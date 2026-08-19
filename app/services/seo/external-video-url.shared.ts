/**
 * Parse a YouTube/Vimeo watch URL into `{host, id}` — the TypeScript twin of
 * [snippets/cp-external-video.liquid](../../../extensions/storefront/snippets/cp-external-video.liquid).
 *
 * THE TWO MUST STAY IN STEP, and there is no way to share code between them:
 * Liquid runs on Shopify's storefront and cannot call this, and the audit runs
 * in Node and cannot call the snippet. That is the same drift risk the snippet
 * itself was created to end (the parser existed three times inside
 * variant-gallery-embed.liquid, and two of the copies had already diverged over
 * `youtube.com/shorts/` — a Shorts link was silently dropped). One deliberate
 * duplicate with a shared test table is the least bad answer; the table lives
 * in tests/unit/external-video-url.test.ts and enumerates every form the
 * snippet handles, so adding a form to one side without the other fails there.
 *
 * Never a half answer: a host without an id would let a caller build
 * `https://www.youtube.com/embed/` and count the YouTube front page as a video.
 *
 * Client-safe (no imports): the structured-data section renders the counts in
 * component scope.
 */

export type ExternalVideoHost = "youtube" | "vimeo";

export interface ExternalVideoRef {
  host: ExternalVideoHost;
  id: string;
}

/** Cut a tail at the first `?`, `/` or `#`, so a trailing query, path segment
 *  or fragment cannot end up inside the id — same three cuts as the snippet. */
function cutId(tail: string): string {
  return tail.split("?")[0].split("/")[0].split("#")[0];
}

export function parseExternalVideoUrl(raw: string | null | undefined): ExternalVideoRef | null {
  const url = (raw ?? "").trim();
  if (!url) return null;

  let host: ExternalVideoHost | null = null;
  let id = "";

  if (url.includes("youtube.com/watch") && url.includes("v=")) {
    host = "youtube";
    // The `v=` value ends at `&` or `#`, never at `/` — a video id may not
    // contain one, but a following path would be part of the query string.
    id = url.split("v=").pop()!.split("&")[0].split("#")[0];
  } else if (url.includes("youtu.be/")) {
    host = "youtube";
    id = cutId(url.split("youtu.be/").pop()!);
  } else if (url.includes("youtube.com/embed/")) {
    host = "youtube";
    id = cutId(url.split("youtube.com/embed/").pop()!);
  } else if (url.includes("youtube.com/shorts/")) {
    host = "youtube";
    id = cutId(url.split("youtube.com/shorts/").pop()!);
  } else if (url.includes("vimeo.com/")) {
    host = "vimeo";
    let tail = url.split("vimeo.com/").pop()!;
    // player.vimeo.com/video/<id> — the snippet strips the same segment.
    if (tail.includes("video/")) tail = tail.split("video/").pop()!;
    id = cutId(tail);
  }

  if (!host || !id) return null;
  return { host, id };
}

/**
 * The identity a product-wide dedup counts on — mirrors the `"<host>|<id>"`
 * seen-set the storefront block builds, so the audit counts exactly the videos
 * the block would emit rather than the URLs a merchant happened to paste.
 */
export function externalVideoKey(ref: ExternalVideoRef): string {
  return `${ref.host}|${ref.id}`;
}
