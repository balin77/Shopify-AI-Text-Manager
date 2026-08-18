/**
 * Metaobject Probe -- PLAN_METAOBJECTS_EDITOR Phase 0
 *
 * Answers the five assumptions the metaobject plan refuses to design around
 * (§2, V1-V5) plus the one format question (M2), against a live shop:
 *
 *   V1  May a third-party app with `write_metaobjects` create / update /
 *       delete entries of a Shopify STANDARD definition (`shopify--...`)?
 *   V2  What does the standard colour definition look like -- is it really
 *       `shopify--color-pattern`, and which of its fields is the colour?
 *   V3  Is `ProductOptionValue.swatch` DERIVED from those fields, i.e. does
 *       our `metaobjectUpdate` move the swatch the storefront shows?
 *   V4  Is there a reverse relation on Metaobject that counts the products
 *       using an entry?
 *   V5  What happens when a still-linked entry is deleted -- refusal, cascade
 *       (variants and their stock/prices go with it) or a dead reference?
 *   M2  The real wire format of a `color` value and a `file_reference` value.
 *
 * Four rules this route inherits from api.collection-model-probe.tsx, because
 * they were expensive to learn there:
 *
 * 1. A FAILED call is never a NEGATIVE answer. Every shape carries `missing`
 *    (the API answered and it is not there) and `error` (we never got an
 *    answer) as SEPARATE states. A throttled request must not be read as
 *    "standard definitions are read-only" and re-plan Phase 4.
 * 2. An EMPTY result is not evidence. `translatableContent` only lists keys
 *    that HAVE a primary value, so the sample picker prefers an entry whose
 *    fields are actually filled -- the same reason `pickWithImage` exists in
 *    api.translation-probe.tsx.
 * 3. It does not GUESS the name of the reverse relation (V4). It introspects
 *    the `Metaobject` type and reports what is actually there; a name from the
 *    plan that comes back absent is a finding, not a typo.
 * 4. Cleanup runs in a `finally`, and whatever could NOT be cleaned up is
 *    reported WITH its GID rather than swallowed.
 *
 * Dev-only, WHOLE route: steps 3 and 4 create real objects in the merchant's
 * shop, and even the read half burns Admin API budget. The Settings sub-tab is
 * gated the same way, but a hidden tab is not a permission check -- this route
 * takes a direct POST.
 */

import { data as json, type ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { logger } from "~/utils/logger.server";
import { resolveApiVersionString } from "~/utils/api-version";

/** The definition V2 expects to find. Probed by name so an absence is loud. */
const STANDARD_COLOUR_TYPE = "shopify--color-pattern";

/** How many entries step 2 samples. Small on purpose: it is a shape question,
 *  not a census, and every extra entry is another translatableResource call. */
const SAMPLE_LIMIT = 5;

/** Reverse-relation names the plan speculates about (V4). Introspection is the
 *  authority; this list only decides which ones get called out explicitly. */
const CANDIDATE_REVERSE_FIELDS = ["referencedBy", "referencedByProducts", "usedBy"];

type GraphQLCallResult = {
  ok: boolean;
  data?: any;
  errors?: Array<{ message: string }>;
  networkError?: string;
};

interface StepOutcome {
  step: string;
  ok: boolean;
  detail: string;
}

interface DefinitionShape {
  id: string;
  type: string;
  name: string;
  /** `shopify--` prefixed -- the definitions V1 is about. */
  standard: boolean;
  access?: { admin?: string | null; storefront?: string | null } | null;
  capabilities?: Record<string, unknown> | null;
  createdByApp?: string | null;
  fieldDefinitions: Array<{ key: string; name?: string; type: string; required?: boolean }>;
}

interface SampleEntry {
  id: string;
  handle: string;
  displayName: string;
  fields: Array<{ key: string; value: string | null; type: string }>;
  /** Keys Shopify reports as translatable. ABSENT != untranslatable: the key
   *  is only listed when the field HAS a primary value. */
  translatableKeys?: string[];
  translatableError?: string;
}

export interface MetaobjectProbeReport {
  shop: string;
  ranAt: string;
  apiVersion: string;
  /** Which steps were asked for -- so a partial report cannot read as a full one. */
  requestedSteps: string[];
  definitions?: DefinitionShape[];
  definitionsError?: string;
  /** Whether the full selection (access/capabilities/createdByApp) was accepted;
   *  false means the shapes above are absent because the QUERY was reduced, not
   *  because the shop has none. */
  definitionsFullSelection?: boolean;
  samples?: { type: string; entries: SampleEntry[]; error?: string };
  /** Introspected fields of the Metaobject object type -- the V4 answer. */
  metaobjectTypeFields?: string[];
  metaobjectTypeFieldsError?: string;
  reverseRelationField?: string | null;
  writeTest: { attempted: boolean; skippedReason?: string; steps?: StepOutcome[]; verdict?: string; leftovers?: string[] };
  linkTest: { attempted: boolean; skippedReason?: string; steps?: StepOutcome[]; verdict?: string; leftovers?: string[] };
  verdicts: string[];
}

function describeFailure(res: GraphQLCallResult, userErrors?: Array<{ message: string }>): string {
  if (res.networkError) return `no answer: ${res.networkError}`;
  if (res.errors?.length) return `errors: ${res.errors.map((e) => e.message).join("; ").slice(0, 400)}`;
  if (userErrors?.length) return `userErrors: ${userErrors.map((e) => e.message).join("; ").slice(0, 400)}`;
  return "no answer and no error reported";
}

/** The one place that turns a field-definition node into our flat shape. */
function flattenFieldDefinitions(nodes: any[]): DefinitionShape["fieldDefinitions"] {
  return (nodes ?? []).map((f: any) => ({
    key: f?.key ?? "",
    name: f?.name ?? undefined,
    type: f?.type?.name ?? "",
    required: typeof f?.required === "boolean" ? f.required : undefined,
  }));
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);

  // Whole-route dev gate -- see the header. Steps 3 and 4 WRITE.
  if (process.env.APP_ENV !== "development") {
    return json(
      { success: false, error: "The metaobject probe is a development-only diagnostic." },
      { status: 403 },
    );
  }

  const formData = await request.formData().catch(() => null);
  const requestedSteps = String(formData?.get("steps") ?? "definitions")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const sampleType = String(formData?.get("sampleType") ?? "").trim();
  const writeType = String(formData?.get("writeType") ?? STANDARD_COLOUR_TYPE).trim();

  /** One Admin GraphQL call that never throws. */
  const call = async (query: string, variables?: Record<string, unknown>): Promise<GraphQLCallResult> => {
    try {
      const res = await admin.graphql(query, { variables: variables ?? {} });
      const body: any = await res.json();
      return { ok: !body.errors?.length, data: body.data, errors: body.errors };
    } catch (e) {
      return { ok: false, networkError: e instanceof Error ? e.message : String(e) };
    }
  };

  const report: MetaobjectProbeReport = {
    shop: session.shop,
    ranAt: new Date().toISOString(),
    apiVersion: resolveApiVersionString(),
    requestedSteps,
    writeTest: { attempted: false },
    linkTest: { attempted: false },
    verdicts: [],
  };

  const wants = (step: string) => requestedSteps.includes(step);

  // ---- Step 1: definitions (read-only) -------------------------------------
  // The full selection is TRIED first and falls back to the minimal one. A
  // reduced query is recorded (`definitionsFullSelection: false`) so an absent
  // `access` block cannot be read as "this shop's definitions have none".
  let definitions: DefinitionShape[] = [];
  if (wants("definitions") || wants("samples") || wants("write") || wants("link")) {
    const full = await call(
      `#graphql
        query MetaobjectProbeDefinitionsFull($first: Int!) {
          metaobjectDefinitions(first: $first) {
            nodes {
              id
              type
              name
              access { admin storefront }
              capabilities { translatable { enabled } publishable { enabled } }
              createdByApp { handle }
              fieldDefinitions { key name required type { name } }
            }
          }
        }`,
      { first: 100 },
    );

    if (full.ok) {
      report.definitionsFullSelection = true;
      definitions = (full.data?.metaobjectDefinitions?.nodes ?? []).map((n: any) => ({
        id: n.id,
        type: n.type,
        name: n.name,
        standard: String(n.type ?? "").startsWith("shopify--"),
        access: n.access ?? null,
        capabilities: n.capabilities ?? null,
        createdByApp: n.createdByApp?.handle ?? null,
        fieldDefinitions: flattenFieldDefinitions(n.fieldDefinitions),
      }));
    } else {
      const minimal = await call(
        `#graphql
          query MetaobjectProbeDefinitionsMinimal($first: Int!) {
            metaobjectDefinitions(first: $first) {
              nodes {
                id
                type
                name
                fieldDefinitions { key name required type { name } }
              }
            }
          }`,
        { first: 100 },
      );
      if (minimal.ok) {
        report.definitionsFullSelection = false;
        report.definitionsError = `full selection refused (${describeFailure(full)}) -- access/capabilities/createdByApp are UNKNOWN, not absent`;
        definitions = (minimal.data?.metaobjectDefinitions?.nodes ?? []).map((n: any) => ({
          id: n.id,
          type: n.type,
          name: n.name,
          standard: String(n.type ?? "").startsWith("shopify--"),
          fieldDefinitions: flattenFieldDefinitions(n.fieldDefinitions),
        }));
      } else {
        report.definitionsError = describeFailure(minimal);
      }
    }
    report.definitions = definitions;

    if (report.definitionsError && definitions.length === 0) {
      report.verdicts.push(
        "INCONCLUSIVE: the definition list could not be read. Nothing below is a negative answer -- re-run before drawing a conclusion.",
      );
    } else {
      const colour = definitions.find((d) => d.type === STANDARD_COLOUR_TYPE);
      if (colour) {
        const colourField = colour.fieldDefinitions.find((f) => f.type === "color");
        const fileField = colour.fieldDefinitions.find((f) => f.type === "file_reference");
        report.verdicts.push(
          `V2 CONFIRMED: "${STANDARD_COLOUR_TYPE}" exists with fields ${colour.fieldDefinitions
            .map((f) => `${f.key}:${f.type}`)
            .join(", ")}. colour field = ${colourField?.key ?? "NONE"}, image field = ${fileField?.key ?? "NONE"}.`,
        );
      } else {
        report.verdicts.push(
          `V2 NEGATIVE for this shop: no definition of type "${STANDARD_COLOUR_TYPE}". Standard definitions present: ${
            definitions.filter((d) => d.standard).map((d) => d.type).join(", ") || "(none)"
          }. A shop that never used a standard colour option simply has none -- this is not evidence the type does not exist on the platform.`,
        );
      }
    }
  }

  // ---- Step 1b: does Metaobject carry a reverse relation? (V4) -------------
  // Introspection rather than a guessed field name: an absent name from the
  // plan is then a measurement, not a typo.
  if (wants("definitions") || wants("link")) {
    const introspect = await call(
      `#graphql
        query MetaobjectProbeTypeShape {
          __type(name: "Metaobject") {
            fields(includeDeprecated: true) { name }
          }
        }`,
    );
    if (introspect.ok) {
      const names: string[] = (introspect.data?.__type?.fields ?? []).map((f: any) => f.name);
      report.metaobjectTypeFields = names;
      report.reverseRelationField = CANDIDATE_REVERSE_FIELDS.find((c) => names.includes(c)) ?? null;
      report.verdicts.push(
        report.reverseRelationField
          ? `V4 CONFIRMED: Metaobject.${report.reverseRelationField} exists -- a live usage count is possible.`
          : `V4 NEGATIVE: Metaobject exposes none of ${CANDIDATE_REVERSE_FIELDS.join(", ")}. Usage must be counted from the product cache, and "cache empty" stays UNKNOWN rather than zero.`,
      );
    } else {
      report.metaobjectTypeFieldsError = describeFailure(introspect);
      report.reverseRelationField = null;
      report.verdicts.push("V4 INCONCLUSIVE: the introspection call failed. Not a negative answer.");
    }
  }

  // ---- Step 2: sample values + translatable keys (read-only, M2) -----------
  if (wants("samples")) {
    const type = sampleType || STANDARD_COLOUR_TYPE;
    const listed = await call(
      `#graphql
        query MetaobjectProbeSamples($type: String!, $first: Int!) {
          metaobjects(type: $type, first: $first) {
            nodes {
              id
              handle
              displayName
              fields { key value type }
            }
          }
        }`,
      { type, first: 50 },
    );

    if (!listed.ok) {
      report.samples = { type, entries: [], error: describeFailure(listed) };
    } else {
      const all: SampleEntry[] = (listed.data?.metaobjects?.nodes ?? []).map((n: any) => ({
        id: n.id,
        handle: n.handle,
        displayName: n.displayName,
        fields: n.fields ?? [],
      }));
      // Rule 2 of the header: prefer entries whose fields are actually FILLED.
      // `translatableContent` omits keys without a primary value, so a sample
      // of empty entries would report "nothing is translatable" about a type
      // that translates fine.
      const filledFirst = [...all].sort(
        (a, b) =>
          b.fields.filter((f) => (f.value ?? "").trim() !== "").length -
          a.fields.filter((f) => (f.value ?? "").trim() !== "").length,
      );
      const entries = filledFirst.slice(0, SAMPLE_LIMIT);
      for (const entry of entries) {
        const translatable = await call(
          `#graphql
            query MetaobjectProbeTranslatable($resourceId: ID!) {
              translatableResource(resourceId: $resourceId) {
                resourceId
                translatableContent { key digest type }
              }
            }`,
          { resourceId: entry.id },
        );
        if (translatable.ok) {
          entry.translatableKeys = (translatable.data?.translatableResource?.translatableContent ?? []).map(
            (c: any) => c.key,
          );
        } else {
          entry.translatableError = describeFailure(translatable);
        }
      }
      report.samples = { type, entries };
      const withKeys = entries.filter((e) => e.translatableKeys && e.translatableKeys.length > 0);
      report.verdicts.push(
        withKeys.length > 0
          ? `M2/§6.6: Shopify reports these translatable keys on "${type}": ${Array.from(
              new Set(withKeys.flatMap((e) => e.translatableKeys!)),
            ).join(", ")}. Keys NOT listed may simply have no primary value -- never read the absence as "not translatable".`
          : `M2/§6.6 INCONCLUSIVE for "${type}": no sampled entry reported a translatable key. Check whether the sampled entries have any primary values at all before concluding anything.`,
      );
    }
  }

  // ---- Step 3: write test on a definition (destructive, self-cleaning) -----
  if (wants("write")) {
    report.writeTest = await runWriteTest(call, writeType, definitions);
    if (report.writeTest.verdict) report.verdicts.push(report.writeTest.verdict);
  }

  // ---- Step 4: link + delete test (destructive, opt-in) --------------------
  if (wants("link")) {
    report.linkTest = await runLinkTest(call, writeType, definitions, report.reverseRelationField ?? null);
    if (report.linkTest.verdict) report.verdicts.push(report.linkTest.verdict);
  }

  logger.info("[MetaobjectProbe] run finished", {
    context: "MetaobjectProbe",
    shop: session.shop,
    steps: requestedSteps,
    verdicts: report.verdicts.length,
  });

  return json({ success: true, report });
}

/**
 * V1 + M2: create a throwaway entry of `type`, set its colour field, read it
 * back, delete it. The echo -- not `userErrors: []` -- decides every step.
 */
async function runWriteTest(
  call: (query: string, variables?: Record<string, unknown>) => Promise<GraphQLCallResult>,
  type: string,
  definitions: DefinitionShape[],
): Promise<MetaobjectProbeReport["writeTest"]> {
  const steps: StepOutcome[] = [];
  const leftovers: string[] = [];

  const definition = definitions.find((d) => d.type === type);
  if (!definition) {
    return {
      attempted: false,
      skippedReason: `No definition of type "${type}" in this shop -- the write test needs one that exists. This is not a V1 answer.`,
    };
  }

  // Every REQUIRED field has to carry something Shopify accepts, or the create
  // fails for a reason that says nothing about V1.
  const colourField = definition.fieldDefinitions.find((f) => f.type === "color");
  const seed: Array<{ key: string; value: string }> = [];
  for (const field of definition.fieldDefinitions) {
    if (field.required !== true) continue;
    if (field.type === "color") seed.push({ key: field.key, value: "#123456" });
    else if (field.type === "single_line_text_field" || field.type === "multi_line_text_field") {
      seed.push({ key: field.key, value: "contentpilot probe" });
    } else if (field.type === "list.single_line_text_field") {
      seed.push({ key: field.key, value: JSON.stringify(["contentpilot probe"]) });
    } else {
      return {
        attempted: false,
        skippedReason: `Required field "${field.key}" is of type "${field.type}", which this probe cannot seed. Skipped WITHOUT answering V1.`,
      };
    }
  }

  let createdId: string | null = null;
  try {
    const created = await call(
      `#graphql
        mutation MetaobjectProbeCreate($metaobject: MetaobjectCreateInput!) {
          metaobjectCreate(metaobject: $metaobject) {
            metaobject { id handle type fields { key value type } }
            userErrors { field message code }
          }
        }`,
      { metaobject: { type, fields: seed } },
    );
    const createErrors = created.data?.metaobjectCreate?.userErrors ?? [];
    createdId = created.data?.metaobjectCreate?.metaobject?.id ?? null;
    steps.push({
      step: "metaobjectCreate",
      ok: !!createdId,
      detail: createdId
        ? `id=${createdId} fields=${JSON.stringify(created.data.metaobjectCreate.metaobject.fields)}`
        : describeFailure(created, createErrors),
    });

    if (!createdId) {
      const refused = createErrors.length > 0;
      return {
        attempted: true,
        steps,
        leftovers,
        verdict: refused
          ? `V1 NEGATIVE for "${type}": Shopify REFUSED the create (${createErrors
              .map((e: any) => `${e.code ?? ""} ${e.message}`.trim())
              .join("; ")}). Phase 4 takes the read-only branch (§7.2) for this definition.`
          : `V1 INCONCLUSIVE for "${type}": the call never produced an answer (${describeFailure(created)}). NOT a negative -- re-run.`,
      };
    }

    // Update the colour field, if this definition has one (V1's write half + M2).
    if (colourField) {
      const targetColour = "#0a7f5f";
      const updated = await call(
        `#graphql
          mutation MetaobjectProbeUpdate($id: ID!, $metaobject: MetaobjectUpdateInput!) {
            metaobjectUpdate(id: $id, metaobject: $metaobject) {
              metaobject { id fields { key value type } }
              userErrors { field message code }
            }
          }`,
        { id: createdId, metaobject: { fields: [{ key: colourField.key, value: targetColour }] } },
      );
      const updateErrors = updated.data?.metaobjectUpdate?.userErrors ?? [];
      const echoed = (updated.data?.metaobjectUpdate?.metaobject?.fields ?? []).find(
        (f: any) => f.key === colourField.key,
      );
      const confirmed = (echoed?.value ?? "") === targetColour;
      steps.push({
        step: `metaobjectUpdate (${colourField.key})`,
        ok: confirmed,
        detail: confirmed
          ? `echoed ${JSON.stringify(echoed)} -- the stored format for a color value is exactly what came back`
          : `sent ${targetColour} -> ${describeFailure(updated, updateErrors)} (echo: ${JSON.stringify(echoed ?? null)})`,
      });
    } else {
      steps.push({
        step: "metaobjectUpdate",
        ok: false,
        detail: `definition "${type}" has no field of type color -- the colour half of V1/M2 was not measured`,
      });
    }

    // Fresh read: the update echo can be the mutation's own view.
    const readBack = await call(
      `#graphql
        query MetaobjectProbeRead($id: ID!) {
          metaobject(id: $id) { id handle fields { key value type } }
        }`,
      { id: createdId },
    );
    steps.push({
      step: "read back",
      ok: readBack.ok,
      detail: readBack.ok
        ? JSON.stringify(readBack.data?.metaobject?.fields ?? null)
        : describeFailure(readBack),
    });

    const colourWritten = colourField
      ? (readBack.data?.metaobject?.fields ?? []).some(
          (f: any) => f.key === colourField.key && f.value === "#0a7f5f",
        )
      : false;

    if (!readBack.ok) {
      return {
        attempted: true,
        steps,
        leftovers,
        verdict: `V1 INCONCLUSIVE for "${type}": the entry was created but the read-back failed, so the write half is unknown. Re-run.`,
      };
    }
    if (colourField && !colourWritten) {
      return {
        attempted: true,
        steps,
        leftovers,
        verdict: `V1 PARTIAL for "${type}": creating is allowed, but the colour field did not take the written value. Treat updates on this definition as unconfirmed until re-measured.`,
      };
    }
    return {
      attempted: true,
      steps,
      leftovers,
      verdict: `V1 POSITIVE for "${type}"${
        definition.standard ? " (a Shopify STANDARD definition)" : ""
      }: create${colourField ? " and colour update" : ""} both confirmed by a fresh read. Phase 4 may offer the full editor here.`,
    };
  } finally {
    if (createdId) {
      const deleted = await call(
        `#graphql
          mutation MetaobjectProbeDelete($id: ID!) {
            metaobjectDelete(id: $id) { deletedId userErrors { field message code } }
          }`,
        { id: createdId },
      );
      const deletedId = deleted.data?.metaobjectDelete?.deletedId ?? null;
      steps.push({
        step: "metaobjectDelete (cleanup)",
        ok: !!deletedId,
        detail: deletedId ? `deletedId=${deletedId}` : describeFailure(deleted, deleted.data?.metaobjectDelete?.userErrors),
      });
      // Reported WITH the GID rather than swallowed -- somebody has to go and
      // remove it by hand, and they need to know what.
      if (!deletedId) leftovers.push(createdId);
    }
  }
}

/**
 * V3 + V4 + V5: a throwaway PRODUCT whose colour option is linked to the
 * standard definition, pointed at a throwaway entry.
 *
 * Reads the swatch Shopify derives (V3), the reverse relation if one exists
 * (V4), then deletes the ENTRY while the product still references it and reads
 * the product back (V5). Both throwaways are removed in the `finally`.
 */
async function runLinkTest(
  call: (query: string, variables?: Record<string, unknown>) => Promise<GraphQLCallResult>,
  type: string,
  definitions: DefinitionShape[],
  reverseRelationField: string | null,
): Promise<MetaobjectProbeReport["linkTest"]> {
  const steps: StepOutcome[] = [];
  const leftovers: string[] = [];

  const definition = definitions.find((d) => d.type === type);
  if (!definition) {
    return { attempted: false, skippedReason: `No definition of type "${type}" in this shop.` };
  }
  const colourField = definition.fieldDefinitions.find((f) => f.type === "color");
  const labelField =
    definition.fieldDefinitions.find((f) => f.key === "label") ??
    definition.fieldDefinitions.find((f) => f.type === "single_line_text_field");
  if (!labelField) {
    return {
      attempted: false,
      skippedReason: `Definition "${type}" has no text field to use as the option value name.`,
    };
  }

  let entryId: string | null = null;
  let productId: string | null = null;
  try {
    const fields: Array<{ key: string; value: string }> = [
      { key: labelField.key, value: "ContentPilot Probe Colour" },
    ];
    if (colourField) fields.push({ key: colourField.key, value: "#0a7f5f" });

    const created = await call(
      `#graphql
        mutation MetaobjectProbeLinkCreate($metaobject: MetaobjectCreateInput!) {
          metaobjectCreate(metaobject: $metaobject) {
            metaobject { id handle }
            userErrors { field message code }
          }
        }`,
      { metaobject: { type, fields } },
    );
    entryId = created.data?.metaobjectCreate?.metaobject?.id ?? null;
    steps.push({
      step: "metaobjectCreate (link target)",
      ok: !!entryId,
      detail: entryId ? `id=${entryId}` : describeFailure(created, created.data?.metaobjectCreate?.userErrors),
    });
    if (!entryId) {
      return {
        attempted: true,
        steps,
        leftovers,
        verdict: "V3/V4/V5 NOT MEASURED: the link target could not be created (see step detail). This says nothing about deletion behaviour.",
      };
    }

    // The option is linked through the METAFIELD the definition backs, which is
    // spelled namespace--key. For a standard definition the two are spelled the
    // same, which is exactly the confusion Phase 5 exists to fix -- so the
    // namespace/key are split from the type rather than assumed.
    const [metafieldNamespace, metafieldKey] = type.includes("--")
      ? [type.split("--")[0], type.split("--").slice(1).join("--")]
      : ["custom", type];

    // Two steps rather than one `productCreate` carrying `productOptions`:
    // PRODUCT_OPTIONS_CREATE is the shape this app already runs in production
    // against linked options, so a rejection here is about the LINK and not
    // about a payload nobody has ever sent.
    const productCreated = await call(
      `#graphql
        mutation MetaobjectProbeProductCreate($product: ProductCreateInput!) {
          productCreate(product: $product) {
            product { id title }
            userErrors { field message }
          }
        }`,
      { product: { title: "ContentPilot probe product (delete me)", status: "DRAFT" } },
    );
    productId = productCreated.data?.productCreate?.product?.id ?? null;
    steps.push({
      step: "productCreate",
      ok: !!productId,
      detail: productId
        ? `id=${productId}`
        : describeFailure(productCreated, productCreated.data?.productCreate?.userErrors),
    });
    if (!productId) {
      return {
        attempted: true,
        steps,
        leftovers,
        verdict:
          "V3/V5 NOT MEASURED: the throwaway product could not be created, so nothing was linked. Not a statement about swatches or deletion.",
      };
    }

    const optionCreated = await call(
      `#graphql
        mutation MetaobjectProbeOptionCreate($productId: ID!, $options: [OptionCreateInput!]!) {
          productOptionsCreate(productId: $productId, options: $options, variantStrategy: CREATE) {
            product {
              id
              options {
                id
                name
                linkedMetafield { namespace key }
                optionValues { id name linkedMetafieldValue swatch { color image { image { url } } } }
              }
              variants(first: 10) { nodes { id title } }
            }
            userErrors { field message }
          }
        }`,
      {
        productId,
        options: [
          {
            name: "Colour",
            linkedMetafield: { namespace: metafieldNamespace, key: metafieldKey, values: [entryId] },
          },
        ],
      },
    );
    const optionErrors = optionCreated.data?.productOptionsCreate?.userErrors ?? [];
    const linkedProduct = optionCreated.data?.productOptionsCreate?.product ?? null;
    steps.push({
      step: "productOptionsCreate (linked option)",
      ok: !!linkedProduct && optionErrors.length === 0,
      detail: linkedProduct
        ? JSON.stringify(linkedProduct.options)
        : describeFailure(optionCreated, optionErrors),
    });
    if (!linkedProduct || optionErrors.length > 0) {
      return {
        attempted: true,
        steps,
        leftovers,
        verdict:
          "V3/V5 NOT MEASURED: the option could not be linked to the metaobject entry, so nothing referenced it. Not a statement about swatches or deletion.",
      };
    }

    // V3: is the swatch DERIVED from the entry's colour field?
    const optionValues = linkedProduct.options?.[0]?.optionValues ?? [];
    const swatch = optionValues[0]?.swatch ?? null;
    const swatchMatches = colourField ? swatch?.color?.toLowerCase() === "#0a7f5f" : false;
    steps.push({
      step: "read swatch (V3)",
      ok: !!swatch,
      detail: `swatch=${JSON.stringify(swatch)} linkedMetafieldValue=${optionValues[0]?.linkedMetafieldValue ?? "null"}`,
    });

    // V4: the reverse relation, if introspection found one.
    if (reverseRelationField) {
      const reverse = await call(
        `#graphql
          query MetaobjectProbeReverse($id: ID!) {
            metaobject(id: $id) {
              id
              ${reverseRelationField}(first: 10) { nodes { __typename } }
            }
          }`,
        { id: entryId },
      );
      steps.push({
        step: `Metaobject.${reverseRelationField} (V4)`,
        ok: reverse.ok,
        detail: reverse.ok ? JSON.stringify(reverse.data?.metaobject ?? null) : describeFailure(reverse),
      });
    } else {
      steps.push({
        step: "reverse relation (V4)",
        ok: false,
        detail: "introspection found no candidate field -- usage stays a cache question",
      });
    }

    // V5: delete the entry WHILE the product still points at it.
    const deleted = await call(
      `#graphql
        mutation MetaobjectProbeLinkDelete($id: ID!) {
          metaobjectDelete(id: $id) { deletedId userErrors { field message code } }
        }`,
      { id: entryId },
    );
    const deletedId = deleted.data?.metaobjectDelete?.deletedId ?? null;
    const deleteErrors = deleted.data?.metaobjectDelete?.userErrors ?? [];
    steps.push({
      step: "metaobjectDelete on a LINKED entry (V5)",
      ok: !!deletedId,
      detail: deletedId ? `deletedId=${deletedId}` : describeFailure(deleted, deleteErrors),
    });
    if (deletedId) entryId = null;

    // V5's actual answer is in the product, not the mutation.
    const productAfter = await call(
      `#graphql
        query MetaobjectProbeProductAfter($id: ID!) {
          product(id: $id) {
            id
            options { id name optionValues { id name linkedMetafieldValue swatch { color } } }
            variants(first: 10) { nodes { id title } }
          }
        }`,
      { id: productId },
    );
    steps.push({
      step: "read product after delete (V5)",
      ok: productAfter.ok,
      detail: productAfter.ok ? JSON.stringify(productAfter.data?.product ?? null) : describeFailure(productAfter),
    });

    if (!productAfter.ok) {
      return {
        attempted: true,
        steps,
        leftovers,
        verdict:
          "V5 INCONCLUSIVE: the product read-back after the delete failed, so the consequence is unknown. Until re-measured the UI keeps assuming the worst case (variants are lost).",
      };
    }

    const valuesAfter = productAfter.data?.product?.options?.[0]?.optionValues ?? [];
    const variantsAfter = productAfter.data?.product?.variants?.nodes ?? [];
    const v3 = colourField
      ? swatchMatches
        ? "V3 POSITIVE: the option value's swatch carries the colour written into the metaobject field -- editing the field moves the storefront swatch."
        : `V3 NEGATIVE or DELAYED: the swatch read back as ${JSON.stringify(
            swatch,
          )} while the entry's colour field was #0a7f5f. Do not promise the merchant that editing the field changes the storefront swatch until this is re-measured.`
      : "V3 NOT MEASURED: this definition has no color field.";

    if (!deletedId && deleteErrors.length > 0) {
      return {
        attempted: true,
        steps,
        leftovers,
        verdict: `${v3} || V5 = (a) REFUSED: Shopify declines to delete an entry a product still uses (${deleteErrors
          .map((e: any) => e.message)
          .join("; ")}). The UI may offer the button and surface the refusal.`,
      };
    }
    if (deletedId && valuesAfter.length === 0) {
      return {
        attempted: true,
        steps,
        leftovers,
        verdict: `${v3} || V5 = (b) CASCADE: the entry was deleted and the option value went with it (${variantsAfter.length} variants left). Deleting a used entry destroys variants -- keep the button LOCKED while usage > 0.`,
      };
    }
    if (deletedId) {
      return {
        attempted: true,
        steps,
        leftovers,
        verdict: `${v3} || V5 = (c) DEAD REFERENCE: the entry is gone but the option still lists ${valuesAfter.length} value(s) (${JSON.stringify(
          valuesAfter,
        )}). Warn and recommend fixing the product, do not lock.`,
      };
    }
    return {
      attempted: true,
      steps,
      leftovers,
      verdict: `${v3} || V5 INCONCLUSIVE: the delete produced neither a deletedId nor a userError. Treat as unmeasured.`,
    };
  } finally {
    if (entryId) {
      const cleanup = await call(
        `#graphql
          mutation MetaobjectProbeCleanupEntry($id: ID!) {
            metaobjectDelete(id: $id) { deletedId userErrors { message } }
          }`,
        { id: entryId },
      );
      if (!cleanup.data?.metaobjectDelete?.deletedId) leftovers.push(entryId);
    }
    if (productId) {
      const cleanup = await call(
        `#graphql
          mutation MetaobjectProbeCleanupProduct($input: ProductDeleteInput!) {
            productDelete(input: $input) { deletedProductId userErrors { message } }
          }`,
        { input: { id: productId } },
      );
      const gone = cleanup.data?.productDelete?.deletedProductId;
      steps.push({
        step: "productDelete (cleanup)",
        ok: !!gone,
        detail: gone ? `deletedProductId=${gone}` : describeFailure(cleanup, cleanup.data?.productDelete?.userErrors),
      });
      if (!gone) leftovers.push(productId);
    }
  }
}
