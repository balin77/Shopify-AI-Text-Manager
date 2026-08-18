/**
 * API route: the ENTRIES of one metaobject type.
 *
 * Splat route (`$`) so a type id with special characters survives the URL.
 * The metaobjects page loads its type list eagerly and the entries of the
 * SELECTED type through here, with `page`, `limit` and `search` -- the
 * parameters were always accepted, the page just never sent them, which is how
 * a shop with 60 colours came to show 25 of them under a header saying 60
 * (PLAN_METAOBJECTS_EDITOR B2).
 *
 * Two rules this route carries:
 *
 * - **It gates itself.** `/app/metaobjects` is behind `PlanAccessGate`, but a
 *   loader is directly GET-reachable, so the plan check lives HERE too -- the
 *   same class as the `/api/ai` handlers and the crawl CSV exports.
 * - **It has no `action`.** It used to carry a second implementation of
 *   loadTranslations / translateField / updateContent that no caller in the
 *   repo ever posted to, with its own (echo-less) translation writes. CLAUDE.md
 *   forbids a parallel write path, and a dead one is worse than a live one: it
 *   is exactly where a later change lands by accident. The ONE write path for
 *   this page is `handleUnifiedContentActions`.
 *
 * The translation keys it emits are COMPOUND (`<gid>#<fieldKey>`), matching the
 * field keys `METAOBJECTS_CONFIG.getFieldDefinitions` builds. `MetaobjectTranslation`
 * already carries the field key in its unique key, so this needed no migration.
 */

import { data as json, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { logger } from "~/utils/logger.server";
import { canAccessContentType } from "~/utils/planUtils";
import type { Plan } from "~/config/plans";
import { metaobjectFieldKey } from "~/services/metaobject-fields.shared";
import type { MetaobjectFieldDefinition } from "~/config/create-fields.config";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const typeId = params["*"];

  if (!typeId) {
    return json({ success: false, error: "typeId is required" }, { status: 400 });
  }

  // Parse and validate pagination parameters from URL
  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const limit = Math.min(250, Math.max(1, parseInt(url.searchParams.get("limit") || "25", 10) || 25));
  const search = url.searchParams.get("search") || "";
  /** A specific entry to land on — the page it sits on wins over `page`. */
  const focus = url.searchParams.get("focus") || "";

  try {
    const { db } = await import("../db.server");

    // Route-level plan gate — see the header. A closed gate is a 403, never an
    // empty list: an empty result would read as "this shop has no entries".
    const settings = await db.aISettings.findUnique({
      where: { shop: session.shop },
      select: { subscriptionPlan: true },
    });
    if (!canAccessContentType((settings?.subscriptionPlan || "free") as Plan, "metaobjects")) {
      return json({ success: false, error: "Your plan does not include metaobjects." }, { status: 403 });
    }

    // Load metaobject definition from DB
    const definition = await db.metaobjectDefinition.findUnique({
      where: {
        shop_type: {
          shop: session.shop,
          type: typeId
        }
      }
    });

    if (!definition) {
      return json({ success: false, error: "Metaobject type not found" }, { status: 404 });
    }

    // Fetch metaobjects for this type from DB
    let metaobjects = await db.metaobject.findMany({
      where: {
        shop: session.shop,
        type: typeId
      },
      orderBy: {
        displayName: 'asc'
      }
    });

    // Apply search filter if provided
    if (search) {
      const searchLower = search.toLowerCase();
      metaobjects = metaobjects.filter((m) =>
        m.displayName?.toLowerCase().includes(searchLower) ||
        m.handle?.toLowerCase().includes(searchLower)
      );
    }

    // Calculate pagination. `focus` names an entry the caller wants to SEE (a
    // deep link from the product editor, or the entry that was just created) —
    // so the page containing it wins over the requested page number. An entry
    // that is not in the (possibly searched) list leaves `page` alone rather
    // than snapping to page 1: it was filtered out, not moved.
    const totalCount = metaobjects.length;
    const totalPages = Math.ceil(totalCount / limit);
    const focusIndex = focus ? metaobjects.findIndex((m) => m.id === focus) : -1;
    const effectivePage = focusIndex >= 0 ? Math.floor(focusIndex / limit) + 1 : page;
    const startIndex = (effectivePage - 1) * limit;
    const paginatedMetaobjects = metaobjects.slice(startIndex, startIndex + limit);

    // Load translations for paginated metaobjects from DB
    const metaobjectIds = paginatedMetaobjects.map(m => m.id);
    const translations = await db.metaobjectTranslation.findMany({
      where: {
        shop: session.shop,
        metaobjectId: { in: metaobjectIds }
      }
    });

    // Format metaobjects with DB data
    const formattedMetaobjects = paginatedMetaobjects.map((metaobj) => ({
      id: metaobj.id,
      handle: metaobj.handle,
      displayName: metaobj.displayName,
      type: metaobj.type,
      updatedAt: metaobj.shopifyUpdatedAt.toISOString(),
      fields: metaobj.fields as any,
    }));

    // Thumbnails for `file_reference` values, from the shop's OWN media cache.
    // A GID the cache does not know is simply absent — the field then shows the
    // id with a note instead of a broken image, because "we have no preview"
    // and "the file is gone" are different states and only Shopify can tell
    // them apart.
    const referencedFileIds = [
      ...new Set(
        formattedMetaobjects.flatMap((m) =>
          (Array.isArray(m.fields) ? (m.fields as Array<{ value?: string | null }>) : [])
            .map((f) => f?.value ?? "")
            .filter((v) => v.startsWith("gid://shopify/MediaImage/")),
        ),
      ),
    ];
    const filePreviews: Record<string, string> = {};
    if (referencedFileIds.length > 0) {
      const media = await db.mediaLibraryImage.findMany({
        where: { shop: session.shop, id: { in: referencedFileIds } },
        select: { id: true, url: true },
      });
      for (const row of media) filePreviews[row.id] = row.url;
    }

    // Format translations for UI. Global rows (marketId "") feed the per-item
    // `translations` array; market-specific rows are surfaced as
    // `marketTranslations` so resolve() can layer them over the global value.
    // The key is COMPOUND (`<metaobjectId>#<fieldKey>`) — one entry has many
    // translatable fields, and the metaobject id alone could only ever address
    // one of them. The market lookup is
    //   marketTranslations[marketId][`<metaobjectId>#<fieldKey>`][locale].
    const translationsArray = translations
      .filter(t => (t.marketId ?? "") === "")
      .map(t => ({
        key: metaobjectFieldKey(t.metaobjectId, t.key),
        value: t.value,
        locale: t.locale,
      }));
    const marketTranslations: Record<string, Record<string, Record<string, string>>> = {};
    for (const t of translations) {
      if ((t.marketId ?? "") === "") continue;
      const byKey = (marketTranslations[t.marketId] ??= {});
      const byLocale = (byKey[metaobjectFieldKey(t.metaobjectId, t.key)] ??= {});
      byLocale[t.locale] = t.value;
    }

    logger.debug("[API-METAOBJECTS-LOADER] Metaobjects loaded from DB", {
      context: "Metaobjects",
      typeId,
      totalCount,
      page: effectivePage,
      totalPages,
      itemsShown: paginatedMetaobjects.length,
      translationsCount: translationsArray.length
    });

    // Build response with paginated metaobjects and translations
    const metaobjectData = {
      id: `metaobject_type_${typeId}`,
      type: typeId,
      title: definition.name,
      handle: typeId,
      definitionName: definition.name,
      definitionId: definition.id,
      role: 'METAOBJECT_TYPE',
      metaobjects: formattedMetaobjects,
      // The definition's own field list — the editor builds one control per
      // ENTRY x FIELD from it, and it is also what lets an unsupported field
      // be NAMED with its type instead of silently missing.
      fieldDefinitions: (definition.fieldDefinitions as unknown as MetaobjectFieldDefinition[]) ?? [],
      // §7.2 — Shopify's access regime for this definition. `null` means the
      // row predates the column, and the client reads that as UNKNOWN: it
      // neither locks the editor nor promises that a save will work.
      adminAccess: definition.adminAccess ?? null,
      filePreviews,
      translations: translationsArray, // global rows, compound keys
      marketTranslations, // market rows: [marketId][compoundKey][locale]
      contentCount: totalCount,
      // Pagination metadata
      pagination: {
        page: effectivePage,
        limit,
        totalCount,
        totalPages,
        hasNextPage: effectivePage < totalPages,
        hasPreviousPage: effectivePage > 1,
        search,
      }
    };

    return json({ success: true, metaobject: metaobjectData }, { headers: { "Cache-Control": "no-store" } });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    logger.error("[API-METAOBJECTS] Error loading type", { context: "Metaobjects", typeId, error: msg, stack });
    return json({ success: false, error: "Failed to load metaobject type." }, { status: 500 });
  }
};
