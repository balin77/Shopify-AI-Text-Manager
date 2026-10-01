import { describe, it, expect, vi } from "vitest";
import {
  registerAndVerify,
  removeAndVerify,
  removeAndVerifyAcrossLocales,
  registerWithDigests,
  mirrorConfirmedContentTranslations,
  LOCALE_KEY_SEP,
  type GraphqlClient,
} from "~/services/translations/verified-translations.server";
import * as bulk from "~/services/bulk-editor/translations.server";

/**
 * Phase A of PLAN_TRANSLATION_WRITE_UNIFICATION: the verified helpers live in
 * translations/verified-translations.server.ts, the bulk editor re-exports.
 */

const RID = "gid://shopify/Product/1";
const SHOP = "s.myshopify.com";

function fakeClient(respond: (query: string, variables?: Record<string, unknown>) => unknown) {
  const calls: { query: string; variables?: Record<string, unknown> }[] = [];
  const client: GraphqlClient = {
    graphql: async (query, opts) => {
      calls.push({ query, variables: opts?.variables });
      const data = respond(query, opts?.variables);
      return { json: async () => data };
    },
  };
  return { client, calls };
}

const registerEcho = (translations: unknown[]) => ({
  data: { translationsRegister: { translations, userErrors: [] } },
});

describe("bulk-editor re-exports", () => {
  it("exposes the very same functions", () => {
    expect(bulk.registerAndVerify).toBe(registerAndVerify);
    expect(bulk.removeAndVerify).toBe(removeAndVerify);
    expect(bulk.removeAndVerifyAcrossLocales).toBe(removeAndVerifyAcrossLocales);
    expect(bulk.LOCALE_KEY_SEP).toBe(LOCALE_KEY_SEP);
  });
});

describe("case-insensitive locale matching (sent spelling wins)", () => {
  it("registerAndVerify confirms pt-BR sent / pt-br echoed", async () => {
    const { client } = fakeClient(() => registerEcho([{ key: "title", locale: "pt-br", value: "Olá" }]));
    const r = await registerAndVerify(client, RID, [
      { key: "title", value: "Olá", locale: "pt-BR", translatableContentDigest: "d" },
    ]);
    expect([...r.confirmedKeys]).toEqual(["title"]);
    expect(r.confirmedValues.get("title")).toBe("Olá");
  });

  it("removeAndVerify confirms pt-BR sent / pt-br echoed", async () => {
    const { client, calls } = fakeClient(() => ({
      data: { translationsRemove: { translations: [{ key: "title", locale: "pt-br" }], userErrors: [] } },
    }));
    const r = await removeAndVerify(client, RID, ["title"], "pt-BR", "");
    expect(r.confirmedKeys.has("title")).toBe(true);
    expect(calls).toHaveLength(1); // no re-read needed
  });

  it("removeAndVerifyAcrossLocales keys confirmedPairs by the SENT spelling", async () => {
    const { client } = fakeClient(() => ({
      data: { translationsRemove: { translations: [{ key: "title", locale: "pt-br" }], userErrors: [] } },
    }));
    const { confirmedPairs } = await removeAndVerifyAcrossLocales(client, RID, ["title"], ["pt-BR", "de"], "");
    expect([...confirmedPairs]).toEqual([`pt-BR${LOCALE_KEY_SEP}title`]);
  });

  it("a different locale is still not a match", async () => {
    const { client } = fakeClient(() => registerEcho([{ key: "title", locale: "de", value: "x" }]));
    const r = await registerAndVerify(client, RID, [
      { key: "title", value: "x", locale: "fr", translatableContentDigest: "d" },
    ]);
    expect(r.confirmedKeys.size).toBe(0);
  });
});

describe("registerWithDigests", () => {
  const digestResponse = (digests: Record<string, string>) => ({
    data: {
      translatableResource: {
        translatableContent: Object.entries(digests).map(([key, digest]) => ({ key, digest })),
      },
    },
  });

  it("registers only keys with a digest and reports the rest in noDigest", async () => {
    const { client, calls } = fakeClient((query) =>
      query.includes("translationsRegister")
        ? registerEcho([{ key: "title", locale: "fr", value: "Titre" }])
        : digestResponse({ title: "dt" }),
    );
    const r = await registerWithDigests(client, RID, "fr", [
      { key: "title", value: "Titre" },
      { key: "product_type", value: "Type" },
    ]);
    expect([...r.confirmedKeys]).toEqual(["title"]);
    expect(r.noDigest).toEqual(["product_type"]);
    expect(r.digests.get("title")).toBe("dt");
    const sent = calls.find((c) => c.query.includes("translationsRegister"))!;
    expect(sent.variables?.translations).toEqual([
      { key: "title", value: "Titre", locale: "fr", translatableContentDigest: "dt" },
    ]);
    expect(calls).toHaveLength(2);
  });

  it("sends no register call when no key has a digest", async () => {
    const { client, calls } = fakeClient(() => digestResponse({}));
    const r = await registerWithDigests(client, RID, "fr", [{ key: "title", value: "x" }]);
    expect(r.noDigest).toEqual(["title"]);
    expect(calls.filter((c) => c.query.includes("translationsRegister"))).toHaveLength(0);
  });

  it("throws when the resource itself does not answer, never reporting every key as no-digest", async () => {
    // An absent translatableResource looks exactly like "no key has a digest";
    // a caller that mirrors no-digest keys locally must never see it as that.
    const { client, calls } = fakeClient(() => ({ data: { translatableResource: null } }));
    await expect(registerWithDigests(client, RID, "fr", [{ key: "title", value: "x" }])).rejects.toThrow(
      /not found/,
    );
    expect(calls.filter((c) => c.query.includes("translationsRegister"))).toHaveLength(0);
  });

  it("sends every value under the ONE locale and market of the call", async () => {
    const { client, calls } = fakeClient((query) =>
      query.includes("translationsRegister")
        ? registerEcho([{ key: "title", locale: "de", value: "T" }])
        : digestResponse({ title: "dt" }),
    );
    await registerWithDigests(client, RID, "de", [{ key: "title", value: "T" }], "gid://shopify/Market/1");
    const sent = calls.find((c) => c.query.includes("translationsRegister"))!;
    expect(sent.variables?.translations).toEqual([
      { key: "title", value: "T", locale: "de", translatableContentDigest: "dt", marketId: "gid://shopify/Market/1" },
    ]);
  });
});

describe("mirrorConfirmedContentTranslations", () => {
  function fakeDb() {
    const upsert = vi.fn(async (_args: unknown) => ({}));
    return { db: { contentTranslation: { upsert } } as never, upsert };
  }
  const base = { shop: SHOP, resourceId: RID, resourceType: "Product", locale: "pt-BR" };

  it("upserts confirmed keys only, with digest, under the sent locale spelling", async () => {
    const { db, upsert } = fakeDb();
    const out = await mirrorConfirmedContentTranslations(db, {
      ...base,
      sent: [
        { key: "title", value: "sent" },
        { key: "body_html", value: "b" },
      ],
      result: { confirmedKeys: new Set(["title"]), confirmedValues: new Map() },
      digests: new Map([["title", "dt"], ["body_html", "db"]]),
    });
    expect(out).toEqual({ mirrored: ["title"], localOnly: [] });
    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0][0] as any;
    expect(arg.where.shop_resourceId_key_locale_marketId).toEqual({
      shop: SHOP, resourceId: RID, key: "title", locale: "pt-BR", marketId: "",
    });
    expect(arg.create).toMatchObject({ value: "sent", digest: "dt", resourceType: "Product", locale: "pt-BR" });
  });

  it("prefers the echoed value", async () => {
    const { db, upsert } = fakeDb();
    await mirrorConfirmedContentTranslations(db, {
      ...base,
      marketId: "gid://shopify/Market/1",
      sent: [{ key: "handle", value: "Foo Bar" }],
      result: { confirmedKeys: new Set(["handle"]), confirmedValues: new Map([["handle", "foo-bar"]]) },
      digests: new Map([["handle", "dh"]]),
    });
    const arg = upsert.mock.calls[0][0] as any;
    expect(arg.update.value).toBe("foo-bar");
    expect(arg.where.shop_resourceId_key_locale_marketId.marketId).toBe("gid://shopify/Market/1");
  });

  it("mirrors no-digest keys only with the opt-in, with a null digest", async () => {
    const args = {
      ...base,
      sent: [{ key: "product_type", value: "T" }],
      result: { confirmedKeys: new Set<string>(), confirmedValues: new Map<string, string>() },
      digests: new Map<string, string>(),
    };
    const off = fakeDb();
    expect(await mirrorConfirmedContentTranslations(off.db, args)).toEqual({ mirrored: [], localOnly: [] });
    expect(off.upsert).not.toHaveBeenCalled();

    const on = fakeDb();
    expect(await mirrorConfirmedContentTranslations(on.db, { ...args, mirrorWithoutDigest: true })).toEqual({
      mirrored: [],
      localOnly: ["product_type"],
    });
    expect((on.upsert.mock.calls[0][0] as any).create.digest).toBeNull();
  });

  it("never mirrors a key that had a digest, was sent and was not echoed", async () => {
    const { db, upsert } = fakeDb();
    const out = await mirrorConfirmedContentTranslations(db, {
      ...base,
      sent: [{ key: "title", value: "x" }],
      result: { confirmedKeys: new Set(), confirmedValues: new Map() },
      digests: new Map([["title", "dt"]]),
      mirrorWithoutDigest: true,
    });
    expect(out).toEqual({ mirrored: [], localOnly: [] });
    expect(upsert).not.toHaveBeenCalled();
  });
});
