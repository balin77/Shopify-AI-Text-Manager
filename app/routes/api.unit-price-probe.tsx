/**
 * Unit-price probe — is the *Grundpreis* writable through the Admin API?
 *
 * ── What is being measured, and why it needs a live shop ────────────────────
 * The "Stückpreis" box on Shopify's own variant page declares a pack's total
 * quantity (500 g) and a reference unit (1 kg), and the storefront then prints
 * "CHF 22.90 · CHF 45.80 / kg" beside the price. It is a legal display rule —
 * the Preisangabenverordnung in Germany, the Preisbekanntgabeverordnung in
 * Switzerland, directive 98/6/EC behind both — and it matters for anything
 * sold by weight or volume.
 *
 * `ProductVariant.unitPriceMeasurement` is READABLE; whether it can be WRITTEN
 * is the open question, and the docs do not settle it. This app has been bitten
 * by exactly that gap before: a field taken from documentation and shipped as
 * a feature, where the write turned out to do nothing and reported success.
 * So it is measured before anything is built on it.
 *
 * ── Three questions, answered separately ────────────────────────────────────
 *   1. INPUT SHAPE — does `ProductVariantsBulkInput` carry a unit-price field
 *      at all, and what is it called? Asked by INTROSPECTION, not by guessing:
 *      a name from the docs that does not exist would otherwise come back as a
 *      generic "mutation failed" and read like a broken shop.
 *   2. WRITE — if it exists, send one and read the variant back.
 *   3. CLEAR — if the write works, can it be removed again? A field that can
 *      be set and not unset is a trap, not a feature: the merchant who ticks
 *      it by mistake is stuck with a wrong Grundpreis on the storefront.
 *
 * ── The rule every probe in this app follows ────────────────────────────────
 * A FAILED call is never reported as a NEGATIVE answer. `missing` (the API
 * answered and the field is not there) and `error` (no answer arrived) are
 * separate states in every shape below, because one throttled response read as
 * "not supported" would close a question that is actually open — the same rule
 * as `attributesSyncedAt` and `indexabilityKnown` elsewhere in this codebase.
 *
 * ── It writes to a REAL variant, and puts it back ───────────────────────────
 * There is no sandbox for this. The probe therefore reads the variant's
 * current measurement FIRST, writes its own, and restores what was there in a
 * `finally` — the same shape the collection-model probe uses for its throwaway
 * collection. The caller picks the variant; nothing is chosen for them.
 *
 * Dev-only, whole route: it is a diagnostic that mutates a live variant. The
 * Settings tab that drives it is gated the same way, but a hidden tab is not a
 * permission check — this route takes a direct POST.
 */

import { data as json, type ActionFunctionArgs } from "react-router";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { logger } from "~/utils/logger.server";

/** One answered question. `missing` and `error` are NOT the same answer. */
interface Finding {
  ok: boolean;
  /** The API answered and the thing is not there. */
  missing?: boolean;
  /** No answer arrived — says nothing about whether the thing exists. */
  error?: string;
  detail?: unknown;
}

const fail = (error: string): Finding => ({ ok: false, error });
const absent = (detail?: unknown): Finding => ({ ok: false, missing: true, detail });

/** Field names the docs and the admin UI suggest. Probed EXPLICITLY as well as
 *  discovered, so a name that is not there is a stated miss rather than an
 *  absence nobody cross-checked. */
const CANDIDATE_FIELDS = ["unitPriceMeasurement", "unitPrice", "measurement"];

export const action = async (args: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(args.request);

  // Whole-route dev gate — see the header. It WRITES to a live variant, and a
  // hidden Settings tab is not a permission check.
  if (process.env.APP_ENV !== "development") {
    return json(
      { success: false, error: "The unit-price probe is a development-only diagnostic." },
      { status: 403 },
    );
  }

  const formData = await args.request.formData();
  const variantGid = String(formData.get("variantGid") ?? "");
  const productGid = String(formData.get("productGid") ?? "");

  if (!variantGid.startsWith("gid://shopify/ProductVariant/")) {
    return json({ success: false, error: "A ProductVariant GID is required." }, { status: 400 });
  }

  const results: Record<string, Finding> = {};
  /** What was there before this probe touched anything. */
  let restore: { quantityValue: number; quantityUnit: string; referenceValue: number; referenceUnit: string } | null =
    null;

  try {
    // ── 1. Does the INPUT carry a unit-price field, and what is it called? ──
    try {
      const response = await admin.graphql(
        `#graphql
          query unitPriceInputShape {
            variantInput: __type(name: "ProductVariantsBulkInput") {
              inputFields { name type { name kind ofType { name kind } } }
            }
            measurementInput: __type(name: "UnitPriceMeasurementInput") {
              inputFields { name type { name kind ofType { name kind } } }
            }
          }`,
      );
      const body = (await response.json()) as {
        data?: {
          variantInput?: { inputFields?: Array<{ name: string; type?: unknown }> } | null;
          measurementInput?: { inputFields?: Array<{ name: string }> } | null;
        };
        errors?: Array<{ message?: string }>;
      };
      if (body.errors?.length) {
        results.inputShape = fail(body.errors[0]?.message ?? "introspection failed");
      } else if (!body.data?.variantInput) {
        // The input type itself is missing, which would be a much bigger
        // finding than the one this probe is about.
        results.inputShape = absent({ note: "ProductVariantsBulkInput not found" });
      } else {
        const names = (body.data.variantInput.inputFields ?? []).map((f) => f.name);
        const found = CANDIDATE_FIELDS.filter((c) => names.includes(c));
        results.inputShape = {
          ok: found.length > 0,
          missing: found.length === 0,
          detail: {
            found,
            candidatesProbed: CANDIDATE_FIELDS,
            // The whole list, so a field under a name nobody guessed is still
            // visible in the report rather than invisible to the probe.
            allInputFields: names,
            measurementInputFields:
              body.data.measurementInput?.inputFields?.map((f) => f.name) ?? null,
          },
        };
      }
    } catch (error) {
      results.inputShape = fail(error instanceof Error ? error.message : String(error));
    }

    // ── 2. What does the variant hold right now? ───────────────────────────
    try {
      const response = await admin.graphql(
        `#graphql
          query unitPriceCurrent($id: ID!) {
            productVariant(id: $id) {
              id
              title
              unitPriceMeasurement {
                measuredType
                quantityValue
                quantityUnit
                referenceValue
                referenceUnit
              }
            }
          }`,
        { variables: { id: variantGid } },
      );
      const body = (await response.json()) as {
        data?: {
          productVariant?: {
            id?: string;
            title?: string;
            unitPriceMeasurement?: {
              measuredType?: string | null;
              quantityValue?: number | null;
              quantityUnit?: string | null;
              referenceValue?: number | null;
              referenceUnit?: string | null;
            } | null;
          } | null;
        };
        errors?: Array<{ message?: string }>;
      };
      if (body.errors?.length) {
        results.read = fail(body.errors[0]?.message ?? "read failed");
      } else if (!body.data?.productVariant) {
        results.read = absent({ note: "no such variant" });
      } else {
        const measurement = body.data.productVariant.unitPriceMeasurement ?? null;
        if (
          measurement &&
          measurement.quantityValue != null &&
          measurement.quantityUnit &&
          measurement.referenceValue != null &&
          measurement.referenceUnit
        ) {
          restore = {
            quantityValue: measurement.quantityValue,
            quantityUnit: measurement.quantityUnit,
            referenceValue: measurement.referenceValue,
            referenceUnit: measurement.referenceUnit,
          };
        }
        results.read = {
          ok: true,
          detail: { title: body.data.productVariant.title, measurement, willRestore: restore },
        };
      }
    } catch (error) {
      results.read = fail(error instanceof Error ? error.message : String(error));
    }

    // ── 3. Can it be WRITTEN? ──────────────────────────────────────────────
    // Attempted regardless of what introspection said: the two answers
    // together are the finding. A field that introspects as present and then
    // refuses the write is exactly the case this probe exists to catch, and it
    // is invisible if the write is skipped whenever the shape looks wrong.
    if (!productGid.startsWith("gid://shopify/Product/")) {
      results.write = fail("A Product GID is required for the write test.");
    } else {
      results.write = await tryWrite(admin, productGid, variantGid, {
        quantityValue: 500,
        quantityUnit: "GRAMS",
        referenceValue: 1,
        referenceUnit: "KILOGRAMS",
      });

      // ── 4. Can it be CLEARED again? ─────────────────────────────────────
      // Only worth asking if the write took. A field that can be set and not
      // unset is a trap: a merchant who fills it in by mistake is stuck with a
      // wrong Grundpreis on their storefront.
      if (results.write.ok) {
        results.clear = await tryWrite(admin, productGid, variantGid, null);
      }
    }
  } finally {
    // Put back whatever was there. A probe that leaves a 500 g / kg
    // measurement on a real product has changed the storefront it came to
    // measure.
    if (results.write?.ok) {
      // Put back exactly what was there — or clear it, when there was nothing.
      // "Restore" for an empty starting state IS the clear.
      results.restored = await tryWrite(admin, productGid, variantGid, restore);
    }
  }

  logger.info("[UnitPriceProbe] finished", {
    context: "UnitPriceProbe",
    shop: session.shop,
    steps: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.ok])),
  });

  return json({ success: true, results });
};

/**
 * One `productVariantsBulkUpdate` carrying a unit-price measurement.
 *
 * `null` clears it. The echo is READ BACK from the variant rather than trusted
 * from the mutation payload: this app's whole experience of new fields is that
 * `userErrors: []` is not the same as "stored".
 */
async function tryWrite(
  admin: AdminApiContext,
  productGid: string,
  variantGid: string,
  measurement: { quantityValue: number; quantityUnit: string; referenceValue: number; referenceUnit: string } | null,
): Promise<Finding> {
  if (!productGid.startsWith("gid://shopify/Product/")) return fail("no product gid");
  try {
    const response = await admin.graphql(
      `#graphql
        mutation unitPriceWrite($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            productVariants {
              id
              unitPriceMeasurement {
                quantityValue
                quantityUnit
                referenceValue
                referenceUnit
              }
            }
            userErrors { field message }
          }
        }`,
      {
        variables: {
          productId: productGid,
          variants: [{ id: variantGid, unitPriceMeasurement: measurement }],
        },
      },
    );
    const body = (await response.json()) as {
      data?: {
        productVariantsBulkUpdate?: {
          productVariants?: Array<{
            id?: string;
            unitPriceMeasurement?: Record<string, unknown> | null;
          }> | null;
          userErrors?: Array<{ field?: string[]; message?: string }>;
        } | null;
      };
      errors?: Array<{ message?: string }>;
    };

    // A schema-level rejection is THE most likely answer here and the most
    // informative one: it names the field the input does not have. Reported as
    // `missing`, not as a failure, because it IS the answer to question 1.
    if (body.errors?.length) {
      const message = body.errors[0]?.message ?? "";
      const isSchema = /unitPriceMeasurement|Field .* is not defined|InputObject/i.test(message);
      return isSchema ? absent({ schemaError: message }) : fail(message);
    }
    const payload = body.data?.productVariantsBulkUpdate;
    if (payload?.userErrors?.length) {
      return { ok: false, error: payload.userErrors[0]?.message, detail: payload.userErrors };
    }
    const echoed = payload?.productVariants?.find((v) => v.id === variantGid);
    if (!echoed) return fail("the mutation returned no variant — nothing confirms the write");

    const got = echoed.unitPriceMeasurement ?? null;
    const wanted = measurement;
    const matches =
      wanted === null
        ? got === null
        : !!got &&
          Number(got.quantityValue) === wanted.quantityValue &&
          got.quantityUnit === wanted.quantityUnit &&
          Number(got.referenceValue) === wanted.referenceValue &&
          got.referenceUnit === wanted.referenceUnit;

    return {
      // ACCEPTED AND IGNORED is its own outcome, and the one worth the probe:
      // no errors, a healthy response, and the value unchanged.
      ok: matches,
      error: matches ? undefined : "accepted, but the variant came back without the value",
      detail: { sent: wanted, echoed: got },
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
