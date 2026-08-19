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

/** Unwraps NON_NULL/LIST wrappers to the named type. `nodes` is `[T!]!`, i.e.
 *  four levels deep — unwrapping too few is how step 2b first shipped blind. */
function namedTypeOf(ref: any): string | undefined {
  let cursor = ref;
  for (let depth = 0; cursor && depth < 6; depth++) {
    if (cursor.name) return cursor.name as string;
    cursor = cursor.ofType;
  }
  return undefined;
}

/** The KIND of the named type behind any wrappers — SCALAR/ENUM need no
 *  sub-selection, everything else does. */
function leafKindOf(ref: any): string | undefined {
  let cursor = ref;
  for (let depth = 0; cursor && depth < 6; depth++) {
    if (cursor.name) return cursor.kind as string;
    cursor = cursor.ofType;
  }
  return undefined;
}

/**
 * A selection set that asks a node for everything it can answer WITHOUT the
 * probe knowing its schema.
 *
 * Scalars and enums go in bare; an OBJECT, UNION or INTERFACE goes in as
 * `field { __typename }`, which is valid for every composite type. That second
 * half is the point: on `MetafieldRelation` the field that names the
 * referencing PRODUCT is `referencer`, an object — a scalar-only selection
 * leaves out exactly the thing a usage count needs and then reports that the
 * question was answered.
 *
 * A field with a REQUIRED argument is skipped: selecting it without one is a
 * hard error that `isSelectionError` does not recognise, so a single such
 * field would make a working connection read as "shape not measured".
 */
function liveNodeSelection(
  fields: Array<{ name: string; type: unknown; args?: Array<{ name: string; type: unknown }> }>,
): { full: string; scalars: string; composites: string[] } {
  const scalars: string[] = [];
  const composites: string[] = [];
  for (const field of fields) {
    const needsArgument = (field.args ?? []).some((a) => leafKindOf(a.type) !== undefined && isRequiredArg(a.type));
    if (needsArgument) continue;
    const kind = leafKindOf(field.type);
    if (kind === "SCALAR" || kind === "ENUM") scalars.push(field.name);
    else if (kind === "OBJECT" || kind === "UNION" || kind === "INTERFACE") {
      composites.push(`${field.name} { __typename }`);
    }
  }
  // The pieces are returned SEPARATELY, not re-derived from `full` by regex.
  // They were, and the pattern that split them treated `referencer` (a name
  // followed by a space, then a brace) as a scalar -- so the scalars-only
  // candidate selected a composite field bare and could only ever error.
  return {
    full: ["__typename", ...scalars, ...composites].join(" "),
    scalars: ["__typename", ...scalars].join(" "),
    composites,
  };
}

/** NON_NULL at the OUTERMOST level means the argument has to be supplied. */
function isRequiredArg(ref: any): boolean {
  return ref?.kind === "NON_NULL";
}

/** Enough introspection wrappers for `[T!]!` and one to spare. */
const TYPE_REF_FRAGMENT = `#graphql
  fragment TypeRef on __Type {
    kind
    name
    ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
  }`;

/**
 * Did the SERVER reject the selection, or did we simply not get an answer?
 *
 * Only the first justifies concluding anything about the schema's shape. A
 * throttled call that is read as "this connection has no `nodes`" would record
 * an outage as a measurement.
 */
function isSelectionError(res: GraphQLCallResult): boolean {
  if (res.networkError) return false;
  return (res.errors ?? []).some((e) =>
    /doesn't exist on type|Field '[^']+' doesn't exist|Cannot query field|didn't exist|is not defined on/i.test(
      e.message ?? "",
    ),
  );
}

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
  fieldDefinitions: Array<{
    key: string;
    name?: string;
    type: string;
    required?: boolean;
    /**
     * PLAN_METAOBJECT_TAXONOMY_CREATE T2. The sync has queried and stored these
     * since Phase 0 of the content-creation plan and nothing has ever read
     * them; a `product_taxonomy_value_reference` presumably names the ATTRIBUTE
     * whose values it accepts right here. Printing them costs one selection.
     */
    validations?: Array<{ name: string; value: string | null }>;
  }>;
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
  /**
   * The reverse relation's SHAPE (step 2b). Its NAME being present is not
   * enough to write a usage query against it: whether it pages through `nodes`
   * or `edges`, what the node type is, and whether the connection can report a
   * COUNT without paging all decide whether a live cross-check is one cheap
   * call or an unbounded sweep. Absent when the step was not requested.
   */
  reverseRelation?: {
    connectionType?: string;
    connectionFields?: string[];
    nodeType?: string;
    nodeFields?: string[];
    /** A live run against a real entry — the only thing that proves it works. */
    liveShape?: "nodes" | "edges";
    liveSample?: string;
    /** The selection the live run used — reused by the link test's own V4 step. */
    nodeSelection?: string;
    error?: string;
  };
  /** PLAN_METAOBJECT_TAXONOMY_CREATE Phase 0 (T1-T3). */
  taxonomy?: {
    /** What the `Taxonomy` root offers, if the type exists at all. */
    taxonomyFields?: string[];
    /** Shape of the value type the metaobject fields reference. */
    valueTypeFields?: string[];
    /** GIDs read off real entries, resolved to a __typename and a name. */
    resolvedValues?: Array<{ gid: string; typename?: string; label?: string; error?: string }>;
    /** The attribute HANDLE each taxonomy field names in its validations. */
    attributeHandles?: Array<{ fieldKey: string; handle: string; min?: string; max?: string }>;
    /** What a category offers — the only door the Taxonomy root has. */
    categoryFields?: string[];
    attributeTypeFields?: string[];
    /** Where the permitted values were found, and how many there are. */
    valueSource?: string;
    valueCount?: number;
    valueSample?: string[];
    /** A full page — the true count is "this or more", never invented. */
    valuesTruncated?: boolean;
    steps: StepOutcome[];
  };

  /** Results of the leftover cleanup step, when it was asked for. */
  cleanup?: StepOutcome[];
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
    validations: Array.isArray(f?.validations)
      ? f.validations.map((v: any) => ({ name: v?.name ?? "", value: v?.value ?? null }))
      : undefined,
  }));
}


/**
 * The NODE type behind a connection type name.
 *
 * `nodes` is `[T!]!` and `edges` is `[Edge!]!` with the node one hop further
 * in, so reading either without unwrapping reports the connection or the edge
 * as the node. Both mistakes have already been made in this file once each.
 * Returns `null` when the question could not be answered — never a guess.
 */
async function connectionNodeType(
  call: (query: string, variables?: Record<string, unknown>) => Promise<GraphQLCallResult>,
  connectionType: string,
): Promise<{ nodeType: string | null; carrier: "nodes" | "edges" | null; error?: string }> {
  const res = await call(
    `#graphql
      query MetaobjectProbeConnectionNode($name: String!) {
        __type(name: $name) { fields(includeDeprecated: true) { name type { ...TypeRef } } }
      }
      ${TYPE_REF_FRAGMENT}`,
    { name: connectionType },
  );
  if (!res.ok) return { nodeType: null, carrier: null, error: describeFailure(res) };
  const fields = res.data?.__type?.fields;
  if (!fields) return { nodeType: null, carrier: null, error: "the API answered and the type is not there" };

  const nodesField = fields.find((f: any) => f.name === "nodes");
  if (nodesField) return { nodeType: namedTypeOf(nodesField.type) ?? null, carrier: "nodes" };

  const edgeType = namedTypeOf(fields.find((f: any) => f.name === "edges")?.type);
  if (!edgeType) return { nodeType: null, carrier: null, error: "connection carries neither nodes nor edges" };
  const edgeRes = await call(
    `#graphql
      query MetaobjectProbeEdgeNode($name: String!) {
        __type(name: $name) { fields(includeDeprecated: true) { name type { ...TypeRef } } }
      }
      ${TYPE_REF_FRAGMENT}`,
    { name: edgeType },
  );
  if (!edgeRes.ok) return { nodeType: null, carrier: "edges", error: describeFailure(edgeRes) };
  const nodeField = (edgeRes.data?.__type?.fields ?? []).find((f: any) => f.name === "node");
  return { nodeType: namedTypeOf(nodeField?.type) ?? null, carrier: "edges" };
}

/**
 * A selection over a possibly-POLYMORPHIC node.
 *
 * An object type contributes its own selectable fields; a union or interface
 * contributes one inline fragment per member, each with that member's own
 * fields. Nothing is hardcoded: a member name or a field this probe invented
 * would be rejected as a whole document, and the step that can answer T1 would
 * report "no such API" about one that works.
 */
function polymorphicSelection(
  shape: { kind?: string; fields?: Array<{ name: string; type: unknown; args?: Array<{ name: string; type: unknown }> }>; possibleTypes?: Array<{ name: string; fields?: Array<{ name: string; type: unknown; args?: Array<{ name: string; type: unknown }> }> }> },
  /**
   * Field names to leave OUT.
   *
   * A connection field selected without arguments is refused by Shopify at
   * runtime ("provide first or last"), and selecting the same field twice with
   * different arguments is refused by GraphQL's field-merging rule before that
   * — so an expensive sub-connection is not squeezed in here. It is fetched by
   * its own id in a second call instead, which is also the only way to stay
   * inside the query-cost budget.
   */
  omit: string[] = [],
): string {
  const forFields = (fields: Array<{ name: string; type: unknown; args?: Array<{ name: string; type: unknown }> }>) =>
    liveNodeSelection(fields.filter((f) => !omit.includes(f.name))).full;

  if (shape.possibleTypes?.length) {
    const members = shape.possibleTypes
      .filter((m) => m.fields?.length)
      .map((m) => `... on ${m.name} { ${forFields(m.fields!)} }`);
    return ["__typename", ...members].join(" ");
  }
  return forFields(shape.fields ?? []);
}

/** Wraps a node selection in whatever carrier the connection was measured to
 *  have. Hardcoding `nodes` would generate a document the schema rejects on an
 *  edges-only connection, and report that as "no such path". */
function carrierSelection(carrier: "nodes" | "edges" | null, selection: string): string {
  return carrier === "edges" ? `edges { node { ${selection} } }` : `nodes { ${selection} }`;
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
  /** GIDs an earlier run left behind, to be removed now. */
  const cleanupIds = String(formData?.get("cleanupIds") ?? "")
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter((v) => v.startsWith("gid://shopify/"))
    .slice(0, 25);

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
  if (wants("definitions") || wants("samples") || wants("write") || wants("link") || wants("taxonomy")) {
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
              fieldDefinitions { key name required type { name } validations { name value } }
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

  // ---- Step 2b: the reverse relation's SHAPE (read-only, V4) ---------------
  // Measured 2026-08-18: `Metaobject.referencedBy` EXISTS. That answers half of
  // V4 and none of the half the delete path needs -- a usage query cannot be
  // written against a field whose connection shape and node type are unknown,
  // and guessing them is exactly what this probe exists to replace. Read-only,
  // so it runs without the destructive steps.
  //
  // The field NAME comes from the same introspection step 1b does, so this step
  // runs it itself when asked for on its own: the route takes a direct POST and
  // `steps=references` alone must not silently measure nothing.
  if (wants("references")) {
    const shape: NonNullable<MetaobjectProbeReport["reverseRelation"]> = {};
    /** The selections the live run may ask the node for, widest first.
     *  `__typename` alone until the node type has been introspected. */
    let selections: { full: string; scalars: string; composites: string[] } = {
      full: "__typename",
      scalars: "__typename",
      composites: [],
    };
    /** Appends rather than overwrites: an early failure explains a later one. */
    const noteError = (message: string) => {
      shape.error = shape.error ? `${shape.error} | ${message}` : message;
    };

    let field = report.reverseRelationField ?? null;
    if (!field) {
      const names = await call(
        `#graphql
          query MetaobjectProbeReverseName {
            __type(name: "Metaobject") { fields(includeDeprecated: true) { name } }
          }`,
      );
      if (names.ok) {
        const list: string[] = (names.data?.__type?.fields ?? []).map((f: any) => f.name);
        field = CANDIDATE_REVERSE_FIELDS.find((c) => list.includes(c)) ?? null;
        report.metaobjectTypeFields ??= list;
        report.reverseRelationField ??= field;
      } else {
        noteError(`field lookup: ${describeFailure(names)}`);
      }
    }

    if (!field) {
      report.reverseRelation = shape;
      report.verdicts.push(
        `V4 SHAPE NOT MEASURED: ${shape.error ?? "Metaobject exposes none of " + CANDIDATE_REVERSE_FIELDS.join(", ")}.`,
      );
    } else {
      // FOUR wrapper levels, not three: `nodes` is `[T!]!`, i.e.
      // NON_NULL -> LIST -> NON_NULL -> OBJECT. Unwrapping one level too few
      // leaves the node type undefined and makes this whole step report
      // nothing, which is how it shipped the first time.
      const connection = await call(
        `#graphql
          query MetaobjectProbeReverseShape {
            __type(name: "Metaobject") {
              fields(includeDeprecated: true) {
                name
                type { ...TypeRef }
              }
            }
          }
          ${TYPE_REF_FRAGMENT}`,
      );
      if (!connection.ok) {
        noteError(`connection lookup: ${describeFailure(connection)}`);
      } else {
        const node = (connection.data?.__type?.fields ?? []).find((f: any) => f.name === field);
        shape.connectionType = namedTypeOf(node?.type);
      }

      if (shape.connectionType) {
        const inner = await call(
          `#graphql
            query MetaobjectProbeConnectionShape($name: String!) {
              __type(name: $name) {
                fields(includeDeprecated: true) {
                  name
                  type { ...TypeRef }
                }
              }
            }
            ${TYPE_REF_FRAGMENT}`,
          { name: shape.connectionType },
        );
        if (inner.ok) {
          const fields = inner.data?.__type?.fields ?? [];
          shape.connectionFields = fields.map((f: any) => f.name);
          // `nodes` FIRST, explicitly. A plain `find` over both names takes
          // whichever the schema lists earlier, and on
          // MetafieldRelationConnection that is `edges` — which made run 2
          // report the EDGE type (MetafieldRelationEdge, fields `cursor, node`)
          // as the node type.
          const nodesField = fields.find((f: any) => f.name === "nodes");
          if (nodesField) {
            shape.nodeType = namedTypeOf(nodesField.type);
          } else {
            // An edges-ONLY connection: the element of `edges` is the EDGE, and
            // the node is one hop further in. Reading the edge as the node
            // would build `edges { node { cursor } }`, which errors, and a
            // perfectly good connection would be reported as unmeasurable.
            const edgeType = namedTypeOf(fields.find((f: any) => f.name === "edges")?.type);
            if (edgeType) {
              const edgeShape = await call(
                `#graphql
                  query MetaobjectProbeEdgeShape($name: String!) {
                    __type(name: $name) {
                      fields(includeDeprecated: true) { name type { ...TypeRef } }
                    }
                  }
                  ${TYPE_REF_FRAGMENT}`,
                { name: edgeType },
              );
              if (edgeShape.ok) {
                shape.nodeType = namedTypeOf(
                  (edgeShape.data?.__type?.fields ?? []).find((f: any) => f.name === "node")?.type,
                );
              } else {
                noteError(`edge shape: ${describeFailure(edgeShape)}`);
              }
            }
          }
        } else {
          noteError(`connection fields: ${describeFailure(inner)}`);
        }
      }

      if (shape.nodeType) {
        const nodeShape = await call(
          `#graphql
            query MetaobjectProbeNodeShape($name: String!) {
              __type(name: $name) {
                kind
                fields(includeDeprecated: true) {
                  name
                  type { ...TypeRef }
                  args { name type { ...TypeRef } }
                }
                possibleTypes { name }
              }
            }
            ${TYPE_REF_FRAGMENT}`,
          { name: shape.nodeType },
        );
        if (nodeShape.ok) {
          const t = nodeShape.data?.__type;
          // A UNION (which a "referenced by" node plausibly is) has no fields
          // and lists its members instead. Both are reported; an empty answer
          // is left empty rather than dressed up as the other one.
          const fields: Array<{ name: string; type: unknown; args?: Array<{ name: string; type: unknown }> }> =
            t?.fields ?? [];
          shape.nodeFields =
            fields.length > 0
              ? fields.map((f) => f.name)
              : (t?.possibleTypes ?? []).map((f: any) => f.name);
          // What the live run may ask for. Run 2 selected only `__typename` and
          // therefore could not say whether a relation names the PRODUCT that
          // uses the entry — which is the only thing a usage count needs.
          if (fields.length > 0) selections = liveNodeSelection(fields);
        } else {
          // A failed call is not "this type has no fields" -- without this the
          // report simply omits the line and "not measured" reads as "none".
          noteError(`node shape: ${describeFailure(nodeShape)}`);
        }
      }

      // A LIVE run is the only thing that proves the shape is usable.
      const sample = await call(
        `#graphql
          query MetaobjectProbeReferenceSample($type: String!) {
            metaobjects(type: $type, first: 1) { nodes { id displayName } }
          }`,
        { type: sampleType || STANDARD_COLOUR_TYPE },
      );
      const sampleId = sample.data?.metaobjects?.nodes?.[0]?.id ?? null;
      if (!sample.ok) {
        // Rule 1 of this file's header: a failed call is not a negative answer.
        // Reported as "we could not ask", never as "that type has no entries".
        noteError(`sample lookup: ${describeFailure(sample)}`);
      } else if (!sampleId) {
        noteError(`no entry of type "${sampleType || STANDARD_COLOUR_TYPE}" to run it against`);
      } else {
        // Selections in DECREASING ambition, run against `nodes` and, if the
        // connection rejects that field itself, against `edges`.
        //
        // Run 3 measured why the ladder is needed: the widest selection
        // ("__typename key name namespace referencer { __typename }
        // target { __typename }") came back "Metafield reference target could
        // not be retrieved" -- a RESOLVER failure on ONE field, not a statement
        // about the shape -- while a bare `__typename` run had worked in the
        // run before. Giving up there reported "the form does not exist" about
        // a connection that demonstrably does. Each composite is therefore also
        // tried on its own, so one unresolvable field cannot hide the rest:
        // `referencer` is the one the usage question actually needs.
        // Ordered by what each candidate ANSWERS, not by how much it asks. The
        // composites come before the scalars-only fallback: `referencer` is the
        // whole point of the step, and a scalars-only candidate that resolves
        // would otherwise stop the ladder one rung short and report "V4 SHAPE
        // MEASURED" without the field V4 is about — and hand that same
        // selection to the expensive link test.
        const candidates = [
          selections.full,
          ...selections.composites.map((composite) => `__typename ${composite}`),
          ...(selections.composites.length > 0 ? [selections.scalars] : []),
          "__typename",
        ].filter((c, i, all) => all.indexOf(c) === i);

        /** Why the WIDEST selection failed — kept separate, because a later
         *  candidate's throttle must not be reported as its reason. */
        let widestFailure: string | null = null;

        const runLadder = async (via: "nodes" | "edges"): Promise<GraphQLCallResult | null> => {
          let last: GraphQLCallResult | null = null;
          for (const candidate of candidates) {
            const body = via === "nodes" ? `nodes { ${candidate} }` : `edges { node { ${candidate} } }`;
            const attempt = await call(
              `#graphql
                query MetaobjectProbeReferencedBy($id: ID!) {
                  metaobject(id: $id) {
                    id
                    ${field}(first: 5) { ${body} }
                  }
                }`,
              { id: sampleId },
            );
            if (attempt.ok) {
              shape.liveShape = via;
              shape.nodeSelection = candidate;
              shape.liveSample = JSON.stringify(attempt.data?.metaobject ?? null).slice(0, 600);
              if (candidate !== selections.full && widestFailure) {
                noteError(`the full selection "${selections.full}" failed (${widestFailure}); "${candidate}" answered instead`);
              }
              return attempt;
            }
            if (candidate === selections.full) widestFailure = describeFailure(attempt);
            last = attempt;
          }
          return last;
        };

        const nodesResult = await runLadder("nodes");
        if (!shape.liveShape) {
          // Only a rejected SELECTION justifies trying the other carrier. Any
          // other failure (throttling, network) says nothing about whether this
          // connection uses `nodes` -- concluding "edges" from an outage would
          // record the outage as a shape.
          if (nodesResult && isSelectionError(nodesResult)) {
            const edgesResult = await runLadder("edges");
            if (!shape.liveShape) {
              noteError(
                `nodes: ${describeFailure(nodesResult)} | edges: ${edgesResult ? describeFailure(edgesResult) : "not attempted"}`,
              );
            }
          } else if (nodesResult) {
            noteError(`live run: ${describeFailure(nodesResult)}`);
          }
        }
      }

      // Whatever actually answered — not what was attempted first. The link
      // test reuses this, and reusing a selection that is known to fail would
      // waste the one run with a self-created referencing product.
      shape.nodeSelection ??= selections.full;
      report.reverseRelation = shape;
      report.verdicts.push(
        shape.liveShape
          ? `V4 SHAPE MEASURED: Metaobject.${field} pages through \`${shape.liveShape}\` of ${
              shape.nodeType ?? "an unnamed type"
            }; connection fields: ${(shape.connectionFields ?? []).join(", ") || "unknown"}. A live usage cross-check can be written against this${
              (shape.connectionFields ?? []).some((f) => /count/i.test(f))
                ? " and the connection reports a COUNT, so it needs no paging."
                : " -- but the connection reports NO count field, so counting means paging, which is why the cache stays the primary source."
            }`
          : `V4 SHAPE NOT MEASURED: ${shape.error ?? "the live run produced no answer"}. The name exists; the form does not, so no usage query is written against it.`,
      );
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

  // ---- Taxonomy: can the permitted values be reached at all? (T1-T3) ------
  // PLAN_METAOBJECT_TAXONOMY_CREATE Phase 0. `shopify--color-pattern` cannot be
  // CREATED from this app because two of its required fields are
  // `product_taxonomy_value_reference`, and there is no editor for that type.
  // Whether one can be BUILT hangs on a question nobody has asked: is there an
  // API that lists the permitted values? Everything here is read-only.
  //
  // The chain is data-driven, not guessed: the definition's own `validations`
  // say which attribute a field accepts, a real entry's stored GIDs say what a
  // value looks like, and introspection says what can be selected on it. A
  // guessed field name would answer "no such API" about one that exists.
  if (wants("taxonomy")) {
    const steps: StepOutcome[] = [];
    const tax: NonNullable<MetaobjectProbeReport["taxonomy"]> = { steps };
    const definition = definitions.find((d) => d.type === (sampleType || STANDARD_COLOUR_TYPE));

    // 1. What does the Taxonomy root offer? MISSING and ERROR stay apart: a
    //    throttled introspection must not be read as "there is no taxonomy".
    const root = await call(
      `#graphql
        query MetaobjectProbeTaxonomyRoot {
          __type(name: "Taxonomy") { fields(includeDeprecated: true) { name args { name } } }
        }`,
    );
    if (root.ok) {
      const fields = root.data?.__type?.fields;
      if (!fields) {
        steps.push({ step: "__type(Taxonomy)", ok: false, detail: "the API answered and the type is not there" });
      } else {
        const named = fields.map((f: any) => `${f.name}(${(f.args ?? []).map((a: any) => a.name).join(",")})`);
        tax.taxonomyFields = named;
        steps.push({ step: "__type(Taxonomy)", ok: true, detail: named.join(" | ") });
      }
    } else {
      steps.push({ step: "__type(Taxonomy)", ok: false, detail: describeFailure(root) });
    }

    // 2. The validations of the taxonomy-reference fields — T2, out of data
    //    the sync has stored all along and nothing has ever read.
    const taxonomyFieldDefs = (definition?.fieldDefinitions ?? []).filter((f) =>
      f.type.includes("product_taxonomy_value_reference"),
    );
    steps.push({
      step: "field validations (T2)",
      ok: taxonomyFieldDefs.length > 0,
      detail:
        taxonomyFieldDefs.length > 0
          ? taxonomyFieldDefs
              .map((f) => `${f.key}: ${JSON.stringify(f.validations ?? "none reported")}`)
              .join(" | ")
          : `no taxonomy-reference field on "${sampleType || STANDARD_COLOUR_TYPE}"`,
    });

    // 3. Resolve the GIDs a real ENTRY holds. Only that source: the validations
    //    name the attribute by a HANDLE (measured, see above), so there is no
    //    GID in them to resolve. Reading a stored value back is what proves a
    //    picker could ever display the current value instead of a raw GID.
    // MEASURED (run 5): the validation names the attribute by a stable HANDLE
    // -- `product_taxonomy_attribute_handle = "color"` -- not by a GID. The
    // first cut looked for a GID and therefore reported "the validations
    // carried none" about a validation that carried exactly the right thing,
    // in a better form: a handle survives a shop, a GID would not have to.
    // `list.min` / `list.max` come along because they are a REQUIREMENT of the
    // create form (colour accepts 1 to 4 values), not decoration.
    tax.attributeHandles = taxonomyFieldDefs.map((f) => {
      const byName = (name: string) => f.validations?.find((v) => v.name === name)?.value ?? undefined;
      return {
        fieldKey: f.key,
        handle: byName("product_taxonomy_attribute_handle") ?? "",
        min: byName("list.min"),
        max: byName("list.max"),
      };
    });
    steps.push({
      step: "attribute handles (T2)",
      ok: tax.attributeHandles.some((h) => h.handle !== ""),
      detail: tax.attributeHandles
        .map((h) => `${h.fieldKey} -> ${h.handle || "(none)"}${h.min || h.max ? ` [${h.min ?? "?"}..${h.max ?? "?"}]` : ""}`)
        .join(" | "),
    });

    const entries = await call(
      `#graphql
        query MetaobjectProbeTaxonomySample($type: String!, $first: Int!) {
          metaobjects(type: $type, first: $first) { nodes { fields { key value } } }
        }`,
      { type: sampleType || STANDARD_COLOUR_TYPE, first: 10 },
    );
    const gidsFromEntries = entries.ok
      ? ((entries.data?.metaobjects?.nodes ?? []) as Array<{ fields?: Array<{ key: string; value: string | null }> }>)
          .flatMap((n) => n.fields ?? [])
          .filter((f) => taxonomyFieldDefs.some((t) => t.key === f.key))
          .flatMap((f) => {
            const raw = f.value ?? "";
            try {
              const parsed: unknown = JSON.parse(raw);
              return Array.isArray(parsed) ? parsed.map(String) : [raw];
            } catch {
              return [raw];
            }
          })
          .filter((v) => v.startsWith("gid://shopify/"))
      : [];
    if (!entries.ok) steps.push({ step: "read stored values", ok: false, detail: describeFailure(entries) });

    const gids = [...new Set(gidsFromEntries)].slice(0, 10);
    if (gids.length > 0) {
      // `nodes(ids:)` with __typename only: the concrete type is the ANSWER,
      // and asking for a name before knowing the type is how a probe reports
      // "does not exist" about a field on a type it guessed wrong.
      const typed = await call(
        `#graphql
          query MetaobjectProbeTaxonomyTypes($ids: [ID!]!) {
            nodes(ids: $ids) { __typename id }
          }`,
        { ids: gids },
      );
      if (!typed.ok) {
        tax.resolvedValues = gids.map((gid) => ({ gid, error: describeFailure(typed) }));
        steps.push({ step: "nodes(ids:) __typename", ok: false, detail: describeFailure(typed) });
      } else {
        const nodes = (typed.data?.nodes ?? []) as Array<{ __typename?: string; id?: string } | null>;
        tax.resolvedValues = gids.map((gid) => ({
          gid,
          typename: nodes.find((n) => n?.id === gid)?.__typename,
        }));
        steps.push({
          step: "nodes(ids:) __typename",
          ok: true,
          detail: JSON.stringify(tax.resolvedValues),
        });

        // 4. What can be SELECTED on that type — the picker's label problem.
        const valueType = tax.resolvedValues.find((r) => r.typename)?.typename;
        if (valueType) {
          const shape = await call(
            `#graphql
              query MetaobjectProbeTaxonomyValueShape($name: String!) {
                __type(name: $name) {
                  fields(includeDeprecated: true) { name type { ...TypeRef } args { name type { ...TypeRef } } }
                }
              }
              ${TYPE_REF_FRAGMENT}`,
            { name: valueType },
          );
          if (shape.ok && shape.data?.__type?.fields) {
            const fields = shape.data.__type.fields as Array<{ name: string; type: unknown; args?: Array<{ name: string; type: unknown }> }>;
            tax.valueTypeFields = fields.map((f) => f.name);
            steps.push({ step: `__type(${valueType})`, ok: true, detail: tax.valueTypeFields.join(", ") });

            // Read the LABEL of one value. Same descent as the referencedBy
            // step: a selection the server rejects is a shape answer, anything
            // else is an outage and must not be reported as one.
            const selection = liveNodeSelection(fields);
            const labelCandidates = [selection.full, selection.scalars, "__typename id"].filter(
              (c, i, all) => all.indexOf(c) === i,
            );
            let labelled = false;
            for (const candidate of labelCandidates) {
              const attempt = await call(
                `#graphql
                  query MetaobjectProbeTaxonomyLabels($ids: [ID!]!) {
                    nodes(ids: $ids) { __typename ... on ${valueType} { ${candidate} } }
                  }`,
                { ids: gids },
              );
              if (attempt.ok) {
                labelled = true;
                steps.push({
                  step: `resolve labels (${candidate === selection.full ? "full" : "reduced"})`,
                  ok: true,
                  detail: JSON.stringify(attempt.data?.nodes ?? null).slice(0, 600),
                });
                break;
              }
              // Only a rejected SELECTION justifies trying a narrower one. Any
              // other failure is an outage, and walking past it would let a
              // throttle be reported as "this type has no such fields".
              if (!isSelectionError(attempt)) {
                steps.push({ step: "resolve labels", ok: false, detail: describeFailure(attempt) });
                labelled = true;
                break;
              }
              steps.push({ step: `resolve labels (${candidate})`, ok: false, detail: describeFailure(attempt) });
            }
            if (!labelled) {
              steps.push({
                step: "resolve labels",
                ok: false,
                detail: "every selection was rejected — a picker could not show a name for a stored value",
              });
            }
          } else {
            steps.push({
              step: `__type(${valueType})`,
              ok: false,
              detail: shape.ok ? "the API answered and the type is not there" : describeFailure(shape),
            });
          }
        }
      }
    } else {
      steps.push({
        step: "collect taxonomy GIDs",
        ok: false,
        detail: "no stored entry value carried a taxonomy GID — nothing to resolve",
      });
    }

    // 5. T1/T3 — where do the permitted values live, and how many are there?
    //
    // MEASURED (run 5): the `Taxonomy` root offers ONLY `categories(...)`.
    // There is no attributes entry point and no shop-wide value list, and
    // `TaxonomyValue` carries only `id` and `name` -- so it cannot be walked
    // backwards to its attribute either. The only remaining door is a
    // CATEGORY, and whether it has one is what this measures.
    //
    // EVERY type and field name below is introspected first and built from
    // what came back. The previous cut hardcoded three attribute type names
    // and a `name` field on one of them: a single wrong name rejects the whole
    // document, and the only step that can answer T1 would then publish
    // "no such API" about an API that works.
    const wantedHandles = (tax.attributeHandles ?? []).map((h) => h.handle).filter(Boolean);
    const VALUES_PAGE = 250;
    const ATTRIBUTES_PAGE = 50;

    // Which carrier each connection uses is MEASURED, not assumed: a generated
    // `nodes { … }` against an edges-only connection is a document the schema
    // rejects, and that rejection would be reported as "no path exists".
    let categoryCarrier: "nodes" | "edges" | null = null;
    const taxonomyShape = await call(
      `#graphql
        query MetaobjectProbeTaxonomyShape {
          __type(name: "Taxonomy") {
            fields(includeDeprecated: true) { name type { ...TypeRef } }
          }
        }
        ${TYPE_REF_FRAGMENT}`,
    );
    const categoriesConnection = taxonomyShape.ok
      ? namedTypeOf((taxonomyShape.data?.__type?.fields ?? []).find((f: any) => f.name === "categories")?.type)
      : undefined;
    if (categoriesConnection) {
      const resolved = await connectionNodeType(call, categoriesConnection);
      categoryCarrier = resolved.carrier;
      steps.push({
        step: `carrier of ${categoriesConnection}`,
        ok: !!resolved.carrier,
        detail: resolved.carrier ?? resolved.error ?? "not resolved",
      });
    }

    const categoryShape = await call(
      `#graphql
        query MetaobjectProbeCategoryShape {
          __type(name: "TaxonomyCategory") {
            fields(includeDeprecated: true) { name args { name } type { ...TypeRef } }
          }
        }
        ${TYPE_REF_FRAGMENT}`,
    );
    let attributesConnection: string | undefined;
    if (!categoryShape.ok) {
      steps.push({ step: "__type(TaxonomyCategory)", ok: false, detail: describeFailure(categoryShape) });
    } else if (!categoryShape.data?.__type?.fields) {
      steps.push({ step: "__type(TaxonomyCategory)", ok: false, detail: "the API answered and the type is not there" });
    } else {
      const fields = categoryShape.data.__type.fields as Array<{ name: string; type: unknown }>;
      tax.categoryFields = fields.map((f) => f.name);
      attributesConnection = namedTypeOf(fields.find((f) => f.name === "attributes")?.type);
      steps.push({
        step: "__type(TaxonomyCategory)",
        ok: true,
        detail: `${tax.categoryFields.join(", ")}${attributesConnection ? ` -- attributes: ${attributesConnection}` : " -- NO attributes field"}`,
      });
    }

    // The attributes field yields a CONNECTION, so the attribute itself is two
    // hops in. Reading the connection as the attribute is what made the last
    // report print "Attribute type: edges | nodes | pageInfo" as though it had
    // measured what an attribute is.
    let attributeNode: string | null = null;
    let attributeCarrier: "nodes" | "edges" | null = null;
    if (attributesConnection) {
      const resolved = await connectionNodeType(call, attributesConnection);
      attributeNode = resolved.nodeType;
      attributeCarrier = resolved.carrier;
      steps.push({
        step: `node of ${attributesConnection}`,
        ok: !!attributeNode,
        detail: attributeNode ? `${attributeNode} (via ${resolved.carrier})` : resolved.error ?? "not resolved",
      });
    }

    let attributeSelection: string | null = null;
    if (attributeNode) {
      const attrShape = await call(
        `#graphql
          query MetaobjectProbeAttributeShape($name: String!) {
            __type(name: $name) {
              kind
              fields(includeDeprecated: true) { name type { ...TypeRef } args { name type { ...TypeRef } } }
              possibleTypes {
                name
                fields(includeDeprecated: true) { name type { ...TypeRef } args { name type { ...TypeRef } } }
              }
            }
          }
          ${TYPE_REF_FRAGMENT}`,
        { name: attributeNode },
      );
      const shape = attrShape.ok ? attrShape.data?.__type : null;
      if (!shape) {
        steps.push({
          step: `__type(${attributeNode})`,
          ok: false,
          detail: attrShape.ok ? "the API answered and the type is not there" : describeFailure(attrShape),
        });
      } else {
        const members = (shape.possibleTypes ?? []).map(
          (m: any) => `${m.name}{${(m.fields ?? []).map((f: any) => f.name).join(",")}}`,
        );
        const described: string[] =
          members.length > 0 ? members : (shape.fields ?? []).map((f: any) => f.name);
        tax.attributeTypeFields = described;
        steps.push({
          step: `__type(${attributeNode})`,
          ok: true,
          detail: `kind=${shape.kind} ${described.join(" | ")}`,
        });
        // `values` is deliberately LEFT OUT here — see polymorphicSelection.
        // It is a connection, it is expensive, and round B fetches it by id.
        attributeSelection = polymorphicSelection(shape, ["values"]);
      }
    }

    if (attributeSelection) {
      // Round A: which attributes exist, and what are they called. CHEAP on
      // purpose: `categories(10) x attributes(50)` is 500 cost points, and the
      // Admin API refuses a single query over 1000. The first cut asked for
      // `categories(25) x attributes(50) x values(250)` — roughly 300 000 —
      // so every round would have come back MAX_COST_EXCEEDED and the report
      // would have called that "no path exists".
      const CATEGORY_PAGE = 10;
      const readCategories = async (extraArg: string, variables: Record<string, unknown>) =>
        call(
          `#graphql
            query MetaobjectProbeCategoryAttributes(${extraArg}$first: Int!) {
              taxonomy {
                categories(${Object.keys(variables)
                  .map((k) => `${k}: $${k}`)
                  .join(", ")}) {
                  ${carrierSelection(
                    categoryCarrier,
                    `id name attributes(first: ${ATTRIBUTES_PAGE}) { ${carrierSelection(attributeCarrier, attributeSelection)} }`,
                  )}
                }
              }
            }`,
          variables,
        );

      const unwrap = (connection: any): any[] =>
        ((connection?.nodes ?? connection?.edges?.map((e: any) => e?.node) ?? []) as any[]).filter(Boolean);
      const attributesOf = (data: any): any[] =>
        unwrap(data?.taxonomy?.categories).flatMap((c) => unwrap(c?.attributes));

      const matchesWanted = (a: any) =>
        wantedHandles.some(
          (h) => String(a?.name ?? "").toLowerCase().replace(/\s+/g, "-") === h.toLowerCase(),
        );

      // Top-level verticals first, then the DESCENDANTS of the first one: a
      // colour attribute plausibly hangs off a leaf rather than off "Apparel",
      // and sampling only the top level would miss it structurally and report
      // T1 unanswered rather than measured.
      const rounds: Array<{ label: string; run: () => Promise<GraphQLCallResult> }> = [
        { label: "top-level categories", run: () => readCategories("", { first: CATEGORY_PAGE }) },
      ];

      let match: any = null;
      let sampled = 0;
      for (const round of rounds) {
        const res = await round.run();
        if (!res.ok) {
          steps.push({ step: round.label, ok: false, detail: describeFailure(res) });
          continue;
        }
        const attributes = attributesOf(res.data);
        sampled += attributes.length;
        steps.push({
          step: round.label,
          ok: attributes.length > 0,
          detail:
            attributes.length > 0
              ? `${attributes.length} attributes: ${attributes.slice(0, 20).map((a: any) => a?.name ?? a?.__typename).join(", ")}`
              : "answered with no attributes here — not proof that none exist, only that these carry none",
        });
        match = match ?? attributes.find(matchesWanted) ?? null;
        if (match) break;

        const firstCategory = unwrap(res.data?.taxonomy?.categories)[0]?.id;
        if (firstCategory && rounds.length === 1) {
          rounds.push({
            label: "descendants of the first category",
            run: () =>
              readCategories("$descendantsOf: ID!, ", { descendantsOf: firstCategory, first: 50 }),
          });
        }
      }

      // Round B: the values of THAT attribute, by its own id. One connection,
      // one page, and the only call in this step that is allowed to be big.
      if (!match?.id) {
        steps.push({
          step: "find the wanted attribute",
          ok: false,
          detail: `none of the ${sampled} sampled attributes matched ${wantedHandles.join("/") || "(no handle known)"}`,
        });
      } else {
        const valuesRes = await call(
          `#graphql
            query MetaobjectProbeAttributeValues($ids: [ID!]!, $first: Int!) {
              nodes(ids: $ids) {
                __typename
                ... on ${match.__typename} { values(first: $first) { nodes { id name } } }
              }
            }`,
          { ids: [match.id], first: VALUES_PAGE },
        );
        const values = valuesRes.ok
          ? (((valuesRes.data?.nodes ?? []) as any[]).flatMap((n) => n?.values?.nodes ?? []).filter(Boolean))
          : [];
        if (!valuesRes.ok) {
          steps.push({ step: `values of "${match.name}"`, ok: false, detail: describeFailure(valuesRes) });
        } else if (values.length === 0) {
          steps.push({
            step: `values of "${match.name}"`,
            ok: false,
            detail: "the query answered with an EMPTY list — that is not a count, it is a path that carried nothing",
          });
        } else {
          tax.valueSource = `${match.__typename}.values (found via TaxonomyCategory.attributes)`;
          tax.valueCount = values.length;
          // From the page size the query ACTUALLY asked for — a second literal
          // would drift and flip the T3 verdict between list and search.
          tax.valuesTruncated = values.length >= VALUES_PAGE;
          tax.valueSample = values.slice(0, 12).map((v: any) => v?.name ?? v?.id).filter(Boolean);
          steps.push({
            step: `values of "${match.name}"`,
            ok: true,
            detail: `${values.length}${tax.valuesTruncated ? "+" : ""} — ${tax.valueSample.join(", ")}`,
          });
        }
      }
    }

    report.taxonomy = tax;
    const reachable = tax.valueCount !== undefined;
    report.verdicts.push(
      reachable
        ? `T1 POSITIVE: the permitted values are reachable via ${tax.valueSource} — ${tax.valueCount}${
            tax.valuesTruncated ? " or more" : ""
          } of them. T3 says the editor should be ${
            tax.valuesTruncated || (tax.valueCount ?? 0) > 60 ? "a SEARCH picker" : "a plain list"
          }.`
        : `T1 NOT ANSWERED: no path to the permitted values worked. See the step details — a failed call is not proof that no such API exists, and PLAN_METAOBJECT_TAXONOMY_CREATE §5 (deep link into the Shopify admin) is the fallback only once this has been RE-RUN and still fails.`,
    );
    // T2 is answered whatever happens to T1, and it is answered from data that
    // was already in the cache — worth saying on its own so a negative T1 does
    // not bury it.
    if ((tax.attributeHandles ?? []).some((h) => h.handle)) {
      report.verdicts.push(
        `T2 POSITIVE: the definition names its attribute by a stable HANDLE, not a GID — ${(tax.attributeHandles ?? [])
          .filter((h) => h.handle)
          .map((h) => `${h.fieldKey}=${h.handle}${h.min || h.max ? ` (${h.min ?? "?"}..${h.max ?? "?"} values)` : ""}`)
          .join(", ")}. A create form has to honour those bounds.`,
      );
    }
  }

  // ---- Cleanup: remove objects an earlier run could not ------------------
  // A leftover GID is reported so somebody can go and remove it -- but a
  // Shopify STANDARD definition (`shopify--...`) is not listed under Content >
  // Metaobjects at all, so "go and remove it" is advice the merchant cannot
  // follow. Measured the hard way in run 3: the entry survived because the
  // referencing product still existed at cleanup time, and then could not be
  // found in the admin. Reporting an id nobody can act on is half a report.
  if (wants("cleanup")) {
    const outcomes: StepOutcome[] = [];
    for (const gid of cleanupIds) {
      if (gid.includes("/Metaobject/")) {
        const res = await call(
          `#graphql
            mutation MetaobjectProbeManualCleanup($id: ID!) {
              metaobjectDelete(id: $id) { deletedId userErrors { field message code } }
            }`,
          { id: gid },
        );
        const gone = res.data?.metaobjectDelete?.deletedId;
        outcomes.push({
          step: `metaobjectDelete ${gid}`,
          ok: !!gone,
          detail: gone
            ? `deletedId=${gone}`
            : describeFailure(res, res.data?.metaobjectDelete?.userErrors),
        });
      } else if (gid.includes("/Product/")) {
        const res = await call(
          `#graphql
            mutation MetaobjectProbeManualCleanupProduct($input: ProductDeleteInput!) {
              productDelete(input: $input) { deletedProductId userErrors { field message } }
            }`,
          { input: { id: gid } },
        );
        const gone = res.data?.productDelete?.deletedProductId;
        outcomes.push({
          step: `productDelete ${gid}`,
          ok: !!gone,
          detail: gone ? `deletedProductId=${gone}` : describeFailure(res, res.data?.productDelete?.userErrors),
        });
      } else {
        // Deliberately narrow: this step deletes things, so it only accepts the
        // two id shapes THIS probe can create. Anything else is refused by name
        // rather than forwarded to a mutation.
        outcomes.push({
          step: `skipped ${gid}`,
          ok: false,
          detail: "not a Metaobject or Product GID — this step only removes what the probe itself creates",
        });
      }
    }
    report.cleanup = outcomes;
    const removed = outcomes.filter((o) => o.ok).length;
    report.verdicts.push(
      `CLEANUP: removed ${removed} of ${outcomes.length} listed object(s).${
        removed < outcomes.length ? " The rest are still there — see the step details." : ""
      }`,
    );
  }

  // ---- Step 3: write test on a definition (destructive, self-cleaning) -----
  if (wants("write")) {
    report.writeTest = await runWriteTest(call, writeType, definitions);
    if (report.writeTest.verdict) report.verdicts.push(report.writeTest.verdict);
  }

  // ---- Step 4: link + delete test (destructive, opt-in) --------------------
  if (wants("link")) {
    report.linkTest = await runLinkTest(
      call,
      writeType,
      definitions,
      report.reverseRelationField ?? null,
      // Measured by step 2b when it ran; `__typename` alone otherwise, which is
      // why the two steps are worth ticking together.
      report.reverseRelation?.nodeSelection ?? "__typename",
    );
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
 * Is this stored value something worth COPYING into a required field?
 *
 * `""` obviously not — but neither is `"[]"`, `"null"` or `"{}"`: a list field
 * whose source entry happens to be empty would be copied into a REQUIRED field
 * and reproduce the exact "can't be blank" refusal the borrowing exists to
 * avoid, while looking like a value in the report.
 */
function carriesAValue(raw: string | null | undefined): boolean {
  const value = (raw ?? "").trim();
  if (value === "" || value === "null") return false;
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.length > 0;
    if (parsed && typeof parsed === "object") return Object.keys(parsed).length > 0;
  } catch {
    // Not JSON — a plain non-empty string is a value.
  }
  return true;
}

/**
 * Field values for a throwaway entry of `type`, or the reason there are none.
 *
 * A required field this probe cannot invent a value for is not a dead end:
 * MEASURED on a live shop (run 2), every Shopify STANDARD definition requires
 * a `product_taxonomy_value_reference`, so an inventing-only seeder skips the
 * write test on every one of them and V1 stays unanswerable forever.
 *
 * The way out is not to guess a taxonomy GID -- it is to COPY one the shop
 * already uses, read off an EXISTING entry of the same definition. That is a
 * value Shopify has already accepted for this exact field, which is the only
 * kind of value worth putting in a throwaway. A definition with no existing
 * entry to copy from is skipped, honestly and by name.
 */
async function seedFieldsFor(
  call: (query: string, variables?: Record<string, unknown>) => Promise<GraphQLCallResult>,
  definition: DefinitionShape,
  labelValue: string,
): Promise<{ ok: true; fields: Array<{ key: string; value: string }>; borrowed: string[] } | { ok: false; reason: string }> {
  const fields: Array<{ key: string; value: string }> = [];
  const needsBorrowing: string[] = [];

  for (const field of definition.fieldDefinitions) {
    if (field.required !== true) continue;
    if (field.type === "color") fields.push({ key: field.key, value: "#123456" });
    else if (field.type === "single_line_text_field" || field.type === "multi_line_text_field") {
      fields.push({ key: field.key, value: labelValue });
    } else if (field.type === "list.single_line_text_field") {
      fields.push({ key: field.key, value: JSON.stringify([labelValue]) });
    } else {
      needsBorrowing.push(field.key);
    }
  }

  if (needsBorrowing.length === 0) return { ok: true, fields, borrowed: [] };

  const existing = await call(
    `#graphql
      query MetaobjectProbeSeedSource($type: String!, $first: Int!) {
        metaobjects(type: $type, first: $first) {
          nodes { id fields { key value } }
        }
      }`,
    { type: definition.type, first: 20 },
  );
  if (!existing.ok) {
    // A failed lookup is not "there is nothing to copy" -- the same rule the
    // rest of this file follows. The test is skipped as UNMEASURED.
    return {
      ok: false,
      reason: `could not read existing entries of "${definition.type}" to copy required values from (${describeFailure(existing)}). Skipped WITHOUT answering V1.`,
    };
  }

  const entries: Array<{ fields?: Array<{ key: string; value: string | null }> }> =
    existing.data?.metaobjects?.nodes ?? [];
  const borrowed: string[] = [];
  for (const key of needsBorrowing) {
    const found = entries
      .flatMap((e) => e.fields ?? [])
      .find((f) => f.key === key && carriesAValue(f.value));
    if (!found) {
      return {
        ok: false,
        reason: `required field "${key}" is of a type this probe cannot invent, and no existing entry of "${definition.type}" has a value to copy. Skipped WITHOUT answering V1.`,
      };
    }
    fields.push({ key, value: found.value! });
    borrowed.push(key);
  }
  return { ok: true, fields, borrowed };
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
  const seeded = await seedFieldsFor(call, definition, "contentpilot probe");
  if (!seeded.ok) {
    return { attempted: false, skippedReason: seeded.reason };
  }
  const seed = seeded.fields;
  if (seeded.borrowed.length > 0) {
    steps.push({
      step: "seed required fields",
      ok: true,
      detail: `copied from an existing entry of this definition: ${seeded.borrowed.join(", ")}`,
    });
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
      const detail = createErrors.map((e: any) => `${e.code ?? ""} ${e.message}`.trim()).join("; ");
      // A refusal is only a V1 answer when it is about ACCESS. Now that the
      // seeder borrows real values the create actually runs, so most refusals
      // are about the PAYLOAD -- a handle collision with a leftover throwaway,
      // a taxonomy value the definition does not accept, a validation rule.
      // Publishing "this definition is read-only for us" off one of those would
      // send Phase 4 down the §7.2 branch on a definition that writes fine.
      const accessRefusal =
        createErrors.length > 0 &&
        createErrors.some((e: any) =>
          /access|denied|not authorized|unauthorized|permission|forbidden|scope/i.test(
            `${e.code ?? ""} ${e.message ?? ""}`,
          ),
        );
      return {
        attempted: true,
        steps,
        leftovers,
        verdict: accessRefusal
          ? `V1 NEGATIVE for "${type}": Shopify refused the create on ACCESS grounds (${detail}). Phase 4 takes the read-only branch (§7.2) for this definition.`
          : createErrors.length > 0
            ? `V1 INCONCLUSIVE for "${type}": the create was refused, but for the PAYLOAD rather than for access (${detail}). That says nothing about whether this app may write here -- fix the payload and re-run.`
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
  /** The selection step 2b measured for a relation node. `__typename` alone
   *  would waste the ONE run that has a self-created referencing product. */
  reverseNodeSelection: string,
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

  // Every REQUIRED field, the same way the write test does it — inventing what
  // it can and COPYING the rest from an existing entry. Run 2 died exactly
  // here ("Base color can't be blank; Base pattern can't be blank"): the link
  // target could not be created, so V3, V4's semantics and V5 all went
  // unmeasured for want of two taxonomy references the shop already had.
  const seeded = await seedFieldsFor(call, definition, "ContentPilot Probe Colour");
  if (!seeded.ok) {
    return { attempted: false, skippedReason: seeded.reason };
  }

  let entryId: string | null = null;
  let productId: string | null = null;
  try {
    const fields = [...seeded.fields];
    const setField = (key: string, value: string) => {
      const at = fields.findIndex((f) => f.key === key);
      if (at >= 0) fields[at] = { key, value };
      else fields.push({ key, value });
    };
    setField(labelField.key, "ContentPilot Probe Colour");
    // The colour is the VALUE V3 is about, so it overrides whatever the seeder
    // put there — a borrowed colour would make "did the swatch move?" untestable.
    if (colourField) setField(colourField.key, "#0a7f5f");

    if (seeded.borrowed.length > 0) {
      steps.push({
        step: "seed required fields",
        ok: true,
        detail: `copied from an existing entry of this definition: ${seeded.borrowed.join(", ")}`,
      });
    }

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
              ${reverseRelationField}(first: 10) { nodes { ${reverseNodeSelection} } }
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
    // PRODUCT FIRST, then the entry. Measured (run 3): Shopify REFUSES to
    // delete a metaobject "while it is referenced by another resource" -- which
    // is the V5 answer and also means the entry cannot go while the throwaway
    // product still points at it. Cleaning up in the other order left a
    // throwaway colour entry in the merchant's shop on every run that measured
    // V5 successfully, i.e. on exactly the runs that worked.
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
    if (entryId) {
      const cleanup = await call(
        `#graphql
          mutation MetaobjectProbeCleanupEntry($id: ID!) {
            metaobjectDelete(id: $id) { deletedId userErrors { message } }
          }`,
        { id: entryId },
      );
      const gone = cleanup.data?.metaobjectDelete?.deletedId;
      steps.push({
        step: "metaobjectDelete (cleanup)",
        ok: !!gone,
        detail: gone
          ? `deletedId=${gone}`
          : describeFailure(cleanup, cleanup.data?.metaobjectDelete?.userErrors),
      });
      if (!gone) leftovers.push(entryId);
    }
  }
}
