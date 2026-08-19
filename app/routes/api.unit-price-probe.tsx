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
 *   2. WRITE - if it exists, send one and read the variant back.
 *   3. CLEAR - if the write works, can it be removed again? A field that can
 *      be set and not unset is a trap, not a feature: the merchant who ticks
 *      it by mistake is stuck with a wrong Grundpreis on the storefront.
 *   4. HIDE - a separate question from 3, and only asked because the first
 *      live run answered 3 with NO. `unitPriceMeasurement: null` is accepted,
 *      reports no errors, and leaves the measurement exactly where it was.
 *      `showUnitPrice` sat next to it in the same introspection, so the clear
 *      step is a LADDER of candidates and the two outcomes are reported
 *      apart: removing a Grundpreis and hiding one are not the same promise.
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

import { data as json, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
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

/** The field the write actually sends. */
const FIELD_NAME = "unitPriceMeasurement";

/**
 * The units this field takes, MEASURED rather than assumed.
 *
 * `UnitPriceMeasurementInput` does NOT use `WeightUnit` - the probe's first
 * run sent the long spelling every other weight field in this app uses, and
 * Shopify refused it at the SCHEMA level, naming the valid set in the error:
 * ML, CL, L, M3, FLOZ, PT, QT, GAL, MG, G, KG, OZ, LB, MM, CM, M, IN, FT, YD,
 * M2, FT2, ITEM, UNKNOWN. That refusal arrived as a top-level `errors` array
 * with `data: null`, i.e. the shape that never reaches `userErrors` - a caller
 * checking only `userErrors` would have read it as a success.
 *
 * The probe uses the two mass units, which is the common Grundpreis case: a
 * 500 g pack priced per kilogram.
 */
const UNIT_PRICE_UNITS = {
  quantity: "G",
  reference: "KG",
} as const;

/**
 * The products this shop has cached, with their variants.
 *
 * So the probe can be driven from two dropdowns instead of two pasted GIDs.
 * Nobody knows a variant's GID by heart, and a diagnostic that is hard to
 * START is a diagnostic that does not get run — which is the whole reason it
 * exists.
 *
 * Read from the CACHE, not from Shopify: the list only has to be good enough
 * to pick a product to write a test measurement to. `shopifyGid` is stored on
 * the variant row, so nothing is assembled from an id here.
 */
export const loader = async (args: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(args.request);

  if (process.env.APP_ENV !== "development") {
    return json({ success: false, products: [] }, { status: 403 });
  }

  const products = await db.product.findMany({
    where: { shop: session.shop },
    select: {
      id: true,
      title: true,
      variants: {
        select: { id: true, shopifyGid: true, title: true, sku: true },
        orderBy: { position: "asc" },
        // A product with hundreds of variants needs none of them here: the
        // probe writes to ONE, and a picker nobody can scroll is not a picker.
        take: 100,
      },
    },
    orderBy: { title: "asc" },
    // Bounded for the same reason. A dev diagnostic does not need the whole
    // catalogue in one response.
    take: 200,
  });

  return json({
    success: true,
    products: products
      // A product whose variants were never synced cannot be probed, and
      // offering it would produce a picker that leads nowhere.
      .filter((product) => product.variants.length > 0)
      .map((product) => ({
        gid: product.id,
        title: product.title,
        variants: product.variants.map((variant) => ({
          gid: variant.shopifyGid,
          title: variant.title,
          sku: variant.sku,
        })),
      })),
  });
};


/** What "nothing is set" actually looks like on the wire.
 *
 *  MEASURED: a variant with no Grundpreis does NOT answer `null`. It answers a
 *  ZEROED struct - `{measuredType: null, quantityValue: 0, quantityUnit: null,
 *  referenceValue: 0, referenceUnit: null}` - so `=== null` is not the
 *  emptiness test. Getting this wrong reports a successful clear as a failure,
 *  which is the same class of mistake as reading an empty column as evidence. */
function isEmptyMeasurement(measurement: Record<string, unknown> | null | undefined): boolean {
  return !measurement || !measurement.quantityUnit || !measurement.referenceUnit;
}

/**
 * The ways a Grundpreis might be taken off a variant, in the order they are
 * tried.
 *
 * There is more than one candidate because `unitPriceMeasurement: null` is
 * MEASURED not to work: the mutation accepts it, reports no errors, and the
 * variant comes back still carrying 500 g / 1 kg. `showUnitPrice` turned up in
 * the same introspection as its neighbour, which makes it the obvious second
 * question - and the two are not the same question. Removing the measurement
 * and hiding it are different outcomes for a merchant, so they are reported
 * separately rather than folded into one "clear" verdict.
 */
const CLEAR_STRATEGIES: Array<{ label: string; input: Record<string, unknown> }> = [
  { label: "unitPriceMeasurement: null", input: { unitPriceMeasurement: null } },
  { label: "showUnitPrice: false", input: { showUnitPrice: false } },
  { label: "both at once", input: { unitPriceMeasurement: null, showUnitPrice: false } },
];

/** The unit-price state of one variant, as the mutation echoed it back. */
interface VariantState {
  measurement: Record<string, unknown> | null;
  /** `null` when the field is not readable on this API version - "not asked"
   *  and "off" are different answers. */
  showUnitPrice: boolean | null;
}

interface Attempt {
  strategy: string;
  measurement: unknown;
  showUnitPrice: boolean | null;
  measurementGone: boolean;
  hidden: boolean;
  error?: string;
}

export const action = async (args: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(args.request);

  // Whole-route dev gate - see the header. It WRITES to a live variant, and a
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
  /**
   * `clear` runs ONLY the removal ladder, against whatever the variant holds.
   *
   * It exists because the probe's own first run could not put the variant back:
   * the write worked, every clear failed, and the restore in the `finally`
   * failed for the identical reason. A probe that can leave a measurement
   * behind owes the merchant a way to take it off - and re-running the full
   * probe is not that way, since it would read the leftover as the state to
   * restore and put it back at the end.
   */
  const mode = String(formData.get("mode") ?? "probe") === "clear" ? "clear" : "probe";

  if (!variantGid.startsWith("gid://shopify/ProductVariant/")) {
    return json({ success: false, error: "A ProductVariant GID is required." }, { status: 400 });
  }
  if (!productGid.startsWith("gid://shopify/Product/")) {
    return json({ success: false, error: "A Product GID is required." }, { status: 400 });
  }

  const results: Record<string, Finding> = {};
  /** What was there before this probe touched anything. */
  let restore: {
    quantityValue: number;
    quantityUnit: string;
    referenceValue: number;
    referenceUnit: string;
  } | null = null;
  let restoreShowUnitPrice: boolean | null = null;
  /**
   * Whether `ProductVariant.showUnitPrice` can be SELECTED, established by
   * introspection before anything selects it. A guessed field name in a
   * selection set fails the whole query, which would take the answers that do
   * exist down with it.
   */
  let readsShowUnitPrice = false;
  /** The strategy that actually removed the measurement, once one has. */
  let workingClear: { label: string; input: Record<string, unknown> } | null = null;

  try {
    // -- 1. Does the INPUT carry a unit-price field, and what is it called? --
    if (mode === "probe") {
      results.inputShape = await probeInputShape(admin);
    }
    // The output side is needed in BOTH modes: it decides what may be selected.
    readsShowUnitPrice = await canReadShowUnitPrice(admin);
    if (results.inputShape?.detail && typeof results.inputShape.detail === "object") {
      (results.inputShape.detail as Record<string, unknown>).readsShowUnitPrice = readsShowUnitPrice;
    }

    // -- 2. What does the variant hold right now? ---------------------------
    const current = await readVariant(admin, variantGid, readsShowUnitPrice);
    results.read = current.finding;
    if (current.state) {
      const measurement = current.state.measurement;
      if (
        measurement &&
        !isEmptyMeasurement(measurement) &&
        measurement.quantityValue != null &&
        measurement.referenceValue != null
      ) {
        restore = {
          quantityValue: Number(measurement.quantityValue),
          quantityUnit: String(measurement.quantityUnit),
          referenceValue: Number(measurement.referenceValue),
          referenceUnit: String(measurement.referenceUnit),
        };
      }
      restoreShowUnitPrice = current.state.showUnitPrice;
      (results.read.detail as Record<string, unknown>).willRestore = restore;
    }

    // -- 3. Can it be WRITTEN? ----------------------------------------------
    // Attempted regardless of what introspection said: the two answers
    // together are the finding. A field that introspects as present and then
    // refuses the write is exactly the case this probe exists to catch, and it
    // is invisible if the write is skipped whenever the shape looks wrong.
    if (mode === "probe") {
      const wanted = {
        quantityValue: 500,
        quantityUnit: UNIT_PRICE_UNITS.quantity,
        referenceValue: 1,
        referenceUnit: UNIT_PRICE_UNITS.reference,
      };
      const written = await applyVariantInput(
        admin,
        productGid,
        variantGid,
        { unitPriceMeasurement: wanted },
        readsShowUnitPrice,
      );
      if (written.error) {
        results.write = written.error;
      } else {
        const got = written.state?.measurement ?? null;
        const matches =
          !!got &&
          Number(got.quantityValue) === wanted.quantityValue &&
          got.quantityUnit === wanted.quantityUnit &&
          Number(got.referenceValue) === wanted.referenceValue &&
          got.referenceUnit === wanted.referenceUnit;
        results.write = {
          // ACCEPTED AND IGNORED is its own outcome, and the one worth the
          // probe: no errors, a healthy response, and the value unchanged.
          ok: matches,
          error: matches ? undefined : "accepted, but the variant came back without the value",
          detail: { sent: wanted, echoed: got, showUnitPrice: written.state?.showUnitPrice ?? null },
        };
      }
    }

    // -- 4. Can it be REMOVED again, and can it be HIDDEN? ------------------
    // Two questions, not one. A measurement that cannot be removed but can be
    // switched off is still a shippable feature - the off-switch is just a
    // different field. A measurement that can be neither is a trap: the
    // merchant who fills it in by mistake is stuck with a wrong Grundpreis on
    // their storefront, and this app must not offer to write it.
    const worthClearing = mode === "clear" || results.write?.ok;
    if (worthClearing) {
      const attempts: Attempt[] = [];
      for (const strategy of CLEAR_STRATEGIES) {
        const out = await applyVariantInput(
          admin,
          productGid,
          variantGid,
          strategy.input,
          readsShowUnitPrice,
        );
        if (out.error) {
          // Not an answer. The next strategy may still give one.
          attempts.push({
            strategy: strategy.label,
            measurement: null,
            showUnitPrice: null,
            measurementGone: false,
            hidden: false,
            error: out.error.error ?? "no answer",
          });
          continue;
        }
        const state = out.state as VariantState;
        const attempt: Attempt = {
          strategy: strategy.label,
          measurement: state.measurement,
          showUnitPrice: state.showUnitPrice,
          measurementGone: isEmptyMeasurement(state.measurement),
          hidden: state.showUnitPrice === false,
        };
        attempts.push(attempt);
        if (attempt.measurementGone && !workingClear) {
          workingClear = strategy;
          break;
        }
      }

      const removed = attempts.find((a) => a.measurementGone);
      const hid = attempts.find((a) => a.hidden);
      const answered = attempts.some((a) => !a.error);

      results.clear = {
        ok: !!removed,
        // Every strategy was refused outright, so nothing was learned. Only an
        // ANSWERED round of attempts can say "it cannot be removed".
        missing: !removed && answered ? true : undefined,
        error: removed
          ? undefined
          : answered
            ? "accepted every time, and the measurement stayed on the variant"
            : "no strategy got an answer",
        detail: { attempts, worked: removed?.strategy ?? null },
      };
      results.hide = {
        ok: !!hid,
        missing: !hid && answered && readsShowUnitPrice ? true : undefined,
        error: hid
          ? undefined
          : !readsShowUnitPrice
            ? "ProductVariant.showUnitPrice is not readable on this API version, so this was not asked"
            : answered
              ? "showUnitPrice did not come back false"
              : "no strategy got an answer",
        detail: { worked: hid?.strategy ?? null },
      };
    }
  } finally {
    // Put the variant back the way it was found. A probe that leaves a
    // 500 g / kg measurement on a real product has changed the storefront it
    // came to measure - which is exactly what the first run did, and why the
    // failure below is REPORTED rather than swallowed.
    if (mode === "probe" && results.write?.ok) {
      if (restore) {
        const out = await applyVariantInput(
          admin,
          productGid,
          variantGid,
          { unitPriceMeasurement: restore },
          readsShowUnitPrice,
        );
        const got = out.state?.measurement ?? null;
        const back =
          !!got &&
          Number(got.quantityValue) === restore.quantityValue &&
          got.quantityUnit === restore.quantityUnit;
        results.restored = {
          ok: back,
          error: out.error?.error ?? (back ? undefined : "the old measurement did not go back on"),
          detail: { sent: restore, echoed: got },
        };
      } else if (workingClear) {
        // It started empty, so restoring IS clearing - and the ladder already
        // found the way. Replaying it here also puts `showUnitPrice` back,
        // since the strategy that worked may have turned it off.
        const input = { ...workingClear.input };
        if (readsShowUnitPrice && restoreShowUnitPrice !== null) {
          input.showUnitPrice = restoreShowUnitPrice;
        }
        const out = await applyVariantInput(admin, productGid, variantGid, input, readsShowUnitPrice);
        const gone = isEmptyMeasurement(out.state?.measurement);
        results.restored = {
          ok: gone,
          error: out.error?.error ?? (gone ? undefined : "the measurement stayed on the variant"),
          detail: { strategy: workingClear.label, echoed: out.state?.measurement ?? null },
        };
      } else {
        // Nothing could take it off. Saying so plainly is the only honest
        // outcome: the variant is left carrying the probe's measurement and
        // the merchant has to remove it in the Shopify admin.
        results.restored = {
          ok: false,
          error:
            "the variant still carries the probe's 500 g / 1 kg measurement - nothing could remove it",
          detail: { leftBehind: true, variantGid },
        };
      }
    }
  }

  logger.info("[UnitPriceProbe] finished", {
    context: "UnitPriceProbe",
    shop: session.shop,
    mode,
    steps: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.ok])),
  });

  return json({ success: true, results });
};

/** Question 1, on its own so the clear-only mode can skip it. */
async function probeInputShape(admin: AdminApiContext): Promise<Finding> {
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
        variantInput?: { inputFields?: Array<{ name: string }> } | null;
        measurementInput?: { inputFields?: Array<{ name: string }> } | null;
      };
      errors?: Array<{ message?: string }>;
    };
    if (body.errors?.length) return fail(body.errors[0]?.message ?? "introspection failed");
    if (!body.data?.variantInput) {
      // The input type itself is missing, which would be a much bigger finding
      // than the one this probe is about.
      return absent({ note: "ProductVariantsBulkInput not found" });
    }
    const names = (body.data.variantInput.inputFields ?? []).map((f) => f.name);
    const found = CANDIDATE_FIELDS.filter((c) => names.includes(c));
    return {
      ok: found.length > 0,
      missing: found.length === 0,
      detail: {
        found,
        candidatesProbed: CANDIDATE_FIELDS,
        // The whole list, so a field under a name nobody guessed is still
        // visible in the report rather than invisible to the probe.
        allInputFields: names,
        measurementInputFields: body.data.measurementInput?.inputFields?.map((f) => f.name) ?? null,
      },
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

/**
 * May `showUnitPrice` be SELECTED on this API version?
 *
 * Asked before anything selects it. GraphQL fails the whole document on one
 * unknown field, so guessing here would turn a missing extra into a total
 * failure of the read - and the read is where the restore value comes from.
 * A failed introspection answers `false`: not asking for a field costs one
 * detail, asking for one that is not there costs the run.
 */
async function canReadShowUnitPrice(admin: AdminApiContext): Promise<boolean> {
  try {
    const response = await admin.graphql(
      `#graphql
        query unitPriceOutputShape {
          variantType: __type(name: "ProductVariant") { fields { name } }
        }`,
    );
    const body = (await response.json()) as {
      data?: { variantType?: { fields?: Array<{ name: string }> } | null };
    };
    return (body.data?.variantType?.fields ?? []).some((f) => f.name === "showUnitPrice");
  } catch {
    return false;
  }
}

/** The selection both the read and every write share. */
const MEASUREMENT_SELECTION = `unitPriceMeasurement {
  measuredType
  quantityValue
  quantityUnit
  referenceValue
  referenceUnit
}`;

/** Question 2, and the source of the restore value. */
async function readVariant(
  admin: AdminApiContext,
  variantGid: string,
  readsShowUnitPrice: boolean,
): Promise<{ finding: Finding; state?: VariantState }> {
  try {
    const response = await admin.graphql(
      `#graphql
        query unitPriceCurrent($id: ID!) {
          productVariant(id: $id) {
            id
            title
            ${MEASUREMENT_SELECTION}
            ${readsShowUnitPrice ? "showUnitPrice" : ""}
          }
        }`,
      { variables: { id: variantGid } },
    );
    const body = (await response.json()) as {
      data?: {
        productVariant?: {
          title?: string;
          unitPriceMeasurement?: Record<string, unknown> | null;
          showUnitPrice?: boolean | null;
        } | null;
      };
      errors?: Array<{ message?: string }>;
    };
    if (body.errors?.length) return { finding: fail(body.errors[0]?.message ?? "read failed") };
    if (!body.data?.productVariant) return { finding: absent({ note: "no such variant" }) };

    const measurement = body.data.productVariant.unitPriceMeasurement ?? null;
    const showUnitPrice = readsShowUnitPrice
      ? (body.data.productVariant.showUnitPrice ?? null)
      : null;
    return {
      finding: {
        ok: true,
        detail: {
          title: body.data.productVariant.title,
          measurement,
          isEmpty: isEmptyMeasurement(measurement),
          showUnitPrice,
        },
      },
      state: { measurement, showUnitPrice },
    };
  } catch (error) {
    return { finding: fail(error instanceof Error ? error.message : String(error)) };
  }
}

/**
 * One `productVariantsBulkUpdate` carrying whatever unit-price input the
 * caller wants to try, and the state the variant came back with.
 *
 * The echo is what decides everything above: this app's whole experience of
 * new fields is that `userErrors: []` is not the same as "stored".
 */
async function applyVariantInput(
  admin: AdminApiContext,
  productGid: string,
  variantGid: string,
  input: Record<string, unknown>,
  readsShowUnitPrice: boolean,
): Promise<{ error?: Finding; state?: VariantState }> {
  try {
    const response = await admin.graphql(
      `#graphql
        mutation unitPriceWrite($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            productVariants {
              id
              ${MEASUREMENT_SELECTION}
              ${readsShowUnitPrice ? "showUnitPrice" : ""}
            }
            userErrors { field message }
          }
        }`,
      {
        variables: {
          productId: productGid,
          variants: [{ id: variantGid, ...input }],
        },
      },
    );
    const body = (await response.json()) as {
      data?: {
        productVariantsBulkUpdate?: {
          productVariants?: Array<{
            id?: string;
            unitPriceMeasurement?: Record<string, unknown> | null;
            showUnitPrice?: boolean | null;
          }> | null;
          userErrors?: Array<{ field?: string[]; message?: string }>;
        } | null;
      };
      errors?: Array<{ message?: string }>;
    };

    // A schema-level rejection is THE most likely answer here and the most
    // informative one: it names the field the input does not have. Reported as
    // `missing`, not as a failure, because it IS the answer to question 1.
    //
    // But only a rejection that says the field is NOT THERE. A rejection of
    // the VALUE mentions the same field name while proving the opposite - the
    // first live run was refused with "invalid value for
    // 0.unitPriceMeasurement.quantityUnit (Expected ... to be one of: ...)",
    // which is the schema confirming the field exists and disagreeing about
    // the unit. Matching on the field name alone would have turned that into
    // "not supported" and closed the question with the answer inverted.
    if (body.errors?.length) {
      const message = body.errors[0]?.message ?? "";
      const undefinedField =
        /is not defined|doesn't exist|does not exist|unknown field|no field/i.test(message);
      const namesTheField = new RegExp(FIELD_NAME, "i").test(message);
      return { error: undefinedField && namesTheField ? absent({ schemaError: message }) : fail(message) };
    }
    const payload = body.data?.productVariantsBulkUpdate;
    if (payload?.userErrors?.length) {
      return { error: { ok: false, error: payload.userErrors[0]?.message, detail: payload.userErrors } };
    }
    const echoed = payload?.productVariants?.find((v) => v.id === variantGid);
    if (!echoed) {
      return { error: fail("the mutation returned no variant - nothing confirms the write") };
    }
    return {
      state: {
        measurement: echoed.unitPriceMeasurement ?? null,
        showUnitPrice: readsShowUnitPrice ? (echoed.showUnitPrice ?? null) : null,
      },
    };
  } catch (error) {
    return { error: fail(error instanceof Error ? error.message : String(error)) };
  }
}
