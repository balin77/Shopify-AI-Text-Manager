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
 */
export function makeThemeDomainLoader(domain: string, logPrefix: string) {
  return createContentLoader({
    logPrefix,
    resourceType: null, // uses the ThemeTranslation table, not ContentTranslation
    itemsKey: "themes" as const,

    async loadData(ctx) {
      const allGroupRows = await ctx.db.themeContent.findMany({
        where: { shop: ctx.session.shop, domain },
        select: {
          groupId: true,
          groupName: true,
          groupIcon: true,
          translatableContent: true,
        },
      });

      // Aggregate by groupId, counting unique translatable field keys.
      const groupMap = new Map<string, { groupName: string; groupIcon: string; uniqueKeys: Set<string> }>();
      for (const row of allGroupRows) {
        const existing = groupMap.get(row.groupId);
        const items = Array.isArray(row.translatableContent)
          ? (row.translatableContent as unknown as TranslatableField[])
          : [];
        if (existing) {
          for (const item of items) if (item.key) existing.uniqueKeys.add(item.key);
        } else {
          const keys = new Set<string>();
          for (const item of items) if (item.key) keys.add(item.key);
          groupMap.set(row.groupId, { groupName: row.groupName, groupIcon: row.groupIcon, uniqueKeys: keys });
        }
      }

      const themes: ThemeNavItem[] = Array.from(groupMap.entries())
        .map(([groupId, group]) => ({
          id: `group_${groupId}`,
          title: group.groupName,
          groupName: group.groupName,
          icon: group.groupIcon,
          groupId,
          role: "THEME_GROUP",
          contentCount: group.uniqueKeys.size,
          translatableContent: [] as TranslatableField[],
          translations: [] as { key: string; value: string; locale?: string }[],
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
export function makeThemeContentRouteAction(domain: string) {
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

    const themeGroups = await db.themeContent.findMany({
      where: { shop: session.shop, groupId, domain },
    });

    if (themeGroups.length === 0) {
      return json({ success: false, error: "Group not found" }, { status: 404 });
    }

    const firstGroup = themeGroups[0] as ThemeContentRow;
    const resourceId = firstGroup.resourceId;

    // Map each field key → owning Shopify resource (a group may span resources).
    const keyToResourceId = new Map<string, string>();
    for (const group of themeGroups) {
      const items = group.translatableContent as unknown as TranslatableField[];
      if (Array.isArray(items)) {
        for (const item of items) keyToResourceId.set(item.key, group.resourceId);
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
