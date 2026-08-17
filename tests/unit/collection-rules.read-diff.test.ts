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
  type RuleSource,
} from "~/config/collection-rules.shared";

const tagCondition = {
  __typename: "CollectionRuleProductTagCondition",
  relation: "TAGGED_WITH",
  values: ["sale", "summer"],
  matchType: "ANY",
};

describe("fromShopifySources", () => {
  it("reads a plain single-source collection", () => {
    const [source] = fromShopifySources([
      {
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
      { id: "s1", title: "Nested", subCollections: { ids: ["gid://shopify/Collection/9"] } },
    ]);
    expect(source.unrenderable?.reason).toBe("subCollections");
    expect(source.unrenderable?.raw).toBeTruthy();
  });

  it("marks a shareable source unrenderable", () => {
    const [source] = fromShopifySources([{ id: "s1", title: "Shared", shareableSource: { id: "x" } }]);
    expect(source.unrenderable?.reason).toBe("shareableSource");
  });

  it("marks a source unrenderable when ONE condition is unknown", () => {
    // Not "drop the condition and keep the rest" — the whole source is carried
    // unchanged. A rule this app cannot read is a rule it must not rewrite.
    const [source] = fromShopifySources([
      {
        id: "s1",
        title: "Mixed",
        inclusion: {
          matchType: "ALL",
          conditions: [tagCondition, { __typename: "CollectionRuleConditionUnknown", relation: "?" }],
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
        id: "s1",
        title: "Rules plus picks",
        inclusion: {
          matchType: "ALL",
          conditions: [tagCondition],
          selections: [{ id: "gid://shopify/Product/1" }],
        },
      },
    ]);
    expect(source.unrenderable?.reason).toBe("unknownCondition");
  });

  it("reads an exclusion side, and omits it when empty", () => {
    const [withExclusion] = fromShopifySources([
      {
        id: "s1",
        title: "With exclusion",
        inclusion: { matchType: "ALL", conditions: [tagCondition] },
        exclusion: {
          matchType: "ANY",
          conditions: [
            { __typename: "CollectionRuleExclusionProductTagCondition", relation: "TAGGED_WITH", values: ["clearance"], matchType: "ALL" },
          ],
        },
      },
    ]);
    expect(withExclusion.exclusion?.conditions).toHaveLength(1);

    const [withoutExclusion] = fromShopifySources([
      { id: "s2", title: "None", inclusion: { matchType: "ALL", conditions: [tagCondition] }, exclusion: { matchType: "ALL", conditions: [] } },
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
    expect(inclusion).toContain("... on CollectionRuleProductTagCondition");
    expect(inclusion).toContain("... on CollectionRuleVariantPriceCondition");
    // A list kind carries its own matchType; a scalar one does not.
    expect(inclusion).toContain("values");
    expect(inclusion).toContain("matchType");
    expect(inclusion).toContain("definitionId");
  });

  it("uses a distinct type name per side", () => {
    // Exclusion conditions are their OWN types, and `productTag` exists on
    // both sides with different relations — one shared name would read the
    // wrong one.
    expect(readConditionTypename("inclusion", "productTag")).toBe("CollectionRuleProductTagCondition");
    expect(readConditionTypename("exclusion", "productTag")).toBe("CollectionRuleExclusionProductTagCondition");
  });

  it("omits `relation` for the one kind that has none", () => {
    // The exclusion `collection` kind is a bare list of ids. Selecting a field
    // the type does not have fails the WHOLE query at the schema level.
    const exclusion = readConditionFragments("exclusion");
    const collectionFragment = exclusion.slice(exclusion.indexOf("CollectionRuleExclusionCollectionCondition"));
    expect(collectionFragment.split("}")[0]).not.toContain("relation");
  });
});

describe("diffRuleSources", () => {
  const renderable = (id: string | undefined, tag: string): RuleSource => ({
    ...(id ? { id } : {}),
    title: `Source ${tag}`,
    inclusion: {
      matchType: "ALL",
      conditions: [{ localId: `c-${tag}`, kind: "productTag", relation: "TAGGED_WITH", value: tag, matchType: "ANY" }],
    },
  });

  it("creates the new, updates the kept, deletes the removed", () => {
    const before = [renderable("s1", "sale"), renderable("s2", "old")];
    const after = [renderable("s1", "sale-changed"), renderable(undefined, "brand-new")];

    const diff = diffRuleSources(before, after);
    expect(diff.sourcesToUpdate).toHaveLength(1);
    expect(diff.sourcesToUpdate[0]).toMatchObject({ id: "s1" });
    expect(diff.sourcesToCreate).toHaveLength(1);
    expect(diff.sourcesToCreate[0]).not.toHaveProperty("id");
    expect(diff.sourcesToDelete).toEqual(["s2"]);
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
    const diff = diffRuleSources([untouchable, renderable("s1", "sale")], [untouchable, renderable("s1", "sale")]);

    expect(diff.sourcesToCreate).toHaveLength(0);
    expect(diff.sourcesToUpdate.map((s) => s.id)).toEqual(["s1"]);
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
    const before = [renderable("s1", "sale")];
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
