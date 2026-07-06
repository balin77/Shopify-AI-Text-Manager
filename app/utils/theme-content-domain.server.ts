/**
 * Shared loader + route-action factories for the ThemeContent-backed rubrics.
 *
 * The Templates (theme), System, Online-Store-Extras and Selling-Plans routes
 * are identical except for their `domain`. These factories build the per-route
 * loader (lazy nav metadata) and action (translate / save dispatch) so each
 * route is a thin, declarative wrapper instead of a 1000-line copy.
 */

import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { createContentLoader } from "./loader-factory.server";
import { getFormString } from "./form-data.utils";
import { handleLoadTranslations } from "~/actions/templates/templates-load.action";
import { handleGenerateAIText } from "~/actions/templates/templates-generate.action";
import { handleTranslateField, handleTranslateFieldToAllLocales } from "~/actions/templates/templates-translate-field.action";
import { handleTranslateAll } from "~/actions/templates/templates-translate-all.action";
import { handleUpdateContent } from "~/actions/templates/templates-update.action";
import type { TranslatableField, ThemeContentRow, TemplatesActionContext } from "~/actions/templates/shared";
import type { ThemeNavItem } from "~/types/theme-content-domain";

/**
 * Build a content loader scoped to one ThemeContent domain. Returns lightweight
 * nav metadata (group list + unique-key counts); the per-group field content is
 * loaded lazily by the api.theme-content route.
 *
 * `resourceTypeFilter` optionally restricts the loaded groups to specific
 * Shopify resource types. The online_store_extras domain holds both FILTER and
 * SHOP rows; the Filter and Shop-Metadaten tabs each pass their own filter so a
 * single domain backs two separate tabs.
 */
export function makeThemeDomainLoader(domain: string, logPrefix: string, resourceTypeFilter?: string[]) {
  return createContentLoader({
    logPrefix,
    resourceType: null, // uses the ThemeTranslation table, not ContentTranslation
    itemsKey: "themes" as const,

    async loadData(ctx) {
      const allGroupRows = await ctx.db.themeContent.findMany({
        where: {
          shop: ctx.session.shop,
          domain,
          ...(resourceTypeFilter ? { resourceType: { in: resourceTypeFilter } } : {}),
        },
        select: {
          groupId: true,
          groupName: true,
          groupIcon: true,
          resourceType: true,
          resourceTypeLabel: true,
          translatableContent: true,
          appEmbedOwned: true,
          aiShortTitle: true,
        },
        // Deterministic scan order so first-row-derived fields (groupName/icon)
        // don't flip between reloads.
        orderBy: { groupId: "asc" },
      });

      // Aggregate by groupId, counting unique translatable field keys. A group
      // is flagged technical when any of its rows is an App-Embed resource.
      //
      // type/typeLabel drive the item-list type filter. They are only meaningful
      // when a group maps to a SINGLE resource type: for flat domains (selling
      // plans, system, …) each group is exactly one resource, so it is set. For
      // the theme domain a group can consolidate rows of DIFFERENT resource
      // types (e.g. theme-standard mixes ONLINE_STORE_THEME_LOCALE_CONTENT and
      // ONLINE_STORE_THEME under one pattern-derived groupId) — mixed groups are
      // marked resourceType=null so they never contribute a (misleading,
      // order-dependent) type to the filter. The emoji icon still shows.
      const APP_EMBED = "ONLINE_STORE_THEME_APP_EMBED";
      const groupMap = new Map<
        string,
        { groupName: string; aiShortTitle: string | null; groupIcon: string; uniqueKeys: Set<string>; embedTechnical: boolean; resourceType: string | null; resourceTypeLabel: string | null }
      >();
      for (const row of allGroupRows) {
        const existing = groupMap.get(row.groupId);
        const items = Array.isArray(row.translatableContent)
          ? (row.translatableContent as unknown as TranslatableField[])
          : [];
        // Only OUR app's embeds are locked read-only (pure technical selectors);
        // other apps' embeds may hold real translatable labels, so they stay
        // editable (parity with Translate & Adapt). appEmbedOwned is set at full
        // sync from the authoritative block.type app-handle.
        const isOwnedEmbed = row.resourceType === APP_EMBED && row.appEmbedOwned === true;
        if (existing) {
          for (const item of items) if (item.key) existing.uniqueKeys.add(item.key);
          if (isOwnedEmbed) existing.embedTechnical = true;
          // Downgrade to "mixed" (null) as soon as a second resource type appears.
          if (existing.resourceType !== null && existing.resourceType !== row.resourceType) {
            existing.resourceType = null;
            existing.resourceTypeLabel = null;
          }
        } else {
          const keys = new Set<string>();
          for (const item of items) if (item.key) keys.add(item.key);
          groupMap.set(row.groupId, { groupName: row.groupName, aiShortTitle: row.aiShortTitle, groupIcon: row.groupIcon, uniqueKeys: keys, embedTechnical: isOwnedEmbed, resourceType: row.resourceType, resourceTypeLabel: row.resourceTypeLabel });
        }
      }

      const themes: ThemeNavItem[] = Array.from(groupMap.entries())
        .map(([groupId, group]) => ({
          id: `group_${groupId}`,
          // Prefer the AI-generated concise title (e.g. "Bestellbestätigung")
          // over the raw groupName (the full email subject line) when present.
          title: group.aiShortTitle || group.groupName,
          groupName: group.groupName,
          icon: group.groupIcon,
          groupId,
          role: "THEME_GROUP",
          contentCount: group.uniqueKeys.size,
          type: group.resourceType ?? undefined,
          iconTooltip: group.resourceTypeLabel ?? undefined,
          translatableContent: [] as TranslatableField[],
          translations: [] as { key: string; value: string; locale?: string }[],
          embedTechnical: group.embedTechnical,
          // Signals the client to lazily kick off the AI title backfill: an
          // email-notification template that has no short title yet.
          aiTitlePending: group.resourceType === "EMAIL_TEMPLATE" && !group.aiShortTitle,
        }))
        .sort((a, b) => a.title.localeCompare(b.title));

      return { items: themes, ids: [] };
    },
  });
}

/**
 * Build the route action for a ThemeContent domain. Handles the editor's
 * fetchers (loadTranslations / generateAIText / translate* / updateContent),
 * dispatching to the shared template action handlers with the right domain.
 */
export function makeThemeContentRouteAction(domain: string, resourceTypes?: string[]) {
  return async ({ request }: ActionFunctionArgs) => {
    const { admin, session } = await authenticate.admin(request);
    const formData = await request.formData();
    const actionType = getFormString(formData, "action");
    const itemId = getFormString(formData, "itemId");

    const groupId = itemId?.replace("group_", "");
    if (!groupId) {
      return json({ success: false, error: "groupId is required" }, { status: 400 });
    }

    const { db } = await import("../db.server");

    // Theme sub-tabs share domain="theme" but a key-pattern groupId is not
    // guaranteed unique across resource types — scope to the tab's type(s) so
    // editor actions never touch a sibling tab's rows.
    const themeGroups = await db.themeContent.findMany({
      where: {
        shop: session.shop,
        groupId,
        domain,
        ...(resourceTypes && resourceTypes.length > 0 ? { resourceType: { in: resourceTypes } } : {}),
      },
    });

    if (themeGroups.length === 0) {
      return json({ success: false, error: "Group not found" }, { status: 404 });
    }

    const firstGroup = themeGroups[0] as ThemeContentRow;
    const resourceId = firstGroup.resourceId;

    // Map each field key → owning Shopify resource (a group may span resources).
    const keyToResourceId = new Map<string, string>();
    const keyToResourceType = new Map<string, string>();
    for (const group of themeGroups) {
      const items = group.translatableContent as unknown as TranslatableField[];
      if (Array.isArray(items)) {
        for (const item of items) {
          keyToResourceId.set(item.key, group.resourceId);
          if (group.resourceType) keyToResourceType.set(item.key, group.resourceType);
        }
      }
    }

    const ctx: TemplatesActionContext = {
      admin,
      session,
      db,
      formData,
      domain,
      groupId,
      themeGroups: themeGroups as ThemeContentRow[],
      firstGroup,
      resourceId,
      keyToResourceId,
      keyToResourceType,
    };

    try {
      switch (actionType) {
        case "loadTranslations":
          return handleLoadTranslations(ctx);
        case "generateAIText":
          return handleGenerateAIText(ctx);
        case "translateField":
          return handleTranslateField(ctx);
        case "translateFieldToAllLocales":
          return handleTranslateFieldToAllLocales(ctx);
        case "translateAll":
        case "translateAllForLocale":
          return handleTranslateAll(ctx, actionType);
        case "updateContent":
          return handleUpdateContent(ctx);
        default:
          return json({ success: false, error: "Unknown action" }, { status: 400 });
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      const { logger } = await import("./logger.server");
      logger.error(`[${logPrefixForDomain(domain)}-ACTION] Error`, { context: "ThemeContent", domain, error: msg, stack });
      return json({ success: false, error: msg }, { status: 500 });
    }
  };
}

function logPrefixForDomain(domain: string): string {
  return domain.toUpperCase();
}
