/**
 * The menu tree's FINGERPRINT — the pure half (no Shopify, no Prisma, no
 * server imports).
 *
 * This module used to hold the rename feature. That feature is gone, absorbed
 * by the tree editor (menu-tree.shared.ts / menu-tree.server.ts): a rename is
 * one kind of tree change, and TWO whole-tree writers on one menu is a hazard
 * rather than a convenience — the second one's drift check would fail against
 * the first one's own result. What survived is the part both would have
 * needed, and the reason it exists is unchanged:
 *
 *   A TRANSLATION addresses one Link resource with translationsRegister. One
 *   item, one call, and nothing else in the menu is touched.
 *
 *   A RENAME goes through menuUpdate, which takes the WHOLE item list. There
 *   is no "update this one item" mutation. So "rename one item" is really
 *   "write the merchant's entire navigation back", and an item that is not in
 *   the list we send is DELETED, not left alone.
 *
 * Everything here exists to make that safe. The write path re-reads the tree
 * from Shopify immediately before writing and substitutes ONLY the titles the
 * merchant changed — every url, resourceId, tag and position comes from that
 * fresh read, so an edit made elsewhere in the meantime is carried forward
 * rather than reverted. The one thing a fresh read cannot carry forward is a
 * TITLE somebody else changed, because a title is exactly what we are
 * replacing. That is what the fingerprint is for: it pins the tree we showed
 * the merchant, and a save whose fresh tree does not match it is refused
 * instead of silently reverting the other person's edit.
 */

/** A menu item as both the cache JSON and the fresh read expose it. */
export interface MenuTreeNode {
  id?: unknown;
  title?: unknown;
  items?: unknown;
}

/**
 * A stable description of "the tree as it was shown", for detecting that
 * somebody else moved it underneath us.
 *
 * Contains position, id AND title. The first two catch a restructure; the
 * TITLE is in there because the write substitutes titles — an item renamed in
 * the Shopify admin while this page was open would otherwise be quietly reset
 * to the label our page still remembers, which is the one class of data loss
 * this whole feature could cause. Everything else (url, resourceId, tags) is
 * deliberately absent: those are carried over from the fresh read verbatim, so
 * a change to them is preserved by construction and must not block a save.
 *
 * Line-oriented rather than hashed: when a save is refused, the two strings
 * can be diffed in a log to say WHAT moved. A menu has tens of items, not
 * thousands, so the size is irrelevant.
 */
export function menuStructureFingerprint(items: unknown, maxDepth = 10): string {
  const lines: string[] = [];

  const walk = (nodes: unknown, depth: number, path: number[]) => {
    if (!Array.isArray(nodes) || depth > maxDepth) return;
    nodes.forEach((raw, index) => {
      const node = raw as MenuTreeNode;
      const id = typeof node?.id === "string" ? node.id : "";
      if (!id) return;
      const title = typeof node?.title === "string" ? node.title : "";
      const nextPath = [...path, index + 1];
      // Tab-separated: a title may contain anything a merchant can type, and a
      // separator that can appear inside a value makes two different trees
      // able to produce one fingerprint.
      lines.push(`${nextPath.join(".")}\t${id}\t${title}`);
      walk(node?.items, depth + 1, nextPath);
    });
  };

  walk(items, 1, []);
  return lines.join("\n");
}

/**
 * What somebody ELSE changed, read out of the two fingerprints.
 *
 * No extra payload and no second read: the fingerprint is already
 * `path<TAB>id<TAB>title` per line, i.e. exactly the tree the page was
 * rendered from. Parsing it back turns a bare refusal ("the menu changed")
 * into something a merchant can act on ("Kontakt was renamed and one item was
 * added"), which is the difference between reloading confidently and
 * wondering what one is about to lose.
 *
 * Titles are what the report names — an id tail names nothing.
 */
export interface MenuFingerprintDrift {
  added: string[];
  removed: string[];
  renamed: Array<{ from: string; to: string }>;
  moved: string[];
}

export function describeFingerprintDrift(before: string, after: string): MenuFingerprintDrift {
  const parse = (fingerprint: string) => {
    const byId = new Map<string, { path: string; title: string }>();
    for (const line of fingerprint.split("\n")) {
      if (!line) continue;
      const [path, id, ...rest] = line.split("\t");
      // A title may legitimately be empty; a line without an id cannot be
      // matched at all and is skipped rather than guessed at.
      if (!id) continue;
      byId.set(id, { path, title: rest.join("\t") });
    }
    return byId;
  };

  const drift: MenuFingerprintDrift = { added: [], removed: [], renamed: [], moved: [] };
  const beforeById = parse(before);
  const afterById = parse(after);

  for (const [id, now] of afterById) {
    const then = beforeById.get(id);
    if (!then) {
      drift.added.push(now.title);
      continue;
    }
    if (then.title !== now.title) drift.renamed.push({ from: then.title, to: now.title });
    else if (then.path !== now.path) drift.moved.push(now.title);
  }
  for (const [id, then] of beforeById) {
    if (!afterById.has(id)) drift.removed.push(then.title);
  }
  return drift;
}
