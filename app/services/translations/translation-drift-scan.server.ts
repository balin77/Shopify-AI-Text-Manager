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
 * 3. A CAP on how many resources one sweep hands over. Every handover can start
 *    an unattended AI run on the merchant's own key; a shop that bulk-imported
 *    500 pages overnight must not turn that into 500 runs at 3am. What is left
 *    over is not lost — it is simply the next sweep's work, because the digests
 *    it would have compared are still unchanged.
 *
 * 4. IT NEVER THROWS. A sweep runs unattended; a failure logs and the shop is
 *    tried again on its next tick.
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

/** Resources per page of the sweep. Shopify's own maximum for this connection. */
const PAGE_SIZE = 100;

/** Pages per type, so one enormous catalogue cannot hold a tick open. */
const MAX_PAGES_PER_TYPE = 20;

/**
 * Resources ONE sweep may hand to the reconciliation. Each is a potential
 * detached AI run; the remainder is the next sweep's work, not a loss.
 */
export const MAX_DRIFT_HANDOVERS = 25;

export interface DriftScanResult {
  /** Resources whose primary text moved since the mirror's baseline. */
  changed: number;
  /** Of those, how many were handed to the reconciliation (the cap). */
  handed: number;
  /** Types whose query failed — reported, never counted as "nothing changed". */
  failedTypes: string[];
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
}): Promise<DriftScanResult> {
  const { gateway, shop, foreignLocales } = params;
  const result: DriftScanResult = { changed: 0, handed: 0, failedTypes: [] };
  if (foreignLocales.length === 0) return result;

  const { db } = await import("../../db.server");
  const sync = await import("./stale-translation-sync.server");
  const reconcile = params.reconcile ?? sync.reconcileStaleTranslations;
  const { digestBaselineKey } = await import("./stale-translations.shared");

  for (const type of SCANNED_TYPES) {
    if (result.handed >= MAX_DRIFT_HANDOVERS) break;

    // The mirror's whole baseline for this type, in ONE query. Keyed by
    // resource, then by `digestBaselineKey(locale, key)` — the exact shape
    // `reconcileStaleTranslations` expects, so nothing is re-derived per node.
    let baseline: Map<string, Record<string, string | null>>;
    try {
      const rows = await db.contentTranslation.findMany({
        where: { shop, resourceType: type.mirror, marketId: "" },
        select: { resourceId: true, key: true, locale: true, digest: true },
      });
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

  if (result.changed > 0 || result.failedTypes.length > 0) {
    logger.info("[DriftScan] Swept the webhook-less types", {
      context: "DriftScan",
      shop,
      changed: result.changed,
      handed: result.handed,
      failedTypes: result.failedTypes,
    });
  }
  return result;

  async function scanType(
    type: (typeof SCANNED_TYPES)[number],
    baseline: Map<string, Record<string, string | null>>,
  ): Promise<void> {
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES_PER_TYPE; page++) {
      if (result.handed >= MAX_DRIFT_HANDOVERS) return;

      const { nodes, next } = await fetchPage(type.shopify, cursor);
      for (const node of nodes) {
        if (result.handed >= MAX_DRIFT_HANDOVERS) return;
        const previousDigests = baseline.get(node.resourceId);
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
        const moved = translations.some((row) => {
          const previous = previousDigests[digestBaselineKey(row.locale, row.key)];
          const current = primaryContent[row.key]?.digest;
          return !!previous && !!current && previous !== current;
        });
        if (!moved) continue;

        result.changed++;
        result.handed++;
        await reconcile({
          client: gateway,
          shop,
          resourceId: node.resourceId,
          resourceType: type.mirror,
          contentKind: type.contentKind,
          translations,
          primaryContent,
          previousDigests,
        });
      }
      if (!next) return;
      cursor = next;
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
    const variables: Record<string, unknown> = { first: PAGE_SIZE, after };
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
