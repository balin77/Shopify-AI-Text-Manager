import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The sweep that stands in for the webhook Shopify does not send.
 *
 * Everything it must NOT do has a failure mode behind it: a sweep that acts
 * without a baseline would delete translations on its first run, one that
 * queries a type the shop never translated would cost every merchant a round
 * trip for nothing, and one without a cap would turn a 500-page overnight
 * import into 500 unattended AI runs at 3am.
 */

const { db } = vi.hoisted(() => ({
  db: {
    contentTranslation: {
      findMany: vi.fn(
        async (
          _args?: unknown,
        ): Promise<Array<{ resourceId: string; key: string; locale: string; digest: string | null }>> =>
          [],
      ),
    },
  },
}));

vi.mock("../../app/db.server", () => ({ db, default: db }));

import { scanTranslationDrift, MAX_DRIFT_HANDOVERS } from "../../app/services/translations/translation-drift-scan.server";
type ReconcileParams = Parameters<
  typeof import("../../app/services/translations/stale-translation-sync.server").reconcileStaleTranslations
>[0];
import { digestBaselineKey } from "../../app/services/translations/stale-translations.shared";

const SHOP = "test.myshopify.com";
const PAGE = "gid://shopify/Page/1";
const OLD = "digest-old";
const NEW = "digest-new";

interface NodeSpec {
  resourceId: string;
  digest: string;
  /** locale → the keys that locale holds a translation for. */
  translated: Record<string, string[]>;
  /** Shopify's own staleness verdict on those rows. Default true. */
  outdated?: boolean;
  /** Keys with no `translatableContent` entry — how a CLEARED field looks. */
  clearedKeys?: string[];
}

/** A gateway answering the sweep with one page of the given nodes per type. */
function fakeGateway(nodesByType: Record<string, NodeSpec[]>) {
  const queries: Array<{ type: string; variables: Record<string, unknown> }> = [];
  const gateway = {
    graphql: async (query: string, opts?: { variables?: Record<string, unknown> }) => {
      const type = /resourceType: (\w+)/.exec(query)?.[1] ?? "";
      queries.push({ type, variables: opts?.variables ?? {} });
      const locales = Object.keys(opts?.variables ?? {})
        .filter((name) => name.startsWith("loc"))
        .sort()
        .map((name) => String((opts?.variables ?? {})[name]));
      const nodes = (nodesByType[type] ?? []).map((spec) => {
        const node: Record<string, unknown> = {
          resourceId: spec.resourceId,
          // A CLEARED field produces NO entry at all — never an empty one.
          translatableContent: [
            { key: "title", value: "About us", digest: spec.digest },
            { key: "body_html", value: "<p>Text</p>", digest: spec.digest },
          ].filter((entry) => !(spec.clearedKeys ?? []).includes(entry.key)),
        };
        locales.forEach((locale, index) => {
          // Shopify answers with a row per translatable KEY and `value: null`
          // where that locale has nothing — the fake mirrors that, or a test
          // would pass on a query that reads untranslated locales as translated.
          node[`l${index}`] = ["title", "body_html"].map((key) => ({
            key,
            value: (spec.translated[locale] ?? []).includes(key) ? `t-${key}` : null,
            outdated: spec.outdated ?? true,
          }));
        });
        return { node };
      });
      return {
        json: async () => ({
          data: {
            translatableResources: {
              edges: nodes,
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      } as unknown as Response;
    },
  };
  return { gateway: gateway as never, queries };
}

/** Mirror rows: every (locale, key) written against `digest`. */
function baselineRows(resourceId: string, locale: string, keys: string[], digest: string | null) {
  return keys.map((key) => ({ resourceId, key, locale, digest }));
}

beforeEach(() => {
  db.contentTranslation.findMany.mockReset();
  db.contentTranslation.findMany.mockResolvedValue([]);
});

describe("scanTranslationDrift", () => {
  it("does nothing at all on a single-language shop", async () => {
    const { gateway, queries } = fakeGateway({});
    const reconcile = vi.fn(async () => ({ removed: 0, retranslating: 0 }));

    const result = await scanTranslationDrift({ gateway, shop: SHOP, foreignLocales: [], reconcile });

    expect(result).toEqual({ changed: 0, handed: 0, failedTypes: [], truncatedTypes: [] });
    expect(queries).toEqual([]);
    expect(db.contentTranslation.findMany).not.toHaveBeenCalled();
  });

  it("asks Shopify NOTHING for a type the shop never translated", async () => {
    // The baseline query answers empty, so there is no resource whose staleness
    // could be established — paying a round trip to learn that is the cost this
    // short-circuit exists to avoid.
    const { gateway, queries } = fakeGateway({ PAGE: [{ resourceId: PAGE, digest: NEW, translated: {} }] });
    const reconcile = vi.fn(async () => ({ removed: 0, retranslating: 0 }));

    await scanTranslationDrift({ gateway, shop: SHOP, foreignLocales: ["de"], reconcile });

    expect(queries).toEqual([]);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("reconciles a resource whose digest MOVED, with the mirror's own baseline", async () => {
    db.contentTranslation.findMany.mockImplementation(async (args: any) =>
      args?.where?.resourceType === "Page"
        ? baselineRows(PAGE, "de", ["title", "body_html"], OLD)
        : [],
    );
    const { gateway } = fakeGateway({
      PAGE: [{ resourceId: PAGE, digest: NEW, translated: { de: ["title", "body_html"] } }],
    });
    const reconcile = vi.fn(async (_params: ReconcileParams) => ({ removed: 0, retranslating: 2 }));

    const result = await scanTranslationDrift({
      gateway,
      shop: SHOP,
      foreignLocales: ["de"],
      reconcile,
    });

    expect(result.changed).toBe(1);
    expect(result.handed).toBe(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    const params = reconcile.mock.calls[0][0] as unknown as Record<string, any>;
    expect(params).toMatchObject({ shop: SHOP, resourceId: PAGE, resourceType: "Page", contentKind: "page" });
    expect(params.primaryContent.title).toEqual({ value: "About us", digest: NEW });
    expect(params.previousDigests[digestBaselineKey("de", "title")]).toBe(OLD);
    // Global layer only — the market overrides are the purge's business, never
    // a reason to start a reconciliation.
    expect(params.translations.every((row: any) => row.marketId === "")).toBe(true);
  });

  it("leaves a resource alone when its digest still matches", async () => {
    db.contentTranslation.findMany.mockImplementation(async (args: any) =>
      args?.where?.resourceType === "Page" ? baselineRows(PAGE, "de", ["title"], NEW) : [],
    );
    const { gateway } = fakeGateway({
      PAGE: [{ resourceId: PAGE, digest: NEW, translated: { de: ["title"] } }],
    });
    const reconcile = vi.fn(async () => ({ removed: 0, retranslating: 0 }));

    const result = await scanTranslationDrift({ gateway, shop: SHOP, foreignLocales: ["de"], reconcile });

    expect(result.changed).toBe(0);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("treats a MISSING previous digest as no evidence — a first sweep is harmless", async () => {
    // A row this app wrote before it mirrored digests, or one imported by a
    // sync that had none. Acting on it would delete a translation on the
    // strength of "we do not know what it was written against".
    db.contentTranslation.findMany.mockImplementation(async (args: any) =>
      args?.where?.resourceType === "Page" ? baselineRows(PAGE, "de", ["title"], null) : [],
    );
    const { gateway } = fakeGateway({
      PAGE: [{ resourceId: PAGE, digest: NEW, translated: { de: ["title"] } }],
    });
    const reconcile = vi.fn(async () => ({ removed: 0, retranslating: 0 }));

    await scanTranslationDrift({ gateway, shop: SHOP, foreignLocales: ["de"], reconcile });

    expect(reconcile).not.toHaveBeenCalled();
  });

  it("ignores a locale that holds no translation, however its digest looks", async () => {
    // The baseline is for the SWEPT locale, so the digest half of the gate
    // passes: only the `value: null` filter can keep this out. With the
    // baseline written for another locale the test would pass with that filter
    // deleted, which is what it looked like at first.
    db.contentTranslation.findMany.mockImplementation(async (args: any) =>
      args?.where?.resourceType === "Page" ? baselineRows(PAGE, "fr", ["title"], OLD) : [],
    );
    const { gateway } = fakeGateway({
      PAGE: [{ resourceId: PAGE, digest: NEW, translated: { fr: [] } }],
    });
    const reconcile = vi.fn(async () => ({ removed: 0, retranslating: 0 }));

    await scanTranslationDrift({ gateway, shop: SHOP, foreignLocales: ["fr"], reconcile });

    expect(reconcile).not.toHaveBeenCalled();
  });

  it("does NOT hand over a resource Shopify reports as already re-translated", async () => {
    // The digest moved, but `outdated: false` says somebody translated it
    // against the NEW source — an admin edit followed by an admin translation,
    // which is the population this sweep watches. The real gate refuses it, so
    // handing it over repairs nothing, advances no baseline, and hands the same
    // resource over again on every sweep until it starves everything behind it.
    db.contentTranslation.findMany.mockImplementation(async (args: any) =>
      args?.where?.resourceType === "Page" ? baselineRows(PAGE, "de", ["title"], OLD) : [],
    );
    const { gateway } = fakeGateway({
      PAGE: [{ resourceId: PAGE, digest: NEW, translated: { de: ["title"] }, outdated: false }],
    });
    const reconcile = vi.fn(async () => ({ removed: 0, retranslating: 0 }));

    const result = await scanTranslationDrift({ gateway, shop: SHOP, foreignLocales: ["de"], reconcile });

    expect(result.changed).toBe(0);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("DOES hand over a resource whose primary value was cleared", async () => {
    // A cleared field has no `translatableContent` entry at all, so no current
    // digest — the half of the gate an earlier pre-check made unreachable by
    // demanding one.
    db.contentTranslation.findMany.mockImplementation(async (args: any) =>
      args?.where?.resourceType === "Page" ? baselineRows(PAGE, "de", ["title"], OLD) : [],
    );
    const { gateway } = fakeGateway({
      PAGE: [
        { resourceId: PAGE, digest: NEW, translated: { de: ["title"] }, outdated: false, clearedKeys: ["title"] },
      ],
    });
    const reconcile = vi.fn(async () => ({ removed: 1, retranslating: 0 }));

    const result = await scanTranslationDrift({ gateway, shop: SHOP, foreignLocales: ["de"], reconcile });

    expect(result.changed).toBe(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("stops at the PER-TYPE budget, so one type cannot starve the others", async () => {
    const ids = Array.from({ length: MAX_DRIFT_HANDOVERS + 5 }, (_, i) => `gid://shopify/Page/${i}`);
    db.contentTranslation.findMany.mockImplementation(async (args: any) =>
      args?.where?.resourceType === "Page"
        ? ids.flatMap((id) => baselineRows(id, "de", ["title"], OLD))
        : [],
    );
    const { gateway } = fakeGateway({
      PAGE: ids.map((id) => ({ resourceId: id, digest: NEW, translated: { de: ["title"] } })),
    });
    const reconcile = vi.fn(async () => ({ removed: 0, retranslating: 1 }));

    const result = await scanTranslationDrift({ gateway, shop: SHOP, foreignLocales: ["de"], reconcile });

    // A quarter of the budget, because there are four scanned types and each
    // gets its own share — with one shared pool these pages would take every
    // slot and the shop's articles, blogs and policies would never be swept.
    const perType = Math.ceil(MAX_DRIFT_HANDOVERS / 4);
    expect(result.handed).toBe(perType);
    expect(reconcile).toHaveBeenCalledTimes(perType);
  });

  it("reports a failed type instead of counting it as 'nothing changed'", async () => {
    db.contentTranslation.findMany.mockImplementation(async (args: any) =>
      args?.where?.resourceType === "Page" ? baselineRows(PAGE, "de", ["title"], OLD) : [],
    );
    const gateway = {
      graphql: async () => ({
        json: async () => ({ data: null, errors: [{ message: "Throttled" }] }),
      }),
    } as never;
    const reconcile = vi.fn(async () => ({ removed: 0, retranslating: 0 }));

    const result = await scanTranslationDrift({ gateway, shop: SHOP, foreignLocales: ["de"], reconcile });

    expect(result.failedTypes).toEqual(["PAGE"]);
    expect(result.changed).toBe(0);
    expect(reconcile).not.toHaveBeenCalled();
  });
});
