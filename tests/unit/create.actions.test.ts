/**
 * PLAN_CONTENT_CREATION §7 (Phase 1) — the createContent handler itself.
 *
 * This file exists because its absence let three bugs ship in a row: the
 * metaobject payload carrying a property GraphQL refuses, the request id being
 * re-minted per click so the dedup never matched, and an echo assertion
 * throwing after the object already existed. Every one of them was invisible
 * to the config-level tests, because every one of them lived in the ORDER of
 * this handler's steps rather than in any single rule.
 *
 * So what is exercised here is the order and the branches:
 *   - which refusal comes out of which situation
 *   - what a retry gets, in each of the states the first attempt can be in
 *   - what happens when Shopify creates the object and a LATER step fails
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { handleCreateContent } from "~/actions/content/create.actions";
import { __resetCreateIdempotency } from "~/utils/create-idempotency.server";

/** Minimal stand-in for the unified handler's context. */
function makeCtx(options: {
  plan?: string;
  productCount?: number;
  graphql?: (query: string, init: { variables: Record<string, unknown> }) => Promise<{ json: () => Promise<unknown> }>;
} = {}) {
  const graphql =
    options.graphql ??
    (async () => ({
      json: async () => ({
        data: {
          productSet: {
            product: { id: "gid://shopify/Product/1", title: "A shirt", handle: "a-shirt", variants: { nodes: [] } },
            userErrors: [],
          },
        },
      }),
    }));

  return {
    admin: { graphql: vi.fn(graphql) },
    session: { shop: "test.myshopify.com" },
    db: {
      product: { count: vi.fn(async () => options.productCount ?? 0) },
      collection: { count: vi.fn(async () => 0) },
      article: { count: vi.fn(async () => 0) },
      page: { count: vi.fn(async () => 0) },
      metaobjectDefinition: { findFirst: vi.fn(async () => null) },
    },
    aiSettings: { subscriptionPlan: options.plan ?? "max" },
  } as never;
}

/** How many times the CREATE mutation itself ran. Counting every graphql call
 *  would also count the follow-up cache sync, which is not what these tests
 *  are about. */
function createCalls(ctx: unknown, marker = "productSet"): number {
  const mock = (ctx as { admin: { graphql: { mock: { calls: unknown[][] } } } }).admin.graphql.mock;
  return mock.calls.filter((c) => typeof c[0] === "string" && (c[0] as string).includes(marker)).length;
}

function form(values: Record<string, string>, extra: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("resource", extra.resource ?? "product");
  for (const [k, v] of Object.entries(extra)) if (k !== "resource") fd.set(k, v);
  for (const [k, v] of Object.entries(values)) fd.set(`value.${k}`, v);
  return fd;
}

async function body(response: unknown): Promise<Record<string, unknown>> {
  // `data()` from react-router wraps the payload; unwrap either shape.
  const r = response as { data?: unknown; json?: () => Promise<unknown> };
  if (r.data !== undefined) return r.data as Record<string, unknown>;
  return (await r.json!()) as Record<string, unknown>;
}

beforeEach(() => {
  __resetCreateIdempotency();
  vi.clearAllMocks();
});

describe("plan gates", () => {
  it("refuses a content type the plan lacks, with THAT reason", async () => {
    const result = await body(await handleCreateContent(makeCtx({ plan: "free" }), form({ title: "A page" }, { resource: "page" })));
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("planContentType");
  });

  it("refuses a reached quantity limit with the OTHER reason", async () => {
    const ctx = makeCtx({ plan: "free", productCount: 100_000 });
    const result = await body(await handleCreateContent(ctx, form({ title: "A shirt" })));
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("planLimit");
  });

  it("never reaches Shopify when a gate refuses", async () => {
    const ctx = makeCtx({ plan: "free" });
    await handleCreateContent(ctx, form({ title: "A page" }, { resource: "page" }));
    expect((ctx as never as { admin: { graphql: ReturnType<typeof vi.fn> } }).admin.graphql).not.toHaveBeenCalled();
  });
});

describe("validation", () => {
  it("rejects an unknown field instead of dropping it", async () => {
    const result = await body(await handleCreateContent(makeCtx(), form({ title: "A shirt", giftCard: "true" })));
    expect(result.errorCode).toBe("validation");
    expect(result.fieldErrors).toContainEqual({ field: "giftCard", code: "unknownField" });
  });

  it("rejects a missing required field", async () => {
    const result = await body(await handleCreateContent(makeCtx(), form({})));
    expect(result.errorCode).toBe("validation");
  });

  it("leaves NO claim behind after a validation failure", async () => {
    // The bug this guards: claiming before validating stranded the corrected
    // retry on "already in progress" forever, because the same request id must
    // be reused for the dedup to work at all.
    const ctx = makeCtx();
    await handleCreateContent(ctx, form({ title: "" }, { requestId: "r1" }));
    const second = await body(await handleCreateContent(ctx, form({ title: "A shirt" }, { requestId: "r1" })));
    expect(second.success).toBe(true);
    expect(second.pending).toBeUndefined();
  });
});

describe("the echo rule", () => {
  it("fails when Shopify returns no id", async () => {
    const ctx = makeCtx({
      graphql: async () => ({ json: async () => ({ data: { productSet: { product: null, userErrors: [{ message: "nope" }] } } }) }),
    });
    const result = await body(await handleCreateContent(ctx, form({ title: "A shirt" })));
    expect(result.success).toBe(false);
  });

  it("does NOT fail on a title Shopify normalised", async () => {
    // The object exists. Throwing here took the "nothing was created" branch,
    // released the claim, and handed the merchant a duplicate on their retry.
    const ctx = makeCtx({
      graphql: async () => ({
        json: async () => ({
          data: {
            productSet: {
              product: { id: "gid://shopify/Product/1", title: "A shirt (truncated)", handle: "a-shirt", variants: { nodes: [] } },
              userErrors: [],
            },
          },
        }),
      }),
    });
    const result = await body(await handleCreateContent(ctx, form({ title: "A shirt" })));
    expect(result.success).toBe(true);
    expect((result.notes as string[]).join(" ")).toContain("A shirt (truncated)");
  });
});

describe("a failure AFTER the object exists", () => {
  it("reports SUCCESS with a note, never a failure", async () => {
    // Reporting failure here is what produces the duplicate: the merchant
    // retries something that already exists, and this app cannot delete the
    // second one for them without them noticing.
    let call = 0;
    const ctx = makeCtx({
      graphql: async () => {
        call += 1;
        if (call === 1) {
          return {
            json: async () => ({
              data: {
                pageCreate: { page: { id: "gid://shopify/Page/1", title: "A page", handle: "a-page" }, userErrors: [] },
              },
            }),
          };
        }
        // The SEO metafield step blows up.
        throw new Error("network");
      },
    });

    const result = await body(
      await handleCreateContent(ctx, form({ title: "A page", seoTitle: "SEO" }, { resource: "page" })),
    );
    expect(result.success).toBe(true);
    expect(result.id).toBe("gid://shopify/Page/1");
    expect((result.notes as string[]).join(" ")).toMatch(/SEO/i);
  });

  it("keeps the claim, so the retry gets the FIRST result", async () => {
    let call = 0;
    const ctx = makeCtx({
      graphql: async () => {
        call += 1;
        if (call === 1) {
          return {
            json: async () => ({
              data: { pageCreate: { page: { id: "gid://shopify/Page/1", title: "A page", handle: "a-page" }, userErrors: [] } },
            }),
          };
        }
        throw new Error("network");
      },
    });

    const first = await body(await handleCreateContent(ctx, form({ title: "A page" }, { resource: "page", requestId: "r9" })));
    const retry = await body(await handleCreateContent(ctx, form({ title: "A page" }, { resource: "page", requestId: "r9" })));
    expect(retry.id).toBe(first.id);
  });
});

describe("idempotency ordering", () => {
  it("returns the first result to a retry, without creating again", async () => {
    const ctx = makeCtx();
    const first = await body(await handleCreateContent(ctx, form({ title: "A shirt" }, { requestId: "r2" })));
    expect(createCalls(ctx)).toBe(1);

    const retry = await body(await handleCreateContent(ctx, form({ title: "A shirt" }, { requestId: "r2" })));
    expect(retry).toEqual(first);
    // The point of the whole mechanism: the SECOND request creates nothing.
    expect(createCalls(ctx)).toBe(1);
  });

  it("answers a retry BEFORE the quantity gate can call it 'limit reached'", async () => {
    // The object the first attempt created is already counted. Gating first
    // would refuse the retry over the very thing it is waiting for.
    const ctx = makeCtx({ plan: "free", productCount: 100_000 });
    // Seed a completed result for this id by letting one through under a
    // generous plan, then re-asking under the exhausted one.
    const generous = makeCtx();
    const first = await body(await handleCreateContent(generous, form({ title: "A shirt" }, { requestId: "r3" })));

    const retry = await body(await handleCreateContent(ctx, form({ title: "A shirt" }, { requestId: "r3" })));
    expect(retry).toEqual(first);
    expect(retry.errorCode).toBeUndefined();
  });

  it("does not dedupe when no request id was sent", async () => {
    // Nothing to compare against. Refusing would break any caller that does
    // not mint an id, which is worse than not deduping.
    const ctx = makeCtx();
    await handleCreateContent(ctx, form({ title: "A shirt" }));
    await handleCreateContent(ctx, form({ title: "A shirt" }));
    expect(createCalls(ctx)).toBe(2);
  });
});

describe("delete-safety of the resource/id pairing", () => {
  it("refuses a resource it cannot create", async () => {
    const result = await body(await handleCreateContent(makeCtx(), form({ title: "x" }, { resource: "policy" })));
    expect(result.success).toBe(false);
  });
});
