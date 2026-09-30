/**
 * Märkte und Adressen: a market gets its own subfolder (or loses it) through
 * whichever mutation this API version has, and the change counts only when a
 * fresh read shows it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("~/utils/shop-locales-cache.server", () => ({ clearShopLocalesCache: vi.fn() }));

const {
  loadMarketAddresses,
  validateSubfolderRequest,
  createMarketSubfolder,
  removeMarketAddress,
  __resetMarketAddressCache,
} = await import("~/services/market-address.server");

/** The shape measured on the owner's shop, optionally with Spain on /es-es. */
function state(spainOwn: boolean) {
  const shared = {
    id: "wpShared",
    subfolderSuffix: null,
    domain: { host: "shop.example" },
    rootUrls: [{ locale: "de", url: "https://shop.example/" }],
    defaultLocale: { locale: "de" },
    markets: { nodes: [] },
  };
  const spain = {
    id: "wpEs",
    subfolderSuffix: "es",
    domain: { host: "shop.example" },
    rootUrls: [{ locale: "es", url: "https://shop.example/es-es/" }],
    defaultLocale: { locale: "es" },
    markets: { nodes: [{ id: "mES", name: "Spanien", status: "ACTIVE" }] },
  };
  return {
    presences: { data: { webPresences: { pageInfo: { hasNextPage: false }, nodes: spainOwn ? [shared, spain] : [shared] } } },
    markets: {
      data: {
        markets: {
          pageInfo: { hasNextPage: false },
          nodes: [
            { id: "mCH", name: "Schweiz", status: "ACTIVE", webPresences: { nodes: [] } },
            { id: "mES", name: "Spanien", status: "ACTIVE", webPresences: { nodes: spainOwn ? [{ id: "wpEs" }] : [] } },
            { id: "mUS", name: "USA", status: "DRAFT", webPresences: { nodes: [] } },
          ],
        },
      },
    },
  };
}

function shopAdmin(opts: { mutations: string[]; afterWrite: boolean; startOwn?: boolean; writeBody?: unknown }) {
  let written = false;
  const graphql = vi.fn(async (query: string, _opts?: { variables?: Record<string, unknown> }) => {
    let body: unknown;
    const own = written ? opts.afterWrite : !!opts.startOwn;
    if (query.includes("appMarketAddressPresences")) body = state(own).presences;
    else if (query.includes("appMarketAddressMarkets")) body = state(own).markets;
    else if (query.includes("appMutationNames")) body = { data: { __schema: { mutationType: { fields: opts.mutations.map((name) => ({ name })) } } } };
    else {
      written = true;
      body =
        opts.writeBody ??
        (query.includes("webPresenceCreate(")
          ? { data: { webPresenceCreate: { webPresence: { id: "wpEs" }, userErrors: [] } } }
          : { data: { [query.match(/\b(marketUpdate|marketWebPresenceCreate|webPresenceDelete|marketWebPresenceDelete)\(/)?.[1] ?? "x"]: { userErrors: [] } } });
    }
    return { json: async () => body } as unknown as Response;
  });
  return { graphql };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetMarketAddressCache();
});

describe("loadMarketAddresses", () => {
  it("lists active markets with their own address or none, and the shared url", async () => {
    const result = await loadMarketAddresses(shopAdmin({ mutations: [], afterWrite: false, startOwn: true }));
    expect(result).toEqual({
      sharedUrl: "https://shop.example/",
      markets: [
        { marketId: "mCH", name: "Schweiz", own: null },
        { marketId: "mES", name: "Spanien", own: { presenceId: "wpEs", url: "https://shop.example/es-es/", subfolderSuffix: "es" } },
      ],
    });
  });

  it("a failed read is null, never 'shared'", async () => {
    const admin = { graphql: vi.fn(async () => ({ json: async () => ({ errors: [{ message: "nope" }] }) }) as unknown as Response) };
    expect(await loadMarketAddresses(admin)).toBeNull();
  });
});

describe("validateSubfolderRequest", () => {
  const addresses = {
    sharedUrl: "https://shop.example/",
    markets: [
      { marketId: "mCH", name: "Schweiz", own: null },
      { marketId: "mES", name: "Spanien", own: { presenceId: "wpEs", url: null, subfolderSuffix: "es" } },
    ],
  };
  it("normalises and drops the default from the alternates", () => {
    expect(
      validateSubfolderRequest({ marketId: "mCH", suffix: " CH ", defaultLocale: "de", alternateLocales: ["de", "fr"] }, addresses, ["de", "fr"]),
    ).toEqual({ ok: true, request: { marketId: "mCH", suffix: "ch", defaultLocale: "de", alternateLocales: ["fr"] } });
  });
  it("refuses a market that already has one, a taken or malformed code, and unknown languages", () => {
    const req = { marketId: "mCH", suffix: "ch", defaultLocale: "de", alternateLocales: [] as string[] };
    expect(validateSubfolderRequest({ ...req, marketId: "mES" }, addresses, ["de"])).toEqual({ ok: false, error: "marketHasAddress" });
    expect(validateSubfolderRequest({ ...req, suffix: "es" }, addresses, ["de"])).toEqual({ ok: false, error: "suffixTaken" });
    expect(validateSubfolderRequest({ ...req, suffix: "c-h" }, addresses, ["de"])).toEqual({ ok: false, error: "invalidSuffix" });
    expect(validateSubfolderRequest({ ...req, defaultLocale: "nl" }, addresses, ["de"])).toEqual({ ok: false, error: "unknownLocale" });
    expect(validateSubfolderRequest({ ...req, marketId: "mXX" }, addresses, ["de"])).toEqual({ ok: false, error: "unknownMarket" });
  });
});

describe("createMarketSubfolder", () => {
  const request = { marketId: "mES", suffix: "es", defaultLocale: "es", alternateLocales: ["en"] };

  it("uses webPresenceCreate + marketUpdate where the version has them, and confirms by a re-read", async () => {
    const admin = shopAdmin({ mutations: ["webPresenceCreate", "marketUpdate", "webPresenceDelete"], afterWrite: true });
    expect(await createMarketSubfolder(admin, "s", request)).toEqual({ ok: true });
    const attach = admin.graphql.mock.calls.find(([q]) => String(q).includes("appMarketAttachPresence"));
    expect(attach?.[1]).toEqual({ variables: { id: "mES", input: { webPresencesToAdd: ["wpEs"] } } });
  });

  it("falls back to marketWebPresenceCreate on an older version", async () => {
    const admin = shopAdmin({ mutations: ["marketWebPresenceCreate"], afterWrite: true });
    expect(await createMarketSubfolder(admin, "s", request)).toEqual({ ok: true });
    const call = admin.graphql.mock.calls.find(([q]) => String(q).includes("appMarketWebPresenceCreate"));
    expect(call?.[1]).toEqual({
      variables: { marketId: "mES", webPresence: { subfolderSuffix: "es", defaultLocale: "es", alternateLocales: ["en"] } },
    });
  });

  it("an accepted write the re-read does not show is notConfirmed", async () => {
    const admin = shopAdmin({ mutations: ["marketWebPresenceCreate"], afterWrite: false });
    expect(await createMarketSubfolder(admin, "s", request)).toEqual({ ok: false, error: "notConfirmed" });
  });

  it("neither mutation available is notSupported — nothing is guessed", async () => {
    const admin = shopAdmin({ mutations: ["productUpdate"], afterWrite: true });
    expect(await createMarketSubfolder(admin, "s", request)).toEqual({ ok: false, error: "notSupported" });
    expect(admin.graphql.mock.calls.some(([q]) => /\bmutation app/.test(String(q)))).toBe(false);
  });

  it("a schema refusal is reported in Shopify's words", async () => {
    const admin = shopAdmin({
      mutations: ["marketWebPresenceCreate"],
      afterWrite: false,
      writeBody: { errors: [{ message: "Field 'subfolderSuffix' doesn't exist" }] },
    });
    expect(await createMarketSubfolder(admin, "s", request)).toEqual({ ok: false, error: "Field 'subfolderSuffix' doesn't exist" });
  });
});

describe("removeMarketAddress", () => {
  it("removes an own subfolder and confirms that the market is back on the shared address", async () => {
    const admin = shopAdmin({ mutations: ["webPresenceDelete"], afterWrite: false, startOwn: true });
    expect(await removeMarketAddress(admin, "s", "mES")).toEqual({ ok: true });
  });

  it("refuses a market that has no own subfolder", async () => {
    const admin = shopAdmin({ mutations: ["webPresenceDelete"], afterWrite: false });
    expect(await removeMarketAddress(admin, "s", "mCH")).toEqual({ ok: false, error: "notSubfolder" });
  });
});
