/**
 * Translation Coverage Probe — Phase 0 / one-shot dev tool
 *
 * Hits every TranslatableResourceType the plan §10 calls out as "NEW" and
 * reports key shapes, sample values, total counts, locale coverage, and
 * write-test results. Output is consumed by the Settings → Translation
 * Probe tab as a paste-ready markdown report. See
 * docs/PLAN_TRANSLATION_COVERAGE.md §10 Phase 0 / §12 spike findings.
 *
 * Read-only by default. Pass formData "writeTest=true" to attempt a single
 * SHOP write against an enabled non-primary locale (used to answer the
 * built-in-override question). The write targets a low-impact key
 * (`checkout.general.continue_button`) and tags the value so it's easy to
 * spot in the admin language editor.
 */

import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { logger } from "~/utils/logger.server";
import { db } from "~/db.server";
import { listThemes, pickMainThemeId, resolveSelectedThemeId } from "~/services/theme-selection.server";
import { extractThemeIdFromResourceId } from "~/utils/theme-id";

// Probe target list. Includes resource types we already cover, so we can find
// where Shopify hides things like Cookie-Banner. COOKIE_BANNER is documented
// in the unstable enum but absent from 2025-10's enum docs — we try it anyway
// since Shopify's enum docs sometimes lag the actual API. The "already covered"
// types are listed near the top so any cookie-related keys surface quickly.
const PROBE_RESOURCE_TYPES = [
  // Cookie-Banner: try the new documented unstable-enum value first
  "COOKIE_BANNER",
  // Hunt for Cookie-Banner content under previously-suspected types
  "SHOP_POLICY",
  "ONLINE_STORE_THEME_LOCALE_CONTENT",
  "ONLINE_STORE_THEME",
  // Originally-planned new types
  "SHOP",
  "EMAIL_TEMPLATE",
  "PACKING_SLIP_TEMPLATE",
  "DELIVERY_METHOD_DEFINITION",
  "PAYMENT_GATEWAY",
  "FILTER",
  "SELLING_PLAN",
  "SELLING_PLAN_GROUP",
  "ONLINE_STORE_THEME_APP_EMBED",
  "ONLINE_STORE_THEME_SETTINGS_DATA_SECTIONS",
] as const;

// Substrings flagged as cookie-banner candidates. Key-only matching (values
// are noisy — "consent" matches subscription-buyer-consent, "tracking" matches
// order-tracking, etc.). The first hunt confirmed the cookie-preferences
// LINKS live in ONLINE_STORE_THEME_LOCALE_CONTENT; this widened set is meant
// to surface the actual banner CONTENT, which we expect under shopify.consent.*
// or shopify.cookie_banner.* (the 2590 shopify.* keys are too deep for the
// per-prefix sample limit to show).
const COOKIE_KEY_HINTS = [
  "cookie",            // shopify.checkout.shop_policies.cookie_preferences
  "consent_banner",    // possible Shopify namespace
  "cookie_banner",
  "privacy_banner",    // customer_accounts.privacy_banner.*
  "consent_dialog",
  "gdpr_compliance",
  "shopify.consent",   // exact prefix match — most likely landing zone
];
const COOKIE_HUNT_LIMIT = 200;

interface KeyStats {
  prefix: string;
  count: number;
  samples: string[];
}

interface ResourceReport {
  resourceType: string;
  status: "ok" | "error";
  errorMessage?: string;
  resourceCount: number;
  totalKeys: number;
  keysByPrefix: KeyStats[];
  sampleKeys: Array<{ key: string; value: string | null; locale: string; digest: string }>;
  translationLocalesSeen: string[];
}

interface WriteTestReport {
  attempted: boolean;
  targetLocale?: string;
  targetKey?: string;
  before?: string | null;
  attemptedValue?: string;
  result?: "success" | "failure";
  errors?: string[];
  /** Notes for follow-up: e.g. "now verify in Shopify Admin → Languages" */
  note?: string;
}

interface CookieHintHit {
  resourceType: string;
  resourceId: string;
  key: string;
  value: string | null;
  locale: string;
}

/**
 * Theme-Selection 404 diagnostic. Answers WHY /api/theme-content/theme/* returns
 * 404 "Group not found" after the theme-selection feature: the read path scopes
 * rows to `themeId IN (resolvedSelectedThemeId, "")`. This block surfaces the
 * three values that must line up — the resolved selection, the themeIds actually
 * stored on the rows, and the themeId embedded in Shopify's live resourceIds.
 */
interface ThemeSelectionDiag {
  themes: Array<{ id: string; name: string; role: string }>;
  mainThemeId: string | null;
  storedSelectedThemeId: string | null;
  resolvedSelectedThemeId: string | null;
  /** DISTINCT ThemeContent.themeId (domain=theme) + row counts. */
  dbThemeContentByThemeId: Array<{ themeId: string; count: number }>;
  /** DISTINCT ThemeTranslation.themeId (domain=theme) + row counts. */
  dbThemeTranslationByThemeId: Array<{ themeId: string; count: number }>;
  /** Sample live resourceIds per theme resource type + the extracted Theme-GID. */
  resourceThemeIds: Array<{ resourceType: string; resourceId: string; extractedThemeId: string | null }>;
  /** Human-readable conclusion computed server-side. */
  verdict: string;
}

interface ProbeReport {
  generatedAt: string;
  shop: string;
  primaryLocale: string;
  enabledLocales: string[];
  apiVersion: string;
  resources: ResourceReport[];
  cookieHints: CookieHintHit[];
  writeTest: WriteTestReport;
  themeSelectionDiag?: ThemeSelectionDiag;
  themeFetchWorkaround?: ThemeFetchWorkaround;
}

/**
 * Empirical test of whether an UNPUBLISHED theme's translatable content can be
 * reached at all — and via which API. Answers the "is there a workaround?"
 * question with hard data from this shop rather than forum consensus.
 */
interface ThemeFetchWorkaround {
  targetTheme: { id: string; name: string; role: string } | null;
  /** translatableResource(resourceId) with the theme_id rewritten to the target theme. */
  translationsApiRewrite: { resourceId: string; contentCount: number; error?: string };
  /** translatableResourcesByIds([rewritten id]). */
  translationsApiByIds: { contentCount: number; error?: string };
  /** theme(id: target){ files(locales/*) } — the theme-files API is per-theme. */
  themeFilesRead: Array<{ theme: "MAIN" | "target"; filename: string; found: boolean; byteSize: number; sampleKeys: string[]; error?: string }>;
  verdict: string;
}

const PROBE_QUERY = `#graphql
  query probe($first: Int!, $resourceType: TranslatableResourceType!) {
    translatableResources(first: $first, resourceType: $resourceType) {
      edges {
        node {
          resourceId
          translatableContent { key value digest locale }
        }
      }
      pageInfo { hasNextPage }
    }
  }
`;

const SHOP_TRANSLATIONS_QUERY = `#graphql
  query shopTranslations($resourceId: ID!, $locale: String!) {
    translatableResource(resourceId: $resourceId) {
      resourceId
      translatableContent { key value digest locale }
      translations(locale: $locale) { key value locale outdated }
    }
  }
`;

const TRANSLATIONS_REGISTER = `#graphql
  mutation registerTranslations($resourceId: ID!, $translations: [TranslationInput!]!) {
    translationsRegister(resourceId: $resourceId, translations: $translations) {
      translations { key value locale }
      userErrors { field message }
    }
  }
`;

// Single-resource translatable-content lookup (no locale filter) — used to test
// whether rewriting theme_id in a resourceId reaches a different theme.
const SINGLE_TRANSLATABLE_QUERY = `#graphql
  query singleTranslatable($resourceId: ID!) {
    translatableResource(resourceId: $resourceId) {
      resourceId
      translatableContent { key value digest locale }
    }
  }
`;

const BY_IDS_TRANSLATABLE_QUERY = `#graphql
  query byIdsTranslatable($resourceIds: [ID!]!) {
    translatableResourcesByIds(resourceIds: $resourceIds, first: 5) {
      edges { node { resourceId translatableContent { key value locale } } }
    }
  }
`;

// Theme-files API is addressed per Theme-GID and works for UNPUBLISHED themes.
const THEME_FILES_QUERY = `#graphql
  query themeFiles($id: ID!, $filenames: [String!]!) {
    theme(id: $id) {
      id
      name
      role
      files(filenames: $filenames, first: 10) {
        nodes {
          filename
          body { ... on OnlineStoreThemeFileBodyText { content } }
        }
      }
    }
  }
`;

const LOCALES_QUERY = `#graphql
  query locales {
    shopLocales { locale primary }
    shop { id }
  }
`;

/** Top-level prefix; for "checkout.shipping.title" → "checkout". */
function prefixOf(key: string): string {
  const i = key.indexOf(".");
  if (i < 0) return "(no-dot)";
  return key.slice(0, i);
}

function summarize(node: { resourceId: string; translatableContent: Array<{ key: string; value: string | null; locale: string; digest: string }> }, accum: ResourceReport) {
  accum.resourceCount += 1;
  for (const item of node.translatableContent ?? []) {
    accum.totalKeys += 1;
    const p = prefixOf(item.key);
    let bucket = accum.keysByPrefix.find((b) => b.prefix === p);
    if (!bucket) {
      bucket = { prefix: p, count: 0, samples: [] };
      accum.keysByPrefix.push(bucket);
    }
    bucket.count += 1;
    if (bucket.samples.length < 5) bucket.samples.push(item.key);

    if (accum.sampleKeys.length < 10) {
      accum.sampleKeys.push({
        key: item.key,
        value: item.value ? item.value.slice(0, 120) : null,
        locale: item.locale,
        digest: item.digest?.slice(0, 16) ?? "",
      });
    }
    if (item.locale && !accum.translationLocalesSeen.includes(item.locale)) {
      accum.translationLocalesSeen.push(item.locale);
    }
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  // GET → just authenticate and tell the caller this endpoint is POST-only.
  await authenticate.admin(request);
  return json({ ok: true, hint: "POST to run the probe. See docs/PLAN_TRANSLATION_COVERAGE.md §10 Phase 0." });
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData().catch(() => null);
  const wantsWriteTest = formData?.get("writeTest") === "true";

  logger.info("[TRANSLATION-PROBE] Starting", { context: "TranslationProbe", shop: session.shop, writeTest: wantsWriteTest });

  // Resolve locales + shop GID once
  let primaryLocale = "en";
  let enabledLocales: string[] = [];
  let shopGid = "";
  try {
    const r = await admin.graphql(LOCALES_QUERY);
    const j = (await r.json()) as { data?: { shopLocales?: Array<{ locale: string; primary: boolean }>; shop?: { id: string } } };
    enabledLocales = (j.data?.shopLocales ?? []).map((l) => l.locale);
    primaryLocale = (j.data?.shopLocales ?? []).find((l) => l.primary)?.locale || "en";
    shopGid = j.data?.shop?.id ?? "";
  } catch (e) {
    logger.error("[TRANSLATION-PROBE] locales query failed", { context: "TranslationProbe", error: e instanceof Error ? e.message : String(e) });
  }

  const report: ProbeReport = {
    generatedAt: new Date().toISOString(),
    shop: session.shop,
    primaryLocale,
    enabledLocales,
    apiVersion: process.env.SHOPIFY_API_VERSION || "2025-10",
    resources: [],
    cookieHints: [],
    writeTest: { attempted: false },
  };

  for (const resourceType of PROBE_RESOURCE_TYPES) {
    const r: ResourceReport = {
      resourceType,
      status: "ok",
      resourceCount: 0,
      totalKeys: 0,
      keysByPrefix: [],
      sampleKeys: [],
      translationLocalesSeen: [],
    };
    try {
      // COOKIE_BANNER is documented in unstable but rejected by 2025-10. Try
      // it against the unstable endpoint via raw fetch using the session's
      // access token. Everything else uses the pinned admin client.
      let data: { data?: { translatableResources?: { edges: Array<{ node: { resourceId: string; translatableContent: Array<{ key: string; value: string | null; locale: string; digest: string }> } }> } }; errors?: Array<{ message: string }> };
      if (resourceType === "COOKIE_BANNER") {
        const accessToken = (session as unknown as { accessToken?: string }).accessToken;
        if (!accessToken) {
          throw new Error("No access token on session — cannot probe unstable endpoint");
        }
        const rawResp = await fetch(`https://${session.shop}/admin/api/unstable/graphql.json`, {
          method: "POST",
          headers: {
            "X-Shopify-Access-Token": accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query: PROBE_QUERY, variables: { first: 50, resourceType } }),
        });
        data = await rawResp.json();
      } else {
        const resp = await admin.graphql(PROBE_QUERY, { variables: { first: 50, resourceType } });
        data = await resp.json();
      }
      if (data.errors?.length) {
        r.status = "error";
        r.errorMessage = data.errors.map((e) => e.message).join(" | ");
      } else {
        for (const edge of data.data?.translatableResources?.edges ?? []) {
          summarize(edge.node, r);
          // Scan for cookie-banner-related keys. Key-only matching (values
          // produce too many false positives: order-tracking, email-tracking,
          // subscription buyer-consent, etc.).
          for (const item of edge.node.translatableContent ?? []) {
            const keyLower = item.key.toLowerCase();
            if (COOKIE_KEY_HINTS.some((h) => keyLower.includes(h))) {
              if (report.cookieHints.length < COOKIE_HUNT_LIMIT) {
                report.cookieHints.push({
                  resourceType,
                  resourceId: edge.node.resourceId,
                  key: item.key,
                  value: item.value ? item.value.slice(0, 200) : null,
                  locale: item.locale,
                });
              }
            }
          }
        }
        r.keysByPrefix.sort((a, b) => b.count - a.count);
      }
    } catch (e) {
      r.status = "error";
      r.errorMessage = e instanceof Error ? e.message : String(e);
    }
    report.resources.push(r);
    // Small pause to be gentle on the translation rate-limit (forum thread:
    // community.shopify.dev/t/translatable-resource-rate-limit/15107).
    await new Promise((res) => setTimeout(res, 250));
  }

  // ── Theme-Selection 404 diagnostic ─────────────────────────────────────────
  // Reads (never writes) the three things that must line up for
  // /api/theme-content/theme/* to return rows instead of 404.
  try {
    const themes = await listThemes(admin);
    const mainThemeId = pickMainThemeId(themes);
    const settings = await db.aISettings.findUnique({
      where: { shop: session.shop },
      select: { selectedThemeId: true },
    });
    const storedSelectedThemeId = settings?.selectedThemeId ?? null;
    const resolvedSelectedThemeId = await resolveSelectedThemeId(session.shop, admin, themes);

    // What themeIds are actually stored on the theme-domain rows?
    const [contentGroups, translationGroups] = await Promise.all([
      db.themeContent.groupBy({
        by: ["themeId"],
        where: { shop: session.shop, domain: "theme" },
        _count: { _all: true },
      }),
      db.themeTranslation.groupBy({
        by: ["themeId"],
        where: { shop: session.shop, domain: "theme" },
        _count: { _all: true },
      }),
    ]);
    const toCounts = (g: Array<{ themeId: string; _count: { _all: number } }>) =>
      g.map((x) => ({ themeId: x.themeId, count: x._count._all })).sort((a, b) => b.count - a.count);
    const dbThemeContentByThemeId = toCounts(contentGroups as Array<{ themeId: string; _count: { _all: number } }>);
    const dbThemeTranslationByThemeId = toCounts(translationGroups as Array<{ themeId: string; _count: { _all: number } }>);

    // Sample a few live resourceIds per theme resource type and show the Theme-GID
    // we extract from each (this is exactly what the sync stamps onto the row).
    const THEME_DIAG_TYPES = [
      "ONLINE_STORE_THEME_JSON_TEMPLATE",
      "ONLINE_STORE_THEME_SECTION_GROUP",
      "ONLINE_STORE_THEME_APP_EMBED",
      "ONLINE_STORE_THEME_SETTINGS_CATEGORY",
      "ONLINE_STORE_THEME_SETTINGS_DATA_SECTIONS",
      "ONLINE_STORE_THEME_LOCALE_CONTENT",
    ];
    const resourceThemeIds: Array<{ resourceType: string; resourceId: string; extractedThemeId: string | null }> = [];
    for (const rt of THEME_DIAG_TYPES) {
      try {
        const resp = await admin.graphql(PROBE_QUERY, { variables: { first: 3, resourceType: rt } });
        const d = (await resp.json()) as { data?: { translatableResources?: { edges: Array<{ node: { resourceId: string } }> } }; errors?: Array<{ message: string }> };
        if (d.errors?.length) {
          resourceThemeIds.push({ resourceType: rt, resourceId: `(error: ${d.errors[0].message})`, extractedThemeId: null });
          continue;
        }
        for (const edge of d.data?.translatableResources?.edges ?? []) {
          resourceThemeIds.push({
            resourceType: rt,
            resourceId: edge.node.resourceId,
            extractedThemeId: extractThemeIdFromResourceId(edge.node.resourceId),
          });
        }
      } catch (e) {
        resourceThemeIds.push({ resourceType: rt, resourceId: `(exception: ${e instanceof Error ? e.message : String(e)})`, extractedThemeId: null });
      }
      await new Promise((res) => setTimeout(res, 250));
    }

    // Compute a verdict: which stored rows would be INVISIBLE to the read path.
    let verdict: string;
    if (!resolvedSelectedThemeId) {
      verdict = "resolvedSelectedThemeId is null → themeScope is empty {} → NO theme filter is applied. A 404 is NOT caused by theme scoping; look elsewhere (migration not applied? column missing? empty DB?).";
    } else {
      const visible = new Set([resolvedSelectedThemeId, ""]);
      const invisible = dbThemeContentByThemeId.filter((x) => !visible.has(x.themeId));
      if (dbThemeContentByThemeId.length === 0) {
        verdict = "No theme-domain ThemeContent rows exist at all for this shop → the theme has never been synced (or was wiped). Expected 404 until a full theme sync runs.";
      } else if (invisible.length === 0) {
        verdict = `All stored themeIds are visible (either "" or the resolved selection ${resolvedSelectedThemeId}). Theme scoping is NOT the 404 cause here.`;
      } else {
        verdict =
          `ROOT CAUSE CONFIRMED: ${invisible.reduce((n, x) => n + x.count, 0)} ThemeContent row(s) are stored under themeId(s) ` +
          `[${invisible.map((x) => `"${x.themeId}" (${x.count})`).join(", ")}] which are NEITHER "" NOR the resolved selection ` +
          `"${resolvedSelectedThemeId}". The read path (themeId IN ["${resolvedSelectedThemeId}", ""]) filters them out → 404.`;
      }
    }

    report.themeSelectionDiag = {
      themes,
      mainThemeId,
      storedSelectedThemeId,
      resolvedSelectedThemeId,
      dbThemeContentByThemeId,
      dbThemeTranslationByThemeId,
      resourceThemeIds,
      verdict,
    };
  } catch (e) {
    logger.error("[TRANSLATION-PROBE] theme-selection diag failed", { context: "TranslationProbe", error: e instanceof Error ? e.message : String(e) });
    report.themeSelectionDiag = {
      themes: [],
      mainThemeId: null,
      storedSelectedThemeId: null,
      resolvedSelectedThemeId: null,
      dbThemeContentByThemeId: [],
      dbThemeTranslationByThemeId: [],
      resourceThemeIds: [],
      verdict: `Diagnostic failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // ── Theme-fetch workaround test ─────────────────────────────────────────────
  // Empirically answers: can an UNPUBLISHED theme's translatable content be
  // reached, and via which API? (1) translations API with a rewritten theme_id
  // (expected: empty), (2) translatableResourcesByIds (expected: empty),
  // (3) theme-files API per Theme-GID (expected: returns the target theme).
  try {
    const tsd = report.themeSelectionDiag;
    const themesList = tsd?.themes ?? [];
    const mainId = tsd?.mainThemeId ?? null;
    // Prefer the resolved selection if it's non-MAIN; else any non-MAIN theme.
    const targetTheme =
      (tsd?.resolvedSelectedThemeId && tsd.resolvedSelectedThemeId !== mainId
        ? themesList.find((t) => t.id === tsd.resolvedSelectedThemeId)
        : undefined) ??
      themesList.find((t) => t.id !== mainId && String(t.role).toUpperCase() !== "MAIN") ??
      null;

    const wa: ThemeFetchWorkaround = {
      targetTheme: targetTheme ?? null,
      translationsApiRewrite: { resourceId: "", contentCount: 0 },
      translationsApiByIds: { contentCount: 0 },
      themeFilesRead: [],
      verdict: "",
    };

    const numericOf = (gid: string) => gid.split("/").pop() || gid;

    if (!targetTheme) {
      wa.verdict = "No non-MAIN theme available to test — cannot probe the unpublished-theme workaround.";
    } else {
      const targetNumeric = numericOf(targetTheme.id);

      // (1)+(2): rewrite theme_id on a real resourceId to point at the target theme.
      const srcEntry = (tsd?.resourceThemeIds ?? []).find(
        (r) => r.extractedThemeId && /[?&]theme_id=\d+/.test(r.resourceId)
      );
      if (!srcEntry) {
        wa.translationsApiRewrite = { resourceId: "(no source resourceId with theme_id found)", contentCount: 0, error: "skipped" };
        wa.translationsApiByIds = { contentCount: 0, error: "skipped" };
      } else {
        const rewritten = srcEntry.resourceId.replace(/([?&]theme_id=)\d+/, `$1${targetNumeric}`);
        wa.translationsApiRewrite.resourceId = rewritten;
        try {
          const r1 = await admin.graphql(SINGLE_TRANSLATABLE_QUERY, { variables: { resourceId: rewritten } });
          const d1 = (await r1.json()) as { data?: { translatableResource?: { translatableContent?: unknown[] } }; errors?: Array<{ message: string }> };
          if (d1.errors?.length) wa.translationsApiRewrite.error = d1.errors.map((e) => e.message).join(" | ");
          else wa.translationsApiRewrite.contentCount = d1.data?.translatableResource?.translatableContent?.length ?? 0;
        } catch (e) {
          wa.translationsApiRewrite.error = e instanceof Error ? e.message : String(e);
        }
        await new Promise((res) => setTimeout(res, 250));
        try {
          const r2 = await admin.graphql(BY_IDS_TRANSLATABLE_QUERY, { variables: { resourceIds: [rewritten] } });
          const d2 = (await r2.json()) as { data?: { translatableResourcesByIds?: { edges: Array<{ node: { translatableContent?: unknown[] } }> } }; errors?: Array<{ message: string }> };
          if (d2.errors?.length) wa.translationsApiByIds.error = d2.errors.map((e) => e.message).join(" | ");
          else wa.translationsApiByIds.contentCount = (d2.data?.translatableResourcesByIds?.edges ?? []).reduce((n, ed) => n + (ed.node.translatableContent?.length ?? 0), 0);
        } catch (e) {
          wa.translationsApiByIds.error = e instanceof Error ? e.message : String(e);
        }
      }

      // (3): read locale files from BOTH MAIN and the target theme via theme-files API.
      const localeFilenames = [
        `locales/${primaryLocale}.default.json`,
        ...enabledLocales.filter((l) => l !== primaryLocale).map((l) => `locales/${l}.json`),
      ];
      const readThemeFiles = async (label: "MAIN" | "target", themeGid: string) => {
        try {
          const r = await admin.graphql(THEME_FILES_QUERY, { variables: { id: themeGid, filenames: localeFilenames } });
          const d = (await r.json()) as {
            data?: { theme?: { files?: { nodes: Array<{ filename: string; body?: { content?: string } }> } } };
            errors?: Array<{ message: string }>;
          };
          if (d.errors?.length) {
            wa.themeFilesRead.push({ theme: label, filename: "(query)", found: false, byteSize: 0, sampleKeys: [], error: d.errors.map((e) => e.message).join(" | ") });
            return;
          }
          const nodes = d.data?.theme?.files?.nodes ?? [];
          if (nodes.length === 0) {
            wa.themeFilesRead.push({ theme: label, filename: localeFilenames.join(", "), found: false, byteSize: 0, sampleKeys: [] });
            return;
          }
          for (const n of nodes) {
            let sampleKeys: string[] = [];
            try {
              const parsed = JSON.parse(n.body?.content ?? "{}");
              sampleKeys = Object.keys(parsed).slice(0, 8);
            } catch { /* non-JSON or truncated */ }
            wa.themeFilesRead.push({ theme: label, filename: n.filename, found: true, byteSize: n.body?.content?.length ?? 0, sampleKeys });
          }
        } catch (e) {
          wa.themeFilesRead.push({ theme: label, filename: "(exception)", found: false, byteSize: 0, sampleKeys: [], error: e instanceof Error ? e.message : String(e) });
        }
      };
      if (mainId) await readThemeFiles("MAIN", mainId);
      await new Promise((res) => setTimeout(res, 250));
      await readThemeFiles("target", targetTheme.id);

      // Verdict
      const translApiReached = wa.translationsApiRewrite.contentCount > 0 || wa.translationsApiByIds.contentCount > 0;
      const targetFilesFound = wa.themeFilesRead.some((f) => f.theme === "target" && f.found);
      if (translApiReached) {
        wa.verdict = `UNEXPECTED: the translations API returned content for the target theme (rewrite=${wa.translationsApiRewrite.contentCount}, byIds=${wa.translationsApiByIds.contentCount}). Per-theme reads via the translations API may be possible after all — re-evaluate before restricting to MAIN.`;
      } else if (targetFilesFound) {
        wa.verdict = `CONFIRMED: translations API cannot reach the unpublished theme "${targetTheme.name}" (rewrite=0, byIds=0${wa.translationsApiRewrite.error ? `, err="${wa.translationsApiRewrite.error}"` : ""}), BUT the theme-files API returns its locale file(s). → Option B (rebuild theme content on the theme-files API) is technically viable for unpublished themes.`;
      } else {
        wa.verdict = `Translations API returned nothing for the target theme AND the theme-files read found no locale files (${wa.themeFilesRead.filter((f) => f.theme === "target").map((f) => f.error ?? "empty").join("; ") || "empty"}). If the theme-files error is a scope/permission issue, that's fixable; if the theme genuinely has no locale files, there is nothing to edit there.`;
      }
    }

    report.themeFetchWorkaround = wa;
  } catch (e) {
    logger.error("[TRANSLATION-PROBE] theme-fetch workaround test failed", { context: "TranslationProbe", error: e instanceof Error ? e.message : String(e) });
    report.themeFetchWorkaround = {
      targetTheme: null,
      translationsApiRewrite: { resourceId: "", contentCount: 0, error: e instanceof Error ? e.message : String(e) },
      translationsApiByIds: { contentCount: 0, error: "aborted" },
      themeFilesRead: [],
      verdict: `Workaround test failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Optional write test against SHOP — answers "do app writes override the
  // built-in 33-language pack?" question from the plan.
  if (wantsWriteTest && shopGid) {
    const writeLocale = enabledLocales.find((l) => l !== primaryLocale);
    if (!writeLocale) {
      report.writeTest = {
        attempted: false,
        note: "No non-primary locale enabled — cannot probe override behaviour. Enable a second language and retry.",
      };
    } else {
      const targetKey = "checkout.general.continue_button";
      const tag = `__cp-probe-${Date.now()}`;
      const attemptedValue = `Continue [${tag}]`;
      const wt: WriteTestReport = {
        attempted: true,
        targetLocale: writeLocale,
        targetKey,
        attemptedValue,
      };

      try {
        // Fetch digest for the target key
        const tr = await admin.graphql(SHOP_TRANSLATIONS_QUERY, { variables: { resourceId: shopGid, locale: writeLocale } });
        const td = (await tr.json()) as { data?: { translatableResource?: { translatableContent?: Array<{ key: string; value: string | null; digest: string }>; translations?: Array<{ key: string; value: string }> } }; errors?: Array<{ message: string }> };
        if (td.errors?.length) {
          wt.result = "failure";
          wt.errors = td.errors.map((e) => e.message);
        } else {
          const item = (td.data?.translatableResource?.translatableContent ?? []).find((i) => i.key === targetKey);
          const existing = (td.data?.translatableResource?.translations ?? []).find((i) => i.key === targetKey)?.value ?? null;
          wt.before = existing;

          if (!item?.digest) {
            wt.result = "failure";
            wt.errors = [`Key "${targetKey}" not present in SHOP translatableContent — pick a different key for this shop.`];
          } else {
            const mResp = await admin.graphql(TRANSLATIONS_REGISTER, {
              variables: {
                resourceId: shopGid,
                translations: [{
                  key: targetKey,
                  value: attemptedValue,
                  locale: writeLocale,
                  translatableContentDigest: item.digest,
                }],
              },
            });
            const mData = (await mResp.json()) as { data?: { translationsRegister?: { translations: unknown[]; userErrors: Array<{ field: string[]; message: string }> } }; errors?: Array<{ message: string }> };
            if (mData.errors?.length) {
              wt.result = "failure";
              wt.errors = mData.errors.map((e) => e.message);
            } else if (mData.data?.translationsRegister?.userErrors?.length) {
              wt.result = "failure";
              wt.errors = mData.data.translationsRegister.userErrors.map((e) => `${e.field?.join(".")}: ${e.message}`);
            } else {
              wt.result = "success";
              wt.note = `Now visit Shopify Admin → Settings → Languages → ${writeLocale} → Translate (search "continue") and verify whether the value "${attemptedValue}" replaced Shopify's built-in translation, or whether the built-in still wins. Restore the original value when done by clearing the override in the admin UI.`;
            }
          }
        }
      } catch (e) {
        wt.result = "failure";
        wt.errors = [e instanceof Error ? e.message : String(e)];
      }
      report.writeTest = wt;
    }
  }

  logger.info("[TRANSLATION-PROBE] Done", {
    context: "TranslationProbe",
    shop: session.shop,
    types: report.resources.length,
    okTypes: report.resources.filter((r) => r.status === "ok").length,
    writeAttempted: report.writeTest.attempted,
  });

  return json({ success: true, report });
}
