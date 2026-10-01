/**
 * Collection-Model Probe — PLAN_CONTENT_CREATION Phase 0, Schritt 5
 *
 * Answers the two Phase-0 measurements that need a live shop:
 *
 *   A) What do the collection RULE types actually look like on the target API
 *      version? (field/operator enums, `CollectionConditionMatchType`, whether
 *      exclusions and multiple sources exist at all) — the input for
 *      `collection-rules.shared.ts`.
 *   B) Does `collectionUpdate` with `sourcesToCreate` convert an existing
 *      MANUAL collection into a rule-based one? The Help Center says the type
 *      is immutable after creation; the input field says otherwise. Both
 *      cannot be true, and §1.2 point 3 refuses to guess.
 *
 * Three design points that make this a measurement rather than a lookup:
 *
 * 1. **It does not use `admin.graphql`.** That client is bolted to the pinned
 *    version (2025-10), and the whole question is about 2026-07. This route
 *    raw-fetches `/admin/api/<version>/graphql.json` with the session token, so
 *    the answer needs no deploy and no change to the pin. It also probes which
 *    versions respond at all — which is Phase −1's first question anyway.
 * 2. **It does not guess type names.** The plan's §1.2 tree was researched
 *    against `latest`; the names may differ. So step 1 asks the schema which
 *    Collection-ish types EXIST and step 2 introspects what it found. A type
 *    from the plan that comes back missing is a real finding, not a typo.
 * 3. **A FAILED call is never reported as a NEGATIVE answer.** This is the
 *    trap a probe is most likely to fall into and the most expensive one to
 *    fall into: one throttled response must not read as "the type does not
 *    exist, re-plan §2.4". Every shape carries `missing` (the API answered,
 *    the type is not there) and `error` (we never got an answer) as SEPARATE
 *    states, and every verdict checks for the second before drawing a
 *    conclusion. Same rule as `attributesSyncedAt` and `indexabilityKnown`
 *    elsewhere in this codebase: an empty result is not evidence.
 *
 * Dev-only, whole route: it is a Phase-0 diagnostic, it burns a double-digit
 * number of Admin API calls per run against the shop's rate budget, and the
 * write test creates a real collection. The Settings tab that drives it is
 * gated the same way, but a hidden tab is not a permission check — this route
 * takes a direct POST.
 */

import { data as json, type ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { logger } from "~/utils/logger.server";
import {
  SUPPORTED_SHOPIFY_API_VERSIONS,
  isSupportedApiVersion,
  resolveApiVersionString,
} from "~/utils/api-version";

/** The version PLAN §1.0 identifies as both the deadline target and the one
 *  that introduces the `sources` model. */
const DEFAULT_PROBE_VERSION = "2026-07";

/**
 * Types the plan names. Probed explicitly IN ADDITION to discovery, so a name
 * that does not exist on the target version shows up as an explicit miss
 * instead of merely being absent from a list nobody cross-checks.
 */
const PLAN_TYPES = [
  "CollectionCreateInput",
  "CollectionUpdateInput",
  "CollectionInput",
  "CollectionCreateSourceTargetInput",
  "CollectionCreateConditionsSourceInput",
  "CollectionCreateSourceInclusionInput",
  "CollectionConditionMatchType",
  "CollectionRuleColumn",
  "CollectionRuleRelation",
  "CollectionSortOrder",
];

/** Cap on how many DISCOVERED types get introspected. Never silent — the
 *  report carries `typesTruncated` so a cut-off list cannot read as complete. */
const MAX_INTROSPECTED_TYPES = 140;

/**
 * Wrapper types that never carry an answer. The first real run spent 50 of its
 * 60 slots on Connection/Edge/Payload noise (alphabetical order put them first)
 * and never reached `CollectionSourceInclusionConditionInput` — the ONE type
 * the rule editor is built from. Dropping them is not a cap, it is a filter,
 * and the report counts them separately from the truncation.
 */
const NOISE_TYPE_SUFFIX = /(Connection|Edge|Payload|UserError|UserErrorCode|SortKeys)$/;

/** Types per introspection request. Aliases collapse ~60 round trips into two
 *  or three, which is the difference between a diagnostic and a rate-limit
 *  incident on the merchant's shop. */
const INTROSPECT_BATCH_SIZE = 25;

interface GraphQLCallResult {
  ok: boolean;
  status: number;
  data?: any;
  errors?: Array<{ message: string }>;
  networkError?: string;
}

interface TypeShape {
  name: string;
  kind: string;
  /** Present for INPUT_OBJECT / OBJECT. */
  fields?: Array<{ name: string; type: string }>;
  /** Present for ENUM — the actual answer for the rule builder's dropdowns. */
  enumValues?: string[];
  /** The API ANSWERED and the type is not there. A real negative. */
  missing?: boolean;
  /** We never got an answer. NOT a negative — the question stays open. */
  error?: string;
}

export interface CollectionModelProbeReport {
  shop: string;
  ranAt: string;
  /** What the APP currently speaks — for contrast with the probed version. */
  pinnedApiVersion: string;
  probedApiVersion: string;
  /** Which versions answered a trivial query. Measured, not looked up. */
  versionReachability: Array<{ version: string; reachable: boolean; detail: string }>;
  /** Every schema type whose name mentions Collection or Condition. */
  discoveredTypeNames: string[];
  /** Wrapper types (Connection/Edge/Payload/…) deliberately not introspected. */
  noiseTypesSkipped?: number;
  /** Set when the type sweep itself failed — "(none)" would otherwise read as
   *  "this schema has no collection types". */
  discoveryError?: string;
  typesTruncated: boolean;
  /** Introspected shapes, plan types first. */
  types: TypeShape[];
  /** Quick verdicts the reader would otherwise have to derive by hand. */
  verdicts: string[];
  writeTest: {
    attempted: boolean;
    skippedReason?: string;
    steps?: Array<{ step: string; ok: boolean; detail: string }>;
    verdict?: string;
  };
}

/** Renders a nested __Type ref down to a readable "[Foo!]!" string. */
function renderTypeRef(ref: any): string {
  if (!ref) return "?";
  if (ref.kind === "NON_NULL") return `${renderTypeRef(ref.ofType)}!`;
  if (ref.kind === "LIST") return `[${renderTypeRef(ref.ofType)}]`;
  return ref.name ?? "?";
}

/** One readable line from whatever a call actually produced. Deliberately not
 *  a chain of `??`: an empty userErrors array is not nullish, so a `??` chain
 *  would render a 429 as "[]" and hide the only useful information. */
function describeFailure(res: GraphQLCallResult, userErrors?: Array<{ message: string }>): string {
  const parts: string[] = [];
  if (res.networkError) parts.push(res.networkError);
  if (res.errors?.length) parts.push(`graphQLErrors=${JSON.stringify(res.errors)}`);
  if (userErrors?.length) parts.push(`userErrors=${JSON.stringify(userErrors)}`);
  if (parts.length === 0) parts.push(`HTTP ${res.status}, no error detail returned`);
  return parts.join(" | ");
}

const TYPE_REF_FRAGMENT = `
  fragment TypeRef on __Type {
    kind
    name
    ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
  }`;

const TYPE_SHAPE_FRAGMENT = `
  fragment TypeShape on __Type {
    name
    kind
    enumValues(includeDeprecated: true) { name }
    inputFields { name type { ...TypeRef } }
    fields(includeDeprecated: true) { name type { ...TypeRef } }
  }`;

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);

  // Whole-route dev gate — see the header. The read half is not "harmless":
  // it costs the shop a double-digit number of Admin API calls per POST.
  if (process.env.APP_ENV !== "development") {
    return json(
      { success: false, error: "The collection-model probe is a development-only diagnostic." },
      { status: 403 },
    );
  }

  const formData = await request.formData().catch(() => null);
  const requestedVersion = (formData?.get("apiVersion") as string | null)?.trim().toLowerCase() || DEFAULT_PROBE_VERSION;
  const wantsWriteTest = formData?.get("writeTest") === "true";
  const sourcesOverride = (formData?.get("sourcesToCreate") as string | null)?.trim() || "";

  // Validated, not just interpolated: the value becomes a path segment in the
  // admin URL, and an unlisted string would silently be served by a DIFFERENT
  // version while the report labels it with what was asked for.
  if (!isSupportedApiVersion(requestedVersion)) {
    return json(
      {
        success: false,
        error: `Unsupported API version "${requestedVersion}". Known: ${SUPPORTED_SHOPIFY_API_VERSIONS.join(", ")}`,
      },
      { status: 400 },
    );
  }

  const accessToken = session.accessToken;
  if (!accessToken) {
    return json({ success: false, error: "No access token on the session" }, { status: 401 });
  }

  /** One raw GraphQL call against an EXPLICIT api version. */
  const call = async (version: string, query: string, variables?: Record<string, unknown>): Promise<GraphQLCallResult> => {
    try {
      const res = await fetch(`https://${session.shop}/admin/api/${version}/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query, variables: variables ?? {} }),
      });
      const status = res.status;
      if (!res.ok) {
        return { ok: false, status, networkError: `HTTP ${status}: ${(await res.text()).slice(0, 300)}` };
      }
      const body = await res.json();
      return { ok: !body.errors?.length, status, data: body.data, errors: body.errors };
    } catch (e) {
      return { ok: false, status: 0, networkError: e instanceof Error ? e.message : String(e) };
    }
  };

  const report: CollectionModelProbeReport = {
    shop: session.shop,
    ranAt: new Date().toISOString(),
    pinnedApiVersion: resolveApiVersionString(),
    probedApiVersion: requestedVersion,
    versionReachability: [],
    discoveredTypeNames: [],
    typesTruncated: false,
    types: [],
    verdicts: [],
    writeTest: { attempted: false },
  };

  // ── 0. Which versions answer at all? ─────────────────────────────────────
  // Phase −1's first question, and it also tells us whether the rest of this
  // report is even meaningful.
  report.versionReachability = await Promise.all(
    SUPPORTED_SHOPIFY_API_VERSIONS.map(async (version) => {
      const res = await call(version, `{ shop { name } }`);
      return {
        version,
        reachable: res.ok,
        detail: res.ok ? `ok (${res.status})` : describeFailure(res),
      };
    }),
  );

  if (report.versionReachability.find((v) => v.version === requestedVersion)?.reachable !== true) {
    report.verdicts.push(
      `❌ API ${requestedVersion} did not answer a trivial query — everything below would be inconclusive, not negative. Nothing else was probed.`,
    );
    return json({ success: true, report });
  }

  // ── 1. Discover the type names instead of assuming them ──────────────────
  const schemaRes = await call(requestedVersion, `{ __schema { types { name kind } } }`);
  if (!schemaRes.ok) {
    // Degrading to an empty list here would render as "(none)" and read as
    // "this schema has no collection types" — the exact confusion this route
    // exists to avoid.
    report.discoveryError = describeFailure(schemaRes);
    report.verdicts.push(`⚠ The type sweep failed (${report.discoveryError}). Only the plan's named types were probed.`);
  }
  const allTypes: Array<{ name: string; kind: string }> = schemaRes.data?.__schema?.types ?? [];
  const matching = allTypes.filter((t) => /collection|condition/i.test(t.name ?? ""));
  report.discoveredTypeNames = matching.map((t) => t.name).sort();

  // Order by what actually answers questions: INPUT_OBJECT (the shapes we have
  // to construct), then ENUM (the dropdown values), then everything else.
  // Alphabetical order alone is what made the first run useless.
  const kindRank = (kind: string) => (kind === "INPUT_OBJECT" ? 0 : kind === "ENUM" ? 1 : 2);
  const ranked = matching
    .filter((t) => !NOISE_TYPE_SUFFIX.test(t.name))
    .sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || a.name.localeCompare(b.name))
    .map((t) => t.name);
  report.noiseTypesSkipped = matching.length - ranked.length;

  // Plan types first (so a missing one is impossible to overlook), then the
  // ranked rest up to the cap.
  const toIntrospect = [...PLAN_TYPES];
  for (const name of ranked) {
    if (toIntrospect.length >= MAX_INTROSPECTED_TYPES) {
      report.typesTruncated = true;
      break;
    }
    if (!toIntrospect.includes(name)) toIntrospect.push(name);
  }

  // ── 2. Introspect each, batched via aliases ──────────────────────────────
  for (let i = 0; i < toIntrospect.length; i += INTROSPECT_BATCH_SIZE) {
    const batch = toIntrospect.slice(i, i + INTROSPECT_BATCH_SIZE);
    const aliases = batch.map((name, idx) => `  t${idx}: __type(name: ${JSON.stringify(name)}) { ...TypeShape }`).join("\n");
    const res = await call(requestedVersion, `query ProbeTypes {\n${aliases}\n}\n${TYPE_SHAPE_FRAGMENT}\n${TYPE_REF_FRAGMENT}`);

    if (!res.ok || !res.data) {
      // The whole batch is UNKNOWN, not absent. Marking these `missing` is the
      // single most damaging thing this route could do.
      const detail = describeFailure(res);
      for (const name of batch) report.types.push({ name, kind: "—", error: detail });
      continue;
    }

    batch.forEach((name, idx) => {
      const t = res.data[`t${idx}`];
      if (!t) {
        report.types.push({ name, kind: "—", missing: true });
        return;
      }
      const inputFields = (t.inputFields ?? []).map((f: any) => ({ name: f.name, type: renderTypeRef(f.type) }));
      const objectFields = (t.fields ?? []).map((f: any) => ({ name: f.name, type: renderTypeRef(f.type) }));
      report.types.push({
        name: t.name ?? name,
        kind: t.kind,
        fields: inputFields.length > 0 ? inputFields : objectFields.length > 0 ? objectFields : undefined,
        enumValues: (t.enumValues ?? []).map((e: any) => e.name),
      });
    });
  }

  // ── 3. Verdicts the plan actually asked for ──────────────────────────────
  // Every branch checks `error` FIRST: a call we never got an answer to must
  // produce "unknown", never a conclusion.
  const byName = new Map(report.types.map((t) => [t.name, t]));
  const createInput = byName.get("CollectionCreateInput");
  const updateInput = byName.get("CollectionUpdateInput");

  if (createInput?.error) {
    report.verdicts.push(`⚠ CollectionCreateInput could not be read (${createInput.error}) — UNKNOWN, re-run before concluding anything.`);
  } else if (createInput?.missing) {
    report.verdicts.push(
      `❌ CollectionCreateInput does not exist on ${requestedVersion} — the new collection model is NOT available here. §1.2 and §2.4 need re-planning against whatever this version does offer.`,
    );
  } else if (createInput?.fields?.some((f) => f.name === "sources")) {
    report.verdicts.push(`✅ CollectionCreateInput.sources exists on ${requestedVersion} — the §1.2 model is real.`);
  } else if (createInput) {
    report.verdicts.push(
      `⚠ CollectionCreateInput exists but has NO 'sources' field. Fields: ${createInput.fields?.map((f) => f.name).join(", ") || "—"}`,
    );
  }

  if (updateInput?.error) {
    report.verdicts.push(`⚠ CollectionUpdateInput could not be read (${updateInput.error}) — the §1.2 point-3 question stays OPEN.`);
  } else if (updateInput?.missing) {
    report.verdicts.push(
      `ℹ CollectionUpdateInput does not exist on ${requestedVersion} (this version likely still takes \`input: CollectionInput\`). The §1.2 point-3 question is not answerable here — probe a version that has it.`,
    );
  } else {
    const sourcesToCreate = updateInput?.fields?.find((f) => f.name === "sourcesToCreate");
    report.verdicts.push(
      sourcesToCreate
        ? `✅ CollectionUpdateInput.sourcesToCreate exists (${sourcesToCreate.type}) — measurement B can decide whether it CONVERTS a manual collection.`
        : `⚠ CollectionUpdateInput has no 'sourcesToCreate' — the §1.2 point-3 contradiction resolves in favour of "type is immutable".`,
    );
  }

  for (const planType of PLAN_TYPES) {
    const t = byName.get(planType);
    if (t?.missing) report.verdicts.push(`ℹ Plan type "${planType}" does not exist on ${requestedVersion}.`);
    if (t?.error) report.verdicts.push(`⚠ Plan type "${planType}" could not be read — unknown, not absent.`);
  }

  // ── 4. Measurement B — the write test ────────────────────────────────────
  if (wantsWriteTest) {
    report.writeTest = await runWriteTest(call, requestedVersion, sourcesOverride, byName);
  } else {
    report.writeTest = { attempted: false, skippedReason: "Not requested (tick the write-test box to opt in)." };
  }

  logger.info("[COLLECTION-PROBE] Done", {
    context: "CollectionModelProbe",
    shop: session.shop,
    version: requestedVersion,
    typesFound: report.types.filter((t) => !t.missing && !t.error).length,
    typesUnknown: report.types.filter((t) => t.error).length,
    writeTest: report.writeTest.attempted,
  });

  return json({ success: true, report });
}

/**
 * Build ONE inclusion condition from the types this run actually introspected,
 * instead of hardcoding a shape.
 *
 * The 2026-07 model does NOT use a generic {column, relation, condition} triple
 * — that is the old `ruleSet` shape. `CollectionSourceInclusionConditionInput`
 * is a one-field-per-attribute union (`productTag`, `productTitle`,
 * `variantPrice`, …), each pointing at its own typed input with its own
 * relation enum. Guessing that from a plan researched against `latest` is what
 * wasted the first write-test run, so the probe now derives it from the schema
 * it just read: measured, not assumed — the same rule the rest of this route
 * follows.
 */
function deriveConditionPayload(byName: Map<string, TypeShape>): { payload: Record<string, unknown> | null; note: string } {
  const bare = (t: string) => t.replace(/[[\]!]/g, "");
  const conditionInput = byName.get("CollectionSourceInclusionConditionInput");
  if (!conditionInput || conditionInput.missing || conditionInput.error || !conditionInput.fields?.length) {
    return { payload: null, note: "CollectionSourceInclusionConditionInput was not introspected — cannot build a payload." };
  }

  // Prefer the product-tag condition: it needs no existing catalogue data, so a
  // rejection cannot be blamed on the shop's contents.
  const chosen =
    conditionInput.fields.find((f) => /tag/i.test(f.name)) ??
    conditionInput.fields.find((f) => /title/i.test(f.name)) ??
    conditionInput.fields[0];

  const inner = byName.get(bare(chosen.type));
  if (!inner || !inner.fields?.length) {
    return { payload: null, note: `Inner type ${bare(chosen.type)} for "${chosen.name}" was not introspected.` };
  }

  const value: Record<string, unknown> = {};
  for (const field of inner.fields) {
    // A LIST field must get a LIST. GraphQL happens to coerce a bare scalar
    // into a single-element list, so the first successful run sent
    // `values: "contentpilot-probe"` against `values: [String!]!` and still
    // passed — a payload that works by leniency is not a payload this probe
    // should be reporting as the correct shape.
    const isList = field.type.includes("[");
    const wrap = (v: unknown) => (isList ? [v] : v);
    const fieldType = byName.get(bare(field.type));

    if (fieldType?.enumValues?.length) {
      // Enums here are NOT interchangeable between condition kinds — productTag
      // has TAGGED_WITH where productTitle has EQUALS. Take what this one
      // offers rather than assuming a common vocabulary.
      const relation = fieldType.enumValues.includes("EQUALS") ? "EQUALS" : fieldType.enumValues[0];
      value[field.name] = isList ? [relation] : relation;
    } else if (fieldType?.kind === "INPUT_OBJECT") {
      // e.g. MoneyInput / WeightInput / the category value object — needs its
      // own synthesis, which is beyond what a diagnostic should guess at.
      return { payload: null, note: `${inner.name}.${field.name} needs a nested ${bare(field.type)} — use the override field.` };
    } else if (/String|ID/.test(field.type)) {
      value[field.name] = wrap("contentpilot-probe");
    } else if (/Int|Decimal|Float/.test(field.type)) {
      value[field.name] = wrap(1);
    } else if (/Boolean/.test(field.type)) {
      value[field.name] = wrap(true);
    } else if (field.type.endsWith("!")) {
      // A required field we cannot synthesise — better to say so than to send
      // something the API will reject for an unrelated reason.
      return { payload: null, note: `Cannot synthesise required field ${inner.name}.${field.name}: ${field.type}. Use the override field.` };
    }
  }

  return {
    payload: { [chosen.name]: value },
    note: `Derived from ${conditionInput.name}.${chosen.name} → ${inner.name}: ${JSON.stringify({ [chosen.name]: value })}`,
  };
}

/**
 * Measurement B: create a MANUAL collection, try to give it a rule source,
 * read back whether it converted, then clean up.
 *
 * The `sourcesToCreate` payload defaults to the shape PLAN §1.2 documents, but
 * that research ran against `latest` — so the payload is overridable and BOTH
 * the sent variables and the raw error are reported. A rejected shape is then
 * one paste away from being corrected, instead of an opaque "it failed".
 */
async function runWriteTest(
  call: (version: string, query: string, variables?: Record<string, unknown>) => Promise<GraphQLCallResult>,
  version: string,
  sourcesOverride: string,
  byName: Map<string, TypeShape>,
): Promise<CollectionModelProbeReport["writeTest"]> {
  const steps: Array<{ step: string; ok: boolean; detail: string }> = [];
  const title = `[ContentPilot probe] delete me ${new Date().toISOString()}`;
  let collectionId: string | null = null;

  const finish = (verdict: string) => ({ attempted: true, steps, verdict });

  async function cleanup() {
    if (!collectionId) return;
    const deleted = await call(
      version,
      `mutation ProbeDelete($input: CollectionDeleteInput!) {
         collectionDelete(input: $input) { deletedCollectionId userErrors { field message } }
       }`,
      { input: { id: collectionId } },
    );
    const deletedId = deleted.data?.collectionDelete?.deletedCollectionId;
    steps.push({
      step: "cleanup (collectionDelete)",
      ok: !!deletedId,
      detail: deletedId
        ? `deleted ${deletedId}`
        : `LEFTOVER — delete "${title}" by hand. ${describeFailure(deleted, deleted.data?.collectionDelete?.userErrors)}`,
    });
  }

  // 1. Create a plainly MANUAL collection (no sources, no ruleSet).
  const created = await call(
    version,
    `mutation ProbeCreate($collection: CollectionCreateInput!) {
       collectionCreate(collection: $collection) {
         collection { id title ruleSet { appliedDisjunctively } }
         userErrors { field message }
       }
     }`,
    { collection: { title } },
  );
  const createErrors = created.data?.collectionCreate?.userErrors ?? [];
  collectionId = created.data?.collectionCreate?.collection?.id ?? null;
  steps.push({
    step: "collectionCreate (manual)",
    ok: !!collectionId && createErrors.length === 0,
    detail: collectionId
      ? `id=${collectionId}, ruleSet=${JSON.stringify(created.data?.collectionCreate?.collection?.ruleSet ?? null)}`
      : describeFailure(created, createErrors),
  });
  if (!collectionId) return finish("❌ Could not create the throwaway collection — measurement B INCONCLUSIVE (this says nothing about convertibility).");

  // 2. Try to convert it.
  let sourcesToCreate: unknown;
  if (sourcesOverride) {
    try {
      sourcesToCreate = JSON.parse(sourcesOverride);
    } catch (e) {
      steps.push({ step: "parse sourcesToCreate override", ok: false, detail: e instanceof Error ? e.message : String(e) });
      await cleanup();
      return finish("❌ The sourcesToCreate override is not valid JSON — nothing was measured.");
    }
  } else {
    const derived = deriveConditionPayload(byName);
    steps.push({ step: "derive condition payload", ok: !!derived.payload, detail: derived.note });
    if (!derived.payload) {
      await cleanup();
      return finish(
        "⚠ INCONCLUSIVE: could not derive a valid condition payload from the introspected types. Paste one into the override field and re-run — nothing about convertibility was measured.",
      );
    }
    sourcesToCreate = [{ source: { title: "Probe source", inclusion: { matchType: "ALL", conditions: [derived.payload] } } }];
  }

  const updated = await call(
    version,
    `mutation ProbeConvert($id: ID!, $sourcesToCreate: [CollectionCreateSourceTargetInput!]) {
       collectionUpdate(collection: { id: $id, sourcesToCreate: $sourcesToCreate }) {
         collection { id title ruleSet { appliedDisjunctively rules { column relation condition } } }
         userErrors { field message }
       }
     }`,
    { id: collectionId, sourcesToCreate },
  );
  const updateErrors = updated.data?.collectionUpdate?.userErrors ?? [];
  const updateAccepted = updated.ok && updateErrors.length === 0;
  // A payload the SERVER never even ran — variable coercion / unknown field —
  // says nothing about convertibility. The first real run reported exactly this
  // as "❌ the type is immutable, Phase 3 must not offer conversion", off a
  // payload that used the OLD {column, relation, condition} shape. A request
  // that was never executed is not a negative answer.
  const malformedRequest =
    !updateAccepted &&
    (updated.errors ?? []).some((e) =>
      /provided invalid value|is not defined on|Variable \$|expects type|argument/i.test(e.message ?? ""),
    );
  steps.push({
    step: "collectionUpdate (sourcesToCreate)",
    ok: updateAccepted,
    detail: `sent=${JSON.stringify(sourcesToCreate)} → ${
      updateAccepted
        ? JSON.stringify(updated.data?.collectionUpdate?.collection ?? null)
        : describeFailure(updated, updateErrors)
    }`,
  });

  // 3. Read back — the echo is the only thing that decides, not userErrors.
  const readBack = await call(
    version,
    `query ProbeRead($id: ID!) {
       collection(id: $id) { id title ruleSet { appliedDisjunctively rules { column relation condition } } }
     }`,
    { id: collectionId },
  );
  const ruleSetAfter = readBack.data?.collection?.ruleSet ?? null;
  steps.push({
    step: "read back",
    ok: readBack.ok,
    detail: readBack.ok ? `ruleSet=${JSON.stringify(ruleSetAfter)}` : describeFailure(readBack),
  });

  await cleanup();

  // A failed read-back means we do not KNOW the outcome. Calling that a silent
  // no-op would be a confident wrong answer about a collection that has since
  // been deleted — unrecoverable without re-running.
  if (!readBack.ok) {
    return finish(
      `⚠ INCONCLUSIVE: the read-back failed, so the outcome is unknown. The update itself was ${
        updateAccepted ? "accepted" : "rejected"
      } — re-run before drawing any conclusion.`,
    );
  }

  if (ruleSetAfter) {
    return finish(
      "✅ CONVERTED: a manual collection became rule-based via sourcesToCreate. The Help Center's \"type is immutable\" does not hold for the API — §1.2 point 3 resolves in favour of the input field, and Phase 3 may offer the conversion.",
    );
  }
  if (malformedRequest) {
    return finish(
      "⚠ INCONCLUSIVE — the PAYLOAD was rejected, not the conversion. The API refused the request shape before running it, so this says NOTHING about whether a manual collection can be converted. Correct the payload from the introspected types (see the step detail for the exact complaint) and re-run.",
    );
  }
  if (!updateAccepted) {
    return finish(
      "❌ REJECTED: the mutation ran, refused the change, and the collection stayed manual. The type appears immutable after creation — Phase 3 must NOT offer to convert a manual collection. See the step detail for the exact error.",
    );
  }
  return finish(
    "⚠ SILENT NO-OP: the mutation reported success but the collection has no ruleSet afterwards. Treat as \"not convertible\" — and note this is exactly the false-success pattern the echo rule exists for.",
  );
}
