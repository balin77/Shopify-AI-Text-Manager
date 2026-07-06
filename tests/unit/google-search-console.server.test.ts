import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getGscOAuthConfig,
  signOAuthState,
  verifyOAuthState,
  buildGscAuthUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  emailFromIdToken,
  pickProperty,
  defaultDateRange,
  enrichKeywordsFromGsc,
  getGscAccessToken,
  revokeGoogleToken,
  submitSitemap,
  findCtrOpportunities,
  summarizeInspection,
  GscReconnectRequiredError,
  type SearchAnalyticsRow,
} from "~/services/google-search-console.server";
import { encryptApiKey, isEncrypted } from "~/utils/encryption.server";

/**
 * Phase 6 GSC service — deterministic units. OAuth round-trips to Google are
 * mocked at fetch; the encrypted-token path uses the real AES utility (the test
 * setup provides ENCRYPTION_KEY).
 */

const resp = (ok: boolean, body: any, status = ok ? 200 : 400) => ({
  ok,
  status,
  json: async () => body,
});

describe("getGscOAuthConfig", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is null when client id/secret are unset", () => {
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "");
    expect(getGscOAuthConfig()).toBeNull();
  });

  it("derives the redirect URI from SHOPIFY_APP_URL when not set explicitly", () => {
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "cid");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "csec");
    vi.stubEnv("GOOGLE_OAUTH_REDIRECT_URI", "");
    vi.stubEnv("SHOPIFY_APP_URL", "https://app.example.com/");
    expect(getGscOAuthConfig()).toEqual({
      clientId: "cid",
      clientSecret: "csec",
      redirectUri: "https://app.example.com/auth/google/callback",
    });
  });
});

describe("OAuth state signing", () => {
  it("round-trips shop + host", () => {
    const state = signOAuthState({ shop: "s.myshopify.com", host: "aG9zdA" });
    expect(verifyOAuthState(state)).toEqual({ shop: "s.myshopify.com", host: "aG9zdA", customDomain: null });
  });
  it("round-trips a custom domain so the callback can match it in pickProperty", () => {
    const state = signOAuthState({ shop: "s.myshopify.com", host: "h", customDomain: "shop.example.com" });
    expect(verifyOAuthState(state)).toEqual({
      shop: "s.myshopify.com",
      host: "h",
      customDomain: "shop.example.com",
    });
  });
  it("rejects a tampered signature", () => {
    const state = signOAuthState({ shop: "s.myshopify.com", host: "h" });
    const tampered = state.slice(0, -2) + (state.endsWith("aa") ? "bb" : "aa");
    expect(verifyOAuthState(tampered)).toBeNull();
  });
  it("rejects malformed input", () => {
    expect(verifyOAuthState("not-a-state")).toBeNull();
    expect(verifyOAuthState("")).toBeNull();
  });
  it("rejects an expired state (past the 10-min TTL)", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-29T00:00:00Z"));
      const state = signOAuthState({ shop: "s.myshopify.com", host: "h" });
      vi.advanceTimersByTime(11 * 60 * 1000);
      expect(verifyOAuthState(state)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("OAuth state secret — production must not use the dev fallback", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("throws in production when neither SHOPIFY_API_SECRET nor ENCRYPTION_KEY is set", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SHOPIFY_API_SECRET", "");
    vi.stubEnv("ENCRYPTION_KEY", "");
    expect(() => signOAuthState({ shop: "s.myshopify.com", host: "h" })).toThrow(
      /OAuth state secret is not configured/i,
    );
  });

  it("still works in production when SHOPIFY_API_SECRET is set", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SHOPIFY_API_SECRET", "shpss_real_secret");
    vi.stubEnv("ENCRYPTION_KEY", "");
    const state = signOAuthState({ shop: "s.myshopify.com", host: "h" });
    expect(verifyOAuthState(state)).toEqual({ shop: "s.myshopify.com", host: "h", customDomain: null });
  });

  it("falls back to the dev-only secret outside production", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SHOPIFY_API_SECRET", "");
    vi.stubEnv("ENCRYPTION_KEY", "");
    expect(() => signOAuthState({ shop: "s.myshopify.com", host: "h" })).not.toThrow();
  });
});

describe("buildGscAuthUrl", () => {
  beforeEach(() => {
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "cid");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "csec");
    vi.stubEnv("GOOGLE_OAUTH_REDIRECT_URI", "https://app.example.com/auth/google/callback");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("includes the offline/consent params and the state", () => {
    const url = buildGscAuthUrl("STATE123")!;
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("client_id")).toBe("cid");
    expect(u.searchParams.get("redirect_uri")).toBe("https://app.example.com/auth/google/callback");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("state")).toBe("STATE123");
    expect(u.searchParams.get("scope")).toContain("webmasters.readonly");
  });
});

describe("token exchange / refresh", () => {
  beforeEach(() => {
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "cid");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "csec");
    vi.stubEnv("GOOGLE_OAUTH_REDIRECT_URI", "https://app.example.com/auth/google/callback");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("parses an authorization-code exchange", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => resp(true, { access_token: "at", refresh_token: "rt", expires_in: 3600, id_token: "id" })),
    );
    const t = await exchangeCodeForTokens("code");
    expect(t).toEqual({ accessToken: "at", refreshToken: "rt", expiresIn: 3600, idToken: "id" });
  });

  it("throws on a failed exchange", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => resp(false, { error: "invalid_request" })));
    await expect(exchangeCodeForTokens("bad")).rejects.toThrow(/token exchange failed/i);
  });

  it("refreshes an access token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => resp(true, { access_token: "at2" })));
    expect(await refreshAccessToken("rt")).toBe("at2");
  });

  it("maps invalid_grant to GscReconnectRequiredError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => resp(false, { error: "invalid_grant" })));
    await expect(refreshAccessToken("revoked")).rejects.toBeInstanceOf(GscReconnectRequiredError);
  });
});

describe("emailFromIdToken", () => {
  it("decodes the email claim", () => {
    const payload = Buffer.from(JSON.stringify({ email: "owner@shop.com" })).toString("base64url");
    expect(emailFromIdToken(`header.${payload}.sig`)).toBe("owner@shop.com");
  });
  it("returns null for malformed tokens", () => {
    expect(emailFromIdToken(undefined)).toBeNull();
    expect(emailFromIdToken("nope")).toBeNull();
  });
});

describe("pickProperty", () => {
  const sites = [
    { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
    { siteUrl: "https://foo.myshopify.com/", permissionLevel: "siteOwner" },
  ];
  it("prefers a matching domain property when a custom domain matches", () => {
    expect(pickProperty(sites, "foo.myshopify.com", "example.com")).toBe("sc-domain:example.com");
  });
  it("falls back to a matching URL property", () => {
    expect(pickProperty(sites, "foo.myshopify.com")).toBe("https://foo.myshopify.com/");
  });
  it("does NOT guess sites[0] when nothing matches shop or custom domain — returns null so the caller can prompt the merchant", () => {
    expect(pickProperty(sites, "other.myshopify.com")).toBeNull();
    expect(pickProperty(sites, "other.myshopify.com", "unrelated.com")).toBeNull();
  });
  it("returns null for no sites", () => {
    expect(pickProperty([], "foo.myshopify.com")).toBeNull();
  });
});

describe("defaultDateRange", () => {
  it("is a 28-day window ending 3 days ago", () => {
    const { startDate, endDate } = defaultDateRange(new Date("2026-06-29T00:00:00Z"));
    expect(endDate).toBe("2026-06-26");
    expect(startDate).toBe("2026-05-29");
  });
});

describe("refresh token is encrypted at rest", () => {
  it("encryptApiKey output is not the plaintext", () => {
    const enc = encryptApiKey("super-secret-refresh-token");
    expect(enc).not.toBe("super-secret-refresh-token");
    expect(isEncrypted(enc)).toBe(true);
  });
});

describe("enrichKeywordsFromGsc", () => {
  beforeEach(() => {
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "cid");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "csec");
    vi.stubEnv("GOOGLE_OAUTH_REDIRECT_URI", "https://app.example.com/auth/google/callback");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("writes GSC metrics onto matching keyword rows (case-insensitive)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/token")) return resp(true, { access_token: "at" });
        if (String(url).includes("searchAnalytics")) {
          return resp(true, {
            rows: [
              { keys: ["Blue Shoes"], clicks: 12, impressions: 300, ctr: 0.04, position: 7.5 },
              { keys: ["unrelated"], clicks: 1, impressions: 5, ctr: 0.2, position: 50 },
            ],
          });
        }
        return resp(false, { error: { message: "unexpected" } });
      }),
    );

    const updates: any[] = [];
    const db = {
      googleSearchConsoleConnection: {
        findUnique: async () => ({
          shop: "s.myshopify.com",
          propertyUrl: "sc-domain:example.com",
          refreshToken: encryptApiKey("rt"),
        }),
        deleteMany: async () => ({ count: 0 }),
      },
      seoKeyword: {
        findMany: async () => [
          { id: "k1", keyword: "blue shoes" },
          { id: "k2", keyword: "missing keyword" },
        ],
        update: async (args: any) => {
          updates.push(args);
          return {};
        },
      },
    } as any;

    const enriched = await enrichKeywordsFromGsc(db, "s.myshopify.com", new Date("2026-06-29T00:00:00Z"));
    expect(enriched).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].where).toEqual({ id: "k1" });
    expect(updates[0].data.gscPosition).toBe(7.5);
    expect(updates[0].data.gscClicks).toBe(12);
  });
});

describe("getGscAccessToken — recovery paths", () => {
  beforeEach(() => {
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "cid");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "csec");
    vi.stubEnv("GOOGLE_OAUTH_REDIRECT_URI", "https://app.example.com/auth/google/callback");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("clears the connection and asks to reconnect when the stored token can't be decrypted", async () => {
    // A real ciphertext with a flipped tail → AES-GCM auth-tag mismatch → decrypt
    // throws internally; the non-throwing read must turn that into null (the H1 fix).
    const valid = encryptApiKey("rt")!;
    const corrupted = valid.slice(0, -6) + "abcdef";
    // If the fix regressed and decrypt threw past the guard, fetch must not be hit.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network must not be called"); }));
    const deleteMany = vi.fn(async () => ({ count: 1 }));
    const db = {
      googleSearchConsoleConnection: {
        findUnique: async () => ({ shop: "s", propertyUrl: "sc-domain:x", refreshToken: corrupted }),
        deleteMany,
      },
    } as any;
    await expect(getGscAccessToken(db, "s")).rejects.toBeInstanceOf(GscReconnectRequiredError);
    expect(deleteMany).toHaveBeenCalledWith({ where: { shop: "s" } });
  });

  it("clears the connection on invalid_grant (revoked refresh token)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => resp(false, { error: "invalid_grant" })));
    const deleteMany = vi.fn(async () => ({ count: 1 }));
    const db = {
      googleSearchConsoleConnection: {
        findUnique: async () => ({ shop: "s", propertyUrl: "sc-domain:x", refreshToken: encryptApiKey("rt") }),
        deleteMany,
      },
    } as any;
    await expect(getGscAccessToken(db, "s")).rejects.toBeInstanceOf(GscReconnectRequiredError);
    expect(deleteMany).toHaveBeenCalledWith({ where: { shop: "s" } });
  });
});

describe("revokeGoogleToken — best-effort disconnect", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts the refresh token form-encoded to Google's revoke endpoint", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => resp(true, {}));
    vi.stubGlobal("fetch", fetchMock);
    await revokeGoogleToken("rt-value");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://oauth2.googleapis.com/revoke");
    expect(init?.method).toBe("POST");
    expect(String(init?.body)).toContain("token=rt-value");
  });

  it("never throws — a network error must not block disconnect", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    await expect(revokeGoogleToken("rt-value")).resolves.toBeUndefined();
  });

  it("never throws even when Google responds with an error status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => resp(false, { error: "invalid_token" })));
    await expect(revokeGoogleToken("rt-value")).resolves.toBeUndefined();
  });
});

describe("findCtrOpportunities — Search Console page 'Quick wins'", () => {
  const row = (query: string, page: string, impressions: number, position: number, ctr = 0.01): SearchAnalyticsRow => ({
    keys: [query, page],
    clicks: Math.round(impressions * ctr),
    impressions,
    ctr,
    position,
  });

  it("keeps only rows with impressions >= 200 and position in [4,20]", () => {
    const rows = [
      row("in-range", "https://s.com/a", 200, 4), // boundary — kept
      row("also-in-range", "https://s.com/b", 500, 20), // boundary — kept
      row("too-few-impressions", "https://s.com/c", 199, 10),
      row("too-close", "https://s.com/d", 999, 3.9),
      row("too-far", "https://s.com/e", 999, 20.1),
    ];
    const result = findCtrOpportunities(rows);
    expect(result.map((r) => r.query).sort()).toEqual(["also-in-range", "in-range"].sort());
  });

  it("sorts by impressions descending and caps at the limit", () => {
    const rows = [
      row("low", "https://s.com/low", 250, 10),
      row("high", "https://s.com/high", 900, 10),
      row("mid", "https://s.com/mid", 500, 10),
    ];
    const result = findCtrOpportunities(rows, 2);
    expect(result.map((r) => r.query)).toEqual(["high", "mid"]);
  });

  it("maps keys[0]/keys[1] to query/page and preserves impressions/position/ctr", () => {
    const [result] = findCtrOpportunities([row("blue shoes", "https://s.com/p/blue-shoes", 300, 8, 0.02)]);
    expect(result).toEqual({
      query: "blue shoes",
      page: "https://s.com/p/blue-shoes",
      impressions: 300,
      position: 8,
      ctr: 0.02,
    });
  });

  it("returns an empty list for no rows", () => {
    expect(findCtrOpportunities([])).toEqual([]);
  });
});

describe("summarizeInspection — urlInspection response mapping", () => {
  it("extracts the indexStatusResult fields the UI needs", () => {
    const summary = summarizeInspection({
      indexStatusResult: {
        verdict: "PASS",
        coverageState: "Submitted and indexed",
        robotsTxtState: "ALLOWED",
        indexingState: "INDEXING_ALLOWED",
        lastCrawlTime: "2026-06-01T00:00:00Z",
      },
      mobileUsabilityResult: { verdict: "NEUTRAL" }, // must be ignored
    });
    expect(summary).toEqual({
      verdict: "PASS",
      coverageState: "Submitted and indexed",
      robotsTxtState: "ALLOWED",
      indexingState: "INDEXING_ALLOWED",
      lastCrawlTime: "2026-06-01T00:00:00Z",
    });
  });

  it("degrades gracefully for a missing/null inspection result", () => {
    expect(summarizeInspection(null)).toEqual({
      verdict: "VERDICT_UNSPECIFIED",
      coverageState: "",
      robotsTxtState: "",
      indexingState: "",
      lastCrawlTime: null,
    });
    expect(summarizeInspection({})).toEqual({
      verdict: "VERDICT_UNSPECIFIED",
      coverageState: "",
      robotsTxtState: "",
      indexingState: "",
      lastCrawlTime: null,
    });
  });
});

describe("submitSitemap — requires a full absolute sitemap URL", () => {
  beforeEach(() => {
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "cid");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "csec");
    vi.stubEnv("GOOGLE_OAUTH_REDIRECT_URI", "https://app.example.com/auth/google/callback");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("PUTs the encoded full https sitemap URL, not a bare relative path", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => resp(true, {}, 204));
    vi.stubGlobal("fetch", fetchMock);
    await submitSitemap("at", "sc-domain:example.com", "https://example.com/sitemap.xml");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain(encodeURIComponent("https://example.com/sitemap.xml"));
    expect(init?.method).toBe("PUT");
  });
});
