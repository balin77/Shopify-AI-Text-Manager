/**
 * Translation Coverage Probe — Phase 0 / one-shot dev tool
 *
 * Hits every TranslatableResourceType the plan §10 calls out as "NEW" and
 * reports key shapes, sample values, total counts, locale coverage, and
 * write-test results. Output is consumed by the Settings → Translation
 * Probe tab as a paste-ready markdown report. See
 * docs/architecture/TRANSLATION_COVERAGE.md §10 Phase 0 / §12 spike findings.
 *
 * Read-only by default. Pass formData "writeTest=true" to attempt a single
 * SHOP write against an enabled non-primary locale (used to answer the
 * built-in-override question). The write targets a low-impact key
 * (`checkout.general.continue_button`) and tags the value so it's easy to
 * spot in the admin language editor.
 */

import { data as json, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
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
  imageAltDiag?: ImageAltDiag;
}

/**
 * Empirical answer to "which images can have a TRANSLATED alt text?".
 *
 * Product media are known to work (the app writes them today: translationsRegister
 * on the MediaImage GID, key "alt"). Open questions this section settles with
 * data from THIS shop instead of assumptions:
 *
 * 1. Is MEDIA_IMAGE a valid `TranslatableResourceType`? If yes, every image in
 *    the Files library — not just product media — can be enumerated and
 *    translated through one and the same path.
 * 2. Does a COLLECTION / ARTICLE carry an alt key in its own translatable
 *    content? (Expected: no — their translatable keys are title/body_html/
 *    meta_title/meta_description/handle.)
 * 3. Does a collection's / article's featured image have an addressable GID of
 *    its own, and does `translatableResource` resolve it? Shopify's legacy
 *    `Image` type is not a MediaImage, so this is the crux: if it resolves,
 *    those alts ARE translatable after all; if not, they are not — full stop.
 */
interface ImageAltDiag {
  /** One entry per resource type we asked `translatableResources(resourceType:)` for. */
  enumSupport: Array<{ resourceType: string; supported: boolean; sampleCount: number; error?: string }>;
  /** Sample subjects and what their translatable content looks like. */
  subjects: ImageAltSubject[];
  /** Can a CollectionImage/ArticleImage be traced back to a MediaImage? */
  fileLink: ImageFileLink[];
  /** Would a filename-based owner index actually work, measured over a sample? */
  ownerLinkage?: ImageOwnerLinkageDiag;
  verdict: string;
}

/**
 * Measures whether collection/article images could be ATTRIBUTED to their
 * owner in the media library ("where is this picture used?"), which today
 * reports `unknown` for both.
 *
 * The link can only be the FILENAME: a collection's picture is a
 * CollectionImage, not a MediaImage, and Shopify's `files()` has no
 * "used by" facet. So this walks from the authoritative side — every sampled
 * collection/article knows its own image URL — and looks the basename up in
 * the local MediaLibraryImage cache, which is what a real implementation
 * would use (no extra Shopify calls per image).
 *
 * Three things decide whether that is buildable, and all three are counted
 * rather than argued about:
 *
 *  1. `unique`  — exactly ONE cache row carries that filename. Only these
 *     could ever be attributed; anything else must stay `unknown`, the same
 *     posture usage.server.ts already takes for ambiguous owners.
 *  2. `ambiguous` / `none` — a filename shared by several files, or a picture
 *     that is not in the Files library at all (the sampled ARTICLE was
 *     exactly this: served from /articles/, absent from Files).
 *  3. `altDiverges` — of the unique matches, how many have a file alt text
 *     that differs from the object's own. Every one of those is a case where
 *     labelling the file "belongs to collection X" would invite an edit that
 *     silently does not reach the storefront, because the two alts are
 *     separate records.
 *
 * A cache that was never synced makes the whole measurement meaningless, so
 * its size is reported alongside — 0 matches out of an empty cache says
 * nothing about linkability.
 */
interface ImageOwnerLinkageDiag {
  /** Rows in MediaLibraryImage for this shop. 0 ⇒ the numbers below are void. */
  cachedImages: number;
  groups: ImageOwnerLinkageGroup[];
  verdict: string;
}

interface ImageOwnerLinkageGroup {
  kind: "collection" | "article";
  sampled: number;
  withImage: number;
  unique: number;
  ambiguous: number;
  none: number;
  /** Of the `unique` ones: file alt ≠ object alt (both non-empty or one empty). */
  altDiverges: number;
  /** A few concrete rows, so the aggregate can be sanity-checked. */
  examples: Array<{
    title: string;
    basename: string;
    matches: number;
    objectAlt: string;
    fileAlt: string | null;
  }>;
}

/**
 * Empirical answer to "can we get from a CollectionImage/ArticleImage GID to
 * the MediaImage that actually holds the file?".
 *
 * It matters because a MediaImage IS translatable and the bulk editor already
 * writes it. If a collection's featured image turns out to BE a file in the
 * Files library, its alt text needs no new write path at all — only the link.
 *
 * Two independent hypotheses, deliberately tested separately:
 *
 *  A) ARITHMETIC — is the numeric tail of `gid://shopify/CollectionImage/123`
 *     the same record as `gid://shopify/MediaImage/123`? Expected: no (they
 *     are different types from different id spaces), but "expected" is not
 *     "measured", and a single `node()` lookup settles it. A resolved node
 *     only counts if its URL is the SAME picture — otherwise the number
 *     merely collides with an unrelated file.
 *
 *  B) THE FILE ITSELF — does the image's filename appear in `files()`? If it
 *     appears exactly once and that file's URL is the same picture, the
 *     mapping is exact rather than a heuristic. Several hits, or a different
 *     URL, means it is guesswork and must not be built on.
 *
 * `urlMatch` compares the BASENAME, not the full URL: Shopify serves the same
 * file under different CDN path segments depending on where it is attached
 * (…/collections/… vs …/files/…), so comparing whole URLs would report a
 * mismatch for a genuine match. The full URLs are reported too, so the bucket
 * difference stays visible instead of being silently normalised away.
 */
interface ImageFileLink {
  kind: "collectionImage" | "articleImage";
  ownerLabel: string;
  /** The legacy image GID, "" when the object has none (or has no image). */
  sourceImageId: string;
  sourceUrl: string;
  sourceBasename: string;
  /** A) node(gid://shopify/MediaImage/<same number>). */
  arithmetic: {
    /** The GID we constructed, "" when the source GID carries no number. */
    triedId: string;
    resolved: boolean;
    /** __typename of whatever came back — a non-MediaImage is a red flag. */
    typename: string;
    url: string;
    urlMatch: boolean;
    error?: string;
  };
  /** B) files(query: "filename:…"). */
  byFilename: {
    query: string;
    hits: Array<{ id: string; typename: string; url: string; alt: string | null }>;
    /** Hits whose basename equals the source basename. */
    exactMatches: number;
    error?: string;
  };
}

interface ImageAltSubject {
  kind: "productMedia" | "collection" | "collectionImage" | "article" | "articleImage";
  /** The GID we asked about ("" when the shop has no such object). */
  resourceId: string;
  label: string;
  /** Present for the *Image subjects: what the object's image field returned. */
  imageProbe?: {
    hasImage: boolean;
    imageId: string | null;
    altText: string | null;
    /** False when Shopify rejected `image { id }` outright — the legacy Image
     * type then has no addressable GID at all. */
    idSelectable: boolean;
  };
  /** translatableResource(resourceId) → the keys it offers. */
  translatableKeys: string[];
  hasAltKey: boolean;
  error?: string;
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

// Sample subjects for the image-alt diagnosis. Deliberately THREE separate
// queries: `image { id }` may not even be selectable on Shopify's legacy Image
// type, and root-level `articles` is newer than some API versions — one
// combined query would let a single invalid field hide every other answer.
const IMAGE_ALT_PRODUCTS_QUERY = `#graphql
  query imageAltProducts {
    products(first: 25) {
      nodes {
        id
        title
        media(first: 1) { nodes { ... on MediaImage { id alt } } }
      }
    }
  }
`;

/** `$withId` is not a GraphQL feature — the caller string-swaps the selection
 * so a failure of `image { id }` is observable instead of fatal. */
const IMAGE_ALT_COLLECTIONS_QUERY = (withId: boolean) => `#graphql
  query imageAltCollections {
    collections(first: 25) {
      nodes { id title image { ${withId ? "id " : ""}url altText } }
    }
  }
`;

const IMAGE_ALT_ARTICLES_QUERY = (withId: boolean) => `#graphql
  query imageAltArticles {
    articles(first: 25) {
      nodes { id title image { ${withId ? "id " : ""}url altText } }
    }
  }
`;

/** Fallback for API versions without a root `articles` connection. */
const IMAGE_ALT_ARTICLES_VIA_BLOGS_QUERY = (withId: boolean) => `#graphql
  query imageAltArticlesViaBlogs {
    blogs(first: 5) {
      nodes {
        articles(first: 10) { nodes { id title image { ${withId ? "id " : ""}url altText } } }
      }
    }
  }
`;

/** A) Is `gid://shopify/MediaImage/<n>` — same n as the legacy image GID —
 * a real object, and is it the same picture? */
const MEDIA_IMAGE_BY_ID_QUERY = `#graphql
  query mediaImageById($id: ID!) {
    node(id: $id) {
      __typename
      ... on MediaImage { id alt image { url } }
    }
  }
`;

/** B) Does the file exist in the Files library under this filename? */
const FILES_BY_FILENAME_QUERY = `#graphql
  query filesByFilename($query: String!) {
    files(first: 10, query: $query) {
      nodes {
        __typename
        ... on MediaImage { id alt image { url } }
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
  return json({ ok: true, hint: "POST to run the probe. See docs/architecture/TRANSLATION_COVERAGE.md §10 Phase 0." });
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

  // ── Image alt-text diagnosis (read-only) ─────────────────────────────────
  report.imageAltDiag = await probeImageAltTranslatability(admin, session.shop);

  logger.info("[TRANSLATION-PROBE] Done", {
    context: "TranslationProbe",
    shop: session.shop,
    types: report.resources.length,
    okTypes: report.resources.filter((r) => r.status === "ok").length,
    writeAttempted: report.writeTest.attempted,
  });

  return json({ success: true, report });
}

/**
 * Answers "which images can carry a translated alt text?" empirically.
 *
 * Read-only: enumeration attempts and translatableResource lookups only, no
 * mutation. An unsupported enum value comes back as a GraphQL error, which is
 * exactly the signal we want — so errors are REPORTED, never swallowed.
 */
async function probeImageAltTranslatability(
  admin: { graphql: (query: string, opts?: Record<string, unknown>) => Promise<Response> },
  shop: string,
): Promise<ImageAltDiag> {
  const enumSupport: ImageAltDiag["enumSupport"] = [];
  const subjects: ImageAltSubject[] = [];

  // 1. Which enum values does this API version accept? MEDIA_IMAGE is the
  //    interesting one: it would make the whole Files library enumerable.
  for (const resourceType of ["MEDIA_IMAGE", "COLLECTION", "ARTICLE", "PRODUCT_IMAGE", "FILE"]) {
    try {
      const response = await admin.graphql(PROBE_QUERY, { variables: { first: 3, resourceType } });
      const data = (await response.json()) as {
        data?: { translatableResources?: { edges?: unknown[] } };
        errors?: Array<{ message: string }>;
      };
      if (data.errors?.length) {
        enumSupport.push({ resourceType, supported: false, sampleCount: 0, error: data.errors[0].message });
        continue;
      }
      enumSupport.push({
        resourceType,
        supported: true,
        sampleCount: data.data?.translatableResources?.edges?.length ?? 0,
      });
    } catch (e) {
      enumSupport.push({
        resourceType,
        supported: false,
        sampleCount: 0,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // 2. Sample subjects: a product's MediaImage (the known-good baseline), a
  //    collection and an article — each once as the OBJECT and once as its
  //    IMAGE, if the image has an addressable GID at all.
  const noteFailure = (label: string, error: string) => {
    subjects.push({
      kind: "productMedia",
      resourceId: "",
      label,
      translatableKeys: [],
      hasAltKey: false,
      error,
    });
  };

  /** Runs a query and returns its data, or null (after recording why). */
  const run = async <T,>(
    label: string,
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T | null> => {
    try {
      const response = await admin.graphql(query, variables ? { variables } : undefined);
      const data = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
      if (data.errors?.length) {
        noteFailure(label, data.errors.map((e) => e.message).join(" | "));
        return null;
      }
      return data.data ?? null;
    } catch (e) {
      noteFailure(label, e instanceof Error ? e.message : String(e));
      return null;
    }
  };

  interface ImageNode {
    id: string;
    title: string;
    image?: { id?: string | null; url?: string | null; altText?: string | null } | null;
  }

  let sampleProductMedia: { id: string; label: string } | null = null;
  const productData = await run<{ products?: { nodes?: Array<{ id: string; title: string; media?: { nodes?: Array<{ id?: string; alt?: string | null }> } }> } }>(
    "product media query",
    IMAGE_ALT_PRODUCTS_QUERY,
  );
  for (const product of productData?.products?.nodes ?? []) {
    const media = product.media?.nodes?.find((m) => m?.id);
    if (media?.id) {
      sampleProductMedia = { id: media.id, label: product.title };
      break;
    }
  }

  /**
   * Picks the first object that HAS an image, and reports whether `image { id }`
   * was even selectable — a legacy `Image` without an addressable GID can never
   * be a translation target, and that answer is exactly what we are after.
   */
  const pickWithImage = async (
    label: string,
    build: (withId: boolean) => string,
    extract: (data: unknown) => ImageNode[],
    // `nodes` is the WHOLE page — the linkage measurement needs a sample, not
    // the one best specimen.
  ): Promise<{ node: ImageNode | null; nodes: ImageNode[]; imageIdSelectable: boolean }> => {
    // Prefer a sample whose image HAS an alt text: on an image without one,
    // "no translatable keys" would be ambiguous between "not translatable at
    // all" and "nothing set that could be translated".
    const best = (nodes: ImageNode[]): ImageNode | null =>
      nodes.find((n) => n.image?.altText && n.image.altText.trim() !== "") ??
      nodes.find((n) => n.image) ??
      nodes[0] ??
      null;

    const withId = await run<unknown>(`${label} (image.id)`, build(true));
    if (withId) {
      const nodes = extract(withId);
      return { node: best(nodes), nodes, imageIdSelectable: true };
    }
    // `image { id }` was rejected — retry without it so we still learn whether
    // the object has an image at all.
    const withoutId = await run<unknown>(`${label} (no image.id)`, build(false));
    if (!withoutId) return { node: null, nodes: [], imageIdSelectable: false };
    const nodes = extract(withoutId);
    return { node: best(nodes), nodes, imageIdSelectable: false };
  };

  const collectionPick = await pickWithImage("collections", IMAGE_ALT_COLLECTIONS_QUERY, (data) => {
    const typed = data as { collections?: { nodes?: ImageNode[] } };
    return typed.collections?.nodes ?? [];
  });
  let articlePick = await pickWithImage("articles", IMAGE_ALT_ARTICLES_QUERY, (data) => {
    const typed = data as { articles?: { nodes?: ImageNode[] } };
    return typed.articles?.nodes ?? [];
  });
  if (!articlePick.node) {
    // Older API versions have no root `articles` connection — go through blogs.
    articlePick = await pickWithImage("articles via blogs", IMAGE_ALT_ARTICLES_VIA_BLOGS_QUERY, (data) => {
      const typed = data as { blogs?: { nodes?: Array<{ articles?: { nodes?: ImageNode[] } }> } };
      return (typed.blogs?.nodes ?? []).flatMap((b) => b.articles?.nodes ?? []);
    });
  }

  const sampleCollection = collectionPick.node;
  const sampleArticle = articlePick.node;

  const inspect = async (kind: ImageAltSubject["kind"], resourceId: string, label: string, imageProbe?: ImageAltSubject["imageProbe"]) => {
    const subject: ImageAltSubject = {
      kind,
      resourceId,
      label,
      ...(imageProbe ? { imageProbe } : {}),
      translatableKeys: [],
      hasAltKey: false,
    };
    if (!resourceId) {
      subject.error = "no such object in this shop (or the image has no addressable GID)";
      subjects.push(subject);
      return;
    }
    try {
      const response = await admin.graphql(SINGLE_TRANSLATABLE_QUERY, { variables: { resourceId } });
      const data = (await response.json()) as {
        data?: { translatableResource?: { translatableContent?: Array<{ key: string }> } | null };
        errors?: Array<{ message: string }>;
      };
      if (data.errors?.length) {
        subject.error = data.errors.map((e) => e.message).join(" | ");
      } else if (!data.data?.translatableResource) {
        subject.error = "translatableResource resolved to null — not a translatable resource";
      } else {
        subject.translatableKeys = [...new Set((data.data.translatableResource.translatableContent ?? []).map((c) => c.key))];
        subject.hasAltKey = subject.translatableKeys.includes("alt");
      }
    } catch (e) {
      subject.error = e instanceof Error ? e.message : String(e);
    }
    subjects.push(subject);
  };

  await inspect("productMedia", sampleProductMedia?.id ?? "", sampleProductMedia?.label ?? "(no product with media)");
  await inspect("collection", sampleCollection?.id ?? "", sampleCollection?.title ?? "(no collection)");
  await inspect(
    "collectionImage",
    sampleCollection?.image?.id ?? "",
    `${sampleCollection?.title ?? "(no collection)"} → image`,
    {
      hasImage: !!sampleCollection?.image,
      imageId: sampleCollection?.image?.id ?? null,
      altText: sampleCollection?.image?.altText ?? null,
      idSelectable: collectionPick.imageIdSelectable,
    },
  );
  await inspect("article", sampleArticle?.id ?? "", sampleArticle?.title ?? "(no article)");
  await inspect(
    "articleImage",
    sampleArticle?.image?.id ?? "",
    `${sampleArticle?.title ?? "(no article)"} → image`,
    {
      hasImage: !!sampleArticle?.image,
      imageId: sampleArticle?.image?.id ?? null,
      altText: sampleArticle?.image?.altText ?? null,
      idSelectable: articlePick.imageIdSelectable,
    },
  );

  const fileLink: ImageFileLink[] = [
    await probeImageFileLink(admin, run, "collectionImage", sampleCollection),
    await probeImageFileLink(admin, run, "articleImage", sampleArticle),
  ];

  const ownerLinkage = await probeImageOwnerLinkage(shop, collectionPick.nodes, articlePick.nodes);

  return {
    enumSupport,
    subjects,
    fileLink,
    ownerLinkage,
    verdict: buildImageAltVerdict(enumSupport, subjects, fileLink),
  };
}

/** See {@link ImageOwnerLinkageDiag}. Reads the local media cache only — the
 * point is to measure what an implementation could do WITHOUT extra Shopify
 * calls per image. */
async function probeImageOwnerLinkage(
  shop: string,
  collections: Array<{ title: string; image?: { url?: string | null; altText?: string | null } | null }>,
  articles: Array<{ title: string; image?: { url?: string | null; altText?: string | null } | null }>,
): Promise<ImageOwnerLinkageDiag> {
  const cachedImages = await db.mediaLibraryImage.count({ where: { shop } }).catch(() => 0);

  const measure = async (
    kind: ImageOwnerLinkageGroup["kind"],
    objects: Array<{ title: string; image?: { url?: string | null; altText?: string | null } | null }>,
  ): Promise<ImageOwnerLinkageGroup> => {
    const group: ImageOwnerLinkageGroup = {
      kind,
      sampled: objects.length,
      withImage: 0,
      unique: 0,
      ambiguous: 0,
      none: 0,
      altDiverges: 0,
      examples: [],
    };
    for (const object of objects) {
      const basename = cdnBasename(object.image?.url ?? "");
      if (!basename) continue;
      group.withImage += 1;
      const hits = await db.mediaLibraryImage
        .findMany({ where: { shop, filename: basename }, select: { altText: true }, take: 5 })
        .catch(() => [] as { altText: string | null }[]);
      const objectAlt = object.image?.altText ?? "";
      let fileAlt: string | null = null;
      if (hits.length === 1) {
        group.unique += 1;
        fileAlt = hits[0].altText ?? "";
        // The trap this whole section exists to quantify: same picture, two
        // alt-text records. Editing the file would not move the object's.
        if ((fileAlt ?? "").trim() !== objectAlt.trim()) group.altDiverges += 1;
      } else if (hits.length > 1) {
        group.ambiguous += 1;
      } else {
        group.none += 1;
      }
      if (group.examples.length < 5) {
        group.examples.push({ title: object.title, basename, matches: hits.length, objectAlt, fileAlt });
      }
    }
    return group;
  };

  const groups = [await measure("collection", collections), await measure("article", articles)];
  return { cachedImages, groups, verdict: buildOwnerLinkageVerdict(cachedImages, groups) };
}

function buildOwnerLinkageVerdict(cachedImages: number, groups: ImageOwnerLinkageGroup[]): string {
  if (cachedImages === 0) {
    return "The media-library cache is EMPTY for this shop — run the media sync first, otherwise every number below is zero for the wrong reason.";
  }
  const parts = [`Media cache holds ${cachedImages} image(s).`];
  for (const group of groups) {
    if (group.withImage === 0) {
      parts.push(`${group.kind}: no sampled object has an image — inconclusive.`);
      continue;
    }
    const pct = Math.round((group.unique / group.withImage) * 100);
    parts.push(
      `${group.kind}: ${group.unique}/${group.withImage} (${pct}%) resolve to exactly one cached file` +
        `${group.ambiguous ? `, ${group.ambiguous} ambiguous` : ""}` +
        `${group.none ? `, ${group.none} not in the library` : ""}.` +
        (group.unique > 0
          ? ` Of the unique ones, ${group.altDiverges} carry a DIFFERENT alt text than the object — attributing those would invite an edit that never reaches the storefront.`
          : ""),
    );
  }
  return parts.join(" ");
}

/** Last path segment of a CDN URL, query string stripped and percent-decoded.
 * Shopify serves the same file under different path segments depending on what
 * it is attached to, so the basename is the only stable part. */
function cdnBasename(url: string): string {
  if (!url) return "";
  const withoutQuery = url.split("?")[0];
  const last = withoutQuery.slice(withoutQuery.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** Tests both routes from a legacy image GID to a MediaImage — see ImageFileLink. */
async function probeImageFileLink(
  admin: { graphql: (query: string, opts?: Record<string, unknown>) => Promise<Response> },
  run: <T>(label: string, query: string, variables?: Record<string, unknown>) => Promise<T | null>,
  kind: ImageFileLink["kind"],
  owner: { title: string; image?: { id?: string | null; url?: string | null } | null } | null,
): Promise<ImageFileLink> {
  const sourceImageId = owner?.image?.id ?? "";
  const sourceUrl = owner?.image?.url ?? "";
  const sourceBasename = cdnBasename(sourceUrl);
  const link: ImageFileLink = {
    kind,
    ownerLabel: owner?.title ?? "(no such object in this shop)",
    sourceImageId,
    sourceUrl,
    sourceBasename,
    arithmetic: { triedId: "", resolved: false, typename: "", url: "", urlMatch: false },
    byFilename: { query: "", hits: [], exactMatches: 0 },
  };
  if (!owner?.image) {
    link.arithmetic.error = "the object has no image";
    link.byFilename.error = "the object has no image";
    return link;
  }

  // A) same number, different type.
  const numeric = sourceImageId.match(/\/(\d+)(?:\?|$)/)?.[1] ?? "";
  if (!numeric) {
    link.arithmetic.error = sourceImageId
      ? "the image GID carries no numeric id"
      : "the image has no addressable GID at all";
  } else {
    const triedId = `gid://shopify/MediaImage/${numeric}`;
    link.arithmetic.triedId = triedId;
    const data = await run<{ node?: { __typename?: string; image?: { url?: string | null } | null } | null }>(
      `${kind} → MediaImage by same id`,
      MEDIA_IMAGE_BY_ID_QUERY,
      { id: triedId },
    );
    if (data) {
      const node = data.node ?? null;
      link.arithmetic.resolved = !!node;
      link.arithmetic.typename = node?.__typename ?? "";
      link.arithmetic.url = node?.image?.url ?? "";
      // Resolving is not enough: an unrelated file whose id happens to collide
      // would look like a hit. Only the same picture counts.
      link.arithmetic.urlMatch =
        !!link.arithmetic.url && cdnBasename(link.arithmetic.url) === sourceBasename;
    } else {
      link.arithmetic.error = "query failed — see the errors above";
    }
  }

  // B) the file itself.
  if (!sourceBasename) {
    link.byFilename.error = "the image URL has no filename";
    return link;
  }
  const query = `filename:${sourceBasename}`;
  link.byFilename.query = query;
  const files = await run<{
    files?: { nodes?: Array<{ __typename?: string; id?: string; alt?: string | null; image?: { url?: string | null } | null }> };
  }>(`${kind} → files by filename`, FILES_BY_FILENAME_QUERY, { query });
  if (!files) {
    link.byFilename.error = "query failed — see the errors above";
    return link;
  }
  for (const node of files.files?.nodes ?? []) {
    link.byFilename.hits.push({
      id: node.id ?? "",
      typename: node.__typename ?? "",
      url: node.image?.url ?? "",
      alt: node.alt ?? null,
    });
  }
  link.byFilename.exactMatches = link.byFilename.hits.filter(
    (h) => cdnBasename(h.url) === sourceBasename,
  ).length;
  return link;
}

/** Plain-language reading of the numbers above — the sentence that actually
 * answers the planning question. */
function buildImageAltVerdict(
  enumSupport: ImageAltDiag["enumSupport"],
  subjects: ImageAltSubject[],
  fileLink: ImageFileLink[],
): string {
  const parts: string[] = [];
  const mediaImageEnum = enumSupport.find((e) => e.resourceType === "MEDIA_IMAGE");
  const productMedia = subjects.find((s) => s.kind === "productMedia");
  const collectionImage = subjects.find((s) => s.kind === "collectionImage");
  const articleImage = subjects.find((s) => s.kind === "articleImage");

  parts.push(
    mediaImageEnum?.supported
      ? `MEDIA_IMAGE IS a translatable resource type — every image in the Files library can be enumerated (sample returned ${mediaImageEnum.sampleCount}).`
      : `MEDIA_IMAGE is NOT accepted as a TranslatableResourceType (${mediaImageEnum?.error ?? "no result"}) — images can only be reached through the objects that own them.`,
  );
  if (productMedia) {
    parts.push(
      productMedia.hasAltKey
        ? "Product media expose the 'alt' key as expected (baseline confirmed)."
        : `Product media did NOT expose an 'alt' key — baseline BROKEN, treat every other result here with suspicion (${productMedia.error ?? (productMedia.translatableKeys.join(", ") || "no keys")}).`,
    );
  }
  for (const [name, subject] of [["Collection", collectionImage], ["Article", articleImage]] as const) {
    if (!subject) continue;
    if (subject.imageProbe && !subject.imageProbe.idSelectable) {
      parts.push(
        `${name} featured image: Shopify rejected \`image { id }\` — the legacy Image type exposes no GID, so it can never be a translation target.`,
      );
    } else if (!subject.imageProbe?.hasImage) {
      parts.push(`${name} featured image: this shop has no sample to test with — inconclusive.`);
    } else if (!subject.imageProbe.imageId) {
      parts.push(`${name} featured image has NO addressable GID (image.id is null) — it cannot be a translation target.`);
    } else if (subject.hasAltKey) {
      parts.push(`${name} featured image IS translatable via ${subject.imageProbe.imageId} (key 'alt').`);
    } else {
      parts.push(
        `${name} featured image is NOT translatable: ${subject.error ?? `keys are [${subject.translatableKeys.join(", ")}]`}.`,
      );
    }
  }
  // The follow-up question: even if those images are not translatable in their
  // own right, can they be traced to a MediaImage that IS?
  for (const link of fileLink) {
    const name = link.kind === "collectionImage" ? "Collection" : "Article";
    if (!link.sourceUrl) {
      parts.push(`${name} image → MediaImage: no sample in this shop — inconclusive.`);
      continue;
    }
    if (link.arithmetic.urlMatch) {
      parts.push(
        `${name} image → MediaImage: the SAME numeric id resolves to the same picture (${link.arithmetic.triedId}) — the id spaces line up after all.`,
      );
    } else if (link.arithmetic.resolved) {
      parts.push(
        `${name} image → MediaImage: ${link.arithmetic.triedId} resolves to a ${link.arithmetic.typename || "node"} but a DIFFERENT picture — an id collision, not a mapping. Do not derive one GID from the other.`,
      );
    } else {
      parts.push(
        `${name} image → MediaImage: the same numeric id does not resolve (${link.arithmetic.error ?? "no node"}) — the GIDs cannot be converted into each other.`,
      );
    }
    if (link.byFilename.error) {
      parts.push(`${name} image → Files lookup failed: ${link.byFilename.error}`);
    } else if (link.byFilename.exactMatches === 1) {
      parts.push(
        `${name} image IS in the Files library, exactly once, as ${link.byFilename.hits.find((h) => h.url)?.id ?? "(a MediaImage)"} — the file is an EXACT link, so its alt text needs no new write path, only the association.`,
      );
    } else if (link.byFilename.exactMatches > 1) {
      parts.push(
        `${name} image matches ${link.byFilename.exactMatches} files by filename — ambiguous, so a filename mapping would be guesswork.`,
      );
    } else {
      parts.push(
        `${name} image is NOT in the Files library under its own filename (${link.byFilename.hits.length} unrelated hit(s)) — it is stored outside Files and has no MediaImage to translate.`,
      );
    }
  }
  return parts.join(" ");
}
