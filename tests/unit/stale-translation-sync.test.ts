/**
 * Unit tests — the sync-side stale-translation reconciliation.
 *
 * These cover the two paths where a bug costs the merchant translation content
 * that cannot be recovered:
 *   - the removal must be scoped per LOCALE (translationsRemove takes keys ×
 *     locales as a cross product, so sending the union deletes translations
 *     nobody flagged), and a local row may only go once Shopify confirms it;
 *   - a translation Shopify CONFIRMED must never end up in the purge fallback
 *     because the local mirror write failed afterwards.
 *
 * Shopify, the database and the AI provider are mocked (image-operations.test.ts
 * convention); the module's own logic is real.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { db, shopify, ai, policy } = vi.hoisted(() => {
  const db = {
    contentTranslation: {
      deleteMany: vi.fn(async () => ({ count: 1 })),
      upsert: vi.fn(async () => ({})),
      findMany: vi.fn(async () => []),
    },
    aISettings: { findUnique: vi.fn(async () => ({ preferredProvider: "claude" })) },
    aIInstructions: { findUnique: vi.fn(async () => null) },
    task: {
      create: vi.fn(async () => ({ id: "task-1" })),
      update: vi.fn(async () => ({})),
    },
  };
  const shopify = {
    /** locale → keys Shopify confirms it removed. Default: everything asked for. */
    removeConfirms: null as null | Record<string, string[]>,
    removeCalls: [] as Array<{ keys: string[]; locale: string }>,
    registerConfirms: null as null | string[],
    registerCalls: [] as Array<{ key: string; locale: string; value: string }>,
  };
  const ai = { translate: vi.fn(async () => ({})) as any };
  const policy = { purgeOnPrimaryChange: true, autoTranslateExternalChanges: false, plan: "max" };
  return { db, shopify, ai, policy };
});

vi.mock("../../app/db.server", () => ({ db, default: db }));

vi.mock("../../app/services/bulk-editor/translations.server", () => ({
  removeAndVerify: vi.fn(async (_gw: unknown, _id: string, keys: string[], locale: string) => {
    shopify.removeCalls.push({ keys, locale });
    const confirmed = shopify.removeConfirms ? (shopify.removeConfirms[locale] ?? []) : keys;
    return { confirmedKeys: new Set(confirmed), userErrors: [] };
  }),
  registerAndVerify: vi.fn(
    async (_gw: unknown, _id: string, inputs: Array<{ key: string; locale: string; value: string }>) => {
      for (const input of inputs) shopify.registerCalls.push(input);
      const confirmed = shopify.registerConfirms ?? inputs.map((i) => i.key);
      return { confirmedKeys: new Set(confirmed), userErrors: [] };
    },
  ),
}));

vi.mock("../../app/services/translations/translation-change-policy.server", () => ({
  loadTranslationChangePolicy: vi.fn(async () => policy),
  isPurgeOnPrimaryChangeEnabled: vi.fn(async () => policy.purgeOnPrimaryChange),
}));

vi.mock("../../src/services/translation.service", () => ({
  TranslationService: class {
    translateProduct(...args: unknown[]) {
      return ai.translate(...args);
    }
  },
}));

import {
  reconcileStaleTranslations,
  awaitDetachedRetranslations,
} from "../../app/services/translations/stale-translation-sync.server";

const SHOP = "test.myshopify.com";
const OLD = "digest-old";
const NEW = "digest-new";

// A fresh resource id per test: a successful reconciliation marks its resource
// as "just written" (translation-save-lock), which deliberately makes the next
// reconciliation of the SAME resource bail — sharing one id across tests would
// have every case after the first silently do nothing.
let nextProductId = 0;
const freshProduct = () => `gid://shopify/Product/${++nextProductId}`;

/** A reconcile call where `title` (de) and `body_html` (fr) are the stale set. */
function baseParams(over: Record<string, unknown> = {}) {
  return {
    client: { graphql: vi.fn() } as never,
    shop: SHOP,
    resourceId: freshProduct(),
    resourceType: "Product",
    contentKind: "product" as const,
    resourceTitle: "Box",
    translations: [
      { key: "title", value: "Titre", locale: "de", marketId: "", outdated: true },
      { key: "body_html", value: "Corps", locale: "fr", marketId: "", outdated: true },
    ],
    primaryContent: {
      title: { value: "Box", digest: NEW },
      body_html: { value: "<p>Box</p>", digest: NEW },
    },
    previousDigests: { title: OLD, body_html: OLD },
    ...over,
  };
}

beforeEach(() => {
  shopify.removeCalls = [];
  shopify.registerCalls = [];
  shopify.removeConfirms = null;
  shopify.registerConfirms = null;
  policy.purgeOnPrimaryChange = true;
  policy.autoTranslateExternalChanges = false;
  db.contentTranslation.deleteMany.mockClear();
  db.contentTranslation.upsert.mockClear();
  db.contentTranslation.upsert.mockImplementation(async () => ({}));
  ai.translate = vi.fn(async () => ({}));
});

describe("purge path", () => {
  it("removes each locale's OWN keys, never the union across locales", async () => {
    // title is stale in de, body_html in fr. Sending {title, body_html} × {de, fr}
    // would delete fr's current title and de's current body_html on Shopify.
    const result = await reconcileStaleTranslations(baseParams());

    expect(result.removed).toBe(2);
    expect(shopify.removeCalls).toHaveLength(2);
    expect(shopify.removeCalls.find((c) => c.locale === "de")?.keys).toEqual(["title"]);
    expect(shopify.removeCalls.find((c) => c.locale === "fr")?.keys).toEqual(["body_html"]);
  });

  it("deletes the local row only for keys Shopify confirmed", async () => {
    shopify.removeConfirms = { de: ["title"], fr: [] }; // fr silently no-ops
    await reconcileStaleTranslations(baseParams());

    const deletes = db.contentTranslation.deleteMany.mock.calls.map((c: any[]) => c[0].where);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toMatchObject({ locale: "de", key: { in: ["title"] }, marketId: "" });
  });

  it("does nothing at all when the merchant switched the purge off", async () => {
    policy.purgeOnPrimaryChange = false;
    const result = await reconcileStaleTranslations(baseParams());

    expect(result).toEqual({ removed: 0, retranslating: 0 });
    expect(shopify.removeCalls).toEqual([]);
    expect(db.contentTranslation.deleteMany).not.toHaveBeenCalled();
  });

  it("touches nothing when this sync saw no digest change", async () => {
    const result = await reconcileStaleTranslations(
      baseParams({ previousDigests: { title: NEW, body_html: NEW } }),
    );
    expect(result).toEqual({ removed: 0, retranslating: 0 });
    expect(shopify.removeCalls).toEqual([]);
  });
});

describe("auto-translation path (Max)", () => {
  beforeEach(() => {
    policy.autoTranslateExternalChanges = true;
  });

  it("registers the re-translation instead of purging", async () => {
    ai.translate = vi.fn(async (fields: Record<string, string>, locales: string[]) => ({
      [locales[0]]: Object.fromEntries(Object.keys(fields).map((k) => [k, `translated-${k}`])),
    }));

    const result = await reconcileStaleTranslations(baseParams());
    expect(result.retranslating).toBe(2);
    await awaitDetachedRetranslations();

    expect(shopify.registerCalls).toHaveLength(2);
    expect(shopify.removeCalls).toEqual([]);
    expect(db.contentTranslation.upsert).toHaveBeenCalledTimes(2);
  });

  it("falls back to the purge when the AI fails — the stale text must not survive", async () => {
    ai.translate = vi.fn(async () => {
      throw new Error("provider down");
    });

    await reconcileStaleTranslations(baseParams());
    await awaitDetachedRetranslations();

    expect(shopify.registerCalls).toEqual([]);
    expect(shopify.removeCalls.map((c) => c.locale).sort()).toEqual(["de", "fr"]);
  });

  it("falls back to the purge for a key Shopify did not echo back", async () => {
    ai.translate = vi.fn(async (fields: Record<string, string>, locales: string[]) => ({
      [locales[0]]: Object.fromEntries(Object.keys(fields).map((k) => [k, `translated-${k}`])),
    }));
    shopify.registerConfirms = []; // nothing echoed → nothing verified

    await reconcileStaleTranslations(baseParams());
    await awaitDetachedRetranslations();

    expect(shopify.removeCalls.map((c) => c.locale).sort()).toEqual(["de", "fr"]);
  });

  it("NEVER purges a translation Shopify confirmed just because the local mirror failed", async () => {
    ai.translate = vi.fn(async (fields: Record<string, string>, locales: string[]) => ({
      [locales[0]]: Object.fromEntries(Object.keys(fields).map((k) => [k, `translated-${k}`])),
    }));
    db.contentTranslation.upsert.mockImplementation(async () => {
      throw new Error("connection pool exhausted");
    });

    await reconcileStaleTranslations(baseParams());
    await awaitDetachedRetranslations();

    // Written and verified on Shopify — a local write failure is a mirror
    // problem, not a reason to delete storefront content.
    expect(shopify.registerCalls).toHaveLength(2);
    expect(shopify.removeCalls).toEqual([]);
  });

  it("does not start a second run for a resource whose run is still going", async () => {
    // The gate is created UP FRONT: the detached run reaches the AI call only
    // after several awaits, so a `release` assigned inside the mock would still
    // be undefined when the test wants to open it.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    ai.translate = vi.fn(async () => {
      await gate;
      return {};
    });

    // Two webhooks for the SAME product, as Shopify emits for one admin save.
    const sameProduct = freshProduct();
    const first = await reconcileStaleTranslations(baseParams({ resourceId: sameProduct }));
    const second = await reconcileStaleTranslations(baseParams({ resourceId: sameProduct }));

    expect(first.retranslating).toBe(2);
    expect(second.retranslating).toBe(0);

    release();
    await awaitDetachedRetranslations();
  });
});
