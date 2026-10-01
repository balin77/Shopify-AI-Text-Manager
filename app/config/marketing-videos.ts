/**
 * Where a website video comes from: the guide's topic pages carry one slot
 * each (`marketing-guide.ts`), every other page's slots are listed below.
 *
 *   { kind: "file"  }  a self-hosted MP4/WebM (Cloudflare R2, Stream, any CDN)
 *   { kind: "embed" }  YouTube or Vimeo, loaded only after a click
 *
 * An embed is rendered as a FACADE: the poster and a play button are ours, and
 * nothing is requested from the provider until the visitor presses play. That
 * is not politeness, it is what keeps a page with an unplayed video free of
 * third-party cookies, and therefore free of a consent banner.
 */
export type MarketingVideoSource =
  | {
      kind: "file";
      /** Absolute https URL. Several entries = several <source> types. */
      sources: Array<{ src: string; type: string }>;
      poster?: string;
    }
  | {
      kind: "embed";
      provider: "youtube" | "vimeo";
      /** The provider's video id, not a full URL. */
      videoId: string;
      poster?: string;
    };

/**
 * The website's video positions, named after the PLACE they appear in: one
 * beside the home page's hero, one per pillar of its scroll story, and one per
 * feature block on /features. (The guide's topic videos live in
 * `marketing-guide.ts`.) `null` until the video is recorded; the slot then
 * shows a "video follows" frame of the same size, so publishing one moves
 * nothing.
 *
 * To publish a video, replace its `null`, e.g.
 *   hero: { kind: "embed", provider: "youtube", videoId: "abc123" },
 */
export const SITE_VIDEO_SLOTS = [
  "hero",
  "pillar-writes",
  "pillar-translates",
  "pillar-found",
  "feature-ai",
  "feature-translations",
  "feature-bulk",
  "feature-seo",
  "feature-aeo",
  "feature-media",
  "feature-structure",
] as const;

export type SiteVideoSlot = (typeof SITE_VIDEO_SLOTS)[number];

export const SITE_VIDEOS: Record<SiteVideoSlot, MarketingVideoSource | null> = {
  hero: null,
  "pillar-writes": null,
  "pillar-translates": null,
  "pillar-found": null,
  "feature-ai": null,
  "feature-translations": null,
  "feature-bulk": null,
  "feature-seo": null,
  "feature-aeo": null,
  "feature-media": null,
  "feature-structure": null,
};

/**
 * The iframe URL for an embed, built only once the visitor has pressed play.
 *
 * YouTube's `-nocookie` host and Vimeo's `dnt=1` are the providers' own
 * do-not-track variants: they still load third-party code, but they do not
 * write a profiling cookie, which is the difference between "loads on click"
 * and "loads on click and then follows the visitor".
 */
export function embedUrl(source: Extract<MarketingVideoSource, { kind: "embed" }>): string {
  if (source.provider === "youtube") {
    return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(source.videoId)}?autoplay=1&rel=0`;
  }
  return `https://player.vimeo.com/video/${encodeURIComponent(source.videoId)}?autoplay=1&dnt=1`;
}
