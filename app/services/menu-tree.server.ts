/**
 * Writing a whole menu tree — reorder, re-nest, add, delete, retarget, rename.
 *
 * The rename path (menu-write.server.ts) substitutes titles into Shopify's own
 * tree and passes everything else through. This one is the opposite posture:
 * the merchant's tree IS the intent, so the write states every item and every
 * position. Read menu-tree.shared.ts first for what that costs.
 *
 * Five things are load-bearing here, and each of them is a measurement rather
 * than a precaution (2026-08-23, API 2026-07, /api/menu-write-probe):
 *
 *   1. FRESH READ, still. Not for positions any more — those come from the
 *      editor — but for the per-item FIELDS the editor never shows: url,
 *      resourceId, tags. A write-back built from the editor alone would strip
 *      the product binding off every link in the menu.
 *
 *   2. DRIFT IS REFUSED, NOT MERGED. If Shopify's tree no longer matches the
 *      one the page was rendered from, nothing is written and the response
 *      SAYS WHAT CHANGED — a three-way merge would produce a tree nobody
 *      looked at, and the deletion semantics of menuUpdate make that the
 *      expensive kind of wrong. The merchant reloads (their draft survives)
 *      and decides.
 *
 *   3. NEW ITEMS ARE RESOLVED BY POSITION. An item sent without an id is
 *      created and comes back at exactly the index it was sent at, so the
 *      editor's temp key maps to the real id through the position — the same
 *      path-matching the echo check already uses.
 *
 *   4. RE-PARENTING DESTROYS TRANSLATIONS — the item's and its whole
 *      subtree's, on the global AND the market layer, with the ids unchanged.
 *      So the affected values are CAPTURED before the write and registered
 *      again after it. This is the one repair without which a drag silently
 *      throws away merchant content.
 *
 *   5. THREE LEVELS. A fourth is refused by Shopify outright, so it is refused
 *      here before the call rather than after it.
 */

import type { PrismaClient } from "@prisma/client";
import type { ShopifyApiGateway } from "./shopify-api-gateway.service";
import { linkGidForMenuItem } from "./menu-translations.shared";
import { MENU_LINK_KEY, MENU_LINK_RESOURCE_TYPE } from "./menu-translations.server";
import {
  menuStructureFingerprint,
  describeFingerprintDrift,
  type MenuFingerprintDrift,
} from "./menu-write.shared";
import {
  diffMenuTrees,
  editorNodesFromRawTree,
  flattenEditorTree,
  itemsNeedingTranslationRepair,
  validateEditorTree,
  type MenuEditorNode,
  type MenuTreeDiff,
  type MenuTreeProblem,
} from "./menu-tree.shared";
import {
  captureLinkTranslations,
  restoreLinkTranslations,
  type CapturedLinkTranslations,
} from "./menu-translation-repair.server";
import {
  loadTranslationChangePolicy,
  type TranslationChangePolicy,
} from "./translations/translation-change-policy.server";
import { removeAndVerifyAcrossLocales, LOCALE_KEY_SEP } from "./bulk-editor/translations.server";
import { logger } from "../utils/logger.server";

// No prose and no non-ASCII inside a #graphql literal (CLAUDE.md).

const MENU_ITEM_FIELDS = `
  id
  title
  type
  url
  resourceId
  tags
`;

/**
 * The read. Four levels although Shopify accepts three: an unread level is a
 * level the write-back would delete, and reading one past the platform's own
 * maximum costs an empty selection.
 */
const MENU_TREE_READ_QUERY = `#graphql
  query menuTreeForWrite($id: ID!) {
    menu(id: $id) {
      id
      title
      handle
      items {
        ${MENU_ITEM_FIELDS}
        items {
          ${MENU_ITEM_FIELDS}
          items {
            ${MENU_ITEM_FIELDS}
            items {
              ${MENU_ITEM_FIELDS}
            }
          }
        }
      }
    }
  }
`;

const MENU_TREE_UPDATE_MUTATION = `#graphql
  mutation menuTreeUpdate($id: ID!, $title: String!, $handle: String!, $items: [MenuItemUpdateInput!]!) {
    menuUpdate(id: $id, title: $title, handle: $handle, items: $items) {
      menu {
        id
        title
        items {
          ${MENU_ITEM_FIELDS}
          items {
            ${MENU_ITEM_FIELDS}
            items {
              ${MENU_ITEM_FIELDS}
            }
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

interface RawItem {
  id: string;
  title: string;
  type?: string | null;
  url?: string | null;
  resourceId?: string | null;
  tags?: string[] | null;
  items?: RawItem[] | null;
}

interface RawMenu {
  id: string;
  title: string;
  handle: string;
  items?: RawItem[] | null;
}

export type MenuTreeSaveStatus =
  | "ok"
  | "menuMissing"
  | "readFailed"
  | "structureChanged"
  | "invalidTree"
  | "unknownItems"
  | "writeFailed";

export interface MenuTreeSaveResult {
  status: MenuTreeSaveStatus;
  /** What the merchant's tree changed, as the server understood it. */
  diff: MenuTreeDiff;
  /** Editor key -> the MenuItem GID Shopify minted for it. */
  createdIds: Record<string, string>;
  /** Items whose id changed under the update — the rail that should never fire. */
  reassignedItemIds: Array<{ before: string; after: string }>;
  /** Problems found before the mutation, per item. */
  problems: MenuTreeProblem[];
  /** What somebody else changed in Shopify, when the save was refused for drift. */
  foreignChanges?: MenuFingerprintDrift;
  /** Translations restored after a move, and the ones that could not be. */
  translationRepair: { restored: number; failed: Array<{ linkId: string; message: string }> };
  /** Link GIDs whose translations were purged because their primary text changed. */
  purgedLinkIds: string[];
  purgedTranslationCount: number;
  message?: string;
}

function emptyResult(status: MenuTreeSaveStatus, extra: Partial<MenuTreeSaveResult> = {}): MenuTreeSaveResult {
  return {
    status,
    diff: { renamed: [], reparented: [], reordered: [], retargeted: [], created: [], deleted: [] },
    createdIds: {},
    reassignedItemIds: [],
    problems: [],
    translationRepair: { restored: 0, failed: [] },
    purgedLinkIds: [],
    purgedTranslationCount: 0,
    ...extra,
  };
}

/**
 * The editor's tree as menuUpdate input, with each existing item's untouched
 * fields taken from Shopify's own read.
 *
 * The merge rule per field is the whole point: TITLE, POSITION and PARENT come
 * from the editor (that is what it edits), the TARGET comes from the editor
 * only when the merchant actually retargeted the item, and everything else —
 * tags today, whatever Shopify adds tomorrow — comes from the fresh read. An
 * item the fresh read does not know is a NEW item and is sent without an id.
 */
function buildUpdateInput(
  nodes: MenuEditorNode[],
  fresh: Map<string, RawItem>,
  retargeted: Set<string>,
): Array<Record<string, unknown>> {
  return nodes.map((node) => {
    const existing = node.id ? fresh.get(node.id) : undefined;
    const useEditorTarget = !existing || (node.id ? retargeted.has(node.id) : true);

    const item: Record<string, unknown> = {
      title: node.title.trim(),
      type: useEditorTarget ? node.type : (existing?.type ?? node.type),
    };
    if (node.id) item.id = node.id;

    const url = useEditorTarget ? node.url : existing?.url;
    const resourceId = useEditorTarget ? node.resourceId : existing?.resourceId;
    // Present-only, never null: an explicit null is a different input from an
    // absent key, and the mutation is entitled to reject it.
    if (url) item.url = url;
    if (resourceId) item.resourceId = resourceId;

    const tags = existing?.tags ?? node.tags;
    if (tags && tags.length > 0) item.tags = tags;

    const children = buildUpdateInput(node.children ?? [], fresh, retargeted);
    if (children.length > 0) item.items = children;
    return item;
  });
}

/** Depth-first (id, title, path) of a raw tree — the echo comparison's input. */
function flattenRaw(items: RawItem[] | null | undefined, prefix: number[] = []): Array<{
  id: string;
  title: string;
  path: string;
}> {
  const out: Array<{ id: string; title: string; path: string }> = [];
  (items ?? []).forEach((item, index) => {
    const path = [...prefix, index + 1];
    out.push({ id: item.id, title: item.title, path: path.join(".") });
    out.push(...flattenRaw(item.items, path));
  });
  return out;
}

/** Every raw item by id, at any depth. */
function indexRaw(items: RawItem[] | null | undefined, into = new Map<string, RawItem>()): Map<string, RawItem> {
  for (const item of items ?? []) {
    into.set(item.id, item);
    indexRaw(item.items, into);
  }
  return into;
}

export interface SaveMenuTreeParams {
  menuId: string;
  /** The fingerprint of the tree the page was rendered from. */
  fingerprint: string;
  /** The tree the merchant built. */
  tree: MenuEditorNode[];
  /** The menu's own title, when the merchant changed it. */
  menuTitle?: string;
  /** Published foreign locales — the scope of both the repair and the purge. */
  foreignLocales: string[];
  /**
   * The shop's primary locale — the language the titles are written in, which
   * the auto-re-translation has to name. Empty (a failed lookup) simply means
   * no re-translation: there is nothing to translate FROM, so the deletion
   * takes over, which is the direction that never leaves stale text live.
   */
  primaryLocale: string;
  /** Active market ids. The repair covers them; an empty list means global only. */
  marketIds: string[];
}

/**
 * Write the merchant's tree.
 *
 * Never throws for a Shopify-side problem: the caller is an action whose
 * response has to reach the merchant with their draft intact.
 */
export async function saveMenuTree(
  gateway: ShopifyApiGateway,
  db: PrismaClient,
  shop: string,
  params: SaveMenuTreeParams,
): Promise<MenuTreeSaveResult> {
  const { menuId, fingerprint, tree, menuTitle, foreignLocales, primaryLocale, marketIds } = params;

  // ── 1. Fresh read ────────────────────────────────────────────────────────
  let menu: RawMenu | null = null;
  try {
    const response = await gateway.graphql(MENU_TREE_READ_QUERY, { variables: { id: menuId } });
    const payload = (await response.json()) as {
      data?: { menu?: RawMenu | null };
      errors?: Array<{ message: string }>;
    };
    if (payload.errors?.length) return emptyResult("readFailed", { message: payload.errors[0].message });
    menu = payload.data?.menu ?? null;
  } catch (error) {
    return emptyResult("readFailed", { message: error instanceof Error ? error.message : String(error) });
  }
  if (!menu) return emptyResult("menuMissing");

  const baseTree = editorNodesFromRawTree(menu.items);

  // ── 2. Drift ─────────────────────────────────────────────────────────────
  // Refused, not merged — and described, because "the menu changed" does not
  // tell a merchant whether reloading costs them anything.
  const freshFingerprint = menuStructureFingerprint(menu.items);
  if (freshFingerprint !== fingerprint) {
    const foreignChanges = describeFingerprintDrift(fingerprint, freshFingerprint);
    logger.info("[MENU-TREE] Refused a tree save — the menu changed in Shopify since the page loaded", {
      context: "MenuTree",
      shop,
      menuId,
      added: foreignChanges.added.length,
      removed: foreignChanges.removed.length,
      renamed: foreignChanges.renamed.length,
      moved: foreignChanges.moved.length,
      retargeted: foreignChanges.retargeted.length,
    });
    return emptyResult("structureChanged", { foreignChanges });
  }

  // ── 3. Validate, and only then diff ──────────────────────────────────────
  const problems = validateEditorTree(tree);
  if (problems.length > 0) return emptyResult("invalidTree", { problems });

  const freshById = indexRaw(menu.items);
  for (const item of flattenEditorTree(tree)) {
    // The fingerprint already proved the trees agree, so an id the fresh tree
    // does not contain is a malformed payload rather than a race.
    if (item.id && !freshById.has(item.id)) {
      return emptyResult("unknownItems", { message: item.id });
    }
  }

  const diff = diffMenuTrees(baseTree, tree);
  const retargeted = new Set(diff.retargeted.map((r) => r.id));

  // ── 4. Capture what the move is about to destroy ─────────────────────────
  // BEFORE the write, because afterwards it is gone. Read from Shopify rather
  // than from our mirror: a shop that translated in Shopify's own editor holds
  // values this app has never written, and they would be destroyed just the
  // same.
  const repairIds = itemsNeedingTranslationRepair(baseTree, tree);
  let captured: CapturedLinkTranslations[] = [];
  if (repairIds.length > 0 && foreignLocales.length > 0) {
    const linkIds = repairIds.map(linkGidForMenuItem).filter((id): id is string => !!id);
    captured = await captureLinkTranslations(gateway, linkIds, foreignLocales, marketIds);
  }

  // ── 5. Write ─────────────────────────────────────────────────────────────
  const items = buildUpdateInput(tree, freshById, retargeted);
  let echoed: RawItem[] | null | undefined;
  try {
    const response = await gateway.graphql(MENU_TREE_UPDATE_MUTATION, {
      variables: {
        id: menuId,
        title: (menuTitle ?? menu.title).trim() || menu.title,
        handle: menu.handle,
        items,
      },
    });
    const payload = (await response.json()) as {
      data?: {
        menuUpdate?: {
          menu?: { id: string; items?: RawItem[] | null } | null;
          userErrors?: Array<{ field?: string[] | null; message: string }>;
        };
      };
      errors?: Array<{ message: string }>;
    };
    // A schema-level error arrives as a top-level array with data: null and
    // never reaches userErrors.
    if (payload.errors?.length) return emptyResult("writeFailed", { diff, message: payload.errors[0].message });
    const userErrors = payload.data?.menuUpdate?.userErrors ?? [];
    if (userErrors.length > 0) return emptyResult("writeFailed", { diff, message: userErrors[0].message });
    echoed = payload.data?.menuUpdate?.menu?.items;
  } catch (error) {
    return emptyResult("writeFailed", {
      diff,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  // ── 6. Echo: ids by position, new ids by position ────────────────────────
  const sentFlat = flattenEditorTree(tree);
  const echoedFlat = flattenRaw(echoed);
  const echoedByPath = new Map(echoedFlat.map((i) => [i.path, i]));

  const reassignedItemIds: Array<{ before: string; after: string }> = [];
  const createdIds: Record<string, string> = {};
  for (const sent of sentFlat) {
    const back = echoedByPath.get(sent.path);
    if (!back) continue;
    if (sent.id && back.id !== sent.id) {
      reassignedItemIds.push({ before: sent.id, after: back.id });
    } else if (!sent.id) {
      // MEASURED: a created item comes back at exactly the position it was
      // sent at, which is the only handle the editor's temp key has.
      createdIds[sent.key] = back.id;
    }
  }
  if (reassignedItemIds.length > 0) {
    logger.error("[MENU-TREE] Shopify reassigned MenuItem ids — translations were orphaned", {
      context: "MenuTree",
      shop,
      menuId,
      count: reassignedItemIds.length,
    });
  }

  // ── 7. Put the moved items' translations back ────────────────────────────
  const translationRepair = { restored: 0, failed: [] as Array<{ linkId: string; message: string }> };
  if (captured.length > 0) {
    const outcome = await restoreLinkTranslations(gateway, db, shop, captured);
    translationRepair.restored = outcome.restored;
    translationRepair.failed = outcome.failed;
  }

  // ── 8. Renamed items: the merchant's stale-translation setting ───────────
  // Unchanged from the rename path, including the reason menus are on the
  // unreconciled side (no webhook, nothing re-translates them). An item that
  // was BOTH renamed and moved is deliberately skipped here: its translations
  // were just restored in step 7, and purging them again would delete the
  // repair — the merchant's rename intent is served by the fact that the
  // restored value is now flagged outdated.
  const purgedLinkIds: string[] = [];
  let purgedTranslationCount = 0;
  const movedIds = new Set(diff.reparented.map((r) => r.id));
  const renamedOnlyEntries = diff.renamed.filter((r) => !movedIds.has(r.id));
  const renamedOnly = renamedOnlyEntries.map((r) => r.id);

  // With auto-translate on, a rename is REPLACED rather than deleted. A menu
  // has no webhook and no sync of its own, so this save is the only event that
  // will ever notice — which is precisely why the deletion used to stand
  // regardless of the switch.
  let policy: TranslationChangePolicy | null = null;
  /** Did the repair actually take responsibility for these renames? */
  let repairDidSomething = false;
  if (renamedOnly.length > 0 && foreignLocales.length > 0) {
    try {
      policy = await loadTranslationChangePolicy(shop, db);
    } catch {
      policy = null; // The policy module fails open by design; so does this.
    }
  }
  const retranslateRenames =
    !!policy?.autoTranslateExternalChanges && !!primaryLocale && renamedOnly.length > 0;

  if (retranslateRenames) {
    try {
      const { reconcileAfterPrimarySave } = await import(
        "./translations/stale-translation-sync.server"
      );
      const outcome = await reconcileAfterPrimarySave({
        client: gateway,
        shop,
        // The GROUP is the menu — one Task row the merchant recognises, one
        // in-flight key. Each entry names the LINK its translation lives on,
        // which is what the register, the removal and the mirror address.
        resourceId: menuId,
        resourceType: "Menu",
        // The prompt comes from `translateAs`; this only decides the Task
        // label, and `taskResourceType` keeps a menu OUT of the admin-path map,
        // which has no entry for it and must not guess one.
        contentKind: "page",
        taskResourceType: "menu",
        resourceTitle: menuTitle || menuId,
        changed: renamedOnlyEntries
          .map((entry) => ({
            resourceId: linkGidForMenuItem(entry.id) ?? "",
            resourceType: MENU_LINK_RESOURCE_TYPE,
            key: MENU_LINK_KEY,
            // A rename keeps the translation and flags it outdated with a
            // CHANGED digest (measured, CLAUDE.md), so the read-back must show
            // the new title before anything may be translated against it.
            // TRIMMED, because that is what `buildUpdateInput` sent: comparing
            // against the raw editor value would make a title with stray
            // whitespace mismatch, and a mismatch is a decline — the
            // translation would be deleted, which is the outcome this branch
            // exists to prevent.
            expectedValue: entry.to.trim(),
          }))
          .filter((entry) => !!entry.resourceId),
        foreignLocales,
        policy: policy!,
        translateAs: {
          kind: "values",
          context: "navigation menu item titles",
          sourceLocale: primaryLocale,
        },
      });
      // The repair removes what it cannot re-translate (a cleared title, a
      // missing digest, a stale read-back the merchant asked to delete). That
      // is a deletion the merchant should see, so it joins the count the purge
      // branch reports rather than leaving it at zero.
      purgedTranslationCount += outcome.removed;
      // The repair may legitimately do NOTHING — a throttled read-back, a spent
      // detection budget, a locale whose query failed. Menus have no webhook and
      // no sync, so "nothing happened" means the stale title stays live for
      // good; the deletion this branch replaces has to take over instead.
      repairDidSomething = outcome.removed > 0 || outcome.retranslating > 0;
    } catch (error) {
      // Never fail the save over the repair: the tree write has already gone
      // through, and a thrown error here would report it as broken.
      logger.warn("[MENU-TREE] Rename re-translation failed — translations kept", {
        context: "MenuTree",
        shop,
        menuId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!repairDidSomething && renamedOnly.length > 0 && foreignLocales.length > 0) {
    // `purgeUnreconciledSurfaces` is the merchant's stored answer, unmodified —
    // it is what applies wherever nothing re-translates, which is every menu
    // save that did not just take the branch above.
    const mayPurge = policy?.purgeUnreconciledSurfaces ?? true;
    if (mayPurge) {
      for (const menuItemId of renamedOnly) {
        const linkId = linkGidForMenuItem(menuItemId);
        if (!linkId) continue;
        try {
          // A renamed item's MARKET overrides go too — a menu title is one of
          // the surfaces the repair never re-translates on that layer, and a
          // menu has no webhook to notice later.
          try {
            const { purgeMarketOverrides } = await import(
              "./translations/market-layer-purge.server"
            );
            const { contentTranslationMirror } = await import(
              "./translations/stale-translation-sync.server"
            );
            await purgeMarketOverrides({
              gateway,
              mirror: contentTranslationMirror(shop),
              refs: [{ resourceId: linkId, resourceType: "Link" }],
              locales: foreignLocales,
              keys: [MENU_LINK_KEY],
              context: "menu",
            });
          } catch {
            // Logged inside; never fails the menu write that already happened.
          }

          const removal = await removeAndVerifyAcrossLocales(
            gateway,
            linkId,
            [MENU_LINK_KEY],
            foreignLocales,
            "",
          );
          const confirmed = foreignLocales.filter((locale) =>
            removal.confirmedPairs.has(`${locale}${LOCALE_KEY_SEP}${MENU_LINK_KEY}`),
          );
          if (confirmed.length === 0) continue;
          await db.contentTranslation.deleteMany({
            where: {
              shop,
              resourceId: linkId,
              resourceType: MENU_LINK_RESOURCE_TYPE,
              key: MENU_LINK_KEY,
              marketId: "",
              locale: { in: confirmed },
            },
          });
          purgedLinkIds.push(linkId);
          purgedTranslationCount += confirmed.length;
        } catch (error) {
          logger.warn("[MENU-TREE] Could not purge translations of a renamed item", {
            context: "MenuTree",
            shop,
            linkId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  // ── 9. Deleted items: drop their local mirror rows ───────────────────────
  // Shopify already took the translations with the item (measured: the Link
  // stops resolving), so this is bookkeeping, not a second delete — and it
  // must never fail the save for that reason.
  if (diff.deleted.length > 0) {
    const deletedLinkIds = diff.deleted.map(linkGidForMenuItem).filter((id): id is string => !!id);
    if (deletedLinkIds.length > 0) {
      try {
        await db.contentTranslation.deleteMany({
          where: { shop, resourceType: MENU_LINK_RESOURCE_TYPE, resourceId: { in: deletedLinkIds } },
        });
      } catch (error) {
        logger.warn("[MENU-TREE] Could not clean up a deleted item's local translations", {
          context: "MenuTree",
          shop,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  logger.info("[MENU-TREE] Saved a menu tree", {
    context: "MenuTree",
    shop,
    menuId,
    renamed: diff.renamed.length,
    reparented: diff.reparented.length,
    created: diff.created.length,
    deleted: diff.deleted.length,
    restored: translationRepair.restored,
    repairFailed: translationRepair.failed.length,
  });

  return {
    status: "ok",
    diff,
    createdIds,
    reassignedItemIds,
    problems: [],
    translationRepair,
    purgedLinkIds,
    purgedTranslationCount,
  };
}
