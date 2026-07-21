/**
 * Real-user web-vitals (RUM) types — Phase 2 of the SEO Performance section.
 *
 * Contract between three parties:
 *  - the storefront beacon (extensions/storefront/assets/web-vitals.js) POSTs a
 *    WebVitalBeaconPayload to /apps/contentpilot/web-vitals (app proxy),
 *  - proxy.web-vitals.tsx validates + records it via web-vitals.service.ts,
 *  - app.seo.performance.tsx renders the WebVitalsSummary aggregate.
 *
 * Privacy: samples carry NO visitor identifiers — only page path, template,
 * device class, metric values and element labels.
 */

export type WebVitalDevice = "mobile" | "desktop";

/** Raw beacon body sent by the storefront script. All fields untrusted. */
export interface WebVitalBeaconPayload {
  /** location.pathname (no query), truncated server-side to 512 chars. */
  path: string;
  /** Liquid template name, e.g. "product", "collection", "index", "page". */
  template: string;
  device: WebVitalDevice;
  metrics: {
    lcpMs?: number;
    /** Unitless CLS value (session-window max). */
    cls?: number;
    inpMs?: number;
    fcpMs?: number;
    ttfbMs?: number;
  };
  /** Short selector/snippet of the element responsible per metric (≤120 chars). */
  elements?: {
    lcp?: string;
    cls?: string;
    inp?: string;
  };
}

/** One aggregate row: a (template, device) bucket over the window. */
export interface WebVitalsSummaryRow {
  template: string;
  device: WebVitalDevice;
  samples: number;
  /** 75th percentile; null when no samples carried the metric. */
  lcpP75Ms: number | null;
  clsP75: number | null;
  inpP75Ms: number | null;
}

/** A slow page: p75 LCP per exact path, worst first. */
export interface WebVitalsSlowPath {
  path: string;
  samples: number;
  lcpP75Ms: number;
}

/** Most frequent metric-causing elements across the window. */
export interface WebVitalsElementIssue {
  kind: "lcp" | "cls" | "inp";
  label: string;
  occurrences: number;
}

export interface WebVitalsSummary {
  /** Aggregation window in days (default 28). */
  windowDays: number;
  totalSamples: number;
  rows: WebVitalsSummaryRow[];
  slowPaths: WebVitalsSlowPath[];
  elements: WebVitalsElementIssue[];
}
