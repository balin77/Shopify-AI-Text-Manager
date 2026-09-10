/**
 * The website's videos, and where they come from.
 *
 * The SOURCE is deliberately one field per video so the hosting decision can
 * be made — and changed — in this file alone. Three states, and the third is
 * the one that lets the page ship before a single video exists:
 *
 *   { kind: "file"  }  a self-hosted MP4/WebM (Cloudflare R2, Stream, any CDN)
 *   { kind: "embed" }  YouTube or Vimeo, loaded only after a click
 *   null               not produced yet — the card renders as "recording"
 *
 * An embed is rendered as a FACADE: the poster and a play button are ours, and
 * nothing is requested from the provider until the visitor presses play. That
 * is not politeness, it is what keeps a page with an unplayed video free of
 * third-party cookies, and therefore free of a consent banner.
 *
 * The `id` is also the i18n key (`marketing.videos.items[id]`), so title and
 * description live with the rest of the copy in all three languages rather
 * than being duplicated here.
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

export interface MarketingVideo {
  /** Stable key; also the i18n lookup into `videos.items`. */
  id: "overview" | "bulk-editor" | "translations" | "seo" | "aeo";
  /** `null` until the video is produced. */
  source: MarketingVideoSource | null;
  /** Shown on the card when known, e.g. "4:12". Free text, not parsed. */
  duration?: string;
}

export const MARKETING_VIDEOS: MarketingVideo[] = [
  { id: "overview", source: null },
  { id: "bulk-editor", source: null },
  { id: "translations", source: null },
  { id: "seo", source: null },
  { id: "aeo", source: null },
];

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
