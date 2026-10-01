/**
 * @vitest-environment node
 *
 * The collection rule model, checked against Shopify's REAL 2026-07 schema.
 *
 * Opt-in (`SHOPIFY_SCHEMA_CHECK=1 npm run test`) because it fetches: the
 * ordinary suite must not depend on the network. It exists because the first
 * cut of the read path was DERIVED from the input types §1.2a had probed, and
 * every one of its guesses failed the whole `getCollection` query — the
 * collection sync stopped for every collection on the shop, with a schema-level
 * error that never reaches `userErrors`.
 *
 * Two things are verified, and neither can be checked by reading docs:
 *
 *   1. The composed DOCUMENTS validate — including the overlapping-fields rule,
 *      which is why every condition field is read under a per-kind alias: the
 *      members of the condition interface disagree about the type of
 *      `relation`, `value` and `values`, and one response name over two shapes
 *      is a validation error on the document as a whole.
 *   2. The built INPUT payloads match the input types, for every condition kind
 *      on both sides — the half where a wrong shape reads as a successful save.
 *
 * The endpoint is Shopify's public schema proxy (the one `@shopify/api-codegen-preset`
 * uses); no shop, no token, no data.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { buildClientSchema, getIntrospectionQuery, parse, validate, type IntrospectionQuery } from "graphql";
import { COLLECTION_SOURCES_FIELDS, collectionAttributeSelection } from "~/services/attribute-sync.shared";
import { CREATE_COLLECTION_WITH_SOURCES } from "~/graphql/content.mutations";
import {
  conditionKinds,
  diffRuleSources,
  newCondition,
  toSourcesInput,
  type ConditionSide,
  type RuleCondition,
  type RuleSource,
} from "~/config/collection-rules.shared";

const API_VERSION = "2026-07";
const ENDPOINT = `https://shopify.dev/admin-graphql-direct-proxy/${API_VERSION}`;

const enabled = process.env.SHOPIFY_SCHEMA_CHECK === "1";

let introspection: IntrospectionQuery;
const inputTypes = new Map<string, any>();

beforeAll(async () => {
  if (!enabled) return;
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: getIntrospectionQuery({ descriptions: false }) }),
  });
  const body = (await response.json()) as { data: IntrospectionQuery };
  introspection = body.data;
  for (const type of introspection.__schema.types as any[]) inputTypes.set(type.name, type);
}, 180000);

/**
 * A JS value against an introspected type. Deliberately hand-rolled: graphql-js
 * coerces LITERALS, and turning a payload into a literal would have to guess
 * which strings are enums — the exact class of guess this file exists to end.
 */
function checkValue(ref: any, value: unknown, path: string, errors: string[]): void {
  if (ref.kind === "NON_NULL") {
    if (value === null || value === undefined) errors.push(`${path}: required but missing`);
    else checkValue(ref.ofType, value, path, errors);
    return;
  }
  if (value === null || value === undefined) return;
  if (ref.kind === "LIST") {
    if (!Array.isArray(value)) errors.push(`${path}: expected a list`);
    else value.forEach((v, i) => checkValue(ref.ofType, v, `${path}[${i}]`, errors));
    return;
  }
  const type = inputTypes.get(ref.name);
  if (!type) {
    errors.push(`${path}: unknown type ${ref.name}`);
    return;
  }
  if (type.kind === "INPUT_OBJECT") {
    if (typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${path}: expected an object for ${type.name}`);
      return;
    }
    const known = new Set<string>(type.inputFields.map((f: any) => f.name));
    for (const key of Object.keys(value as object)) {
      if (!known.has(key)) errors.push(`${path}.${key}: no such field on ${type.name}`);
    }
    for (const field of type.inputFields) {
      const present = (value as Record<string, unknown>)[field.name];
      if (present === undefined) {
        if (field.type.kind === "NON_NULL" && field.defaultValue == null) {
          errors.push(`${path}.${field.name}: required by ${type.name} but missing`);
        }
        continue;
      }
      checkValue(field.type, present, `${path}.${field.name}`, errors);
    }
    return;
  }
  if (type.kind === "ENUM") {
    if (!type.enumValues.some((v: any) => v.name === value)) {
      errors.push(`${path}: ${JSON.stringify(value)} is not a ${type.name}`);
    }
    return;
  }
  if (type.name === "Int" && !Number.isInteger(value)) errors.push(`${path}: expected Int`);
  if (type.name === "Float" && typeof value !== "number") errors.push(`${path}: expected Float`);
  if (type.name === "Boolean" && typeof value !== "boolean") errors.push(`${path}: expected Boolean`);
  if ((type.name === "ID" || type.name === "String") && typeof value !== "string") {
    errors.push(`${path}: expected ${type.name}`);
  }
}

/** A filled-in condition per kind — the value shapes are what this pins. */
function sampleCondition(side: ConditionSide, kind: string, index: number): RuleCondition {
  const base = newCondition(side, kind, `c${index}`, { currencyCode: "CHF" });
  const byKind: Record<string, Partial<RuleCondition>> = {
    productCategory: { value: "gid://shopify/TaxonomyCategory/aa-1", includeDescendants: true },
    productStatus: { value: "ACTIVE" },
    variantPrice: { value: "19.90" },
    variantCompareAtPrice: { value: "29.90" },
    variantInventory: { value: "5" },
    variantWeight: { value: "2.5", weightUnit: "POUNDS" },
    metafieldBoolean: { value: "true" },
    metafieldInteger: { value: "3" },
    metafieldDecimal: { value: "3.5" },
    metafieldMetaobject: { value: "gid://shopify/Metaobject/1" },
    metafieldMetaobjectList: { value: "gid://shopify/Metaobject/1, gid://shopify/Metaobject/2" },
    collection: { value: "gid://shopify/Collection/1, gid://shopify/Collection/2" },
  };
  return {
    ...base,
    value: "sample",
    ...(base.definitionId !== undefined ? { definitionId: "gid://shopify/MetafieldDefinition/1" } : {}),
    ...byKind[kind],
  };
}

/** One source holding every kind both sides know. */
function everyKindSource(id?: string): RuleSource {
  return {
    ...(id ? { id } : {}),
    title: "Everything",
    targetType: "PRODUCTS",
    inclusion: {
      matchType: "ALL",
      conditions: conditionKinds("inclusion").map((spec, i) => ({
        ...sampleCondition("inclusion", spec.key, i),
        ...(id ? { id: `inc-${i}` } : {}),
      })),
    },
    exclusion: {
      matchType: "ANY",
      conditions: conditionKinds("exclusion").map((spec, i) => ({
        ...sampleCondition("exclusion", spec.key, 100 + i),
        ...(id ? { id: `exc-${i}` } : {}),
      })),
    },
  };
}

describe.skipIf(!enabled)(`the collection rule model against the live ${API_VERSION} schema`, () => {
  it("validates the documents that read the rule tree", () => {
    const schema = buildClientSchema(introspection);

    const getCollection = `
      query getCollection($id: ID!) {
        collection(id: $id) {
          id
          title
          handle
          descriptionHtml
          updatedAt${collectionAttributeSelection(API_VERSION)}
          image { id url altText }
          seo { title description }
        }
      }`;

    const updateRules = `
      mutation updateCollectionRules($collection: CollectionUpdateInput!) {
        collectionUpdate(collection: $collection) {
          collection { id ${COLLECTION_SOURCES_FIELDS} }
          userErrors { field message }
        }
      }`;

    for (const [name, document] of [
      ["getCollection", getCollection],
      ["updateCollectionRules", updateRules],
      // The create path is its OWN mutation with its OWN variable type
      // (`CollectionCreateInput!`, not `CollectionUpdateInput!`) — validating
      // only the update one leaves creating a collection WITH rules unchecked.
      ["createCollectionWithSources", CREATE_COLLECTION_WITH_SOURCES],
    ] as const) {
      expect(
        validate(schema, parse(document)).map((e) => e.message),
        name,
      ).toEqual([]);
    }
  });

  it("builds a CREATE payload the input types accept, for every kind", () => {
    // TWO input types take the same list, and the app writes to both: creating
    // a collection with rules sends `CollectionCreateInput.sources`
    // (`createCollection` in create.actions.ts), while turning an existing one
    // into a rule-based collection sends `CollectionUpdateInput.sourcesToCreate`.
    // Checking one and assuming the other is how this file's own subject —
    // a shape derived instead of measured — got into the code.
    //
    // Scope: the rule half. The create input's other fields ride along from
    // the manual create path and are not pinned here.
    for (const [type, payload] of [
      ["CollectionCreateInput", { title: "Everything", sources: toSourcesInput([everyKindSource()]) }],
      [
        "CollectionUpdateInput",
        { id: "gid://shopify/Collection/1", sourcesToCreate: toSourcesInput([everyKindSource()]) },
      ],
    ] as const) {
      const errors: string[] = [];
      checkValue({ kind: "NON_NULL", ofType: { kind: "INPUT_OBJECT", name: type } }, payload, "collection", errors);
      expect(errors, type).toEqual([]);
    }
  });

  it("builds an UPDATE payload the input types accept, for every kind", () => {
    // The wrapper is the point: `conditionsToUpdate` takes `{ id, condition }`,
    // never the kind key beside the id.
    const before = [everyKindSource("s1")];
    const after = [
      {
        ...everyKindSource("s1"),
        title: "Renamed",
        inclusion: {
          matchType: "ANY" as const,
          conditions: [
            // The FIRST condition is left out — it becomes a delete — and one
            // without an id is added. All three lists have to be exercised:
            // `conditionsToCreate`/`ToDelete` are field names of the update
            // input just as much as `conditionsToUpdate` is, and a wrong one
            // fails at the schema level where no userError appears.
            ...everyKindSource("s1")
              .inclusion.conditions.slice(1)
              .map((c) => ({ ...c, value: c.kind === "productStatus" ? "DRAFT" : `${c.value}x` })),
            sampleCondition("inclusion", "productTag", 900),
          ],
        },
      },
    ];

    const diff = diffRuleSources(before, after);
    expect(diff.sourcesToUpdate).toHaveLength(1);
    const inclusion = (diff.sourcesToUpdate[0] as any).condition.inclusion;
    expect(inclusion.conditionsToCreate).toHaveLength(1);
    expect(inclusion.conditionsToDelete).toEqual(["inc-0"]);
    expect(inclusion.conditionsToUpdate.length).toBeGreaterThan(0);

    const errors: string[] = [];
    checkValue(
      { kind: "NON_NULL", ofType: { kind: "INPUT_OBJECT", name: "CollectionUpdateInput" } },
      {
        id: "gid://shopify/Collection/1",
        sourcesToUpdate: diff.sourcesToUpdate,
        sourcesToDelete: ["gid://shopify/CollectionSource/9"],
      },
      "collection",
      errors,
    );
    expect(errors).toEqual([]);
  });
});
