import type {
  CompareGroupId,
  CompareRowId,
  CompetitorId,
  Support,
} from "../../../config/marketing-compare";

export type CompetitorCopy = {
  /** One line under the name: what kind of app this is. */
  kind: string;
  /** Meta description and lead of the `/compare/<app>` page. */
  summary: string;
  /** How the app works, in two or three sentences. */
  about: string;
  /** Where the other app is the better choice — said plainly. */
  strengths: string[];
  /** What ContentPilot adds on top. */
  ourEdge: string[];
  /** "Which one fits you" — the closing verdict. */
  verdict: string;
  /** How the other app charges, in words (prices move; the model does not). */
  pricing: string;
  /** Short explanation for a cell, keyed by row. Optional per row. */
  notes?: Partial<Record<CompareRowId, string>>;
};

export type CompareCopy = {
  title: string;
  intro: string;
  /** `{name}` is the competitor. */
  vsTitle: string;
  vsMetaTitle: string;
  tableHeading: string;
  featureColumn: string;
  support: Record<Support, string>;
  groups: Record<CompareGroupId, string>;
  rows: Record<CompareRowId, { label: string; help: string }>;
  /** Our own notes on a cell, keyed by row. */
  ourNotes: Partial<Record<CompareRowId, string>>;
  aboutHeading: string;
  strengthsHeading: string;
  ourEdgeHeading: string;
  verdictHeading: string;
  pricingHeading: string;
  ourPricing: string;
  /** Month the facts were last checked, written out ("September 2026"). */
  checkedAt: string;
  /** `{date}` is `checkedAt`. */
  disclaimer: string;
  correction: string;
  detailLink: string;
  otherComparisons: string;
  allComparisons: string;
  competitors: Record<CompetitorId, CompetitorCopy>;
};
