/**
 * restoreLinkTranslations echo matching (PLAN_TRANSLATION_WRITE_UNIFICATION
 * Phase G): per (locale, market), shared matcher, behaviour otherwise unchanged.
 */
import { describe, it, expect, vi } from "vitest";
import { restoreLinkTranslations } from "../../app/services/menu-translation-repair.server";

const LINK = "gid://shopify/Link/5";
const MARKET = "gid://shopify/Market/1";

function gatewayEchoing(echo: (sent: any[]) => any[]) {
  return {
    graphql: vi.fn(async (query: string, opts?: { variables?: any }) => {
      if (query.includes("translationsRegister")) {
        return {
          json: async () => ({
            data: { translationsRegister: { translations: echo(opts!.variables.translations), userErrors: [] } },
          }),
        };
      }
      return { json: async () => ({ data: { translatableResource: { translatableContent: [{ key: "title", digest: "dg" }] } } }) };
    }),
  } as never;
}

function makeDb() {
  return { contentTranslation: { upsert: vi.fn(async (a: any) => a) } } as any;
}

const captured = [
  {
    linkId: LINK,
    values: [
      { locale: "pt-BR", marketId: "", value: "Ola" },
      { locale: "en", marketId: MARKET, value: "Hi market" },
    ],
  },
];
const exact = (sent: any[]) =>
  sent.map((s) => ({ key: s.key, locale: s.locale, value: s.value, market: s.marketId ? { id: s.marketId } : null }));

describe("restoreLinkTranslations echo", () => {
  it("restores and mirrors every value the echo carries", async () => {
    const db = makeDb();
    const out = await restoreLinkTranslations(gatewayEchoing(exact), db, "s", captured);
    expect(out).toEqual({ restored: 2, failed: [] });
    expect(db.contentTranslation.upsert).toHaveBeenCalledTimes(2);
  });

  it("a value the echo does not carry is reported and not mirrored", async () => {
    const db = makeDb();
    const out = await restoreLinkTranslations(gatewayEchoing((s) => exact(s).slice(0, 1)), db, "s", captured);
    expect(out.restored).toBe(1);
    expect(out.failed[0].message).toContain(`en / ${MARKET}`);
    expect(db.contentTranslation.upsert).toHaveBeenCalledTimes(1);
  });

  it("a global value is not confirmed by an echo of the same locale in a market", async () => {
    const db = makeDb();
    const out = await restoreLinkTranslations(
      gatewayEchoing((s) => exact(s).map((e) => (e.locale === "pt-BR" ? { ...e, market: { id: MARKET } } : e))),
      db, "s", captured,
    );
    expect(out.restored).toBe(1);
    expect(out.failed).toHaveLength(1);
  });

  it("a market value is not confirmed by a global echo", async () => {
    const db = makeDb();
    const out = await restoreLinkTranslations(
      gatewayEchoing((s) => exact(s).map((e) => (e.locale === "en" ? { ...e, market: null } : e))),
      db, "s", captured,
    );
    expect(out.restored).toBe(1);
  });

  it("a differently-cased locale in the echo is the same translation (pt-BR sent, pt-br echoed)", async () => {
    const db = makeDb();
    const out = await restoreLinkTranslations(
      gatewayEchoing((s) => exact(s).map((e) => (e.locale === "pt-BR" ? { ...e, locale: "pt-br" } : e))),
      db, "s", captured,
    );
    expect(out).toEqual({ restored: 2, failed: [] });
    const first = db.contentTranslation.upsert.mock.calls[0][0];
    expect(first.where.shop_resourceId_key_locale_marketId.locale).toBe("pt-BR");
  });
});
