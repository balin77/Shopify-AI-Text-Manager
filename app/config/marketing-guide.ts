/**
 * The website's GUIDE (`/guide`, `/guide/<topic>`): which categories exist,
 * which topics sit in each, in which order — and each topic's video.
 *
 * Structure only. The words live in `app/i18n/marketing/guide/*.ts`, typed
 * against the ids declared here, so a topic added to this file fails typecheck
 * until every language has written it, and a topic written in one language
 * alone cannot exist.
 *
 * The topic id is also its URL slug, and the slug is the SAME in every
 * language (`/guide/glossary`, `/de/guide/glossary`) — the same rule the rest
 * of the site follows with `/features`. A translated slug would need a
 * per-locale route table and a redirect for every rename, for no gain on a
 * site with three languages.
 *
 * Import-free apart from a type: `marketing-locale.shared.ts` and the sitemap
 * read the topic list, and neither may pull a component into its graph.
 */

import type { MarketingVideoSource } from "./marketing-videos";

export const GUIDE_CATEGORIES = [
  {
    id: "getting-started",
    topics: ["setup", "ai-providers", "app-tour", "storefront-embeds", "tasks"],
  },
  {
    id: "ai-content",
    topics: ["content-editor", "ai-generate", "ai-instructions", "create-content"],
  },
  {
    id: "translations",
    topics: [
      "translating",
      "glossary",
      "markets",
      "source-changes",
      "translated-handles",
      "theme-content",
      "direct-translations",
      "menus",
      "metaobjects",
    ],
  },
  {
    id: "bulk",
    topics: ["bulk-editor", "bulk-csv", "bulk-translate"],
  },
  {
    id: "media",
    topics: ["image-manager", "image-bulk-upload", "alt-texts", "webp"],
  },
  {
    id: "seo",
    topics: [
      "keywords",
      "seo-score",
      "crawl",
      "performance",
      "search-console",
      "redirects",
      "internal-links",
      "sitemap-indexnow",
      "hreflang",
    ],
  },
  {
    id: "ai-visibility",
    topics: ["structured-data", "ai-discovery", "catalog-readiness"],
  },
  {
    id: "shop-data",
    topics: ["product-details", "collection-rules", "store-texts"],
  },
] as const;

export type GuideCategoryId = (typeof GUIDE_CATEGORIES)[number]["id"];
export type GuideTopicId = (typeof GUIDE_CATEGORIES)[number]["topics"][number];

/**
 * One video per topic, `null` until it is recorded. The page renders a
 * "video follows" frame in its place — same three source kinds as the
 * `/videos` page (`marketing-videos.ts`), and the same click-to-load facade
 * for an embed, so an unwatched guide page sets no third-party cookie.
 *
 * To publish a video, replace its `null`, e.g.
 *   "glossary": { kind: "embed", provider: "youtube", videoId: "abc123" },
 * and optionally add its length to GUIDE_VIDEO_DURATIONS.
 *
 * A `Record` over every id, so a new topic without an entry here fails
 * typecheck rather than rendering without a video slot.
 */
export const GUIDE_VIDEOS: Record<GuideTopicId, MarketingVideoSource | null> = {
  setup: null,
  "ai-providers": null,
  "app-tour": null,
  "storefront-embeds": null,
  tasks: null,
  "content-editor": null,
  "ai-generate": null,
  "ai-instructions": null,
  "create-content": null,
  translating: null,
  glossary: null,
  markets: null,
  "source-changes": null,
  "translated-handles": null,
  "theme-content": null,
  "direct-translations": null,
  menus: null,
  metaobjects: null,
  "bulk-editor": null,
  "bulk-csv": null,
  "bulk-translate": null,
  "image-manager": null,
  "image-bulk-upload": null,
  "alt-texts": null,
  webp: null,
  keywords: null,
  "seo-score": null,
  crawl: null,
  performance: null,
  "search-console": null,
  redirects: null,
  "internal-links": null,
  "sitemap-indexnow": null,
  hreflang: null,
  "structured-data": null,
  "ai-discovery": null,
  "catalog-readiness": null,
  "product-details": null,
  "collection-rules": null,
  "store-texts": null,
};

/** Free text shown beside a published video, e.g. "3:40". Optional per topic. */
export const GUIDE_VIDEO_DURATIONS: Partial<Record<GuideTopicId, string>> = {};

/** Every topic in reading order — the order prev/next walks. */
export const GUIDE_TOPIC_ORDER: GuideTopicId[] = GUIDE_CATEGORIES.flatMap(
  (category) => [...category.topics] as GuideTopicId[],
);

export function isGuideTopicId(value: string | undefined): value is GuideTopicId {
  return typeof value === "string" && (GUIDE_TOPIC_ORDER as string[]).includes(value);
}

export function guideCategoryOf(topic: GuideTopicId): GuideCategoryId {
  const category = GUIDE_CATEGORIES.find((c) => (c.topics as readonly string[]).includes(topic));
  // Unreachable for a typed id; the fallback keeps the signature total.
  return category ? category.id : GUIDE_CATEGORIES[0].id;
}

/** `/guide/<topic>` without a locale prefix. */
export function guideTopicPath(topic: GuideTopicId): string {
  return `/guide/${topic}`;
}
