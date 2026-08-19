/**
 * PLAN_CONTENT_CREATION §1.4b — the collection rule model, as MEASURED.
 *
 * Client-safe and shared with the server validator, the same arrangement as
 * `create-fields.config.ts`: the builder renders from this, the server refuses
 * anything not described here. A rule the client invents cannot reach Shopify.
 *
 * ── Why this is a union and not a triple ────────────────────────────────────
 * The plan was drafted around a generic `{column, relation, condition}`. That
 * is the OLD `ruleSet` shape. The 2026-07 model measured on a live shop
 * (PLAN §1.2a) is a discriminated union: one field per attribute, each with
 * its OWN relation enum and its own value shape. `productTag` knows
 * `TAGGED_WITH`; `productTitle` knows `EQUALS`/`CONTAINS`/…; `metafieldString`
 * knows only `EQUALS`. There is no shared vocabulary to flatten into.
 *
 * Three consequences the UI must not paper over:
 *
 *   1. EXCLUSIONS CAN DO STRICTLY LESS THAN INCLUSIONS — fewer kinds, and
 *      fewer relations within the kinds they share. `productTitle` can be
 *      included but not excluded; excluding by `productType` offers two
 *      relations where including offers six. Mirroring the inclusion list into
 *      the exclusion UI would offer combinations Shopify rejects.
 *   2. A LIST CONDITION HAS ITS OWN `matchType`, on top of the source's. Two
 *      levels, and the inner one is exactly what the legacy `ruleSet`
 *      projection drops.
 *   3. AN UNKNOWN CONDITION IS EXPECTED. Shopify ships
 *      `...ConditionUnknown` on both sides, so a client meeting a condition it
 *      cannot render is a designed-for case, not a bug — which is why §2.4's
 *      read-only rule is the intended behaviour and not merely our caution.
 *
 * ── Availability ────────────────────────────────────────────────────────────
 * `sources[]` exists from API 2026-07 on. Below that the app can still create
 * and edit MANUAL collections; the rule editor is simply not offered, with a
 * reason. `rulesAvailableOn()` is the one predicate for that.
 */

import { isSupportedApiVersion, type ShopifyApiVersionString } from "../utils/api-version";

/** The first API version carrying `CollectionCreateInput.sources`. */
export const RULES_MIN_API_VERSION = "2026-07";

/**
 * The editor value that means "these rules may not be edited" — a `ruleSet`
 * row (the lossy 2025-10 projection), an unsynced collection, a malformed
 * envelope.
 *
 * It exists because the editor's values are STRINGS, and `""` already means
 * something: no rules, editable, and saving it strips the collection's rules.
 * Collapsing "unknown" into "" would hand the merchant an empty builder over a
 * collection that has rules — and the first save would make the emptiness
 * true. Deliberately not valid JSON, so no parse path can mistake it for a
 * tree.
 */
export const RULES_UNREADABLE = "unreadable";

/**
 * Can the rule editor talk to this API version?
 *
 * Compared as strings on purpose: Shopify's versions are `YYYY-MM`, which
 * sorts lexicographically exactly as it sorts chronologically. `unstable` is
 * treated as newest, because it is.
 */
export function rulesAvailableOn(apiVersion: string): boolean {
  if (apiVersion === "unstable") return true;
  if (!isSupportedApiVersion(apiVersion)) return false;
  return (apiVersion as ShopifyApiVersionString) >= RULES_MIN_API_VERSION;
}

// ────────────────────────────────────────────────────────────────────────────
// The condition kinds, with their measured relations and value shapes
// ────────────────────────────────────────────────────────────────────────────

/** How a condition carries its value — three genuinely different shapes. */
export type ConditionValueShape =
  /** `{ relation, values: [...], matchType }` — the inner matchType lives here. */
  | "stringList"
  /** `{ relation, value }` with a scalar. */
  | "scalar"
  /** `{ relation, value | values, matchType?, definitionId }`. */
  | "metafield";

/**
 * How the READ side hands a kind's value back — MEASURED against the 2026-07
 * schema (2026-08-19), and the half §1.2a never probed because it introspected
 * the INPUT types only.
 *
 * Writing is flat: ids, strings and scalars. Reading is not — seven of the
 * kinds answer with OBJECTS, and a selection that asks for a bare `value` on
 * one of them is a schema-level error that fails the WHOLE query, which is how
 * the collection sync came to fail for every collection on the shop.
 */
export type ConditionValueRead =
  /** `values: [String!]` / `value: Int` — the value IS the payload. */
  | "scalar"
  /** `values { category { id } includeDescendants }` ↔ `{ categoryId, includeDescendants }`. */
  | "category"
  /** `value { amount currencyCode }` ↔ `MoneyInput`. */
  | "money"
  /** `value { value unit }` ↔ `WeightInput`. */
  | "weight"
  /** A node with an id — `Metaobject`, `Collection` — written back as that id. */
  | "gid";

/** `WeightInput.unit`, measured. */
export const WEIGHT_UNITS = ["KILOGRAMS", "GRAMS", "POUNDS", "OUNCES"] as const;
export type WeightUnit = (typeof WEIGHT_UNITS)[number];

export interface ConditionKindSpec {
  /** The field name inside `CollectionSourceInclusionConditionInput`. */
  key: string;
  shape: ConditionValueShape;
  /** THIS kind's relations. Never assume another kind's. */
  relations: readonly string[];
  /** `values` is a list ⇒ the condition carries its own matchType. */
  list: boolean;
  /** How Shopify hands the value BACK. Defaults to `scalar`. */
  read?: ConditionValueRead;
  /**
   * The one list kind whose INPUT has no `matchType`: an exclusion by
   * collection takes `values: [ID!]` and nothing else. Sending the field the
   * other list kinds require fails the mutation at the schema level.
   */
  omitMatchTypeOnWrite?: true;
  /** Scalar kinds name the input type so the UI can pick a control. */
  scalarType?: "Int" | "Decimal" | "Money" | "Weight" | "Boolean" | "ID" | "ProductStatus";
  /** Metafield kinds additionally require a definitionId. */
  needsDefinition?: boolean;
  /** i18n key under `t.collectionRules.kinds.*`. */
  labelKey: string;
}

const TEXTY = ["EQUALS", "NOT_EQUALS", "STARTS_WITH", "ENDS_WITH", "CONTAINS", "DOES_NOT_CONTAIN"] as const;

/** 18 kinds, measured against 2026-07 (PLAN §1.2a). */
export const INCLUSION_CONDITIONS: readonly ConditionKindSpec[] = [
  { key: "productTag", shape: "stringList", list: true, relations: ["TAGGED_WITH", "NOT_TAGGED_WITH"], labelKey: "productTag" },
  { key: "productTitle", shape: "stringList", list: true, relations: TEXTY, labelKey: "productTitle" },
  { key: "productType", shape: "stringList", list: true, relations: TEXTY, labelKey: "productType" },
  { key: "productVendor", shape: "stringList", list: true, relations: TEXTY, labelKey: "productVendor" },
  { key: "productCategory", shape: "stringList", list: true, read: "category", relations: ["EQUALS", "NOT_EQUALS"], labelKey: "productCategory" },
  { key: "productStatus", shape: "stringList", list: true, relations: ["EQUALS", "NOT_EQUALS"], scalarType: "ProductStatus", labelKey: "productStatus" },
  { key: "variantTitle", shape: "stringList", list: true, relations: TEXTY, labelKey: "variantTitle" },
  { key: "variantPrice", shape: "scalar", list: false, read: "money", relations: ["EQUALS", "NOT_EQUALS", "GREATER_THAN", "LESS_THAN"], scalarType: "Money", labelKey: "variantPrice" },
  {
    key: "variantCompareAtPrice",
    shape: "scalar",
    list: false,
    read: "money",
    relations: ["EQUALS", "NOT_EQUALS", "GREATER_THAN", "LESS_THAN", "IS_SET", "IS_NOT_SET"],
    scalarType: "Money",
    labelKey: "variantCompareAtPrice",
  },
  { key: "variantInventory", shape: "scalar", list: false, relations: ["EQUALS", "GREATER_THAN", "LESS_THAN"], scalarType: "Int", labelKey: "variantInventory" },
  { key: "variantWeight", shape: "scalar", list: false, read: "weight", relations: ["EQUALS", "NOT_EQUALS", "GREATER_THAN", "LESS_THAN"], scalarType: "Weight", labelKey: "variantWeight" },
  { key: "metafieldString", shape: "metafield", list: true, relations: ["EQUALS"], needsDefinition: true, labelKey: "metafieldString" },
  { key: "metafieldStringList", shape: "metafield", list: true, relations: ["INCLUDES"], needsDefinition: true, labelKey: "metafieldStringList" },
  { key: "metafieldInteger", shape: "metafield", list: false, relations: ["EQUALS", "GREATER_THAN", "LESS_THAN"], scalarType: "Int", needsDefinition: true, labelKey: "metafieldInteger" },
  { key: "metafieldDecimal", shape: "metafield", list: false, relations: ["EQUALS", "GREATER_THAN", "LESS_THAN"], scalarType: "Decimal", needsDefinition: true, labelKey: "metafieldDecimal" },
  { key: "metafieldBoolean", shape: "metafield", list: false, relations: ["EQUALS"], scalarType: "Boolean", needsDefinition: true, labelKey: "metafieldBoolean" },
  { key: "metafieldMetaobject", shape: "metafield", list: false, read: "gid", relations: ["EQUALS"], scalarType: "ID", needsDefinition: true, labelKey: "metafieldMetaobject" },
  { key: "metafieldMetaobjectList", shape: "metafield", list: true, read: "gid", relations: ["INCLUDES"], needsDefinition: true, labelKey: "metafieldMetaobjectList" },
];

/**
 * 5 kinds. NOT a subset by accident — `productType` and `productVendor` offer
 * two relations here where the inclusion side offers six, and `productTag`
 * offers one where inclusion offers two. Deriving this list from the inclusion
 * one would generate combinations Shopify rejects.
 */
export const EXCLUSION_CONDITIONS: readonly ConditionKindSpec[] = [
  { key: "productTag", shape: "stringList", list: true, relations: ["TAGGED_WITH"], labelKey: "productTag" },
  { key: "productType", shape: "stringList", list: true, relations: ["EQUALS", "CONTAINS"], labelKey: "productType" },
  { key: "productVendor", shape: "stringList", list: true, relations: ["EQUALS", "CONTAINS"], labelKey: "productVendor" },
  { key: "productCategory", shape: "stringList", list: true, read: "category", relations: ["EQUALS"], labelKey: "productCategory" },
  // The odd one out: no relation at all, and no matchType on the input either
  // — just a list of collection ids. It READS a matchType back, which is
  // exactly why the write side has to name the exception rather than infer it.
  { key: "collection", shape: "stringList", list: true, read: "gid", omitMatchTypeOnWrite: true, relations: [], scalarType: "ID", labelKey: "collection" },
];

export const CONDITION_MATCH_TYPES = ["ALL", "ANY"] as const;
export const SOURCE_TARGET_TYPES = ["PRODUCTS", "VARIANTS"] as const;

export type ConditionSide = "inclusion" | "exclusion";

export function conditionKinds(side: ConditionSide): readonly ConditionKindSpec[] {
  return side === "inclusion" ? INCLUSION_CONDITIONS : EXCLUSION_CONDITIONS;
}

export function conditionKind(side: ConditionSide, key: string): ConditionKindSpec | null {
  return conditionKinds(side).find((k) => k.key === key) ?? null;
}

// ────────────────────────────────────────────────────────────────────────────
// The editor's own value model
// ────────────────────────────────────────────────────────────────────────────

/**
 * One condition as the FORM holds it. Flat on purpose — the nesting Shopify
 * wants is built at submit time by `toConditionInput`, so the builder does not
 * have to carry a different shape per kind through its state.
 */
export interface RuleCondition {
  /** Stable within a session so React keys and edits survive reordering. */
  localId: string;
  /**
   * Shopify's own condition id, present only on a condition READ back.
   *
   * This is what makes editing a source a diff rather than a replace:
   * `conditionsToUpdate`/`ToDelete` are keyed by it (PLAN §1.2a). A condition
   * without one is new by definition — and an id the CACHE does not know is
   * not an identity at all, because the payload is client-supplied.
   */
  id?: string;
  kind: string;
  relation: string;
  /** Comma-separated for list kinds; the single value for scalar kinds. */
  value: string;
  /** List kinds only — the condition's OWN matchType (the second level). */
  matchType?: (typeof CONDITION_MATCH_TYPES)[number];
  /** Metafield kinds only. */
  definitionId?: string;
  /**
   * `productCategory` only. Shopify stores it PER VALUE; the form holds one
   * flag for the whole condition, so a condition whose values disagree is read
   * as unrenderable rather than flattened onto the first value's answer — the
   * §2.4 rule, at the one place this model is narrower than the API's.
   */
  includeDescendants?: boolean;
  /** `variantWeight` only. `WeightInput` requires a unit; a bare number is a
   *  schema error, and guessing the unit changes which products match. */
  weightUnit?: WeightUnit;
  /** The money kinds only. `MoneyInput` requires a currency; the value read
   *  back carries the shop's, and a new condition is given it by the form. */
  currencyCode?: string;
}

export interface RuleSide {
  matchType: (typeof CONDITION_MATCH_TYPES)[number];
  conditions: RuleCondition[];
}

export interface RuleSource {
  /** Present when editing an existing source; absent when creating one. */
  id?: string;
  title: string;
  description?: string;
  targetType?: (typeof SOURCE_TARGET_TYPES)[number];
  inclusion: RuleSide;
  exclusion?: RuleSide;
  /**
   * §2.4's read-only rule, made concrete: a source the editor cannot fully
   * represent — sub-collections, a shareable source, a condition kind it does
   * not know — is carried UNCHANGED and never submitted as an update. The raw
   * tree is kept so it can be displayed, and so nothing about it is lost by
   * having passed through this app.
   */
  unrenderable?: {
    reason: "subCollections" | "shareableSource" | "unknownCondition" | "unknownSource";
    raw?: unknown;
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Validation — the same rules on both sides
// ────────────────────────────────────────────────────────────────────────────

export interface RuleValidationError {
  sourceIndex: number;
  conditionId?: string;
  code: "noConditions" | "unknownKind" | "unknownRelation" | "emptyValue" | "missingDefinition" | "noTitle" | "tooManySources";
  detail?: string;
}

/** Shopify has no documented cap; this is ours, to keep a form usable. */
export const MAX_SOURCES = 10;

export function validateRuleSources(sources: RuleSource[]): RuleValidationError[] {
  const errors: RuleValidationError[] = [];

  if (sources.length > MAX_SOURCES) {
    errors.push({ sourceIndex: -1, code: "tooManySources", detail: `${sources.length}/${MAX_SOURCES}` });
  }

  sources.forEach((source, sourceIndex) => {
    // A source we cannot render is not validated — it is passed through
    // untouched, so holding it to this editor's rules would be wrong.
    if (source.unrenderable) return;

    if (!source.title.trim()) errors.push({ sourceIndex, code: "noTitle" });

    if (source.inclusion.conditions.length === 0) {
      // A source with no inclusion matches nothing, which is never what
      // someone building one meant.
      errors.push({ sourceIndex, code: "noConditions" });
    }

    for (const [side, block] of [
      ["inclusion", source.inclusion] as const,
      ["exclusion", source.exclusion] as const,
    ]) {
      if (!block) continue;
      for (const condition of block.conditions) {
        const spec = conditionKind(side, condition.kind);
        if (!spec) {
          errors.push({ sourceIndex, conditionId: condition.localId, code: "unknownKind", detail: `${side}.${condition.kind}` });
          continue;
        }
        // Relations are per KIND and per SIDE. Excluding by productType offers
        // two where including offers six; accepting the inclusion set here
        // would build a payload Shopify rejects.
        if (spec.relations.length > 0 && !spec.relations.includes(condition.relation)) {
          errors.push({ sourceIndex, conditionId: condition.localId, code: "unknownRelation", detail: `${condition.kind}.${condition.relation}` });
        }
        if (spec.needsDefinition && !condition.definitionId?.trim()) {
          errors.push({ sourceIndex, conditionId: condition.localId, code: "missingDefinition" });
        }
        // IS_SET / IS_NOT_SET are the only relations that carry no value.
        const valueless = condition.relation === "IS_SET" || condition.relation === "IS_NOT_SET";
        if (!valueless && !condition.value.trim()) {
          errors.push({ sourceIndex, conditionId: condition.localId, code: "emptyValue" });
        }
      }
    }
  });

  return errors;
}

// ────────────────────────────────────────────────────────────────────────────
// Form value → Shopify input
// ────────────────────────────────────────────────────────────────────────────

function splitList(value: string): string[] {
  return value.split(",").map((v) => v.trim()).filter(Boolean);
}

/** One condition, in the nested shape `CollectionSourceInclusionConditionInput` wants. */
export function toConditionInput(side: ConditionSide, condition: RuleCondition): Record<string, unknown> | null {
  const spec = conditionKind(side, condition.kind);
  if (!spec) return null;

  const inner: Record<string, unknown> = {};
  if (spec.relations.length > 0) inner.relation = condition.relation;
  if (spec.needsDefinition && condition.definitionId) inner.definitionId = condition.definitionId;

  const valueless = condition.relation === "IS_SET" || condition.relation === "IS_NOT_SET";
  if (!valueless) {
    // The three read shapes whose INPUT is an object too, measured
    // (2026-08-19). Tested before `spec.list`, because `category` is a list
    // and the two others are not. `gid` is deliberately absent: it reads as a
    // node and writes as the bare id, so the plain branches below are right
    // for it.
    if (spec.read === "category") {
      inner.values = splitList(condition.value).map((categoryId) => ({
        categoryId,
        includeDescendants: condition.includeDescendants === true,
      }));
      inner.matchType = condition.matchType ?? "ANY";
    } else if (spec.read === "money") {
      inner.value = {
        amount: condition.value.replace(",", "."),
        currencyCode: condition.currencyCode || "XXX",
      };
    } else if (spec.read === "weight") {
      inner.value = {
        value: Number.parseFloat(condition.value.replace(",", ".")),
        unit: condition.weightUnit ?? "KILOGRAMS",
      };
    } else if (spec.list) {
      inner.values = splitList(condition.value);
      // The condition's OWN matchType — the level the legacy ruleSet
      // projection silently drops. The one input that does not take it says so
      // on its spec; inferring it from "is a list" is what made the exclusion
      // by collection unsavable.
      if (!spec.omitMatchTypeOnWrite) inner.matchType = condition.matchType ?? "ANY";
    } else if (spec.scalarType === "Int") {
      inner.value = Number.parseInt(condition.value, 10);
    } else if (spec.scalarType === "Decimal") {
      inner.value = condition.value.replace(",", ".");
    } else if (spec.scalarType === "Boolean") {
      inner.value = condition.value === "true";
    } else {
      inner.value = condition.value;
    }
  }

  return { [condition.kind]: inner };
}

/**
 * The full `sources[]` payload for `collectionCreate` / `collectionUpdate`.
 *
 * Sources the editor could not render are OMITTED, not rewritten — that is
 * §2.4's read-only rule at the point where it actually bites. Because Shopify
 * edits sources by diff (`sourcesToCreate`/`ToUpdate`/`ToDelete`, each keyed
 * by id), leaving one out of the payload leaves it untouched on Shopify's
 * side. Not touching what we cannot represent is mechanical here rather than
 * a matter of discipline.
 */
export function toSourcesInput(sources: RuleSource[]): Array<Record<string, unknown>> {
  return sources
    .filter((source) => !source.unrenderable)
    .map((source) => {
      const inclusion: Record<string, unknown> = {
        matchType: source.inclusion.matchType,
        conditions: source.inclusion.conditions
          .map((c) => toConditionInput("inclusion", c))
          .filter((c): c is Record<string, unknown> => c !== null),
      };

      const target: Record<string, unknown> = {
        source: {
          title: source.title.trim(),
          ...(source.description ? { description: source.description } : {}),
          ...(source.targetType ? { targetType: source.targetType } : {}),
          inclusion,
          ...(source.exclusion && source.exclusion.conditions.length > 0
            ? {
                exclusion: {
                  matchType: source.exclusion.matchType,
                  conditions: source.exclusion.conditions
                    .map((c) => toConditionInput("exclusion", c))
                    .filter((c): c is Record<string, unknown> => c !== null),
                },
              }
            : {}),
        },
      };
      return target;
    });
}

/**
 * A fresh, valid-by-construction condition for a kind.
 *
 * `defaults.currencyCode` is the SHOP's currency, threaded down from the route
 * — `MoneyInput` requires one, and a condition built without it falls back to
 * `XXX` (the ISO placeholder for "no currency"), which is what this app sent
 * before the shape was measured. Passing the real one is strictly better; not
 * having it must not make the price kinds unusable.
 */
export function newCondition(
  side: ConditionSide,
  kind: string,
  localId: string,
  defaults?: { currencyCode?: string },
): RuleCondition {
  const spec = conditionKind(side, kind);
  return {
    localId,
    kind,
    relation: spec?.relations[0] ?? "",
    value: "",
    matchType: spec?.list ? "ANY" : undefined,
    definitionId: spec?.needsDefinition ? "" : undefined,
    ...(spec?.read === "weight" ? { weightUnit: "KILOGRAMS" as WeightUnit } : {}),
    ...(spec?.read === "money" ? { currencyCode: defaults?.currencyCode || undefined } : {}),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Reading Shopify's tree back, and turning an edit into a DIFF
// ────────────────────────────────────────────────────────────────────────────

/**
 * ── Why reading is harder than writing ──────────────────────────────────────
 * Writing is an INPUT object: `{ productTag: { relation, values, matchType } }`,
 * one measured shape per kind (§1.2a). Reading is a UNION — Shopify returns
 * `conditions[]` whose members are distinct object types, and a client must
 * name each one in an inline fragment to see its fields.
 *
 * The member type NAMES are the one thing §1.2a did not measure: the probe
 * introspected the input side. So `readConditionTypename` derives them from the
 * kinds this module already knows, and the collection probe VERIFIES that
 * derivation against a live 2026-07 shop (Settings → Collection Probe). Until
 * it does, the derivation is a hypothesis — which is why a condition whose
 * `__typename` this module does not recognise makes its whole SOURCE
 * `unrenderable` instead of being dropped. §2.4's rule, doing real work: a
 * source carried unchanged cannot lose a condition nobody could read.
 */

/**
 * `productTag` (inclusion) → `CollectionSourceInclusionConditionProductTag`.
 *
 * MEASURED (2026-08-19), not derived: the first cut guessed
 * `CollectionRule<Kind>Condition` and every inline fragment on it was a
 * schema error. Shopify additionally ships `…ConditionUnknown` on both sides,
 * which this app deliberately never names — an unrecognised `__typename`
 * makes the whole SOURCE unrenderable, which is §2.4 doing its job.
 */
export function readConditionTypename(side: ConditionSide, kind: string): string {
  const capitalized = kind.charAt(0).toUpperCase() + kind.slice(1);
  return `CollectionSource${side === "inclusion" ? "Inclusion" : "Exclusion"}Condition${capitalized}`;
}

/**
 * Every field of a condition is read under a name of its OWN, and that is not
 * cosmetic.
 *
 * Each kind has its own `relation` ENUM (`…ProductTagRelation` vs
 * `…VariantPriceRelation`), its own `values` element type and, for seven of
 * them, an object where the others have a scalar. GraphQL's overlapping-fields rule
 * compares the RESPONSE SHAPE of fields that share a response name across
 * sibling fragments — two different enums are two different shapes — so
 * selecting a bare `relation` in all eighteen fragments is a validation error
 * per PAIR of kinds, and the server refuses the document before it looks at
 * anything else. Aliasing per kind is what makes one selection over an
 * interface possible at all; the reader looks the values back up by the same
 * rule (`aliasFor`), so the two cannot drift.
 *
 * `id` is the exception: it is declared on the INTERFACE, identical on every
 * member, and it is what the diff keys on.
 */
function aliasFor(kind: string, field: string): string {
  return `${kind}_${field}`;
}

/**
 * What to select for one kind's value.
 *
 * MEASURED (2026-08-19): four of the five read shapes answer with an OBJECT,
 * and asking for a bare `value` on one of them is a schema error — which takes
 * the WHOLE query down rather than that one field.
 */
function readValueSelection(spec: ConditionKindSpec): string {
  const name = spec.list ? "values" : "value";
  const alias = `${aliasFor(spec.key, name)}: ${name}`;
  switch (spec.read) {
    case "category":
      return `${alias} { category { id } includeDescendants }`;
    case "money":
      return `${alias} { amount currencyCode }`;
    case "weight":
      return `${alias} { value unit }`;
    case "gid":
      return `${alias} { id }`;
    default:
      return alias;
  }
}

/** The inline fragments for one side, generated from the kind specs so the read
 *  selection can never drift from the write mapping. */
export function readConditionFragments(side: ConditionSide): string {
  return conditionKinds(side)
    .map((spec) => {
      const value = readValueSelection(spec);
      const matchType = spec.list ? `\n                    ${aliasFor(spec.key, "matchType")}: matchType` : "";
      const relation =
        spec.relations.length > 0 ? `\n                    ${aliasFor(spec.key, "relation")}: relation` : "";
      // A metafield condition reports its DEFINITION as a node, while the
      // input takes a bare `definitionId`: the id has to be dug out again.
      const definition = spec.needsDefinition
        ? `\n                    ${aliasFor(spec.key, "definition")}: definition { id }`
        : "";
      // `id` first and unconditionally: without it an existing condition has
      // no identity, and every save would have to delete-and-recreate the
      // whole side — the replace this module exists to avoid.
      return `                  ... on ${readConditionTypename(side, spec.key)} {
                    id${relation}
                    ${value}${matchType}${definition}
                  }`;
    })
    .join("\n");
}

/**
 * One condition as the read selection delivers it: `__typename` and `id` under
 * their own names, everything else under the per-kind ALIAS the selection had
 * to use (`aliasFor`).
 */
interface RawCondition {
  __typename?: string;
  id?: string | null;
  [alias: string]: unknown;
}

/** The aliased field of a condition, or `undefined`. */
function aliased(condition: RawCondition, kind: string, field: string): unknown {
  return condition[aliasFor(kind, field)];
}

interface RawSide {
  matchType?: string | null;
  conditions?: RawCondition[] | null;
  /** Hand-picked products/variants. The editor does not render these, and a
   *  source that has any is carried unchanged rather than flattened. It is a
   *  CONNECTION — read with `first: 1`, because "are there any" is the whole
   *  question. */
  selections?: { nodes?: unknown[] | null } | null;
}

/**
 * One entry of `Collection.sources`, as MEASURED (2026-08-19).
 *
 * `CollectionSource` is an interface with two members: `CollectionConditionsSource`
 * (everything below `targetType`) and `CollectionSubCollectionsSource`. There is
 * no `shareableSource` MEMBER — a shareable source is a conditions source with
 * `shareable: true`, which is the branch the create input calls
 * `shareableSource`.
 */
export interface RawSource {
  __typename?: string;
  id?: string | null;
  title?: string | null;
  description?: string | null;
  targetType?: string | null;
  /** True when this source is shared with other collections. */
  shareable?: boolean | null;
  inclusion?: RawSide | null;
  exclusion?: RawSide | null;
}

/** The one source type this editor renders; anything else is carried untouched. */
const CONDITIONS_SOURCE_TYPENAME = "CollectionConditionsSource";
const SUB_COLLECTIONS_SOURCE_TYPENAME = "CollectionSubCollectionsSource";

function matchTypeOf(raw: string | null | undefined): (typeof CONDITION_MATCH_TYPES)[number] {
  return raw === "ANY" ? "ANY" : "ALL";
}

/** The extra bits a kind's OBJECT value carries next to the text the form holds. */
interface DecodedValue {
  value: string;
  includeDescendants?: boolean;
  weightUnit?: WeightUnit;
  currencyCode?: string;
}

function idsOf(values: unknown): string[] {
  return Array.isArray(values)
    ? values.map((v) => String((v as { id?: unknown })?.id ?? "")).filter(Boolean)
    : [];
}

/**
 * Shopify's value → the form's flat string, plus whatever does not fit in it.
 *
 * `null` means "this condition cannot be represented", which makes its whole
 * SOURCE read-only (§2.4). It is returned for exactly one case that a joined
 * string really cannot hold: a category condition whose values disagree about
 * `includeDescendants`, where the form has one checkbox for the condition.
 * Flattening that onto the first value's answer would change which products
 * the collection contains on the next save.
 */
function decodeConditionValue(spec: ConditionKindSpec, condition: RawCondition): DecodedValue | null {
  const rawValue = aliased(condition, spec.key, spec.list ? "values" : "value");
  switch (spec.read) {
    case "category": {
      const entries = Array.isArray(rawValue) ? rawValue : [];
      const ids = entries.map((e) => String((e as { category?: { id?: unknown } })?.category?.id ?? "")).filter(Boolean);
      const flags = new Set(entries.map((e) => (e as { includeDescendants?: unknown })?.includeDescendants === true));
      if (flags.size > 1) return null;
      return { value: ids.join(", "), includeDescendants: flags.has(true) };
    }
    case "money": {
      const money = rawValue as { amount?: unknown; currencyCode?: unknown } | null;
      return {
        value: money?.amount == null ? "" : String(money.amount),
        ...(typeof money?.currencyCode === "string" ? { currencyCode: money.currencyCode } : {}),
      };
    }
    case "weight": {
      const weight = rawValue as { value?: unknown; unit?: unknown } | null;
      // An unknown unit is not rounded to kilograms: the number would keep its
      // digits and change its meaning, which is the one thing a rule editor
      // may never do quietly.
      if (weight?.unit != null && !WEIGHT_UNITS.includes(weight.unit as WeightUnit)) return null;
      return {
        value: weight?.value == null ? "" : String(weight.value),
        ...(weight?.unit ? { weightUnit: weight.unit as WeightUnit } : {}),
      };
    }
    case "gid":
      return spec.list
        ? { value: idsOf(rawValue).join(", ") }
        : { value: String((rawValue as { id?: unknown })?.id ?? "") };
    default: {
      const values = Array.isArray(rawValue) ? rawValue.map((v) => String(v)) : null;
      return { value: values ? values.join(", ") : String(rawValue ?? "") };
    }
  }
}

/** `__typename` → the kind key this module knows, or null. */
function kindForTypename(side: ConditionSide, typename: string | undefined): ConditionKindSpec | null {
  if (!typename) return null;
  return conditionKinds(side).find((spec) => readConditionTypename(side, spec.key) === typename) ?? null;
}

function readSide(side: ConditionSide, raw: RawSide | null | undefined): { parsed: RuleSide; readable: boolean } {
  const conditions: RuleCondition[] = [];
  let readable = true;
  // A hand-picked selection has no representation in this editor. Rendering
  // the conditions and dropping the selections would silently change which
  // products the collection contains — the §2.4 failure exactly.
  if ((raw?.selections?.nodes?.length ?? 0) > 0) readable = false;

  for (const [index, condition] of (raw?.conditions ?? []).entries()) {
    const spec = kindForTypename(side, condition.__typename);
    if (!spec) {
      readable = false;
      continue;
    }
    const decoded = decodeConditionValue(spec, condition);
    if (!decoded) {
      readable = false;
      continue;
    }
    const definitionId = (aliased(condition, spec.key, "definition") as { id?: string } | null)?.id;
    conditions.push({
      localId: `read-${side}-${index}`,
      ...(condition.id ? { id: condition.id } : {}),
      kind: spec.key,
      relation: String(aliased(condition, spec.key, "relation") ?? spec.relations[0] ?? ""),
      value: decoded.value,
      ...(decoded.includeDescendants !== undefined ? { includeDescendants: decoded.includeDescendants } : {}),
      ...(decoded.weightUnit ? { weightUnit: decoded.weightUnit } : {}),
      ...(decoded.currencyCode ? { currencyCode: decoded.currencyCode } : {}),
      ...(spec.list ? { matchType: matchTypeOf(aliased(condition, spec.key, "matchType") as string | null) } : {}),
      ...(spec.needsDefinition && definitionId ? { definitionId } : {}),
    });
  }

  return { parsed: { matchType: matchTypeOf(raw?.matchType), conditions }, readable };
}

/**
 * Shopify's `sources[]` → the editor's model.
 *
 * A source this editor cannot fully represent keeps its raw tree and is marked
 * `unrenderable`. It is then DISPLAYED but never submitted as an update, so
 * passing through this app cannot cost a collection a rule it depends on.
 */
export function fromShopifySources(raw: RawSource[] | null | undefined): RuleSource[] {
  return (raw ?? []).map((source, index) => {
    const base: RuleSource = {
      ...(source.id ? { id: source.id } : {}),
      title: source.title ?? `Source ${index + 1}`,
      ...(source.description ? { description: source.description } : {}),
      ...(source.targetType === "VARIANTS" ? { targetType: "VARIANTS" as const } : {}),
      inclusion: { matchType: "ALL", conditions: [] },
    };

    // The shapes with no editor at all (§2.4). Checked first — their
    // conditions are not the point, their SHAPE is. All three are decided on
    // the source's OWN typename and flag: `subCollections` and
    // `shareableSource` are branches of the INPUT, and reading them back as
    // fields (which the first cut did) finds nothing, so every source would
    // have read as an ordinary one.
    if (source.__typename === SUB_COLLECTIONS_SOURCE_TYPENAME) {
      return { ...base, unrenderable: { reason: "subCollections", raw: source } };
    }
    // A shared source governs OTHER collections too, so editing it here would
    // change memberships nobody looked at.
    if (source.shareable === true) {
      return { ...base, unrenderable: { reason: "shareableSource", raw: source } };
    }
    // A member of the interface this app does not know — a type Shopify adds
    // later. An absent typename is the same answer: the read selection always
    // asks for it, so its absence means this tree did not come from that read.
    if (source.__typename !== CONDITIONS_SOURCE_TYPENAME) {
      return { ...base, unrenderable: { reason: "unknownSource", raw: source } };
    }

    const inclusion = readSide("inclusion", source.inclusion);
    const exclusion = source.exclusion ? readSide("exclusion", source.exclusion) : null;
    if (!inclusion.readable || (exclusion && !exclusion.readable)) {
      return { ...base, unrenderable: { reason: "unknownCondition", raw: source } };
    }

    return {
      ...base,
      inclusion: inclusion.parsed,
      ...(exclusion && exclusion.parsed.conditions.length > 0 ? { exclusion: exclusion.parsed } : {}),
    };
  });
}

/**
 * The rule sources an editor may TOUCH, from the stored `sourcesJson` envelope.
 *
 * `null` is not "no rules" — it is "nothing here may be edited". Three cases
 * produce it, and collapsing any of them into an empty list would hand the
 * merchant a blank builder over a collection that has rules, which the first
 * save would then make true:
 *
 *   1. Not a `sources` envelope — a `ruleSet` row is the 2025-10 back-
 *      projection and has already lost exclusions and extra sources
 *      (CLAUDE.md), so it is not a base to edit from.
 *   2. Nothing stored at all — an unsynced collection.
 *   3. A tree written before the read path selected CONDITION ids. Diffing
 *      against it would match nothing: every condition the client holds would
 *      read as new, none as kept, none as removed — and the collection would
 *      end up with its rules doubled. An id-less condition is a stale cache,
 *      not an empty one ("an empty column is never evidence").
 *
 * One function for both sides on purpose: the loader decides what the merchant
 * may edit and the write path decides what it will diff, and those two answers
 * disagreeing is how an editor offers a control whose save then refuses.
 */
export function editableSourcesFromEnvelope(envelope: unknown): RuleSource[] | null {
  if (!envelope || typeof envelope !== "object") return null;
  const { shape, data } = envelope as { shape?: string; data?: unknown };
  if (shape !== "sources" || !Array.isArray(data)) return null;

  const sources = fromShopifySources(data as RawSource[]);
  const stale = sources.some(
    (source) =>
      !source.unrenderable &&
      [source.inclusion, source.exclusion].some((side) => side?.conditions.some((c) => !c.id)),
  );
  return stale ? null : sources;
}

/**
 * The same sources with the raw trees dropped, for the trip to the browser.
 *
 * `unrenderable.raw` is the untouched Shopify sub-tree — the whole point of
 * which is that it never leaves the server: the diff's BEFORE side comes from
 * the cache, and an unrenderable source is skipped in every direction. Sending
 * it down would put an arbitrarily large blob into every collection page load
 * and every save, and would hand the client a tree it has no legitimate use
 * for. The `reason` is what the builder actually renders.
 */
export function withoutRawTrees(sources: RuleSource[]): RuleSource[] {
  return sources.map((source) =>
    source.unrenderable ? { ...source, unrenderable: { reason: source.unrenderable.reason } } : source,
  );
}

export interface RuleSourcesDiff {
  /** `CollectionCreateSourceTargetInput` — `{ source: { … } }`, measured. */
  sourcesToCreate: Array<Record<string, unknown>>;
  /** `CollectionUpdateSourceTargetInput` — `{ condition: { id, … } }`. */
  sourcesToUpdate: Array<Record<string, unknown>>;
  sourcesToDelete: string[];
}

/**
 * ── Why updating a source is itself a diff ──────────────────────────────────
 * `CollectionUpdateSourceInclusionInput` does not take a `conditions` list. It
 * takes `conditionsToCreate` / `conditionsToUpdate` / `conditionsToDelete`
 * (plus `selectionsToAdd`/`ToRemove`), and `CollectionUpdateConditionsSourceInput`
 * requires `id: ID!` — PLAN §1.2a, introspected on a live 2026-07 shop. There
 * is no "write the whole list back" on this side of the API, which is why the
 * read path selects condition ids (`readConditionFragments`) at all.
 *
 * Comparison is done on the BUILT INPUT, not on the form fields: two
 * conditions that produce the same payload are the same condition as far as
 * Shopify is concerned, so re-typing a comma list with different spacing must
 * not churn a rule and re-run a membership calculation.
 */
function conditionInputsEqual(a: Record<string, unknown> | null, b: Record<string, unknown> | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function diffSide(
  side: ConditionSide,
  before: RuleSide | undefined,
  after: RuleSide | undefined,
): Record<string, unknown> | null {
  const beforeById = new Map(
    (before?.conditions ?? []).filter((c) => c.id).map((c) => [c.id as string, c] as const),
  );

  const conditionsToCreate: Array<Record<string, unknown>> = [];
  const conditionsToUpdate: Array<Record<string, unknown>> = [];
  const keptIds = new Set<string>();

  for (const condition of after?.conditions ?? []) {
    const input = toConditionInput(side, condition);
    if (!input) continue;
    // An id the cache does not carry is a client CLAIM, not an identity. It is
    // created as new rather than updated in place: honouring it would let a
    // crafted payload rewrite a condition this editor never read.
    const previous = condition.id ? beforeById.get(condition.id) : undefined;
    if (!previous) {
      conditionsToCreate.push(input);
      continue;
    }
    keptIds.add(previous.id as string);
    if (!conditionInputsEqual(toConditionInput(side, previous), input)) {
      // `CollectionUpdateSourceInclusionConditionInput` is `{ id, condition }`
      // — the kind key lives INSIDE `condition`, not beside the id. Measured
      // 2026-08-19; spreading it next to the id is a schema-level error, which
      // never reaches `userErrors` and would read as a successful save.
      conditionsToUpdate.push({ id: previous.id, condition: input });
    }
  }

  const conditionsToDelete = [...beforeById.keys()].filter((id) => !keptIds.has(id));

  // A side that vanished entirely keeps its old matchType rather than
  // defaulting it — the merchant deleted conditions, not a setting.
  const matchType = after?.matchType ?? before?.matchType ?? "ALL";
  const matchTypeChanged = (before?.matchType ?? "ALL") !== matchType;

  if (
    conditionsToCreate.length === 0 &&
    conditionsToUpdate.length === 0 &&
    conditionsToDelete.length === 0 &&
    !matchTypeChanged
  ) {
    return null;
  }

  return {
    matchType,
    ...(conditionsToCreate.length > 0 ? { conditionsToCreate } : {}),
    ...(conditionsToUpdate.length > 0 ? { conditionsToUpdate } : {}),
    ...(conditionsToDelete.length > 0 ? { conditionsToDelete } : {}),
  };
}

/** One `CollectionUpdateSourceTargetInput`, or null when nothing changed. */
function buildSourceUpdate(before: RuleSource, after: RuleSource): Record<string, unknown> | null {
  const inclusion = diffSide("inclusion", before.inclusion, after.inclusion);
  const exclusion = diffSide("exclusion", before.exclusion, after.exclusion);

  const title = after.title.trim();
  const titleChanged = title !== before.title.trim();
  const description = (after.description ?? "").trim();
  const descriptionChanged = description !== (before.description ?? "").trim();

  if (!inclusion && !exclusion && !titleChanged && !descriptionChanged) return null;

  // `targetType` is deliberately absent: it is a property of the source's
  // SHAPE, and the update input offers no way to change it. Sending it on a
  // create is right; sending it here would be inventing a field.
  return {
    condition: {
      id: before.id,
      ...(titleChanged ? { title } : {}),
      ...(descriptionChanged ? { description } : {}),
      ...(inclusion ? { inclusion } : {}),
      ...(exclusion ? { exclusion } : {}),
    },
  };
}

/**
 * Turns "what the editor now holds" into the three lists `collectionUpdate`
 * takes. A REPLACE would be the obvious implementation and the wrong one:
 * Shopify keys sources by id, and re-creating them all would churn every
 * membership on every save.
 *
 * Three rules carry the §2.4 guarantee:
 *
 *   - An UNRENDERABLE source is never created, never updated and never
 *     deleted. It is invisible to this diff in every direction, so a
 *     collection using a feature the editor does not speak survives a save
 *     untouched.
 *   - A source is only DELETED when it was read as renderable and the editor
 *     no longer holds it. An id that vanished because it could not be parsed
 *     must not be read as "the merchant removed it".
 *   - An `after` source whose id the BEFORE side does not carry is DROPPED,
 *     not created and not updated. `before` comes from the cache and `after`
 *     from the client, so an unknown id is either a stale cache — in which
 *     case dropping it leaves Shopify's own copy untouched, the correct
 *     outcome — or a crafted payload aimed at a source this editor is not
 *     allowed to touch, including an unrenderable one.
 */
export function diffRuleSources(before: RuleSource[], after: RuleSource[]): RuleSourcesDiff {
  const renderableBefore = before.filter((s) => !s.unrenderable && s.id);
  const beforeById = new Map(renderableBefore.map((s) => [s.id as string, s] as const));

  const sourcesToCreate: Array<Record<string, unknown>> = [];
  const sourcesToUpdate: Array<Record<string, unknown>> = [];
  const keptIds = new Set<string>();

  for (const source of after) {
    // Untouched by definition — see the rules above.
    if (source.unrenderable) continue;

    if (!source.id) {
      const [input] = toSourcesInput([source]);
      if (input) sourcesToCreate.push(input);
      continue;
    }

    const previous = beforeById.get(source.id);
    if (!previous) continue;
    keptIds.add(source.id);

    const update = buildSourceUpdate(previous, source);
    if (update) sourcesToUpdate.push(update);
  }

  const sourcesToDelete = renderableBefore
    .map((s) => s.id as string)
    .filter((id) => !keptIds.has(id));

  return { sourcesToCreate, sourcesToUpdate, sourcesToDelete };
}
