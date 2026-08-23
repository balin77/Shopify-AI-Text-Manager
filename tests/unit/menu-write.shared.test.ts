/**
 * The pure half of renaming menu items.
 *
 * The fingerprint is the whole safety story of this feature in one string: it
 * decides whether a write-back that carries the merchant's ENTIRE navigation
 * is allowed to go out. So these tests are mostly about what it must NOT
 * consider equal.
 */

import { describe, it, expect } from "vitest";
import { menuStructureFingerprint, describeFingerprintDrift } from "~/services/menu-write.shared";

const tree = [
  {
    id: "gid://shopify/MenuItem/10",
    title: "Produkte",
    items: [
      {
        id: "gid://shopify/MenuItem/20",
        title: "Stifthalter",
        items: [{ id: "gid://shopify/MenuItem/30", title: "Holz" }],
      },
    ],
  },
  { id: "gid://shopify/MenuItem/40", title: "Kontakt" },
];

describe("menuStructureFingerprint", () => {
  it("is stable for the same tree", () => {
    expect(menuStructureFingerprint(tree)).toBe(menuStructureFingerprint(structuredClone(tree)));
  });

  it("changes when an item is RENAMED elsewhere", () => {
    // The case the check exists for: somebody renamed an item in the Shopify
    // admin while our page was open. Writing back would silently revert it.
    const other = structuredClone(tree);
    other[1].title = "Kontakt & Anfahrt";
    expect(menuStructureFingerprint(other)).not.toBe(menuStructureFingerprint(tree));
  });

  it("changes when two items swap places", () => {
    const other = [tree[1], tree[0]];
    expect(menuStructureFingerprint(other)).not.toBe(menuStructureFingerprint(tree));
  });

  it("changes when an item is added or removed", () => {
    const removed = structuredClone(tree);
    removed[0].items = [];
    expect(menuStructureFingerprint(removed)).not.toBe(menuStructureFingerprint(tree));
  });

  it("changes when a child moves to another parent", () => {
    const moved = structuredClone(tree);
    const child = moved[0].items![0];
    moved[0].items = [];
    (moved[1] as { items?: unknown[] }).items = [child];
    expect(menuStructureFingerprint(moved)).not.toBe(menuStructureFingerprint(tree));
  });

  it("ignores tags, which the write-back carries over verbatim", () => {
    // `tags` comes from the FRESH read and is never substituted, so a change
    // to it is preserved by construction. Blocking a save on it would refuse a
    // rename over an edit that cannot be lost.
    const withTags = structuredClone(tree) as Array<Record<string, unknown>>;
    withTags[1].tags = ["a"];
    expect(menuStructureFingerprint(withTags)).toBe(menuStructureFingerprint(tree));
  });

  it("changes when somebody else retargets an item", () => {
    // The editor SUBSTITUTES the target now, so a target changed in the
    // Shopify admin while this page was open has to refuse the save — exactly
    // like a title. Without it our stale target is written back silently.
    const retargeted = structuredClone(tree) as Array<Record<string, unknown>>;
    retargeted[1].type = "PAGE";
    retargeted[1].resourceId = "gid://shopify/Page/9";
    expect(menuStructureFingerprint(retargeted)).not.toBe(menuStructureFingerprint(tree));
  });

  it("ignores the DERIVED url of a resource-bound item", () => {
    // Shopify builds that url from the resource's handle. A handle changed
    // anywhere else in the shop must not read as "somebody retargeted the
    // menu" — it would refuse a save nobody's edit conflicts with.
    const base = structuredClone(tree) as Array<Record<string, unknown>>;
    base[1].type = "PAGE";
    base[1].resourceId = "gid://shopify/Page/9";
    base[1].url = "/pages/kontakt";
    const renamedHandle = structuredClone(base);
    renamedHandle[1].url = "/pages/kontakt-neu";
    expect(menuStructureFingerprint(renamedHandle)).toBe(menuStructureFingerprint(base));
  });

  it("DOES notice a changed url on a free-URL item", () => {
    // There the url IS the target, not a projection of one.
    const base = structuredClone(tree) as Array<Record<string, unknown>>;
    base[1].type = "HTTP";
    base[1].url = "https://example.com/a";
    const moved = structuredClone(base);
    moved[1].url = "https://example.com/b";
    expect(menuStructureFingerprint(moved)).not.toBe(menuStructureFingerprint(base));
  });

  it("cannot be forged by a title containing the separator", () => {
    // Two different trees must never produce one fingerprint. A tab inside a
    // title is the obvious attempt, since the format is tab-separated.
    const a = [{ id: "gid://shopify/MenuItem/1", title: "A\tgid://shopify/MenuItem/2\tB" }];
    const b = [
      { id: "gid://shopify/MenuItem/1", title: "A" },
      { id: "gid://shopify/MenuItem/2", title: "B" },
    ];
    expect(menuStructureFingerprint(a)).not.toBe(menuStructureFingerprint(b));
  });

  it("survives a malformed tree instead of hanging", () => {
    expect(menuStructureFingerprint(null)).toBe("");
    expect(menuStructureFingerprint([{ title: "no id" }])).toBe("");
  });
});

describe("describeFingerprintDrift", () => {
  it("names what somebody else changed, out of the fingerprints alone", () => {
    // No extra payload and no second read: the fingerprint already carries
    // path, id and title per line, which is exactly the tree the page saw.
    const before = menuStructureFingerprint([
      { id: "gid://shopify/MenuItem/1", title: "Produkte" },
      { id: "gid://shopify/MenuItem/4", title: "Kontakt" },
    ]);
    const after = menuStructureFingerprint([
      { id: "gid://shopify/MenuItem/4", title: "Kontakt & Anfahrt" },
      { id: "gid://shopify/MenuItem/9", title: "Neu" },
    ]);
    const drift = describeFingerprintDrift(before, after);
    expect(drift.renamed).toEqual([{ from: "Kontakt", to: "Kontakt & Anfahrt" }]);
    expect(drift.added).toEqual(["Neu"]);
    expect(drift.removed).toEqual(["Produkte"]);
  });

  it("reports a move as a move, not as an add and a remove", () => {
    const before = menuStructureFingerprint([
      { id: "a", title: "A", items: [{ id: "b", title: "B" }] },
    ]);
    const after = menuStructureFingerprint([
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ]);
    expect(describeFingerprintDrift(before, after).moved).toEqual(["B"]);
  });
});

describe("describeFingerprintDrift — a foreign retarget", () => {
  it("names the item whose target somebody else changed", () => {
    const before = menuStructureFingerprint([
      { id: "gid://shopify/MenuItem/1", title: "Kontakt", type: "HTTP", url: "/kontakt" },
    ]);
    const after = menuStructureFingerprint([
      { id: "gid://shopify/MenuItem/1", title: "Kontakt", type: "PAGE", resourceId: "gid://shopify/Page/9" },
    ]);
    const drift = describeFingerprintDrift(before, after);
    expect(drift.retargeted).toEqual(["Kontakt"]);
    // One bucket per item: a retarget is not also a rename or a move.
    expect(drift.renamed).toEqual([]);
    expect(drift.moved).toEqual([]);
  });

  it("reports a rename rather than a retarget when both changed", () => {
    // Most-specific first. Listing the item twice would read as two separate
    // foreign edits, and the merchant is deciding whether to reload.
    const before = menuStructureFingerprint([
      { id: "gid://shopify/MenuItem/1", title: "Alt", type: "HTTP", url: "/a" },
    ]);
    const after = menuStructureFingerprint([
      { id: "gid://shopify/MenuItem/1", title: "Neu", type: "HTTP", url: "/b" },
    ]);
    const drift = describeFingerprintDrift(before, after);
    expect(drift.renamed).toEqual([{ from: "Alt", to: "Neu" }]);
    expect(drift.retargeted).toEqual([]);
  });
});
