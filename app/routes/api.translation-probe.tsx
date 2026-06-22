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

// Probe target list. Includes resource types we already cover, so we can find
// where Shopify hides things like Cookie-Banner (which T&A exposes but our
// initial probe couldn't locate). The "already covered" types are listed near
// the top so any cookie-related keys surface quickly in the report.
const PROBE_RESOURCE_TYPES = [
  // Hunt for Cookie-Banner — most likely candidates first
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

// Substrings flagged as cookie-banner candidates — surface them in a dedicated
// section of the report so they don't get lost in a multi-thousand-key dump.
const COOKIE_HINTS = ["cookie", "consent", "privacy_banner", "gdpr", "tracking"];

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

interface ProbeReport {
  generatedAt: string;
  shop: string;
  primaryLocale: string;
  enabledLocales: string[];
  apiVersion: string;
  resources: ResourceReport[];
  cookieHints: CookieHintHit[];
  writeTest: WriteTestReport;
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
      const resp = await admin.graphql(PROBE_QUERY, { variables: { first: 50, resourceType } });
      const data = (await resp.json()) as { data?: { translatableResources?: { edges: Array<{ node: { resourceId: string; translatableContent: Array<{ key: string; value: string | null; locale: string; digest: string }> } }> } }; errors?: Array<{ message: string }> };
      if (data.errors?.length) {
        r.status = "error";
        r.errorMessage = data.errors.map((e) => e.message).join(" | ");
      } else {
        for (const edge of data.data?.translatableResources?.edges ?? []) {
          summarize(edge.node, r);
          // Scan for cookie-banner-related keys/values; T&A exposes them under
          // a known rubric but the source resource type is undocumented.
          for (const item of edge.node.translatableContent ?? []) {
            const haystack = `${item.key} ${item.value ?? ""}`.toLowerCase();
            if (COOKIE_HINTS.some((h) => haystack.includes(h))) {
              if (report.cookieHints.length < 50) {
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
