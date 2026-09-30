import type { GuideCategoryId, GuideTopicId } from "../../../config/marketing-guide";

/**
 * The shape of the guide's copy. One file per language, each typed against
 * this — and both maps are `Record`s over the ids in marketing-guide.ts, so a
 * topic added there fails typecheck here until it is written in every language.
 */

export interface GuideSection {
  heading: string;
  /** Rendered as separate paragraphs, in order. */
  paragraphs: string[];
  /** Optional bullet list under the paragraphs. */
  list?: string[];
  /** Optional numbered steps under the paragraphs — for "how do I…" parts. */
  steps?: string[];
}

export interface GuideTopicCopy {
  title: string;
  /** One or two sentences: the index card and the page's meta description. */
  summary: string;
  sections: GuideSection[];
  /** Short practical hints, shown in their own box at the end. */
  tips?: string[];
}

export interface GuideCategoryCopy {
  title: string;
  intro: string;
}

export interface GuideCopy {
  categories: Record<GuideCategoryId, GuideCategoryCopy>;
  topics: Record<GuideTopicId, GuideTopicCopy>;
}
