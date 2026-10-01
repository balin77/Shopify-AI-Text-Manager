/**
 * The one gate between the shop's setting and an image reaching a provider.
 *
 * Worth its own test because every AI path now goes through it and because the
 * expensive direction is asymmetric: refusing an image the merchant paid for is
 * a missing sentence in a description, while sending one they switched off is a
 * bill they did not agree to.
 */

import { describe, it, expect } from "vitest";
import {
  AI_IMAGES_PER_REQUEST_MAX,
  aiImageCandidates,
  clampImagesPerRequest,
  readImageCandidates,
  resolveVisionPolicy,
  visionImageUrls,
} from "~/services/ai/vision-policy.shared";

const ON = { sendImages: true, maxImages: 3 };

describe("resolveVisionPolicy", () => {
  it("treats a shop with no settings row as OFF", () => {
    expect(resolveVisionPolicy(null)).toEqual({ sendImages: false, maxImages: 1 });
  });

  it("reads the stored answer", () => {
    expect(resolveVisionPolicy({ sendImagesToAI: true, aiImagesPerRequest: 3 })).toEqual({
      sendImages: true,
      maxImages: 3,
    });
  });

  it("never reads a missing flag as a yes", () => {
    expect(resolveVisionPolicy({ aiImagesPerRequest: 5 }).sendImages).toBe(false);
  });
});

describe("clampImagesPerRequest", () => {
  it("falls back to ONE, never to the maximum, for an unusable value", () => {
    for (const value of [undefined, null, NaN, 0, -4]) {
      expect(clampImagesPerRequest(value as number)).toBe(1);
    }
  });

  it("caps at the ceiling", () => {
    expect(clampImagesPerRequest(500)).toBe(AI_IMAGES_PER_REQUEST_MAX);
  });

  it("floors a fractional value rather than rounding up", () => {
    expect(clampImagesPerRequest(2.9)).toBe(2);
  });
});

describe("visionImageUrls", () => {
  it("sends nothing at all while the switch is off", () => {
    expect(visionImageUrls(["a", "b"], { sendImages: false, maxImages: 5 })).toEqual([]);
  });

  it("stops at the merchant's count", () => {
    expect(visionImageUrls(["a", "b", "c", "d"], ON)).toEqual(["a", "b", "c"]);
  });

  it("drops blanks and duplicates — the same picture twice is the same bill twice", () => {
    expect(visionImageUrls(["a", "", "a", null, " b ", undefined], ON)).toEqual(["a", "b"]);
  });

  it("honours an override of one, which is what alt text passes", () => {
    expect(visionImageUrls(["a", "b", "c"], ON, 1)).toEqual(["a"]);
  });

  it("an override of one still sends nothing while the switch is off", () => {
    expect(visionImageUrls(["a"], { sendImages: false, maxImages: 1 }, 1)).toEqual([]);
  });
});

describe("readImageCandidates", () => {
  const form = (entries: Record<string, string>) => ({
    get: (name: string) => entries[name] ?? null,
  });

  it("reads the JSON list", () => {
    expect(readImageCandidates(form({ imageUrls: JSON.stringify(["a", "b"]) }))).toEqual(["a", "b"]);
  });

  it("falls back to the single spelling every existing caller sends", () => {
    expect(readImageCandidates(form({ imageUrl: "a" }))).toEqual(["a"]);
  });

  it("treats a malformed list as no list rather than throwing — the request still has work to do", () => {
    expect(readImageCandidates(form({ imageUrls: "{oops", imageUrl: "a" }))).toEqual(["a"]);
  });

  it("is empty when nothing was offered", () => {
    expect(readImageCandidates(form({}))).toEqual([]);
  });
});

describe("aiImageCandidates", () => {
  const product = {
    images: [{ url: "one" }, { url: "two" }, { url: "three" }],
    featuredImage: { url: "one" },
  };

  it("leads with the image the merchant is looking at", () => {
    expect(aiImageCandidates("products", product, 2)).toEqual(["three", "one", "two"]);
  });

  it("does not offer the featured image twice", () => {
    expect(aiImageCandidates("products", product, 0)).toEqual(["one", "two", "three"]);
  });

  it("offers a collection its one image", () => {
    expect(aiImageCandidates("collections", { featuredImage: { url: "hero" } })).toEqual(["hero"]);
  });

  it("offers nothing for a type this app has no image for", () => {
    expect(aiImageCandidates("pages", { featuredImage: { url: "hero" } })).toEqual([]);
  });

  it("never offers more than the server could ever use", () => {
    const many = { images: Array.from({ length: 20 }, (_, i) => ({ url: `u${i}` })) };
    expect(aiImageCandidates("products", many).length).toBe(AI_IMAGES_PER_REQUEST_MAX);
  });

  it("survives an item with no images at all", () => {
    expect(aiImageCandidates("products", { images: [], featuredImage: null })).toEqual([]);
    expect(aiImageCandidates("products", null)).toEqual([]);
  });
});
