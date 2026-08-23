/**
 * Renaming menu items — the Shopify + Prisma half.
 *
 * ONE mutation exists for this and it is menuUpdate, which takes the whole
 * item list. Read menu-write.shared.ts first: everything below is the safety
 * work that shape forces.
 *
 * The order is load-bearing, and each step is here because skipping it has a
 * specific, nameable consequence:
 *
 *   1. FRESH READ. The write-back tree comes from Shopify, never from our
 *      cache. The cache carries id and title and nothing else, so a write-back
 *      built from it would strip every url, resourceId and tag in the menu —
 *      turning a product link into a dead entry. It also selects resourceId,
 *      which the cache query deliberately does not: this is the only place
 *      that needs it, and a value only ever read to be written straight back
 *      has no business being mirrored anywhere.
 *
 *   2. DRIFT CHECK. The fingerprint of that fresh tree must equal the one the
 *      page was rendered from. Refusing here is the difference between "your
 *      colleague's rename was kept" and "your colleague's rename was silently
 *      reverted by an app they were not using".
 *
 *   3. SUBSTITUTE, DON'T REBUILD. Only the changed titles are replaced; every
 *      other field of every other item is passed through byte for byte.
 *
 *   4. ECHO + ID CHECK. userErrors:[] is not success anywhere in this codebase,
 *      and here there is a second thing to verify: menuUpdate must give every
 *      item back its OWN id. A menu item's translations live on
 *      gid://shopify/Link/<the same number> — so if Shopify ever minted new
 *      ids on update, a rename would orphan every translation in that menu and
 *      the next refreshMenuCache would delete the orphaned rows for good.
 *      MEASURED on a live shop (2026-08-23, API 2026-07,
 *      /api/menu-write-probe): every id came back its own, so this rail fires
 *      nowhere. It stays because the consequence is unrepairable and the check
 *      costs one comparison — and it REPORTS rather than pretending the save
 *      was clean.
 *
 *   5. STALE TRANSLATIONS. A confirmed rename means the text every translation
 *      of that item was written against is gone. Shopify does NOT clear them:
 *      measured in the same run, the translation survived the rename and came
 *      back outdated: true with a changed digest, i.e. the storefront keeps
 *      serving the old wording until somebody removes it. So this is the same
 *      question every other primary write in this app asks, through the same
 *      module (translation-change-policy) — menus are reconciled by no webhook
 *      at all (they have none), so they ask the UNRECONCILED side of it, and
 *      the merchant's stored choice decides.
 */

import type { PrismaClient } from "@prisma/client";
import type { ShopifyApiGateway } from "./shopify-api-gateway.service";
import { removeAndVerifyAcrossLocales, LOCALE_KEY_SEP } from "./bulk-editor/translations.server";
import { linkGidForMenuItem } from "./menu-translations.shared";
import { MENU_LINK_KEY, MENU_LINK_RESOURCE_TYPE } from "./menu-translations.server";
import { menuStructureFingerprint, invalidMenuTitle, type MenuTitleChange } from "./menu-write.shared";
import { isPurgeOnPrimaryChangeEnabled } from "./translations/translation-change-policy.server";
import { logger } from "../utils/logger.server";

// No prose and no non-ASCII inside a #graphql literal — the text between the
// backticks reaches Shopify verbatim (CLAUDE.md).

/**
 * The write-back selection: four WRITABLE levels, plus a fifth that reads
 * nothing but ids.
 *
 * Shopify documents three levels. Four are read because a level this query
 * does not read is a level the write-back would DELETE, and one past the
 * documented maximum is the cheap side of that trade. The FIFTH exists purely
 * so the depth guard can see what it guards against: with the query stopping
 * at four, a five-level menu came back looking exactly like a four-level one,
 * mapUpdateInput never reached depth 5, and the refusal was unreachable — the
 * deepest items would have been quietly dropped from the input, i.e. deleted.
 * A guard that cannot observe its own condition is not a guard.
 */
const MENU_ITEM_WRITE_FIELDS = `
  id
  title
  type
  url
  resourceId
  tags
`;

const MENU_WRITE_READ_QUERY = `#graphql
  query menuForWrite($id: ID!) {
    menu(id: $id) {
      id
      title
      handle
      items {
        ${MENU_ITEM_WRITE_FIELDS}
        items {
          ${MENU_ITEM_WRITE_FIELDS}
          items {
            ${MENU_ITEM_WRITE_FIELDS}
            items {
              ${MENU_ITEM_WRITE_FIELDS}
              items {
                id
              }
            }
          }
        }
      }
    }
  }
`;

const MENU_UPDATE_MUTATION = `#graphql
  mutation menuRenameItems($id: ID!, $title: String!, $handle: String!, $items: [MenuItemUpdateInput!]!) {
    menuUpdate(id: $id, title: $title, handle: $handle, items: $items) {
      menu {
        id
        items {
          ${MENU_ITEM_WRITE_FIELDS}
          items {
            ${MENU_ITEM_WRITE_FIELDS}
            items {
              ${MENU_ITEM_WRITE_FIELDS}
              items {
                ${MENU_ITEM_WRITE_FIELDS}
              }
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

/** How deep the write-back may go. One past what Shopify documents. */
const MAX_WRITE_DEPTH = 4;

interface RawMenu {
  id: string;
  title: string;
  handle: string;
  items?: RawMenuItem[] | null;
}

interface RawMenuItem {
  id: string;
  title: string;
  type?: string | null;
  url?: string | null;
  resourceId?: string | null;
  tags?: string[] | null;
  items?: RawMenuItem[] | null;
}

export type MenuTitleSaveStatus =
  | "ok"
  | "menuMissing"
  | "readFailed"
  | "structureChanged"
  | "unknownItems"
  | "tooDeep"
  | "unwritableItem"
  | "writeFailed";

export interface MenuTitleSaveResult {
  status: MenuTitleSaveStatus;
  /** MenuItem GIDs whose new title Shopify echoed back. */
  savedItemIds: string[];
  failures: Array<{ menuItemId: string; message: string }>;
  /**
   * Items whose id changed under the update. Empty is the expected and
   * measured case; a non-empty list means translations were orphaned and the
   * merchant has to be told, because nothing else in the app can notice.
   */
  reassignedItemIds: Array<{ before: string; after: string }>;
  /** Link GIDs whose translations were removed because their source text changed. */
  purgedLinkIds: string[];
  /**
   * How many (item, locale) rows that removal actually covered.
   *
   * Separate from purgedLinkIds.length, which counts ITEMS: on a four-locale
   * shop one renamed item is four removed translations, and a banner reading
   * "1 translation removed" over four deletions is a wrong number in the one
   * direction that matters — it understates what was thrown away.
   */
  purgedTranslationCount: number;
  /** Free-text detail for the statuses that are not per-item failures. */
  message?: string;
}

function emptyResult(status: MenuTitleSaveStatus, message?: string): MenuTitleSaveResult {
  return {
    status,
    savedItemIds: [],
    failures: [],
    reassignedItemIds: [],
    purgedLinkIds: [],
    purgedTranslationCount: 0,
    message,
  };
}

/** Depth-first list of (id, title) in tree order — the echo check's input. */
function flattenIdTitle(items: RawMenuItem[] | null | undefined, depth = 1, path: number[] = []): Array<{
  id: string;
  title: string;
  path: string;
}> {
  const out: Array<{ id: string; title: string; path: string }> = [];
  (items ?? []).forEach((item, index) => {
    const nextPath = [...path, index + 1];
    out.push({ id: item.id, title: item.title, path: nextPath.join(".") });
    out.push(...flattenIdTitle(item.items, depth + 1, nextPath));
  });
  return out;
}

/**
 * The fresh tree as menuUpdate input, with the requested titles substituted.
 *
 * Returns null when the tree cannot be expressed as valid input: deeper than
 * MAX_WRITE_DEPTH, or an item whose required `type` the read did not return.
 * Truncating or guessing instead would send a tree that is missing an item —
 * and a missing item is a DELETED item, which is the one mistake this module
 * may never make quietly.
 */
type MapResult =
  | { items: Array<Record<string, unknown>> }
  | { refusal: "tooDeep" | "unwritableItem"; itemId?: string };

function mapUpdateInput(
  items: RawMenuItem[] | null | undefined,
  titles: Map<string, string>,
  depth = 1,
): MapResult {
  const out: Array<Record<string, unknown>> = [];
  for (const item of items ?? []) {
    if (depth > MAX_WRITE_DEPTH) return { refusal: "tooDeep", itemId: item.id };
    // MEASURED: MenuItemUpdateInput requires BOTH title and type
    // (title: String!, type: MenuItemType!). A type the read did not hand back
    // would fail the mutation at the SCHEMA level — data: null, no userErrors —
    // and take every other rename in the same call with it, so it is refused
    // here instead, where the message can name the item.
    if (!item.type) return { refusal: "unwritableItem", itemId: item.id };
    const node: Record<string, unknown> = {
      id: item.id,
      title: titles.get(item.id) ?? item.title,
      type: item.type,
    };
    // Present-only, never null: a resourceId of null on an HTTP item is not the
    // same input as an absent key, and the mutation is entitled to reject it.
    if (item.url) node.url = item.url;
    if (item.resourceId) node.resourceId = item.resourceId;
    if (item.tags && item.tags.length > 0) node.tags = item.tags;
    if (item.items && item.items.length > 0) {
      const children = mapUpdateInput(item.items, titles, depth + 1);
      if ("refusal" in children) return children;
      node.items = children.items;
    }
    out.push(node);
  }
  return { items: out };
}

export interface SaveMenuItemTitlesParams {
  menuId: string;
  /** The fingerprint of the tree the merchant was looking at. */
  fingerprint: string;
  changes: MenuTitleChange[];
  /** Published foreign locales — the purge's scope. */
  foreignLocales: string[];
}

/**
 * Rename menu items, with the whole-tree write made safe.
 *
 * Never throws for a Shopify-side problem: the caller is an action whose
 * response has to reach the merchant with their draft intact, so every failure
 * comes back as a status or a per-item entry.
 */
export async function saveMenuItemTitles(
  gateway: ShopifyApiGateway,
  db: PrismaClient,
  shop: string,
  params: SaveMenuItemTitlesParams,
): Promise<MenuTitleSaveResult> {
  const { menuId, fingerprint, changes, foreignLocales } = params;
  if (changes.length === 0) return emptyResult("ok");

  // ── 1. Fresh read ────────────────────────────────────────────────────────
  let menu: RawMenu | null = null;
  try {
    const response = await gateway.graphql(MENU_WRITE_READ_QUERY, { variables: { id: menuId } });
    const payload = (await response.json()) as {
      data?: { menu?: RawMenu | null };
      errors?: Array<{ message: string }>;
    };
    if (payload.errors?.length) {
      return emptyResult("readFailed", payload.errors[0].message);
    }
    menu = payload.data?.menu ?? null;
  } catch (error) {
    return emptyResult("readFailed", error instanceof Error ? error.message : String(error));
  }
  if (!menu) return emptyResult("menuMissing");

  // ── 2. Drift check ───────────────────────────────────────────────────────
  // Fingerprinted over the same four levels the page's cache query reads. A
  // fifth level is invisible to BOTH sides, which is exactly why the depth
  // refusal below exists and why it comes before any mutation: drift detection
  // cannot cover a level nobody read, so that case is not compared, it is
  // declined.
  const freshFingerprint = menuStructureFingerprint(menu.items);
  if (freshFingerprint !== fingerprint) {
    logger.info("[MENU-WRITE] Refused a rename — the menu changed in Shopify since the page was loaded", {
      context: "MenuWrite",
      shop,
      menuId,
    });
    return emptyResult("structureChanged");
  }

  // ── 3. Substitute ────────────────────────────────────────────────────────
  const known = new Map(flattenIdTitle(menu.items).map((i) => [i.id, i.title]));
  const titles = new Map<string, string>();
  const failures: MenuTitleSaveResult["failures"] = [];
  for (const change of changes) {
    if (!known.has(change.menuItemId)) {
      // The fingerprint already proved the trees agree, so an id it does not
      // contain cannot come from this menu — it is a malformed payload, not a
      // race. Refusing the whole save is right: a half-applied write built on a
      // payload we do not understand is worse than none.
      return emptyResult("unknownItems", change.menuItemId);
    }
    if (invalidMenuTitle(change.title)) {
      failures.push({ menuItemId: change.menuItemId, message: "A menu item needs a name." });
      continue;
    }
    titles.set(change.menuItemId, change.title.trim());
  }
  if (titles.size === 0) {
    return {
      status: "ok",
      savedItemIds: [],
      failures,
      reassignedItemIds: [],
      purgedLinkIds: [],
      purgedTranslationCount: 0,
    };
  }

  const mapped = mapUpdateInput(menu.items, titles);
  if ("refusal" in mapped) {
    // Two different refusals, and they are kept apart: both mean "nothing was
    // sent", but a merchant who is told which one can act on exactly one of
    // them. The item is named because a tree of sixty gives no other clue.
    return emptyResult(
      mapped.refusal,
      mapped.refusal === "tooDeep"
        ? `This menu is nested deeper than ${MAX_WRITE_DEPTH} levels — renaming would have to rewrite a level this app cannot read.`
        : `Shopify reported the menu item ${mapped.itemId ?? "(unknown)"} without a link type, which the rename would have to send back.`,
    );
  }
  const items = mapped.items;

  // ── 4. Write, then verify the echo ───────────────────────────────────────
  let echoed: RawMenuItem[] | null | undefined;
  try {
    const response = await gateway.graphql(MENU_UPDATE_MUTATION, {
      variables: { id: menuId, title: menu.title, handle: menu.handle, items },
    });
    const payload = (await response.json()) as {
      data?: {
        menuUpdate?: {
          menu?: { id: string; items?: RawMenuItem[] | null } | null;
          userErrors?: Array<{ field?: string[] | null; message: string }>;
        };
      };
      errors?: Array<{ message: string }>;
    };
    // A schema-level error arrives as a top-level errors array with data: null
    // and never reaches userErrors — forwarding it as "saved" is the failure
    // mode this codebase names most often.
    if (payload.errors?.length) return emptyResult("writeFailed", payload.errors[0].message);
    const userErrors = payload.data?.menuUpdate?.userErrors ?? [];
    if (userErrors.length > 0) return emptyResult("writeFailed", userErrors[0].message);
    echoed = payload.data?.menuUpdate?.menu?.items;
  } catch (error) {
    return emptyResult("writeFailed", error instanceof Error ? error.message : String(error));
  }

  const before = flattenIdTitle(menu.items);
  const after = flattenIdTitle(echoed);
  const afterByPath = new Map(after.map((i) => [i.path, i]));

  const reassignedItemIds: MenuTitleSaveResult["reassignedItemIds"] = [];
  for (const item of before) {
    const echo = afterByPath.get(item.path);
    if (echo && echo.id !== item.id) reassignedItemIds.push({ before: item.id, after: echo.id });
  }

  const savedItemIds: string[] = [];
  const echoById = new Map(after.map((i) => [i.id, i.title]));
  for (const [menuItemId, title] of titles) {
    const stored = echoById.get(menuItemId);
    if (stored === title) {
      savedItemIds.push(menuItemId);
      continue;
    }
    failures.push({
      menuItemId,
      message:
        stored === undefined
          ? "Shopify accepted the change but did not report this item back — nothing was confirmed."
          : `Shopify stored "${stored}" instead.`,
    });
  }

  if (reassignedItemIds.length > 0) {
    // Not downgraded to a failure: the RENAME did happen. What broke is the
    // link between the item and its translations, which no later sync can
    // repair — so it is logged and handed to the caller to say out loud.
    logger.error("[MENU-WRITE] Shopify reassigned MenuItem ids on update — translations were orphaned", {
      context: "MenuWrite",
      shop,
      menuId,
      count: reassignedItemIds.length,
    });
  }

  // ── 5. The renamed items' translations ───────────────────────────────────
  const purgedLinkIds: string[] = [];
  let purgedTranslationCount = 0;
  if (savedItemIds.length > 0 && foreignLocales.length > 0) {
    let mayPurge = false;
    try {
      // Menus have no webhook and nothing re-translates them automatically, so
      // this is the UNRECONCILED question — the default of that accessor, but
      // passed explicitly because a reader should not have to know the default
      // to know which side menus are on.
      mayPurge = await isPurgeOnPrimaryChangeEnabled(shop, db, { reconciled: false });
    } catch {
      // The policy module fails open by design (a stale translation nobody can
      // see is worse than a deletion they can). Mirrored here rather than
      // swallowed silently.
      mayPurge = true;
    }
    if (mayPurge) {
      for (const menuItemId of savedItemIds) {
        const linkId = linkGidForMenuItem(menuItemId);
        if (!linkId) continue;
        try {
          const removal = await removeAndVerifyAcrossLocales(
            gateway,
            linkId,
            [MENU_LINK_KEY],
            foreignLocales,
            "", // Global layer only, the same scope this page writes in.
          );
          if (removal.confirmedPairs.size === 0) continue;
          // The pair key is the sweep's own (locale, key) shape, taken from
          // its exported separator rather than re-spelled here: a second copy
          // of that format would silently confirm nothing the day it drifts.
          const confirmedLocales = foreignLocales.filter((locale) =>
            removal.confirmedPairs.has(`${locale}${LOCALE_KEY_SEP}${MENU_LINK_KEY}`),
          );
          // The local row goes only where Shopify confirmed the removal; an
          // unconfirmed one leaves a stale local row the next sync corrects,
          // which is the cheaper of the two errors on a sweep like this.
          if (confirmedLocales.length > 0) {
            await db.contentTranslation.deleteMany({
              where: {
                shop,
                resourceId: linkId,
                resourceType: MENU_LINK_RESOURCE_TYPE,
                key: MENU_LINK_KEY,
                marketId: "",
                locale: { in: confirmedLocales },
              },
            });
          }
          purgedLinkIds.push(linkId);
          purgedTranslationCount += confirmedLocales.length;
        } catch (error) {
          // A failed purge never fails the rename: the primary text is already
          // written, and reporting the save as broken would send the merchant
          // into a retry that renames nothing and purges nothing.
          logger.warn("[MENU-WRITE] Could not purge translations of a renamed item", {
            context: "MenuWrite",
            shop,
            linkId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  // The cached tree is deliberately NOT mirrored here. refreshMenuCache runs
  // on every load of /app/menus and re-reads every menu from Shopify, so the
  // revalidation that follows this save already replaces it — a second writer
  // would only add a way for the two to disagree.

  logger.info("[MENU-WRITE] Renamed menu items", {
    context: "MenuWrite",
    shop,
    menuId,
    saved: savedItemIds.length,
    failed: failures.length,
    purged: purgedLinkIds.length,
  });

  return { status: "ok", savedItemIds, failures, reassignedItemIds, purgedLinkIds, purgedTranslationCount };
}
