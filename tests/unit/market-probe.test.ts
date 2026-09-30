/**
 * The market probe WRITES to a merchant's shop, so what it leaves behind is the
 * part that must be pinned: against a stateful fake Shopify, every run ends
 * with the shop exactly as it started — on the happy path, when marketDelete
 * leaves an attached presence behind, and when the attach itself throws.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}));
vi.mock("~/utils/shop-locales-cache.server", () => ({ clearShopLocalesCache: vi.fn() }));
vi.mock("../../app/utils/shop-locales-cache.server", () => ({ clearShopLocalesCache: vi.fn() }));

let fake: ReturnType<typeof makeShop>;
vi.mock("~/shopify.server", () => ({
  authenticate: { admin: async () => ({ admin: fake.admin, session: { shop: "probe.myshopify.com" } }) },
}));
vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ admin: fake.admin, session: { shop: "probe.myshopify.com" } }) },
}));

const { action } = await import("~/routes/api.market-probe");
const { __resetMarketAddressCache } = await import("~/services/market-address.server");

const done = { hasNextPage: false };

function makeShop(opts: {
  deleteTakesPresence: boolean;
  attachThrows?: boolean;
  addOnly?: boolean;
  /** Assigning a presence publishes the locale (unmeasured in reality). */
  assignPublishes?: boolean;
  /** The next N market reads leave the newest market out (a lagging read). */
  hideNewMarketReads?: number;
}) {
  let hidden = opts.hideNewMarketReads ?? 0;
  const markets: Array<{ id: string; name: string; status: string; presences: string[] }> = [
    { id: "mCH", name: "Schweiz", status: "ACTIVE", presences: [] },
  ];
  const presences: Array<{ id: string; suffix: string | null; defaultLocale: string }> = [
    { id: "wpShared", suffix: null, defaultLocale: "de" },
  ];
  const locales = [
    { locale: "de", primary: true, published: true, presences: ["wpShared"] },
    { locale: "en", primary: false, published: true, presences: ["wpShared"] },
    { locale: "nl", primary: false, published: false, presences: [] as string[] },
  ];
  let seq = 0;
  const reply = (data: unknown) => ({ json: async () => ({ data }) }) as unknown as Response;
  const presenceNode = (p: (typeof presences)[number]) => ({
    id: p.id,
    subfolderSuffix: p.suffix,
    domain: { host: "shop.example" },
    defaultLocale: { locale: p.defaultLocale },
    alternateLocales: [],
    rootUrls: [{ locale: p.defaultLocale, url: `https://shop.example/${p.suffix ? `${p.defaultLocale}-${p.suffix}/` : ""}` }],
    markets: {
      pageInfo: done,
      nodes: markets.filter((m) => m.presences.includes(p.id)).map((m) => ({ id: m.id, name: m.name, status: m.status })),
    },
  });
  const dropPresence = (id: string) => {
    const i = presences.findIndex((p) => p.id === id);
    if (i >= 0) presences.splice(i, 1);
    for (const m of markets) m.presences = m.presences.filter((x) => x !== id);
    for (const l of locales) l.presences = l.presences.filter((x) => x !== id);
  };
  const graphql = vi.fn(async (query: string, o?: { variables?: Record<string, any> }) => {
    const v = o?.variables ?? {};
    if (query.includes("appMutationNames")) {
      return reply({
        __schema: { mutationType: { fields: ["webPresenceCreate", "marketUpdate", "webPresenceDelete", "marketCreate", "marketDelete"].map((name) => ({ name })) } },
      });
    }
    if (query.includes("marketProbeMutations")) {
      return reply({ __schema: { mutationType: { fields: [{ name: "marketCreate", isDeprecated: false, args: [] }] } } });
    }
    if (query.includes("marketProbeInputShape")) return reply({ __type: null });
    if (query.includes("appInputShape")) {
      return reply({ __type: { inputFields: (v.name === "MarketCreateInput" ? ["name", "conditions", "status"] : []).map((name) => ({ name })) } });
    }
    if (query.includes("appMarketFields")) return reply({ __type: { fields: [{ name: "id" }] } });
    if (query.includes("appMarketAddressPresences") || query.includes("marketProbePresences")) {
      return reply({ webPresences: { pageInfo: done, nodes: presences.map(presenceNode) } });
    }
    if (query.includes("appMarketAddressMarkets")) {
      const visible = hidden > 0 && markets.length > 1 ? (hidden--, markets.slice(0, -1)) : markets;
      return reply({
        markets: {
          pageInfo: done,
          nodes: visible.map((m) => ({
            id: m.id,
            name: m.name,
            status: m.status,
            webPresences: { pageInfo: done, nodes: m.presences.map((id) => ({ id })) },
          })),
        },
      });
    }
    if (query.includes("appMarketCreate")) {
      const id = `mNEW${++seq}`;
      markets.push({ id, name: v.input.name, status: v.input.status ?? "ACTIVE", presences: [] });
      return reply({ marketCreate: { market: { id }, userErrors: [] } });
    }
    if (query.includes("appWebPresenceCreate")) {
      const id = `wpNEW${++seq}`;
      presences.push({ id, suffix: v.input.subfolderSuffix, defaultLocale: v.input.defaultLocale });
      return reply({ webPresenceCreate: { webPresence: { id }, userErrors: [] } });
    }
    if (query.includes("appMarketAttachPresence")) {
      if (opts.attachThrows) {
        throw Object.assign(new Error("Field 'webPresencesToAdd' doesn't exist"), {
          body: { errors: { graphQLErrors: [{ message: "Field 'webPresencesToAdd' doesn't exist" }] } },
        });
      }
      markets.find((m) => m.id === v.id)!.presences.push(...v.input.webPresencesToAdd);
      return reply({ marketUpdate: { market: { id: v.id }, userErrors: [] } });
    }
    if (query.includes("appWebPresenceDelete") || query.includes("marketProbePresenceDelete")) {
      dropPresence(v.id);
      return reply({ webPresenceDelete: { userErrors: [] } });
    }
    if (query.includes("marketProbeMarketDelete") || query.includes("appMarketDelete")) {
      const m = markets.find((x) => x.id === v.id);
      if (!m) return reply({ marketDelete: { deletedId: null, userErrors: [{ message: "not found" }] } });
      if (opts.deleteTakesPresence) for (const id of [...m.presences]) dropPresence(id);
      markets.splice(markets.indexOf(m), 1);
      return reply({ marketDelete: { deletedId: v.id, userErrors: [] } });
    }
    if (query.includes("marketProbeShopLocales")) {
      return reply({ shopLocales: locales.map((l) => ({ ...l, marketWebPresences: l.presences.map((id) => ({ id })) })) });
    }
    if (query.includes("marketProbeLocalePresences")) {
      const l = locales.find((x) => x.locale === v.locale)!;
      if (typeof v.shopLocale.published === "boolean") l.published = v.shopLocale.published;
      const ids: string[] | undefined = v.shopLocale.marketWebPresenceIds;
      if (ids) {
        if (opts.assignPublishes && ids.length > l.presences.length) l.published = true;
        l.presences = opts.addOnly ? [...new Set([...l.presences, ...ids])] : [...ids];
      }
      return reply({ shopLocaleUpdate: { shopLocale: { locale: l.locale, published: l.published, marketWebPresences: [] }, userErrors: [] } });
    }
    // Everything else (the tab's language-presence read) is refused — the probe
    // must carry on without it.
    return { json: async () => ({ errors: [{ message: "unknown in fake" }], data: null }) } as unknown as Response;
  });
  return { admin: { graphql }, markets, presences, locales };
}

async function run() {
  const fd = new FormData();
  fd.set("confirm", "true");
  const response = (await action({ request: new Request("https://app/api/market-probe", { method: "POST", body: fd }) } as any)) as any;
  return (response.data ?? response).report as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetMarketAddressCache();
  process.env.APP_ENV = "development";
});

describe("market probe", () => {
  it("measures every step and leaves the shop exactly as it found it", async () => {
    fake = makeShop({ deleteTakesPresence: true });
    const report = await run();
    const outcome = (id: string) => report.steps.find((s: any) => s.id === id)?.outcome;
    expect(outcome("createMarket")).toBe("ok");
    expect(outcome("subfolder")).toBe("ok");
    expect(outcome("languages")).toBe("ok");
    expect(report.steps.find((s: any) => s.id === "languages").detail).toContain("REPLACE");
    expect(outcome("removeAddress")).toBe("ok");
    expect(report.steps.find((s: any) => s.id === "deleteWithPresence").detail).toContain("went WITH the market");
    expect(report.cleanup.allRemoved).toBe(true);
    expect(fake.markets.map((m) => m.id)).toEqual(["mCH"]);
    expect(fake.presences.map((p) => p.id)).toEqual(["wpShared"]);
    expect(fake.locales.find((l) => l.locale === "en")!.presences).toEqual(["wpShared"]);
    // The UNPUBLISHED language is the one written to, and it is back as it was.
    expect(report.steps.find((s: any) => s.id === "languages").title).toContain('"nl"');
    expect(fake.locales.find((l) => l.locale === "nl")).toMatchObject({ published: false, presences: [] });
  });

  it("puts a publication back that the assignment moved", async () => {
    fake = makeShop({ deleteTakesPresence: true, assignPublishes: true });
    const report = await run();
    expect(report.steps.find((s: any) => s.id === "languages").detail).toContain("MOVED the publication");
    expect(fake.locales.find((l) => l.locale === "nl")).toMatchObject({ published: false, presences: [] });
    expect(report.cleanup.allRemoved).toBe(true);
  });

  it("finds a market whose create the app could not confirm, instead of creating a second one", async () => {
    fake = makeShop({ deleteTakesPresence: true, hideNewMarketReads: 1 });
    const report = await run();
    expect(report.steps.find((s: any) => s.id === "createMarket").detail).toContain("EXISTS nevertheless");
    expect(fake.admin.graphql.mock.calls.filter(([q]) => String(q).includes("appMarketCreate"))).toHaveLength(1);
    expect(fake.markets.map((m) => m.id)).toEqual(["mCH"]);
    expect(report.cleanup.allRemoved).toBe(true);
  });

  it("reports ADD-ONLY semantics and a presence marketDelete leaves behind — and still cleans up", async () => {
    fake = makeShop({ deleteTakesPresence: false, addOnly: true });
    const report = await run();
    expect(report.steps.find((s: any) => s.id === "languages").detail).toContain("ADD-ONLY");
    expect(report.steps.find((s: any) => s.id === "deleteWithPresence").detail).toContain("SURVIVED");
    expect(report.cleanup.allRemoved).toBe(true);
    expect(fake.markets.map((m) => m.id)).toEqual(["mCH"]);
    expect(fake.presences.map((p) => p.id)).toEqual(["wpShared"]);
  });

  it("a thrown attach is reported and neither the presence nor the market stays behind", async () => {
    fake = makeShop({ deleteTakesPresence: true, attachThrows: true });
    const report = await run();
    expect(report.steps.find((s: any) => s.id === "subfolder").outcome).toBe("failed");
    expect(report.steps.find((s: any) => s.id === "subfolder").detail).toContain("webPresencesToAdd");
    expect(report.cleanup.allRemoved).toBe(true);
    expect(fake.markets.map((m) => m.id)).toEqual(["mCH"]);
    expect(fake.presences.map((p) => p.id)).toEqual(["wpShared"]);
  });

  it("refuses outside development and without the confirmation", async () => {
    fake = makeShop({ deleteTakesPresence: true });
    process.env.APP_ENV = "production";
    const fd = new FormData();
    fd.set("confirm", "true");
    const refused = (await action({ request: new Request("https://app/x", { method: "POST", body: fd }) } as any)) as any;
    expect(refused.init?.status ?? refused.status).toBe(403);
    process.env.APP_ENV = "development";
    const unconfirmed = (await action({ request: new Request("https://app/x", { method: "POST", body: new FormData() }) } as any)) as any;
    expect(unconfirmed.init?.status ?? unconfirmed.status).toBe(400);
    expect(fake.admin.graphql).not.toHaveBeenCalled();
  });
});
