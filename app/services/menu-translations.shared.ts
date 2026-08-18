/**
 * Menu translations — the pure half (no Shopify, no Prisma, no server imports).
 *
 * The one non-obvious fact this module encodes, measured on a live shop in
 * 2026-08 and recorded as an invariant in CLAUDE.md:
 *
 *   A menu item's translation does NOT live on the Menu resource. It lives on
 *   its own Link resource, under the single key "title", and that resource's
 *   GID carries the SAME NUMBER as the MenuItem's:
 *
 *       gid://shopify/MenuItem/796316107084
 *    -> gid://shopify/Link/796316107084
 *
 * That correspondence is why this file exists. The documented way to enumerate
 * those links — translatableResource(menu).nestedTranslatableResources(LINK) —
 * returns ZERO links for every menu at every depth, which is exactly what an
 * untranslatable resource looks like from the outside and is how this app spent
 * years telling merchants that Shopify cannot translate menu items. It can; the
 * ids simply have to be derived rather than asked for.
 *
 * Depth is not a discriminator anywhere here: a third-level item behaves
 * exactly like a first-level one, so nothing in this module branches on it.
 * Depth is carried only so the UI can indent.
 */

/** A menu item as the Menu cache stores it (Prisma Json, hence the loose shape). */
export interface MenuItemNode {
  id?: unknown;
  title?: unknown;
  items?: unknown;
}

export interface FlatMenuItem {
  menuItemId: string;
  /** Derived Link GID, or null when the MenuItem GID has no numeric tail. */
  linkId: string | null;
  title: string;
  /** 1 = top level. Presentation only. */
  depth: number;
  /** 1-based position path, e.g. [2,1,3] — used as a stable label. */
  path: number[];
}

/**
 * gid://shopify/MenuItem/<n> -> gid://shopify/Link/<n>.
 *
 * Returns null rather than guessing when the id is not of that shape: a
 * fabricated GID would be written to, and Shopify would answer without
 * userErrors while storing nothing — the silent no-op this codebase treats as
 * the worst outcome of all.
 */
export function linkGidForMenuItem(menuItemGid: string): string | null {
  const match = /^gid:\/\/shopify\/MenuItem\/(\d+)$/.exec(menuItemGid.trim());
  return match ? `gid://shopify/Link/${match[1]}` : null;
}

/**
 * Depth-first flatten of a menu's item tree, in the order the merchant sees.
 *
 * `maxDepth` is a cycle guard, not a Shopify limit: the tree comes from a JSON
 * column this app wrote, so a malformed row must not be able to hang a render.
 * Shopify documents three levels; the guard sits far above that deliberately,
 * because silently dropping a level is the failure mode this whole feature
 * exists to undo.
 */
export function flattenMenuItems(items: unknown, maxDepth = 10): FlatMenuItem[] {
  const out: FlatMenuItem[] = [];

  const walk = (nodes: unknown, depth: number, path: number[]) => {
    if (!Array.isArray(nodes) || depth > maxDepth) return;
    nodes.forEach((raw, index) => {
      const node = raw as MenuItemNode;
      const id = typeof node?.id === "string" ? node.id : "";
      const title = typeof node?.title === "string" ? node.title : "";
      if (!id) return;
      const nextPath = [...path, index + 1];
      out.push({ menuItemId: id, linkId: linkGidForMenuItem(id), title, depth, path: nextPath });
      walk(node?.items, depth + 1, nextPath);
    });
  };

  walk(items, 1, []);
  return out;
}

export interface MenuTranslationChange {
  linkId: string;
  /** Empty string means "remove the translation", never "store a blank". */
  value: string;
}

/**
 * What actually has to be written.
 *
 * Diff-only, for the same reason the bulk editor is: a save that re-sends
 * every field would re-register dozens of unchanged translations, burn the
 * translation API's own rate limit, and — because translationsRegister is
 * bound to a digest — turn a stale digest for an untouched item into a failure
 * the merchant never caused.
 *
 * Both sides are trimmed before comparing: a trailing space is not an edit,
 * but it IS a different string, and without this every whitespace wobble in a
 * text field would queue a write.
 */
export function diffMenuTranslations(
  original: Record<string, string>,
  draft: Record<string, string>,
): MenuTranslationChange[] {
  const changes: MenuTranslationChange[] = [];
  for (const [linkId, rawValue] of Object.entries(draft)) {
    const value = rawValue.trim();
    if (value === (original[linkId] ?? "").trim()) continue;
    changes.push({ linkId, value });
  }
  return changes;
}
