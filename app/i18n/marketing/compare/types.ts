import type {
  CompareGroupId,
  PriceAppId,
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
  /** Under the table: it answers "can the app do this at all", never "on which plan". */
  tableNote: string;
  pricing: {
    heading: string;
    intro: string;
    perMonth: string;
    free: string;
    /** Currency, tax, annual discounts, AI costs — one sentence. */
    note: string;
    /** One line per app under its name, e.g. "priced by languages and words". */
    summaries: Record<PriceAppId, string>;
    /** What each plan includes, keyed by the plan ids in `COMPARE_PRICES`. */
    plans: Record<PriceAppId, Record<string, string>>;
  };
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
