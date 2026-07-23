/**
 * PageSpeed audit types — the contract between pagespeed.service.ts (server,
 * PSI API + Prisma cache) and app.seo.performance.tsx (UI).
 *
 * Coordinates: annotation rects are in the natural pixel space of the
 * full-page screenshot returned by Lighthouse's `full-page-screenshot` audit,
 * so the client can overlay boxes by scaling rect/naturalSize to the rendered
 * image size. When only the viewport `final-screenshot` is available there are
 * no annotations (rects would not align).
 */

export type PageSpeedStrategy = "mobile" | "desktop";

export type PageSpeedMetricId = "lcp" | "cls" | "tbt" | "fcp" | "si";

export interface PageSpeedMetric {
  id: PageSpeedMetricId;
  /** Lighthouse displayValue, e.g. "1,2 s" / "0.03". */
  displayValue: string;
  numericValue: number;
  /** Lighthouse 0..1 score for the metric, null when not scored. */
  score: number | null;
}

export interface PageSpeedRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type PageSpeedAnnotationKind = "lcp" | "cls" | "image" | "other";

/** One highlightable element on the screenshot, color-matched in the findings list. */
export interface PageSpeedAnnotation {
  /** Stable within one result; opportunities reference it via annotationIds. */
  id: string;
  kind: PageSpeedAnnotationKind;
  /** Human-readable element label (selector or snippet, truncated). */
  label: string;
  rect: PageSpeedRect;
  /** Extra finding context, e.g. "412 KB sparbar" or shift score. */
  detail?: string;
}

/**
 * Cell kinds we render from a Lighthouse `details` table. Lighthouse's own
 * `valueType` vocabulary is larger; anything we can't render (thumbnails,
 * link objects, …) is dropped in the parser rather than guessed at.
 */
export type PageSpeedCellType = "text" | "url" | "code" | "bytes" | "ms" | "numeric" | "node";

/** A DOM element a table row points at — carries the rect for a screenshot crop. */
export interface PageSpeedNodeRef {
  /** Snippet / nodeLabel, truncated. */
  label: string;
  selector?: string;
  /**
   * Rect in full-page-screenshot pixel space. Present only when Lighthouse
   * delivered the full-page screenshot's nodes map — that's what makes the
   * element thumbnails in the findings list possible.
   */
  rect?: PageSpeedRect;
}

export interface PageSpeedCell {
  type: PageSpeedCellType;
  /** Display text for text/url/code cells. */
  text?: string;
  /** Raw number for bytes/ms/numeric cells — formatted locale-aware in the UI. */
  value?: number;
  node?: PageSpeedNodeRef;
}

export interface PageSpeedTableRow {
  /** Aligned 1:1 with `PageSpeedTable.columns`; null = no value in that column. */
  cells: (PageSpeedCell | null)[];
  /** Lighthouse `subItems`, rendered indented under the row. */
  subRows?: PageSpeedTableRow[];
}

/** Normalized Lighthouse `details` table shown inside an expanded finding. */
export interface PageSpeedTable {
  columns: { label: string; type: PageSpeedCellType }[];
  rows: PageSpeedTableRow[];
  /** Rows before the cap, so the UI can disclose the truncation. */
  rowTotal: number;
}

/** One Lighthouse opportunity/diagnostic worth showing to the merchant. */
export interface PageSpeedOpportunity {
  /** Lighthouse audit id, e.g. "render-blocking-resources". */
  id: string;
  title: string;
  description?: string;
  /**
   * Estimated savings in ms. Opportunity-type audits carry this in
   * `details.overallSavingsMs`; table-type diagnostics (e.g.
   * `server-response-time`) only carry per-metric `metricSavings`, from which
   * the largest entry is used instead — otherwise those findings would render
   * with no impact figure at all.
   */
  savingsMs?: number;
  savingsBytes?: number;
  /** Annotations (screenshot boxes) belonging to this finding; may be empty. */
  annotationIds: string[];
  /** Lighthouse `displayValue`, e.g. "Potential savings of 150 ms". */
  displayValue?: string;
  /** Lighthouse 0..1 audit score; null for informative audits. Drives the row's tone marker. */
  score?: number | null;
  /** `scoreDisplayMode === "informative"` — Lighthouse reports it but does not score it. */
  informative?: boolean;
  /** Metrics the savings are attributed to (`metricSavings` keys), e.g. ["LCP", "FCP"]. */
  metricLabels?: string[];
  /** The audit's `details` table, normalized for rendering. */
  table?: PageSpeedTable;
}

/**
 * A Lighthouse audit this page already passes. Kept title-only (no details
 * table): there are typically 20-30 of them and they exist to confirm what is
 * fine, not to be worked through.
 */
export interface PageSpeedPassedAudit {
  id: string;
  title: string;
  /** Lighthouse `displayValue`, e.g. "0 Ressourcen" — often absent. */
  displayValue?: string;
}

/**
 * One accessibility / best-practices finding (or manual check) from the
 * Lighthouse quality categories. Mirrors the spirit of PageSpeedOpportunity
 * but stays deliberately smaller: no savings, no annotation links, and a flat
 * element list instead of the normalized details table.
 */
export interface QualityIssue {
  /** Lighthouse audit id, e.g. "color-contrast". */
  id: string;
  title: string;
  /** Markdown links stripped (stripMarkdownLinks reused). */
  description?: string;
  /** 0 = failed, 1 = passed, null = not scorable. NEVER smooth null to 0. */
  score: number | null;
  /**
   * Lighthouse group heading this audit belongs to, already resolved to its
   * localized title (e.g. "Vertrauen und Sicherheit", "Browserkompatibilität")
   * from `categoryGroups`. Absent when the audit ref carries no group.
   */
  group?: string;
  /**
   * Raw Lighthouse group id (e.g. "best-practices-trust-safety") — kept
   * alongside the localized `group` title so the UI can order the group
   * sections deterministically without matching on translated strings.
   */
  groupId?: string;
  /** Affected elements, capped. */
  items: Array<{ selector?: string; snippet?: string; url?: string }>;
  /** Number of affected elements BEFORE the cap. */
  itemTotal: number;
  /**
   * The audit's full `details` table, normalized like a performance
   * opportunity's — carries the richer columns (source location, console error
   * text, CSP directive, …) that the flat `items` list cannot represent.
   * Absent when the audit has no renderable table. No screenshot node rects:
   * quality findings are parsed with nodesMap=null.
   */
  table?: PageSpeedTable;
  /** scoreDisplayMode "manual" — not automatically checked by Lighthouse. */
  manual: boolean;
}

/**
 * Accessibility + best-practices outcome of a run. Absent on audits stored
 * before the quality categories were requested — the UI shows an explicit
 * "re-run the test" empty state then (accessibility plan §3.8).
 */
export interface QualityResult {
  a11yScore: number | null;
  bestPracticesScore: number | null;
  /** Findings (failing) AND manual audits (manual: true). */
  accessibility: QualityIssue[];
  bestPractices: QualityIssue[];
  /** Findings before the cap (manual audits not counted). */
  accessibilityTotal: number;
  bestPracticesTotal: number;
  /**
   * Audits this page already passes, per category — the same "Passed checks"
   * list the performance tab shows, title-only. Absent on runs stored before
   * this was captured; legacy audits then simply show no passed list.
   */
  accessibilityPassed?: PageSpeedPassedAudit[];
  bestPracticesPassed?: PageSpeedPassedAudit[];
  /**
   * Informative / advisory audits (score null, no pass-fail verdict) — the
   * gray-circle entries PSI groups under "Trust and Safety" /
   * "Browser Compatibility" etc. (CSP, HSTS, clickjacking, third-party
   * cookies …). Carry a title, description, optional table and group, but no
   * score. Absent on legacy runs.
   */
  accessibilityAdvisory?: QualityIssue[];
  bestPracticesAdvisory?: QualityIssue[];
  /**
   * Audits that did not apply to this page (scoreDisplayMode notApplicable) —
   * PSI's "Not applicable" list, title-only. Absent on legacy runs.
   */
  accessibilityNotApplicable?: PageSpeedPassedAudit[];
  bestPracticesNotApplicable?: PageSpeedPassedAudit[];
}

export type CruxCategory = "FAST" | "AVERAGE" | "SLOW";

/** One CrUX histogram bucket (good / needs-improvement / poor). */
export interface PageSpeedFieldBucket {
  min: number;
  /** Absent on the open-ended "poor" bucket. */
  max?: number;
  /** Share of real users in this bucket, 0..1. */
  proportion: number;
}

export interface PageSpeedFieldMetric {
  /** 75th-percentile value (ms; CLS is value*100 per CrUX convention). */
  percentile: number;
  category: CruxCategory;
  /**
   * CrUX's three-bucket user distribution, used to draw PSI's segmented bar.
   * Optional because audits stored before this field existed have no buckets —
   * the UI falls back to fixed threshold bands then.
   */
  distributions?: PageSpeedFieldBucket[];
}

/** Real-user (CrUX) data; null when Google has no field data for the URL. */
export interface PageSpeedFieldData {
  lcp?: PageSpeedFieldMetric;
  cls?: PageSpeedFieldMetric;
  inp?: PageSpeedFieldMetric;
  fcp?: PageSpeedFieldMetric;
  /** Time to first byte (CrUX `EXPERIMENTAL_TIME_TO_FIRST_BYTE`). */
  ttfb?: PageSpeedFieldMetric;
  /**
   * CrUX's aggregate verdict (`loadingExperience.overall_category`) — the
   * "passed / did not pass the Core Web Vitals assessment" line PSI shows
   * above the field metrics.
   */
  overallCategory?: CruxCategory;
  /** True when metrics are origin-wide (URL itself had too little traffic). */
  originFallback: boolean;
}

export interface PageSpeedScreenshot {
  /** data: URL (jpeg/webp base64). */
  data: string;
  width: number;
  height: number;
  /** True when this is the full-page screenshot (annotations align only then). */
  fullPage: boolean;
}

export interface PageSpeedAuditResult {
  url: string;
  strategy: PageSpeedStrategy;
  /** ISO timestamp of the PSI run (serves as cache age indicator). */
  fetchedAt: string;
  /** Lighthouse performance score 0-100, null when Lighthouse could not score. */
  performanceScore: number | null;
  metrics: PageSpeedMetric[];
  screenshot: PageSpeedScreenshot | null;
  /**
   * Lighthouse's viewport `final-screenshot` — what the page looked like above
   * the fold. Shown as the preview next to the score gauge, because `screenshot`
   * is the full-page capture (needed for element crops) and would only show a
   * top slice there. Absent when Lighthouse produced no viewport shot, or when
   * `screenshot` already IS the viewport fallback.
   */
  previewScreenshot?: PageSpeedScreenshot;
  annotations: PageSpeedAnnotation[];
  opportunities: PageSpeedOpportunity[];
  /** Audits that passed — shown as their own "passed checks" group. */
  passedAudits?: PageSpeedPassedAudit[];
  fieldData: PageSpeedFieldData | null;
  /**
   * URL Lighthouse actually measured (`finalDisplayedUrl`), set only when it
   * differs from the requested `url` — i.e. the page redirected. Without it the
   * UI would report a score for a page the merchant did not ask about.
   */
  finalUrl?: string;
  /**
   * `lighthouseResult.runtimeError.message` when Lighthouse could not analyse
   * the page at all (failed navigation, no FCP, timeout). PSI still answers
   * HTTP 200 in that case, so without this the run renders as an empty result
   * with a "–" score and no explanation.
   */
  runtimeError?: string;
  /** `lighthouseResult.runWarnings` — caveats about the run itself. */
  runWarnings?: string[];
  /** Findings before the `MAX_OPPORTUNITIES` cap, so the UI can say how many are hidden. */
  opportunityTotal?: number;
  /** Annotations before the per-kind caps, likewise. */
  annotationTotal?: number;
  /** True when this result is a stored older audit served because a fresh PSI run couldn't be made (e.g. Google's daily quota was exhausted). */
  stale?: boolean;
  /**
   * Why `stale` was set — `"quota"` = Google refused the run (429),
   * `"dailyLimit"` = our own per-shop daily budget is used up. Set when the
   * stored audit is served, never persisted, because the reason belongs to the
   * failed attempt and not to the stored run.
   */
  staleReason?: "quota" | "dailyLimit";
  /**
   * Reason Lighthouse could not produce the annotatable full-page screenshot,
   * lifted from the raw PSI response (audit `errorMessage`, `runtimeError`,
   * or first relevant `runWarnings` entry). Only set when `screenshot?.fullPage`
   * is false. Empty string when the fallback fired but no reason was reported.
   */
  screenshotUnavailableReason?: string;
  /**
   * Accessibility + best-practices categories of the same run. Optional so
   * audits stored before these categories were requested stay type-conformant
   * (they trigger the legacy empty state instead).
   */
  quality?: QualityResult;
}

/** Lightweight history row (no heavy result JSON) for the trend list. */
export interface PageSpeedHistoryEntry {
  id: string;
  url: string;
  strategy: PageSpeedStrategy;
  performanceScore: number | null;
  /** Lighthouse accessibility score 0-100; null on rows stored before the quality columns existed. */
  a11yScore: number | null;
  /** Lighthouse best-practices score 0-100; null on rows stored before the quality columns existed. */
  bestPracticesScore: number | null;
  createdAt: string;
}
