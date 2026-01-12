/**
 * API Route: Load theme content details for a specific group
 * Used for lazy loading when user clicks on a navigation item
 */

import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { groupId } = params;

  if (!groupId) {
    return json({ error: "groupId is required" }, { status: 400 });
  }

  try {
    const { db } = await import("../db.server");

    // Load theme content and translations for this specific group
    const [themeGroups, themeTranslations] = await Promise.all([
      db.themeContent.findMany({
        where: {
          shop: session.shop,
          groupId: groupId
        }
      }),
      db.themeTranslation.findMany({
        where: {
          shop: session.shop,
          groupId: groupId
        }
      })
    ]);

    if (themeGroups.length === 0) {
      return json({ error: "Group not found" }, { status: 404 });
    }

    // Group translations by resourceId
    const translationsByResource: Record<string, any[]> = {};
    for (const trans of themeTranslations) {
      const key = trans.resourceId;
      if (!translationsByResource[key]) {
        translationsByResource[key] = [];
      }
      translationsByResource[key].push(trans);
    }

    // Merge all translatable content from all resources in this group
    const allContent = themeGroups.flatMap((group) => group.translatableContent as any[]);
    const allTranslations = themeGroups.flatMap((group) =>
      translationsByResource[group.resourceId] || []
    );

    // Get group metadata from first item
    const firstGroup = themeGroups[0];

    const themeData = {
      id: `group_${groupId}`,
      title: firstGroup.groupName,
      name: firstGroup.groupName,
      icon: firstGroup.groupIcon,
      groupId: groupId,
      role: 'THEME_GROUP',
      translatableContent: allContent,
      translations: allTranslations,
      contentCount: allContent.length
    };

    return json({ theme: themeData });
  } catch (error: any) {
    console.error(`[API-TEMPLATES] Error loading group ${groupId}:`, error);
    return json({ error: error.message }, { status: 500 });
  }
};
