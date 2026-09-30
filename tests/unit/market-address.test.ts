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
  validateMarketRequest,
  createMarket,
  deleteMarket,
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

/** What the app's real client does with a top-level `errors` array: it THROWS. */
function graphqlQueryError(message: string) {
  return Object.assign(new Error(message), {
    name: "GraphqlQueryError",
    body: { errors: { graphQLErrors: [{ message }] } },
  });
}

function shopAdmin(opts: {
  mutations: string[];
  afterWrite: boolean;
  startOwn?: boolean;
  writeBody?: unknown;
  /** Per mutation name: a body to answer with, or an Error to throw. */
  writes?: Record<string, unknown>;
  primary?: Record<string, boolean>;
  /** Portugal shares Spain's presence. */
  sharedWithPortugal?: boolean;
}) {
  let written = false;
  const graphql = vi.fn(async (query: string, _opts?: { variables?: Record<string, unknown> }) => {
    let body: unknown;
    const own = written ? opts.afterWrite : !!opts.startOwn;
    if (query.includes("appMarketAddressPresences")) {
      body = state(own).presences;
      if (opts.sharedWithPortugal) {
        (body as any).data.webPresences.nodes.find((n: any) => n.id === "wpEs")?.markets.nodes.push({ id: "mPT", name: "Portugal", status: "ACTIVE" });
      }
    } else if (query.includes("appMarketAddressMarkets")) body = state(own).markets;
    else if (query.includes("appMutationNames")) body = { data: { __schema: { mutationType: { fields: opts.mutations.map((name) => ({ name })) } } } };
    else if (query.includes("appMarketFields")) {
      body = { data: { __type: { fields: [{ name: "id" }, ...(opts.primary ? [{ name: "primary" }] : [])] } } };
    } else if (query.includes("appMarketPrimary")) {
      body = { data: { markets: { nodes: Object.entries(opts.primary ?? {}).map(([id, primary]) => ({ id, primary })) } } };
    } else if (query.includes("appInputShape")) body = { data: { __type: { inputFields: [{ name: "webPresencesToAdd" }] } } };
    else {
      const name = query.match(/\b(webPresenceCreate|marketUpdate|marketWebPresenceCreate|webPresenceDelete|marketWebPresenceDelete)\(/)?.[1] ?? "x";
      const scripted = opts.writes?.[name];
      if (scripted instanceof Error) throw scripted;
      written = true;
      body =
        scripted ??
        opts.writeBody ??
        (name === "webPresenceCreate"
          ? { data: { webPresenceCreate: { webPresence: { id: "wpEs" }, userErrors: [] } } }
          : name === "marketUpdate"
            ? { data: { marketUpdate: { market: { id: "mES" }, userErrors: [] } } }
            : { data: { [name]: { userErrors: [] } } });
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
      takenSuffixes: ["es"],
      markets: [
        { marketId: "mCH", name: "Schweiz", status: "ACTIVE", primary: null, own: null },
        {
          marketId: "mES",
          name: "Spanien",
          status: "ACTIVE",
          primary: null,
          own: { presenceId: "wpEs", url: "https://shop.example/es-es/", subfolderSuffix: "es", sharedWith: [] },
        },
        { marketId: "mUS", name: "USA", status: "DRAFT", primary: null, own: null },
      ],
    });
  });

  it("reads the primary flag where the version has one, and names who else uses a presence", async () => {
    const result = await loadMarketAddresses(
      shopAdmin({ mutations: [], afterWrite: false, startOwn: true, primary: { mCH: true, mES: false }, sharedWithPortugal: true }),
    );
    expect(result?.markets.map((m) => [m.marketId, m.primary])).toEqual([
      ["mCH", true],
      ["mES", false],
      ["mUS", null],
    ]);
    expect(result?.markets.find((m) => m.marketId === "mES")?.own?.sharedWith).toEqual(["mPT"]);
  });

  it("an unclaimed SUBFOLDER is an orphan, never the shared address — but its suffix is taken", async () => {
    const admin = shopAdmin({ mutations: [], afterWrite: false, startOwn: true });
    const graphql = admin.graphql.getMockImplementation()!;
    admin.graphql.mockImplementation(async (query: string, o?: any) => {
      const res = await graphql(query, o);
      if (!query.includes("appMarketAddressPresences")) return res;
      const body = await res.json();
      const orphan = { id: "wpOrphan", subfolderSuffix: "fr", rootUrls: [{ locale: "fr", url: "https://shop.example/fr-fr/" }], defaultLocale: { locale: "fr" }, markets: { nodes: [] } };
      body.data.webPresences.nodes.unshift(orphan);
      return { json: async () => body } as unknown as Response;
    });
    const result = await loadMarketAddresses(admin);
    expect(result?.sharedUrl).toBe("https://shop.example/");
    expect(result?.takenSuffixes).toEqual(["fr", "es"]);
  });

  it("a failed read is null, never 'shared'", async () => {
    const admin = { graphql: vi.fn(async () => ({ json: async () => ({ errors: [{ message: "nope" }] }) }) as unknown as Response) };
    expect(await loadMarketAddresses(admin)).toBeNull();
  });
});

describe("validateSubfolderRequest", () => {
  const addresses = {
    sharedUrl: "https://shop.example/",
    takenSuffixes: ["es", "fr"],
    markets: [
      { marketId: "mCH", name: "Schweiz", status: "ACTIVE", primary: null, own: null },
      {
        marketId: "mES",
        name: "Spanien",
        status: "ACTIVE",
        primary: null,
        own: { presenceId: "wpEs", url: null, subfolderSuffix: "es", sharedWith: [] },
      },
      { marketId: "mUS", name: "USA", status: "DRAFT", primary: null, own: null },
      { marketId: "mDE", name: "Deutschland", status: "ACTIVE", primary: true, own: null },
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
    // A suffix only an ORPHAN presence carries is taken just the same.
    expect(validateSubfolderRequest({ ...req, suffix: "fr" }, addresses, ["de"])).toEqual({ ok: false, error: "suffixTaken" });
    // The primary market IS the root storefront.
    expect(validateSubfolderRequest({ ...req, marketId: "mDE" }, addresses, ["de"])).toEqual({ ok: false, error: "primaryMarket" });
    expect(validateSubfolderRequest({ ...req, suffix: "c-h" }, addresses, ["de"])).toEqual({ ok: false, error: "invalidSuffix" });
    expect(validateSubfolderRequest({ ...req, defaultLocale: "nl" }, addresses, ["de"])).toEqual({ ok: false, error: "unknownLocale" });
    expect(validateSubfolderRequest({ ...req, marketId: "mXX" }, addresses, ["de"])).toEqual({ ok: false, error: "unknownMarket" });
    // A draft market has no storefront to address.
    expect(validateSubfolderRequest({ ...req, marketId: "mUS" }, addresses, ["de"])).toEqual({ ok: false, error: "unknownMarket" });
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

  it("the real client THROWS a schema refusal — still Shopify's words, and the input shape is looked up", async () => {
    const admin = shopAdmin({
      mutations: ["marketWebPresenceCreate"],
      afterWrite: false,
      writes: { marketWebPresenceCreate: graphqlQueryError("Field 'subfolderSuffix' doesn't exist") },
    });
    expect(await createMarketSubfolder(admin, "s", request)).toEqual({ ok: false, error: "Field 'subfolderSuffix' doesn't exist" });
    expect(admin.graphql.mock.calls.some(([q]) => String(q).includes("appInputShape"))).toBe(true);
  });

  it.each([
    ["a thrown schema refusal", graphqlQueryError("Field 'webPresencesToAdd' doesn't exist"), "Field 'webPresencesToAdd' doesn't exist"],
    ["a throttle", new Error("Throttled"), "Throttled"],
    ["an answer with no market", { data: { marketUpdate: null } }, "notConfirmed"],
  ])("a failed attach (%s) deletes the presence it just created", async (_label, answer, error) => {
    const admin = shopAdmin({
      mutations: ["webPresenceCreate", "marketUpdate", "webPresenceDelete"],
      afterWrite: false,
      writes: { marketUpdate: answer },
    });
    expect(await createMarketSubfolder(admin, "s", request)).toEqual({ ok: false, error });
    const cleanup = admin.graphql.mock.calls.find(([q]) => String(q).includes("appWebPresenceDelete"));
    expect(cleanup?.[1]).toEqual({ variables: { id: "wpEs" } });
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

  it("refuses a presence another market uses too — it would take that market's address along", async () => {
    const admin = shopAdmin({ mutations: ["webPresenceDelete"], afterWrite: false, startOwn: true, sharedWithPortugal: true });
    expect(await removeMarketAddress(admin, "s", "mES")).toEqual({ ok: false, error: "presenceShared" });
    expect(admin.graphql.mock.calls.some(([q]) => /\bmutation app/.test(String(q)))).toBe(false);
  });
});

describe("adding and deleting a market", () => {
  const addresses = {
    sharedUrl: null,
    takenSuffixes: [],
    markets: [{ marketId: "mCH", name: "Schweiz", status: "ACTIVE", primary: null, own: null }],
  };

  it("validates name and countries", () => {
    expect(validateMarketRequest({ name: " Nordics ", countries: ["se", "NO", "se"] }, addresses)).toEqual({
      ok: true,
      name: "Nordics",
      countries: ["SE", "NO"],
    });
    expect(validateMarketRequest({ name: "schweiz", countries: ["CH"] }, addresses)).toEqual({ ok: false, error: "marketNameTaken" });
    expect(validateMarketRequest({ name: "X", countries: [] }, addresses)).toEqual({ ok: false, error: "invalidCountries" });
  });

  function marketAdmin(inputFields: string[], opts: { created?: boolean; deleted?: boolean } = {}) {
    let wrote = false;
    return {
      graphql: vi.fn(async (query: string, _opts?: { variables?: Record<string, unknown> }) => {
        let body: unknown;
        if (query.includes("appMutationNames")) {
          body = { data: { __schema: { mutationType: { fields: [{ name: "marketCreate" }, { name: "marketDelete" }] } } } };
        } else if (query.includes("appMarketFields")) {
          body = { data: { __type: { fields: [{ name: "primary" }] } } };
        } else if (query.includes("appMarketPrimary")) {
          body = { data: { markets: { nodes: [{ id: "mCH", primary: true }] } } };
        } else if (query.includes("appInputShape")) {
          body = { data: { __type: { inputFields: inputFields.map((name) => ({ name })) } } };
        } else if (query.includes("appMarketAddressPresences")) {
          body = state(false).presences;
        } else if (query.includes("appMarketAddressMarkets")) {
          const base = state(false).markets as any;
          const nodes = [...base.data.markets.nodes];
          if (wrote && opts.created) nodes.push({ id: "mNEW", name: "Nordics", status: "DRAFT", webPresences: { nodes: [] } });
          const filtered = wrote && opts.deleted ? nodes.filter((n: any) => n.id !== "mES") : nodes;
          body = { data: { markets: { pageInfo: { hasNextPage: false }, nodes: filtered } } };
        } else if (query.includes("appMarketCreate")) {
          wrote = true;
          body = { data: { marketCreate: { market: { id: "mNEW" }, userErrors: [] } } };
        } else if (query.includes("appMarketDelete")) {
          wrote = true;
          body = { data: { marketDelete: { deletedId: "mES", userErrors: [] } } };
        }
        return { json: async () => body } as unknown as Response;
      }),
    };
  }

  it("creates a DRAFT market with the countries where the current input puts them", async () => {
    const admin = marketAdmin(["name", "conditions", "status"], { created: true });
    expect(await createMarket(admin, "s", { name: "Nordics", countries: ["SE", "NO"] })).toEqual({ ok: true, marketId: "mNEW" });
    const call = admin.graphql.mock.calls.find(([q]) => String(q).includes("appMarketCreate"));
    expect(call?.[1]).toEqual({
      variables: {
        input: {
          name: "Nordics",
          conditions: { regionsCondition: { regions: [{ countryCode: "SE" }, { countryCode: "NO" }] } },
          status: "DRAFT",
        },
      },
    });
  });

  it("uses the older regions/enabled shape where that is what the input has", async () => {
    const admin = marketAdmin(["name", "regions", "enabled"], { created: true });
    await createMarket(admin, "s", { name: "Nordics", countries: ["SE"] });
    const call = admin.graphql.mock.calls.find(([q]) => String(q).includes("appMarketCreate"));
    expect(call?.[1]).toEqual({ variables: { input: { name: "Nordics", regions: [{ countryCode: "SE" }], enabled: false } } });
  });

  it("a create the re-read does not show is notConfirmed", async () => {
    const admin = marketAdmin(["name", "conditions", "status"], { created: false });
    expect(await createMarket(admin, "s", { name: "Nordics", countries: ["SE"] })).toEqual({ ok: false, error: "notConfirmed" });
  });

  it("never deletes the primary market", async () => {
    const admin = marketAdmin([], { deleted: true });
    expect(await deleteMarket(admin, "s", "mCH")).toEqual({ ok: false, error: "primaryMarket" });
    expect(admin.graphql.mock.calls.some(([q]) => String(q).includes("appMarketDelete"))).toBe(false);
  });

  it("deletes on the echoed id AND the market's absence from a fresh read", async () => {
    expect(await deleteMarket(marketAdmin([], { deleted: true }), "s", "mES")).toEqual({ ok: true });
    expect(await deleteMarket(marketAdmin([], { deleted: false }), "s", "mES")).toEqual({ ok: false, error: "notConfirmed" });
  });
});
