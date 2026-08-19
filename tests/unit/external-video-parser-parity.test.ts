import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseExternalVideoUrl } from "~/utils/mediaKind";

/**
 * ONE TypeScript parser and one Liquid snippet, held to one table.
 *
 * `mediaKind.parseExternalVideoUrl` is the parser that decides what ever gets
 * WRITTEN into `custom.variant_external_videos` / `variant_gallery_order`
 * (FilePickerModal, VariantImageManager), so the gallery audit reads back with
 * the same parser that wrote — a second TS copy was added here and removed
 * again, because that is the §3.3 bug (three copies, two of which had lost
 * `youtube.com/shorts/`) starting over.
 *
 * The snippet cannot be executed from vitest, so this file pins the two things
 * that can be checked from outside: the branch set, and the properties the
 * snippet's own docstring promises. The second one caught a live defect — see
 * "the snippet must not answer with half a parse" below.
 */

const snippet = readFileSync(
  join(__dirname, "../../extensions/storefront/snippets/cp-external-video.liquid"),
  "utf8",
);

const CASES: { url: string; host: string | null; id: string | null; why: string }[] = [
  { url: "https://www.youtube.com/watch?v=ABC12345678", host: "youtube", id: "ABC12345678", why: "watch" },
  { url: "https://youtu.be/ABC12345678", host: "youtube", id: "ABC12345678", why: "short link" },
  { url: "https://www.youtube.com/embed/ABC12345678", host: "youtube", id: "ABC12345678", why: "embed" },
  { url: "https://www.youtube.com/shorts/ABC12345678", host: "youtube", id: "ABC12345678", why: "shorts — the form the drifted copies dropped" },
  { url: "https://vimeo.com/123456789", host: "vimeo", id: "123456789", why: "vimeo" },
  { url: "https://player.vimeo.com/video/123456789", host: "vimeo", id: "123456789", why: "vimeo player" },
  { url: "https://youtu.be/ABC12345678?t=30", host: "youtube", id: "ABC12345678", why: "query after short link" },
  { url: "https://www.youtube.com/watch?v=ABC12345678&list=PL1", host: "youtube", id: "ABC12345678", why: "playlist param" },
  { url: "https://vimeo.com/123456789/abc123hash", host: "vimeo", id: "123456789", why: "vimeo privacy hash" },
  { url: "https://www.youtube.com/watch", host: null, id: null, why: "watch without v=" },
  { url: "https://example.com/video.mp4", host: null, id: null, why: "foreign host" },
  { url: "", host: null, id: null, why: "empty" },
  { url: "   ", host: null, id: null, why: "whitespace only" },
];

describe("parseExternalVideoUrl (the parser that also WRITES these metafields)", () => {
  for (const c of CASES) {
    it(`${c.why}: ${c.url || "(empty)"}`, () => {
      const got = parseExternalVideoUrl(c.url);
      if (c.host === null) expect(got).toBeNull();
      else expect(got).toMatchObject({ host: c.host, externalId: c.id });
    });
  }

  it("never answers with a host but no id", () => {
    // A half answer lets a caller build ".../embed/" and count the YouTube
    // front page as a video — which is exactly what the snippet used to do.
    for (const url of [
      "https://youtu.be/",
      "https://www.youtube.com/embed/",
      "https://www.youtube.com/shorts/",
      "https://vimeo.com/",
      "https://www.youtube.com/watch?v=",
    ]) {
      expect(parseExternalVideoUrl(url)).toBeNull();
    }
  });

  it("checks the HOST, not a substring of the URL", () => {
    // The substring-matching copy accepted both of these as YouTube videos.
    expect(parseExternalVideoUrl("https://notyoutube.com/watch?v=ABC12345678")).toBeNull();
    expect(parseExternalVideoUrl("https://evil.example/?u=https://youtu.be/ABC12345678")).toBeNull();
  });
});

describe("parity with snippets/cp-external-video.liquid", () => {
  it("handles exactly the URL forms the snippet branches on", () => {
    const branches = [
      "youtube.com/watch",
      "youtu.be/",
      "youtube.com/embed/",
      "youtube.com/shorts/",
      "vimeo.com/",
    ];
    for (const b of branches) expect(snippet).toContain(b);
    for (const b of branches) {
      expect(CASES.some((c) => c.url.includes(b) && c.host !== null)).toBe(true);
    }
  });

  it("uses the same two hosts and the same separator", () => {
    expect(snippet).toContain("assign cp_s_host = 'youtube'");
    expect(snippet).toContain("assign cp_s_host = 'vimeo'");
    expect(snippet).toContain("echo '|'");
  });

  it("the snippet must not answer with half a parse", () => {
    // Liquid's `split` is Ruby's, which DROPS trailing empty strings, so
    // `"https://youtu.be/" | split: 'youtu.be/' | last` is "https://" — and the
    // cut chain reduces that to "https:", a non-blank "id". The snippet then
    // printed `youtube|https:` and the block emitted
    // `"embedUrl": "https://www.youtube.com/embed/https:"`. The guard below is
    // what stops it; a video id can contain neither ":" nor ".".
    expect(snippet).toContain("if cp_s_id contains ':'");
    expect(snippet).toContain("if cp_s_id contains '.'");
  });
});
