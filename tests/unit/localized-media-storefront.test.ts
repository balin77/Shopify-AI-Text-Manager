/**
 * The storefront half of "images and videos per language"
 * (extensions/storefront/assets/localized-media.js), run in a DOM against
 * markup shaped like a theme's: an <img> gallery, a native <video>, a
 * YouTube iframe and a player still inside a <template> (Dawn's deferred
 * media). What is pinned is what a visitor sees: the right replacement for
 * their language/market, nothing for anyone else, and no observer loop.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SCRIPT = readFileSync(resolve(__dirname, "../../extensions/storefront/assets/localized-media.js"), "utf8");
const VKEY = "abcdef0123456789";
const VKEY2 = "fedcba9876543210";

function setup(body: string, island: unknown) {
  document.head.innerHTML =
    `<style id="cp-lm-prehide">img{visibility:hidden}</style>` +
    `<script type="application/json" id="cp-lm-data">${JSON.stringify(island)}</script>`;
  document.body.innerHTML = body;
  // eslint-disable-next-line no-new-func
  new Function(SCRIPT)();
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

describe("localized-media.js", () => {
  it("swaps an image for the visitor's language and carries the requested width", () => {
    setup(`<img id="a" src="//shop.example/cdn/shop/files/shirt.jpg?v=1&width=800">`, {
      l: "fr", k: "42",
      e: [{ o: "shirt.jpg", l: "fr", k: "", u: "https://cdn.shopify.com/s/files/1/files/shirt-fr.jpg?v=2" }],
    });
    const img = document.getElementById("a")!;
    expect(img.getAttribute("src")).toContain("shirt-fr.jpg");
    expect(img.getAttribute("src")).toContain("width=800");
    expect(img.hasAttribute("data-cp-lm")).toBe(true);
  });

  it("prefers this market's entry and ignores other languages", () => {
    setup(`<img id="a" src="https://cdn.shopify.com/s/files/1/files/shirt.jpg">`, {
      l: "fr", k: "42",
      e: [
        { o: "shirt.jpg", l: "fr", k: "", u: "https://cdn.shopify.com/s/files/1/files/all.jpg" },
        { o: "shirt.jpg", l: "fr", k: "42", u: "https://cdn.shopify.com/s/files/1/files/ch.jpg" },
        { o: "shirt.jpg", l: "de", k: "", u: "https://cdn.shopify.com/s/files/1/files/de.jpg" },
      ],
    });
    expect(document.getElementById("a")!.getAttribute("src")).toContain("ch.jpg");
  });

  it("does not loop on a map that swaps two originals for each other", async () => {
    setup(`<img id="a" src="https://cdn.shopify.com/s/files/1/files/a.jpg">`, {
      l: "fr", k: "",
      e: [
        { o: "a.jpg", l: "fr", k: "", u: "https://cdn.shopify.com/s/files/1/files/b.jpg" },
        { o: "b.jpg", l: "fr", k: "", u: "https://cdn.shopify.com/s/files/1/files/a.jpg" },
      ],
    });
    await flush();
    await flush();
    expect(document.getElementById("a")!.getAttribute("src")).toContain("b.jpg");
  });

  it("replaces a native video's sources and its poster", () => {
    setup(
      `<video id="v" poster="//shop.example/cdn/shop/files/preview_images/old.jpg?v=1">` +
        `<source src="//shop.example/cdn/shop/videos/c/vp/${VKEY}/${VKEY}.HD-1080p-7.2Mbps.mp4" type="video/mp4"></video>`,
      {
        l: "fr", k: "",
        e: [{
          o: VKEY, l: "fr", k: "", x: "v", p: "old.jpg",
          u: "https://cdn.shopify.com/s/files/1/files/preview_images/new.jpg",
          w: [{ u: `https://cdn.shopify.com/videos/c/vp/${VKEY2}/${VKEY2}.HD-720p.mp4`, t: "video/mp4" }],
        }],
      },
    );
    const video = document.getElementById("v")!;
    const sources = video.querySelectorAll("source");
    expect(sources).toHaveLength(1);
    expect(sources[0].getAttribute("src")).toContain(VKEY2);
    expect(video.getAttribute("poster")).toContain("new.jpg");
  });

  it("rewrites a YouTube player inside a <template> before it is inserted, keeping the theme's query", () => {
    setup(
      `<template id="t"><iframe src="https://www.youtube.com/embed/AAAAAAAAAAA?autoplay=1&rel=0"></iframe></template>`,
      {
        l: "fr", k: "",
        e: [{ o: "youtube.AAAAAAAAAAA", l: "fr", k: "", x: "e", p: "", u: "", r: "https://player.vimeo.com/video/123456789" }],
      },
    );
    const frame = (document.getElementById("t") as HTMLTemplateElement).content.querySelector("iframe")!;
    expect(frame.getAttribute("src")).toBe("https://player.vimeo.com/video/123456789?autoplay=1&rel=0");
  });

  it("points the theme's playlist (Dawn's loop) at the replacement, not the original", () => {
    setup(
      `<iframe id="f" src="https://www.youtube.com/embed/AAAAAAAAAAA?autoplay=1&loop=1&playlist=AAAAAAAAAAA"></iframe>`,
      { l: "fr", k: "", e: [{ o: "youtube.AAAAAAAAAAA", l: "fr", k: "", x: "e", p: "", u: "", r: "https://www.youtube.com/embed/BBBBBBBBBBB" }] },
    );
    const src = document.getElementById("f")!.getAttribute("src")!;
    expect(src).toContain("/embed/BBBBBBBBBBB");
    expect(src).toContain("playlist=BBBBBBBBBBB");
    expect(src).not.toContain("AAAAAAAAAAA");
  });

  it("keeps the privacy-enhanced YouTube host", () => {
    setup(
      `<iframe id="f" src="https://www.youtube-nocookie.com/embed/AAAAAAAAAAA"></iframe>`,
      { l: "fr", k: "", e: [{ o: "youtube.AAAAAAAAAAA", l: "fr", k: "", x: "e", p: "", u: "", r: "https://www.youtube.com/embed/BBBBBBBBBBB" }] },
    );
    expect(document.getElementById("f")!.getAttribute("src")).toBe("https://www.youtube-nocookie.com/embed/BBBBBBBBBBB");
  });

  it("never writes a hand-edited embed address that is not a player", () => {
    setup(
      `<iframe id="f" src="https://www.youtube.com/embed/AAAAAAAAAAA"></iframe>`,
      { l: "fr", k: "", e: [{ o: "youtube.AAAAAAAAAAA", l: "fr", k: "", x: "e", p: "", u: "", r: "javascript:alert(1)" }] },
    );
    expect(document.getElementById("f")!.getAttribute("src")).toBe("https://www.youtube.com/embed/AAAAAAAAAAA");
  });

  it("leaves another app's image with the same filename alone", () => {
    setup(`<img id="a" src="https://images.other-cdn.example/shirt.jpg">`, {
      l: "fr", k: "",
      e: [{ o: "shirt.jpg", l: "fr", k: "", u: "https://cdn.shopify.com/s/files/1/files/shirt-fr.jpg" }],
    });
    expect(document.getElementById("a")!.getAttribute("src")).toBe("https://images.other-cdn.example/shirt.jpg");
  });
});
