/**
 * Write endpoint for the internal-linking suggestions (Pro+).
 *
 * WHY a resource route instead of the page route's own action: the suggestions
 * page fires these calls with raw `fetch` so several rows can run at once (a
 * useFetcher has one slot and would cancel its own in-flight request). With
 * `v3_singleFetch` enabled, a raw POST to a PAGE route is a document request —
 * the response is the route's HTML, so the JSON body would be unreadable. A
 * resource route (no default export) returns exactly what the action returns,
 * for every kind of request.
 *
 * Actions (all POST, `actionType` field):
 *   previewAccept  compute the insertion, write nothing, return before/after
 *   accept         apply ONE suggestion: insertion + save + mark accepted
 *   reject         permanent dismissal (feeds the next run's do-not-repeat list)
 *   restore        move a rejected suggestion back to the open list
 *   acceptAll      apply the whole listed set, capped per request
 *   rejectAll      dismiss the whole listed set in one statement
 *
 * Applying goes through `handleUnifiedContentActions` — the same entry point
 * the editor routes use. This route does NOT write content itself (CLAUDE.md
 * architecture invariant: one write path), it only calls that handler in-process
 * instead of over HTTP.
 *
 * `carryTranslations` (the page's toggle, on by default) changes what an accept
 * does to the source item's FOREIGN content. Off, an accept is a plain primary
 * save: the handler purges the translations of the field it changed, which for
 * a link insertion throws away translations the merchant wrote for text that
 * did not actually change. On, `changedFields` is omitted so nothing is purged,
 * and the same link is written into each existing translation with the
 * localized URL — see internal-links-translate.server.ts.
 */

import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getFormString } from "../utils/form-data.utils";
import { meetsPlan } from "../utils/planUtils";
import type { Plan } from "../config/plans";
import { getCachedShopLocales } from "../utils/shop-locales-cache.server";
import {
  insertLinkIntoHtml,
  targetUrlPath,
  groupSuggestionsBySource,
} from "../services/seo/internal-links.service";
import { RESOURCE_ROUTE, BULK_ACCEPT_LIMIT } from "../services/seo/internal-links-routes";
import { suggestionWhere, parseView, parseTypeFilter } from "../services/seo/internal-links-query";
import { carryLinkIntoTranslations, type CarryOutcome } from "../services/seo/internal-links-translate.server";
import { ShopifyApiGateway } from "../services/shopify-api-gateway.service";
import { fieldTranslationKeyMap } from "../../src/services/shopify-content.service";
import { createAIService, getMissingPreferredKey } from "./api-ai-handlers/shared";

/**
 * How many source items "Alle annehmen" applies at the same time. Suggestions
 * that share a source item are NEVER parallel (see groupSuggestionsBySource) —
 * each insertion is computed from the content the previous one wrote, so racing
 * them would silently drop a link.
 */
const BULK_ACCEPT_CONCURRENCY = 3;

/** A suggestion row as this endpoint handles it (Prisma model, kept loose). */
type SuggestionRecord = {
  id: string;
  fromResourceType: string;
  fromResourceId: string;
  toResourceType: string;
  toResourceId: string;
  anchorText: string;
};

type Insertion =
  | {
      ok: true;
      before: string;
      after: string;
      savePath: string;
      fieldKey: "description" | "body";
      itemId: string;
      /** Resolved link target — the carry step needs its handle and title to
       *  build the localized href and the localized anchor wording. */
      target: { resourceId: string; resourceType: "Product" | "Collection"; handle: string; title: string };
    }
  | { ok: false; code: "UNSUPPORTED" | "STALE" | "SOURCE_MISSING" | "TARGET_MISSING"; error: string };

/**
 * Where the accepted link would go: the source's CURRENT content with the
 * anchor linked. Always read fresh from the DB (not the content captured at
 * suggestion time), so an edit made since the scan is detected as STALE instead
 * of being silently overwritten. Shared by the preview and by the apply paths,
 * so what the merchant sees and what gets written cannot diverge.
 */
async function computeInsertion(db: any, shop: string, suggestion: SuggestionRecord): Promise<Insertion> {
  const fromRoute = RESOURCE_ROUTE[suggestion.fromResourceType];
  if (!fromRoute) {
    return { ok: false, code: "UNSUPPORTED", error: "Unsupported source resource type" };
  }

  let currentHtml: string | null = null;
  if (suggestion.fromResourceType === "Product") {
    const row = await db.product.findFirst({ where: { id: suggestion.fromResourceId, shop }, select: { descriptionHtml: true } });
    currentHtml = row?.descriptionHtml ?? null;
  } else if (suggestion.fromResourceType === "Collection") {
    const row = await db.collection.findFirst({ where: { id: suggestion.fromResourceId, shop }, select: { descriptionHtml: true } });
    currentHtml = row?.descriptionHtml ?? null;
  } else if (suggestion.fromResourceType === "Article") {
    const row = await db.article.findFirst({ where: { id: suggestion.fromResourceId, shop }, select: { body: true } });
    currentHtml = row?.body ?? null;
  } else if (suggestion.fromResourceType === "Page") {
    const row = await db.page.findFirst({ where: { id: suggestion.fromResourceId, shop }, select: { body: true } });
    currentHtml = row?.body ?? null;
  }

  if (currentHtml === null) {
    return { ok: false, code: "SOURCE_MISSING", error: "Source content not found" };
  }

  let targetRow: { handle: string | null; title: string | null } | null = null;
  if (suggestion.toResourceType === "Product") {
    targetRow = await db.product.findFirst({ where: { id: suggestion.toResourceId, shop }, select: { handle: true, title: true } });
  } else if (suggestion.toResourceType === "Collection") {
    targetRow = await db.collection.findFirst({ where: { id: suggestion.toResourceId, shop }, select: { handle: true, title: true } });
  }
  const targetHandle = targetRow?.handle ?? null;
  if (!targetHandle) {
    return { ok: false, code: "TARGET_MISSING", error: "Target content not found" };
  }

  const targetType = suggestion.toResourceType as "Product" | "Collection";
  const href = targetUrlPath({ resourceType: targetType, handle: targetHandle });
  const result = insertLinkIntoHtml(currentHtml, suggestion.anchorText, href);
  if (!result.inserted) {
    return { ok: false, code: "STALE", error: "Anchor text not found in current content" };
  }

  return {
    ok: true,
    before: currentHtml,
    after: result.html,
    savePath: fromRoute.path,
    fieldKey: fromRoute.fieldKey,
    itemId: suggestion.fromResourceId,
    target: {
      resourceId: suggestion.toResourceId,
      resourceType: targetType,
      handle: targetHandle,
      title: targetRow?.title ?? "",
    },
  };
}

/**
 * Everything a save needs, loaded once per request: the unified handler, the
 * per-resource-type editor config it expects, the shop's primary locale (an
 * accepted link is always primary-locale content) and — for the carry step —
 * the published foreign locales plus an AI hook for the anchor wording.
 */
async function loadApplyContext(db: any, shop: string, admin: any, carryTranslations: boolean) {
  const [{ handleUnifiedContentActions }, configs, aiSettings, aiInstructions, shopLocales] = await Promise.all([
    import("../actions/unified-content.actions"),
    import("../config/content-fields.config"),
    db.aISettings.findUnique({ where: { shop } }),
    db.aIInstructions.findUnique({ where: { shop } }),
    getCachedShopLocales(admin, shop).catch(() => []),
  ]);

  const primaryLocale = shopLocales.find((l) => l.primary)?.locale ?? "";
  const foreignLocales = carryTranslations
    ? shopLocales.filter((l) => l.published && !l.primary).map((l) => l.locale)
    : [];

  return {
    handleUnifiedContentActions,
    configByType: {
      Product: configs.PRODUCTS_CONFIG,
      Collection: configs.COLLECTIONS_CONFIG,
      Article: configs.BLOGS_CONFIG,
      Page: configs.PAGES_CONFIG,
    } as Record<string, any>,
    aiSettings,
    aiInstructions,
    primaryLocale,
    foreignLocales,
    gateway: new ShopifyApiGateway(admin, shop),
    translateAnchor: buildAnchorTranslator(aiSettings, shop, primaryLocale),
  };
}

/**
 * Reads the anchor's wording out of each translation in ONE request, or
 * undefined when the shop has no usable AI key (the carry step then relies on
 * the target's translated title and on the anchor being spelled the same way,
 * which covers brand and product names).
 *
 * No Task row and no queue: this runs inside the merchant's accept request, so
 * it must answer within it — `createAIService` with an empty taskId is the
 * documented direct-execution path (ai.service.ts askAI).
 */
function buildAnchorTranslator(
  aiSettings: any,
  shop: string,
  primaryLocale: string,
):
  | ((anchor: string, fromLocale: string, samples: { locale: string; text: string }[]) => Promise<Record<string, string>>)
  | undefined {
  if (!primaryLocale) return undefined;
  if (getMissingPreferredKey(aiSettings)) return undefined;

  return (anchor, fromLocale, samples) =>
    createAIService(aiSettings, shop, "").findLocalizedAnchors(anchor, fromLocale, samples);
}

/**
 * Apply one suggestion: insert the link into the current content and save it
 * through the editor's own handler. Returns the insertion failure code when
 * there is nothing to save, so a single accept can tell the merchant WHY.
 *
 * With `carryTranslations` on, `changedFields` is deliberately NOT sent: it is
 * the only thing that triggers the handler's stale-translation purge, and a
 * link insertion leaves the wording untouched, so the translations are still
 * correct. The link is then written into them separately (carry step below).
 * Everything about that step is best-effort — the translations survive whether
 * or not it succeeds, so its failures never fail the accept.
 */
async function applySuggestion(
  db: any,
  shop: string,
  admin: any,
  session: any,
  ctx: Awaited<ReturnType<typeof loadApplyContext>>,
  suggestion: SuggestionRecord,
): Promise<{ ok: true; carried?: CarryOutcome } | { ok: false; code?: string; error: string }> {
  const insertion = await computeInsertion(db, shop, suggestion);
  if (!insertion.ok) return { ok: false, code: insertion.code, error: insertion.error };

  const contentConfig = ctx.configByType[suggestion.fromResourceType];
  if (!contentConfig) return { ok: false, code: "UNSUPPORTED", error: "Unsupported source resource type" };

  const carry = ctx.foreignLocales.length > 0;

  const saveForm = new FormData();
  saveForm.set("action", "updateContent");
  saveForm.set("itemId", insertion.itemId);
  saveForm.set("locale", ctx.primaryLocale);
  saveForm.set("primaryLocale", ctx.primaryLocale);
  saveForm.set(insertion.fieldKey, insertion.after);
  if (!carry) saveForm.set("changedFields", JSON.stringify([insertion.fieldKey]));

  const response = await ctx.handleUnifiedContentActions({
    admin,
    session,
    formData: saveForm,
    contentConfig,
    db,
    aiSettings: ctx.aiSettings,
    aiInstructions: ctx.aiInstructions,
  });
  const body = (await response.json().catch(() => null)) as { success?: boolean; error?: string } | null;
  if (!body?.success) return { ok: false, error: body?.error || "Save failed" };

  if (!carry) return { ok: true };

  const carried = await carryLinkIntoTranslations({
    gateway: ctx.gateway,
    db,
    shop,
    source: { resourceId: insertion.itemId, resourceType: suggestion.fromResourceType },
    target: insertion.target,
    // The ONE field→key map (CLAUDE.md); "description"/"body" both land on
    // "body_html" for all four source types.
    translationKey: fieldTranslationKeyMap(suggestion.fromResourceType)[insertion.fieldKey],
    anchorText: suggestion.anchorText,
    primaryLocale: ctx.primaryLocale,
    foreignLocales: ctx.foreignLocales,
    translateAnchor: ctx.translateAnchor,
  });

  return { ok: true, carried };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");
  const shop = session.shop;
  const formData = await request.formData();
  const actionType = getFormString(formData, "actionType");
  const suggestionId = getFormString(formData, "suggestionId");
  // The page's toggle. Absent = off, so a caller that predates it keeps the old
  // purging behaviour; the page itself sends "1" unless the merchant turns it off.
  const carryTranslations = getFormString(formData, "carryTranslations") === "1";

  // Directly POST-reachable, so the plan is checked here and not only in the
  // page's loader — every path below writes to the merchant's shop.
  const settings = await db.aISettings.findUnique({ where: { shop }, select: { subscriptionPlan: true } });
  if (!meetsPlan((settings?.subscriptionPlan || "free") as Plan, "pro")) {
    return json({ success: false, error: "This feature requires the Pro plan" }, { status: 403 });
  }

  // ── Bulk actions (no suggestionId — they act on the listed set) ────────────
  if (actionType === "rejectAll" || actionType === "acceptAll") {
    const where = suggestionWhere(
      shop,
      parseView(getFormString(formData, "view")),
      parseTypeFilter(getFormString(formData, "from")),
      parseTypeFilter(getFormString(formData, "to")),
    );

    if (actionType === "rejectAll") {
      // One statement for the whole filtered view — same semantics as rejecting
      // each row by hand (permanent, feeds the next run's do-not-repeat list).
      const { count } = await db.seoInternalLinkSuggestion.updateMany({
        where,
        data: { status: "dismissed", dismissedUntil: null },
      });
      return json({ success: true, rejected: count });
    }

    const batch = await db.seoInternalLinkSuggestion.findMany({
      where,
      orderBy: [{ confidence: "desc" }, { id: "asc" }],
      take: BULK_ACCEPT_LIMIT,
    });
    if (batch.length === 0) {
      return json({ success: true, accepted: 0, failed: 0, remaining: 0 });
    }

    const ctx = await loadApplyContext(db, shop, admin, carryTranslations);

    // Suggestions that share a source item run in order (each insertion builds
    // on the content the previous save wrote); different source items run
    // concurrently, bounded so a batch doesn't hammer Shopify's rate limit.
    const queue = groupSuggestionsBySource(batch as SuggestionRecord[]);
    const acceptedIds: string[] = [];
    let failed = 0;
    let translationsLinked = 0;
    let translationsUnlinked = 0;

    const worker = async () => {
      for (;;) {
        const group = queue.shift();
        if (!group) return;
        for (const suggestion of group) {
          const result = await applySuggestion(db, shop, admin, session, ctx, suggestion).catch(() => ({
            ok: false as const,
            error: "Save failed",
          }));
          if (result.ok) {
            acceptedIds.push(suggestion.id);
            translationsLinked += result.carried?.linked.length ?? 0;
            translationsUnlinked += result.carried?.unlinked.length ?? 0;
          } else failed++;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(BULK_ACCEPT_CONCURRENCY, queue.length) }, () => worker()));

    if (acceptedIds.length > 0) {
      await db.seoInternalLinkSuggestion.updateMany({
        where: { shop, id: { in: acceptedIds } },
        data: { status: "accepted", dismissedUntil: null },
      });
    }

    // Failures stay in the list, so `remaining` includes them — the client only
    // suggests another round when there is more left than just this run's
    // failures (a suggestion whose anchor text is gone never succeeds).
    const remaining = await db.seoInternalLinkSuggestion.count({ where });
    return json({
      success: true,
      accepted: acceptedIds.length,
      failed,
      remaining,
      translationsLinked,
      translationsUnlinked,
    });
  }

  // ── Single-suggestion actions ──────────────────────────────────────────────
  const suggestion = suggestionId
    ? await db.seoInternalLinkSuggestion.findFirst({ where: { id: suggestionId, shop } })
    : null;
  if (!suggestion) {
    return json({ success: false, error: "Suggestion not found" }, { status: 404 });
  }

  if (actionType === "reject") {
    // Permanent: `dismissedUntil: null` is never revived by a later run, and
    // the anchor is passed into the next run's synonym prompt as a
    // do-not-repeat (internal-links.service.ts, rejectedAnchorsByTarget).
    await db.seoInternalLinkSuggestion.update({
      where: { id: suggestion.id },
      data: { status: "dismissed", dismissedUntil: null },
    });
    return json({ success: true });
  }

  if (actionType === "restore") {
    // Back to the open list. Clearing `dismissedUntil` keeps the row a normal
    // pending suggestion (and drops it out of the rejection feedback).
    await db.seoInternalLinkSuggestion.update({
      where: { id: suggestion.id },
      data: { status: "pending", dismissedUntil: null },
    });
    return json({ success: true });
  }

  if (actionType === "previewAccept") {
    const insertion = await computeInsertion(db, shop, suggestion);
    if (!insertion.ok) {
      const status = insertion.code === "STALE" ? 409 : insertion.code === "UNSUPPORTED" ? 400 : 404;
      return json({ success: false, code: insertion.code, error: insertion.error }, { status });
    }
    return json({
      success: true,
      before: insertion.before,
      after: insertion.after,
      savePath: insertion.savePath,
      fieldKey: insertion.fieldKey,
      itemId: insertion.itemId,
    });
  }

  if (actionType === "accept") {
    const ctx = await loadApplyContext(db, shop, admin, carryTranslations);
    const result = await applySuggestion(db, shop, admin, session, ctx, suggestion);
    if (!result.ok) {
      const status = result.code === "STALE" ? 409 : result.code ? 400 : 500;
      return json({ success: false, code: result.code, error: result.error }, { status });
    }

    // Only now — a suggestion counts as accepted once its link is really saved.
    await db.seoInternalLinkSuggestion.update({
      where: { id: suggestion.id },
      data: { status: "accepted", dismissedUntil: null },
    });
    return json({
      success: true,
      translationsLinked: result.carried?.linked.length ?? 0,
      translationsUnlinked: result.carried?.unlinked.length ?? 0,
    });
  }

  return json({ success: false, error: `Unknown actionType: ${actionType}` }, { status: 400 });
};
