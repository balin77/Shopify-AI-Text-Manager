import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  fetchAutocomplete,
  gatherSuggestions,
  checkSuggestionsRateLimit,
  resetSuggestionsRateLimit,
  getSuggestionsAvailability,
  markSuggestionsAvailability,
  resetSuggestionsAvailability,
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

describe("availability probe (integrated §6.1 spike)", () => {
  beforeEach(() => resetSuggestionsAvailability());

  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("starts unknown, probes in the background and flips to ok on a healthy response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => resp(true, 200, ["test", ["test a", "test b"]])));
    const first = getSuggestionsAvailability();
    expect(first.status).toBe("unknown"); // never blocks the caller
    await flush();
    expect(getSuggestionsAvailability().status).toBe("ok");
  });

  it("flips to blocked when the probe hits a 429", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => resp(false, 429, {})));
    getSuggestionsAvailability();
    await flush();
    expect(getSuggestionsAvailability().status).toBe("blocked");
  });

  it("stays unknown on a soft failure (empty/malformed body)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => resp(true, 200, { not: "an array" })));
    getSuggestionsAvailability();
    await flush();
    const verdict = getSuggestionsAvailability();
    expect(verdict.status).toBe("unknown");
    expect(verdict.checkedAt).not.toBeNull(); // probed, just inconclusive
  });

  it("does NOT re-probe while a fresh verdict is cached", async () => {
    const fetchMock = vi.fn(async () => resp(true, 200, ["test", ["test a"]]));
    vi.stubGlobal("fetch", fetchMock);
    getSuggestionsAvailability();
    await flush();
    getSuggestionsAvailability();
    getSuggestionsAvailability();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("markSuggestionsAvailability feeds the cache from real research outcomes", async () => {
    const fetchMock = vi.fn(async () => resp(true, 200, ["test", ["test a"]]));
    vi.stubGlobal("fetch", fetchMock);
    markSuggestionsAvailability("blocked");
    expect(getSuggestionsAvailability().status).toBe("blocked");
    markSuggestionsAvailability("ok");
    expect(getSuggestionsAvailability().status).toBe("ok");
    await flush();
    expect(fetchMock).not.toHaveBeenCalled(); // fresh verdicts → no probe call
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
