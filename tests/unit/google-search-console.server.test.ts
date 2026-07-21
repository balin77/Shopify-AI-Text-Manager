import { createHmac } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getGscOAuthConfig,
  signOAuthState,
  verifyOAuthState,
  consumeOAuthState,
  buildGscAuthUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  emailFromIdToken,
  pickProperty,
  defaultDateRange,
  previousDateRange,
  computeQueryDeltas,
  findLostQueries,
  enrichKeywordsFromGsc,
  getGscAccessToken,
  revokeGoogleToken,
  submitSitemap,
  findCtrOpportunities,
  resolveGscPagePath,
  summarizeInspection,
  buildDimensionFilterGroups,
  querySearchAnalytics,
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

describe("consumeOAuthState — single-use OAuth state (replay protection)", () => {
  it("verifies and consumes a fresh state", () => {
    const state = signOAuthState({ shop: "s.myshopify.com", host: "h" });
    expect(consumeOAuthState(state)).toEqual({ shop: "s.myshopify.com", host: "h", customDomain: null });
  });

  it("rejects a second consume of the same state (replay)", () => {
    const state = signOAuthState({ shop: "s.myshopify.com", host: "h" });
    expect(consumeOAuthState(state)).not.toBeNull();
    expect(consumeOAuthState(state)).toBeNull();
  });

  it("does not block a DIFFERENT state for the same shop (nonces are per-state, not per-shop)", () => {
    const state1 = signOAuthState({ shop: "s.myshopify.com", host: "h" });
    const state2 = signOAuthState({ shop: "s.myshopify.com", host: "h" });
    expect(consumeOAuthState(state1)).not.toBeNull();
    expect(consumeOAuthState(state2)).not.toBeNull();
  });

  it("accepts a legacy state signed without a nonce field (pre-deploy grace) on TTL alone", () => {
    const body = Buffer.from(JSON.stringify({ shop: "s.myshopify.com", host: "h", ts: Date.now() })).toString(
      "base64url",
    );
    const sig = createHmac("sha256", "test-api-secret").update(body).digest("base64url");
    const legacyState = `${body}.${sig}`;
    expect(consumeOAuthState(legacyState)).toEqual({ shop: "s.myshopify.com", host: "h", customDomain: null });
    // A legacy (nonce-less) state has nothing to track for single-use, so a
    // second consume within the TTL is NOT rejected as a replay — documented
    // as the accepted one-deploy grace window.
    expect(consumeOAuthState(legacyState)).toEqual({ shop: "s.myshopify.com", host: "h", customDomain: null });
  });

  it("rejects an expired state even though it was never consumed", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-29T00:00:00Z"));
      const state = signOAuthState({ shop: "s.myshopify.com", host: "h" });
      vi.advanceTimersByTime(11 * 60 * 1000);
      expect(consumeOAuthState(state)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a tampered state without consuming any nonce", () => {
    const state = signOAuthState({ shop: "s.myshopify.com", host: "h" });
    const tampered = state.slice(0, -2) + (state.endsWith("aa") ? "bb" : "aa");
    expect(consumeOAuthState(tampered)).toBeNull();
    // The tamper attempt must not have burned the real state's nonce either.
    expect(consumeOAuthState(state)).not.toBeNull();
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

describe("previousDateRange", () => {
  it("is the 28-day window immediately before defaultDateRange's window, with no gap or overlap", () => {
    const now = new Date("2026-06-29T00:00:00Z");
    const current = defaultDateRange(now);
    const previous = previousDateRange(now);
    expect(current).toEqual({ startDate: "2026-05-29", endDate: "2026-06-26" });
    expect(previous).toEqual({ startDate: "2026-04-30", endDate: "2026-05-28" });
    // Butts directly up against the current window: previous.endDate is
    // exactly one day before current.startDate.
    const gapMs =
      new Date(`${current.startDate}T00:00:00Z`).getTime() - new Date(`${previous.endDate}T00:00:00Z`).getTime();
    expect(gapMs).toBe(24 * 60 * 60 * 1000);
  });

  it("respects a custom `days` window size", () => {
    const now = new Date("2026-06-29T00:00:00Z");
    const previous = previousDateRange(now, 7);
    // Window ending the day before the current window starts, spanning the
    // SAME number of inclusive days as defaultDateRange(now, 7) — which is 8
    // (start = end - 7). A shorter previous window would skew the deltas.
    const current = defaultDateRange(now, 7);
    expect(previous.endDate).toBe(
      new Date(new Date(`${current.startDate}T00:00:00Z`).getTime() - 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10),
    );
    const inclusiveSpan = (range: { startDate: string; endDate: string }) =>
      (new Date(`${range.endDate}T00:00:00Z`).getTime() - new Date(`${range.startDate}T00:00:00Z`).getTime()) /
        (24 * 60 * 60 * 1000) +
      1;
    expect(inclusiveSpan(previous)).toBe(inclusiveSpan(current));
  });
});

describe("computeQueryDeltas", () => {
  const row = (query: string, clicks: number, impressions: number, position: number, ctr = 0.01): SearchAnalyticsRow => ({
    keys: [query],
    clicks,
    impressions,
    ctr,
    position,
  });

  it("only returns deltas for queries present in BOTH periods", () => {
    const current = [row("blue shoes", 20, 400, 5), row("only in current", 5, 100, 10)];
    const previous = [row("blue shoes", 12, 300, 7.5), row("only in previous", 3, 80, 12)];
    const deltas = computeQueryDeltas(current, previous);
    expect(deltas.size).toBe(1);
    expect(deltas.has("blue shoes")).toBe(true);
    expect(deltas.has("only in current")).toBe(false);
    expect(deltas.has("only in previous")).toBe(false);
  });

  it("computes clicks/impressions/ctr deltas as current - previous", () => {
    const current = [row("blue shoes", 20, 400, 5, 0.05)];
    const previous = [row("blue shoes", 12, 300, 7.5, 0.04)];
    const delta = computeQueryDeltas(current, previous).get("blue shoes")!;
    expect(delta.clicksDelta).toBe(8);
    expect(delta.impressionsDelta).toBe(100);
    expect(delta.ctrDelta).toBeCloseTo(0.01);
  });

  it("positionDelta is negative when position improved (rank got smaller/better)", () => {
    const current = [row("blue shoes", 20, 400, 5)]; // improved from 7.5 to 5
    const previous = [row("blue shoes", 12, 300, 7.5)];
    const delta = computeQueryDeltas(current, previous).get("blue shoes")!;
    expect(delta.positionDelta).toBeCloseTo(-2.5);
  });

  it("positionDelta is positive when position got worse (rank got larger)", () => {
    const current = [row("blue shoes", 12, 300, 9)]; // dropped from 5 to 9
    const previous = [row("blue shoes", 20, 400, 5)];
    const delta = computeQueryDeltas(current, previous).get("blue shoes")!;
    expect(delta.positionDelta).toBeCloseTo(4);
  });

  it("matches queries case-insensitively", () => {
    const current = [row("Blue Shoes", 20, 400, 5)];
    const previous = [row("blue shoes", 12, 300, 7.5)];
    const deltas = computeQueryDeltas(current, previous);
    expect(deltas.has("blue shoes")).toBe(true);
  });

  it("returns an empty map for no overlap", () => {
    expect(computeQueryDeltas([], [])).toEqual(new Map());
  });
});

describe("findLostQueries", () => {
  const row = (query: string, clicks: number, impressions: number, position: number): SearchAnalyticsRow => ({
    keys: [query],
    clicks,
    impressions,
    ctr: impressions ? clicks / impressions : 0,
    position,
  });

  it("only surfaces previous-period queries with impressions >= threshold that are absent from current", () => {
    const current = [row("still here", 5, 100, 10)];
    const previous = [
      row("still here", 8, 150, 8), // present in current -> not lost
      row("gone big", 20, 500, 6), // absent, above threshold -> lost
      row("gone small", 1, 10, 15), // absent, below threshold -> not lost
    ];
    const lost = findLostQueries(current, previous, 50, 10);
    expect(lost.map((l) => l.query)).toEqual(["gone big"]);
  });

  it("uses the previous-period impressions/clicks/position values for the lost row", () => {
    const previous = [row("gone big", 20, 500, 6.5)];
    const lost = findLostQueries([], previous, 50, 10);
    expect(lost).toEqual([{ query: "gone big", clicks: 20, impressions: 500, position: 6.5 }]);
  });

  it("sorts by previous-period impressions descending", () => {
    const previous = [row("low", 1, 60, 10), row("high", 5, 900, 10), row("mid", 3, 300, 10)];
    const lost = findLostQueries([], previous, 50, 10);
    expect(lost.map((l) => l.query)).toEqual(["high", "mid", "low"]);
  });

  it("caps results at the given limit", () => {
    const previous = [row("a", 1, 300, 10), row("b", 1, 200, 10), row("c", 1, 100, 10)];
    const lost = findLostQueries([], previous, 50, 2);
    expect(lost.map((l) => l.query)).toEqual(["a", "b"]);
  });

  it("excludes queries present in current even if impressions dropped a lot", () => {
    const current = [row("still ranking", 1, 5, 40)];
    const previous = [row("still ranking", 20, 500, 6)];
    expect(findLostQueries(current, previous)).toEqual([]);
  });

  it("matches case-insensitively when checking presence in current", () => {
    const current = [row("Still Here", 5, 100, 10)];
    const previous = [row("still here", 8, 150, 8)];
    expect(findLostQueries(current, previous)).toEqual([]);
  });

  it("returns an empty array when nothing qualifies", () => {
    expect(findLostQueries([], [])).toEqual([]);
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
      seoKeywordSnapshot: {
        upsert: async () => ({}),
        deleteMany: async () => ({ count: 0 }),
      },
    } as any;

    const enriched = await enrichKeywordsFromGsc(db, "s.myshopify.com", new Date("2026-06-29T00:00:00Z"));
    expect(enriched).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].where).toEqual({ id: "k1" });
    expect(updates[0].data.gscPosition).toBe(7.5);
    expect(updates[0].data.gscClicks).toBe(12);
  });

  function stubGscFetch(rows: any[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/token")) return resp(true, { access_token: "at" });
        if (String(url).includes("searchAnalytics")) return resp(true, { rows });
        return resp(false, { error: { message: "unexpected" } });
      }),
    );
  }

  function makeDb(opts: {
    keywords: Array<{ id: string; keyword: string }>;
    onSnapshotUpsert: (args: any) => void;
    onSnapshotDeleteMany: (args: any) => void;
  }) {
    return {
      googleSearchConsoleConnection: {
        findUnique: async () => ({
          shop: "s.myshopify.com",
          propertyUrl: "sc-domain:example.com",
          refreshToken: encryptApiKey("rt"),
        }),
        deleteMany: async () => ({ count: 0 }),
      },
      seoKeyword: {
        findMany: async () => opts.keywords,
        update: async () => ({}),
      },
      seoKeywordSnapshot: {
        upsert: async (args: any) => {
          opts.onSnapshotUpsert(args);
          return {};
        },
        deleteMany: async (args: any) => {
          opts.onSnapshotDeleteMany(args);
          return { count: 0 };
        },
      },
    } as any;
  }

  it("writes a snapshot per enriched keyword with a UTC-midnight-truncated capturedAt", async () => {
    stubGscFetch([{ keys: ["Blue Shoes"], clicks: 12, impressions: 300, ctr: 0.04, position: 7.5 }]);

    const upserts: any[] = [];
    const db = makeDb({
      keywords: [{ id: "k1", keyword: "blue shoes" }],
      onSnapshotUpsert: (args) => upserts.push(args),
      onSnapshotDeleteMany: () => {},
    });

    // Mid-day timestamp — capturedAt must still land on the truncated midnight.
    await enrichKeywordsFromGsc(db, "s.myshopify.com", new Date("2026-06-29T15:42:00Z"));

    expect(upserts).toHaveLength(1);
    expect(upserts[0].where).toEqual({
      keywordId_capturedAt: { keywordId: "k1", capturedAt: new Date("2026-06-29T00:00:00.000Z") },
    });
    expect(upserts[0].create).toMatchObject({
      shop: "s.myshopify.com",
      keywordId: "k1",
      capturedAt: new Date("2026-06-29T00:00:00.000Z"),
      position: 7.5,
      clicks: 12,
      impressions: 300,
      ctr: 0.04,
    });
    expect(upserts[0].update).toMatchObject({ position: 7.5, clicks: 12, impressions: 300, ctr: 0.04 });
  });

  it("prunes snapshots older than 400 days, scoped to the shop", async () => {
    stubGscFetch([{ keys: ["blue shoes"], clicks: 1, impressions: 1, ctr: 0.1, position: 1 }]);

    const deletes: any[] = [];
    const db = makeDb({
      keywords: [{ id: "k1", keyword: "blue shoes" }],
      onSnapshotUpsert: () => {},
      onSnapshotDeleteMany: (args) => deletes.push(args),
    });

    await enrichKeywordsFromGsc(db, "s.myshopify.com", new Date("2026-06-29T00:00:00Z"));

    expect(deletes).toHaveLength(1);
    expect(deletes[0].where.shop).toBe("s.myshopify.com");
    expect(deletes[0].where.capturedAt.lt).toEqual(new Date("2025-05-25T00:00:00.000Z"));
  });

  it("does not write a snapshot for a keyword with no matching GSC row", async () => {
    stubGscFetch([{ keys: ["blue shoes"], clicks: 1, impressions: 1, ctr: 0.1, position: 1 }]);

    const upserts: any[] = [];
    const db = makeDb({
      keywords: [
        { id: "k1", keyword: "blue shoes" },
        { id: "k2", keyword: "no gsc data for this one" },
      ],
      onSnapshotUpsert: (args) => upserts.push(args),
      onSnapshotDeleteMany: () => {},
    });

    const enriched = await enrichKeywordsFromGsc(db, "s.myshopify.com", new Date("2026-06-29T00:00:00Z"));

    expect(enriched).toBe(1);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].create.keywordId).toBe("k1");
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

describe("resolveGscPagePath — Quick wins 'Optimize' deep-link resolution", () => {
  it("resolves a product page", () => {
    expect(resolveGscPagePath("https://shop.example.com/products/blue-shoes")).toEqual({
      resourceType: "Product",
      handle: "blue-shoes",
    });
  });

  it("resolves a collection page", () => {
    expect(resolveGscPagePath("https://shop.example.com/collections/summer-sale")).toEqual({
      resourceType: "Collection",
      handle: "summer-sale",
    });
  });

  it("resolves a page", () => {
    expect(resolveGscPagePath("https://shop.example.com/pages/about-us")).toEqual({
      resourceType: "Page",
      handle: "about-us",
    });
  });

  it("resolves an article, using the article handle (not the blog handle)", () => {
    expect(resolveGscPagePath("https://shop.example.com/blogs/news/our-launch")).toEqual({
      resourceType: "Article",
      handle: "our-launch",
    });
  });

  it("strips a two-letter locale prefix before matching", () => {
    expect(resolveGscPagePath("https://shop.example.com/de/products/blaue-schuhe")).toEqual({
      resourceType: "Product",
      handle: "blaue-schuhe",
    });
  });

  it("strips a locale-region prefix (e.g. en-us) before matching", () => {
    expect(resolveGscPagePath("https://shop.example.com/en-us/collections/summer-sale")).toEqual({
      resourceType: "Collection",
      handle: "summer-sale",
    });
  });

  it("returns null for the root path", () => {
    expect(resolveGscPagePath("https://shop.example.com/")).toBeNull();
  });

  it("returns null for an unknown/unmapped path", () => {
    expect(resolveGscPagePath("https://shop.example.com/search?q=shoes")).toBeNull();
  });

  it("returns null for a blogs path missing the article handle", () => {
    expect(resolveGscPagePath("https://shop.example.com/blogs/news")).toBeNull();
  });

  it("returns null for an invalid URL", () => {
    expect(resolveGscPagePath("not-a-url")).toBeNull();
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

describe("buildDimensionFilterGroups — country/device analytics filters", () => {
  it("returns undefined when no filters are set", () => {
    expect(buildDimensionFilterGroups()).toBeUndefined();
    expect(buildDimensionFilterGroups({})).toBeUndefined();
  });

  it("builds a single-filter group for country only", () => {
    expect(buildDimensionFilterGroups({ country: "deu" })).toEqual([
      { filters: [{ dimension: "country", operator: "equals", expression: "deu" }] },
    ]);
  });

  it("builds a single-filter group for device only", () => {
    expect(buildDimensionFilterGroups({ device: "MOBILE" })).toEqual([
      { filters: [{ dimension: "device", operator: "equals", expression: "MOBILE" }] },
    ]);
  });

  it("combines both filters in ONE group (AND semantics — country AND device)", () => {
    const groups = buildDimensionFilterGroups({ country: "usa", device: "DESKTOP" });
    expect(groups).toHaveLength(1);
    expect(groups![0].filters).toEqual([
      { dimension: "country", operator: "equals", expression: "usa" },
      { dimension: "device", operator: "equals", expression: "DESKTOP" },
    ]);
  });
});

describe("querySearchAnalytics — request body filter wiring", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("omits dimensionFilterGroups from the request body when no filters are passed", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => resp(true, { rows: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await querySearchAnalytics("at", "sc-domain:example.com", {
      startDate: "2026-06-01",
      endDate: "2026-06-28",
    });
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body).not.toHaveProperty("dimensionFilterGroups");
  });

  it("includes dimensionFilterGroups in the request body when filters are passed", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => resp(true, { rows: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await querySearchAnalytics("at", "sc-domain:example.com", {
      startDate: "2026-06-01",
      endDate: "2026-06-28",
      filters: { country: "deu", device: "MOBILE" },
    });
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body.dimensionFilterGroups).toEqual([
      {
        filters: [
          { dimension: "country", operator: "equals", expression: "deu" },
          { dimension: "device", operator: "equals", expression: "MOBILE" },
        ],
      },
    ]);
  });
});
