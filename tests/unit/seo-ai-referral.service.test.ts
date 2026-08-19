/**
 * AI referral tracking — classification, path normalization, rate limit.
 *
 * The classifier is the privacy boundary: only its OUTPUT (a source key) is
 * ever stored, so it has to be strict about what counts as an AI assistant and
 * unambiguous about what does not.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  classifyAiReferral,
  normalizeReferralPath,
  referralDay,
  allowReferralHit,
  resetReferralRateLimit,
  AI_REFERRAL_SOURCES,
} from "~/services/seo/ai-referral.service";

describe("classifyAiReferral", () => {
  it("classifies the known assistants from a referrer URL", () => {
    expect(classifyAiReferral("https://chatgpt.com/c/abc")).toBe("chatgpt");
    expect(classifyAiReferral("https://www.perplexity.ai/search?q=x")).toBe("perplexity");
    expect(classifyAiReferral("https://claude.ai/chat/1")).toBe("claude");
    expect(classifyAiReferral("https://gemini.google.com/app")).toBe("gemini");
    expect(classifyAiReferral("https://copilot.microsoft.com/")).toBe("copilot");
  });

  it("returns null for ordinary traffic", () => {
    expect(classifyAiReferral("https://www.google.com/search?q=x")).toBeNull();
    expect(classifyAiReferral("https://www.facebook.com/")).toBeNull();
    expect(classifyAiReferral("")).toBeNull();
    expect(classifyAiReferral(null)).toBeNull();
  });

  it("does not match a host that merely CONTAINS an assistant's name", () => {
    // The prefilter in the theme is loose on purpose; the server must not be.
    expect(classifyAiReferral("https://chatgpt.com.evil.example/")).toBeNull();
    expect(classifyAiReferral("https://notperplexity.ai.example/")).toBeNull();
  });

  it("accepts the bare host form utm_source carries", () => {
    expect(classifyAiReferral(null, "chatgpt.com")).toBe("chatgpt");
  });

  it("prefers the referrer over utm_source, because the parameter survives resharing", () => {
    // A ChatGPT link pasted into a newsletter keeps ?utm_source=chatgpt.com
    // forever. The referrer is set by the browser for the actual click.
    expect(classifyAiReferral("https://www.perplexity.ai/", "chatgpt.com")).toBe("perplexity");
    // Non-AI referrer wins too: the visit did not come from ChatGPT.
    expect(classifyAiReferral("https://newsletter.example/", "chatgpt.com")).toBeNull();
  });

  it("only ever returns keys the recorder accepts", () => {
    const key = classifyAiReferral("https://chatgpt.com/");
    expect(AI_REFERRAL_SOURCES).toContain(key);
  });
});

describe("normalizeReferralPath", () => {
  it("strips origin, query and fragment", () => {
    expect(normalizeReferralPath("https://shop.com/products/box?utm_source=chatgpt.com#a")).toBe(
      "/products/box",
    );
  });

  it("collapses the trailing slash but keeps the root", () => {
    expect(normalizeReferralPath("/collections/all/")).toBe("/collections/all");
    expect(normalizeReferralPath("/")).toBe("/");
  });

  it("leading-slashes a relative path and survives empty input", () => {
    expect(normalizeReferralPath("products/box")).toBe("/products/box");
    expect(normalizeReferralPath("")).toBe("");
  });
});

describe("referralDay", () => {
  it("buckets to UTC midnight", () => {
    expect(referralDay(new Date("2026-08-18T23:59:59Z")).toISOString()).toBe(
      "2026-08-18T00:00:00.000Z",
    );
  });
});

describe("allowReferralHit", () => {
  beforeEach(() => resetReferralRateLimit());

  it("allows a burst, then throttles, then refills over time", () => {
    const t0 = 1_000_000;
    let allowed = 0;
    for (let i = 0; i < 200; i++) if (allowReferralHit("a.myshopify.com", t0)) allowed++;
    expect(allowed).toBeGreaterThan(0);
    expect(allowed).toBeLessThan(200);
    // Drained now...
    expect(allowReferralHit("a.myshopify.com", t0)).toBe(false);
    // ...and refilled a minute later.
    expect(allowReferralHit("a.myshopify.com", t0 + 60_000)).toBe(true);
  });

  it("keeps shops independent", () => {
    const t0 = 2_000_000;
    for (let i = 0; i < 200; i++) allowReferralHit("a.myshopify.com", t0);
    expect(allowReferralHit("b.myshopify.com", t0)).toBe(true);
  });
});
