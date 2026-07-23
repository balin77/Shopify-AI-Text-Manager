/**
 * PageSpeed Insights audit — SEO tab "Performance" section.
 *
 * Server-side wrapper around the PSI v5 API: runs (or serves a cached) audit
 * for a shop's storefront URL, parses the raw Lighthouse response into the
 * compact `PageSpeedAuditResult` contract (pagespeed.types.ts), and persists
 * it to `SeoPageSpeedAudit` (Prisma). History is pruned to the newest 10 rows
 * per (shop, url, strategy) on every write.
 *
 * `db` is typed loosely (`any`) rather than `PrismaClient`: this file was
 * built against a schema.prisma model (SeoPageSpeedAudit) whose Prisma Client
 * has not been regenerated in this environment, so `PrismaClient` would not
 * carry the `seoPageSpeedAudit` delegate yet and the file would fail to
 * typecheck. Once `prisma generate` runs against the new schema this can be
 * tightened back to `PrismaClient` like the sibling seo/*.service.ts files.
 *
 * `parsePageSpeedResponse` is exported for tests and is deliberately
 * defensive: PSI/Lighthouse response shapes vary across versions and PSI
 * itself omits sections (no field data, no screenshot, etc.) — every field is
 * optional-chained and the whole function is wrapped so a malformed/garbage
 * response degrades to nulls/empty arrays instead of throwing.
 */

import type { Plan } from "../../config/plans";
import { getDailyPageSpeedRunsLimit } from "../../utils/planUtils";
import type {
  PageSpeedAnnotation,
  PageSpeedAuditResult,
  PageSpeedCell,
  PageSpeedCellType,
  PageSpeedTable,
  PageSpeedTableRow,
  PageSpeedFieldData,
  PageSpeedFieldMetric,
  PageSpeedHistoryEntry,
  PageSpeedMetric,
  PageSpeedMetricId,
  PageSpeedOpportunity,
  PageSpeedPassedAudit,
  PageSpeedRect,
  PageSpeedScreenshot,
  PageSpeedStrategy,
  QualityIssue,
  QualityResult,
} from "./pagespeed.types";

/**
 * How long a stored audit may still answer a plain (non-forced) run.
 *
 * The UI does not rely on this any more: its single "test" button always forces
 * a real measurement, and asks first when one is this recent (see
 * RECENT_RUN_WINDOW_MS in app.seo.performance.tsx) — a merchant who clicks
 * "test" must never be handed an old result without being told. The window
 * survives only as the guard for any non-forced caller, because the lookup
 * happens BEFORE the daily budget check.
 */
export const PAGESPEED_CACHE_TTL_MS = 5 * 60 * 1000;

/** History rows are pruned to this many per (shop, url, strategy) on every write. */
const HISTORY_KEEP_PER_TARGET = 10;

const PSI_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const PSI_TIMEOUT_MS = 60_000;

/**
 * Thrown when Google PSI returns 429 (per-day or per-minute quota). Callers
 * can catch this specifically to fall back to a stale cached result instead of
 * surfacing Google's raw English error message to the merchant.
 */
export class PageSpeedQuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageSpeedQuotaExceededError";
  }
}

/**
 * Thrown when the shop has used up its plan's `dailyPageSpeedRuns` budget.
 * Kept distinct from `PageSpeedQuotaExceededError` so the UI can say "your
 * daily budget" rather than blaming Google for a limit that is ours.
 */
export class PageSpeedDailyLimitError extends Error {
  constructor(
    readonly runsToday: number,
    readonly limit: number,
  ) {
    super(`PageSpeed daily limit reached: ${runsToday}/${limit}`);
    this.name = "PageSpeedDailyLimitError";
  }
}

/** Midnight UTC of the day `now` falls in. UTC so the boundary never moves with shop timezone. */
function startOfUtcDay(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Real PSI runs this shop made today.
 *
 * A `SeoPageSpeedAudit` row is written only after a run that actually reached
 * Google (cache hits return early, before the insert), so counting rows IS the
 * usage counter — no separate counter model needed.
 */
export async function countPageSpeedRunsToday(db: any, shop: string): Promise<number> {
  return db.seoPageSpeedAudit.count({
    where: { shop, createdAt: { gte: startOfUtcDay() } },
  });
}

/**
 * True when `url` is https and its hostname matches one of `allowedHosts`
 * (case-insensitive, exact match — no subdomain/wildcard matching).
 */
export function isAllowedAuditUrl(url: string, allowedHosts: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return allowedHosts.some((h) => h.toLowerCase() === host);
}

export interface RunPageSpeedAuditOptions {
  db: any; // Prisma client (see file header re: loose typing)
  shop: string;
  url: string; // absolute https URL, already domain-validated by the caller
  strategy: PageSpeedStrategy;
  force?: boolean; // true = bypass cache and re-run
  /** Drives the daily run budget. Resolved from AISettings.subscriptionPlan by the caller. */
  plan: Plan;
  /**
   * UI language (AISettings.appLanguage). Passed to PSI as `locale` so audit
   * titles, descriptions and table headings — all of which we render verbatim —
   * come back in the merchant's language instead of English.
   */
  locale?: string;
}

export async function runPageSpeedAudit(opts: RunPageSpeedAuditOptions): Promise<PageSpeedAuditResult> {
  const { db, shop, url, strategy, force, plan, locale } = opts;

  if (!force) {
    const cached = await db.seoPageSpeedAudit.findFirst({
      where: { shop, url, strategy },
      orderBy: { createdAt: "desc" },
    });
    if (cached) {
      const createdAtMs =
        cached.createdAt instanceof Date ? cached.createdAt.getTime() : new Date(cached.createdAt).getTime();
      if (Date.now() - createdAtMs < PAGESPEED_CACHE_TTL_MS) {
        return cached.result as PageSpeedAuditResult;
      }
    }
  }

  // Budget check sits AFTER the cache lookup on purpose: serving a cached
  // result costs no Google quota, so re-opening a recent audit must stay free.
  // Only runs that reach Google are budgeted.
  const limit = getDailyPageSpeedRunsLimit(plan);
  const runsToday = await countPageSpeedRunsToday(db, shop);
  if (runsToday >= limit) {
    throw new PageSpeedDailyLimitError(runsToday, limit);
  }

  const fetchedAt = new Date().toISOString();
  const raw = await fetchPageSpeedInsights(url, strategy, locale);
  const result = parsePageSpeedResponse(raw, url, strategy, fetchedAt);

  await db.seoPageSpeedAudit.create({
    data: {
      shop,
      url,
      strategy,
      score: result.performanceScore,
      a11yScore: result.quality?.a11yScore ?? null,
      bestPracticesScore: result.quality?.bestPracticesScore ?? null,
      result: result as any,
    },
  });

  await pruneHistory(db, shop, url, strategy);

  return result;
}

async function fetchPageSpeedInsights(
  url: string,
  strategy: PageSpeedStrategy,
  locale?: string,
  // `seo` is deliberately NOT requested (accessibility plan §11.4): ContentPilot
  // has its own, deeper SEO scoring, and a second SEO number with a different
  // band would only undercut it.
  categories: string[] = ["performance", "accessibility", "best-practices"],
): Promise<unknown> {
  const apiUrl = new URL(PSI_ENDPOINT);
  apiUrl.searchParams.set("url", url);
  apiUrl.searchParams.set("strategy", strategy);
  for (const c of categories) apiUrl.searchParams.append("category", c);
  if (locale) apiUrl.searchParams.set("locale", locale);
  if (process.env.PAGESPEED_API_KEY) {
    apiUrl.searchParams.set("key", process.env.PAGESPEED_API_KEY);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PSI_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(apiUrl.toString(), { signal: controller.signal });
    } catch (err) {
      throw new Error(
        `PageSpeed Insights request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      let detail = "";
      try {
        const body: any = await res.json();
        if (body?.error?.message) detail = `: ${body.error.message}`;
      } catch {
        // body wasn't JSON (or empty) — fall through with no detail.
      }
      if (res.status === 429) {
        throw new PageSpeedQuotaExceededError(`PageSpeed Insights returned 429${detail}`);
      }
      throw new Error(`PageSpeed Insights returned ${res.status}${detail}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function pruneHistory(db: any, shop: string, url: string, strategy: PageSpeedStrategy): Promise<void> {
  const stale = await db.seoPageSpeedAudit.findMany({
    where: { shop, url, strategy },
    orderBy: { createdAt: "desc" },
    select: { id: true },
    skip: HISTORY_KEEP_PER_TARGET,
  });
  if (stale.length > 0) {
    await db.seoPageSpeedAudit.deleteMany({
      where: { id: { in: stale.map((r: { id: string }) => r.id) } },
    });
  }
}

/**
 * Return the newest stored audit for (shop, url, strategy) regardless of age,
 * marked `stale: true`. Used as a graceful fallback when a fresh PSI run can't
 * be made (e.g. Google's daily quota was exhausted). Returns null when nothing
 * has ever been cached for this target.
 */
export async function findLatestPageSpeedAudit(
  db: any,
  shop: string,
  url: string,
  strategy: PageSpeedStrategy,
): Promise<PageSpeedAuditResult | null> {
  const cached = await db.seoPageSpeedAudit.findFirst({
    where: { shop, url, strategy },
    orderBy: { createdAt: "desc" },
  });
  if (!cached) return null;
  const result = cached.result as PageSpeedAuditResult;
  return { ...result, stale: true };
}

/**
 * Fetch a stored audit by its row id, scoped to `shop` (so one shop cannot
 * read another shop's audit even if it guesses the id). Returns the parsed
 * `PageSpeedAuditResult` or null when the row does not exist / belongs to a
 * different shop.
 */
export async function findPageSpeedAuditById(
  db: any,
  shop: string,
  id: string,
): Promise<PageSpeedAuditResult | null> {
  const cached = await db.seoPageSpeedAudit.findFirst({
    where: { id, shop },
  });
  if (!cached) return null;
  return cached.result as PageSpeedAuditResult;
}

export interface ListPageSpeedHistoryOptions {
  db: any;
  shop: string;
  limit?: number; // default 20
}

export async function listPageSpeedHistory(opts: ListPageSpeedHistoryOptions): Promise<PageSpeedHistoryEntry[]> {
  const { db, shop, limit = 20 } = opts;
  const rows = await db.seoPageSpeedAudit.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      url: true,
      strategy: true,
      score: true,
      a11yScore: true,
      bestPracticesScore: true,
      createdAt: true,
    },
  });
  return rows.map((r: any) => ({
    id: r.id,
    url: r.url,
    strategy: r.strategy,
    performanceScore: typeof r.score === "number" ? r.score : null,
    a11yScore: typeof r.a11yScore === "number" ? r.a11yScore : null,
    bestPracticesScore: typeof r.bestPracticesScore === "number" ? r.bestPracticesScore : null,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
  }));
}

/**
 * Delete one stored audit by its row id, scoped to `shop` so a tampered request
 * cannot delete another tenant's history. Returns the number of rows removed
 * (0 when the id does not exist / belongs to a different shop).
 */
export async function deletePageSpeedAudit(db: any, shop: string, id: string): Promise<number> {
  const res = await db.seoPageSpeedAudit.deleteMany({ where: { id, shop } });
  return typeof res?.count === "number" ? res.count : 0;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

const METRIC_AUDIT_IDS: Record<PageSpeedMetricId, string> = {
  lcp: "largest-contentful-paint",
  cls: "cumulative-layout-shift",
  tbt: "total-blocking-time",
  fcp: "first-contentful-paint",
  si: "speed-index",
};

/**
 * Diagnostics worth surfacing as opportunities even when not
 * `type: "opportunity"` and without `metricSavings`. All of these carry a
 * numeric `score`, so they only surface when actually failing — informative
 * (score: null) audits are deliberately not listed here, as they would show up
 * on every single run.
 */
const EXTRA_DIAGNOSTIC_AUDIT_IDS = [
  "render-blocking-resources",
  "unused-javascript",
  "unused-css-rules",
  "total-byte-weight",
  "dom-size",
];

/** Image-savings audits scanned for `image` annotations + opportunity linking. */
const IMAGE_OPPORTUNITY_AUDIT_IDS = ["modern-image-formats", "uses-responsive-images", "uses-optimized-images"];

const MAX_LABEL_LENGTH = 80;
const MAX_CLS_ANNOTATIONS = 5;
const MAX_IMAGE_ANNOTATIONS = 5;
/**
 * Safety net only. Findings are no longer truncated for display — the accordion
 * keeps them collapsed, so an extra finding costs one header row — but a
 * malformed response should not be able to blow up the stored JSON.
 */
const MAX_OPPORTUNITIES = 60;
/** Passed audits are title-only, so a generous cap costs almost nothing. */
const MAX_PASSED_AUDITS = 60;
/** Caps on the per-finding detail table — it is persisted with the audit. */
const MAX_TABLE_ROWS = 8;
const MAX_SUB_ROWS = 3;
const MAX_TABLE_COLUMNS = 4;
const MAX_CELL_LENGTH = 160;
/**
 * Caps on the quality (accessibility / best-practices) findings, persisted in
 * the result JSON next to the Base64 screenshots — size matters (accessibility
 * plan §4). Totals before the cap are stored so the UI can disclose it.
 */
const MAX_QUALITY_ISSUES = 15;
const MAX_QUALITY_ISSUE_ITEMS = 5;

/** Parse a raw PSI v5 response into the compact result. Never throws. */
export function parsePageSpeedResponse(
  raw: unknown,
  url: string,
  strategy: PageSpeedStrategy,
  fetchedAt: string,
): PageSpeedAuditResult {
  try {
    return parsePageSpeedResponseInner(raw, url, strategy, fetchedAt);
  } catch {
    return {
      url,
      strategy,
      fetchedAt,
      performanceScore: null,
      metrics: [],
      screenshot: null,
      annotations: [],
      opportunities: [],
      fieldData: null,
    };
  }
}

function parsePageSpeedResponseInner(
  raw: unknown,
  url: string,
  strategy: PageSpeedStrategy,
  fetchedAt: string,
): PageSpeedAuditResult {
  const r: any = raw && typeof raw === "object" ? raw : {};
  const lighthouseResult: any = r.lighthouseResult ?? {};
  const audits: Record<string, any> = lighthouseResult.audits ?? {};
  const categories: any = lighthouseResult.categories ?? {};

  const performanceScore = extractPerformanceScore(categories);
  const metrics = extractMetrics(audits);
  const { screenshot, preview, nodesMap } = extractScreenshot(audits, lighthouseResult);

  const imageAnnotationsByAuditId: Record<string, string[]> = {};
  const { annotations, total: annotationTotal } = nodesMap
    ? extractAnnotations(audits, nodesMap, imageAnnotationsByAuditId)
    : { annotations: [], total: 0 };

  const { opportunities, total: opportunityTotal } = extractOpportunities(
    audits,
    imageAnnotationsByAuditId,
    nodesMap,
  );
  const passedAudits = extractPassedAudits(audits, categories);
  const fieldData = extractFieldData(r);
  const quality = extractQuality(lighthouseResult, audits);

  const base: PageSpeedAuditResult = {
    url,
    strategy,
    fetchedAt,
    performanceScore,
    metrics,
    screenshot,
    annotations,
    opportunities,
    fieldData,
    annotationTotal,
    opportunityTotal,
  };
  if (screenshot && !screenshot.fullPage) {
    base.screenshotUnavailableReason = extractScreenshotUnavailableReason(lighthouseResult, audits);
  }

  const finalUrl = lighthouseResult.finalDisplayedUrl ?? lighthouseResult.finalUrl;
  if (typeof finalUrl === "string" && finalUrl && !sameUrl(finalUrl, url)) {
    base.finalUrl = finalUrl;
  }

  if (preview) base.previewScreenshot = preview;
  if (passedAudits.length > 0) base.passedAudits = passedAudits;
  if (quality) base.quality = quality;

  const runtimeError = extractRuntimeError(lighthouseResult);
  if (runtimeError) base.runtimeError = runtimeError;

  const runWarnings = Array.isArray(lighthouseResult.runWarnings)
    ? lighthouseResult.runWarnings.filter((w: unknown): w is string => typeof w === "string" && !!w.trim())
    : [];
  if (runWarnings.length > 0) base.runWarnings = runWarnings;

  return base;
}

/** Compare two URLs ignoring a trailing slash, so `/x` vs `/x/` is not reported as a redirect. */
function sameUrl(a: string, b: string): boolean {
  const norm = (u: string) => u.replace(/\/+$/, "");
  return norm(a) === norm(b);
}

/**
 * Lighthouse's fatal error for the run, if any. PSI answers HTTP 200 even when
 * the page could not be analysed (failed navigation, no first paint, timeout),
 * so this is the only signal distinguishing "score 0-ish" from "never ran".
 * `NO_ERROR` is Lighthouse's explicit all-clear code and is ignored.
 */
function extractRuntimeError(lighthouseResult: any): string | null {
  const err = lighthouseResult?.runtimeError;
  if (!err) return null;
  if (typeof err.code === "string" && err.code === "NO_ERROR") return null;
  const message = typeof err.message === "string" ? err.message.trim() : "";
  if (message) return message;
  return typeof err.code === "string" && err.code ? err.code : null;
}

/**
 * Best-effort text lifted from the raw PSI response explaining why Lighthouse
 * fell back to the viewport-only `final-screenshot`. Checks the failing audit
 * first, then a top-level `runtimeError`, then any `runWarnings` that mention
 * screenshots. Returns an empty string when nothing informative was reported —
 * the UI shows a generic explanation in that case.
 */
function extractScreenshotUnavailableReason(
  lighthouseResult: any,
  audits: Record<string, any>,
): string {
  const auditErr = audits?.["full-page-screenshot"]?.errorMessage;
  if (typeof auditErr === "string" && auditErr.trim()) return auditErr.trim();

  const runtimeMsg = lighthouseResult?.runtimeError?.message;
  if (typeof runtimeMsg === "string" && runtimeMsg.trim()) return runtimeMsg.trim();

  const warnings = lighthouseResult?.runWarnings;
  if (Array.isArray(warnings)) {
    const hit = warnings.find(
      (w) => typeof w === "string" && /screenshot|element/i.test(w),
    );
    if (typeof hit === "string" && hit.trim()) return hit.trim();
  }
  return "";
}

function extractPerformanceScore(categories: any): number | null {
  return extractCategoryScore(categories?.performance);
}

/** Lighthouse 0..1 category score → 0-100, null when the category could not be scored. */
function extractCategoryScore(category: any): number | null {
  const score = category?.score;
  return typeof score === "number" ? Math.round(score * 100) : null;
}

// ── Quality (accessibility / best-practices) ────────────────────────────────

/**
 * Parse the accessibility and best-practices categories of the same run into
 * the `QualityResult` contract. Returns undefined when NEITHER category is in
 * the response — that keeps `quality` absent on responses fetched before the
 * categories were requested (legacy empty state, accessibility plan §3.8).
 * Defensive like the rest of the parser: must never throw.
 */
function extractQuality(lighthouseResult: any, audits: Record<string, any>): QualityResult | undefined {
  try {
    const categories: any = lighthouseResult?.categories ?? {};
    const a11yCategory = categories?.accessibility;
    const bpCategory = categories?.["best-practices"];
    if (!a11yCategory && !bpCategory) return undefined;

    const groupTitles = resolveGroupTitles(lighthouseResult);
    const a11y = extractCategoryBuckets(a11yCategory, audits, groupTitles);
    const bp = extractCategoryBuckets(bpCategory, audits, groupTitles);
    return {
      a11yScore: extractCategoryScore(a11yCategory),
      bestPracticesScore: extractCategoryScore(bpCategory),
      accessibility: a11y.issues,
      bestPractices: bp.issues,
      accessibilityTotal: a11y.total,
      bestPracticesTotal: bp.total,
      ...(a11y.passed.length > 0 ? { accessibilityPassed: a11y.passed } : {}),
      ...(bp.passed.length > 0 ? { bestPracticesPassed: bp.passed } : {}),
      ...(a11y.advisory.length > 0 ? { accessibilityAdvisory: a11y.advisory } : {}),
      ...(bp.advisory.length > 0 ? { bestPracticesAdvisory: bp.advisory } : {}),
      ...(a11y.notApplicable.length > 0 ? { accessibilityNotApplicable: a11y.notApplicable } : {}),
      ...(bp.notApplicable.length > 0 ? { bestPracticesNotApplicable: bp.notApplicable } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Map of Lighthouse group id → its localized title (e.g.
 * "best-practices-trust-safety" → "Vertrauen und Sicherheit"), read from the
 * response's `categoryGroups`. Used to group findings/advisory the way PSI does.
 */
function resolveGroupTitles(lighthouseResult: any): Record<string, string> {
  const map: Record<string, string> = {};
  const groups = lighthouseResult?.categoryGroups;
  if (groups && typeof groups === "object") {
    for (const [id, g] of Object.entries(groups)) {
      const title = (g as any)?.title;
      if (typeof title === "string" && title) map[id] = title;
    }
  }
  return map;
}

/**
 * Sort rank within a category: failing scored audits first, then informative
 * (score null) findings, manual checks always last — they are not findings.
 */
function qualityIssueRank(issue: QualityIssue): number {
  if (issue.manual) return 2;
  if (issue.score === null) return 1;
  return 0;
}

/**
 * Classify every audit ref of a quality category into the buckets PSI shows:
 *
 *  - `issues`   — failing findings (score < 0.9, or an informative audit that
 *                 reported affected items) PLUS the manual checks (manual: true),
 *                 concatenated as before so the UI can split them by `.manual`.
 *  - `advisory` — informative audits with NO verdict and no affected-items list
 *                 (the gray-circle entries: CSP, HSTS, clickjacking, …).
 *  - `passed`   — audits that pass (score >= 0.9), title-only.
 *  - `notApplicable` — audits that did not apply to this page, title-only.
 *  - `total`    — failing findings BEFORE the cap (manual/advisory excluded).
 *
 * Findings, manual checks and advisory are capped SEPARATELY (a shared cap
 * would let a handful of findings swallow the ~10 manual checks a11y always
 * carries). Each finding/advisory/manual carries its resolved Lighthouse group
 * title so the UI can render PSI's group headings.
 */
function extractCategoryBuckets(
  category: any,
  audits: Record<string, any>,
  groupTitles: Record<string, string>,
): {
  issues: QualityIssue[];
  total: number;
  advisory: QualityIssue[];
  passed: PageSpeedPassedAudit[];
  notApplicable: PageSpeedPassedAudit[];
} {
  const refs = Array.isArray(category?.auditRefs) ? category.auditRefs : [];
  const findings: QualityIssue[] = [];
  const manualIssues: QualityIssue[] = [];
  const advisory: QualityIssue[] = [];
  const passed: PageSpeedPassedAudit[] = [];
  const notApplicable: PageSpeedPassedAudit[] = [];
  const seen = new Set<string>();
  let total = 0;

  for (const ref of refs) {
    const id = typeof ref?.id === "string" ? ref.id : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const audit: any = audits[id];
    if (!audit || typeof audit !== "object") continue;

    const mode = typeof audit.scoreDisplayMode === "string" ? audit.scoreDisplayMode : "";
    const title = typeof audit.title === "string" ? audit.title : id;
    const displayValue = typeof audit.displayValue === "string" ? audit.displayValue : undefined;
    const groupId = typeof ref?.group === "string" ? ref.group : "";
    const group = groupId && groupTitles[groupId] ? groupTitles[groupId] : undefined;

    if (mode === "notApplicable") {
      notApplicable.push({ id, title, ...(displayValue ? { displayValue } : {}) });
      continue;
    }

    const score = typeof audit.score === "number" ? audit.score : null;
    const informative = mode === "informative";
    const manual = mode === "manual";

    // Passed: a real binary/numeric verdict >= 0.9. Informative audits are never
    // "passed" even when they carry a nominal score — they have no verdict.
    if (!informative && !manual && score !== null && score >= 0.9) {
      passed.push({ id, title, ...(displayValue ? { displayValue } : {}) });
      continue;
    }

    const { items, itemTotal } = extractQualityIssueItems(audit.details);
    const description = typeof audit.description === "string" ? audit.description : undefined;
    // Richer than the flat items list: source location, console error text, CSP
    // directive, etc. No nodesMap — quality findings carry no screenshot crops.
    const table = manual ? undefined : extractTable(audit.details, null);
    const issue: QualityIssue = {
      id,
      title,
      ...(description ? { description: stripMarkdownLinks(description) } : {}),
      // Informative and manual audits have no verdict — force score null so they
      // render neutral (gray), never as a green "pass" via a nominal score.
      score: manual || informative ? null : score,
      items,
      itemTotal,
      ...(table ? { table } : {}),
      manual,
      ...(group ? { group } : {}),
      ...(groupId ? { groupId } : {}),
    };

    if (manual) {
      manualIssues.push(issue);
      continue;
    }

    if (informative) {
      // A real finding when Lighthouse listed affected items to act on (raw
      // items, mirroring the previous rule), else an advisory hint — the
      // gray-circle entries (CSP, HSTS, …), still worth surfacing.
      const hasRawItems = Array.isArray(audit.details?.items) && audit.details.items.length > 0;
      if (hasRawItems) {
        findings.push(issue);
        total += 1;
      } else {
        advisory.push(issue);
      }
      continue;
    }

    // Non-informative with a numeric score below the pass bar → failing finding.
    // A null score here is neither pass, fail nor advice → dropped.
    if (score !== null) {
      findings.push(issue);
      total += 1;
    }
  }

  findings.sort((a, b) => qualityIssueRank(a) - qualityIssueRank(b));
  passed.sort((a, b) => a.title.localeCompare(b.title));
  notApplicable.sort((a, b) => a.title.localeCompare(b.title));
  return {
    issues: [
      ...findings.slice(0, MAX_QUALITY_ISSUES),
      ...manualIssues.slice(0, MAX_QUALITY_ISSUES),
    ],
    total,
    advisory: advisory.slice(0, MAX_QUALITY_ISSUES),
    passed: passed.slice(0, MAX_PASSED_AUDITS),
    notApplicable: notApplicable.slice(0, MAX_PASSED_AUDITS),
  };
}

/**
 * Affected elements of a quality audit, capped; `itemTotal` = renderable
 * entries before the cap. Entries that end up with no selector, snippet AND
 * url (e.g. errors-in-console rows, which only carry a description) are
 * dropped — they would render as blank lines, and counting them would make
 * the truncation note claim elements the UI never had.
 */
function extractQualityIssueItems(details: any): {
  items: QualityIssue["items"];
  itemTotal: number;
} {
  const rawItems = Array.isArray(details?.items) ? details.items : [];
  const entries: QualityIssue["items"] = [];
  for (const item of rawItems) {
    const entry: QualityIssue["items"][number] = {};
    const selector = item?.node?.selector;
    if (typeof selector === "string" && selector) entry.selector = truncate(selector);
    const rawSnippet = typeof item?.node?.snippet === "string" ? item.node.snippet : "";
    if (rawSnippet) entry.snippet = truncate(rawSnippet);
    // `url` feeds the image-alt → ProductImage match (accessibility plan §7):
    // prefer the item's own url, else pull src="…" from the UNtruncated snippet.
    const url =
      typeof item?.url === "string" && item.url ? item.url : extractSrcFromSnippet(rawSnippet);
    if (url) entry.url = url;
    if (entry.selector || entry.snippet || entry.url) entries.push(entry);
  }
  return { items: entries.slice(0, MAX_QUALITY_ISSUE_ITEMS), itemTotal: entries.length };
}

/**
 * Pull the src attribute out of an element snippet like `<img src="…">`.
 * The lookbehind keeps `data-src="…"` (lazy-load placeholders) from matching —
 * `\b` would match right after the hyphen and hand back the wrong URL.
 */
function extractSrcFromSnippet(snippet: string): string | undefined {
  const m = snippet.match(/(?<![-\w])src=["']([^"']+)["']/i);
  return m ? m[1] : undefined;
}

function extractMetrics(audits: Record<string, any>): PageSpeedMetric[] {
  const metrics: PageSpeedMetric[] = [];
  for (const id of Object.keys(METRIC_AUDIT_IDS) as PageSpeedMetricId[]) {
    const audit = audits[METRIC_AUDIT_IDS[id]];
    if (!audit) continue;
    metrics.push({
      id,
      displayValue: typeof audit.displayValue === "string" ? audit.displayValue : "",
      numericValue: typeof audit.numericValue === "number" ? audit.numericValue : 0,
      score: typeof audit.score === "number" ? audit.score : null,
    });
  }
  return metrics;
}

/** Raw `full-page-screenshot` nodes-map entry: {top,bottom,left,right,width,height}. */
type RawNodeRect = { top?: number; bottom?: number; left?: number; right?: number; width?: number; height?: number };

function rectFromRawNodeRect(n: RawNodeRect | undefined | null): PageSpeedRect | null {
  if (!n) return null;
  const left = n.left;
  const top = n.top;
  const width = typeof n.width === "number" ? n.width : safeSpan(n.right, n.left);
  const height = typeof n.height === "number" ? n.height : safeSpan(n.bottom, n.top);
  if (typeof left !== "number" || typeof top !== "number" || typeof width !== "number" || typeof height !== "number") {
    return null;
  }
  return { left, top, width, height };
}

function safeSpan(end: number | undefined, start: number | undefined): number | undefined {
  return typeof end === "number" && typeof start === "number" ? end - start : undefined;
}

function extractScreenshot(
  audits: Record<string, any>,
  lighthouseResult: any,
): {
  screenshot: PageSpeedScreenshot | null;
  /** Viewport shot, kept alongside the full-page one for the UI preview. */
  preview: PageSpeedScreenshot | null;
  nodesMap: Record<string, RawNodeRect> | null;
} {
  // Lighthouse >= 10 (what PSI runs today) carries the full-page screenshot and
  // its nodes map as a top-level LHR property; only older versions exposed it as
  // the hidden `full-page-screenshot` audit. Reading the audit alone meant we
  // never found a screenshot on current runs — no rects, no element thumbnails,
  // and the "Google couldn't create an element screenshot" banner on every run.
  const fullPageDetails = lighthouseResult?.fullPageScreenshot ?? audits["full-page-screenshot"]?.details;
  const shot = fullPageDetails?.screenshot;

  // Viewport-only shot. Its coordinate space does not match the nodes map, so it
  // never carries annotations — but it is the better preview image.
  const finalData = audits["final-screenshot"]?.details?.data;
  const preview: PageSpeedScreenshot | null =
    typeof finalData === "string" && finalData
      ? { data: finalData, width: 0, height: 0, fullPage: false }
      : null;

  if (shot?.data) {
    return {
      screenshot: {
        data: shot.data,
        width: typeof shot.width === "number" ? shot.width : 0,
        height: typeof shot.height === "number" ? shot.height : 0,
        fullPage: true,
      },
      preview,
      nodesMap:
        fullPageDetails?.nodes && typeof fullPageDetails.nodes === "object" ? fullPageDetails.nodes : null,
    };
  }

  // No full-page capture: the viewport shot has to serve as both, and there are
  // no rects to annotate with (see pagespeed.types.ts header comment).
  if (preview) return { screenshot: preview, preview: null, nodesMap: null };

  return { screenshot: null, preview: null, nodesMap: null };
}

function resolveNodeRect(node: any, nodesMap: Record<string, RawNodeRect>): PageSpeedRect | null {
  if (!node) return null;
  const lhId = node.lhId;
  if (typeof lhId === "string" && nodesMap[lhId]) {
    const r = rectFromRawNodeRect(nodesMap[lhId]);
    if (r) return r;
  }
  return rectFromRawNodeRect(node.boundingRect);
}

function isPositiveRect(r: PageSpeedRect | null): r is PageSpeedRect {
  return !!r && r.width > 0 && r.height > 0;
}

function nodeLabel(node: any, fallback = ""): string {
  const raw = node?.snippet || node?.nodeLabel || node?.selector || fallback;
  const s = String(raw ?? "").trim();
  return s.length > MAX_LABEL_LENGTH ? `${s.slice(0, MAX_LABEL_LENGTH)}…` : s;
}

/** Handles both `items[].node` and the newer nested `items[].items[].node` shape. */
function extractLcpNodes(details: any): any[] {
  const items = Array.isArray(details?.items) ? details.items : [];
  const nodes: any[] = [];
  for (const item of items) {
    if (item?.node) nodes.push(item.node);
    if (Array.isArray(item?.items)) {
      for (const sub of item.items) {
        if (sub?.node) nodes.push(sub.node);
      }
    }
  }
  return nodes;
}

/**
 * Build the screenshot overlay boxes. Returns `total` = how many annotatable
 * elements Lighthouse reported *before* the per-kind caps, so the UI can tell
 * the merchant that the list is truncated rather than silently showing five.
 */
function extractAnnotations(
  audits: Record<string, any>,
  nodesMap: Record<string, RawNodeRect>,
  imageAnnotationsByAuditId: Record<string, string[]>,
): { annotations: PageSpeedAnnotation[]; total: number } {
  const annotations: PageSpeedAnnotation[] = [];
  let total = 0;

  // lcp
  const lcpNodes = extractLcpNodes(audits["largest-contentful-paint-element"]?.details);
  lcpNodes.forEach((node, i) => {
    const rect = resolveNodeRect(node, nodesMap);
    if (!isPositiveRect(rect)) return;
    total += 1;
    annotations.push({ id: `lcp-${i}`, kind: "lcp", label: nodeLabel(node), rect });
  });

  // cls — prefer legacy layout-shift-elements, fall back to newer layout-shifts.
  const clsAudit = audits["layout-shift-elements"] ?? audits["layout-shifts"];
  const clsItems = Array.isArray(clsAudit?.details?.items) ? clsAudit.details.items : [];
  let clsCount = 0;
  for (const item of clsItems) {
    const node = item?.node;
    const rect = resolveNodeRect(node, nodesMap);
    if (!isPositiveRect(rect)) continue;
    total += 1;
    if (clsCount >= MAX_CLS_ANNOTATIONS) continue;
    const score = typeof item?.score === "number" ? item.score : undefined;
    annotations.push({
      id: `cls-${clsCount}`,
      kind: "cls",
      label: nodeLabel(node),
      rect,
      detail: typeof score === "number" ? score.toFixed(3) : undefined,
    });
    clsCount += 1;
  }

  // images
  let imgCount = 0;
  for (const auditId of IMAGE_OPPORTUNITY_AUDIT_IDS) {
    const items = Array.isArray(audits[auditId]?.details?.items) ? audits[auditId].details.items : [];
    for (const item of items) {
      const node = item?.node;
      const rect = resolveNodeRect(node, nodesMap);
      if (!isPositiveRect(rect)) continue;
      total += 1;
      if (imgCount >= MAX_IMAGE_ANNOTATIONS) continue;
      const wastedBytes = typeof item?.wastedBytes === "number" ? item.wastedBytes : undefined;
      const id = `img-${imgCount}`;
      annotations.push({
        id,
        kind: "image",
        label: nodeLabel(node, item?.url),
        rect,
        detail: typeof wastedBytes === "number" ? `${Math.round(wastedBytes / 1024)} KB` : undefined,
      });
      (imageAnnotationsByAuditId[auditId] ??= []).push(id);
      imgCount += 1;
    }
  }

  return { annotations, total };
}

/** Strip markdown links (`[text](url)` -> `text`) from Lighthouse audit descriptions. */
function stripMarkdownLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

/**
 * Largest per-metric saving Lighthouse attributes to an audit, in ms. Only the
 * time-based entries are considered — `metricSavings.CLS` is an unitless layout
 * shift delta and would be meaningless formatted as a duration.
 */
const TIME_METRIC_SAVINGS_KEYS = ["LCP", "FCP", "TBT", "INP", "SI"];

function metricSavingsMs(audit: any): number | undefined {
  const savings = audit?.metricSavings;
  if (!savings || typeof savings !== "object") return undefined;
  let max: number | undefined;
  for (const key of TIME_METRIC_SAVINGS_KEYS) {
    const value = savings[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    if (max === undefined || value > max) max = value;
  }
  return max;
}

/**
 * Lighthouse `valueType` → the cell kinds we can actually render. Anything not
 * listed (thumbnail, link objects, …) makes its column drop out entirely rather
 * than render as a guessed-at string.
 */
const CELL_TYPE_BY_VALUE_TYPE: Record<string, PageSpeedCellType> = {
  url: "url",
  text: "text",
  code: "code",
  "source-location": "text",
  bytes: "bytes",
  ms: "ms",
  timespanMs: "ms",
  numeric: "numeric",
  node: "node",
};

/** Heading shape differs across Lighthouse versions (key/valueType vs itemKey/itemType). */
function headingParts(h: any): { key: string; valueType: string; label: string; subKey?: string; subValueType?: string } | null {
  const key = typeof h?.key === "string" ? h.key : typeof h?.itemKey === "string" ? h.itemKey : "";
  const valueType =
    typeof h?.valueType === "string" ? h.valueType : typeof h?.itemType === "string" ? h.itemType : "";
  if (!key || !valueType) return null;
  const rawLabel = h?.label ?? h?.text;
  return {
    key,
    valueType,
    label: typeof rawLabel === "string" ? rawLabel : key,
    subKey: typeof h?.subItemsHeading?.key === "string" ? h.subItemsHeading.key : undefined,
    subValueType:
      typeof h?.subItemsHeading?.valueType === "string" ? h.subItemsHeading.valueType : undefined,
  };
}

function toCell(value: any, type: PageSpeedCellType, nodesMap: Record<string, RawNodeRect> | null): PageSpeedCell | null {
  if (value == null) return null;

  if (type === "node") {
    const label = nodeLabel(value);
    if (!label) return null;
    const rect = nodesMap ? resolveNodeRect(value, nodesMap) : null;
    const selector = typeof value?.selector === "string" ? value.selector : undefined;
    return { type, node: { label, ...(selector ? { selector } : {}), ...(isPositiveRect(rect) ? { rect } : {}) } };
  }

  if (type === "bytes" || type === "ms" || type === "numeric") {
    const num = typeof value === "number" ? value : Number(value);
    return Number.isFinite(num) ? { type, value: num } : null;
  }

  // `source-location` is an object; everything else arrives as a plain string.
  if (typeof value === "object") {
    const url = typeof value.url === "string" ? value.url : "";
    if (!url) return null;
    const line = typeof value.line === "number" ? `:${value.line}` : "";
    const column = typeof value.column === "number" ? `:${value.column}` : "";
    return { type: "text", text: truncate(`${url}${line}${column}`) };
  }

  const text = String(value).trim();
  return text ? { type, text: truncate(text) } : null;
}

function truncate(s: string): string {
  return s.length > MAX_CELL_LENGTH ? `${s.slice(0, MAX_CELL_LENGTH)}…` : s;
}

/**
 * Normalize a Lighthouse `details` table/opportunity into the flat contract the
 * UI renders. Driven by `headings` rather than per-audit special cases, so a
 * new Lighthouse diagnostic shows its data without a code change here.
 */
function extractTable(details: any, nodesMap: Record<string, RawNodeRect> | null): PageSpeedTable | undefined {
  const type = details?.type;
  if (type !== "table" && type !== "opportunity") return undefined;
  const rawHeadings = Array.isArray(details.headings) ? details.headings : [];
  const rawItems = Array.isArray(details.items) ? details.items : [];
  if (rawHeadings.length === 0 || rawItems.length === 0) return undefined;

  const headings = rawHeadings
    .map(headingParts)
    .filter((h: any): h is NonNullable<ReturnType<typeof headingParts>> => !!h)
    .filter((h: any) => !!CELL_TYPE_BY_VALUE_TYPE[h.valueType])
    .slice(0, MAX_TABLE_COLUMNS);
  if (headings.length === 0) return undefined;

  const buildRow = (item: any, keyOf: (h: any) => string | undefined, typeOf: (h: any) => string): PageSpeedTableRow | null => {
    const cells = headings.map((h: any) => {
      const key = keyOf(h);
      if (!key) return null;
      const cellType = CELL_TYPE_BY_VALUE_TYPE[typeOf(h)];
      if (!cellType) return null;
      return toCell(item?.[key], cellType, nodesMap);
    });
    return cells.some(Boolean) ? { cells } : null;
  };

  const rows: PageSpeedTableRow[] = [];
  // Items we looked at but could not render anything for. They are not "hidden
  // rows" — counting them would make the UI claim data it never had.
  let unrenderable = 0;
  for (const item of rawItems.slice(0, MAX_TABLE_ROWS)) {
    const row = buildRow(item, (h) => h.key, (h) => h.valueType);
    if (!row) {
      unrenderable += 1;
      continue;
    }
    const subItems = Array.isArray(item?.subItems?.items) ? item.subItems.items : [];
    const subRows = subItems
      .slice(0, MAX_SUB_ROWS)
      .map((sub: any) => buildRow(sub, (h) => h.subKey, (h) => h.subValueType ?? h.valueType))
      .filter((r: PageSpeedTableRow | null): r is PageSpeedTableRow => !!r);
    if (subRows.length > 0) row.subRows = subRows;
    rows.push(row);
  }
  if (rows.length === 0) return undefined;

  return {
    columns: headings.map((h: any) => ({ label: h.label, type: CELL_TYPE_BY_VALUE_TYPE[h.valueType] })),
    rows,
    rowTotal: rawItems.length - unrenderable,
  };
}

/** Metrics Lighthouse attributes this audit's savings to, e.g. ["LCP", "FCP"]. */
function metricLabels(audit: any): string[] | undefined {
  const savings = audit?.metricSavings;
  if (!savings || typeof savings !== "object") return undefined;
  const labels = Object.keys(savings).filter((k) => typeof savings[k] === "number");
  return labels.length > 0 ? labels : undefined;
}

/**
 * Returns the failing findings plus `total` = how many were found overall.
 * `total` still exists because audits stored while the display cap was 8 carry
 * a larger total than their own list, and the UI discloses that gap.
 */
function extractOpportunities(
  audits: Record<string, any>,
  imageAnnotationsByAuditId: Record<string, string[]>,
  nodesMap: Record<string, RawNodeRect> | null,
): { opportunities: PageSpeedOpportunity[]; total: number } {
  const opportunities: PageSpeedOpportunity[] = [];

  for (const [auditId, audit] of Object.entries(audits)) {
    if (auditId === "full-page-screenshot" || auditId === "final-screenshot") continue;

    const details: any = (audit as any)?.details;
    const isOpportunityType = details?.type === "opportunity";
    const hasMetricSavings = !!(audit as any)?.metricSavings;
    const isExtraDiagnostic = EXTRA_DIAGNOSTIC_AUDIT_IDS.includes(auditId);
    if (!isOpportunityType && !hasMetricSavings && !isExtraDiagnostic) continue;

    const score = typeof (audit as any)?.score === "number" ? (audit as any).score : null;
    const hasFindings = Array.isArray(details?.items) && details.items.length > 0;
    const failing = score === null ? hasFindings : score < 0.9;
    if (!failing) continue;

    const description = typeof (audit as any)?.description === "string" ? (audit as any).description : undefined;

    const displayValue = typeof (audit as any)?.displayValue === "string" ? (audit as any).displayValue : undefined;
    const labels = metricLabels(audit);
    const table = extractTable(details, nodesMap);

    opportunities.push({
      id: auditId,
      title: typeof (audit as any)?.title === "string" ? (audit as any).title : auditId,
      description: description ? stripMarkdownLinks(description) : undefined,
      savingsMs:
        typeof details?.overallSavingsMs === "number"
          ? details.overallSavingsMs
          : metricSavingsMs(audit),
      savingsBytes: typeof details?.overallSavingsBytes === "number" ? details.overallSavingsBytes : undefined,
      annotationIds: imageAnnotationsByAuditId[auditId] ?? [],
      ...(displayValue ? { displayValue } : {}),
      score,
      ...((audit as any)?.scoreDisplayMode === "informative" ? { informative: true } : {}),
      ...(labels ? { metricLabels: labels } : {}),
      ...(table ? { table } : {}),
    });
  }

  opportunities.sort((a, b) => {
    if (a.savingsMs === undefined && b.savingsMs === undefined) return 0;
    if (a.savingsMs === undefined) return 1;
    if (b.savingsMs === undefined) return -1;
    return b.savingsMs - a.savingsMs;
  });

  return { opportunities: opportunities.slice(0, MAX_OPPORTUNITIES), total: opportunities.length };
}

/** Audit ids that are never a "check" — they are the metrics and the screenshots. */
const NON_CHECK_AUDIT_IDS = new Set([
  ...Object.values(METRIC_AUDIT_IDS),
  "full-page-screenshot",
  "final-screenshot",
  "screenshot-thumbnails",
  "metrics",
]);

/**
 * Audits this page already passes. `notApplicable`/`manual`/`informative` are
 * excluded: Lighthouse did not actually verify anything there, so listing them
 * as passed would overstate the result.
 *
 * Scoped to the performance category's `auditRefs` when present: since the
 * request began asking for accessibility + best-practices too, `audits` holds
 * every category's checks, and the quality tabs list their own audits — passed
 * a11y/bp checks leaking into the speed tab's "passed" list would double-count
 * them. Responses without refs (stored single-category runs) keep the old
 * behavior, where every audit was a performance audit anyway.
 */
function extractPassedAudits(audits: Record<string, any>, categories?: any): PageSpeedPassedAudit[] {
  const refs = categories?.performance?.auditRefs;
  const performanceIds: Set<string> | null = Array.isArray(refs)
    ? new Set(refs.map((ref: any) => ref?.id).filter((id: any): id is string => typeof id === "string"))
    : null;

  const passed: PageSpeedPassedAudit[] = [];
  for (const [auditId, audit] of Object.entries(audits)) {
    if (NON_CHECK_AUDIT_IDS.has(auditId)) continue;
    if (performanceIds && !performanceIds.has(auditId)) continue;
    const mode = (audit as any)?.scoreDisplayMode;
    if (mode === "notApplicable" || mode === "manual" || mode === "informative") continue;
    const score = (audit as any)?.score;
    if (typeof score !== "number" || score < 0.9) continue;

    const displayValue = typeof (audit as any)?.displayValue === "string" ? (audit as any).displayValue : undefined;
    passed.push({
      id: auditId,
      title: typeof (audit as any)?.title === "string" ? (audit as any).title : auditId,
      ...(displayValue ? { displayValue } : {}),
    });
  }
  passed.sort((a, b) => a.title.localeCompare(b.title));
  return passed.slice(0, MAX_PASSED_AUDITS);
}

function toFieldMetric(m: any): PageSpeedFieldMetric | undefined {
  if (!m || typeof m.percentile !== "number" || typeof m.category !== "string") return undefined;
  // CrUX's histogram (good / needs-improvement / poor shares) drives the
  // segmented bar in the UI. `max` is absent on the open-ended poor bucket.
  const distributions = Array.isArray(m.distributions)
    ? m.distributions
        .filter((d: any) => typeof d?.min === "number" && typeof d?.proportion === "number")
        .map((d: any) => ({
          min: d.min,
          ...(typeof d.max === "number" ? { max: d.max } : {}),
          proportion: d.proportion,
        }))
    : undefined;
  return {
    percentile: m.percentile,
    category: m.category,
    ...(distributions && distributions.length > 0 ? { distributions } : {}),
  };
}

function extractFieldData(r: any): PageSpeedFieldData | null {
  const primary = r?.loadingExperience;
  const origin = r?.originLoadingExperience;

  let source = primary?.metrics ? primary : null;
  let originFallback = false;
  if (!source) {
    if (origin?.metrics) {
      source = origin;
      originFallback = true;
    }
  }
  if (primary?.origin_fallback) originFallback = true;

  const metrics = source?.metrics;
  if (!metrics) return null;

  const lcp = toFieldMetric(metrics.LARGEST_CONTENTFUL_PAINT_MS);
  const cls = toFieldMetric(metrics.CUMULATIVE_LAYOUT_SHIFT_SCORE);
  const inp = toFieldMetric(metrics.INTERACTION_TO_NEXT_PAINT);
  const fcp = toFieldMetric(metrics.FIRST_CONTENTFUL_PAINT_MS);
  // CrUX has shipped TTFB under both the experimental and the stable key.
  const ttfb = toFieldMetric(
    metrics.EXPERIMENTAL_TIME_TO_FIRST_BYTE ?? metrics.TIME_TO_FIRST_BYTE,
  );
  if (!lcp && !cls && !inp && !fcp && !ttfb) return null;

  const rawOverall = source?.overall_category;
  const overallCategory =
    rawOverall === "FAST" || rawOverall === "AVERAGE" || rawOverall === "SLOW" ? rawOverall : undefined;

  return { lcp, cls, inp, fcp, ttfb, overallCategory, originFallback };
}
