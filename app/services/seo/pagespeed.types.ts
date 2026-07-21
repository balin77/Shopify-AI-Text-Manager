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

/** One Lighthouse opportunity/diagnostic worth showing to the merchant. */
export interface PageSpeedOpportunity {
  /** Lighthouse audit id, e.g. "render-blocking-resources". */
  id: string;
  title: string;
  description?: string;
  savingsMs?: number;
  savingsBytes?: number;
  /** Annotations (screenshot boxes) belonging to this finding; may be empty. */
  annotationIds: string[];
}

export type CruxCategory = "FAST" | "AVERAGE" | "SLOW";

export interface PageSpeedFieldMetric {
  /** 75th-percentile value (ms; CLS is value*100 per CrUX convention). */
  percentile: number;
  category: CruxCategory;
}

/** Real-user (CrUX) data; null when Google has no field data for the URL. */
export interface PageSpeedFieldData {
  lcp?: PageSpeedFieldMetric;
  cls?: PageSpeedFieldMetric;
  inp?: PageSpeedFieldMetric;
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
  annotations: PageSpeedAnnotation[];
  opportunities: PageSpeedOpportunity[];
  fieldData: PageSpeedFieldData | null;
  /** True when this result is a stored older audit served because a fresh PSI run couldn't be made (e.g. Google's daily quota was exhausted). */
  stale?: boolean;
}

/** Lightweight history row (no heavy result JSON) for the trend list. */
export interface PageSpeedHistoryEntry {
  id: string;
  url: string;
  strategy: PageSpeedStrategy;
  performanceScore: number | null;
  createdAt: string;
}
