/**
 * PLAN_CONTENT_CREATION §Phase 3.1 — editing an EXISTING collection's rules.
 *
 * Creating rules is a one-way translation and was already covered. Editing is
 * the dangerous half, and §2.4 is the reason:
 *
 *   "Regelwerk, das der Editor nicht rendert → read-only + Admin-Link"
 *
 * A collection's rules decide which products it contains. An editor that reads
 * a tree, silently drops the parts it does not understand, and writes the rest
 * back does not fail loudly — it changes the shop's merchandising and says
 * "saved". CLAUDE.md records the same trap one level down: `ruleSet` is a
 * LOSSY back-projection of `sources`, and reading one to write the other loses
 * exclusions, extra sources and variant targeting without a word.
 *
 * So almost every test here is about what must NOT happen.
 */

import { describe, it, expect } from "vitest";
import {
  diffRuleSources,
  fromShopifySources,
  readConditionFragments,
  readConditionTypename,
  toSourcesInput,
  withoutRawTrees,
  type RuleSource,
} from "~/config/collection-rules.shared";

/**
 * A condition exactly as the read selection delivers it: every field but `id`
 * under a per-kind ALIAS, because the members of the condition interface
 * disagree about the type of `relation`, `value` and `values` and GraphQL
 * refuses a document that asks for them under one response name.
 */
const tagCondition = {
  __typename: "CollectionSourceInclusionConditionProductTag",
  productTag_relation: "TAGGED_WITH",
  productTag_values: ["sale", "summer"],
  productTag_matchType: "ANY",
};

/** Every source Shopify returns names its type; the reader decides on it. */
const CONDITIONS_SOURCE = "CollectionConditionsSource";

describe("fromShopifySources", () => {
  it("reads a plain single-source collection", () => {
    const [source] = fromShopifySources([
      {
        __typename: CONDITIONS_SOURCE,
        id: "gid://shopify/CollectionSource/1",
        title: "Sale items",
        inclusion: { matchType: "ALL", conditions: [tagCondition] },
      },
    ]);

    expect(source.unrenderable).toBeUndefined();
    expect(source.id).toBe("gid://shopify/CollectionSource/1");
    expect(source.inclusion.matchType).toBe("ALL");
    expect(source.inclusion.conditions).toHaveLength(1);
    // Lists arrive as an array and live in the editor as one comma string —
    // the same serialization the write path parses back.
    expect(source.inclusion.conditions[0]).toMatchObject({
      kind: "productTag",
      relation: "TAGGED_WITH",
      value: "sale, summer",
      matchType: "ANY",
    });
  });

  it("marks a source with SUB-COLLECTIONS unrenderable and keeps its tree", () => {
    // The editor has no control for this at all. Rendering the rest and
    // dropping this branch would change the collection's membership.
    const [source] = fromShopifySources([
      { __typename: "CollectionSubCollectionsSource", id: "s1", title: "Nested" },
    ]);
    expect(source.unrenderable?.reason).toBe("subCollections");
    expect(source.unrenderable?.raw).toBeTruthy();
  });

  it("marks a shareable source unrenderable", () => {
    // A shareable source is not a type of its own: it is a conditions source
    // with the flag set, and it governs OTHER collections too.
    const [source] = fromShopifySources([
      {
        __typename: CONDITIONS_SOURCE,
        id: "s1",
        title: "Shared",
        shareable: true,
        inclusion: { matchType: "ALL", conditions: [tagCondition] },
      },
    ]);
    expect(source.unrenderable?.reason).toBe("shareableSource");
  });

  it("marks a source type it does not know unrenderable", () => {
    // A member Shopify adds to the interface later. Reading it as an ordinary
    // source would hand the merchant an empty builder over real rules.
    const [source] = fromShopifySources([{ __typename: "CollectionFutureSource", id: "s1", title: "New" }]);
    expect(source.unrenderable?.reason).toBe("unknownSource");
  });

  it("marks a source unrenderable when ONE condition is unknown", () => {
    // Not "drop the condition and keep the rest" — the whole source is carried
    // unchanged. A rule this app cannot read is a rule it must not rewrite.
    const [source] = fromShopifySources([
      {
        __typename: CONDITIONS_SOURCE,
        id: "s1",
        title: "Mixed",
        inclusion: {
          matchType: "ALL",
          conditions: [tagCondition, { __typename: "CollectionSourceInclusionConditionUnknown" }],
        },
      },
    ]);
    expect(source.unrenderable?.reason).toBe("unknownCondition");
  });

  it("marks a source with hand-picked SELECTIONS unrenderable", () => {
    // Conditions plus a manual pick. Saving the conditions alone would quietly
    // remove the picked products.
    const [source] = fromShopifySources([
      {
        __typename: CONDITIONS_SOURCE,
        id: "s1",
        title: "Rules plus picks",
        inclusion: {
          matchType: "ALL",
          conditions: [tagCondition],
          selections: { nodes: [{ __typename: "CollectionInclusionProductSelection" }] },
        },
      },
    ]);
    expect(source.unrenderable?.reason).toBe("unknownCondition");
  });

  it("calls a source with picks but NO conditions a hand-picked membership", () => {
    // The 2026-07 model gives a MANUAL collection a conditions source too:
    // zero conditions, the picks in `selections` (measured — twelve manual
    // collections on a shop with no smart collection at all). Read-only like
    // every other unrenderable source, because the picks must survive a save
    // — but it is not a rule this editor failed to understand, and the banner
    // that said so appeared on every ordinary collection.
    const [source] = fromShopifySources([
      {
        __typename: CONDITIONS_SOURCE,
        id: "s1",
        title: "Hand-picked",
        inclusion: {
          matchType: "ALL",
          conditions: [],
          selections: { nodes: [{ __typename: "CollectionInclusionProductSelection" }] },
        },
      },
    ]);
    expect(source.unrenderable?.reason).toBe("manualSelection");
    expect(source.unrenderable?.raw).toBeTruthy();
  });

  it("still calls picks NEXT TO a condition an unreadable rule", () => {
    // One condition is enough: the editor could render it, and rendering it
    // while dropping the picks is what would change the membership. The
    // milder sentence belongs only to a source that has no rule at all.
    const [source] = fromShopifySources([
      {
        __typename: CONDITIONS_SOURCE,
        id: "s1",
        title: "Picks in the exclusion",
        inclusion: { matchType: "ALL", conditions: [tagCondition] },
        exclusion: {
          matchType: "ANY",
          conditions: [],
          selections: { nodes: [{ __typename: "CollectionExclusionProductSelection" }] },
        },
      },
    ]);
    expect(source.unrenderable?.reason).toBe("unknownCondition");
  });

  it("never submits a hand-picked source, in any direction", () => {
    // The whole reason it stays `unrenderable`: a manual collection's picks
    // are its membership, and a save that diffed them away would empty it.
    const manual: RuleSource = {
      id: "gid://shopify/CollectionSource/9",
      title: "Hand-picked",
      inclusion: { matchType: "ALL", conditions: [] },
      unrenderable: { reason: "manualSelection", raw: { picks: true } },
    };
    const diff = diffRuleSources([manual], [manual]);
    expect(diff).toEqual({ sourcesToCreate: [], sourcesToUpdate: [], sourcesToDelete: [] });
  });

  it("reads an exclusion side, and omits it when empty", () => {
    const [withExclusion] = fromShopifySources([
      {
        __typename: CONDITIONS_SOURCE,
        id: "s1",
        title: "With exclusion",
        inclusion: { matchType: "ALL", conditions: [tagCondition] },
        exclusion: {
          matchType: "ANY",
          conditions: [
            {
              __typename: "CollectionSourceExclusionConditionProductTag",
              productTag_relation: "TAGGED_WITH",
              productTag_values: ["clearance"],
              productTag_matchType: "ALL",
            },
          ],
        },
      },
    ]);
    expect(withExclusion.exclusion?.conditions).toHaveLength(1);

    const [withoutExclusion] = fromShopifySources([
      {
        __typename: CONDITIONS_SOURCE,
        id: "s2",
        title: "None",
        inclusion: { matchType: "ALL", conditions: [tagCondition] },
        exclusion: { matchType: "ALL", conditions: [] },
      },
    ]);
    expect(withoutExclusion.exclusion).toBeUndefined();
  });

  it("survives an empty or absent tree", () => {
    expect(fromShopifySources(null)).toEqual([]);
    expect(fromShopifySources([])).toEqual([]);
  });
});

describe("readConditionFragments", () => {
  it("names every kind it can write, so read and write cannot drift", () => {
    // The selection is GENERATED from the same specs the write path uses. A
    // hand-written selection is how the two sides drift, and a kind missing
    // from the read side would make every collection using it "unrenderable"
    // for no reason.
    const inclusion = readConditionFragments("inclusion");
    expect(inclusion).toContain("... on CollectionSourceInclusionConditionProductTag");
    expect(inclusion).toContain("... on CollectionSourceInclusionConditionVariantPrice");
    // Every field but `id` is ALIASED per kind: the members disagree about the
    // type of `relation`/`value`/`values`, and one response name over
    // conflicting shapes is a validation error on the WHOLE document.
    expect(inclusion).toContain("productTag_relation: relation");
    expect(inclusion).toContain("productTag_values: values");
    expect(inclusion).toContain("productTag_matchType: matchType");
    expect(inclusion).not.toMatch(/^\s+relation$/m);
    // A list kind carries its own matchType; a scalar one does not.
    expect(inclusion).toContain("values");
    expect(inclusion).toContain("matchType");
    // A metafield condition reports a definition NODE, never a bare id.
    expect(inclusion).toContain("metafieldString_definition: definition { id }");
    expect(inclusion).not.toContain("definitionId");
  });

  it("selects the OBJECT shape for the kinds that have one", () => {
    // Measured 2026-08-19. Asking for a bare value on any of these is a schema
    // error, and a schema error fails the WHOLE query — which is exactly what
    // broke the collection sync.
    const inclusion = readConditionFragments("inclusion");
    expect(inclusion).toContain("values { category { id } includeDescendants }");
    expect(inclusion).toContain("value { amount currencyCode }");
    expect(inclusion).toContain("value { value unit }");
    expect(inclusion).toContain("value { id }");
    expect(readConditionFragments("exclusion")).toContain("values { id }");
  });

  it("uses a distinct type name per side", () => {
    // Exclusion conditions are their OWN types, and `productTag` exists on
    // both sides with different relations — one shared name would read the
    // wrong one.
    expect(readConditionTypename("inclusion", "productTag")).toBe("CollectionSourceInclusionConditionProductTag");
    expect(readConditionTypename("exclusion", "productTag")).toBe("CollectionSourceExclusionConditionProductTag");
  });

  it("omits `relation` for the one kind that has none", () => {
    // The exclusion `collection` kind is a bare list of ids. Selecting a field
    // the type does not have fails the WHOLE query at the schema level.
    const exclusion = readConditionFragments("exclusion");
    const collectionFragment = exclusion.slice(exclusion.indexOf("CollectionSourceExclusionConditionCollection"));
    expect(collectionFragment.split("}")[0]).not.toContain("relation");
  });
});

describe("the values that are not plain strings", () => {
  const readOne = (side: "inclusion" | "exclusion", condition: Record<string, unknown>) =>
    fromShopifySources([
      {
        __typename: CONDITIONS_SOURCE,
        id: "s1",
        title: "S",
        inclusion:
          side === "inclusion"
            ? { matchType: "ALL", conditions: [condition] }
            : { matchType: "ALL", conditions: [tagCondition] },
        ...(side === "exclusion" ? { exclusion: { matchType: "ALL", conditions: [condition] } } : {}),
      },
    ])[0];

  const conditionInputs = (source: RuleSource, side: "inclusion" | "exclusion") => {
    const [created] = toSourcesInput([source]);
    const block = (created.source as Record<string, unknown>)[side] as Record<string, unknown>;
    return block.conditions as Array<Record<string, unknown>>;
  };

  it("round-trips a category condition through its id list and its flag", () => {
    const source = readOne("inclusion", {
      __typename: "CollectionSourceInclusionConditionProductCategory",
      id: "c1",
      productCategory_relation: "EQUALS",
      productCategory_matchType: "ANY",
      productCategory_values: [
        { category: { id: "gid://shopify/TaxonomyCategory/aa-1" }, includeDescendants: true },
        { category: { id: "gid://shopify/TaxonomyCategory/aa-2" }, includeDescendants: true },
      ],
    });
    expect(source.unrenderable).toBeUndefined();
    expect(source.inclusion.conditions[0]).toMatchObject({
      kind: "productCategory",
      value: "gid://shopify/TaxonomyCategory/aa-1, gid://shopify/TaxonomyCategory/aa-2",
      includeDescendants: true,
    });
    expect(conditionInputs(source, "inclusion")[0]).toEqual({
      productCategory: {
        relation: "EQUALS",
        matchType: "ANY",
        values: [
          { categoryId: "gid://shopify/TaxonomyCategory/aa-1", includeDescendants: true },
          { categoryId: "gid://shopify/TaxonomyCategory/aa-2", includeDescendants: true },
        ],
      },
    });
  });

  it("refuses a category condition whose values disagree about descendants", () => {
    // The form holds ONE checkbox for the condition. Flattening two answers
    // into it would change which products the collection holds on the next
    // save — so the whole source goes read-only instead.
    const source = readOne("inclusion", {
      __typename: "CollectionSourceInclusionConditionProductCategory",
      id: "c1",
      productCategory_relation: "EQUALS",
      productCategory_matchType: "ANY",
      productCategory_values: [
        { category: { id: "gid://shopify/TaxonomyCategory/aa-1" }, includeDescendants: true },
        { category: { id: "gid://shopify/TaxonomyCategory/aa-2" }, includeDescendants: false },
      ],
    });
    expect(source.unrenderable?.reason).toBe("unknownCondition");
  });

  it("keeps a price condition's own currency instead of inventing one", () => {
    const source = readOne("inclusion", {
      __typename: "CollectionSourceInclusionConditionVariantPrice",
      id: "c1",
      variantPrice_relation: "GREATER_THAN",
      variantPrice_value: { amount: "19.90", currencyCode: "CHF" },
    });
    expect(source.inclusion.conditions[0]).toMatchObject({ value: "19.90", currencyCode: "CHF" });
    expect(conditionInputs(source, "inclusion")[0]).toEqual({
      variantPrice: { relation: "GREATER_THAN", value: { amount: "19.90", currencyCode: "CHF" } },
    });
  });

  it("keeps a weight condition's unit, and refuses one it does not know", () => {
    const source = readOne("inclusion", {
      __typename: "CollectionSourceInclusionConditionVariantWeight",
      id: "c1",
      variantWeight_relation: "LESS_THAN",
      variantWeight_value: { value: 2.5, unit: "POUNDS" },
    });
    expect(source.inclusion.conditions[0]).toMatchObject({ value: "2.5", weightUnit: "POUNDS" });
    expect(conditionInputs(source, "inclusion")[0]).toEqual({
      variantWeight: { relation: "LESS_THAN", value: { value: 2.5, unit: "POUNDS" } },
    });

    // A unit this app cannot render would keep its digits and change its
    // meaning on the next save.
    const unknownUnit = readOne("inclusion", {
      __typename: "CollectionSourceInclusionConditionVariantWeight",
      id: "c2",
      variantWeight_relation: "LESS_THAN",
      variantWeight_value: { value: 2.5, unit: "STONES" },
    });
    expect(unknownUnit.unrenderable?.reason).toBe("unknownCondition");
  });

  it("refuses a weight condition whose unit is missing, not only one it cannot name", () => {
    // An absent unit is not the milder case: `toConditionInput` would write
    // KILOGRAMS for it, so the number would keep its digits and change its
    // meaning — the same damage an unknown unit does.
    const source = readOne("inclusion", {
      __typename: "CollectionSourceInclusionConditionVariantWeight",
      id: "c1",
      variantWeight_relation: "LESS_THAN",
      variantWeight_value: { value: 2.5 },
    });
    expect(source.unrenderable?.reason).toBe("unknownCondition");
  });

  it("refuses a status this app's vocabulary does not have", () => {
    // The builder offers the three measured statuses as checkboxes, so it can
    // only rebuild those three: a fourth one Shopify adds later would vanish
    // on the first toggle. Refusing it in the VALIDATOR instead would block
    // every rule edit on the collection, which is why this is the read side's
    // answer and not the gate's.
    const known = readOne("inclusion", {
      __typename: "CollectionSourceInclusionConditionProductStatus",
      id: "c1",
      productStatus_relation: "EQUALS",
      productStatus_matchType: "ANY",
      productStatus_values: ["ACTIVE", "DRAFT"],
    });
    expect(known.unrenderable).toBeUndefined();
    expect(known.inclusion.conditions[0]).toMatchObject({ kind: "productStatus", value: "ACTIVE, DRAFT" });

    const unknown = readOne("inclusion", {
      __typename: "CollectionSourceInclusionConditionProductStatus",
      id: "c1",
      productStatus_relation: "EQUALS",
      productStatus_matchType: "ANY",
      productStatus_values: ["ACTIVE", "SUPERSEDED"],
    });
    expect(unknown.unrenderable?.reason).toBe("unknownCondition");
  });

  it("refuses a node list with an entry it could not read, instead of shortening it", () => {
    // Dropping the unreadable entry keeps the condition editable, and the next
    // save writes the SHORTER list: one collection fewer excluded, silently.
    const source = readOne("exclusion", {
      __typename: "CollectionSourceExclusionConditionCollection",
      id: "c1",
      collection_matchType: "ANY",
      collection_values: [{ id: "gid://shopify/Collection/5" }, {}],
    });
    expect(source.unrenderable?.reason).toBe("unknownCondition");
  });

  it("refuses a category list with an entry it could not read", () => {
    const source = readOne("inclusion", {
      __typename: "CollectionSourceInclusionConditionProductCategory",
      id: "c1",
      productCategory_relation: "EQUALS",
      productCategory_matchType: "ANY",
      productCategory_values: [
        { category: { id: "gid://shopify/TaxonomyCategory/aa-1" }, includeDescendants: true },
        { category: null, includeDescendants: true },
      ],
    });
    expect(source.unrenderable?.reason).toBe("unknownCondition");
  });

  it("reads a node-valued condition as its id, and its definition as one too", () => {
    const source = readOne("inclusion", {
      __typename: "CollectionSourceInclusionConditionMetafieldMetaobject",
      id: "c1",
      metafieldMetaobject_relation: "EQUALS",
      metafieldMetaobject_definition: { id: "gid://shopify/MetafieldDefinition/7" },
      metafieldMetaobject_value: { id: "gid://shopify/Metaobject/3" },
    });
    expect(source.inclusion.conditions[0]).toMatchObject({
      kind: "metafieldMetaobject",
      value: "gid://shopify/Metaobject/3",
      definitionId: "gid://shopify/MetafieldDefinition/7",
    });
    expect(conditionInputs(source, "inclusion")[0]).toEqual({
      metafieldMetaobject: {
        relation: "EQUALS",
        definitionId: "gid://shopify/MetafieldDefinition/7",
        value: "gid://shopify/Metaobject/3",
      },
    });
  });

  it("writes an exclusion by collection WITHOUT a matchType", () => {
    // It reads one back and its input has none. Sending it fails the mutation
    // at the schema level, where no userError ever appears.
    const source = readOne("exclusion", {
      __typename: "CollectionSourceExclusionConditionCollection",
      id: "c1",
      collection_matchType: "ANY",
      collection_values: [{ id: "gid://shopify/Collection/5" }],
    });
    expect(conditionInputs(source, "exclusion")[0]).toEqual({
      collection: { values: ["gid://shopify/Collection/5"] },
    });
  });
});

describe("diffRuleSources", () => {
  /** A source as the READ path produces it — Shopify ids on both levels. */
  const renderable = (
    id: string | undefined,
    tag: string,
    conditionId?: string,
  ): RuleSource => ({
    ...(id ? { id } : {}),
    title: `Source ${id ?? tag}`,
    inclusion: {
      matchType: "ALL",
      conditions: [
        {
          localId: `c-${tag}`,
          ...(conditionId ? { id: conditionId } : {}),
          kind: "productTag",
          relation: "TAGGED_WITH",
          value: tag,
          matchType: "ANY",
        },
      ],
    },
  });

  /** The `{ condition: { … } }` wrapper `CollectionUpdateSourceTargetInput` takes. */
  const updateBody = (entry: Record<string, unknown>) =>
    (entry as { condition: Record<string, unknown> }).condition;

  it("creates the new, updates the kept, deletes the removed", () => {
    const before = [renderable("s1", "sale", "c1"), renderable("s2", "old", "c2")];
    const after = [renderable("s1", "sale-changed", "c1"), renderable(undefined, "brand-new")];

    const diff = diffRuleSources(before, after);
    expect(diff.sourcesToUpdate).toHaveLength(1);
    expect(updateBody(diff.sourcesToUpdate[0])).toMatchObject({ id: "s1" });
    expect(diff.sourcesToCreate).toHaveLength(1);
    expect(diff.sourcesToCreate[0]).not.toHaveProperty("id");
    expect(diff.sourcesToDelete).toEqual(["s2"]);
  });

  it("edits a source by CONDITION diff, never by replacing its list", () => {
    // `CollectionUpdateSourceInclusionInput` has no `conditions` field at all
    // (PLAN §1.2a) — only the three lists. A whole-source replace would not
    // just be wasteful, it would not typecheck against the schema.
    const before = [renderable("s1", "sale", "c1")];
    const after = [renderable("s1", "clearance", "c1")];

    const body = updateBody(diffRuleSources(before, after).sourcesToUpdate[0]);
    const inclusion = body.inclusion as Record<string, unknown>;
    expect(inclusion).not.toHaveProperty("conditions");
    // `{ id, condition }` — the kind key lives INSIDE `condition`, measured.
    expect(inclusion.conditionsToUpdate).toEqual([
      { id: "c1", condition: { productTag: { relation: "TAGGED_WITH", values: ["clearance"], matchType: "ANY" } } },
    ]);
    expect(inclusion).not.toHaveProperty("conditionsToCreate");
    expect(inclusion).not.toHaveProperty("conditionsToDelete");
  });

  it("adds and removes conditions within a kept source", () => {
    const before: RuleSource[] = [
      {
        id: "s1",
        title: "Source s1",
        inclusion: {
          matchType: "ALL",
          conditions: [
            { localId: "a", id: "c1", kind: "productTag", relation: "TAGGED_WITH", value: "sale", matchType: "ANY" },
            { localId: "b", id: "c2", kind: "productVendor", relation: "EQUALS", value: "Acme", matchType: "ANY" },
          ],
        },
      },
    ];
    const after: RuleSource[] = [
      {
        id: "s1",
        title: "Source s1",
        inclusion: {
          matchType: "ALL",
          conditions: [
            { localId: "a", id: "c1", kind: "productTag", relation: "TAGGED_WITH", value: "sale", matchType: "ANY" },
            { localId: "new", kind: "productType", relation: "EQUALS", value: "Shoe", matchType: "ANY" },
          ],
        },
      },
    ];

    const inclusion = updateBody(diffRuleSources(before, after).sourcesToUpdate[0]).inclusion as Record<string, unknown>;
    expect(inclusion.conditionsToDelete).toEqual(["c2"]);
    expect(inclusion.conditionsToCreate).toHaveLength(1);
    // c1 is untouched and must not appear in ANY list.
    expect(inclusion.conditionsToUpdate).toBeUndefined();
  });

  it("emits no update at all when nothing about a source changed", () => {
    // Re-sending an unchanged source would make Shopify recompute the
    // collection's membership on every save of an unrelated text field.
    const before = [renderable("s1", "sale", "c1")];
    const diff = diffRuleSources(before, [renderable("s1", "sale", "c1")]);
    expect(diff.sourcesToUpdate).toEqual([]);
    expect(diff.sourcesToCreate).toEqual([]);
    expect(diff.sourcesToDelete).toEqual([]);
  });

  it("ignores a whitespace-only difference in a list value", () => {
    // Comparison is on the BUILT INPUT: "a, b" and "a ,b" are the same rule.
    const before = [renderable("s1", "a, b", "c1")];
    const after = [renderable("s1", "a ,  b", "c1")];
    expect(diffRuleSources(before, after).sourcesToUpdate).toEqual([]);
  });

  it("carries a source-level matchType change on its own", () => {
    const before = [renderable("s1", "sale", "c1")];
    const after = [renderable("s1", "sale", "c1")];
    after[0] = { ...after[0], inclusion: { ...after[0].inclusion, matchType: "ANY" } };

    const inclusion = updateBody(diffRuleSources(before, after).sourcesToUpdate[0]).inclusion as Record<string, unknown>;
    expect(inclusion.matchType).toBe("ANY");
    expect(inclusion.conditionsToUpdate).toBeUndefined();
  });

  it("DROPS an `after` source whose id the cache does not carry", () => {
    // `before` is the server's cache, `after` is the client's payload. An id
    // that appears only in the payload is a claim, not an identity — updating
    // it would let a crafted request rewrite a source this editor never read,
    // including an unrenderable one or another collection's.
    const diff = diffRuleSources([renderable("s1", "sale", "c1")], [renderable("s-forged", "evil", "c9")]);
    expect(diff.sourcesToCreate).toEqual([]);
    expect(diff.sourcesToUpdate).toEqual([]);
    // s1 is still deleted — the client genuinely stopped holding it.
    expect(diff.sourcesToDelete).toEqual(["s1"]);
  });

  it("cannot reach an unrenderable source by naming its id", () => {
    const untouchable: RuleSource = {
      id: "s-nested",
      title: "Nested",
      inclusion: { matchType: "ALL", conditions: [] },
      unrenderable: { reason: "subCollections", raw: { anything: true } },
    };
    // The payload drops the `unrenderable` marker and claims the id as a
    // plain editable source — the one attack the flag exists to stop.
    const forged: RuleSource = { ...untouchable, unrenderable: undefined, title: "Mine now" };
    const diff = diffRuleSources([untouchable], [forged]);

    expect(diff.sourcesToCreate).toEqual([]);
    expect(diff.sourcesToUpdate).toEqual([]);
    expect(diff.sourcesToDelete).toEqual([]);
  });

  it("creates a condition whose id the cache does not carry, rather than updating it", () => {
    const before = [renderable("s1", "sale", "c1")];
    const after = [renderable("s1", "sale", "c-forged")];

    const inclusion = updateBody(diffRuleSources(before, after).sourcesToUpdate[0]).inclusion as Record<string, unknown>;
    expect(inclusion.conditionsToUpdate).toBeUndefined();
    expect(inclusion.conditionsToCreate).toHaveLength(1);
    expect(inclusion.conditionsToDelete).toEqual(["c1"]);
  });

  it("NEVER touches an unrenderable source, in any direction", () => {
    // The whole §2.4 guarantee in one assertion: a collection using a feature
    // this editor does not speak comes through a save byte-for-byte unchanged.
    const untouchable: RuleSource = {
      id: "s-nested",
      title: "Nested",
      inclusion: { matchType: "ALL", conditions: [] },
      unrenderable: { reason: "subCollections", raw: { anything: true } },
    };
    const before = [untouchable, renderable("s1", "sale", "c1")];
    const after = [untouchable, renderable("s1", "sale-changed", "c1")];
    const diff = diffRuleSources(before, after);

    expect(diff.sourcesToCreate).toHaveLength(0);
    expect(diff.sourcesToUpdate.map((s) => updateBody(s).id)).toEqual(["s1"]);
    expect(diff.sourcesToDelete).toEqual([]);
  });

  it("does not delete an unrenderable source that the editor never held", () => {
    // The editor may legitimately not carry it forward in its own state. That
    // is not the merchant asking for it to go.
    const untouchable: RuleSource = {
      id: "s-nested",
      title: "Nested",
      inclusion: { matchType: "ALL", conditions: [] },
      unrenderable: { reason: "unknownCondition", raw: {} },
    };
    const diff = diffRuleSources([untouchable], []);
    expect(diff.sourcesToDelete).toEqual([]);
  });

  it("deletes nothing when nothing was removed", () => {
    const before = [renderable("s1", "sale", "c1")];
    const diff = diffRuleSources(before, before);
    expect(diff.sourcesToDelete).toEqual([]);
  });

  it("treats a collection that had no sources as pure creation", () => {
    const diff = diffRuleSources([], [renderable(undefined, "first")]);
    expect(diff.sourcesToCreate).toHaveLength(1);
    expect(diff.sourcesToUpdate).toHaveLength(0);
    expect(diff.sourcesToDelete).toEqual([]);
  });
});

describe("withoutRawTrees", () => {
  it("keeps the reason and drops the tree", () => {
    const [stripped] = withoutRawTrees([
      {
        id: "s1",
        title: "Nested",
        inclusion: { matchType: "ALL", conditions: [] },
        unrenderable: { reason: "subCollections", raw: { huge: true } },
      },
    ]);
    expect(stripped.unrenderable).toEqual({ reason: "subCollections" });
  });

  it("leaves a renderable source alone", () => {
    const source: RuleSource = {
      id: "s1",
      title: "Sale",
      inclusion: { matchType: "ALL", conditions: [] },
    };
    expect(withoutRawTrees([source])[0]).toBe(source);
  });
});
