/**
 * Theme Image × Translation Probe — PLAN_LOCALIZED_IMAGES Phase 0.
 *
 * ── The questions ──────────────────────────────────────────────────────────
 * 1. Does Shopify report a theme `image_picker` setting (value
 *    `shopify://shop_images/<file>`) as a TRANSLATABLE key, with a digest?
 *    The Shopify changelog says so ("online store media localizable to
 *    different languages/markets"); nothing in this repo had measured it.
 * 2. Does `translationsRegister` accept an image reference as a translation,
 *    echo it back and serve it on a fresh read — globally AND with a
 *    `marketId`? And does `translationsRemove` take it away with an echo?
 *
 * The answers decide whether Phase 1a (a picker per language/market in the
 * theme editor) writes anything at all. Everything else in that phase rides
 * on the ordinary theme save path, which already handles both layers.
 *
 * ── How ────────────────────────────────────────────────────────────────────
 * Question 1 is read-only: the cached theme rows are scanned for image
 * values, and ONE sample is re-read live. Question 2 writes, so it needs
 * `confirm=true` and is dev-only like the market probe: it registers the
 * sample's OWN primary value as the translation — the storefront shows the
 * same picture either way — in a locale (and then a locale × market) that
 * holds NOTHING for that key, and removes it again. So no visible change,
 * and no translation of the merchant's is ever overwritten or deleted.
 *
 * What it does NOT measure: that a DIFFERENT image actually renders on the
 * storefront for that language — that needs a visible change on a live
 * theme and is left to a manual check in Phase 1a.
 */
import { data as json, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "~/db.server";
import { logger } from "~/utils/logger.server";
import { REMOVE_TRANSLATIONS, TRANSLATE_CONTENT_VERIFIED } from "~/graphql/content.mutations";
import { isThemeImageReference } from "~/utils/theme-image-reference.shared";

interface ImageSample {
  resourceId: string;
  resourceType: string;
  key: string;
  value: string;
}

interface WriteCheck {
  locale: string;
  marketId: string | null;
  registerEchoed: boolean;
  readBack: boolean;
  removeEchoed: boolean;
  goneAfterRemove: boolean;
  error?: string;
}

export interface ThemeImageProbeReport {
  generatedAt: string;
  shop: string;
  scannedRows: number;
  imageKeysByResourceType: Record<string, number>;
  samples: ImageSample[];
  live: { resourceId: string; key: string; reportedAsTranslatable: boolean; digest: string | null; value: string | null } | null;
  writes: WriteCheck[];
  verdict: string[];
}

type Graphql = (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>;

// Live read of one resource: primary content (key/value/digest) and, per
// requested layer, the stored translation of that key. The prose stays out
// of the documents (CLAUDE.md: #graphql literals carry no comments).
const READ_RESOURCE = `#graphql
  query probeThemeImageResource($id: ID!) {
    translatableResource(resourceId: $id) {
      resourceId
      translatableContent { key value digest }
    }
  }
`;
const READ_TRANSLATION = `#graphql
  query probeThemeImageTranslation($id: ID!, $locale: String!, $marketId: ID) {
    translatableResource(resourceId: $id) {
      translations(locale: $locale, marketId: $marketId) { key value }
    }
  }
`;
const SHOP_LOCALES_AND_MARKETS = `#graphql
  query probeThemeImageLocales {
    shopLocales { locale primary }
    markets(first: 10) { nodes { id status } }
  }
`;

async function gql<T>(graphql: Graphql, query: string, variables: Record<string, unknown> = {}): Promise<T | null> {
  try {
    const res = await graphql(query, { variables });
    const body = (await res.json()) as { data?: T };
    return body.data ?? null;
  } catch (error) {
    logger.warn("[theme-image-probe] query failed", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

async function storedValue(graphql: Graphql, id: string, key: string, locale: string, marketId: string | null) {
  const data = await gql<{ translatableResource: { translations: { key: string; value: string | null }[] } | null }>(
    graphql, READ_TRANSLATION, { id, locale, marketId },
  );
  const rows = data?.translatableResource?.translations;
  if (!rows) return { known: false, value: null as string | null };
  return { known: true, value: rows.find((r) => r.key === key)?.value ?? null };
}

async function writeCycle(
  graphql: Graphql, sample: ImageSample, digest: string, locale: string, marketId: string | null,
): Promise<WriteCheck> {
  const check: WriteCheck = { locale, marketId, registerEchoed: false, readBack: false, removeEchoed: false, goneAfterRemove: false };
  try {
    const translation: Record<string, unknown> = { key: sample.key, value: sample.value, locale, translatableContentDigest: digest };
    if (marketId) translation.marketId = marketId;
    const reg = await gql<{ translationsRegister: { translations: { key: string; locale: string; value: string }[] | null; userErrors: { message: string }[] } }>(
      graphql, TRANSLATE_CONTENT_VERIFIED, { resourceId: sample.resourceId, translations: [translation] },
    );
    const echoed = reg?.translationsRegister?.translations ?? [];
    check.registerEchoed = echoed.some((t) => t.key === sample.key && t.locale === locale && t.value === sample.value);
    if (reg?.translationsRegister?.userErrors?.length) check.error = reg.translationsRegister.userErrors.map((e) => e.message).join("; ");
    check.readBack = (await storedValue(graphql, sample.resourceId, sample.key, locale, marketId)).value === sample.value;
  } finally {
    // Always attempt the removal: the slot was empty before, so removing
    // restores exactly what was there — even when the register looked failed.
    const rem = await gql<{ translationsRemove: { translations: { key: string; locale: string }[] | null } }>(
      graphql, REMOVE_TRANSLATIONS,
      { resourceId: sample.resourceId, translationKeys: [sample.key], locales: [locale], marketIds: marketId ? [marketId] : null },
    );
    check.removeEchoed = (rem?.translationsRemove?.translations ?? []).some((t) => t.key === sample.key && t.locale === locale);
    const after = await storedValue(graphql, sample.resourceId, sample.key, locale, marketId);
    check.goneAfterRemove = after.known && !after.value;
  }
  return check;
}

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);
  return json({ ok: true, hint: "POST; add confirm=true to also run the write check (registers and removes the sample's own value)." });
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  // Directly POST-reachable and it can write — the same dev-only gate the
  // Probes tab itself is rendered behind.
  if (process.env.APP_ENV !== "development") {
    return json({ error: "Not available." }, { status: 403 });
  }
  const formData = await request.formData().catch(() => null);
  const confirm = formData?.get("confirm") === "true";
  const graphql = admin.graphql as unknown as Graphql;

  const rows = await db.themeContent.findMany({
    where: { shop: session.shop },
    select: { resourceId: true, resourceType: true, translatableContent: true },
  });
  const byType: Record<string, number> = {};
  const samples: ImageSample[] = [];
  for (const row of rows) {
    const items = Array.isArray(row.translatableContent) ? (row.translatableContent as Array<{ key?: string; value?: string }>) : [];
    for (const item of items) {
      if (!item?.key || !isThemeImageReference(item.value)) continue;
      byType[row.resourceType] = (byType[row.resourceType] ?? 0) + 1;
      if (samples.length < 5) samples.push({ resourceId: row.resourceId, resourceType: row.resourceType, key: item.key, value: String(item.value) });
    }
  }

  const verdict: string[] = [];
  const report: ThemeImageProbeReport = {
    generatedAt: new Date().toISOString(),
    shop: session.shop,
    scannedRows: rows.length,
    imageKeysByResourceType: byType,
    samples,
    live: null,
    writes: [],
    verdict,
  };

  if (samples.length === 0) {
    verdict.push(
      rows.length === 0
        ? "INCONCLUSIVE: no theme content cached — run a theme sync first."
        : "INCONCLUSIVE: no image reference among the cached theme keys. Either the theme has no image settings with a value, or Shopify does not report them as translatable. Set an image in a theme section and re-sync to tell the two apart.",
    );
    return json({ report });
  }

  const sample = samples[0];
  const live = await gql<{ translatableResource: { translatableContent: { key: string; value: string | null; digest: string | null }[] } | null }>(
    graphql, READ_RESOURCE, { id: sample.resourceId },
  );
  const liveItem = live?.translatableResource?.translatableContent?.find((c) => c.key === sample.key) ?? null;
  report.live = {
    resourceId: sample.resourceId,
    key: sample.key,
    reportedAsTranslatable: !!liveItem,
    digest: liveItem?.digest ?? null,
    value: liveItem?.value ?? null,
  };
  if (!live?.translatableResource) {
    verdict.push("INCONCLUSIVE: the live read of the sample resource failed.");
    return json({ report });
  }
  verdict.push(
    liveItem?.digest
      ? `ANSWER 1: YES — Shopify reports ${sample.key} (value ${liveItem.value}) as translatable with a digest.`
      : "ANSWER 1: NO — the sample key is not in the live translatableContent (or carries no digest).",
  );
  if (!confirm || !liveItem?.digest) {
    if (!confirm) verdict.push("Write check not run (needs confirm=true).");
    return json({ report });
  }

  const meta = await gql<{ shopLocales: { locale: string; primary: boolean }[]; markets: { nodes: { id: string; status: string }[] } }>(
    graphql, SHOP_LOCALES_AND_MARKETS,
  );
  const foreign = (meta?.shopLocales ?? []).filter((l) => !l.primary).map((l) => l.locale);
  const activeMarket = (meta?.markets?.nodes ?? []).find((m) => m.status === "ACTIVE")?.id ?? null;

  // A locale whose slot for this key is EMPTY, so nothing of the merchant's
  // is overwritten or removed.
  let freeLocale: string | null = null;
  for (const locale of foreign) {
    const cur = await storedValue(graphql, sample.resourceId, sample.key, locale, null);
    if (cur.known && !cur.value) { freeLocale = locale; break; }
  }
  if (!freeLocale) {
    verdict.push("Write check skipped: no second language with an empty slot for the sample key (or the reads failed).");
    return json({ report });
  }
  report.writes.push(await writeCycle(graphql, sample, liveItem.digest, freeLocale, null));

  if (activeMarket) {
    const curMarket = await storedValue(graphql, sample.resourceId, sample.key, freeLocale, activeMarket);
    if (curMarket.known && !curMarket.value) {
      report.writes.push(await writeCycle(graphql, sample, liveItem.digest, freeLocale, activeMarket));
    } else {
      verdict.push("Market write check skipped: the market slot is not empty (or its read failed).");
    }
  } else {
    verdict.push("Market write check skipped: no active market.");
  }

  for (const w of report.writes) {
    const layer = w.marketId ? `market ${w.marketId}` : "global";
    const ok = w.registerEchoed && w.readBack && w.removeEchoed && w.goneAfterRemove;
    verdict.push(
      `ANSWER 2 (${w.locale}, ${layer}): ${ok ? "YES" : "NO/PARTIAL"} — register echoed ${w.registerEchoed}, read back ${w.readBack}, remove echoed ${w.removeEchoed}, gone afterwards ${w.goneAfterRemove}${w.error ? ` (${w.error})` : ""}.`,
    );
  }
  logger.info("[theme-image-probe] report", { shop: session.shop, verdict });
  return json({ report });
}
