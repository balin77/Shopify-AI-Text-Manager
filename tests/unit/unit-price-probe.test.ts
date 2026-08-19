/**
 * The unit-price probe's one rule: a FAILED call is never a NEGATIVE answer.
 *
 * This probe exists to decide whether a Grundpreis feature can be built at
 * all. If a throttled response came back as "not supported", the answer would
 * close a question that is actually open — and the feature would be dropped on
 * the strength of a rate limit. So `missing` (the API answered and the field
 * is not there) and `error` (no answer arrived) are separate states, and the
 * one outcome the probe is really hunting for — accepted, no errors, value not
 * stored — is neither.
 *
 * The route is dev-gated and mutates a live variant, so what is tested here is
 * its verdict logic, driven through the module with a stubbed admin client.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const authenticate = { admin: vi.fn() };
vi.mock("~/shopify.server", () => ({ authenticate }));
vi.mock("../../app/shopify.server", () => ({ authenticate }));

const { action } = await import("~/routes/api.unit-price-probe");

const PRODUCT = "gid://shopify/Product/1";
const VARIANT = "gid://shopify/ProductVariant/9";

/** A request carrying the two GIDs the probe needs. */
function request() {
  const body = new FormData();
  body.set("productGid", PRODUCT);
  body.set("variantGid", VARIANT);
  return new Request("https://x/api/unit-price-probe", { method: "POST", body });
}

/** Answers each GraphQL call in turn. */
function adminWith(answers: unknown[]) {
  const graphql = vi.fn(async () => ({ json: async () => answers.shift() ?? {} }));
  authenticate.admin.mockResolvedValue({ admin: { graphql }, session: { shop: "s" } });
  return graphql;
}

const introspection = (fields: string[]) => ({
  data: {
    variantInput: { inputFields: fields.map((name) => ({ name })) },
    measurementInput: { inputFields: [{ name: "quantityValue" }] },
  },
});

const currentValue = (measurement: unknown) => ({
  data: { productVariant: { id: VARIANT, title: "500 g", unitPriceMeasurement: measurement } },
});

async function run(): Promise<Record<string, { ok: boolean; missing?: boolean; error?: string }>> {
  const response = await action({ request: request(), params: {}, context: {} } as never);
  const body = (response as unknown as { data: { results: Record<string, never> } }).data;
  return body.results;
}

beforeEach(() => {
  vi.stubEnv("APP_ENV", "development");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("the unit-price probe", () => {
  it("refuses to run outside development", async () => {
    // It writes to a live variant. A hidden Settings tab is not a check.
    vi.stubEnv("APP_ENV", "production");
    adminWith([]);

    const response = await action({ request: request(), params: {}, context: {} } as never);
    expect((response as unknown as { init?: { status?: number } }).init?.status).toBe(403);
  });

  it("reports a MISSING input field as a real negative", async () => {
    adminWith([
      introspection(["price", "barcode"]),
      currentValue(null),
      // The write is attempted anyway — the two answers together are the
      // finding — and Shopify rejects it at the schema level.
      { errors: [{ message: 'Field is not defined on ProductVariantsBulkInput: "unitPriceMeasurement"' }] },
    ]);
    const results = await run();

    expect(results.inputShape.missing).toBe(true);
    expect(results.write.missing).toBe(true);
    expect(results.write.error).toBeUndefined();
  });

  it("does NOT report a throttled call as unsupported", async () => {
    // The whole point. One rate limit must not close the question.
    adminWith([
      introspection(["unitPriceMeasurement"]),
      currentValue(null),
      { errors: [{ message: "Throttled" }] },
    ]);
    const results = await run();

    expect(results.write.ok).toBe(false);
    expect(results.write.missing).toBeUndefined();
    expect(results.write.error).toMatch(/throttled/i);
  });

  it("catches ACCEPTED AND IGNORED — the outcome the probe is for", async () => {
    // No errors, a healthy response, and the value simply not stored. Read as
    // success this is exactly the silent no-op that would ship a dead feature.
    adminWith([
      introspection(["unitPriceMeasurement"]),
      currentValue(null),
      {
        data: {
          productVariantsBulkUpdate: {
            productVariants: [{ id: VARIANT, unitPriceMeasurement: null }],
            userErrors: [],
          },
        },
      },
    ]);
    const results = await run();

    expect(results.write.ok).toBe(false);
    expect(results.write.error).toMatch(/came back without the value/i);
  });

  it("confirms a write only when the variant echoes it back", async () => {
    const stored = {
      quantityValue: 500,
      quantityUnit: "GRAMS",
      referenceValue: 1,
      referenceUnit: "KILOGRAMS",
    };
    adminWith([
      introspection(["unitPriceMeasurement"]),
      currentValue(null),
      // write
      { data: { productVariantsBulkUpdate: { productVariants: [{ id: VARIANT, unitPriceMeasurement: stored }], userErrors: [] } } },
      // clear
      { data: { productVariantsBulkUpdate: { productVariants: [{ id: VARIANT, unitPriceMeasurement: null }], userErrors: [] } } },
      // restore (back to nothing, which is what was there)
      { data: { productVariantsBulkUpdate: { productVariants: [{ id: VARIANT, unitPriceMeasurement: null }], userErrors: [] } } },
    ]);
    const results = await run();

    expect(results.write.ok).toBe(true);
    expect(results.clear.ok).toBe(true);
    // …and the variant was put back the way it was found.
    expect(results.restored.ok).toBe(true);
  });
});
