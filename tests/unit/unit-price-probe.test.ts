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
 * The live run turned that outcome up where nobody expected it: not on the
 * write, which works, but on the CLEAR. `unitPriceMeasurement: null` is
 * accepted, reports no errors, and leaves the measurement on the variant. That
 * is why the clear step is a ladder and why the probe now has to be able to
 * admit it could not put a real variant back.
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

/** What Shopify answers for a variant with no Grundpreis: a ZEROED struct, not
 *  `null`. Measured on a live shop, and the reason emptiness has its own
 *  predicate in the route. */
const EMPTY = {
  measuredType: null,
  quantityValue: 0,
  quantityUnit: null,
  referenceValue: 0,
  referenceUnit: null,
};

const PROBE_VALUE = {
  measuredType: "WEIGHT",
  quantityValue: 500,
  quantityUnit: "G",
  referenceValue: 1,
  referenceUnit: "KG",
};

type Strategy = "null" | "showUnitPrice" | "both" | "spelled-out" | "empty-object";

interface FakeShop {
  /** What the variant holds; the zeroed struct means "nothing". */
  measurement: Record<string, unknown>;
  showUnitPrice: boolean;
  /** Which of the three clear inputs actually empties the measurement. */
  clearedBy: Strategy[];
  /** `false` models an API version where the field cannot be selected. */
  readsShowUnitPrice: boolean;
  /** The switch is accepted and never moves. */
  stuckSwitch: boolean;
  /** The switch turns on and refuses to turn back off. */
  oneWaySwitch: boolean;
  inputFields: string[];
  /** Replaces the next mutation response wholesale. */
  mutationAnswers: unknown[];
}

/** A Shopify that answers by QUERY, not by call order — the probe's call
 *  sequence is exactly what these tests exercise, so an order-keyed mock would
 *  have to be rewritten by every change it is supposed to catch. */
function fakeShop(overrides: Partial<FakeShop> = {}) {
  const shop: FakeShop = {
    measurement: { ...EMPTY },
    showUnitPrice: true,
    clearedBy: [],
    readsShowUnitPrice: true,
    inputFields: ["price", "unitPriceMeasurement", "showUnitPrice"],
    stuckSwitch: false,
    oneWaySwitch: false,
    mutationAnswers: [],
    ...overrides,
  };

  const graphql = vi.fn(
    async (query: string, options?: { variables?: Record<string, unknown> }) => {
      const answer = (value: unknown) => ({ json: async () => value });

      if (query.includes("ProductVariantsBulkInput\")")) {
        return answer({
          data: {
            variantInput: { inputFields: shop.inputFields.map((name) => ({ name })) },
            measurementInput: { inputFields: [{ name: "quantityValue" }] },
          },
        });
      }
      if (query.includes("__type(name: \"ProductVariant\")")) {
        return answer({
          data: {
            variantType: {
              fields: shop.readsShowUnitPrice
                ? [{ name: "id" }, { name: "showUnitPrice" }]
                : [{ name: "id" }],
            },
          },
        });
      }
      if (query.includes("unitPriceCurrent")) {
        return answer({
          data: {
            productVariant: {
              id: VARIANT,
              title: "Candy",
              unitPriceMeasurement: shop.measurement,
              ...(shop.readsShowUnitPrice ? { showUnitPrice: shop.showUnitPrice } : {}),
            },
          },
        });
      }

      // A mutation.
      if (shop.mutationAnswers.length) return answer(shop.mutationAnswers.shift());

      const input = (options?.variables?.variants as Array<Record<string, unknown>>)[0];
      const setsShow = "showUnitPrice" in input;
      const measurement = input.unitPriceMeasurement as Record<string, unknown> | null | undefined;
      const setsMeasurement = "unitPriceMeasurement" in input;
      const emptyShaped =
        !!measurement && (Object.keys(measurement).length === 0 || measurement.quantityUnit == null);
      const strategy: Strategy | null = !setsMeasurement
        ? setsShow
          ? "showUnitPrice"
          : null
        : measurement === null
          ? setsShow
            ? "both"
            : "null"
          : emptyShaped
            ? Object.keys(measurement).length === 0
              ? "empty-object"
              : "spelled-out"
            : null;

      if (setsMeasurement && measurement && !emptyShaped) {
        shop.measurement = { measuredType: "WEIGHT", ...measurement };
      } else if (strategy && shop.clearedBy.includes(strategy)) {
        shop.measurement = { ...EMPTY };
      }
      if (setsShow && !shop.stuckSwitch) {
        const wanted = input.showUnitPrice as boolean;
        if (!(shop.oneWaySwitch && shop.showUnitPrice && !wanted)) shop.showUnitPrice = wanted;
      }

      return answer({
        data: {
          productVariantsBulkUpdate: {
            productVariants: [
              {
                id: VARIANT,
                unitPriceMeasurement: shop.measurement,
                ...(shop.readsShowUnitPrice ? { showUnitPrice: shop.showUnitPrice } : {}),
              },
            ],
            userErrors: [],
          },
        },
      });
    },
  );

  authenticate.admin.mockResolvedValue({ admin: { graphql }, session: { shop: "s" } });
  return { shop, graphql };
}

type Results = Record<
  string,
  { ok: boolean; missing?: boolean; error?: string; detail?: Record<string, unknown> }
>;

async function run(mode: "probe" | "clear" = "probe"): Promise<Results> {
  const body = new FormData();
  body.set("productGid", PRODUCT);
  body.set("variantGid", VARIANT);
  body.set("mode", mode);
  const request = new Request("https://x/api/unit-price-probe", { method: "POST", body });
  const response = await action({ request, params: {}, context: {} } as never);
  return (response as unknown as { data: { results: Results } }).data.results;
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
    fakeShop();

    const body = new FormData();
    body.set("productGid", PRODUCT);
    body.set("variantGid", VARIANT);
    const request = new Request("https://x/api/unit-price-probe", { method: "POST", body });
    const response = await action({ request, params: {}, context: {} } as never);
    expect((response as unknown as { init?: { status?: number } }).init?.status).toBe(403);
  });

  it("reports a MISSING input field as a real negative", async () => {
    fakeShop({
      inputFields: ["price", "barcode"],
      // The write is attempted anyway — the two answers together are the
      // finding — and Shopify rejects it at the schema level.
      mutationAnswers: [
        {
          errors: [
            { message: 'Field is not defined on ProductVariantsBulkInput: "unitPriceMeasurement"' },
          ],
        },
      ],
    });
    const results = await run();

    expect(results.inputShape.missing).toBe(true);
    expect(results.write.missing).toBe(true);
    expect(results.write.error).toBeUndefined();
  });

  it("does NOT report a throttled call as unsupported", async () => {
    // The whole point. One rate limit must not close the question.
    fakeShop({ mutationAnswers: [{ errors: [{ message: "Throttled" }] }] });
    const results = await run();

    expect(results.write.ok).toBe(false);
    expect(results.write.missing).toBeUndefined();
    expect(results.write.error).toMatch(/throttled/i);
  });

  it("catches ACCEPTED AND IGNORED — the outcome the probe is for", async () => {
    // No errors, a healthy response, and the value simply not stored. Read as
    // success this is exactly the silent no-op that would ship a dead feature.
    fakeShop({
      mutationAnswers: [
        {
          data: {
            productVariantsBulkUpdate: {
              productVariants: [{ id: VARIANT, unitPriceMeasurement: EMPTY }],
              userErrors: [],
            },
          },
        },
      ],
    });
    const results = await run();

    expect(results.write.ok).toBe(false);
    expect(results.write.error).toMatch(/came back without the value/i);
  });

  it("does not read a rejected VALUE as a missing FIELD", async () => {
    // The live refusal named `unitPriceMeasurement` while proving it exists:
    // "invalid value for 0.unitPriceMeasurement.quantityUnit (Expected …)".
    // Matching on the field name alone reports the field as unsupported and
    // closes the question with the answer inverted.
    fakeShop({
      mutationAnswers: [
        {
          errors: [
            {
              message:
                'Variable $variants of type [ProductVariantsBulkInput!]! was provided invalid value for 0.unitPriceMeasurement.quantityUnit (Expected "GRAMS" to be one of: ML, CL, L, G, KG)',
            },
          ],
        },
      ],
    });
    const results = await run();

    expect(results.write.missing).toBeUndefined();
    expect(results.write.ok).toBe(false);
    expect(results.write.error).toMatch(/invalid value/i);
  });

  it("sends the unit CODES, not the WeightUnit spelling", async () => {
    // The first live run cost a whole round trip to this: every other weight
    // field in this app takes GRAMS/KILOGRAMS, and this one does not — the
    // schema names G/KG.
    const { graphql } = fakeShop({ clearedBy: ["null"] });
    await run();

    const write = graphql.mock.calls.find((call) =>
      call[0].includes("productVariantsBulkUpdate"),
    );
    const variants = write?.[1]?.variables?.variants as Array<{ unitPriceMeasurement: unknown }>;
    expect(variants[0].unitPriceMeasurement).toEqual({
      quantityValue: 500,
      quantityUnit: "G",
      referenceValue: 1,
      referenceUnit: "KG",
    });
  });

  it("confirms a write, a clear and the restore when the shop honours them", async () => {
    const { shop } = fakeShop({ clearedBy: ["null"] });
    const results = await run();

    expect(results.write.ok).toBe(true);
    expect(results.clear.ok).toBe(true);
    // …and the variant was put back the way it was found: empty.
    expect(results.restored.ok).toBe(true);
    expect(shop.measurement.quantityUnit).toBeNull();
  });

  it("counts the ZEROED struct as cleared, not as a failed clear", async () => {
    // Shopify never answers `null` for this object. A `=== null` emptiness
    // test would call every successful clear a failure and send the probe
    // hunting for a strategy that already worked.
    fakeShop({ clearedBy: ["null"] });
    const results = await run();

    expect(results.clear.ok).toBe(true);
    expect(results.clear.detail?.worked).toBe("unitPriceMeasurement: null");
  });

  it("walks on to the next strategy when null is accepted and ignored", async () => {
    // The MEASURED behaviour: the mutation reports no errors and the
    // measurement stays. Stopping at the first strategy would have reported
    // "cannot be removed" while an untried input still could.
    fakeShop({ clearedBy: ["both"] });
    const results = await run();

    expect(results.clear.ok).toBe(true);
    expect(results.clear.detail?.worked).toBe("both at once");
    // Stopped at the one that worked; the two empty-shaped rungs below it were
    // never needed.
    expect(results.clear.detail?.attempts).toHaveLength(3);
  });

  it("reports hiding SEPARATELY from removing", async () => {
    // A measurement that cannot be removed but can be switched off is still a
    // shippable feature — with a different off-switch. Folding the two into
    // one verdict would either overstate what the API does or throw away a
    // usable answer.
    fakeShop({ clearedBy: [], showUnitPrice: true });
    const results = await run();

    expect(results.clear.ok).toBe(false);
    expect(results.clear.missing).toBe(true);
    expect(results.hide.ok).toBe(true);
  });

  it("measures the switch by MOVING it, and puts it back", async () => {
    // The first live run reported "hide: yes" off a variant whose
    // `showUnitPrice` was false before anything was written — the untouched
    // state read as an effect of our own call. A value that does not change
    // measures nothing, so the switch is flipped away from where it was.
    const { shop, graphql } = fakeShop({ clearedBy: ["null"], showUnitPrice: false });
    const results = await run();

    expect(results.hide.ok).toBe(true);
    const sent = graphql.mock.calls
      .map((call) => (call[1]?.variables?.variants as Array<Record<string, unknown>>)?.[0])
      .filter((input) => input && "showUnitPrice" in input)
      .map((input) => input.showUnitPrice);
    // Away from false, then back to it. (The restore at the end sets it once
    // more, belt and braces, in case a clear strategy moved it.)
    expect(sent.slice(0, 2)).toEqual([true, false]);
    expect(shop.showUnitPrice).toBe(false);
  });

  it("calls a switch that will not move a real negative", async () => {
    const { graphql } = fakeShop({ clearedBy: ["null"], showUnitPrice: false, stuckSwitch: true });
    const results = await run();

    expect(results.hide.ok).toBe(false);
    expect(results.hide.missing).toBe(true);
    expect(graphql).toHaveBeenCalled();
  });

  it("says so loudly when the switch turns ON and will not turn back", async () => {
    // Worse than a switch that does nothing: the storefront is left showing
    // something the probe turned on.
    fakeShop({ clearedBy: ["null"], showUnitPrice: false, oneWaySwitch: true });
    const results = await run();

    expect(results.hide.ok).toBe(false);
    expect(results.hide.missing).toBeUndefined();
    expect(results.hide.error).toMatch(/would not go back/i);
  });

  it("does not report a removal on a variant that was already empty", async () => {
    // Pressing "remove" twice, or after a cleanup in the admin. The ladder
    // would echo an empty measurement back from the FIRST input and credit
    // that one — which is how a run reported `null` as working right after
    // another run had proved it does not.
    const { graphql } = fakeShop({ clearedBy: [] });
    const results = await run("clear");

    expect(results.clear.ok).toBe(false);
    expect(results.clear.error).toMatch(/nothing to remove/i);
    // …and it wrote nothing at all.
    const mutated = graphql.mock.calls.some((call) =>
      call[0].includes("productVariantsBulkUpdate"),
    );
    expect(mutated).toBe(false);
  });

  it("tries the empty-shaped inputs once null has been refused", async () => {
    // A variant with no Grundpreis reads back as a zeroed struct, so writing
    // that shape is a different request from writing `null` — and `null` is
    // measured not to work.
    fakeShop({ clearedBy: ["spelled-out"] });
    const results = await run();

    expect(results.clear.ok).toBe(true);
    expect(results.clear.detail?.worked).toBe("the empty measurement, spelled out");
  });

  it("admits it left the measurement behind when nothing could remove it", async () => {
    // The honest outcome, and the one the first live run produced. Reporting
    // "restored" here would tell the merchant their storefront is untouched
    // while it is showing a Grundpreis the probe wrote.
    const { shop } = fakeShop({ clearedBy: [] });
    const results = await run();

    expect(results.restored.ok).toBe(false);
    expect(results.restored.error).toMatch(/still carries/i);
    expect(shop.measurement.quantityUnit).toBe("G");
  });

  it("puts back a measurement the variant already had", async () => {
    const { shop } = fakeShop({ measurement: { ...PROBE_VALUE, quantityValue: 250 } });
    const results = await run();

    expect(results.restored.ok).toBe(true);
    expect(shop.measurement.quantityValue).toBe(250);
  });

  it("clear mode runs the ladder and writes nothing of its own", async () => {
    // Re-running the whole probe is NOT the cleanup: it would read the
    // leftover as the state to restore and put it back at the end.
    const { shop, graphql } = fakeShop({ measurement: { ...PROBE_VALUE }, clearedBy: ["null"] });
    const results = await run("clear");

    expect(results.write).toBeUndefined();
    expect(results.inputShape).toBeUndefined();
    expect(results.clear.ok).toBe(true);
    expect(shop.measurement.quantityUnit).toBeNull();
    const wrote500 = graphql.mock.calls.some((call) =>
      JSON.stringify(call[1] ?? {}).includes('"quantityValue":500'),
    );
    expect(wrote500).toBe(false);
  });

  it("does not select showUnitPrice where the schema does not have it", async () => {
    // One unknown field fails the whole document, and the read is where the
    // restore value comes from — so the extra is asked for only once
    // introspection says it is there.
    const { graphql } = fakeShop({ readsShowUnitPrice: false, clearedBy: ["null"] });
    const results = await run();

    const asked = graphql.mock.calls.some(
      (call) => call[0].includes("unitPriceCurrent") && call[0].includes("showUnitPrice"),
    );
    expect(asked).toBe(false);
    expect(results.hide.ok).toBe(false);
    expect(results.hide.missing).toBeUndefined();
    expect(results.hide.error).toMatch(/not readable/i);
  });
});
