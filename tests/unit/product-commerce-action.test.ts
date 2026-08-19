/**
 * The commerce route's ACTION, which is directly POST-reachable.
 *
 * Everything the panel sends can also be sent by hand, so the rules that keep
 * one variant's write off another variant's row — and a half-described
 * measurement out of Shopify — live in the route, not only in the client that
 * usually calls it. This file drives that action with a stubbed admin and db.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const authenticate = { admin: vi.fn() };
vi.mock("~/shopify.server", () => ({ authenticate }));
vi.mock("../../app/shopify.server", () => ({ authenticate }));

const aISettings = { findUnique: vi.fn() };
const productVariant = { updateMany: vi.fn(async () => ({ count: 1 })) };
vi.mock("~/db.server", () => ({ db: { aISettings, productVariant } }));
vi.mock("../../app/db.server", () => ({ db: { aISettings, productVariant } }));

const { action } = await import("~/routes/api.product-commerce");

const PRODUCT = "gid://shopify/Product/1";
const VARIANT = "gid://shopify/ProductVariant/9";

/** The variant echo a healthy `productVariantsBulkUpdate` returns. */
const echo = (fields: Record<string, unknown> = {}) => ({
  data: {
    productVariantsBulkUpdate: {
      productVariants: [{ id: VARIANT, price: null, compareAtPrice: null, ...fields }],
      userErrors: [],
    },
  },
});

/**
 * The action's own view of a request: whatever it does with `formData()`.
 *
 * Handed over directly rather than encoded into a `Request` and parsed back,
 * because THIS test environment's multipart round trip drops fields whose
 * value is the empty string — and an empty string is exactly what "clear the
 * Grundpreis" is made of. Plain Node preserves them, as does every browser
 * (the barcode-clear path has shipped on the same mechanism), so encoding here
 * would test the polyfill rather than the route.
 */
function post(fields: Record<string, string>) {
  const body = new FormData();
  body.set("intent", "price");
  body.set("productId", PRODUCT);
  body.set("variantId", "9");
  body.set("variantGid", VARIANT);
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return { method: "POST", formData: async () => body } as unknown as Request;
}

async function run(fields: Record<string, string>, answer: unknown = echo()) {
  const graphql = vi.fn(
    async (_query: string, _options?: { variables?: Record<string, never> }) => ({
      json: async () => answer,
    }),
  );
  authenticate.admin.mockResolvedValue({ admin: { graphql }, session: { shop: "s" } });
  const response = await action({ request: post(fields), params: {}, context: {} } as never);
  const envelope = response as unknown as { data: Record<string, unknown>; init?: { status?: number } };
  return { status: envelope.init?.status ?? 200, body: envelope.data, graphql };
}

beforeEach(() => {
  aISettings.findUnique.mockResolvedValue({ subscriptionPlan: "pro" });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("the commerce action's unit-price rules", () => {
  it("refuses a PARTIAL quartet rather than half-applying it", () => {
    // The four fields are ONE value on Shopify's side. Three of them describe
    // a measurement nobody typed, and without this the odd ones out would be
    // silently ignored — the request would answer success while doing nothing.
    return run({ unitQuantityValue: "500", unitQuantityUnit: "G" }).then(({ status, body, graphql }) => {
      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(graphql).not.toHaveBeenCalled();
    });
  });

  it("accepts all four EMPTY, because that is how a Grundpreis is removed", async () => {
    // `formData.has` is the presence test, not truthiness: an empty string is
    // present, and reading it as absent would make the measurement unclearable
    // from outside the panel.
    const { status, graphql } = await run(
      {
        unitQuantityValue: "",
        unitQuantityUnit: "",
        unitReferenceValue: "",
        unitReferenceUnit: "",
      },
      echo({ unitPriceMeasurement: { quantityValue: 0, quantityUnit: null, referenceValue: 0, referenceUnit: null } }),
    );

    expect(status).toBe(200);
    const variants = graphql.mock.calls[0][1]?.variables?.variants as
      | Array<Record<string, unknown>>
      | undefined;
    const sent = variants![0];
    // The empty STATE, never null — null is measured to be accepted and ignored.
    expect(sent.unitPriceMeasurement).toEqual({
      quantityValue: 0, quantityUnit: null, referenceValue: 0, referenceUnit: null,
    });
  });

  it("drops an unrecognised display switch instead of reading it as OFF", async () => {
    const { body, graphql } = await run({ showUnitPrice: "vielleicht" });

    expect(body.warnings).toContain("priceInvalid");
    // Nothing was sent for it: coercing would turn a typo into "hide it".
    expect(graphql).not.toHaveBeenCalled();
  });

  it("refuses a variantGid that does not match the variantId", async () => {
    // Directly POST-reachable: a mismatched pair would write one variant's
    // price onto another's cached row.
    const body = new FormData();
    body.set("intent", "price");
    body.set("productId", PRODUCT);
    body.set("variantId", "9");
    body.set("variantGid", "gid://shopify/ProductVariant/10");
    body.set("unitQuantityValue", "500");
    const request = { method: "POST", formData: async () => body } as unknown as Request;
    authenticate.admin.mockResolvedValue({ admin: { graphql: vi.fn() }, session: { shop: "s" } });

    const response = await action({ request, params: {}, context: {} } as never);
    expect((response as unknown as { init?: { status?: number } }).init?.status).toBe(400);
  });

  it("is plan-gated in the ROUTE, not only in the panel", async () => {
    aISettings.findUnique.mockResolvedValue({ subscriptionPlan: "free" });
    const { status } = await run({
      unitQuantityValue: "500",
      unitQuantityUnit: "G",
      unitReferenceValue: "1",
      unitReferenceUnit: "KG",
    });
    expect(status).toBe(403);
  });
});
