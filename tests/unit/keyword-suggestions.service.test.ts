import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  fetchAutocomplete,
  gatherSuggestions,
  checkSuggestionsRateLimit,
  resetSuggestionsRateLimit,
  SuggestionsRateLimitedError,
} from "~/services/seo/keyword-suggestions.service";

function resp(ok: boolean, status: number, body: unknown): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchAutocomplete", () => {
  it("parses the firefox-client JSON shape [query, [suggestions]]", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => resp(true, 200, ["vase", ["vase deko", "vase groß"]])));
    await expect(fetchAutocomplete("vase", "de")).resolves.toEqual(["vase deko", "vase groß"]);
  });

  it("throws the coded error on 429/403 (no retry bomb)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => resp(false, 429, {})));
    await expect(fetchAutocomplete("vase", "de")).rejects.toBeInstanceOf(SuggestionsRateLimitedError);
    vi.stubGlobal("fetch", vi.fn(async () => resp(false, 403, {})));
    await expect(fetchAutocomplete("vase", "de")).rejects.toBeInstanceOf(SuggestionsRateLimitedError);
  });

  it("returns [] on malformed payloads and network errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => resp(true, 200, { not: "an array" })));
    await expect(fetchAutocomplete("vase", "de")).resolves.toEqual([]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await expect(fetchAutocomplete("vase", "de")).resolves.toEqual([]);
  });

  it("sets the ContentPilot user agent", async () => {
    const fetchMock = vi.fn(async () => resp(true, 200, ["v", []]));
    vi.stubGlobal("fetch", fetchMock);
    await fetchAutocomplete("vase", "de");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe("ContentPilot-SEO/1.0");
  });
});

describe("gatherSuggestions", () => {
  it("groups direct + question suggestions, dedupes against the seed and each other", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const q = new URL(String(url)).searchParams.get("q") ?? "";
      if (q === "vase") return resp(true, 200, [q, ["vase deko", "vase"]]);
      if (q.startsWith("wie ")) return resp(true, 200, [q, ["wie vase reinigen", "vase deko"]]);
      return resp(true, 200, [q, []]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const groups = await gatherSuggestions("Vase", "de", { expandAlphabet: false, delayMs: 0 });
    expect(groups.direct).toEqual(["vase deko"]); // seed itself removed
    expect(groups.questions).toEqual(["wie vase reinigen"]); // duplicate removed
    expect(groups.alphabet).toEqual([]);
    // 1 direct + 6 German question words, NO alphabet calls without opt-in.
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it("expandAlphabet adds the 26 a–z calls", async () => {
    const fetchMock = vi.fn(async () => resp(true, 200, ["q", []]));
    vi.stubGlobal("fetch", fetchMock);
    await gatherSuggestions("vase", "en", { expandAlphabet: true, delayMs: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1 + 6 + 26);
  });
});

describe("checkSuggestionsRateLimit", () => {
  beforeEach(() => resetSuggestionsRateLimit());

  it("allows 3 seeds per minute per shop, then refuses", () => {
    const now = 1_000_000;
    expect(checkSuggestionsRateLimit("a.myshopify.com", now)).toBe(true);
    expect(checkSuggestionsRateLimit("a.myshopify.com", now + 1)).toBe(true);
    expect(checkSuggestionsRateLimit("a.myshopify.com", now + 2)).toBe(true);
    expect(checkSuggestionsRateLimit("a.myshopify.com", now + 3)).toBe(false);
    // Another shop is unaffected.
    expect(checkSuggestionsRateLimit("b.myshopify.com", now + 3)).toBe(true);
  });

  it("frees the budget after the window passes", () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) checkSuggestionsRateLimit("a.myshopify.com", now + i);
    expect(checkSuggestionsRateLimit("a.myshopify.com", now + 61_000)).toBe(true);
  });
});
