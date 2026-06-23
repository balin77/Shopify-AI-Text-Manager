/**
 * Content rubric model — the single source of truth for the 3-level content
 * navigation (Plan §5).
 *
 *   LEVEL 1  MainNavigation : Inhalte / Tasks / Einstellungen
 *   LEVEL 2  RubricNavigation : Katalog / Online Store / Theme / System / Direkte Übersetzungen
 *   LEVEL 3  ContentTypeNavigation : the active rubric's content-type entries
 *
 * Both RubricNavigation (Level 2) and ContentTypeNavigation (Level 3) read this
 * config so they can never drift apart.
 */

import type { ContentType as PlanContentType } from "./plans";

/** One Level-3 content-type entry (a route). */
export interface ContentEntryDef {
  id: string;
  path: string;
  icon: string;
  /** Key under the i18n `content` namespace for the label. */
  labelKey: string;
  /** Plan entitlement this entry maps to (drives the lock + gate). */
  planContentType: PlanContentType;
}

/** One Level-2 rubric grouping several content entries. */
export interface RubricDef {
  /** Key under the i18n `rubrics` namespace for the label. */
  id: string;
  icon: string;
  entries: ContentEntryDef[];
}

export const CONTENT_RUBRICS: RubricDef[] = [
  {
    id: "catalog",
    icon: "📦",
    entries: [
      { id: "products", path: "/app/products", icon: "🛍️", labelKey: "products", planContentType: "products" },
      { id: "collections", path: "/app/collections", icon: "📂", labelKey: "collections", planContentType: "collections" },
      { id: "sellingPlans", path: "/app/selling-plans", icon: "🔁", labelKey: "sellingPlans", planContentType: "sellingPlans" },
    ],
  },
  {
    id: "onlineStore",
    icon: "🌐",
    entries: [
      { id: "pages", path: "/app/pages", icon: "📄", labelKey: "pages", planContentType: "pages" },
      { id: "blogs", path: "/app/blog", icon: "📝", labelKey: "blogs", planContentType: "articles" },
      { id: "menus", path: "/app/menus", icon: "🍔", labelKey: "menus", planContentType: "menus" },
      { id: "policies", path: "/app/policies", icon: "📋", labelKey: "policies", planContentType: "policies" },
      { id: "metaobjects", path: "/app/metaobjects", icon: "🔷", labelKey: "metaobjects", planContentType: "metaobjects" },
      { id: "onlineStoreExtras", path: "/app/online-store-extras", icon: "🔍", labelKey: "onlineStoreExtras", planContentType: "onlineStoreExtras" },
    ],
  },
  {
    id: "theme",
    icon: "🎨",
    entries: [
      { id: "templates", path: "/app/templates", icon: "🧪", labelKey: "templates", planContentType: "templates" },
    ],
  },
  {
    id: "system",
    icon: "⚙️",
    entries: [
      { id: "system", path: "/app/system", icon: "✉️", labelKey: "system", planContentType: "system" },
      { id: "delivery", path: "/app/delivery", icon: "🚚", labelKey: "delivery", planContentType: "delivery" },
    ],
  },
  {
    id: "directTranslations",
    icon: "🌐",
    entries: [
      { id: "directTranslations", path: "/app/direct-translations", icon: "🌐", labelKey: "directTranslations", planContentType: "directTranslations" },
    ],
  },
];

/** Flat list of every content path (used for "are we on a content page?" checks). */
export const ALL_CONTENT_PATHS: string[] = CONTENT_RUBRICS.flatMap((r) => r.entries.map((e) => e.path));

function pathMatches(pathname: string, entryPath: string): boolean {
  return pathname === entryPath || pathname.startsWith(entryPath + "/");
}

/** The rubric owning the current pathname, or null on non-content pages. */
export function getActiveRubric(pathname: string): RubricDef | null {
  return CONTENT_RUBRICS.find((r) => r.entries.some((e) => pathMatches(pathname, e.path))) || null;
}

/** The content entry matching the current pathname, or null. */
export function getActiveEntry(pathname: string): ContentEntryDef | null {
  for (const r of CONTENT_RUBRICS) {
    const hit = r.entries.find((e) => pathMatches(pathname, e.path));
    if (hit) return hit;
  }
  return null;
}

/** True when the current pathname belongs to any content rubric. */
export function isContentPath(pathname: string): boolean {
  return getActiveRubric(pathname) !== null;
}
