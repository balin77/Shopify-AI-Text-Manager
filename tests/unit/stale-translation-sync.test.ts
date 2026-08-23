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
      findMany: vi.fn(async (): Promise<Array<{ resourceId?: string; key: string; locale: string }>> => []),
    },
    productImageAltTranslation: {
      findMany: vi.fn(async (): Promise<Array<{ imageId: string; locale: string }>> => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      upsert: vi.fn(async () => ({})),
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
    /** Which Shopify RESOURCE each remove/register call addressed — a group can
     *  span several, and both mutations take exactly one. */
    removeTargets: [] as string[],
    registerTargets: [] as string[],
    /** The gap re-reads: what the folded removal did not echo back. */
    rereadCalls: [] as Array<{ keys: string[]; locale: string }>,
    rereadConfirms: null as null | Record<string, string[]>,
    registerConfirms: null as null | string[],
    registerCalls: [] as Array<{ key: string; locale: string; value: string }>,
  };
  const ai = {
    translate: vi.fn(async () => ({})) as any,
    translateValues: vi.fn(async () => []) as any,
  };
  const policy = { purgeOnPrimaryChange: true, autoTranslateExternalChanges: false, plan: "max" };
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
    async (_gw: unknown, resourceId: string, keys: string[], locales: string[]) => {
      shopify.removeTargets.push(resourceId);
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
    translateValues(...args: unknown[]) {
      return ai.translateValues(...args);
    }
  },
}));

import {
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
  shopify.registerTargets = [];
  shopify.rereadCalls = [];
  shopify.rereadConfirms = null;
  shopify.removeConfirms = null;
  shopify.registerConfirms = null;
  policy.purgeOnPrimaryChange = true;
  policy.autoTranslateExternalChanges = false;
  db.contentTranslation.deleteMany.mockClear();
  db.contentTranslation.upsert.mockClear();
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
                  // translated.
                  translations: Object.keys(primaryContent[resourceId] ?? {}).map((key) => ({
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
    policy.autoTranslateExternalChanges = true;
    policy.purgeOnPrimaryChange = false;
    db.contentTranslation.findMany.mockClear();
    db.contentTranslation.findMany.mockResolvedValue([
      { resourceId: PAGE, key: "title", locale: "de" },
      { resourceId: PAGE, key: "body_html", locale: "de" },
    ]);
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

  it("names the webhook-less content types and NOT the two the sync already repairs", () => {
    // Product and Collection have an update webhook, so starting a second run
    // from the save would queue a duplicate AI run behind a repair that has
    // already happened.
    expect([...IN_APP_RETRANSLATED_RESOURCE_TYPES].sort()).toEqual([
      "Article",
      "Blog",
      "Page",
      "ShopPolicy",
    ]);
    expect(IN_APP_RETRANSLATED_RESOURCE_TYPES.has("Product")).toBe(false);
    expect(IN_APP_RETRANSLATED_RESOURCE_TYPES.has("Collection")).toBe(false);
  });

  it("re-translates the changed keys instead of deleting them", async () => {
    const result = await reconcileAfterPrimarySave(saveParams());
    await awaitDetachedRetranslations();

    expect(result.retranslating).toBe(2);
    expect(result.removed).toBe(0);
    expect(shopify.removeCalls).toEqual([]);
    expect(shopify.registerCalls.map((c) => c.key).sort()).toEqual(["body_html", "title"]);
    expect(shopify.registerCalls.every((c) => c.locale === "de")).toBe(true);
  });

  it("needs NO digest baseline — the save IS the change event", async () => {
    // The sync-side gate exists to prove the primary text moved. Here the
    // caller performed the write, so running that gate would only ADD a way to
    // miss: a mirror row with no digest would pass no gate and its translation
    // would be neither refreshed nor removed — live, describing text that no
    // longer exists. `previousDigests` is not even a parameter here, and the
    // rows the lookup returns carry no digest of their own.
    await reconcileAfterPrimarySave(saveParams());
    await awaitDetachedRetranslations();

    expect(shopify.registerCalls).toHaveLength(2);
    const where = (db.contentTranslation.findMany.mock.calls.at(-1) as unknown as [{ where: any }])[0].where;
    expect(where).toMatchObject({ marketId: "" });
    expect(where.OR).toEqual([{ resourceId: PAGE, resourceType: "Page" }]);
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
    const result = await reconcileAfterPrimarySave(
      saveParams({ primaryContent: { title: { value: "About us", digest: NEW } } }),
    );
    await awaitDetachedRetranslations();

    expect(result.removed).toBe(1);
    expect(shopify.removeCalls).toEqual([{ keys: ["body_html"], locale: "de" }]);
    expect(shopify.registerCalls).toEqual([]);
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

  it("touches nothing when the resource has no translations at all", async () => {
    shopifyHas = {};
    db.contentTranslation.findMany.mockResolvedValue([]);
    const result = await reconcileAfterPrimarySave(saveParams());

    expect(result).toEqual({ removed: 0, retranslating: 0 });
    expect(shopify.removeCalls).toEqual([]);
    expect(shopify.registerCalls).toEqual([]);
  });

  it("ignores a locale Shopify reports with no value — that is not a translation", async () => {
    // `translations(locale:)` answers with a row per translatable key and a null
    // value where the locale has nothing. Taking those as translations would not
    // repair anything: it would CREATE translations into locales the merchant
    // deliberately never translated, unattended and on their own API key.
    db.contentTranslation.findMany.mockResolvedValue([]);
    shopifyHas = { de: ["title"] }; // fr has rows, all of them empty

    await reconcileAfterPrimarySave(saveParams());
    await awaitDetachedRetranslations();

    expect(shopify.registerCalls).toEqual([
      expect.objectContaining({ key: "title", locale: "de" }),
    ]);
  });

  it("repairs a translation Shopify holds that the local mirror never saw", async () => {
    // Written in the Shopify admin, by another app or by an importer. The code
    // this path replaces reached it because it removed BLINDLY across every
    // foreign locale; asking only the mirror would trade "deleted" for "left
    // live on the storefront" — on a type with no webhook to catch it later.
    db.contentTranslation.findMany.mockResolvedValue([]);
    shopifyHas = { fr: ["title"] };

    const result = await reconcileAfterPrimarySave(saveParams());
    await awaitDetachedRetranslations();

    expect(result.retranslating).toBe(1);
    expect(shopify.registerCalls).toEqual([
      expect.objectContaining({ key: "title", locale: "fr" }),
    ]);
  });

  it("falls back to the mirror for a locale whose Shopify read failed", async () => {
    // Degrading to the mirror-only reach is acceptable; losing the whole repair
    // over one failed lookup is not. The DETECTION fails here, the primary
    // read-back still works — a GraphQL-level error, which is how a real
    // refusal arrives, and unlike a thrown transport error it is not retried by
    // the gateway, so the test does not pay backoff to prove one branch.
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

    expect(shopify.registerCalls.map((c) => c.key).sort()).toEqual(["body_html", "title"]);
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

  it("never throws — the primary text is already saved", async () => {
    db.contentTranslation.findMany.mockRejectedValueOnce(new Error("connection lost"));
    await expect(reconcileAfterPrimarySave(saveParams())).resolves.toEqual({
      removed: 0,
      retranslating: 0,
    });
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
    const mirror = productImageAltMirror(new Map([[media, "cache-row-7"]]));

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
  });

  it("an image with no cached row is skipped rather than written under a wrong id", async () => {
    const mirror = productImageAltMirror(new Map());
    db.productImageAltTranslation.upsert.mockClear();

    await mirror.write({ resourceId: "gid://shopify/MediaImage/1", resourceType: "MediaImage" }, "fr", "alt", "x", "d");
    expect(db.productImageAltTranslation.upsert).not.toHaveBeenCalled();
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
