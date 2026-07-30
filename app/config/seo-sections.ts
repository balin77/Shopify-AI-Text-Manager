/**
 * SEO section descriptors — the single source of truth for the SEO tab's
 * navigation (SEO_TAB_IMPLEMENTATION_PLAN.md §0.1b / A1). Mirrors the
 * CONTENT_RUBRICS pattern so the nav can never drift from the routes:
 * the layout route (app.seo.tsx) renders one Level-2 chip per rubric and one
 * Level-3 chip per section of the ACTIVE rubric.
 *
 * Ordering follows the SEO workflow left → right: first see where you stand
 * (Übersicht, Analyse), then optimise content (Keywords, Verlinkungen), then
 * let it be delivered/indexed (Technik & Indexierung).
 *
 * Adding a future SEO feature = appending one entry to the right rubric (once
 * its route exists). Entries are listed only when their route is implemented,
 * so the nav never links to a dead route.
 *
 * `SEO_SECTIONS` stays exported as the flat list (mobile drawer, plan gate
 * lookup in SeoSectionLayout, path matching) — it is derived from the rubrics,
 * never maintained separately.
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

/** One Level-2 rubric grouping several SEO sections. */
export interface SeoRubricDef {
  /** Stable id; label lives under `t.seo.rubrics.<id>`. */
  id: string;
  /** Emoji icon shown in the Level-2 bar. */
  icon: string;
  entries: SeoSectionDef[];
}

export const SEO_RUBRICS: SeoRubricDef[] = [
  {
    id: "overview",
    icon: "📊",
    entries: [
      {
        id: "overview",
        path: "/app/seo",
        icon: "📊",
        labelKey: "overview",
        kind: "audit",
      },
    ],
  },
  {
    // Diagnostics only — these sections read and report, they never write.
    id: "analysis",
    icon: "🔍",
    entries: [
      {
        id: "performance",
        path: "/app/seo/performance",
        icon: "🚀",
        labelKey: "performance",
        kind: "audit",
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
        id: "hreflang",
        path: "/app/seo/hreflang",
        icon: "🌐",
        labelKey: "hreflang",
        kind: "audit",
      },
    ],
  },
  {
    id: "rankings",
    icon: "🔑",
    entries: [
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
    ],
  },
  {
    id: "linking",
    icon: "🔗",
    entries: [
      {
        id: "redirects",
        path: "/app/seo/redirects",
        icon: "↪️",
        labelKey: "redirects",
        kind: "tool",
      },
      {
        id: "internalLinks",
        path: "/app/seo/internal-links",
        icon: "🔗",
        labelKey: "internalLinks",
        kind: "tool",
        planGate: "pro",
      },
    ],
  },
  {
    id: "technical",
    icon: "⚙️",
    entries: [
      {
        id: "structuredData",
        path: "/app/seo/structured-data",
        icon: "🔖",
        labelKey: "structuredData",
        kind: "tool",
      },
      {
        id: "sitemap",
        path: "/app/seo/sitemap",
        icon: "🗺️",
        labelKey: "sitemap",
        kind: "tool",
        planGate: "pro",
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
        id: "aeo",
        path: "/app/seo/aeo",
        icon: "🤖",
        labelKey: "aeo",
        kind: "tool",
        planGate: "basic",
      },
    ],
  },
];

/** Flat list of every SEO section, in rubric order. Derived — never edited directly. */
export const SEO_SECTIONS: SeoSectionDef[] = SEO_RUBRICS.flatMap((r) => r.entries);

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

/** The rubric owning `pathname`, or null on non-SEO pages. */
export function getActiveSeoRubric(pathname: string): SeoRubricDef | null {
  const section = getActiveSeoSection(pathname);
  if (!section) return null;
  return SEO_RUBRICS.find((r) => r.entries.some((e) => e.id === section.id)) ?? null;
}

/** True when `pathname` belongs to the SEO tab. */
export function isSeoPath(pathname: string): boolean {
  return getActiveSeoSection(pathname) !== null;
}
