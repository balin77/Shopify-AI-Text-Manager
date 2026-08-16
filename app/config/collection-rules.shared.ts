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

export interface ConditionKindSpec {
  /** The field name inside `CollectionSourceInclusionConditionInput`. */
  key: string;
  shape: ConditionValueShape;
  /** THIS kind's relations. Never assume another kind's. */
  relations: readonly string[];
  /** `values` is a list ⇒ the condition carries its own matchType. */
  list: boolean;
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
  { key: "productCategory", shape: "stringList", list: true, relations: ["EQUALS", "NOT_EQUALS"], labelKey: "productCategory" },
  { key: "productStatus", shape: "stringList", list: true, relations: ["EQUALS", "NOT_EQUALS"], scalarType: "ProductStatus", labelKey: "productStatus" },
  { key: "variantTitle", shape: "stringList", list: true, relations: TEXTY, labelKey: "variantTitle" },
  { key: "variantPrice", shape: "scalar", list: false, relations: ["EQUALS", "NOT_EQUALS", "GREATER_THAN", "LESS_THAN"], scalarType: "Money", labelKey: "variantPrice" },
  {
    key: "variantCompareAtPrice",
    shape: "scalar",
    list: false,
    relations: ["EQUALS", "NOT_EQUALS", "GREATER_THAN", "LESS_THAN", "IS_SET", "IS_NOT_SET"],
    scalarType: "Money",
    labelKey: "variantCompareAtPrice",
  },
  { key: "variantInventory", shape: "scalar", list: false, relations: ["EQUALS", "GREATER_THAN", "LESS_THAN"], scalarType: "Int", labelKey: "variantInventory" },
  { key: "variantWeight", shape: "scalar", list: false, relations: ["EQUALS", "NOT_EQUALS", "GREATER_THAN", "LESS_THAN"], scalarType: "Weight", labelKey: "variantWeight" },
  { key: "metafieldString", shape: "metafield", list: true, relations: ["EQUALS"], needsDefinition: true, labelKey: "metafieldString" },
  { key: "metafieldStringList", shape: "metafield", list: true, relations: ["INCLUDES"], needsDefinition: true, labelKey: "metafieldStringList" },
  { key: "metafieldInteger", shape: "metafield", list: false, relations: ["EQUALS", "GREATER_THAN", "LESS_THAN"], scalarType: "Int", needsDefinition: true, labelKey: "metafieldInteger" },
  { key: "metafieldDecimal", shape: "metafield", list: false, relations: ["EQUALS", "GREATER_THAN", "LESS_THAN"], scalarType: "Decimal", needsDefinition: true, labelKey: "metafieldDecimal" },
  { key: "metafieldBoolean", shape: "metafield", list: false, relations: ["EQUALS"], scalarType: "Boolean", needsDefinition: true, labelKey: "metafieldBoolean" },
  { key: "metafieldMetaobject", shape: "metafield", list: false, relations: ["EQUALS"], scalarType: "ID", needsDefinition: true, labelKey: "metafieldMetaobject" },
  { key: "metafieldMetaobjectList", shape: "metafield", list: true, relations: ["INCLUDES"], needsDefinition: true, labelKey: "metafieldMetaobjectList" },
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
  { key: "productCategory", shape: "stringList", list: true, relations: ["EQUALS"], labelKey: "productCategory" },
  // The odd one out: no relation at all, just a list of collection ids.
  { key: "collection", shape: "stringList", list: true, relations: [], scalarType: "ID", labelKey: "collection" },
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
  kind: string;
  relation: string;
  /** Comma-separated for list kinds; the single value for scalar kinds. */
  value: string;
  /** List kinds only — the condition's OWN matchType (the second level). */
  matchType?: (typeof CONDITION_MATCH_TYPES)[number];
  /** Metafield kinds only. */
  definitionId?: string;
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
  unrenderable?: { reason: "subCollections" | "shareableSource" | "unknownCondition"; raw: unknown };
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
    if (spec.list) {
      inner.values = splitList(condition.value);
      // The condition's OWN matchType — the level the legacy ruleSet
      // projection silently drops.
      inner.matchType = condition.matchType ?? "ANY";
    } else if (spec.scalarType === "Money") {
      inner.value = { amount: condition.value.replace(",", "."), currencyCode: "XXX" };
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

/** A fresh, valid-by-construction condition for a kind. */
export function newCondition(side: ConditionSide, kind: string, localId: string): RuleCondition {
  const spec = conditionKind(side, kind);
  return {
    localId,
    kind,
    relation: spec?.relations[0] ?? "",
    value: "",
    matchType: spec?.list ? "ANY" : undefined,
    definitionId: spec?.needsDefinition ? "" : undefined,
  };
}
