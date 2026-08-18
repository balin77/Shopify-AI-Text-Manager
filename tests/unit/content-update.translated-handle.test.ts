/**
 * §Phase 3.3, foreign half — the SINGLE editor's translated-handle redirect.
 *
 * This file exists because the first cut of that feature shipped dead: the
 * capture sat in a closure that ran AFTER the save, so it read the row the save
 * had just written and every rename came out as "unchanged". Nothing failed,
 * nothing logged, and the merchant's foreign URL kept 404ing.
 *
 * So both tests here are about ORDER and about trusting the stored value rather
 * than the submitted one — the two things no amount of decision-level testing
 * could have caught.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleUpdateContent } from "~/actions/content/content-update.action";
import { COLLECTIONS_CONFIG } from "~/config/content-fields.config";

const SHOP = "test-shop.myshopify.com";
const ITEM = "gid://shopify/Collection/1";

/** The redirect mutations the run issued. */
let created: Array<Record<string, unknown>>;

function admin() {
  return {
    graphql: async (query: string, opts?: { variables?: Record<string, unknown> }) => {
      if (query.includes("urlRedirectCreate")) {
        created.push((opts?.variables?.urlRedirect as Record<string, unknown>) ?? {});
        return {
          json: async () => ({
            data: { urlRedirectCreate: { urlRedirect: { id: "gid://shopify/UrlRedirect/1" }, userErrors: [] } },
          }),
        };
      }
      if (query.includes("urlRedirects")) {
        return {
          json: async () => ({ data: { urlRedirects: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } } }),
        };
      }
      throw new Error(`Unexpected query: ${query.slice(0, 60)}`);
    },
  };
}

/**
 * A db whose handle translation for `fr` is mutable, so the save stub can move
 * it the way the real write path does.
 */
function db(state: { frHandle: string | null }) {
  const rows = () =>
    state.frHandle === null ? [] : [{ locale: "fr", value: state.frHandle }];
  return {
    contentTranslation: {
      findMany: vi.fn(async () => rows()),
      findFirst: vi.fn(async (args: { where: { locale?: string } }) =>
        args.where.locale === "fr" && state.frHandle !== null ? { value: state.frHandle } : null,
      ),
    },
    collection: {
      // Two different questions on one model: the resource's own handle, and
      // whether ANOTHER collection already answers the old one.
      findFirst: vi.fn(async (args: { where: Record<string, unknown> }) =>
        args.where.id && typeof args.where.id === "object" ? null : { handle: "kumikobox" },
      ),
    },
  };
}

function formData(handle: string) {
  const fd = new FormData();
  fd.set("locale", "fr");
  fd.set("primaryLocale", "de");
  fd.set("handle", handle);
  return fd;
}

/** Only the fields this handler's foreign path touches — the rest of
 *  ContentActionHandlerContext belongs to the AI actions. */
function ctxFor(database: ReturnType<typeof db>, updateContent: () => Promise<unknown>) {
  return {
    admin: admin() as never,
    session: { shop: SHOP } as never,
    contentConfig: COLLECTIONS_CONFIG as never,
    db: database as never,
    aiSettings: { seoAutoHandleRedirect: true } as never,
    itemId: ITEM,
    shopifyContentService: { updateContent } as never,
  } as unknown as Parameters<typeof handleUpdateContent>[0];
}

beforeEach(() => {
  created = [];
});

describe("handleUpdateContent — redirect on a translated handle", () => {
  it("reads the OLD handle before the save, not after it", async () => {
    // The save moves the row, exactly as the real write path does. A capture
    // placed after it would see "boite-neuve" on both sides and decide
    // "unchanged" — the bug this file exists for.
    const state = { frHandle: "boite-ancienne" };
    const database = db(state);
    const ctx = ctxFor(database, async () => {
      state.frHandle = "boite-neuve";
      return { success: true };
    });

    await handleUpdateContent(ctx, formData("boite-neuve"));

    expect(created).toEqual([
      { path: "/collections/boite-ancienne", target: "/collections/boite-neuve" },
    ]);
  });

  it("creates nothing when the write path SKIPPED the handle", async () => {
    // A translated handle identical to the primary one is silently skipped by
    // the write path — no Shopify write, no DB write, no error. Trusting the
    // submitted value would build a redirect off an edit that never happened,
    // and put it on the locale's own live URL.
    const state = { frHandle: "boite-ancienne" };
    const database = db(state);
    const ctx = ctxFor(database, async () => ({ success: true }));

    await handleUpdateContent(ctx, formData("kumikobox"));

    expect(created).toEqual([]);
  });

  it("creates nothing when the locale had no translated handle", async () => {
    const state = { frHandle: null as string | null };
    const database = db(state);
    const ctx = ctxFor(database, async () => {
      state.frHandle = "boite-neuve";
      return { success: true };
    });

    await handleUpdateContent(ctx, formData("boite-neuve"));

    expect(created).toEqual([]);
    // Not even the snapshot read: the capture bails on the first query.
    expect(database.collection.findFirst).not.toHaveBeenCalled();
  });
});
