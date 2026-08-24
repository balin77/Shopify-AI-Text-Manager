/**
 * The change event that Shopify does not send.
 *
 * Products and collections have `products/update` / `collections/update`, so an
 * edit made in the Shopify admin, by another app or by an importer reaches the
 * stale-translation reconciliation by itself. Pages, articles, blogs and shop
 * policies have NO webhook at all — MEASURED, not assumed: the content
 * resources are simply absent from `WebhookSubscriptionTopic`, and Shopify's own
 * developer forum carries an open request for them. So for those four types the
 * only moment anything in this app knew a text had moved was a save WE made, or
 * a merchant pressing reload on that one item.
 *
 * That is the gap this closes: one cheap sweep that plays the part of the
 * missing webhook, and then hands each changed resource to exactly the same
 * `reconcileStaleTranslations` a real webhook would have reached. Nothing about
 * the decision — purge, re-translate, decline, the digest gate, the market
 * layer — lives here. This module only answers "which of these resources moved
 * since we last looked".
 *
 * Four things shape it:
 *
 * 1. ONE PAGED QUERY PER TYPE, not one per resource. `translatableResources`
 *    carries `translatableContent { key value digest }` AND a
 *    `translations(locale:)` alias per published locale in the same node — the
 *    shape the menu sweep already uses — so a shop's whole page catalogue costs
 *    a couple of round trips instead of one per page per locale.
 *
 * 2. THE DIGEST BASELINE COMES FROM THE MIRROR, in ONE query per type rather
 *    than one per resource, and a resource with no mirror row at all is skipped
 *    before anything else happens. No previous digest is no evidence — the rule
 *    that makes a first sweep harmless — and it is also what keeps the cost
 *    proportional to what a shop has actually translated.
 *
 * 3. A CAP on how many resources one sweep hands over, PER TYPE rather than as
 *    one shared pool: every handover can start an unattended AI run on the
 *    merchant's own key, and with a single pool a shop whose pages always fill
 *    it would never have its articles, blogs or policies swept at all. What is
 *    left over is the next sweep's work rather than a loss — but only because
 *    the budget is spent on resources the gate really finds stale, which is why
 *    the pre-check below is the FULL gate and not just its digest half.
 *
 * 4. IT NEVER THROWS, and it never reports silence it did not establish. A
 *    failed type, a truncated baseline and a paging ceiling are all named in the
 *    result; a sweep whose every node was unknown to the mirror says so rather
 *    than looking like a shop with nothing to do.
 */

import type { ShopifyApiGateway } from "../shopify-api-gateway.service";
import { logger } from "../../utils/logger.server";
import type { SyncedTranslation, PrimaryContentEntry } from "./stale-translations.shared";

/**
 * The four types with no webhook. Theme content and menus are deliberately
 * absent: their `translatableResources` sweep is a different shape (a theme's
 * keys are spread over many resources and a menu's over its links), and both
 * already have a save-side repair. They are the next candidates, not a
 * forgotten case.
 */
const SCANNED_TYPES = [
  { shopify: "PAGE", mirror: "Page", contentKind: "page" as const },
  { shopify: "ARTICLE", mirror: "Article", contentKind: "blog" as const },
  { shopify: "BLOG", mirror: "Blog", contentKind: "blog" as const },
  { shopify: "SHOP_POLICY", mirror: "ShopPolicy", contentKind: "page" as const },
] as const;

/**
 * Nodes per page, DIVIDED BY THE LOCALE COUNT — the half of the menu sweep's
 * shape that is easy to copy without and impossible to survive without.
 *
 * Each node carries `translatableContent` plus one `translations(locale:)`
 * alias per published locale, so the query's cost scales with the language
 * count. `menu-translations.server.ts` measured this: at a fixed page size a
 * five-language shop blows the 1000-point single-query ceiling and the whole
 * document is refused with `MAX_COST_EXCEEDED` — which arrives as a top-level
 * `errors` entry, i.e. a THROW that takes the entire type with it, every 24
 * hours, on exactly the multilingual shops this feature exists for.
 *
 * The floor keeps a ten-language shop from paging one node at a time.
 */
const SWEEP_MAX_NODES = 100;
const SWEEP_MIN_NODES = 10;

/** Pages per type, so one enormous catalogue cannot hold a tick open. */
const MAX_PAGES_PER_TYPE = 20;

/**
 * Resources ONE sweep may hand to the reconciliation. Each is a potential
 * detached AI run; the remainder is the next sweep's work, not a loss.
 */
export const MAX_DRIFT_HANDOVERS = 25;

/**
 * Rows the baseline query may materialise per type. The one query here with no
 * natural ceiling: a shop with thousands of articles times keys times locales
 * would otherwise pull the lot into a Map for a sweep that hands over at most
 * MAX_DRIFT_HANDOVERS resources. Truncation is SAFE in the only direction that
 * matters — a resource whose baseline was cut looks like "no evidence" and is
 * skipped — and it is reported rather than silent.
 */
const MAX_BASELINE_ROWS = 50_000;

export interface DriftScanResult {
  /** Resources the gate found stale — including any past the cap. */
  changed: number;
  /** Of those, how many were handed to the reconciliation. */
  handed: number;
  /** Types whose query failed — reported, never counted as "nothing changed". */
  failedTypes: string[];
  /** Types whose baseline was truncated or whose paging hit its ceiling, so
   *  "nothing else changed" is NOT what this sweep established for them. */
  truncatedTypes: string[];
}

interface ScanNode {
  resourceId: string;
  translatableContent: Array<{ key: string; value: string | null; digest: string | null }> | null;
  [alias: string]: unknown;
}

/**
 * Sweep one shop's webhook-less types and reconcile what moved.
 *
 * `foreignLocales` are the shop's published non-primary locales — the sweep
 * asks Shopify for each one's translations inline, so an empty list means there
 * is nothing that could be stale and the whole sweep is skipped.
 */
export async function scanTranslationDrift(params: {
  gateway: ShopifyApiGateway;
  shop: string;
  foreignLocales: readonly string[];
  /** Test seam — the reconciliation is otherwise resolved at call time. */
  reconcile?: typeof import("./stale-translation-sync.server").reconcileStaleTranslations;
  /**
   * The MARKET layer is deliberately not read here. `collectTranslations`
   * reports global rows only, so a locale that holds an override and no global
   * translation is absent from the market purge's scope downstream — the
   * webhook path covers it (its sync fetches every layer), this entrance does
   * not. Reading market layers would mean knowing the shop's markets and
   * carrying an alias per (locale, market) into an already cost-bound query.
   */
}): Promise<DriftScanResult> {
  const { gateway, shop, foreignLocales } = params;
  const result: DriftScanResult = { changed: 0, handed: 0, failedTypes: [], truncatedTypes: [] };
  if (foreignLocales.length === 0) return result;

  const { db } = await import("../../db.server");
  const sync = await import("./stale-translation-sync.server");
  const reconcile = params.reconcile ?? sync.reconcileStaleTranslations;
  const { digestBaselineKey } = await import("./stale-translations.shared");

  // A budget PER TYPE, not one shared pool walked in a fixed order: with one
  // pool a shop whose pages always fill it means its articles, blogs and
  // policies are never swept at all, on any night.
  const perType = Math.max(1, Math.ceil(MAX_DRIFT_HANDOVERS / SCANNED_TYPES.length));
  /** Types this sweep really asked Shopify about — see the log at the end. */
  const queriedTypes: string[] = [];

  for (const type of SCANNED_TYPES) {

    // The mirror's whole baseline for this type, in ONE query. Keyed by
    // resource, then by `digestBaselineKey(locale, key)` — the exact shape
    // `reconcileStaleTranslations` expects, so nothing is re-derived per node.
    let baseline: Map<string, Record<string, string | null>>;
    try {
      const rows = await db.contentTranslation.findMany({
        where: { shop, resourceType: type.mirror, marketId: "" },
        select: { resourceId: true, key: true, locale: true, digest: true },
        take: MAX_BASELINE_ROWS,
      });
      if (rows.length === MAX_BASELINE_ROWS) result.truncatedTypes.push(type.shopify);
      baseline = new Map();
      for (const row of rows) {
        const entry = baseline.get(row.resourceId) ?? {};
        entry[digestBaselineKey(row.locale, row.key)] = row.digest;
        baseline.set(row.resourceId, entry);
      }
    } catch (error: unknown) {
      result.failedTypes.push(type.shopify);
      logger.warn("[DriftScan] Could not read the digest baseline", {
        context: "DriftScan",
        shop,
        type: type.shopify,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    // A shop that never translated this type has nothing that could be stale,
    // and the sweep must not pay a Shopify round trip to find that out.
    if (baseline.size === 0) continue;

    try {
      queriedTypes.push(type.shopify);
      await scanType(type, baseline);
    } catch (error: unknown) {
      result.failedTypes.push(type.shopify);
      logger.warn("[DriftScan] Sweep failed for a type — its resources stay unchecked", {
        context: "DriftScan",
        shop,
        type: type.shopify,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Logged whenever a type was actually QUERIED, not only when something was
  // found. A sweep that found nothing used to log nothing at all, so "ran and
  // found nothing" was indistinguishable from "never ran" — and that is the
  // first question anyone asks of an unattended feature.
  if (queriedTypes.length > 0 || result.failedTypes.length > 0) {
    logger.info("[DriftScan] Swept the webhook-less types", {
      context: "DriftScan",
      shop,
      queriedTypes,
      changed: result.changed,
      handed: result.handed,
      failedTypes: result.failedTypes,
      truncatedTypes: result.truncatedTypes,
    });
  } else {
    // Nothing was queried at all: this shop has translated none of the four
    // types, so there is no baseline against which anything could be stale.
    logger.info("[DriftScan] Nothing to sweep — no mirrored translations", {
      context: "DriftScan",
      shop,
      locales: foreignLocales.length,
    });
  }
  return result;

  async function scanType(
    type: (typeof SCANNED_TYPES)[number],
    baseline: Map<string, Record<string, string | null>>,
  ): Promise<void> {
    let cursor: string | null = null;
    let handedHere = 0;
    /** A node Shopify returned whose id the baseline does not know — see the
     *  mismatch warning below. */
    let unmatched = 0;
    let seen = 0;
    for (let page = 0; page < MAX_PAGES_PER_TYPE; page++) {
      if (handedHere >= perType) return;

      const { nodes, next } = await fetchPage(type.shopify, cursor);
      for (const node of nodes) {
        if (handedHere >= perType) return;
        seen++;
        const previousDigests = baseline.get(node.resourceId);
        if (!previousDigests) unmatched++;
        // No mirror row ⇒ no baseline ⇒ no evidence that anything moved. This
        // is the rule that makes a first sweep harmless, and it is also why the
        // sweep is cheap: most resources never get past this line.
        if (!previousDigests) continue;

        const primaryContent: Record<string, PrimaryContentEntry> = {};
        for (const entry of node.translatableContent ?? []) {
          primaryContent[entry.key] = { value: entry.value ?? "", digest: entry.digest };
        }
        // Nothing readable came back for this resource. An empty
        // `translatableContent` is indistinguishable from "every field was
        // cleared" (CLAUDE.md), so it is skipped rather than acted on.
        if (Object.keys(primaryContent).length === 0) continue;

        const translations = collectTranslations(node);
        if (translations.length === 0) continue;

        // Cheap pre-check, so the shop is not charged a reconciliation call for
        // a resource whose digests all still match. The reconciliation runs the
        // real gate itself — this only avoids calling it for the common case.
        // Deliberately the SAME comparison the real gate makes
        // (`findStaleTranslations`): a key whose entry is ABSENT has no current
        // digest, `null` differs from the stored one, and that is what makes
        // the "the merchant cleared this field" rule reachable at all. An
        // earlier cut required a current digest and thereby made half the
        // gate's evidence invisible through this entrance — a body emptied in
        // the Shopify admin, the orphan-translation case the reconciliation was
        // originally built for.
        // The FULL gate, not just the digest half. `findStaleTranslations`
        // needs a second signal — Shopify's own `outdated`, or a primary value
        // that is gone — and this sweep has both in hand. Checking only the
        // digest handed over resources the gate then refused: a page
        // re-translated in the Shopify admin (digest moved, `outdated: false`)
        // is never repaired, so nothing advances its baseline, so it is handed
        // over again on every sweep forever, burning a budget slot each time
        // and eventually starving everything behind it.
        //
        // `reconcileStaleTranslations` remains the authority and runs the real
        // gate again; this only decides what is worth asking it about.
        const stale = translations.some((row) => {
          const previous = previousDigests[digestBaselineKey(row.locale, row.key)];
          if (!previous) return false;
          const entry = primaryContent[row.key];
          if ((entry?.digest ?? null) === previous) return false;
          return row.outdated === true || !(entry?.value ?? "").trim();
        });
        if (!stale) continue;

        result.changed++;
        result.handed++;
        handedHere++;
        await reconcile({
          client: gateway,
          shop,
          resourceId: node.resourceId,
          resourceType: type.mirror,
          contentKind: type.contentKind,
          // Without this every sweep-started run shows a raw GID in the Tasks
          // tab; the title is right there in the node we already fetched.
          ...(primaryContent.title?.value ? { resourceTitle: primaryContent.title.value } : {}),
          translations,
          primaryContent,
          previousDigests,
          // The FILL: the sweep already knows the shop's published foreign
          // locales — it queries a `translations(locale:)` alias per locale —
          // so a key it proved moved is translated into all of them, not only
          // into the ones that happened to hold a translation before.
          foreignLocales,
        });
      }
      if (!next) {
        warnOnTotalMismatch();
        return;
      }
      cursor = next;
      if (page === MAX_PAGES_PER_TYPE - 1) result.truncatedTypes.push(type.shopify);
    }
    warnOnTotalMismatch();

    /**
     * Every node Shopify returned was unknown to the baseline, while the
     * baseline is not empty. The likely cause is that the two sides spell the
     * same resource's GID differently — pages have historically been
     * `gid://shopify/OnlineStorePage/...` as well as `gid://shopify/Page/...`.
     * Nothing here can repair that, but a permanent silent no-op is the one
     * outcome a sweep must never have, so it says so with one id from each side.
     */
    function warnOnTotalMismatch(): void {
      if (seen === 0 || unmatched < seen || baseline.size === 0) return;
      logger.warn("[DriftScan] No swept resource matched the mirror — check the id spelling", {
        context: "DriftScan",
        shop,
        type: type.shopify,
        seen,
        mirrorRows: baseline.size,
        mirrorExample: [...baseline.keys()][0],
      });
    }
  }

  /** Every published locale's translations of one node, as the reconciliation
   *  reads them. Global layer only — the market overrides are removed by the
   *  purge that follows, and are never a reason to start one. */
  function collectTranslations(node: ScanNode): SyncedTranslation[] {
    const out: SyncedTranslation[] = [];
    foreignLocales.forEach((locale, index) => {
      const rows = node[`l${index}`] as
        | Array<{ key: string; value: string | null; outdated?: boolean }>
        | null
        | undefined;
      for (const row of rows ?? []) {
        // Shopify answers with a row per translatable KEY and `value: null`
        // where that locale has nothing — every sweep in this repo filters on
        // it, or an untranslated locale reads as translated.
        if (row.value === null || row.value === undefined) continue;
        out.push({
          key: row.key,
          value: row.value,
          locale,
          marketId: "",
          ...(row.outdated === undefined ? {} : { outdated: row.outdated }),
        });
      }
    });
    return out;
  }

  async function fetchPage(
    resourceType: string,
    after: string | null,
  ): Promise<{ nodes: ScanNode[]; next: string | null }> {
    // One alias per locale, exactly like the menu sweep: the alternative is a
    // query per locale per page, which multiplies the only expensive part of
    // this module by the number of languages the shop publishes.
    const variableDefs = foreignLocales.map((_, i) => `$loc${i}: String!`).join(", ");
    const localeSelections = foreignLocales
      .map((_, i) => `l${i}: translations(locale: $loc${i}) { key value outdated }`)
      .join("\n            ");
    const pageSize = Math.min(
      SWEEP_MAX_NODES,
      Math.max(SWEEP_MIN_NODES, Math.floor(SWEEP_MAX_NODES / Math.max(1, foreignLocales.length))),
    );
    const variables: Record<string, unknown> = { first: pageSize, after };
    foreignLocales.forEach((locale, i) => {
      variables[`loc${i}`] = locale;
    });

    const response = await gateway.graphql(
      `#graphql
        query translationDriftSweep($first: Int!, $after: String${variableDefs ? `, ${variableDefs}` : ""}) {
          translatableResources(first: $first, after: $after, resourceType: ${resourceType}) {
            edges {
              node {
                resourceId
                translatableContent { key value digest }
                ${localeSelections}
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }`,
      { variables },
    );
    const payload = (await response.json()) as {
      data?: {
        translatableResources?: {
          edges?: Array<{ node: ScanNode }> | null;
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
        } | null;
      };
      errors?: Array<{ message?: string }>;
    };
    if (payload.errors?.length) throw new Error(payload.errors[0]?.message || "GraphQL error");
    const connection = payload.data?.translatableResources;
    return {
      nodes: (connection?.edges ?? []).map((edge) => edge.node),
      next: connection?.pageInfo?.hasNextPage ? (connection.pageInfo.endCursor ?? null) : null,
    };
  }
}
