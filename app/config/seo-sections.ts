/**
 * SEO section descriptors — the single source of truth for the SEO tab's
 * sub-navigation (SEO_TAB_IMPLEMENTATION_PLAN.md §0.1b / A1). Mirrors the
 * CONTENT_RUBRICS pattern so the Level-2 nav can never drift from the routes:
 * the layout route (app.seo.tsx) renders one sub-tab per entry here.
 *
 * Adding a future SEO feature = appending one entry (once its route exists).
 * Entries are listed only when their route is implemented, so the sub-nav never
 * links to a dead route. Phases 3–8 (redirects, hreflang, keywords, GSC, AEO,
 * IndexNow) append their entries as those routes land.
 */

import type { Plan } from "./plans";

export type SeoSectionKind = "audit" | "tool" | "integration";

export interface SeoSectionDef {
  /** Stable id: "overview" | "structuredData" | "redirects" | … */
  id: string;
  /** Route path, e.g. "/app/seo" or "/app/seo/structured-data". */
  path: string;
  /** Emoji icon shown in the sub-nav. */
  icon: string;
  /** i18n key under `t.seo.sections.<labelKey>`. */
  labelKey: string;
  kind: SeoSectionKind;
  /** Minimum plan required to use the section (absent = all plans). */
  planGate?: Plan;
}

export const SEO_SECTIONS: SeoSectionDef[] = [
  {
    id: "overview",
    path: "/app/seo",
    icon: "📊",
    labelKey: "overview",
    kind: "audit",
  },
  {
    id: "structuredData",
    path: "/app/seo/structured-data",
    icon: "🔖",
    labelKey: "structuredData",
    kind: "tool",
  },
  {
    id: "redirects",
    path: "/app/seo/redirects",
    icon: "↪️",
    labelKey: "redirects",
    kind: "tool",
  },
  {
    id: "hreflang",
    path: "/app/seo/hreflang",
    icon: "🌐",
    labelKey: "hreflang",
    kind: "audit",
  },
  {
    id: "performance",
    path: "/app/seo/performance",
    icon: "🚀",
    labelKey: "performance",
    kind: "audit",
  },
  {
    id: "keywords",
    path: "/app/seo/keywords",
    icon: "🔑",
    labelKey: "keywords",
    kind: "tool",
  },
  {
    id: "searchConsole",
    path: "/app/seo/search-console",
    icon: "📈",
    labelKey: "searchConsole",
    kind: "integration",
    planGate: "pro",
  },
  {
    id: "aeo",
    path: "/app/seo/aeo",
    icon: "🤖",
    labelKey: "aeo",
    kind: "tool",
    planGate: "basic",
  },
  {
    id: "indexNow",
    path: "/app/seo/index-now",
    icon: "⚡",
    labelKey: "indexNow",
    kind: "integration",
    planGate: "pro",
  },
  {
    id: "crawl",
    path: "/app/seo/crawl",
    icon: "🕷️",
    labelKey: "crawl",
    kind: "audit",
    planGate: "pro",
  },
  {
    id: "internalLinks",
    path: "/app/seo/internal-links",
    icon: "🔗",
    labelKey: "internalLinks",
    kind: "tool",
    planGate: "pro",
  },
];

/** True when `pathname` is the SEO overview/index (exact, not a sub-path). */
export function isSeoIndexPath(pathname: string): boolean {
  return pathname === "/app/seo" || pathname === "/app/seo/";
}

/**
 * The SEO section owning `pathname`, or null on non-SEO pages.
 *
 * Matched longest-path-first because "/app/seo" is a prefix of every sub-path —
 * a naive `startsWith` would always resolve to the overview section.
 *
 * The `startsWith("/app/seo")` filter is defensive: every current section
 * lives under /app/seo, but it guards against a future entry that links OUT
 * of the section (as the former bulkMeta entry did) lighting the SEO tab.
 */
export function getActiveSeoSection(pathname: string): SeoSectionDef | null {
  const byLongestPath = SEO_SECTIONS.filter((s) => s.path.startsWith("/app/seo")).sort(
    (a, b) => b.path.length - a.path.length,
  );
  for (const section of byLongestPath) {
    if (pathname === section.path || pathname.startsWith(section.path + "/")) {
      return section;
    }
  }
  return null;
}

/** True when `pathname` belongs to the SEO tab. */
export function isSeoPath(pathname: string): boolean {
  return getActiveSeoSection(pathname) !== null;
}
