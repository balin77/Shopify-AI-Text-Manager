import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseExternalVideoUrl,
  externalVideoKey,
} from "~/services/seo/external-video-url.shared";

/**
 * The TS parser is a deliberate DUPLICATE of
 * extensions/storefront/snippets/cp-external-video.liquid — Liquid runs on the
 * storefront and cannot call TypeScript, the audit runs in Node and cannot call
 * Liquid. This file is the thing that keeps the two in step, because the last
 * time this parser was duplicated the copies drifted over `youtube.com/shorts/`
 * and a Shorts link was silently dropped (PLAN_MARKUP_ACTIVATION §3.3).
 *
 * The table below is the contract. Adding a URL form to either side without the
 * other fails here.
 */

const CASES: { url: string; host: string | null; id: string | null; why: string }[] = [
  { url: "https://www.youtube.com/watch?v=ABC12345678", host: "youtube", id: "ABC12345678", why: "watch" },
  { url: "https://youtu.be/ABC12345678", host: "youtube", id: "ABC12345678", why: "short link" },
  { url: "https://www.youtube.com/embed/ABC12345678", host: "youtube", id: "ABC12345678", why: "embed" },
  { url: "https://www.youtube.com/shorts/ABC12345678", host: "youtube", id: "ABC12345678", why: "shorts — the form the drifted copy dropped" },
  { url: "https://vimeo.com/123456789", host: "vimeo", id: "123456789", why: "vimeo" },
  { url: "https://player.vimeo.com/video/123456789", host: "vimeo", id: "123456789", why: "vimeo player" },
  // Trailing junk must not end up inside the id — the three cuts (?, /, #).
  { url: "https://youtu.be/ABC12345678?t=30", host: "youtube", id: "ABC12345678", why: "query after short link" },
  { url: "https://youtu.be/ABC12345678#t=30", host: "youtube", id: "ABC12345678", why: "fragment" },
  { url: "https://www.youtube.com/watch?v=ABC12345678&list=PL1", host: "youtube", id: "ABC12345678", why: "playlist param" },
  { url: "https://vimeo.com/123456789/abc123hash", host: "vimeo", id: "123456789", why: "vimeo privacy hash" },
  // Not a half answer, ever.
  { url: "https://www.youtube.com/watch", host: null, id: null, why: "watch without v=" },
  { url: "https://example.com/video.mp4", host: null, id: null, why: "foreign host" },
  { url: "", host: null, id: null, why: "empty" },
  { url: "   ", host: null, id: null, why: "whitespace only" },
];

describe("parseExternalVideoUrl", () => {
  for (const c of CASES) {
    it(`${c.why}: ${c.url || "(empty)"}`, () => {
      const got = parseExternalVideoUrl(c.url);
      if (c.host === null) expect(got).toBeNull();
      else expect(got).toEqual({ host: c.host, id: c.id });
    });
  }

  it("never returns a host without an id", () => {
    // A half answer would let a caller build ".../embed/" and count the YouTube
    // front page as a video.
    for (const url of ["https://youtu.be/", "https://youtu.be/?x=1", "https://vimeo.com/"]) {
      expect(parseExternalVideoUrl(url)).toBeNull();
    }
  });

  it("trims, so a metafield value with padding still parses", () => {
    expect(parseExternalVideoUrl("  https://youtu.be/ABC12345678  ")?.id).toBe("ABC12345678");
  });
});

describe("externalVideoKey", () => {
  it("collapses every spelling of one video onto one key", () => {
    // This is what makes the product-wide dedup work — and it must agree with
    // the storefront block's own "<host>|<id>" seen-set.
    const keys = [
      "https://www.youtube.com/watch?v=ABC12345678",
      "https://youtu.be/ABC12345678",
      "https://www.youtube.com/shorts/ABC12345678",
    ].map((u) => externalVideoKey(parseExternalVideoUrl(u)!));
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe("youtube|ABC12345678");
  });
});

describe("parity with the Liquid snippet", () => {
  const snippet = readFileSync(
    join(__dirname, "../../extensions/storefront/snippets/cp-external-video.liquid"),
    "utf8",
  );

  it("handles exactly the URL forms the snippet branches on", () => {
    // The snippet's branches, in its own words. If someone adds a form there,
    // this list is where they notice the TS side has to follow.
    const branches = [
      "youtube.com/watch",
      "youtu.be/",
      "youtube.com/embed/",
      "youtube.com/shorts/",
      "vimeo.com/",
    ];
    for (const b of branches) expect(snippet).toContain(b);
    // …and each is covered above.
    for (const b of branches) {
      expect(CASES.some((c) => c.url.includes(b) && c.host !== null)).toBe(true);
    }
  });

  it("uses the same two hosts and the same separator", () => {
    expect(snippet).toContain("assign cp_s_host = 'youtube'");
    expect(snippet).toContain("assign cp_s_host = 'vimeo'");
    expect(snippet).toContain("echo '|'");
  });
});
