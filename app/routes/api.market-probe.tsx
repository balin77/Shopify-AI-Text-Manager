/**
 * Market probe — do the "Märkte und Adressen" writes do what the code assumes?
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Settings → Sprachen und Märkte creates and deletes markets, gives a market its own
 * subfolder, removes it again and assigns languages to web presences. EVERY
 * mutation shape behind that is unmeasured (market-address.server.ts says so
 * in its header): `webPresenceCreate` + `marketUpdate(webPresencesToAdd)` vs
 * `marketWebPresenceCreate`, `MarketCreateInput`'s `conditions` vs `regions`
 * and `status` vs `enabled`, whether `shopLocaleUpdate(marketWebPresenceIds)`
 * REPLACES or ADDS, and whether `marketDelete` takes a market's own presence
 * with it. The code introspects and re-reads so a wrong guess is reported
 * instead of silent — this probe turns the guesses into measurements, in one
 * click, on the shop and API version that actually run.
 *
 * ── It measures through the APP'S OWN functions ────────────────────────────
 * Wherever the question is "does our write path work", the probe calls the
 * very function the tab calls (`createMarket`, `createMarketSubfolder`,
 * `removeMarketAddress`, `removeOrphanAddress`), so a green probe means the
 * feature works, not that a hand copy of it does. Only what the app never does
 * on purpose (a `marketDelete` while a presence is attached — the app refuses
 * that — and the add-vs-replace test) is sent raw.
 *
 * ── Why it builds its own market, as a DRAFT ────────────────────────────────
 * A market decides where the shop SELLS, and a presence moves storefront URLs.
 * Measuring either on the merchant's real markets is not a probe, it is a
 * change to their checkout. So the probe creates a DRAFT market for one small
 * country (Tuvalu first — a market ALREADY covering a country makes Shopify
 * refuse it, so a few fallbacks are tried), measures on it, and deletes
 * everything again in a `finally`. A draft market sells nowhere. The app
 * offers an own address only to ACTIVE markets; the probe deliberately
 * measures the same write on its DRAFT, because activating a market — even for
 * seconds — would open a checkout. The one language test touches a real
 * locale, and only ADDS the probe's presence to it before restoring the exact
 * previous set; the locale's existing presences are never taken away.
 * If any cleanup fails, the report names what is left, loudly.
 */

import { data as json, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { logger } from "~/utils/logger.server";
import { resolveApiVersionString } from "~/utils/api-version";
import {
  loadMarketAddresses,
  createMarket,
  createMarketSubfolder,
  removeMarketAddress,
  removeOrphanAddress,
  type MarketAddresses,
} from "~/services/market-address.server";
import { loadMarketWebPresences } from "~/services/shop-locale-publish.server";

// No prose and no non-ASCII inside a #graphql literal (CLAUDE.md).

const TYPE_REF = `kind name ofType { kind name ofType { kind name ofType { kind name } } }`;

const INPUT_SHAPE = `#graphql
  query marketProbeInputShape($name: String!) {
    __type(name: $name) {
      kind
      inputFields(includeDeprecated: true) {
        name
        isDeprecated
        type { ${TYPE_REF} }
      }
      fields(includeDeprecated: true) {
        name
        isDeprecated
        type { ${TYPE_REF} }
      }
      enumValues(includeDeprecated: true) {
        name
        isDeprecated
      }
    }
  }`;

const MUTATION_FIELDS = `#graphql
  query marketProbeMutations {
    __schema {
      mutationType {
        fields(includeDeprecated: true) {
          name
          isDeprecated
          args {
            name
            type { ${TYPE_REF} }
          }
        }
      }
    }
  }`;

const PRESENCES_RAW = `#graphql
  query marketProbePresences {
    webPresences(first: 10) {
      nodes {
        id
        subfolderSuffix
        domain {
          host
        }
        defaultLocale {
          locale
        }
        alternateLocales {
          locale
        }
        rootUrls {
          locale
          url
        }
        markets(first: 10) {
          nodes {
            id
            name
            status
          }
        }
      }
    }
  }`;

const SHOP_LOCALES = `#graphql
  query marketProbeShopLocales {
    shopLocales {
      locale
      primary
      published
      marketWebPresences {
        id
      }
    }
  }`;

const SHOP_LOCALE_PRESENCES = `#graphql
  mutation marketProbeLocalePresences($locale: String!, $shopLocale: ShopLocaleInput!) {
    shopLocaleUpdate(locale: $locale, shopLocale: $shopLocale) {
      shopLocale {
        locale
        published
        marketWebPresences {
          id
        }
      }
      userErrors {
        field
        message
      }
    }
  }`;

const MARKET_DELETE = `#graphql
  mutation marketProbeMarketDelete($id: ID!) {
    marketDelete(id: $id) {
      deletedId
      userErrors {
        field
        message
      }
    }
  }`;

const LEGACY_PRESENCE_DELETE = `#graphql
  mutation marketProbeLegacyPresenceDelete($webPresenceId: ID!) {
    marketWebPresenceDelete(webPresenceId: $webPresenceId) {
      userErrors {
        field
        message
      }
    }
  }`;

const PRESENCE_DELETE = `#graphql
  mutation marketProbePresenceDelete($id: ID!) {
    webPresenceDelete(id: $id) {
      userErrors {
        field
        message
      }
    }
  }`;

// The types whose shapes the write path guesses at. A name that does not
// exist in this version answers `null`, which the report shows as such.
const SHAPE_TYPES = [
  "WebPresenceCreateInput",
  "WebPresenceUpdateInput",
  "MarketCreateInput",
  "MarketUpdateInput",
  "MarketConditionsInput",
  "MarketConditionsRegionsInput",
  "MarketRegionsConditionInput",
  "MarketRegionCreateInput",
  "MarketWebPresenceCreateInput",
  "ShopLocaleInput",
  "Market",
  "MarketWebPresence",
  "MarketStatus",
];

const RELEVANT_MUTATIONS = [
  "webPresenceCreate",
  "webPresenceUpdate",
  "webPresenceDelete",
  "marketWebPresenceCreate",
  "marketWebPresenceUpdate",
  "marketWebPresenceDelete",
  "marketCreate",
  "marketUpdate",
  "marketDelete",
  "shopLocaleUpdate",
];

/** Countries tried for the throwaway market, in order (see header). */
const DEFAULT_COUNTRIES = ["TV", "NR", "KI", "TO", "WS"];

// ── Report shape (mirrored in MarketProbeCard.tsx) ─────────────────────────

export type StepOutcome = "ok" | "failed" | "skipped" | "info" | "warning";

export interface MarketProbeStep {
  id: string;
  title: string;
  outcome: StepOutcome;
  detail: string;
  data?: unknown;
}

export interface MarketProbeReport {
  generatedAt: string;
  shop: string;
  apiVersion: string;
  schema: {
    mutations: Array<{ name: string; exists: boolean; deprecated?: boolean; args?: string[] }>;
    types: Record<string, unknown>;
  };
  steps: MarketProbeStep[];
  cleanup: { allRemoved: boolean; leftovers: string[]; notes: string[] };
  verdict: string[];
}

type TypeRef = { kind?: string; name?: string | null; ofType?: TypeRef | null } | null | undefined;

function printType(t: TypeRef): string {
  if (!t) return "?";
  if (t.kind === "NON_NULL") return `${printType(t.ofType)}!`;
  if (t.kind === "LIST") return `[${printType(t.ofType)}]`;
  return t.name ?? "?";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function errorText(error: unknown): string {
  const graphQLErrors = (error as { body?: { errors?: { graphQLErrors?: Array<{ message?: string }> } } } | null)?.body
    ?.errors?.graphQLErrors;
  if (Array.isArray(graphQLErrors) && graphQLErrors.length) return graphQLErrors.map((e) => e?.message).join("; ");
  return error instanceof Error ? error.message : String(error);
}

// ── Route ──────────────────────────────────────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);
  return json({ ok: true, hint: "POST with confirm=true. Creates and deletes its own DRAFT market." });
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  // Directly POST-reachable AND it writes, so the gate lives here — the same
  // dev-only gate the Probes tab itself is rendered behind.
  if (process.env.APP_ENV !== "development") {
    return json({ error: "Not available." }, { status: 403 });
  }
  const formData = await request.formData().catch(() => null);
  if (formData?.get("confirm") !== "true") {
    return json({ error: "confirm=true is required — this probe creates and deletes a DRAFT market." }, { status: 400 });
  }
  const requested = String(formData?.get("countries") ?? "")
    .split(/[\s,]+/)
    .map((c) => c.trim().toUpperCase())
    .filter((c) => /^[A-Z]{2}$/.test(c));
  const countries = requested.length ? requested : DEFAULT_COUNTRIES;

  const shop = session.shop;
  const raw = async (query: string, variables?: Record<string, unknown>) => {
    try {
      const response = await admin.graphql(query, variables ? { variables } : undefined);
      return (await response.json()) as { data?: any; errors?: Array<{ message?: string }> };
    } catch (error: unknown) {
      return { data: null, errors: [{ message: errorText(error) }] };
    }
  };

  const report: MarketProbeReport = {
    generatedAt: new Date().toISOString(),
    shop,
    apiVersion: resolveApiVersionString(),
    schema: { mutations: [], types: {} },
    steps: [],
    cleanup: { allRemoved: true, leftovers: [], notes: [] },
    verdict: [],
  };
  const step = (s: MarketProbeStep) => {
    report.steps.push(s);
    return s;
  };

  // What this run created — the cleanup works off these. The market NAME is
  // unique per run, so a market whose create was never confirmed can still be
  // found (and removed) by it.
  const marketName = `ContentPilot probe ${Date.now()}`;
  let marketId: string | null = null;
  let suffix: string | null = null;
  const knownPresenceIds = new Set<string>();
  /** The one real locale this run writes to, and the state it must go back to. */
  let localeTest: { locale: string; beforeIds: string[]; publishedBefore: boolean; restored: boolean } | null = null;
  let hasWebPresenceDelete = true;

  const adoptByName = async (): Promise<string | null | undefined> => {
    const read = await loadMarketAddresses(admin, shop);
    if (!read) return undefined; // cannot tell
    return read.markets.find((m) => m.name === marketName)?.marketId ?? null;
  };
  const readLocale = async (locale: string) => {
    const body = await raw(SHOP_LOCALES);
    const hit = (body.data?.shopLocales ?? []).find((l: any) => l?.locale === locale);
    if (!hit || !Array.isArray(hit.marketWebPresences)) return null; // cannot tell
    return { ids: hit.marketWebPresences.map((p: any) => p.id) as string[], published: !!hit.published };
  };
  const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
  /** Put the locale back exactly: presences AND publication, confirmed by a re-read. */
  const restoreLocale = async (): Promise<string | null> => {
    if (!localeTest) return null;
    const { locale, beforeIds, publishedBefore } = localeTest;
    await raw(SHOP_LOCALE_PRESENCES, { locale, shopLocale: { marketWebPresenceIds: beforeIds } });
    let now = await readLocale(locale);
    if (now && now.published !== publishedBefore) {
      await raw(SHOP_LOCALE_PRESENCES, { locale, shopLocale: { published: publishedBefore } });
      now = await readLocale(locale);
    }
    if (!now) return `could not re-read "${locale}" after restoring it`;
    // The probe presence may still be listed (add-only semantics); it goes with
    // the presence itself in the cleanup, so only the ORIGINAL set matters here.
    const missing = beforeIds.filter((id) => !now!.ids.includes(id));
    const extra = now.ids.filter((id) => !beforeIds.includes(id) && !knownPresenceIds.has(id));
    if (missing.length || extra.length || now.published !== publishedBefore) {
      return `"${locale}" is not back to its previous state (missing ${missing.join(", ") || "none"}, extra ${extra.join(", ") || "none"}, published ${now.published} vs ${publishedBefore})`;
    }
    localeTest.restored = true;
    return null;
  };

  try {
    // ── 0. Schema ────────────────────────────────────────────────────────
    const mutations = await raw(MUTATION_FIELDS);
    const fields: Array<{ name?: string; isDeprecated?: boolean; args?: Array<{ name?: string; type?: TypeRef }> }> =
      mutations.data?.__schema?.mutationType?.fields ?? [];
    report.schema.mutations = RELEVANT_MUTATIONS.map((name) => {
      const hit = fields.find((f) => f?.name === name);
      return hit
        ? {
            name,
            exists: true,
            deprecated: !!hit.isDeprecated,
            args: (hit.args ?? []).map((a) => `${a?.name}: ${printType(a?.type)}`),
          }
        : { name, exists: false };
    });
    if (mutations.errors?.length) {
      step({ id: "schemaError", title: "Mutation list", outcome: "failed", detail: mutations.errors.map((e) => e.message).join("; ") });
    } else {
      hasWebPresenceDelete = report.schema.mutations.some((m) => m.name === "webPresenceDelete" && m.exists);
    }
    for (const name of SHAPE_TYPES) {
      const body = await raw(INPUT_SHAPE, { name });
      const t = body.data?.__type;
      report.schema.types[name] = body.errors?.length
        ? { error: body.errors.map((e) => e.message).join("; ") }
        : t
          ? {
              kind: t.kind,
              inputFields: (t.inputFields ?? []).map(
                (f: any) => `${f.name}: ${printType(f.type)}${f.isDeprecated ? " (deprecated)" : ""}`,
              ),
              fields: (t.fields ?? []).map((f: any) => `${f.name}: ${printType(f.type)}${f.isDeprecated ? " (deprecated)" : ""}`),
              enumValues: (t.enumValues ?? []).map((v: any) => `${v.name}${v.isDeprecated ? " (deprecated)" : ""}`),
            }
          : null;
    }
    const marketFields = ((report.schema.types.Market as any)?.fields ?? []) as string[];
    step({
      id: "schema",
      title: "Schema (introspected from this shop)",
      outcome: "info",
      detail:
        `Mutations present: ${report.schema.mutations.filter((m) => m.exists).map((m) => m.name + (m.deprecated ? " (deprecated)" : "")).join(", ") || "none"}. ` +
        `Market.primary: ${marketFields.find((f) => f.startsWith("primary:")) ?? "absent"}.`,
    });

    // ── 1. What the tab reads today ──────────────────────────────────────
    const before = await loadMarketAddresses(admin, shop);
    const presencesBefore = await loadMarketWebPresences(admin, shop);
    step({
      id: "read",
      title: "Read: markets, addresses and language presences (as the tab reads them)",
      outcome: before && presencesBefore ? "ok" : "failed",
      detail: before
        ? `${before.markets.length} market(s): ${before.markets
            .map((m) => `${m.name} [${m.status}${m.primary === true ? ", primary" : m.primary === null ? ", primary=?" : ""}]${m.own ? ` own /${m.own.subfolderSuffix ?? "(domain)"}` : ""}`)
            .join("; ")}. Shared address: ${before.sharedUrl ?? "none"}. Unused addresses: ${before.orphans.length}. ` +
          `Language presences read: ${presencesBefore ? presencesBefore.length : "FAILED (null)"}.`
        : "loadMarketAddresses answered null (cannot tell) — see the server log for the reason.",
      data: { addresses: before, presences: presencesBefore },
    });
    if (!before) throw new Error("stop: the addresses could not be read, so nothing is written");
    if (before.markets.some((m) => m.primary === null)) {
      report.verdict.push("⚠️ The primary market is NOT recognisable on this version (Market.primary absent) — Shopify is the only guard against moving or deleting it.");
    }

    // ── 2. Create a DRAFT market (app's createMarket) ────────────────────
    const attempts: string[] = [];
    let country: string | null = null;
    let createdAsDraft = false;
    for (const c of countries) {
      const outcome = await createMarket(admin, shop, { name: marketName, countries: [c] });
      if (outcome.ok) {
        marketId = outcome.marketId;
        country = c;
        createdAsDraft = true;
        attempts.push(`${c}: created as DRAFT`);
        break;
      }
      attempts.push(`${c}: ${outcome.error}`);
      if (outcome.marketId) {
        // Created but not as a draft (`createdNotDraft`): it exists and is
        // possibly selling — record it for the cleanup and stop here.
        marketId = outcome.marketId;
        report.verdict.push("🛑 marketCreate did NOT create a draft — the app would report createdNotDraft. The market is deleted again below.");
        break;
      }
      if (outcome.error === "notSupported" || outcome.error === "schemaUnreadable") break;
      // Any other failure may still have created the market (a lagging or
      // failed re-read, a throw after Shopify ran it): look for it by name
      // BEFORE trying another country, or a second market would be created.
      const adopted = await adoptByName();
      if (adopted) {
        marketId = adopted;
        attempts.push(`${c}: the market EXISTS nevertheless (${adopted}) — the app's confirmation missed it`);
        break;
      }
      if (adopted === undefined) {
        attempts.push("stopped: the markets could not be re-read, so another attempt could create a second market");
        break;
      }
    }
    const created = step({
      id: "createMarket",
      title: "createMarket (DRAFT, one country) — the app's own function",
      outcome: createdAsDraft ? "ok" : "failed",
      detail: attempts.join(" · "),
    });
    if (created.outcome !== "ok") throw new Error("stop: no DRAFT market to measure on");

    // ── 3. Own subfolder on the draft (app's createMarketSubfolder) ──────
    const primaryLocale = await raw(SHOP_LOCALES).then(
      (b) => (b.data?.shopLocales ?? []).find((l: any) => l.primary)?.locale as string | undefined,
    );
    const lowered = country!.toLowerCase();
    const pick = [lowered, "cpprobe"].find((x) => !before.takenSuffixes.includes(x));
    if (!pick) throw new Error("stop: both candidate subfolder codes are already taken in this shop");
    // Only ever a suffix nobody used before this run, so a taken one at the end is ours.
    suffix = pick;
    const sub = await createMarketSubfolder(admin, shop, {
      marketId: marketId!,
      suffix,
      defaultLocale: primaryLocale ?? "en",
      alternateLocales: [],
    });
    let subDetail = sub.ok ? `/${suffix} created and confirmed by a re-read.` : `refused: ${sub.error}.`;
    const findOwn = (a: MarketAddresses | null) => a?.markets.find((m) => m.marketId === marketId)?.own ?? null;
    let afterSub = await loadMarketAddresses(admin, shop);
    if (!sub.ok && (sub.error === "notConfirmed" || sub.error === "unverified")) {
      await sleep(3000);
      afterSub = await loadMarketAddresses(admin, shop);
      if (!afterSub) subDetail += " After 3 s the addresses still cannot be read.";
      else if (findOwn(afterSub)) {
        subDetail +=
          sub.error === "notConfirmed"
            ? " After 3 s the market DOES carry it — Shopify's read lags; the app's immediate re-read is too early."
            : " After 3 s the market carries it — the app's re-read had failed.";
      } else subDetail += " After 3 s still not on the market.";
    }
    const own = findOwn(afterSub);
    const presenceId = own?.presenceId ?? afterSub?.orphans.find((o) => o.subfolderSuffix === suffix)?.presenceId ?? null;
    if (presenceId) knownPresenceIds.add(presenceId);
    const presenceRaw = await raw(PRESENCES_RAW);
    const presenceNode = (presenceRaw.data?.webPresences?.nodes ?? []).find((p: any) => p?.id === presenceId);
    step({
      id: "subfolder",
      title: "createMarketSubfolder on the DRAFT — the app's own function",
      outcome: sub.ok ? "ok" : own ? "warning" : "failed",
      detail:
        subDetail +
        (own ? ` Market carries ${own.presenceId} (${own.url ?? "no root url"}).` : "") +
        (!own && presenceId ? " The presence EXISTS but no market claims it (the attach did not land)." : ""),
      data: { presence: presenceNode ?? null },
    });

    // ── 4. Languages on the new presence: add vs replace ─────────────────
    const locales = await raw(SHOP_LOCALES);
    // An UNPUBLISHED second language first: nobody sees it on the storefront.
    const foreign = (locales.data?.shopLocales ?? []).filter((l: any) => !l.primary);
    const target = foreign.find((l: any) => !l.published) ?? foreign[0];
    const title = `shopLocaleUpdate(marketWebPresenceIds)${target ? ` on "${target.locale}"` : ""}`;
    if (!presenceId) {
      step({ id: "languages", title, outcome: "skipped", detail: "No probe presence to assign a language to." });
    } else if (!target) {
      step({ id: "languages", title, outcome: "skipped", detail: "The shop has no second language." });
    } else if (!Array.isArray(target.marketWebPresences)) {
      // The restore sends the set read HERE. A missing list read as "none"
      // would restore the language into NO market — so no test at all.
      step({ id: "languages", title, outcome: "skipped", detail: `The presences of "${target.locale}" could not be read, so nothing was written to it.` });
    } else {
      const beforeIds: string[] = target.marketWebPresences.map((p: any) => p.id);
      // Recorded BEFORE the first write, so the finally restores it whatever happens next.
      localeTest = { locale: target.locale, beforeIds, publishedBefore: !!target.published, restored: false };
      const add = await raw(SHOP_LOCALE_PRESENCES, {
        locale: target.locale,
        shopLocale: { marketWebPresenceIds: [...beforeIds, presenceId] },
      });
      const addErrors = [...(add.errors ?? []), ...(add.data?.shopLocaleUpdate?.userErrors ?? [])].map((e: any) => e.message);
      const afterAdd = await readLocale(target.locale);
      const restore = await raw(SHOP_LOCALE_PRESENCES, {
        locale: target.locale,
        shopLocale: { marketWebPresenceIds: beforeIds },
      });
      const restoreErrors = [...(restore.errors ?? []), ...(restore.data?.shopLocaleUpdate?.userErrors ?? [])].map(
        (e: any) => e.message,
      );
      let afterRestore = await readLocale(target.locale);
      if (afterRestore?.ids.includes(presenceId) && !restoreErrors.length) {
        // Looks add-only — but a lagging read looks the same. Ask once more.
        await sleep(3000);
        afterRestore = await readLocale(target.locale);
      }
      let semantics: string;
      let known = true;
      if (addErrors.length) semantics = `the add was refused: ${addErrors.join("; ")}`;
      else if (!afterAdd) (semantics = "cannot tell — the re-read after the add failed"), (known = false);
      else if (!afterAdd.ids.includes(presenceId)) semantics = "the add reported no error but is not in the re-read";
      else if (restoreErrors.length) (semantics = `cannot tell — the restore was refused: ${restoreErrors.join("; ")}`), (known = false);
      else if (!afterRestore) (semantics = "cannot tell — the re-read after the restore failed"), (known = false);
      else if (afterRestore.ids.includes(presenceId)) semantics = "ADD-ONLY (sending the old set did not remove the new presence, still after 3 s)";
      else semantics = "REPLACE (sending the old set removed it again)";
      const publicationMoved = !!afterAdd && afterAdd.published !== localeTest.publishedBefore;
      const restoreProblem = await restoreLocale();
      step({
        id: "languages",
        title,
        outcome: !known || restoreProblem ? "warning" : addErrors.length || !afterAdd?.ids.includes(presenceId) ? "failed" : "ok",
        detail:
          `Before: ${beforeIds.length} presence(s). Semantics: ${semantics}. ` +
          (publicationMoved
            ? `⚠️ Assigning the presence MOVED the publication (published ${localeTest.publishedBefore} → ${afterAdd!.published}); it was put back. `
            : "Publication unchanged by the assignment. ") +
          (restoreProblem ? `⚠️ Restore: ${restoreProblem}.` : "Restored to the exact previous state (confirmed)."),
        data: { beforeIds, afterAdd, afterRestore },
      });
    }

    // ── 5. Remove the own address (app's removeMarketAddress) ────────────
    if (own?.subfolderSuffix) {
      const removed = await removeMarketAddress(admin, shop, marketId!);
      let detail = removed.ok ? "Removed and confirmed by a re-read." : `refused: ${removed.error}.`;
      if (!removed.ok && (removed.error === "notConfirmed" || removed.error === "unverified")) {
        await sleep(3000);
        const later = await loadMarketAddresses(admin, shop);
        detail += !later
          ? " After 3 s the addresses still cannot be read."
          : !later.takenSuffixes.includes(suffix)
            ? removed.error === "notConfirmed"
              ? " After 3 s it IS gone — Shopify's read lags."
              : " After 3 s it is gone — the app's re-read had failed."
            : " After 3 s still there.";
      }
      step({ id: "removeAddress", title: "removeMarketAddress — the app's own function", outcome: removed.ok ? "ok" : "failed", detail });
    } else {
      step({ id: "removeAddress", title: "removeMarketAddress", outcome: "skipped", detail: "The market carried no subfolder to remove." });
    }

    // ── 6. Does marketDelete take an attached presence with it? ──────────
    const again = await createMarketSubfolder(admin, shop, {
      marketId: marketId!,
      suffix,
      defaultLocale: primaryLocale ?? "en",
      alternateLocales: [],
    });
    const afterAgain = await loadMarketAddresses(admin, shop);
    const againOwn = findOwn(afterAgain);
    if (againOwn?.presenceId) knownPresenceIds.add(againOwn.presenceId);
    for (const o of afterAgain?.orphans ?? []) if (o.subfolderSuffix === suffix) knownPresenceIds.add(o.presenceId);
    if (!again.ok || !againOwn) {
      step({
        id: "deleteWithPresence",
        title: "marketDelete with an attached presence",
        outcome: "skipped",
        detail: `Could not attach a second subfolder (${again.ok ? "not on the market in the re-read" : again.error}), so this could not be measured.`,
      });
    } else {
      const del = await raw(MARKET_DELETE, { id: marketId });
      const delErrors = [...(del.errors ?? []), ...(del.data?.marketDelete?.userErrors ?? [])].map((e: any) => e.message);
      const echoed = del.data?.marketDelete?.deletedId === marketId;
      const settle = async () => {
        const read = await loadMarketAddresses(admin, shop);
        return {
          read,
          orphan: read?.orphans.find((o) => o.subfolderSuffix === suffix) ?? null,
          gone: !!read && !read.takenSuffixes.includes(suffix!),
        };
      };
      await sleep(1000);
      let s = await settle();
      if (s.read && !s.orphan && !s.gone) {
        // Taken but not unused: most likely the delete has not landed in the read yet.
        await sleep(3000);
        s = await settle();
      }
      let detail = delErrors.length
        ? `marketDelete refused: ${delErrors.join("; ")}.`
        : echoed
          ? "marketDelete echoed the id."
          : "marketDelete answered without the id.";
      if (!s.read) detail += " The re-read failed — cannot tell whether the presence survived.";
      else if (s.orphan) {
        detail += ` The presence SURVIVED as an unused address (${s.orphan.presenceId}) — the app's "remove the address first" rule is needed.`;
        const cleaned = await removeOrphanAddress(admin, shop, s.orphan.presenceId);
        detail += ` removeOrphanAddress: ${cleaned.ok ? "removed and confirmed" : cleaned.error}.`;
      } else if (s.gone) {
        detail += " The presence went WITH the market — the \"remove the address first\" rule is stricter than needed.";
      } else {
        detail += " After 4 s the suffix is still taken, but not by an unused presence — see the raw data.";
      }
      step({
        id: "deleteWithPresence",
        title: "marketDelete with an attached presence (sent raw — the app refuses this on purpose)",
        outcome: delErrors.length ? "failed" : s.read && (s.orphan || s.gone) ? "info" : "warning",
        detail,
        data: { afterDelete: s.read },
      });
    }
  } catch (error: unknown) {
    const message = errorText(error);
    if (!message.startsWith("stop:")) {
      logger.error("[MarketProbe] Probe threw", { context: "MarketProbe", shop, error: message });
    }
    step({ id: "stopped", title: "Stopped", outcome: message.startsWith("stop:") ? "warning" : "failed", detail: message });
  } finally {
    // ── Cleanup: everything this run created, whatever happened above ────
    // 1. The real locale first: it is the one thing a storefront could show.
    if (localeTest && !localeTest.restored) {
      const problem = await restoreLocale();
      if (problem) report.cleanup.leftovers.push(`${problem} — check it in Settings → Sprachen und Märkte.`);
      else report.cleanup.notes.push(`Language "${localeTest.locale}" restored in the cleanup.`);
    }
    // 2. The market — adopted by its unique name if no id was ever confirmed.
    if (!marketId) {
      const adopted = await adoptByName();
      if (adopted) marketId = adopted;
    }
    const deletePresence = async (id: string) => {
      const r = await raw(hasWebPresenceDelete ? PRESENCE_DELETE : LEGACY_PRESENCE_DELETE, hasWebPresenceDelete ? { id } : { webPresenceId: id });
      const payload = hasWebPresenceDelete ? r.data?.webPresenceDelete : r.data?.marketWebPresenceDelete;
      const errs = [...(r.errors ?? []), ...(payload?.userErrors ?? [])].map((e: any) => e.message);
      report.cleanup.notes.push(`presence delete ${id}: ${errs.length ? errs.join("; ") : "sent"}`);
    };
    const now = await loadMarketAddresses(admin, shop);
    if (now === null && (marketId || suffix)) {
      report.cleanup.notes.push("The cleanup's read failed — the known ids are deleted blind.");
    }
    const probePresences = new Set<string>(knownPresenceIds);
    const probeOwn = marketId ? now?.markets.find((m) => m.marketId === marketId)?.own : null;
    if (probeOwn?.presenceId && probeOwn.subfolderSuffix === suffix) probePresences.add(probeOwn.presenceId);
    for (const o of now?.orphans ?? []) if (suffix && o.subfolderSuffix === suffix) probePresences.add(o.presenceId);
    // Only delete a known id the read still shows (or blind when it failed).
    for (const id of probePresences) {
      const stillThere =
        now === null || now.orphans.some((o) => o.presenceId === id) || now.markets.some((m) => m.own?.presenceId === id);
      if (stillThere) await deletePresence(id);
    }
    if (marketId && (now === null || now.markets.some((m) => m.marketId === marketId))) {
      const r = await raw(MARKET_DELETE, { id: marketId });
      const errs = [...(r.errors ?? []), ...(r.data?.marketDelete?.userErrors ?? [])].map((e: any) => e.message);
      report.cleanup.notes.push(`marketDelete ${marketId}: ${errs.length ? errs.join("; ") : r.data?.marketDelete?.deletedId ? "deleted" : "no id echoed"}`);
    }
    // 3. A presence Shopify refused to delete while attached is free now.
    let final = await loadMarketAddresses(admin, shop);
    const leftoverOrphans = (final?.orphans ?? []).filter((o) => suffix && o.subfolderSuffix === suffix);
    for (const o of leftoverOrphans) await deletePresence(o.presenceId);
    if (leftoverOrphans.length) final = await loadMarketAddresses(admin, shop);
    if (final) {
      const market = final.markets.find((m) => m.name === marketName);
      if (market) report.cleanup.leftovers.push(`Market "${marketName}" (${market.marketId}) — delete it in Shopify admin → Markets.`);
      if (suffix && final.takenSuffixes.includes(suffix)) {
        report.cleanup.leftovers.push(`A presence with subfolder /${suffix} — it shows as "unused address" in Sprachen und Märkte and can be removed there.`);
      }
    } else if (marketId || suffix || knownPresenceIds.size) {
      report.cleanup.leftovers.push(`Unknown — the final read failed. Check Shopify admin → Markets for a market named "${marketName}".`);
    }
    report.cleanup.allRemoved = report.cleanup.leftovers.length === 0;
  }

  // ── Verdict ────────────────────────────────────────────────────────────
  const byId = (id: string) => report.steps.find((s) => s.id === id);
  if (!report.cleanup.allRemoved) report.verdict.unshift("🛑 CLEANUP INCOMPLETE — see the leftovers below.");
  for (const id of ["createMarket", "subfolder", "languages", "removeAddress", "deleteWithPresence"]) {
    const s = byId(id);
    if (!s) continue;
    const mark = s.outcome === "ok" ? "✅" : s.outcome === "failed" ? "❌" : s.outcome === "warning" ? "⚠️" : "ℹ️";
    report.verdict.push(`${mark} ${s.title}: ${s.detail.split(". ")[0]}`);
  }
  logger.info("[MarketProbe] Report", { context: "MarketProbe", shop, report });
  return json({ report });
}
