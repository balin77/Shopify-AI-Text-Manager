/**
 * The tree editor's pure half.
 *
 * Two things decide whether the editor is safe, and both live here: the DIFF
 * (which tells a re-parent — the only operation that destroys translations —
 * apart from a mere reorder) and the AFFECTED SET (which has to include the
 * descendants that came along, because they lose their translations too).
 * Everything else is validation that keeps one bad item from failing a
 * whole-tree write.
 */

import { describe, it, expect } from "vitest";
import {
  MAX_MENU_DEPTH,
  appendNode,
  diffMenuTrees,
  idsUnder,
  moveNode,
  projectDrop,
  removeNode,
  subtreeHeight,
  updateNode,
  editorNodesFromRawTree,
  flattenEditorTree,
  itemsNeedingTranslationRepair,
  treeDepth,
  validateEditorTree,
  type MenuEditorNode,
} from "~/services/menu-tree.shared";

function node(
  id: string | null,
  title: string,
  children: MenuEditorNode[] = [],
  extra: Partial<MenuEditorNode> = {},
): MenuEditorNode {
  return {
    id,
    key: id ?? `new-${title}`,
    title,
    type: "HTTP",
    url: "https://shop.test/x",
    children,
    ...extra,
  };
}

const base: MenuEditorNode[] = [
  node("gid://shopify/MenuItem/1", "Produkte", [
    node("gid://shopify/MenuItem/2", "Stifthalter", [node("gid://shopify/MenuItem/3", "Holz")]),
  ]),
  node("gid://shopify/MenuItem/4", "Kontakt"),
];

describe("flattenEditorTree", () => {
  it("walks depth-first with paths and parents", () => {
    const flat = flattenEditorTree(base);
    expect(flat.map((i) => `${i.path} ${i.node.title} d${i.depth}`)).toEqual([
      "1 Produkte d1",
      "1.1 Stifthalter d2",
      "1.1.1 Holz d3",
      "2 Kontakt d1",
    ]);
    expect(flat[1].parentKey).toBe("gid://shopify/MenuItem/1");
    expect(flat[3].parentKey).toBeNull();
  });

  it("reports the depth the editor has to clamp against", () => {
    expect(treeDepth(base)).toBe(3);
    expect(treeDepth([])).toBe(0);
    expect(MAX_MENU_DEPTH).toBe(3);
  });
});

describe("editorNodesFromRawTree", () => {
  it("keys an existing item by its MenuItem GID", () => {
    const tree = editorNodesFromRawTree([
      { id: "gid://shopify/MenuItem/1", title: "A", type: "PRODUCT", resourceId: "gid://shopify/Product/7", items: [] },
    ]);
    expect(tree[0]).toMatchObject({ id: "gid://shopify/MenuItem/1", key: "gid://shopify/MenuItem/1" });
  });

  it("drops a node with no id rather than inventing a key", () => {
    // A phantom item in the change list would be worse than a missing one:
    // it cannot be written either way, but it CAN be reported as a change.
    expect(editorNodesFromRawTree([{ title: "nameless" }])).toEqual([]);
    expect(editorNodesFromRawTree(null)).toEqual([]);
  });
});

describe("diffMenuTrees", () => {
  it("sees nothing in an unchanged tree", () => {
    const diff = diffMenuTrees(base, structuredClone(base));
    expect(diff).toEqual({ renamed: [], reparented: [], reordered: [], retargeted: [], created: [], deleted: [] });
  });

  it("tells a re-parent apart from a reorder", () => {
    // The whole reason the two are separate fields: only a re-parent destroys
    // translations, so only it triggers the repair.
    const reordered = [base[1], base[0]];
    // Sorted: the diff walks the EDITED tree, so the list order follows the
    // new positions and carries no meaning of its own.
    expect(diffMenuTrees(base, reordered).reordered.sort()).toEqual([
      "gid://shopify/MenuItem/1",
      "gid://shopify/MenuItem/4",
    ]);
    expect(diffMenuTrees(base, reordered).reparented).toEqual([]);

    const hoisted = [node("gid://shopify/MenuItem/1", "Produkte", []), base[0].children[0], base[1]];
    const diff = diffMenuTrees(base, hoisted);
    expect(diff.reparented).toEqual([
      { id: "gid://shopify/MenuItem/2", fromParent: "gid://shopify/MenuItem/1", toParent: null },
    ]);
  });

  it("reports a rename, a new item and a deletion", () => {
    const edited = [
      node("gid://shopify/MenuItem/1", "Produkte", [
        node("gid://shopify/MenuItem/2", "Stiftehalter", [node("gid://shopify/MenuItem/3", "Holz")]),
      ]),
      node(null, "Neu"),
    ];
    const diff = diffMenuTrees(base, edited);
    expect(diff.renamed).toEqual([
      { id: "gid://shopify/MenuItem/2", from: "Stifthalter", to: "Stiftehalter" },
    ]);
    expect(diff.created).toEqual(["new-Neu"]);
    expect(diff.deleted).toEqual(["gid://shopify/MenuItem/4"]);
  });

  it("reports a retarget", () => {
    const edited = structuredClone(base);
    edited[1] = { ...edited[1], type: "PAGE", url: null, resourceId: "gid://shopify/Page/9" };
    expect(diffMenuTrees(base, edited).retargeted).toHaveLength(1);
  });

  it("counts a move under a NEW parent as a re-parent", () => {
    // The new parent has no id, so comparing parents by id alone would read
    // "null -> null" for a top-level item dragged into a freshly added folder.
    const newParent = node(null, "Neu", [base[1]]);
    const diff = diffMenuTrees(base, [base[0], newParent]);
    expect(diff.reparented.map((r) => r.id)).toEqual(["gid://shopify/MenuItem/4"]);
  });
});

describe("itemsNeedingTranslationRepair", () => {
  it("is empty when nothing was re-parented", () => {
    expect(itemsNeedingTranslationRepair(base, [base[1], base[0]])).toEqual([]);
  });

  it("includes the descendants that came along", () => {
    // MEASURED: a child whose own parent did not change still loses its
    // translation when the branch above it moves. A repair that covered only
    // the dragged item would lose the rest of the branch silently.
    const hoisted = [node("gid://shopify/MenuItem/1", "Produkte", []), base[0].children[0], base[1]];
    expect(itemsNeedingTranslationRepair(base, hoisted).sort()).toEqual([
      "gid://shopify/MenuItem/2",
      "gid://shopify/MenuItem/3",
    ]);
  });

  it("does not include deleted items", () => {
    // Their translations went with them and there is nothing to restore onto:
    // a re-created item gets a new id (measured).
    const edited = [node("gid://shopify/MenuItem/1", "Produkte", []), base[0].children[0]];
    expect(itemsNeedingTranslationRepair(base, edited)).not.toContain("gid://shopify/MenuItem/4");
  });
});

describe("validateEditorTree", () => {
  it("passes a sound tree", () => {
    expect(validateEditorTree(base)).toEqual([]);
  });

  it("refuses an empty title", () => {
    const bad = [node("gid://shopify/MenuItem/1", "   ")];
    expect(validateEditorTree(bad).map((p) => p.code)).toEqual(["emptyTitle"]);
  });

  it("refuses a fourth level, which Shopify refuses too", () => {
    const deep = [node("a", "1", [node("b", "2", [node("c", "3", [node("d", "4")])])])];
    expect(validateEditorTree(deep).map((p) => p.code)).toEqual(["tooDeep"]);
  });

  it("refuses a resource type with no resource", () => {
    // One bad item fails the WHOLE menuUpdate, so this is caught in front of
    // the mutation rather than behind it.
    const bad = [{ ...node("gid://shopify/MenuItem/1", "Produkt"), type: "PRODUCT", url: null, resourceId: null }];
    expect(validateEditorTree(bad).map((p) => p.code)).toEqual(["missingTarget"]);
  });

  it("refuses an HTTP item with no url", () => {
    const bad = [{ ...node("gid://shopify/MenuItem/1", "Link"), url: null }];
    expect(validateEditorTree(bad).map((p) => p.code)).toEqual(["missingTarget"]);
  });

  it("accepts a target-less type without either", () => {
    const ok = [{ ...node("gid://shopify/MenuItem/1", "Start"), type: "FRONTPAGE", url: null, resourceId: null }];
    expect(validateEditorTree(ok)).toEqual([]);
  });

  it("refuses a type outside the measured enum", () => {
    const bad = [{ ...node("gid://shopify/MenuItem/1", "?"), type: "TELEPORT" }];
    expect(validateEditorTree(bad).map((p) => p.code)).toEqual(["unknownType"]);
  });

  it("refuses a duplicated id", () => {
    const bad = [node("gid://shopify/MenuItem/1", "A"), { ...node("gid://shopify/MenuItem/1", "B"), key: "other" }];
    expect(validateEditorTree(bad).map((p) => p.code)).toEqual(["duplicateId"]);
  });
});

describe("projectDrop", () => {
  const flat = () => flattenEditorTree(base);

  it("nests under the item above when the pointer moves right", () => {
    // Kontakt (last, depth 1) dragged one indent to the right lands under the
    // item above it.
    const projection = projectDrop(flat(), "gid://shopify/MenuItem/4", "gid://shopify/MenuItem/4", 40, 40);
    expect(projection.depth).toBe(2);
    expect(projection.parentKey).toBe("gid://shopify/MenuItem/1");
  });

  it("never goes past the measured maximum", () => {
    // Holz already sits at depth 3; dragging it further right must not offer a
    // fourth level, which Shopify refuses outright.
    const projection = projectDrop(flat(), "gid://shopify/MenuItem/3", "gid://shopify/MenuItem/3", 400, 40);
    expect(projection.depth).toBe(MAX_MENU_DEPTH);
  });

  it("clamps by the HEIGHT of what is being dragged", () => {
    // A two-level branch dropped at depth 3 would put its child at depth 4.
    // The canonical dnd-kit example has no such rule; without it the drop is
    // accepted in the UI and refused by Shopify.
    const projection = projectDrop(
      flat(),
      "gid://shopify/MenuItem/2",
      "gid://shopify/MenuItem/2",
      400,
      40,
      /* the branch spans two levels */ 2,
    );
    expect(projection.depth).toBe(MAX_MENU_DEPTH - 1);
  });

  it("stays at the top level for an unknown key rather than guessing", () => {
    expect(projectDrop(flat(), "nope", "gid://shopify/MenuItem/1", 0, 40)).toEqual({
      depth: 1,
      parentKey: null,
    });
  });
});

describe("tree mutations", () => {
  it("moves a node with its subtree", () => {
    const moved = moveNode(base, "gid://shopify/MenuItem/2", null, 0);
    expect(moved[0].key).toBe("gid://shopify/MenuItem/2");
    expect(moved[0].children[0].key).toBe("gid://shopify/MenuItem/3");
    expect(moved[1].children).toEqual([]);
  });

  it("refuses to move a node into its own descendant", () => {
    // A branch that contains itself is not a tree; refusing here keeps the
    // rule next to everything else that knows what a tree is.
    expect(moveNode(base, "gid://shopify/MenuItem/1", "gid://shopify/MenuItem/3", 0)).toBe(base);
    expect(moveNode(base, "gid://shopify/MenuItem/1", "gid://shopify/MenuItem/1", 0)).toBe(base);
  });

  it("updates one node without touching its children", () => {
    const updated = updateNode(base, "gid://shopify/MenuItem/1", { title: "Sortiment" });
    expect(updated[0].title).toBe("Sortiment");
    expect(updated[0].children[0].title).toBe("Stifthalter");
  });

  it("removes a node with everything under it", () => {
    expect(flattenEditorTree(removeNode(base, "gid://shopify/MenuItem/1"))).toHaveLength(1);
  });

  it("counts what a deletion would take", () => {
    // The confirmation says "and the items under it" because of this number.
    expect(idsUnder(base[0])).toEqual([
      "gid://shopify/MenuItem/1",
      "gid://shopify/MenuItem/2",
      "gid://shopify/MenuItem/3",
    ]);
    expect(subtreeHeight(base[0])).toBe(3);
    expect(subtreeHeight(base[1])).toBe(1);
  });

  it("appends a new node at the top level", () => {
    const added = appendNode(base, node(null, "Neu"));
    expect(added).toHaveLength(3);
    expect(added[2].id).toBeNull();
  });
});
