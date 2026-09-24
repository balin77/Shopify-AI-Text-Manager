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
      // Only the kept-handle acknowledgement uses it: a digest advance with the
      // value untouched.
      updateMany: vi.fn(async (_args?: unknown) => ({ count: 1 })),
      // Takes the query: the market-override purge asks this same table for
      // `marketId: { not: "" }`, so a fake that ignores `where` would answer the
      // detection's rows to both and issue removals nobody asked for.
      findMany: vi.fn(
        async (
          _args?: unknown,
        ): Promise<Array<{ resourceId?: string; key: string; locale: string; marketId?: string }>> => [],
      ),
    },
    productImageAltTranslation: {
      findMany: vi.fn(async (): Promise<Array<{ imageId: string; locale: string }>> => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      upsert: vi.fn(async () => ({})),
    },
    // The alt mirror resolves the cache row FRESH on every operation — a
    // product sync deletes and recreates these rows, so a captured id is
    // dangling by the time a detached run writes (see the mirror's head
    // comment). The fake answers the CURRENT state of the table.
    productImage: {
      findMany: vi.fn(
        async (_args?: unknown): Promise<Array<{ id: string; mediaId: string | null }>> => [],
      ),
    },
    // The gate's second baseline, one row per resource. Default: no row — the
    // state of every resource right after the deploy.
    primaryDigestBaseline: {
      findUnique: vi.fn(async (_args?: unknown): Promise<{ digests: unknown } | null> => null),
      upsert: vi.fn(async (_args?: unknown) => ({})),
      // The compare-and-swap claim. Default: won.
      updateMany: vi.fn(async (_args?: unknown): Promise<{ count: number }> => ({ count: 1 })),
      // The full product sync's CREATE-ONLY seed.
      createMany: vi.fn(async (_args?: unknown) => ({ count: 1 })),
    },
    // The brake: `used` is what the conditional increment compares against.
    autoTranslateFillBudget: {
      createMany: vi.fn(async (_args?: unknown) => ({ count: 1 })),
      updateMany: vi.fn(async (_args?: unknown): Promise<{ count: number }> => ({ count: 1 })),
      // Only the cheap "already spent?" pre-check reads it; `used` is what it
      // compares. Default: no row — nothing spent.
      findUnique: vi.fn(async (_args?: unknown): Promise<{ used: number } | null> => null),
    },
    // The refusal count: ONE conditional-append statement returning the number
    // of distinct refused resources, so the array never travels.
    $queryRaw: vi.fn(async (..._args: unknown[]): Promise<Array<{ refused: number }>> => [{ refused: 1 }]),
    aISettings: { findUnique: vi.fn(async () => ({ preferredProvider: "claude" })) },
    aIInstructions: { findUnique: vi.fn(async () => null) },
    task: {
      // Echoes the id the caller minted: the repair hands that id back before
      // the detached run exists, so the row has to carry it.
      create: vi.fn(async (args?: { data?: { id?: string } }) => ({ id: args?.data?.id ?? "task-1" })),
      update: vi.fn(async () => ({})),
      upsert: vi.fn(async (_args?: unknown) => ({})),
    },
  };
  const shopify = {
    /** locale → keys Shopify confirms it removed. Default: everything asked for. */
    removeConfirms: null as null | Record<string, string[]>,
    removeCalls: [] as Array<{ keys: string[]; locale: string }>,
    /** Which Shopify RESOURCE each remove/register call addressed — a group can
     *  span several, and both mutations take exactly one. */
    removeTargets: [] as string[],
    registerTargets: [] as string[],
    /** Non-global layers a removal addressed — the market-override purge. */
    removeMarkets: [] as string[],
    /** The gap re-reads: what the folded removal did not echo back. */
    rereadCalls: [] as Array<{ keys: string[]; locale: string }>,
    rereadConfirms: null as null | Record<string, string[]>,
    registerConfirms: null as null | string[],
    registerCalls: [] as Array<{ key: string; locale: string; value: string }>,
    /** The foreign-URL redirects a handle re-translation asked for. */
    redirectCalls: [] as Array<{ from: string; to: string }>,
  };
  const ai = {
    translate: vi.fn(async () => ({})) as any,
    translateValues: vi.fn(async () => []) as any,
  };
  const policy = {
    purgeOnPrimaryChange: true,
    purgeUnreconciledSurfaces: true,
    autoTranslateExternalChanges: false,
    autoTranslateHandles: false,
    plan: "max",
  };
  return { db, shopify, ai, policy };
});

vi.mock("../../app/db.server", () => ({ db, default: db }));

vi.mock("../../app/services/bulk-editor/translations.server", () => ({
  LOCALE_KEY_SEP: "\u0000",
  // The gap path: keys the folded multi-locale call did not echo go through
  // `removeAndVerify`, which RE-READS before giving up.
  removeAndVerify: vi.fn(async (_gw: unknown, _id: string, keys: string[], locale: string) => {
    shopify.rereadCalls.push({ keys, locale });
    const confirmed = shopify.rereadConfirms ? (shopify.rereadConfirms[locale] ?? []) : [];
    return { confirmedKeys: new Set(confirmed), userErrors: [] };
  }),
  // The purge folds locales that ask for exactly the same keys into ONE call,
  // so the fake records one entry PER LOCALE to keep the assertions about
  // "each locale's own keys" meaningful.
  removeAndVerifyAcrossLocales: vi.fn(
    async (_gw: unknown, resourceId: string, keys: string[], locales: string[], marketId?: string) => {
      shopify.removeTargets.push(resourceId);
      if (marketId) shopify.removeMarkets.push(marketId);
      const confirmedPairs = new Set<string>();
      for (const locale of locales) {
        shopify.removeCalls.push({ keys, locale });
        const confirmed = shopify.removeConfirms ? (shopify.removeConfirms[locale] ?? []) : keys;
        for (const key of confirmed) {
          if (keys.includes(key)) confirmedPairs.add(`${locale}\u0000${key}`);
        }
      }
      return { confirmedPairs, userErrors: [] };
    },
  ),
  registerAndVerify: vi.fn(
    async (_gw: unknown, resourceId: string, inputs: Array<{ key: string; locale: string; value: string }>) => {
      for (const input of inputs) {
        shopify.registerCalls.push(input);
        shopify.registerTargets.push(resourceId);
      }
      const confirmed = shopify.registerConfirms ?? inputs.map((i) => i.key);
      return {
        confirmedKeys: new Set(confirmed),
        // What Shopify STORED — the value a redirect's target is built from.
        confirmedValues: new Map(
          inputs.filter((i) => confirmed.includes(i.key)).map((i) => [i.key, i.value]),
        ),
        userErrors: [],
      };
    },
  ),
}));

vi.mock("../../app/services/seo/handle-redirect.server", () => ({
  applyTranslatedHandleRedirect: vi.fn(async (_admin: unknown, _shop: string, request: any) => {
    shopify.redirectCalls.push({
      from: request.previousTranslatedHandle,
      to: request.nextTranslatedHandle,
    });
    return { created: true, noteCode: "created" as const };
  }),
  handleTakenByOtherResource: vi.fn(async () => false),
}));

// The PRODUCTION resolver factory, so the wiring that attaches it
// (`withHandleResolver`) is exercised by a test that passes no resolver of its
// own. `factory.resolver` is what the built resolver answers; null = no
// redirect possible.
const factory = vi.hoisted(() => ({
  built: 0,
  resolver: null as null | ((...args: unknown[]) => Promise<unknown>),
}));
vi.mock("../../app/services/translations/handle-retranslation.server", () => ({
  makeHandleRedirectResolver: vi.fn(() => {
    factory.built++;
    return async (...args: unknown[]) => (factory.resolver ? factory.resolver(...args) : null);
  }),
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
    translateValues(...args: unknown[]) {
      return ai.translateValues(...args);
    }
  },
}));

import {
  setReadBackRetryDelaysForTests,
  productImageAltMirror,
  featuredImageAltMirror,
  reconcileStaleTranslations,
  reconcileAfterPrimarySave,
  awaitDetachedRetranslations,
  IN_APP_RETRANSLATED_RESOURCE_TYPES,
} from "../../app/services/translations/stale-translation-sync.server";
import { digestBaselineKey } from "../../app/services/translations/stale-translations.shared";
import {
  markTranslationSaved,
  isTranslationRecentlySaved,
} from "../../app/utils/translation-save-lock.server";

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
    previousDigests: {
      [digestBaselineKey("de", "title")]: OLD,
      [digestBaselineKey("fr", "body_html")]: OLD,
    },
    ...over,
  };
}

beforeEach(() => {
  shopify.removeCalls = [];
  shopify.registerCalls = [];
  shopify.removeTargets = [];
  shopify.removeMarkets = [];
  shopify.registerTargets = [];
  shopify.rereadCalls = [];
  shopify.rereadConfirms = null;
  shopify.removeConfirms = null;
  shopify.registerConfirms = null;
  policy.purgeOnPrimaryChange = true;
  policy.purgeUnreconciledSurfaces = true;
  policy.autoTranslateExternalChanges = false;
  policy.autoTranslateHandles = false;
  shopify.redirectCalls = [];
  db.contentTranslation.deleteMany.mockClear();
  db.contentTranslation.upsert.mockClear();
  db.contentTranslation.updateMany.mockClear();
  db.productImage.findMany.mockClear();
  db.productImage.findMany.mockResolvedValue([]);
  db.productImageAltTranslation.upsert.mockClear();
  db.productImageAltTranslation.upsert.mockImplementation(async () => ({}));
  db.productImageAltTranslation.findMany.mockClear();
  db.productImageAltTranslation.findMany.mockResolvedValue([]);
  db.task.create.mockClear();
  db.task.create.mockImplementation(async (args?: { data?: { id?: string } }) => ({
    id: args?.data?.id ?? "task-1",
  }));
  db.task.update.mockClear();
  db.task.upsert.mockClear();
  db.primaryDigestBaseline.findUnique.mockReset();
  db.primaryDigestBaseline.findUnique.mockResolvedValue(null);
  db.primaryDigestBaseline.upsert.mockClear();
  db.primaryDigestBaseline.updateMany.mockReset();
  db.primaryDigestBaseline.updateMany.mockResolvedValue({ count: 1 });
  db.autoTranslateFillBudget.createMany.mockClear();
  db.autoTranslateFillBudget.updateMany.mockReset();
  db.autoTranslateFillBudget.updateMany.mockResolvedValue({ count: 1 });
  db.autoTranslateFillBudget.findUnique.mockReset();
  db.autoTranslateFillBudget.findUnique.mockResolvedValue(null);
  db.$queryRaw.mockReset();
  db.$queryRaw.mockResolvedValue([{ refused: 1 }]);
  db.contentTranslation.upsert.mockImplementation(async () => ({}));
  ai.translate = vi.fn(async () => ({}));
  ai.translateValues = vi.fn(async (values: string[]) => values.map((v) => `xx-${v}`));
});

describe("purge path", () => {
  it("folds locales that ask for the SAME keys into one call", async () => {
    // `translationsRemove` takes keys x locales as a cross product, so locales
    // whose stale key set is identical — the common case by far — go in one
    // call. Twelve metafields on an eight-locale shop would otherwise be 96
    // sequential removals inside the merchant's save request.
    shopify.removeConfirms = null;
    const id = freshProduct();
    await reconcileStaleTranslations(
      baseParams({
        resourceId: id,
        translations: [
          { key: "title", value: "T", locale: "de", marketId: "", outdated: true },
          { key: "title", value: "T", locale: "fr", marketId: "", outdated: true },
        ],
        previousDigests: {
          [digestBaselineKey("de", "title")]: OLD,
          [digestBaselineKey("fr", "title")]: OLD,
        },
      }),
    );

    // One Shopify call, both locales on it.
    expect(shopify.removeTargets).toEqual([id]);
    expect(shopify.removeCalls.map((c) => c.locale).sort()).toEqual(["de", "fr"]);
  });

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

  it("RE-READS a key the removal did not echo, instead of keeping the row forever", async () => {
    // `translationsRemove` echoes what it DELETED, so a key that carried
    // nothing on Shopify — a mirror row written when the register found no
    // digest — comes back empty. Without the re-read its local row survives
    // forever and the editor keeps serving a foreign value for a cleared field.
    shopify.removeConfirms = { de: [], fr: [] };
    shopify.rereadConfirms = { de: ["title"], fr: [] };

    const result = await reconcileStaleTranslations(baseParams());

    expect(shopify.rereadCalls.find((c) => c.locale === "de")?.keys).toEqual(["title"]);
    // Confirmed by the READ, so the local row goes; fr confirmed nothing and
    // keeps its row.
    expect(result.removed).toBe(1);
    const deletes = db.contentTranslation.deleteMany.mock.calls.map((c: any[]) => c[0].where);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toMatchObject({ locale: "de", key: { in: ["title"] } });
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
      baseParams({
        previousDigests: {
          [digestBaselineKey("de", "title")]: NEW,
          [digestBaselineKey("fr", "body_html")]: NEW,
        },
      }),
    );
    expect(result).toEqual({ removed: 0, retranslating: 0 });
    expect(shopify.removeCalls).toEqual([]);
  });
});

describe("auto-translation path (Max)", () => {
  beforeEach(() => {
    // The real policy forces the purge switch off whenever auto-translation is
    // in force, so that is the pair these tests run under.
    policy.autoTranslateExternalChanges = true;
    policy.purgeOnPrimaryChange = false;
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

  it("FILLS a locale that had no translation of the changed key at all", async () => {
    // The sync side of the same promise: `it` holds nothing, so no digest
    // baseline of its own can ever prove anything about it — the evidence comes
    // from the locale that IS translated, and the new text goes to both.
    ai.translate = vi.fn(async (fields: Record<string, string>, locales: string[]) => ({
      [locales[0]]: Object.fromEntries(Object.keys(fields).map((k) => [k, `translated-${k}`])),
    }));

    const result = await reconcileStaleTranslations(
      baseParams({
        translations: [{ key: "title", value: "Titre", locale: "de", marketId: "", outdated: true }],
        previousDigests: { [digestBaselineKey("de", "title")]: OLD },
        foreignLocales: ["de", "it"],
      }),
    );
    await awaitDetachedRetranslations();

    expect(result.retranslating).toBe(2);
    expect(shopify.registerCalls.map((c) => c.locale).sort()).toEqual(["de", "it"]);
    expect(shopify.removeCalls).toEqual([]);
  });

  it("fills nothing when this sync proved no key moved", async () => {
    // The fill widens a proven key to more locales; it is never itself the
    // evidence. Without the gate one price edit — `products/update` fires for
    // those too — would translate a whole catalogue unattended.
    const result = await reconcileStaleTranslations(
      baseParams({
        primaryContent: { title: { value: "Box", digest: OLD }, body_html: { value: "<p>Box</p>", digest: OLD } },
        foreignLocales: ["de", "fr", "it"],
      }),
    );
    await awaitDetachedRetranslations();

    expect(result).toEqual({ removed: 0, retranslating: 0 });
    expect(shopify.registerCalls).toEqual([]);
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

  it("does NOT purge a FILLED entry when the AI fails — there is nothing to remove", async () => {
    // A fill exists to create a translation. Sending its removal echoes nothing
    // back, costs a gap re-read per locale, and reports removals the merchant
    // never had. The locale that really held a stale translation still goes.
    ai.translate = vi.fn(async () => {
      throw new Error("provider down");
    });

    await reconcileStaleTranslations(
      baseParams({
        translations: [{ key: "title", value: "Titre", locale: "de", marketId: "", outdated: true }],
        previousDigests: { [digestBaselineKey("de", "title")]: OLD },
        foreignLocales: ["de", "it"],
      }),
    );
    await awaitDetachedRetranslations();

    expect(shopify.removeCalls).toEqual([{ keys: ["title"], locale: "de" }]);
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

  it("…but REPORTS it: a run that could not mirror is not a clean success", async () => {
    // Every editor in this app renders from the mirror, so a translation that
    // is live on Shopify with no local row is invisible to the merchant — the
    // exact symptom "the field stays empty after the background run". Keeping
    // the entry out of `failed` is right; reporting the run as `completed` on
    // top of it is what made the defect unobservable.
    ai.translate = vi.fn(async (fields: Record<string, string>, locales: string[]) => ({
      [locales[0]]: Object.fromEntries(Object.keys(fields).map((k) => [k, `translated-${k}`])),
    }));
    db.contentTranslation.upsert.mockImplementation(async () => {
      throw new Error("connection pool exhausted");
    });

    await reconcileStaleTranslations(baseParams());
    await awaitDetachedRetranslations();

    const final = db.task.update.mock.calls.at(-1) as unknown as [any];
    expect(final[0].data.status).toBe("completed_with_errors");
    expect(JSON.parse(final[0].data.result)).toMatchObject({ retranslated: 2, notMirrored: 2 });
    // A machine CODE, not an English sentence with a raw Prisma message in it:
    // this run has no merchant locale, and `taskErrorText` renders the code.
    expect(final[0].data.error).toBe("translations_not_mirrored:2");
  });

  it("hands back the Task id BEFORE the detached run creates the row", async () => {
    // The row is created inside the run, which outlives the request that
    // started it — so a caller that wants to tell the merchant "this is still
    // working" can only do it with an id minted up front.
    ai.translate = vi.fn(async (fields: Record<string, string>, locales: string[]) => ({
      [locales[0]]: Object.fromEntries(Object.keys(fields).map((k) => [k, `t-${k}`])),
    }));
    const result = await reconcileStaleTranslations(baseParams());
    expect(result.taskId).toBeTruthy();

    await awaitDetachedRetranslations();
    const created = (db.task.create.mock.calls.at(-1) as unknown as [any])[0];
    expect(created.data.id).toBe(result.taskId);
  });

  it("still removes what it cannot re-translate, even with the purge switch off", async () => {
    // A CLEARED source has nothing to translate. Leaving its translation up
    // would be the opposite of what "always give it the new text" asked for —
    // and the purge switch is off by construction here, so this correction
    // cannot depend on it.
    const result = await reconcileStaleTranslations(
      baseParams({
        translations: [{ key: "title", value: "Titre", locale: "de", marketId: "", outdated: true }],
        primaryContent: { body_html: { value: "<p>Box</p>", digest: NEW } },
        previousDigests: { [digestBaselineKey("de", "title")]: OLD },
      }),
    );

    expect(result.retranslating).toBe(0);
    expect(result.removed).toBe(1);
    expect(shopify.removeCalls).toEqual([{ keys: ["title"], locale: "de" }]);
  });

  it("does not abort itself when the inline purge marks the resource", async () => {
    // The purge runs first and marks the resource as just-written. A run that
    // reads that mark as "the merchant saved" abandons every locale, registers
    // nothing, purges nothing — and the entries are lost for good, because the
    // sync has already advanced their digest baseline.
    ai.translate = vi.fn(async (fields: Record<string, string>, locales: string[]) => ({
      [locales[0]]: Object.fromEntries(Object.keys(fields).map((k) => [k, `translated-${k}`])),
    }));
    const product = freshProduct();

    await reconcileStaleTranslations(
      baseParams({
        resourceId: product,
        // A handle can never be auto-translated, so this run has BOTH an inline
        // purge and a re-translation — the collision the bug needed.
        translations: [
          { key: "handle", value: "titre", locale: "de", marketId: "", outdated: true },
          { key: "title", value: "Titre", locale: "fr", marketId: "", outdated: true },
        ],
        primaryContent: {
          handle: { value: "box", digest: NEW },
          title: { value: "Box", digest: NEW },
        },
        previousDigests: {
          [digestBaselineKey("de", "handle")]: OLD,
          [digestBaselineKey("fr", "title")]: OLD,
        },
      }),
    );
    await awaitDetachedRetranslations();

    expect(shopify.removeCalls).toEqual([{ keys: ["handle"], locale: "de" }]);
    expect(shopify.registerCalls.map((c) => c.key)).toEqual(["title"]);
  });

  it("abandons the run when a REAL save lands while the AI is working", async () => {
    const product = freshProduct();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    ai.translate = vi.fn(async () => {
      await gate;
      return {};
    });

    await reconcileStaleTranslations(baseParams({ resourceId: product }));
    // The merchant saves a translation of this very resource mid-run.
    markTranslationSaved(product);
    release();
    await awaitDetachedRetranslations();

    // Neither overwritten nor deleted — their value is newer than anything
    // this run decided.
    expect(shopify.registerCalls).toEqual([]);
    expect(shopify.removeCalls).toEqual([]);
  });

  it("waits for a running re-translation and actually WRITES the second event's work", async () => {
    // The gate is created UP FRONT: the detached run reaches the AI call only
    // after several awaits, so a `release` assigned inside the mock would still
    // be undefined when the test wants to open it.
    //
    // The mock returns REAL translations on purpose. With an empty result run 1
    // registers nothing and never marks the resource — which is the one shape
    // in which a queued run cannot abort itself, so the test would pass while
    // the defect was live.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    ai.translate = vi.fn(async (fields: Record<string, string>, locales: string[]) => {
      await gate;
      return {
        [locales[0]]: Object.fromEntries(Object.keys(fields).map((k) => [k, `translated-${k}`])),
      };
    });

    // Two admin edits a minute apart: the second event's entries were detected
    // against a baseline this sync has already overwritten, so dropping them
    // loses them permanently. They are queued behind the running one instead.
    const sameProduct = freshProduct();
    const first = await reconcileStaleTranslations(baseParams({ resourceId: sameProduct }));
    const second = await reconcileStaleTranslations(baseParams({ resourceId: sameProduct }));

    expect(first.retranslating).toBe(2);
    expect(second.retranslating).toBe(2);

    release();
    await awaitDetachedRetranslations();
    // BOTH runs registered their two entries — the second was queued, not
    // discarded, and it did not abandon itself over the first run's mark.
    expect(shopify.registerCalls).toHaveLength(4);
    expect(shopify.removeCalls).toEqual([]);
  });

  it("stops before the WRITE when the merchant saves mid-locale", async () => {
    // With one locale the outer check never runs again, so a translation save
    // that lands while that locale's AI request is in flight — a rename plus
    // its foreign title in one save — would be overwritten by the answer.
    const product = freshProduct();
    ai.translate = vi.fn(async (fields: Record<string, string>, locales: string[]) => {
      markTranslationSaved(product); // the merchant, mid-request
      return {
        [locales[0]]: Object.fromEntries(Object.keys(fields).map((k) => [k, `translated-${k}`])),
      };
    });

    await reconcileStaleTranslations(
      baseParams({
        resourceId: product,
        translations: [{ key: "title", value: "Titre", locale: "de", marketId: "", outdated: true }],
        previousDigests: { [digestBaselineKey("de", "title")]: OLD },
      }),
    );
    await awaitDetachedRetranslations();

    expect(shopify.registerCalls).toEqual([]);
  });

  it("keeps the stale rows when the run cannot even START", async () => {
    // The realistic trigger is a DATABASE error. Answering it with the purge
    // would delete the translations on Shopify while the local mirror delete
    // fails for the same reason — storefront content lost because our own
    // database blinked. A stale text is visible and repairable; a deleted one
    // is neither.
    db.task.create.mockRejectedValueOnce(new Error("connection pool exhausted"));

    await reconcileStaleTranslations(baseParams());
    await awaitDetachedRetranslations();

    expect(shopify.registerCalls).toEqual([]);
    expect(shopify.removeCalls).toEqual([]);
    expect(db.contentTranslation.deleteMany).not.toHaveBeenCalled();
  });
});

/**
 * The in-app entry point. A page / article / blog / policy has no Shopify
 * webhook, so the save that changed the primary text is the ONLY event that
 * will ever notice — before this existed their translations were deleted and
 * nothing refreshed them, and a Max shop got the new text on a product and a
 * blank field on a page for the very same edit.
 */
describe("in-app primary save (reconcileAfterPrimarySave)", () => {
  const PAGE = "gid://shopify/Page/42";

  /** locale → the keys Shopify reports a GLOBAL translation for, on PAGE. */
  let shopifyHas: Record<string, string[]> = {};
  /** The primary values Shopify reports back after the write, per resource. */
  let primaryContent: Record<string, Record<string, { value: string; digest: string | null }>> = {};

  const saveClient = () => ({
    graphql: vi.fn(async (query: string, opts: { variables?: Record<string, unknown> }) => ({
      ok: true,
      json: async () => {
        const ids = (opts?.variables?.resourceIds as string[]) ?? [];
        if (query.includes("stalePrimaryContent")) {
          return {
            data: {
              translatableResourcesByIds: {
                edges: ids.map((resourceId) => ({
                  node: {
                    resourceId,
                    translatableContent: Object.entries(primaryContent[resourceId] ?? {}).map(
                      ([key, entry]) => ({ key, value: entry.value, digest: entry.digest }),
                    ),
                  },
                })),
              },
            },
          };
        }
        const locale = String(opts?.variables?.locale ?? "");
        const translated = shopifyHas[locale] ?? [];
        return {
          data: {
            translatableResourcesByIds: {
              edges: ids.map((resourceId) => ({
                node: {
                  resourceId,
                  // Shopify answers with a row per translatable KEY and `value:
                  // null` where that locale has nothing — the shape every sync
                  // in this repo filters on. The fake mirrors it, or the test
                  // would pass on a query that treats untranslated locales as
                  // translated. The key list is the union of what the primary
                  // content holds and what any locale is translated for: a
                  // CLEARED field has no primary entry left and is exactly the
                  // case where the existence lookup matters.
                  translations: [
                    ...new Set([
                      ...Object.keys(primaryContent[resourceId] ?? {}),
                      ...Object.values(shopifyHas).flat(),
                    ]),
                  ].map((key) => ({
                    key,
                    locale,
                    value: translated.includes(key) ? `existing-${key}` : null,
                  })),
                },
              })),
            },
          },
        };
      },
    })),
  });

  function saveParams(over: Record<string, unknown> = {}) {
    return {
      client: saveClient() as never,
      shop: SHOP,
      resourceId: PAGE,
      resourceType: "Page",
      contentKind: "page" as const,
      resourceTitle: "About us",
      changed: [{ key: "title" }, { key: "body_html" }],
      foreignLocales: ["de", "fr"],
      policy: policy as never,
      ...over,
    };
  }

  beforeEach(() => {
    // The expected-value tests below would otherwise sleep through every retry.
    setReadBackRetryDelaysForTests([0, 0, 0]);
    policy.autoTranslateExternalChanges = true;
    policy.purgeOnPrimaryChange = false;
    // Reset explicitly: several tests below flip it, and leaving it to test
    // ORDER is how a deletion assertion comes to pass for the wrong reason.
    policy.purgeUnreconciledSurfaces = true;
    db.contentTranslation.findMany.mockClear();
    db.contentTranslation.findMany.mockReset();
    db.contentTranslation.findMany.mockImplementation(async (args: any) =>
      // Global rows for the detection; no market overrides unless a test says so.
      args?.where?.marketId === ""
        ? [
            { resourceId: PAGE, key: "title", locale: "de" },
            { resourceId: PAGE, key: "body_html", locale: "de" },
          ]
        : [],
    );
    shopifyHas = { de: ["title", "body_html"] };
    primaryContent = {
      [PAGE]: {
        title: { value: "About us", digest: NEW },
        body_html: { value: "<p>New text</p>", digest: NEW },
      },
    };
    ai.translate = vi.fn(async (fields: Record<string, string>, locales: string[]) => ({
      [locales[0]]: Object.fromEntries(Object.keys(fields).map((k) => [k, `translated-${k}`])),
    }));
  });

  it("names EVERY content type the save repairs — the two with a webhook included", () => {
    // Product and Collection were off this list on the argument that their
    // update webhook already runs the repair. It cannot: the sync-side gate
    // proves a change from digests stored ON TRANSLATION ROWS, so a resource
    // nobody has ever translated has no baseline and its webhook proves
    // nothing, forever — which is exactly the state a merchant is in when they
    // switch the feature on. The duplicate that exclusion prevented is now
    // prevented by the CLAIM: the repair marks the resource before it starts
    // and the sync-side entry point bails wholesale on that mark.
    expect([...IN_APP_RETRANSLATED_RESOURCE_TYPES].sort()).toEqual([
      "Article",
      "Blog",
      "Collection",
      "Page",
      "Product",
      "ShopPolicy",
    ]);
  });

  it("translates every changed key into every published locale, not only the ones that had a translation", async () => {
    // THE FILL. Shopify holds a German translation and no French one; the
    // merchant asked for "translate automatically", so both get the new text.
    // Repairing only what already existed answered a question about the PAST
    // and read, on any half-translated shop, as the switch being off.
    const result = await reconcileAfterPrimarySave(saveParams());
    await awaitDetachedRetranslations();

    expect(result.retranslating).toBe(4);
    expect(result.removed).toBe(0);
    expect(shopify.removeCalls).toEqual([]);
    expect(shopify.registerCalls.map((c) => `${c.locale}:${c.key}`).sort()).toEqual([
      "de:body_html",
      "de:title",
      "fr:body_html",
      "fr:title",
    ]);
  });

  it("ADVANCES the primary baseline to the text it just read back", async () => {
    // The webhook of this same save bails on our claim, so nothing else writes
    // it: left at the pre-save digest, any change event after the claim
    // expires proves the same move again and queues a SECOND run.
    db.primaryDigestBaseline.findUnique.mockResolvedValue({ digests: { title: OLD, body_html: OLD } });

    await reconcileAfterPrimarySave(saveParams());
    await awaitDetachedRetranslations();

    const call = (db.primaryDigestBaseline.upsert.mock.calls[0] as unknown as [any])[0];
    expect(call.where.shop_resourceId).toEqual({ shop: SHOP, resourceId: PAGE });
    expect(call.update.digests).toEqual({ title: NEW, body_html: NEW });
  });

  it("leaves the primary baseline alone when it could not be READ", async () => {
    db.primaryDigestBaseline.findUnique.mockRejectedValue(new Error("db down"));

    await reconcileAfterPrimarySave(saveParams());
    await awaitDetachedRetranslations();

    expect(db.primaryDigestBaseline.upsert).not.toHaveBeenCalled();
  });

  it("asks NOBODY which locales are translated when every entry will be translated", async () => {
    // Existence only ever decided whether a REMOVAL is worth sending. With the
    // fill, a save whose keys all carry a value has no removal to send at all —
    // so the per-locale Shopify sweep and the mirror lookup are skipped rather
    // than paid for on every save.
    const params = saveParams();
    await reconcileAfterPrimarySave(params);
    await awaitDetachedRetranslations();

    const graphql = (params.client as unknown as { graphql: { mock: { calls: unknown[][] } } }).graphql;
    const queries = graphql.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(queries.some((q: string) => q.includes("stalePrimaryContent"))).toBe(true);
    expect(queries.some((q: string) => q.includes("staleTranslationTargets"))).toBe(false);
    expect(db.contentTranslation.findMany.mock.calls.some((c: any) => c[0]?.where?.marketId === "")).toBe(
      false,
    );
  });

  it("leaves a (resource, locale, key) the SAVE itself wrote in neither list", async () => {
    // A bulk save that changes a page's primary title AND types its German
    // one has said something about German and nothing about French. Acting on
    // German would overwrite what the merchant just typed; aborting the whole
    // run would leave French stale on a surface with no webhook to notice.
    shopifyHas = { de: ["title", "body_html"], fr: ["title", "body_html"] };
    const result = await reconcileAfterPrimarySave(
      saveParams({
        foreignLocales: ["de", "fr"],
        alreadyWritten: [{ locale: "de", key: "title" }],
      }),
    );
    await awaitDetachedRetranslations();

    // 4 candidates minus the one the merchant wrote.
    expect(result.retranslating).toBe(3);
    expect(shopify.registerCalls).toHaveLength(3);
    expect(shopify.registerCalls.some((c) => c.locale === "de" && c.key === "title")).toBe(false);
    expect(shopify.registerCalls.some((c) => c.locale === "fr" && c.key === "title")).toBe(true);
    // And it is not removed either — neither list.
    expect(shopify.removeCalls).toEqual([]);
  });

  it("needs NO digest baseline — the save IS the change event", async () => {
    // The sync-side gate exists to prove the primary text moved. Here the
    // caller performed the write, so running that gate would only ADD a way to
    // miss: a mirror row with no digest would pass no gate and its translation
    // would be neither refreshed nor removed — live, describing text that no
    // longer exists. `previousDigests` is not even a parameter here, and the
    // rows the mirror returns carry no digest of their own.
    await reconcileAfterPrimarySave(saveParams());
    await awaitDetachedRetranslations();

    expect(shopify.registerCalls).toHaveLength(4);
  });

  it("scopes the EVIDENCE lookup to this resource when a removal is on the table", async () => {
    // The mirror is still asked — but only for the candidates that would be
    // REMOVED, and only for their own resource. The market-override purge
    // queries the same table for `marketId: { not: "" }`, so picking the last
    // call would assert against that instead.
    primaryContent = { [PAGE]: { title: { value: "About us", digest: NEW } } };
    await reconcileAfterPrimarySave(saveParams());
    await awaitDetachedRetranslations();

    const calls = db.contentTranslation.findMany.mock.calls as unknown as [{ where: any }][];
    const where = calls.map((call) => call[0].where).find((w) => w.marketId === "");
    expect(where).toBeDefined();
    expect(where.OR).toEqual([{ resourceId: PAGE, resourceType: "Page" }]);
  });

  it("removes the MARKET overrides of the same keys — nothing else ever refreshes them", async () => {
    // A market override is a deliberately different wording, so the repair
    // never re-translates it. That is exactly why it has to GO when the text it
    // describes moves: nothing else would ever notice, and it would keep
    // describing text that no longer exists on that market's storefront.
    const MARKET = "gid://shopify/Market/5";
    db.contentTranslation.findMany.mockImplementation(async (args: any) => {
      // The detection's own lookup is the GLOBAL one; the override purge asks
      // the same table for everything that is NOT global.
      if (args?.where?.marketId === "") {
        return [
          { resourceId: PAGE, key: "title", locale: "de" },
          { resourceId: PAGE, key: "body_html", locale: "de" },
        ];
      }
      return [{ resourceId: PAGE, key: "title", locale: "de", marketId: MARKET }];
    });

    const result = await reconcileAfterPrimarySave(saveParams());
    await awaitDetachedRetranslations();

    // The global rows were REFRESHED (and the untranslated locale filled), not
    // deleted…
    expect(result.retranslating).toBe(4);
    expect(shopify.registerCalls).toHaveLength(4);
    // …and the market override was removed on ITS OWN layer.
    expect(shopify.removeMarkets).toEqual([MARKET]);
    expect(shopify.removeCalls).toEqual([{ keys: ["title"], locale: "de" }]);
    expect(
      db.contentTranslation.deleteMany.mock.calls.some(
        (call: any) => call[0]?.where?.marketId === MARKET,
      ),
    ).toBe(true);
  });

  it("leaves the market overrides alone when the merchant switched BOTH answers off", async () => {
    // Reached through the PURGE path, not the auto-translate one: with
    // auto-translate off `reconcileAfterPrimarySave` returns before anything
    // market-related, so asserting there would prove nothing at all.
    policy.autoTranslateExternalChanges = false;
    policy.purgeOnPrimaryChange = false;
    policy.purgeUnreconciledSurfaces = false;
    const MARKET = "gid://shopify/Market/5";

    const RESOURCE = freshProduct();
    db.contentTranslation.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.marketId === "") return [{ resourceId: RESOURCE, key: "title", locale: "de" }];
      return [{ resourceId: RESOURCE, key: "title", locale: "de", marketId: MARKET }];
    });
    await reconcileStaleTranslations(
      baseParams({
        resourceId: RESOURCE,
        translations: [{ key: "title", value: "Titre", locale: "de", marketId: "", outdated: true }],
        previousDigests: { [digestBaselineKey("de", "title")]: OLD },
      }),
    );
    await awaitDetachedRetranslations();

    // "don't delete" means don't delete — on both layers.
    expect(shopify.removeCalls).toEqual([]);
    expect(shopify.removeMarkets).toEqual([]);
  });

  it("keeps the market override of a key we DECLINED to translate and kept globally", async () => {
    // `declined` is what WE refused to try, so the merchant's stored "don't
    // delete" still stands — and it has to stand on BOTH layers. Driving the
    // market purge off the caller's full key list deleted exactly those
    // overrides while their global row was deliberately kept: the richtext
    // theme bug, one layer down.
    policy.autoTranslateExternalChanges = true;
    policy.purgeUnreconciledSurfaces = false;
    const MARKET = "gid://shopify/Market/5";
    shopifyHas = { de: ["title", "body_html"] };
    db.contentTranslation.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.marketId === "") {
        return [
          { resourceId: PAGE, key: "title", locale: "de" },
          { resourceId: PAGE, key: "body_html", locale: "de" },
        ];
      }
      // The real query filters `key: { in: keys }` — a fake that ignores it
      // would answer rows the purge never asked for and this test would pass
      // against the very bug it exists for.
      const asked: string[] = args?.where?.key?.in ?? ["title", "body_html"];
      return [
        { resourceId: PAGE, key: "title", locale: "de", marketId: MARKET },
        { resourceId: PAGE, key: "body_html", locale: "de", marketId: MARKET },
      ].filter((row) => asked.includes(row.key));
    });

    await reconcileAfterPrimarySave(
      saveParams({
        changed: [{ key: "title" }, { key: "body_html", retranslatable: false }],
      }),
    );
    await awaitDetachedRetranslations();

    // The re-translated key's override goes; the declined key's stays.
    expect(shopify.removeMarkets).toEqual([MARKET]);
    expect(shopify.removeCalls).toEqual([{ keys: ["title"], locale: "de" }]);
  });

  it("removes a translation whose primary value was CLEARED", async () => {
    // Nothing to translate, so the AI path cannot deliver it and the storefront
    // must not keep a translation of text that no longer exists.
    shopifyHas = { de: ["body_html"] };
    // `translatableContent` omits a key with no value at all — that is how a
    // cleared field announces itself, and it is NOT the same as a failed read.
    primaryContent = { [PAGE]: { title: { value: "About us", digest: NEW } } };
    db.contentTranslation.findMany.mockResolvedValue([
      { resourceId: PAGE, key: "body_html", locale: "de" },
    ]);
    const result = await reconcileAfterPrimarySave(saveParams());
    await awaitDetachedRetranslations();

    // The cleared key goes where a translation really exists — German — and
    // nowhere else: French holds none, and a removal there would be an
    // unechoed no-op logged as an unconfirmed removal.
    expect(result.removed).toBe(1);
    expect(shopify.removeCalls).toEqual([{ keys: ["body_html"], locale: "de" }]);
    // The key that still HAS a value is translated into both locales.
    expect(shopify.registerCalls.map((c) => `${c.locale}:${c.key}`).sort()).toEqual([
      "de:title",
      "fr:title",
    ]);
  });

  it("does nothing when auto-translate is off — the caller's own purge is the repair", async () => {
    // Both paths must be mutually exclusive at BOTH ends: a second
    // translationsRemove for rows that are already gone echoes nothing back and
    // logs as an unconfirmed removal.
    // The switch is re-checked on the policy the CALLER hands in — never on a
    // second read of its own, which would fail open to "off" and return without
    // doing anything while the caller has already stood its purge down.
    const result = await reconcileAfterPrimarySave(
      saveParams({ policy: { ...policy, autoTranslateExternalChanges: false } as never }),
    );

    expect(result).toEqual({ removed: 0, retranslating: 0 });
    expect(shopify.removeCalls).toEqual([]);
    expect(db.contentTranslation.findMany).not.toHaveBeenCalled();
  });

  it("TRANSLATES a resource that had no translation at all — that is what the switch promises", async () => {
    // The case the merchant reported: a page whose translations were empty
    // stayed empty after every primary edit, because the repair only ever
    // refreshed rows that existed. Nothing exists here, and all four entries
    // are written.
    shopifyHas = {};
    db.contentTranslation.findMany.mockResolvedValue([]);
    const result = await reconcileAfterPrimarySave(saveParams());
    await awaitDetachedRetranslations();

    expect(result.retranslating).toBe(4);
    expect(shopify.removeCalls).toEqual([]);
    expect(shopify.registerCalls).toHaveLength(4);
  });

  it("still does nothing when the save changed no key, or the shop has no foreign locale", async () => {
    expect(await reconcileAfterPrimarySave(saveParams({ changed: [] }))).toEqual({
      removed: 0,
      retranslating: 0,
    });
    expect(await reconcileAfterPrimarySave(saveParams({ foreignLocales: [] }))).toEqual({
      removed: 0,
      retranslating: 0,
    });
    expect(shopify.registerCalls).toEqual([]);
  });

  it("does not REMOVE in a locale Shopify reports with no value — that is not a translation", async () => {
    // `translations(locale:)` answers with a row per translatable key and a null
    // value where the locale has nothing. Taking those as translations would
    // send a removal into every locale the merchant never translated: an
    // unechoed no-op, logged as an unconfirmed removal.
    db.contentTranslation.findMany.mockResolvedValue([]);
    // Both keys CLEARED, so every candidate needs evidence. Only German has a
    // value; the French rows come back with `value: null`.
    primaryContent = { [PAGE]: {} };
    shopifyHas = { de: ["title", "body_html"] };

    await reconcileAfterPrimarySave(saveParams());
    await awaitDetachedRetranslations();

    expect(shopify.removeCalls).toEqual([{ keys: ["title", "body_html"], locale: "de" }]);
    expect(shopify.registerCalls).toEqual([]);
  });

  it("removes a translation Shopify holds that the local mirror never saw", async () => {
    // Written in the Shopify admin, by another app or by an importer. The code
    // this path replaces reached it because it removed BLINDLY across every
    // foreign locale; asking only the mirror would trade "deleted" for "left
    // live on the storefront" — on a type with no webhook to catch it later.
    db.contentTranslation.findMany.mockResolvedValue([]);
    primaryContent = { [PAGE]: {} };
    shopifyHas = { fr: ["title"] };

    const result = await reconcileAfterPrimarySave(saveParams({ changed: [{ key: "title" }] }));
    await awaitDetachedRetranslations();

    expect(result.removed).toBe(1);
    expect(shopify.removeCalls).toEqual([{ keys: ["title"], locale: "fr" }]);
  });

  it("falls back to the mirror for a locale whose Shopify read failed", async () => {
    // Degrading to the mirror-only reach is acceptable; losing the whole repair
    // over one failed lookup is not. The DETECTION fails here, the primary
    // read-back still works — a GraphQL-level error, which is how a real
    // refusal arrives, and unlike a thrown transport error it is not retried by
    // the gateway, so the test does not pay backoff to prove one branch.
    primaryContent = { [PAGE]: {} };
    db.contentTranslation.findMany.mockImplementation(async (args: any) =>
      args?.where?.marketId === "" ? [{ resourceId: PAGE, key: "title", locale: "de" }] : [],
    );
    const real = saveClient();
    const client = {
      graphql: vi.fn(async (query: string, opts: { variables?: Record<string, unknown> }) =>
        query.includes("stalePrimaryContent")
          ? real.graphql(query, opts)
          : { ok: true, json: async () => ({ errors: [{ message: "Access denied" }] }) },
      ),
    };
    await reconcileAfterPrimarySave(saveParams({ client: client as never }));
    await awaitDetachedRetranslations();

    expect(shopify.removeCalls).toEqual([{ keys: ["title"], locale: "de" }]);
  });

  it("WAITS for a read-back that has not caught up with the write — an alt that was empty before", async () => {
    // An empty value has no `translatableContent` entry, so a lagging
    // read-back of a FIRST alt text reads as "cleared": the new alt was
    // classified as a removal of nothing and never translated.
    setReadBackRetryDelaysForTests([0, 0, 0]);
    const client = saveClient();
    const inner = client.graphql;
    let reads = 0;
    client.graphql = vi.fn(async (query: string, opts: { variables?: Record<string, unknown> }) => {
      if (query.includes("stalePrimaryContent")) {
        reads++;
        // First look: Shopify has not indexed the new title yet.
        if (reads === 1) {
          return { ok: true, json: async () => ({ data: { translatableResourcesByIds: { edges: [{ node: { resourceId: PAGE, translatableContent: [] } }] } } }) };
        }
      }
      return inner(query, opts);
    }) as never;

    const result = await reconcileAfterPrimarySave(
      saveParams({ client: client as never, changed: [{ key: "title", expectedValue: "About us" }] }),
    );
    await awaitDetachedRetranslations();

    expect(reads).toBe(2);
    expect(result.retranslating).toBe(2);
    expect(shopify.registerCalls.map((c) => `${c.locale}:${c.key}`).sort()).toEqual(["de:title", "fr:title"]);
  });

  it("does NOT re-read a resource whose read FAILED — only one that answered and disagrees", async () => {
    // A failed read is absent from the map; re-asking it put every gateway
    // retry inline in the save, for an outcome that stays "skipped".
    setReadBackRetryDelaysForTests([0, 0, 0]);
    const client = saveClient();
    const inner = client.graphql;
    let reads = 0;
    client.graphql = vi.fn(async (query: string, opts: { variables?: Record<string, unknown> }) => {
      if (query.includes("stalePrimaryContent")) {
        reads++;
        return { ok: true, json: async () => ({ data: { translatableResourcesByIds: { edges: [] } } }) };
      }
      return inner(query, opts);
    }) as never;

    await reconcileAfterPrimarySave(
      saveParams({ client: client as never, changed: [{ key: "title", expectedValue: "About us" }] }),
    );
    expect(reads).toBe(1);
  });

  it("does not count surrounding whitespace as a lagging read-back", async () => {
    setReadBackRetryDelaysForTests([0, 0, 0]);
    const result = await reconcileAfterPrimarySave(
      saveParams({ changed: [{ key: "title", expectedValue: "  About us " }] }),
    );
    await awaitDetachedRetranslations();
    expect(result.retranslating).toBe(2);
  });

  it("never TRANSLATES a key whose read-back does not match what the caller wrote", async () => {
    // A theme write lands in a FILE and is re-indexed afterwards, so the
    // read-back can still answer with the PREVIOUS text — and with a digest
    // that registers cleanly, which would produce an echo-confirmed translation
    // of text the merchant has just replaced, with the deletion already stood
    // down.
    const result = await reconcileAfterPrimarySave(
      saveParams({
        changed: [
          { key: "title", expectedValue: "Something else entirely" },
          { key: "body_html" },
        ],
      }),
    );
    await awaitDetachedRetranslations();

    expect(result.retranslating).toBe(2);
    expect(shopify.registerCalls.map((c) => c.key)).toEqual(["body_html", "body_html"]);
  });

  it("...and DECLINES it, so the merchant's stored deletion answer decides", async () => {
    // Skipping it outright would leave a foreign value live on a surface
    // nothing else ever revisits; deleting it regardless would ignore a
    // merchant who switched the deletion off. It is a decline, so their answer
    // stands — here: on.
    policy.purgeUnreconciledSurfaces = true;
    await reconcileAfterPrimarySave(
      saveParams({ changed: [{ key: "title", expectedValue: "Something else" }] }),
    );
    await awaitDetachedRetranslations();
    expect(shopify.removeCalls.map((c) => c.keys)).toEqual([["title"]]);

    shopify.removeCalls = [];
    policy.purgeUnreconciledSurfaces = false;
    // A second resource, because the first one is now claimed by the run above
    // — and it needs its own primary content: with no value at all the entry
    // would be a PURGE (nothing to translate) rather than the DECLINE this
    // asserts about.
    primaryContent[`${PAGE}-b`] = { title: { value: "About us", digest: NEW } };
    await reconcileAfterPrimarySave(
      saveParams({
        resourceId: `${PAGE}-b`,
        changed: [{ key: "title", expectedValue: "Something else" }],
      }),
    );
    await awaitDetachedRetranslations();
    expect(shopify.removeCalls).toEqual([]);
  });

  it("keeps everything when the primary read-back itself fails", async () => {
    // A failed lookup and "every field was cleared" look identical in the data,
    // and only one of them may lose its translations. Answering our own blink
    // with a deletion is the mistake `startFailed` exists to prevent.
    const client = {
      graphql: vi.fn(async (query: string, opts: { variables?: Record<string, unknown> }) =>
        query.includes("stalePrimaryContent")
          ? { ok: true, json: async () => ({ errors: [{ message: "Throttled" }] }) }
          : saveClient().graphql(query, opts),
      ),
    };
    const result = await reconcileAfterPrimarySave(saveParams({ client: client as never }));
    await awaitDetachedRetranslations();

    expect(result).toEqual({ removed: 0, retranslating: 0 });
    expect(shopify.removeCalls).toEqual([]);
    expect(shopify.registerCalls).toEqual([]);
  });

  it("claims the resource so a reload cannot queue a second identical run", async () => {
    // Every entry here is re-translatable, so there is no inline purge to mark
    // the resource. Without the mark, an item reload while the AI is working
    // re-detects the same entries against a digest mirror that has not advanced
    // yet, and the sync-side path queues a duplicate run behind this one.
    await reconcileAfterPrimarySave(saveParams());

    expect(isTranslationRecentlySaved(PAGE)).toBe(true);

    // ...which is exactly what makes the sync entry point stand down.
    const result = await reconcileStaleTranslations(
      baseParams({
        resourceId: PAGE,
        resourceType: "Page",
        contentKind: "page" as const,
      }),
    );
    expect(result).toEqual({ removed: 0, retranslating: 0 });

    await awaitDetachedRetranslations();
  });

  it("never throws, and a failed EVIDENCE lookup degrades instead of losing the repair", async () => {
    // The mirror is only asked about candidates that would be REMOVED. Letting
    // its failure escape would discard the entries that will be TRANSLATED and
    // never needed it — and the caller has already stood its own purge down, so
    // those keys would be neither refreshed nor removed.
    primaryContent = { [PAGE]: { title: { value: "About us", digest: NEW } } };
    shopifyHas = { de: ["body_html"] };
    db.contentTranslation.findMany.mockRejectedValue(new Error("connection lost"));

    const result = await reconcileAfterPrimarySave(saveParams());
    await awaitDetachedRetranslations();

    expect(result.retranslating).toBe(2);
    expect(shopify.registerCalls.map((c) => `${c.locale}:${c.key}`).sort()).toEqual([
      "de:title",
      "fr:title",
    ]);
    // Shopify's half of the evidence still stands on its own.
    expect(shopify.removeCalls).toEqual([{ keys: ["body_html"], locale: "de" }]);
  });
});


/**
 * A group that spans several Shopify resources — the product's OPTIONS, OPTION
 * VALUES and METAFIELDS. One merchant action, so one Task row, one batched
 * detection and one AI request per locale; but `translationsRegister` and
 * `translationsRemove` each address exactly ONE resource, so the writes fan out
 * per resource.
 */
describe("a group spanning several resources (sub-resources)", () => {
  const PRODUCT = "gid://shopify/Product/9";
  const OPTION = "gid://shopify/ProductOption/1";
  const VALUE = "gid://shopify/ProductOptionValue/2";
  const METAFIELD = "gid://shopify/Metafield/3";

  let translated: Record<string, string[]>;
  let primary: Record<string, Record<string, { value: string; digest: string | null }>>;

  const client = () => ({
    graphql: vi.fn(async (query: string, opts: { variables?: Record<string, unknown> }) => ({
      ok: true,
      json: async () => {
        const ids = (opts?.variables?.resourceIds as string[]) ?? [];
        if (query.includes("stalePrimaryContent")) {
          return {
            data: {
              translatableResourcesByIds: {
                edges: ids.map((resourceId) => ({
                  node: {
                    resourceId,
                    translatableContent: Object.entries(primary[resourceId] ?? {}).map(
                      ([key, entry]) => ({ key, value: entry.value, digest: entry.digest }),
                    ),
                  },
                })),
              },
            },
          };
        }
        const locale = String(opts?.variables?.locale ?? "");
        return {
          data: {
            translatableResourcesByIds: {
              edges: ids.map((resourceId) => ({
                node: {
                  resourceId,
                  translations: Object.keys(primary[resourceId] ?? {}).map((key) => ({
                    key,
                    locale,
                    value: (translated[locale] ?? []).includes(resourceId) ? "alt" : null,
                  })),
                },
              })),
            },
          },
        };
      },
    })),
  });

  const groupParams = (over: Record<string, unknown> = {}) => ({
    client: client() as never,
    shop: SHOP,
    resourceId: PRODUCT,
    resourceType: "Product",
    contentKind: "product" as const,
    resourceTitle: "Kumiko Box",
    changed: [
      { resourceId: OPTION, resourceType: "ProductOption", key: "name" },
      { resourceId: VALUE, resourceType: "ProductOptionValue", key: "name" },
      { resourceId: METAFIELD, resourceType: "Metafield", key: "value" },
    ],
    foreignLocales: ["fr"],
    policy: policy as never,
    translateAs: { kind: "values" as const, context: "product options", sourceLocale: "de" },
    ...over,
  });

  beforeEach(() => {
    policy.autoTranslateExternalChanges = true;
    policy.purgeOnPrimaryChange = false;
    policy.purgeUnreconciledSurfaces = true;
    translated = { fr: [OPTION, VALUE, METAFIELD] };
    primary = {
      [OPTION]: { name: { value: "Farbe", digest: NEW } },
      [VALUE]: { name: { value: "Rot", digest: NEW } },
      [METAFIELD]: { value: { value: "Massivholz", digest: NEW } },
    };
    db.contentTranslation.findMany.mockClear();
    db.contentTranslation.findMany.mockResolvedValue([]);
  });

  it("registers on each entry's OWN resource, not on the group's", async () => {
    await reconcileAfterPrimarySave(groupParams());
    await awaitDetachedRetranslations();

    expect(shopify.registerTargets.sort()).toEqual([METAFIELD, OPTION, VALUE].sort());
    expect(shopify.registerTargets).not.toContain(PRODUCT);
  });

  it("asks the AI ONCE per locale for the whole group", async () => {
    await reconcileAfterPrimarySave(groupParams());
    await awaitDetachedRetranslations();

    expect(ai.translateValues).toHaveBeenCalledTimes(1);
    expect(ai.translateValues.mock.calls[0][0]).toEqual(["Farbe", "Rot", "Massivholz"]);
    // The generic prompt, not the content-field one — an option name has no
    // field to hang SEO limits or per-field instructions on.
    expect(ai.translate).not.toHaveBeenCalled();
  });

  it("maps the answer back by INDEX, so two identical values stay apart", async () => {
    primary[VALUE] = { name: { value: "Farbe", digest: NEW } }; // same text as the option
    ai.translateValues = vi.fn(async () => ["Couleur", "Teinte", "Bois massif"]);

    await reconcileAfterPrimarySave(groupParams());
    await awaitDetachedRetranslations();

    const byResource = Object.fromEntries(
      shopify.registerCalls.map((c, i) => [shopify.registerTargets[i], c.value]),
    );
    expect(byResource[OPTION]).toBe("Couleur");
    expect(byResource[VALUE]).toBe("Teinte");
  });

  it("purges per resource when the AI cannot deliver", async () => {
    ai.translateValues = vi.fn(async () => []);

    await reconcileAfterPrimarySave(groupParams());
    await awaitDetachedRetranslations();

    expect(shopify.removeTargets.sort()).toEqual([METAFIELD, OPTION, VALUE].sort());
  });

  it("REMOVES an entry the generic prompt cannot carry, never re-translates it", async () => {
    // A multi-line text loses every newline to the prompt's sanitiser and a
    // list field is raw JSON. Either would be echo-confirmed and mirrored —
    // corruption recorded as a success, where the previous behaviour was a
    // plain deletion.
    await reconcileAfterPrimarySave(
      groupParams({
        changed: [
          { resourceId: OPTION, resourceType: "ProductOption", key: "name" },
          {
            resourceId: METAFIELD,
            resourceType: "Metafield",
            key: "value",
            retranslatable: false,
          },
        ],
      }),
    );
    await awaitDetachedRetranslations();

    expect(shopify.registerTargets).toEqual([OPTION]);
    expect(shopify.removeTargets).toEqual([METAFIELD]);
    // ...and it never reached the AI at all.
    expect(ai.translateValues.mock.calls[0][0]).toEqual(["Farbe"]);
  });

  it("REMOVES a value the single-line prompt would flatten", async () => {
    // A theme setting carries no type metadata, only a key, so the VALUE is
    // what gets asked. `translateBatchValues` sanitises with allowNewlines:
    // false and has no rule that preserves markup, so a multi-line value comes
    // back flattened and a value with tags comes back with them rewritten —
    // echo-confirmed and mirrored, i.e. corruption recorded as a success.
    primary = {
      [OPTION]: { name: { value: "Zeile eins\nZeile zwei", digest: NEW } },
      [VALUE]: { name: { value: "<p>Absatz</p>", digest: NEW } },
      [METAFIELD]: { value: { value: "Massivholz", digest: NEW } },
    };

    await reconcileAfterPrimarySave(groupParams());
    await awaitDetachedRetranslations();

    expect(shopify.registerTargets).toEqual([METAFIELD]);
    expect(shopify.removeTargets.sort()).toEqual([OPTION, VALUE].sort());
    expect(ai.translateValues.mock.calls[0][0]).toEqual(["Massivholz"]);
  });

  it("KEEPS a declined value when the merchant switched the deletion off", async () => {
    // We chose not to hand it to the AI; that is not the automation failing, so
    // the merchant's stored "don't delete" still means don't delete. Folding
    // the two would delete every richtext theme translation on such a shop.
    policy.purgeUnreconciledSurfaces = false;
    primary = {
      [OPTION]: { name: { value: "Zeile eins\nZeile zwei", digest: NEW } },
      [METAFIELD]: { value: { value: "Massivholz", digest: NEW } },
    };

    await reconcileAfterPrimarySave(
      groupParams({
        changed: [
          { resourceId: OPTION, resourceType: "ProductOption", key: "name" },
          { resourceId: METAFIELD, resourceType: "Metafield", key: "value" },
        ],
      }),
    );
    await awaitDetachedRetranslations();

    expect(shopify.registerTargets).toEqual([METAFIELD]);
    expect(shopify.removeTargets).toEqual([]);
  });

  it("claims a PRIVATE lock so the product's own reconciliation is not blocked", async () => {
    // The Task row names the product; the lock must not, or the
    // products/update webhook's field reconciliation bails for 30 seconds and
    // those translations are neither purged nor refreshed — permanently, since
    // the sync has advanced their digest baseline by then.
    // A fresh id: the save-lock map is module-level, and an earlier test in
    // this block claims PRODUCT under its own (default) lock.
    const fresh = freshProduct();
    await reconcileAfterPrimarySave(
      groupParams({ resourceId: fresh, lockId: `${fresh}#subResources` }),
    );
    await awaitDetachedRetranslations();

    expect(isTranslationRecentlySaved(`${fresh}#subResources`)).toBe(true);
    expect(isTranslationRecentlySaved(fresh)).toBe(false);
  });

  it("a SIBLING repair's own claim does not abort a private-lock run", async () => {
    // An article save runs the content repair and the featured-alt repair on
    // one id. With the group id in the watch list, the sibling's inline claim
    // aborted this run mid-locale and its remaining entries landed in neither
    // list — neither refreshed nor purged, on a surface nothing else revisits.
    const fresh = freshProduct();
    const run = reconcileAfterPrimarySave(
      groupParams({ resourceId: fresh, lockId: `${fresh}#subResources` }),
    );
    markTranslationSaved(fresh); // the sibling, mid-flight
    await run;
    await awaitDetachedRetranslations();

    expect(shopify.registerTargets.sort()).toEqual([METAFIELD, OPTION, VALUE].sort());
  });

  it("stands down for the resource the merchant wrote, and only that one", async () => {
    // Renaming two items and typing one of them's foreign title says nothing
    // about the other. An all-or-nothing abort left the other's entries in
    // neither list — nothing refreshed them, nothing removed them, on a surface
    // with no webhook to notice later.
    ai.translateValues = vi.fn(async (values: string[]) => {
      markTranslationSaved(OPTION); // the merchant, mid-request, on ONE resource
      return values.map((v) => `xx-${v}`);
    });

    await reconcileAfterPrimarySave(groupParams());
    await awaitDetachedRetranslations();

    expect(shopify.registerTargets).not.toContain(OPTION);
    expect(shopify.registerTargets.sort()).toEqual([METAFIELD, VALUE].sort());
    // …and the one the merchant wrote is left alone, not purged.
    expect(shopify.removeTargets).toEqual([]);
  });

  it("chunks the values instead of building one oversized prompt", async () => {
    const many = Array.from({ length: 95 }, (_, i) => `gid://shopify/Metafield/m${i}`);
    primary = Object.fromEntries(
      many.map((id, i) => [id, { value: { value: `text-${i}`, digest: NEW } }]),
    );
    translated = { fr: many };

    await reconcileAfterPrimarySave(
      groupParams({
        changed: many.map((id) => ({ resourceId: id, resourceType: "Metafield", key: "value" })),
      }),
    );
    await awaitDetachedRetranslations();

    // 95 values at 40 per request.
    expect(ai.translateValues).toHaveBeenCalledTimes(3);
    const sizes = ai.translateValues.mock.calls.map((c: unknown[]) => (c[0] as string[]).length);
    expect(sizes).toEqual([40, 40, 15]);
  });
});


/**
 * The pluggable mirrors. The Shopify half of a translation never varies — one
 * API, keyed by GID + key + locale — so only the LOCAL half is per surface,
 * and two of them do not even address the same row Shopify does.
 */
describe("per-surface mirrors", () => {
  it("a product medium's alt is stored by the CACHE row id, not the MediaImage GID", async () => {
    const media = "gid://shopify/MediaImage/55";
    const product = "gid://shopify/Product/900";
    const mirror = productImageAltMirror(SHOP, product);

    db.productImage.findMany.mockResolvedValue([{ id: "cache-row-7", mediaId: media }]);
    db.productImageAltTranslation.findMany.mockResolvedValue([
      { imageId: "cache-row-7", locale: "fr" },
    ]);
    // …and it is reported back under the MEDIA id, which is what the detection,
    // the removal and the register all address.
    expect(await mirror.existing([{ resourceId: media, resourceType: "MediaImage" }], ["fr"], ["alt"]))
      .toEqual([{ resourceId: media, locale: "fr", key: "alt" }]);

    await mirror.write({ resourceId: media, resourceType: "MediaImage" }, "fr", "alt", "Chaise", "d");
    const upsertArgs = (db.productImageAltTranslation.upsert.mock.calls[0] as unknown as [any])[0];
    expect(upsertArgs.where).toEqual({
      imageId_locale_marketId: { imageId: "cache-row-7", locale: "fr", marketId: "" },
    });
    // Resolved by the STABLE pair, which is the table's own unique key — never
    // by a cuid somebody captured earlier.
    const lookup = (db.productImage.findMany.mock.calls.at(-1) as unknown as [any])[0];
    expect(lookup.where).toMatchObject({ productId: product, mediaId: { in: [media] } });
    // …and the TENANCY check rides on it. A `toMatchObject` that only names the
    // pair passes with the shop filter deleted, which is how a multi-tenant
    // lookup comes to read another shop's rows with every test still green.
    expect(lookup.where.product).toEqual({ shop: SHOP });
  });

  it("writes under the cache row the product sync RECREATED mid-run, not the one collected", async () => {
    // The regression this mirror exists for. `syncProduct` does not update a
    // product's ProductImage rows — it deleteMany + createMany, minting a new
    // cuid per image — and the bulk editor's own alt write fires the
    // `products/update` webhook that triggers exactly that, seconds into a
    // detached AI run that takes far longer. A cuid captured when the repair
    // group was collected is a DANGLING FK by the time the run mirrors its
    // confirmed write, so the upsert's create fails, the merchant's field stays
    // empty for good, and Shopify keeps serving a translation nothing can show.
    const media = "gid://shopify/MediaImage/55";
    const product = "gid://shopify/Product/901";
    const mirror = productImageAltMirror(SHOP, product);

    db.productImage.findMany.mockResolvedValue([{ id: "cache-row-before", mediaId: media }]);
    await mirror.write({ resourceId: media, resourceType: "MediaImage" }, "de", "alt", "Stuhl", "d");

    // …the sync lands between two locales of the SAME run.
    db.productImage.findMany.mockResolvedValue([{ id: "cache-row-after", mediaId: media }]);
    await mirror.write({ resourceId: media, resourceType: "MediaImage" }, "fr", "alt", "Chaise", "d");

    const ids = db.productImageAltTranslation.upsert.mock.calls.map(
      (call: unknown[]) => (call[0] as any).where.imageId_locale_marketId.imageId,
    );
    expect(ids).toEqual(["cache-row-before", "cache-row-after"]);
  });

  it("REPORTS an image with no cached row instead of skipping it silently", async () => {
    // Silence is the failure mode, not the write: Shopify has already confirmed
    // the translation by the time a mirror write runs, so "no row here" means
    // the storefront serves a value no editor in this app can render. The
    // caller's mirror-failure bookkeeping has to see it.
    const mirror = productImageAltMirror(SHOP, "gid://shopify/Product/902");
    db.productImage.findMany.mockResolvedValue([]);

    await expect(
      mirror.write({ resourceId: "gid://shopify/MediaImage/1", resourceType: "MediaImage" }, "fr", "alt", "x", "d"),
    ).rejects.toThrow(/could not be mirrored/);
    expect(db.productImageAltTranslation.upsert).not.toHaveBeenCalled();
  });

  it("removes nothing for an image whose cache row is gone — the cascade already did", async () => {
    const mirror = productImageAltMirror(SHOP, "gid://shopify/Product/903");
    db.productImage.findMany.mockResolvedValue([]);

    await mirror.remove({ resourceId: "gid://shopify/MediaImage/1", resourceType: "MediaImage" }, "fr", ["alt"]);
    expect(db.productImageAltTranslation.deleteMany).not.toHaveBeenCalled();
  });

  it("a featured alt rewrites BOTH halves back to the parent row both editors read", async () => {
    // Shopify: key `alt` on the CollectionImage GID. Mirror: `image_alt_text`
    // on the COLLECTION. The third translation shape (CLAUDE.md).
    const parent = "gid://shopify/Collection/3";
    const image = "gid://shopify/CollectionImage/9";
    const mirror = featuredImageAltMirror(SHOP, parent, "Collection");

    await mirror.write({ resourceId: image, resourceType: "MediaImage" }, "fr", "alt", "Vase", "dg");
    const call = (db.contentTranslation.upsert.mock.calls.at(-1) as unknown as [any])[0];
    expect(call.where.shop_resourceId_key_locale_marketId).toMatchObject({
      resourceId: parent,
      key: "image_alt_text",
      locale: "fr",
    });
    expect(call.create).toMatchObject({ resourceType: "Collection", value: "Vase", digest: "dg" });
  });
});

/**
 * The handle opt-in (`AISettings.autoTranslateHandles`).
 *
 * The pure half — "may a handle move at all" — is in stale-translations.test.ts.
 * What is tested here is the part that costs a URL if it is wrong: the value is
 * written as a SLUG, the old foreign address gets its redirect, and a handle
 * with no redirect available is left exactly where it is — neither translated
 * nor deleted.
 */
describe("handle re-translation", () => {
  /** The resource id the market-override fake answers for. */
  let baseId = "";

  /** A resource whose stale set is one `handle` in German. */
  function handleParams(over: Record<string, unknown> = {}) {
    return baseParams({
      translations: [{ key: "handle", value: "kiste-alt", locale: "de", marketId: "", outdated: true }],
      primaryContent: { handle: { value: "kumiko-box", digest: NEW } },
      previousDigests: { [digestBaselineKey("de", "handle")]: OLD },
      ...over,
    });
  }

  /** A resolver that answers: the German handle may move, and here is its old
   *  address plus everything the redirect decision needs. */
  const resolver = async () => ({
    resource: "product" as const,
    previousTranslatedHandle: "kiste-alt",
    primaryHandle: "kumiko-box",
    otherLocaleHandles: [],
    previousHandleTakenElsewhere: false,
    previouslyLive: true,
    blogHandle: null,
    blogHandleTranslatedInLocale: false,
  });

  it("writes the AI's answer as a SLUG and redirects the old foreign URL", async () => {
    policy.autoTranslateExternalChanges = true;
    policy.autoTranslateHandles = true;
    policy.purgeOnPrimaryChange = false;
    // The generic prompt answers with prose — capitals, an umlaut, punctuation.
    ai.translate = vi.fn(async () => ({ de: { handle: "Kumiko Schatulle!" } }));

    await reconcileStaleTranslations(handleParams({ handleRedirect: resolver }));
    await awaitDetachedRetranslations();

    expect(shopify.registerCalls).toEqual([
      { key: "handle", locale: "de", value: "kumiko-schatulle", translatableContentDigest: NEW },
    ]);
    expect(shopify.redirectCalls).toEqual([{ from: "kiste-alt", to: "kumiko-schatulle" }]);
    // Nothing was deleted: the whole point is that the old URL survives as a
    // redirect rather than as a hole.
    expect(shopify.removeCalls).toEqual([]);
  });

  it("leaves the handle ALONE when no redirect can be established — no write, no purge", async () => {
    policy.autoTranslateExternalChanges = true;
    policy.autoTranslateHandles = true;
    // The merchant's stored deletion answer is ON, which is what would
    // otherwise sweep a declined entry into the removal.
    policy.purgeUnreconciledSurfaces = true;
    ai.translate = vi.fn(async () => ({ de: { handle: "Kumiko Schatulle" } }));

    const result = await reconcileStaleTranslations(
      handleParams({ handleRedirect: async () => null }),
    );
    await awaitDetachedRetranslations();

    expect(shopify.registerCalls).toEqual([]);
    expect(shopify.redirectCalls).toEqual([]);
    // A stale handle is still a WORKING URL, so deleting it would move the
    // foreign address with no redirect — the outcome the option exists to avoid.
    expect(shopify.removeCalls).toEqual([]);
    expect(result.removed).toBe(0);
    expect(db.contentTranslation.deleteMany).not.toHaveBeenCalled();
  });

  it("RECORDS a refused redirect, so the next look does not prove the same move again", async () => {
    // Keeping writes nothing, so without this the mirror digest stays old,
    // Shopify's row stays `outdated`, and the drift sweep hands the same page
    // over every night forever — one of its per-type slots each time.
    policy.autoTranslateExternalChanges = true;
    policy.autoTranslateHandles = true;

    await reconcileStaleTranslations(handleParams({ handleRedirect: async () => null }));
    await awaitDetachedRetranslations();

    expect(db.contentTranslation.updateMany).toHaveBeenCalledTimes(1);
    const call = (db.contentTranslation.updateMany.mock.calls[0] as unknown as [any])[0];
    expect(call.where).toMatchObject({ key: "handle", locale: "de", marketId: "" });
    // The digest moves; the VALUE is not in the write at all.
    expect(call.data).toEqual({ digest: NEW });
  });

  it("a DELIBERATELY discarded answer is recorded and does not fail the task", async () => {
    policy.autoTranslateExternalChanges = true;
    policy.autoTranslateHandles = true;
    ai.translate = vi.fn(async () => ({ de: { handle: "組子箱" } }));

    await reconcileStaleTranslations(handleParams({ handleRedirect: resolver }));
    await awaitDetachedRetranslations();

    expect(db.contentTranslation.updateMany).toHaveBeenCalledTimes(1);
    const final = db.task.update.mock.calls.at(-1) as unknown as [any];
    // Leaving the working URL alone is the designed outcome, not a failure.
    expect(final[0].data.status).toBe("completed");
    expect(final[0].data.error).toBeUndefined();
  });

  it("a TRANSIENT keep is not recorded — the next change event tries again", async () => {
    policy.autoTranslateExternalChanges = true;
    policy.autoTranslateHandles = true;
    ai.translate = vi.fn(async () => {
      throw new Error("provider down");
    });

    await reconcileStaleTranslations(handleParams({ handleRedirect: resolver }));
    await awaitDetachedRetranslations();

    expect(db.contentTranslation.updateMany).not.toHaveBeenCalled();
    const final = db.task.update.mock.calls.at(-1) as unknown as [any];
    expect(final[0].data.status).toBe("failed");
  });

  it("ATTACHES the production resolver when the caller passes none", async () => {
    // Every other test here injects its own `handleRedirect`, so without this
    // one `withHandleResolver` could become a no-op and nothing would notice —
    // every handle on every sync path would then be declined for good.
    policy.autoTranslateExternalChanges = true;
    policy.autoTranslateHandles = true;
    factory.built = 0;
    factory.resolver = resolver;
    ai.translate = vi.fn(async () => ({ de: { handle: "Kumiko Schatulle" } }));

    await reconcileStaleTranslations(handleParams());
    await awaitDetachedRetranslations();
    factory.resolver = null;

    expect(factory.built).toBe(1);
    expect(shopify.registerCalls).toEqual([
      { key: "handle", locale: "de", value: "kumiko-schatulle", translatableContentDigest: NEW },
    ]);
    expect(shopify.redirectCalls).toEqual([{ from: "kiste-alt", to: "kumiko-schatulle" }]);
  });

  it("REPORTS a redirect that could not be written after the handle was", async () => {
    // Unattended, and the mirror has advanced to the new slug — nothing will
    // ever rebuild that redirect, so the Task row is the only place the
    // merchant can learn the old foreign URL is dead.
    policy.autoTranslateExternalChanges = true;
    policy.autoTranslateHandles = true;
    ai.translate = vi.fn(async () => ({ de: { handle: "Kumiko Schatulle" } }));
    const redirect = await import("../../app/services/seo/handle-redirect.server");
    vi.mocked(redirect.applyTranslatedHandleRedirect).mockImplementationOnce(async () => {
      throw new Error("redirect API down");
    });

    await reconcileStaleTranslations(handleParams({ handleRedirect: resolver }));
    await awaitDetachedRetranslations();

    expect(shopify.registerCalls).toHaveLength(1);
    const final = db.task.update.mock.calls.at(-1) as unknown as [any];
    expect(final[0].data.status).toBe("completed_with_errors");
    expect(final[0].data.error).toBe("handle_redirects_missing:1");
    expect(JSON.parse(final[0].data.result)).toMatchObject({ redirectsMissing: 1 });
  });

  it("purges the handle when the opt-in is off — unchanged behaviour", async () => {
    policy.autoTranslateExternalChanges = true;
    policy.autoTranslateHandles = false;
    ai.translate = vi.fn(async () => ({ de: { handle: "egal" } }));

    await reconcileStaleTranslations(handleParams({ handleRedirect: resolver }));
    await awaitDetachedRetranslations();

    expect(shopify.registerCalls).toEqual([]);
    expect(shopify.removeCalls).toEqual([{ keys: ["handle"], locale: "de" }]);
  });

  it("discards an answer that cannot be normalised into a slug, and keeps the old one", async () => {
    policy.autoTranslateExternalChanges = true;
    policy.autoTranslateHandles = true;
    // A non-Latin answer collapses to "" under the ASCII sanitiser.
    ai.translate = vi.fn(async () => ({ de: { handle: "組子箱" } }));

    await reconcileStaleTranslations(handleParams({ handleRedirect: resolver }));
    await awaitDetachedRetranslations();

    expect(shopify.registerCalls).toEqual([]);
    expect(shopify.redirectCalls).toEqual([]);
    // Undelivered, but NOT swept into the fallback purge with the other
    // failures: that list deletes, and a deleted handle is a moved URL.
    expect(shopify.removeCalls).toEqual([]);
  });

  it("discards an answer identical to the PRIMARY handle — duplicate slugs break routing", async () => {
    policy.autoTranslateExternalChanges = true;
    policy.autoTranslateHandles = true;
    // The same rule the single editor (skip) and the bulk editor (fail the
    // cell) carry. Unattended, the AI answering with the primary slug is the
    // likeliest way one would get written.
    ai.translate = vi.fn(async () => ({ de: { handle: "Kumiko Box" } }));

    await reconcileStaleTranslations(handleParams({ handleRedirect: resolver }));
    await awaitDetachedRetranslations();

    expect(shopify.registerCalls).toEqual([]);
    expect(shopify.removeCalls).toEqual([]);
  });

  it("keeps the MARKET override of a handle it refreshed — an override is a URL too", async () => {
    policy.autoTranslateExternalChanges = true;
    policy.autoTranslateHandles = true;
    // The shop holds a market-scoped handle for the same (locale, key).
    db.contentTranslation.findMany.mockImplementation(async (args: any) =>
      args?.where?.marketId?.not === ""
        ? [{ resourceId: baseId, key: "handle", locale: "de", marketId: "gid://shopify/Market/1" }]
        : [],
    );
    ai.translate = vi.fn(async () => ({ de: { handle: "Kumiko Schatulle" } }));

    const id = freshProduct();
    baseId = id;
    await reconcileStaleTranslations(handleParams({ resourceId: id, handleRedirect: resolver }));
    await awaitDetachedRetranslations();

    // Nothing in this app can ever re-translate a market override (the redirect
    // decision refuses a market-scoped path), so removing it would move that
    // market's address with no redirect.
    expect(shopify.removeMarkets).toEqual([]);
  });

  it("does not purge the handle when the AI request itself fails", async () => {
    policy.autoTranslateExternalChanges = true;
    policy.autoTranslateHandles = true;
    ai.translate = vi.fn(async () => {
      throw new Error("provider down");
    });

    await reconcileStaleTranslations(handleParams({ handleRedirect: resolver }));
    await awaitDetachedRetranslations();

    // The locale's fallback sweep purges what it could not deliver — except a
    // handle, whose stale translation is a working URL.
    expect(shopify.removeCalls).toEqual([]);
    expect(shopify.registerCalls).toEqual([]);
  });

  it("still re-translates the other fields when a handle is left alone", async () => {
    policy.autoTranslateExternalChanges = true;
    policy.autoTranslateHandles = true;
    ai.translate = vi.fn(async () => ({ de: { title: "Kumiko Schatulle", handle: "egal" } }));

    await reconcileStaleTranslations(
      handleParams({
        translations: [
          { key: "handle", value: "kiste-alt", locale: "de", marketId: "", outdated: true },
          { key: "title", value: "Kiste", locale: "de", marketId: "", outdated: true },
        ],
        primaryContent: {
          handle: { value: "kumiko-box", digest: NEW },
          title: { value: "Kumiko Box", digest: NEW },
        },
        previousDigests: {
          [digestBaselineKey("de", "handle")]: OLD,
          [digestBaselineKey("de", "title")]: OLD,
        },
        handleRedirect: async () => null,
      }),
    );
    await awaitDetachedRetranslations();

    expect(shopify.registerCalls.map((c) => c.key)).toEqual(["title"]);
    expect(shopify.removeCalls).toEqual([]);
  });
});

describe("the PRIMARY digest baseline — a resource nobody has translated yet", () => {
  // The merchant report: auto-translate on, a title edited in the Shopify admin
  // on a product with NO translation. The first entrance cannot see it (no
  // translation row, no digest on one); only the per-resource baseline can.
  beforeEach(() => {
    policy.autoTranslateExternalChanges = true;
    policy.purgeOnPrimaryChange = false;
    ai.translate = vi.fn(async (fields: Record<string, string>, locales: string[]) =>
      Object.fromEntries(
        locales.map((locale) => [
          locale,
          Object.fromEntries(Object.keys(fields).map((k) => [k, `${locale}-${k}`])),
        ]),
      ),
    );
  });

  /**
   * The presence check the second entrance asks SHOPIFY before filling: locale
   * → keys that really hold a value there. `null` = the query fails.
   */
  function shopifyHolding(present: Record<string, string[]> | null) {
    return {
      graphql: vi.fn(async (_query: string, opts?: { variables?: Record<string, unknown> }) => {
        if (present === null) throw new Error("Throttled");
        const vars = opts?.variables ?? {};
        const resource: Record<string, unknown> = {};
        for (const [name, locale] of Object.entries(vars)) {
          if (!name.startsWith("loc")) continue;
          resource[`l${name.slice(3)}`] = (present[String(locale)] ?? []).map((key) => ({ key, value: "v" }));
        }
        return { json: async () => ({ data: { translatableResource: resource } }) };
      }),
    } as never;
  }

  /** An untranslated product whose text is now NEW. */
  function untranslated(over: Record<string, unknown> = {}) {
    return baseParams({
      client: shopifyHolding({}),
      translations: [],
      previousDigests: {},
      foreignLocales: ["de", "fr"],
      ...over,
    });
  }

  it("RULE ONE: an EMPTY baseline table + a changed text ⇒ ZERO translations, only a baseline", async () => {
    // The first sync after the deploy. This is the expensive direction the whole
    // design is arranged around: without it, the first webhook per product would
    // translate the catalogue into every language on the merchant's key.
    const params = untranslated();
    const result = await reconcileStaleTranslations(params);
    await awaitDetachedRetranslations();

    expect(result).toEqual({ removed: 0, retranslating: 0 });
    expect(ai.translate).not.toHaveBeenCalled();
    expect(shopify.registerCalls).toEqual([]);
    expect(db.task.create).not.toHaveBeenCalled();
    // …and what it saw is recorded, so the NEXT edit is provable.
    expect(db.primaryDigestBaseline.upsert).toHaveBeenCalledTimes(1);
    expect((db.primaryDigestBaseline.upsert.mock.calls[0] as any[])[0]).toMatchObject({
      where: { shop_resourceId: { shop: SHOP, resourceId: params.resourceId } },
      create: { resourceType: "Product", digests: { title: NEW, body_html: NEW } },
    });
  });

  it("translates EVERY published locale once the digest moved against a stored baseline", async () => {
    db.primaryDigestBaseline.findUnique.mockResolvedValue({ digests: { title: OLD, body_html: OLD } });

    const result = await reconcileStaleTranslations(untranslated());
    await awaitDetachedRetranslations();

    expect(result.retranslating).toBe(4);
    expect(shopify.registerCalls.map((c) => `${c.locale}:${c.key}`).sort()).toEqual([
      "de:body_html",
      "de:title",
      "fr:body_html",
      "fr:title",
    ]);
    expect(shopify.removeCalls).toEqual([]);
  });

  it("leaves a locale whose translation Shopify reports `outdated: false` untouched", async () => {
    db.primaryDigestBaseline.findUnique.mockResolvedValue({ digests: { title: OLD } });

    await reconcileStaleTranslations(
      baseParams({
        client: shopifyHolding({ de: ["title"] }),
        translations: [{ key: "title", value: "Titel", locale: "de", marketId: "", outdated: false }],
        previousDigests: { [digestBaselineKey("de", "title")]: OLD },
        primaryContent: { title: { value: "Box", digest: NEW } },
        foreignLocales: ["de", "fr"],
      }),
    );
    await awaitDetachedRetranslations();

    expect(shopify.registerCalls.map((c) => `${c.locale}:${c.key}`)).toEqual(["fr:title"]);
    expect(shopify.removeCalls).toEqual([]);
  });

  it("does nothing — and writes nothing — when the digest did not move", async () => {
    db.primaryDigestBaseline.findUnique.mockResolvedValue({ digests: { title: NEW, body_html: NEW } });

    const result = await reconcileStaleTranslations(untranslated());
    await awaitDetachedRetranslations();

    expect(result).toEqual({ removed: 0, retranslating: 0 });
    expect(ai.translate).not.toHaveBeenCalled();
    // A sync with no text change must not cost a database write.
    expect(db.primaryDigestBaseline.upsert).not.toHaveBeenCalled();
  });

  it("reads the baseline BEFORE it writes the next one", async () => {
    db.primaryDigestBaseline.findUnique.mockResolvedValue({ digests: { title: OLD, body_html: OLD } });

    await reconcileStaleTranslations(untranslated());
    await awaitDetachedRetranslations();

    // The write here is the CLAIM — a compare-and-swap against exactly what
    // was read, so it cannot land before that read by construction.
    const readAt = db.primaryDigestBaseline.findUnique.mock.invocationCallOrder[0];
    const writeAt = db.primaryDigestBaseline.updateMany.mock.invocationCallOrder[0];
    expect(readAt).toBeLessThan(writeAt);
    expect((db.primaryDigestBaseline.updateMany.mock.calls[0] as any[])[0]).toMatchObject({
      where: { digests: { equals: { title: OLD, body_html: OLD } } },
      data: { digests: { title: NEW, body_html: NEW } },
    });
    // Already stored by the claim ⇒ no second write.
    expect(db.primaryDigestBaseline.upsert).not.toHaveBeenCalled();
  });

  it("still advances the baseline with auto-translate OFF — a change seen then is not replayed later", async () => {
    policy.autoTranslateExternalChanges = false;
    policy.purgeOnPrimaryChange = true;
    db.primaryDigestBaseline.findUnique.mockResolvedValue({ digests: { title: OLD, body_html: OLD } });

    const result = await reconcileStaleTranslations(untranslated());
    await awaitDetachedRetranslations();

    expect(result).toEqual({ removed: 0, retranslating: 0 });
    expect(shopify.registerCalls).toEqual([]);
    expect(db.primaryDigestBaseline.upsert).toHaveBeenCalledTimes(1);
  });

  it("writes NO baseline when the read failed — it would erase evidence it never compared", async () => {
    db.primaryDigestBaseline.findUnique.mockRejectedValue(new Error("db down"));

    const result = await reconcileStaleTranslations(untranslated());
    await awaitDetachedRetranslations();

    expect(result).toEqual({ removed: 0, retranslating: 0 });
    expect(db.primaryDigestBaseline.upsert).not.toHaveBeenCalled();
  });

  it("THE BRAKE: past the daily cap the fill is refused, REPORTED, and its baseline HELD", async () => {
    db.primaryDigestBaseline.findUnique.mockResolvedValue({ digests: { title: OLD, body_html: OLD } });
    db.autoTranslateFillBudget.updateMany.mockResolvedValue({ count: 0 }); // cap reached
    // Two OTHER resources were refused earlier today; this one is the third.
    db.$queryRaw.mockResolvedValue([{ refused: 3 }]);

    const result = await reconcileStaleTranslations(untranslated());
    await awaitDetachedRetranslations();

    expect(result).toEqual({ removed: 0, retranslating: 0 });
    expect(ai.translate).not.toHaveBeenCalled();
    // Held, not swallowed: the claim had advanced the row, so the final write
    // puts both keys back to OLD — the next change event can still prove it.
    expect((db.primaryDigestBaseline.upsert.mock.calls[0] as any[])[0].update.digests).toEqual({
      title: OLD,
      body_html: OLD,
    });
    // Visible: one Task row per shop and day, carrying a renderable code that
    // counts RESOURCES.
    expect(db.task.upsert).toHaveBeenCalledTimes(1);
    const task = (db.task.upsert.mock.calls[0] as any[])[0];
    expect(task.create.error).toMatch(/^auto_translate_daily_limit:3:\d+$/);
    expect(task.update.error).toBe(task.create.error);
  });

  it("counts a resource refused TWICE today once — resources, not events", async () => {
    db.primaryDigestBaseline.findUnique.mockResolvedValue({ digests: { title: OLD, body_html: OLD } });
    db.autoTranslateFillBudget.updateMany.mockResolvedValue({ count: 0 });
    const params = untranslated();
    // The statement appends only an ABSENT id and returns the distinct count;
    // a repeat refusal therefore reports the same number it did before.
    db.$queryRaw.mockResolvedValue([{ refused: 2 }]);

    await reconcileStaleTranslations(params);

    const [sql, ...values] = db.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(sql.join("?")).toMatch(/= ANY\(/);
    expect(values).toContain(params.resourceId);
    const task = (db.task.upsert.mock.calls[0] as any[])[0];
    expect(task.create.error).toMatch(/^auto_translate_daily_limit:2:\d+$/);
  });

  it("a SPENT budget is refused before anything costs a Shopify call", async () => {
    // During the mass edit the brake exists for, every further webhook used to
    // pay the existence query, the claim and its revert first.
    db.primaryDigestBaseline.findUnique.mockResolvedValue({ digests: { title: OLD, body_html: OLD } });
    db.autoTranslateFillBudget.findUnique.mockResolvedValue({ used: 10_000 });
    const client = shopifyHolding({});
    const graphql = (client as unknown as { graphql: ReturnType<typeof vi.fn> }).graphql;

    const result = await reconcileStaleTranslations(untranslated({ client }));
    await awaitDetachedRetranslations();

    expect(result).toEqual({ removed: 0, retranslating: 0 });
    expect(graphql).not.toHaveBeenCalled();
    // No claim, and the row is left exactly as it is — never written with held
    // keys over what another webhook may have claimed.
    expect(db.primaryDigestBaseline.updateMany).not.toHaveBeenCalled();
    expect(db.primaryDigestBaseline.upsert).not.toHaveBeenCalled();
    expect(db.task.upsert).toHaveBeenCalledTimes(1);
  });

  it("a budget that could not be RESERVED is not reported as the daily limit", async () => {
    db.primaryDigestBaseline.findUnique.mockResolvedValue({ digests: { title: OLD, body_html: OLD } });
    db.autoTranslateFillBudget.updateMany.mockRejectedValue(new Error("db down"));

    const result = await reconcileStaleTranslations(untranslated({ client: shopifyHolding({}) }));
    await awaitDetachedRetranslations();

    // Fails closed…
    expect(result.retranslating).toBe(0);
    expect(ai.translate).not.toHaveBeenCalled();
    // …but "100 reached" would be a false statement about the shop.
    expect(db.task.upsert).not.toHaveBeenCalled();
  });

  it("the brake leaves the FIRST entrance's work alone — that work existed before it", async () => {
    db.primaryDigestBaseline.findUnique.mockResolvedValue({ digests: { title: OLD, body_html: OLD } });
    db.autoTranslateFillBudget.updateMany.mockResolvedValue({ count: 0 });

    const result = await reconcileStaleTranslations(
      baseParams({
        // Shopify confirms the fill target is empty, so the run really reaches
        // the claim and the (refusing) budget — with a bare mock the existence
        // check threw, the fill was held there, and this test passed without
        // the brake ever running.
        client: shopifyHolding({ de: ["title"] }),
        // title is translated in de and proven by ITS row; body_html is not
        // translated anywhere and rests on the primary baseline alone.
        translations: [{ key: "title", value: "Titre", locale: "de", marketId: "", outdated: true }],
        previousDigests: { [digestBaselineKey("de", "title")]: OLD },
        foreignLocales: ["de"],
      }),
    );
    await awaitDetachedRetranslations();

    expect(result.retranslating).toBe(1);
    expect(shopify.registerCalls.map((c) => `${c.locale}:${c.key}`)).toEqual(["de:title"]);
    // body_html's baseline is held back; title's advances.
    const written = (db.primaryDigestBaseline.upsert.mock.calls[0] as any[])[0].update.digests;
    expect(written).toEqual({ title: NEW, body_html: OLD });
    // …and it WAS the brake that refused, not the existence check.
    expect(db.autoTranslateFillBudget.updateMany).toHaveBeenCalled();
  });

  it("asks SHOPIFY before filling: a locale the sync failed to read is not taken as empty", async () => {
    // The sync's read of `fr` failed, so the rows handed in say nothing about
    // it — but Shopify holds a (hand-written) French title. Filling it would
    // overwrite that translation.
    db.primaryDigestBaseline.findUnique.mockResolvedValue({ digests: { title: OLD } });

    const result = await reconcileStaleTranslations(
      untranslated({
        client: shopifyHolding({ fr: ["title"] }),
        primaryContent: { title: { value: "Box", digest: NEW } },
      }),
    );
    await awaitDetachedRetranslations();

    expect(result.retranslating).toBe(1);
    expect(shopify.registerCalls.map((c) => `${c.locale}:${c.key}`)).toEqual(["de:title"]);
  });

  it("fills NOTHING and HOLDS the baseline when Shopify cannot answer that question", async () => {
    db.primaryDigestBaseline.findUnique.mockResolvedValue({ digests: { title: OLD, body_html: OLD } });

    const result = await reconcileStaleTranslations(untranslated({ client: shopifyHolding(null) }));
    await awaitDetachedRetranslations();

    expect(result).toEqual({ removed: 0, retranslating: 0 });
    expect(ai.translate).not.toHaveBeenCalled();
    expect(db.autoTranslateFillBudget.updateMany).not.toHaveBeenCalled();
    // Held: no evidence either way ⇒ the move stays provable.
    expect(db.primaryDigestBaseline.upsert).not.toHaveBeenCalled();
    expect(db.primaryDigestBaseline.updateMany).not.toHaveBeenCalled();
  });

  it("the CLAIM: a second webhook for the same move loses the swap and starts nothing", async () => {
    // One admin save fires several `products/update`; both read OLD. Only the
    // compare-and-swap winner may translate, or every locale is done twice.
    db.primaryDigestBaseline.findUnique.mockResolvedValue({ digests: { title: OLD, body_html: OLD } });
    db.primaryDigestBaseline.updateMany.mockResolvedValue({ count: 0 });

    const result = await reconcileStaleTranslations(untranslated());
    await awaitDetachedRetranslations();

    expect(result).toEqual({ removed: 0, retranslating: 0 });
    expect(ai.translate).not.toHaveBeenCalled();
    expect(db.autoTranslateFillBudget.updateMany).not.toHaveBeenCalled();
    expect(db.primaryDigestBaseline.upsert).not.toHaveBeenCalled();
  });

  it("does not advance the baseline while a save of OURS is in flight for the resource", async () => {
    db.primaryDigestBaseline.findUnique.mockResolvedValue({ digests: { title: OLD, body_html: OLD } });
    const params = untranslated();
    markTranslationSaved(params.resourceId as string);

    await reconcileStaleTranslations(params);

    expect(db.primaryDigestBaseline.upsert).not.toHaveBeenCalled();
    expect(db.primaryDigestBaseline.updateMany).not.toHaveBeenCalled();
  });

  it("a price edit (no text digest moved) costs no policy read, no budget and no write", async () => {
    db.primaryDigestBaseline.findUnique.mockResolvedValue({ digests: { title: NEW, body_html: NEW } });

    await reconcileStaleTranslations(untranslated());

    expect(db.autoTranslateFillBudget.updateMany).not.toHaveBeenCalled();
    expect(db.primaryDigestBaseline.upsert).not.toHaveBeenCalled();
  });
});

describe("seedPrimaryDigestBaselines", () => {
  it("only ever CREATES — a full sync never advances an existing baseline", async () => {
    // The full sync does not reconcile, so advancing a row here would swallow
    // every admin edit since the last change event: the move could no longer
    // be proven by anything. `skipDuplicates` is the whole rule.
    const { seedPrimaryDigestBaselines } = await import(
      "../../app/services/translations/stale-translation-sync.server"
    );
    db.primaryDigestBaseline.createMany.mockClear();

    await seedPrimaryDigestBaselines(SHOP, "Product", [
      {
        resourceId: "gid://shopify/Product/1",
        content: [
          { key: "title", digest: NEW },
          // Not a key this app manages: never part of a baseline.
          { key: "vendor", digest: "x" },
        ],
      },
      // Nothing managed with a digest: no row at all.
      { resourceId: "gid://shopify/Product/2", content: [{ key: "title", digest: null }] },
    ]);

    const call = (db.primaryDigestBaseline.createMany.mock.calls[0] as unknown as [any])[0];
    expect(call.skipDuplicates).toBe(true);
    expect(call.data).toEqual([
      { shop: SHOP, resourceId: "gid://shopify/Product/1", resourceType: "Product", digests: { title: NEW } },
    ]);
    expect(db.primaryDigestBaseline.upsert).not.toHaveBeenCalled();
    expect(db.primaryDigestBaseline.updateMany).not.toHaveBeenCalled();
  });
});
