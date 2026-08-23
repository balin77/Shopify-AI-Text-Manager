/**
 * The menu TREE editor — the pure half (no Shopify, no Prisma, no server imports).
 *
 * `menu-write.shared.ts` next door is the RENAME feature: it substitutes titles
 * into a tree it otherwise leaves alone. This module is the other posture —
 * the merchant's tree IS the intent, positions included — and everything here
 * exists because of one measured fact and its consequences:
 *
 *   menuUpdate takes the whole item list. An item not in it is DELETED.
 *
 * So the editor cannot "carry over what it does not understand"; it has to
 * state the entire tree. What it CAN carry over is the per-item fields it never
 * edits, and that is the server's job (menu-tree.server.ts). This module's job
 * is to say precisely what changed, and to refuse a tree Shopify would reject.
 *
 * Every limit below is MEASURED on a live shop (2026-08-23, API 2026-07, see
 * docs/plans/PLAN_MENU_EDITOR.md §2 and the probe):
 *
 *   - THREE levels, not the four the write path tolerates: a fourth is refused
 *     outright with "Menu has more than 3 levels of nesting".
 *   - An item keeps its id when it is re-parented, reordered, or renamed.
 *   - An item sent without an id is CREATED, at exactly the position it was
 *     sent at — which is what makes a temp key resolvable.
 *   - Re-parenting DESTROYS that item's translations, and its whole subtree's
 *     with it, on the global AND the market layer. That is why
 *     `itemsNeedingTranslationRepair` exists and why it returns descendants.
 */

/** A node as the editor holds it. */
export interface MenuEditorNode {
  /** MenuItem GID for an existing item; null for one the merchant just added. */
  id: string | null;
  /**
   * Stable identity while editing — the MenuItem GID for an existing item, a
   * client-minted key for a new one.
   *
   * Separate from `id` because dnd-kit needs a key for a node that does not
   * exist in Shopify yet, and because a new item's real id only arrives after
   * the write.
   */
  key: string;
  title: string;
  /** A MenuItemType value. Required by the mutation, so required here. */
  type: string;
  url?: string | null;
  resourceId?: string | null;
  tags?: string[];
  children: MenuEditorNode[];
}

/**
 * MEASURED: Shopify refuses a fourth level. The editor clamps its drag
 * projection against this, and the server refuses past it — one constant, two
 * users, so the two cannot disagree.
 */
export const MAX_MENU_DEPTH = 3;

/**
 * The measured MenuItemType enum, split by what each kind needs as a target.
 *
 * A type that needs a resource and is sent without one fails at the SCHEMA or
 * validation level, and menuUpdate carries the WHOLE tree — so one bad item
 * takes every other edit in the menu with it. That is why this is checked in
 * front of the mutation rather than behind it, exactly like the empty title.
 */
export const MENU_ITEM_TYPES_NEEDING_RESOURCE = [
  "COLLECTION",
  "PRODUCT",
  "PAGE",
  "BLOG",
  "ARTICLE",
  "SHOP_POLICY",
  "METAOBJECT",
] as const;

/** Types that carry a free URL. */
export const MENU_ITEM_TYPES_NEEDING_URL = ["HTTP"] as const;

/**
 * Types that need neither. Shopify returns a `url` for them anyway (measured:
 * "/", "/search", "/collections/all", "/collections") and accepts it back, so
 * a url on one of these is carried over, never stripped and never required.
 */
export const MENU_ITEM_TYPES_WITHOUT_TARGET = [
  "FRONTPAGE",
  "SEARCH",
  "CATALOG",
  "COLLECTIONS",
  "CUSTOMER_ACCOUNT_PAGE",
] as const;

export interface FlatEditorItem {
  node: MenuEditorNode;
  key: string;
  id: string | null;
  /** The parent's key, or null at the top level. */
  parentKey: string | null;
  /** 1 = top level. */
  depth: number;
  /** 0-based position among its siblings. */
  index: number;
  /** 1-based positional path, e.g. "2.1.3". */
  path: string;
}

/** Depth-first flatten, in the order the merchant sees. */
export function flattenEditorTree(
  nodes: MenuEditorNode[],
  parentKey: string | null = null,
  depth = 1,
  prefix: number[] = [],
): FlatEditorItem[] {
  const out: FlatEditorItem[] = [];
  nodes.forEach((node, index) => {
    const path = [...prefix, index + 1];
    out.push({ node, key: node.key, id: node.id, parentKey, depth, index, path: path.join(".") });
    out.push(...flattenEditorTree(node.children ?? [], node.key, depth + 1, path));
  });
  return out;
}

/** The deepest level present, 0 for an empty tree. */
export function treeDepth(nodes: MenuEditorNode[]): number {
  const flat = flattenEditorTree(nodes);
  return flat.reduce((max, item) => Math.max(max, item.depth), 0);
}

/**
 * A tree as Shopify (or our cache) hands it over, turned into editor nodes.
 *
 * One converter for both sides: the CLIENT builds its initial state from the
 * cached tree with it, and the SERVER builds the comparison tree from its
 * fresh read with it. Two converters would be two opinions about what an
 * item's key is, and the key is what the diff matches on.
 *
 * The key of an existing item IS its MenuItem GID — measured to be stable
 * across renames, reorders and re-parenting, so nothing else is needed.
 * A node without a usable id is dropped rather than given a synthetic key: it
 * cannot be addressed in a write either, and inventing a key would put a
 * phantom item in the merchant's change list.
 */
export function editorNodesFromRawTree(items: unknown): MenuEditorNode[] {
  if (!Array.isArray(items)) return [];
  const out: MenuEditorNode[] = [];
  for (const raw of items) {
    const node = raw as Record<string, unknown>;
    const id = typeof node?.id === "string" ? node.id : "";
    if (!id) continue;
    out.push({
      id,
      key: id,
      title: typeof node?.title === "string" ? node.title : "",
      type: typeof node?.type === "string" ? node.type : "",
      url: typeof node?.url === "string" ? node.url : null,
      resourceId: typeof node?.resourceId === "string" ? node.resourceId : null,
      tags: Array.isArray(node?.tags) ? (node.tags as unknown[]).filter((t): t is string => typeof t === "string") : [],
      children: editorNodesFromRawTree(node?.items),
    });
  }
  return out;
}

// ── The change list ─────────────────────────────────────────────────────────

export interface MenuTreeDiff {
  /** Existing items whose title changed. */
  renamed: Array<{ id: string; from: string; to: string }>;
  /** Existing items whose PARENT changed — the ones that lose translations. */
  reparented: Array<{ id: string; fromParent: string | null; toParent: string | null }>;
  /** Existing items that only changed position among the same siblings. */
  reordered: string[];
  /** Existing items whose link target changed. */
  retargeted: Array<{ id: string; from: string; to: string }>;
  /** Nodes with no id — they will be created. */
  created: string[];
  /** Ids present in the base tree and absent from the edited one. */
  deleted: string[];
}

export function emptyMenuTreeDiff(): MenuTreeDiff {
  return { renamed: [], reparented: [], reordered: [], retargeted: [], created: [], deleted: [] };
}

export function isEmptyMenuTreeDiff(diff: MenuTreeDiff): boolean {
  return (
    diff.renamed.length === 0 &&
    diff.reparented.length === 0 &&
    diff.reordered.length === 0 &&
    diff.retargeted.length === 0 &&
    diff.created.length === 0 &&
    diff.deleted.length === 0
  );
}

/** A short description of a node's target, for the retarget comparison. */
function targetOf(node: MenuEditorNode): string {
  return `${node.type}|${node.resourceId ?? ""}|${node.url ?? ""}`;
}

/**
 * What the merchant changed, comparing by ID.
 *
 * Reordering and re-parenting are reported SEPARATELY although both are "it
 * moved": only a change of PARENT destroys translations (measured), so the two
 * carry different costs and the save has to be able to tell them apart.
 */
export function diffMenuTrees(base: MenuEditorNode[], edited: MenuEditorNode[]): MenuTreeDiff {
  const diff = emptyMenuTreeDiff();
  const baseFlat = flattenEditorTree(base);
  const editedFlat = flattenEditorTree(edited);

  const baseById = new Map<string, FlatEditorItem>();
  for (const item of baseFlat) if (item.id) baseById.set(item.id, item);

  const seen = new Set<string>();
  for (const item of editedFlat) {
    if (!item.id) {
      diff.created.push(item.key);
      continue;
    }
    seen.add(item.id);
    const before = baseById.get(item.id);
    // An id the base tree does not know is not a rename or a move — it is a
    // payload we do not understand, and the server refuses on it separately.
    if (!before) continue;

    if (before.node.title !== item.node.title) {
      diff.renamed.push({ id: item.id, from: before.node.title, to: item.node.title });
    }
    // Parents are compared by the parent's ID, not by its editor key: a parent
    // that is itself newly created has no id, and "moved under a new item" is
    // still a re-parent.
    const beforeParentId = before.parentKey ? (baseById.get(before.parentKey)?.id ?? before.parentKey) : null;
    const afterParentKey = item.parentKey;
    const afterParentId = afterParentKey
      ? (editedFlat.find((i) => i.key === afterParentKey)?.id ?? afterParentKey)
      : null;
    if (beforeParentId !== afterParentId) {
      diff.reparented.push({ id: item.id, fromParent: beforeParentId, toParent: afterParentId });
    } else if (before.index !== item.index) {
      diff.reordered.push(item.id);
    }
    if (targetOf(before.node) !== targetOf(item.node)) {
      diff.retargeted.push({ id: item.id, from: targetOf(before.node), to: targetOf(item.node) });
    }
  }

  for (const item of baseFlat) {
    if (item.id && !seen.has(item.id)) diff.deleted.push(item.id);
  }
  return diff;
}

/**
 * Every item whose translations the write will destroy: each re-parented item
 * plus ALL of its descendants in the EDITED tree.
 *
 * The descendants are the measured part and the easy one to miss — a child
 * whose own parent did not change still loses its translation when the branch
 * above it moves. A repair that only covered the dragged item would silently
 * lose the rest of the branch.
 *
 * Deleted items are deliberately NOT included: their translations go with them
 * and there is nothing to restore them onto (a re-created item gets a new id).
 */
export function itemsNeedingTranslationRepair(
  base: MenuEditorNode[],
  edited: MenuEditorNode[],
): string[] {
  const diff = diffMenuTrees(base, edited);
  if (diff.reparented.length === 0) return [];

  const editedFlat = flattenEditorTree(edited);
  const byKey = new Map(editedFlat.map((i) => [i.key, i]));
  const childrenOf = new Map<string | null, FlatEditorItem[]>();
  for (const item of editedFlat) {
    const list = childrenOf.get(item.parentKey) ?? [];
    list.push(item);
    childrenOf.set(item.parentKey, list);
  }

  const affected = new Set<string>();
  const walk = (key: string) => {
    const item = byKey.get(key);
    if (!item) return;
    if (item.id) affected.add(item.id);
    for (const child of childrenOf.get(key) ?? []) walk(child.key);
  };
  for (const moved of diff.reparented) {
    const item = editedFlat.find((i) => i.id === moved.id);
    if (item) walk(item.key);
  }
  return [...affected];
}

// ── Validation ──────────────────────────────────────────────────────────────

export type MenuTreeProblemCode =
  | "emptyTitle"
  | "missingType"
  | "unknownType"
  | "missingTarget"
  | "tooDeep"
  | "duplicateKey"
  | "duplicateId";

export interface MenuTreeProblem {
  key: string;
  code: MenuTreeProblemCode;
  /** The item's title, so a message can name it rather than an id tail. */
  title: string;
}

const KNOWN_TYPES = new Set<string>([
  ...MENU_ITEM_TYPES_NEEDING_RESOURCE,
  ...MENU_ITEM_TYPES_NEEDING_URL,
  ...MENU_ITEM_TYPES_WITHOUT_TARGET,
]);

/**
 * Everything Shopify would refuse, found BEFORE the mutation.
 *
 * The point is not tidiness. menuUpdate is one call for the whole tree: a
 * single bad item fails it entirely, so the merchant would lose every other
 * edit in the same save and be told only "rules could not be saved". Each
 * problem here is reported against the item that caused it.
 *
 * An UNKNOWN type is a problem rather than a pass-through: the measured enum
 * has thirteen members, and a value outside it either comes from a newer API
 * version we have not read or from a malformed payload. Sending it costs the
 * whole save either way.
 */
export function validateEditorTree(nodes: MenuEditorNode[]): MenuTreeProblem[] {
  const problems: MenuTreeProblem[] = [];
  const flat = flattenEditorTree(nodes);

  const keys = new Set<string>();
  const ids = new Set<string>();
  for (const item of flat) {
    const { node } = item;
    if (keys.has(item.key)) problems.push({ key: item.key, code: "duplicateKey", title: node.title });
    keys.add(item.key);
    if (item.id) {
      if (ids.has(item.id)) problems.push({ key: item.key, code: "duplicateId", title: node.title });
      ids.add(item.id);
    }

    if (!node.title || node.title.trim() === "") {
      problems.push({ key: item.key, code: "emptyTitle", title: node.title });
    }
    if (!node.type) {
      problems.push({ key: item.key, code: "missingType", title: node.title });
    } else if (!KNOWN_TYPES.has(node.type)) {
      problems.push({ key: item.key, code: "unknownType", title: node.title });
    } else if (
      (MENU_ITEM_TYPES_NEEDING_RESOURCE as readonly string[]).includes(node.type) &&
      !node.resourceId
    ) {
      problems.push({ key: item.key, code: "missingTarget", title: node.title });
    } else if ((MENU_ITEM_TYPES_NEEDING_URL as readonly string[]).includes(node.type) && !node.url) {
      problems.push({ key: item.key, code: "missingTarget", title: node.title });
    }

    if (item.depth > MAX_MENU_DEPTH) {
      problems.push({ key: item.key, code: "tooDeep", title: node.title });
    }
  }
  return problems;
}

/**
 * A human-readable summary of what somebody ELSE changed, for the drift
 * refusal.
 *
 * Compares two trees the same way `diffMenuTrees` does, but the audience is a
 * merchant deciding whether to reload: "3 items were renamed and 1 was added
 * in Shopify" is actionable, "the menu changed" is not.
 */
export function describeForeignChanges(base: MenuEditorNode[], theirs: MenuEditorNode[]): MenuTreeDiff {
  return diffMenuTrees(base, theirs);
}
