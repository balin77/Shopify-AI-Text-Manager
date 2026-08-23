/**
 * Menu WRITE probe — what does menuUpdate actually do to a menu?
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * /app/menus translates menu items and refuses to touch their PRIMARY titles.
 * That refusal was never a platform limit — the scope
 * (write_online_store_navigation) has been declared since the URL-redirect
 * feature — it was a refusal to write a mutation whose behaviour nobody here
 * had measured. `menuUpdate` takes the WHOLE item list, so "rename one item"
 * is in truth "write the merchant's entire navigation back from our cache".
 * Everything dangerous about the feature follows from that one shape, and
 * every fact it depends on is measurable in about four round trips:
 *
 *   1. IDS. Does a MenuItem keep its id across an update? This is the
 *      load-bearing one and it is not cosmetic: a menu item's translation
 *      lives on gid://shopify/Link/<same number> (measured 2026-08, see
 *      menu-translations.shared.ts). If Shopify mints new ids on update, a
 *      rename silently orphans every translation of that menu — and
 *      refreshMenuCache's orphan cleanup would then DELETE those rows on the
 *      very next page load. A feature that loses translations on rename is
 *      not shippable; a feature whose ids are stable is.
 *
 *   2. OMISSION. Is an item left out of the list actually deleted? The whole
 *      conservative design of the write path (re-read fresh, refuse on drift)
 *      is justified by the answer being yes. If it were no, the design would
 *      be needless ceremony — so it is measured rather than assumed.
 *
 *   3. RESOURCE BINDING. A menu item that points at a product carries a
 *      resourceId. Our cache query never selected it, so a naive write-back
 *      would turn a product link into nothing. This measures whether
 *      resourceId survives a round trip when it IS sent — i.e. whether
 *      reading it is sufficient.
 *
 *   4. TRANSLATION SURVIVAL. After a primary rename, is the item's existing
 *      translation still there, and does Shopify mark it outdated? That
 *      decides whether the app's own stale-translation policy has anything to
 *      react to, or whether Shopify already dropped the value.
 *
 *   5. SCHEMA. The exact fields of MenuItemCreateInput / MenuItemUpdateInput,
 *      read by introspection FROM THE SHOP. shopify.dev is not reachable from
 *      every environment this repo is developed in, and a hand-copied input
 *      shape is exactly how the collection-sources reader shipped dead (see
 *      CLAUDE.md): an unknown field is a SCHEMA-level error with data: null
 *      and no userErrors, so it fails everything at once and explains nothing.
 *
 * ── Why it builds its own menu ─────────────────────────────────────────────
 * Every measurement above is destructive by nature — the omission test
 * DELETES a menu item. Doing that to the merchant's navigation to learn how
 * deletion works is not a probe, it is an outage. So the probe creates its own
 * three-level menu under a stamped handle, measures on it, and deletes it in a
 * finally. A menu is only rendered by a theme that references its handle, so a
 * throwaway handle is invisible in the storefront for the seconds it lives.
 * If the delete ever fails, the report says so with the handle, loudly.
 *
 * Nothing here reads or writes the shop's real menus.
 */

import { data as json, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { logger } from "~/utils/logger.server";
import { db } from "~/db.server";
import { meetsPlan } from "~/utils/planUtils";
import { resolveApiVersionString } from "~/utils/api-version";
import { linkGidForMenuItem } from "~/services/menu-translations.shared";

// ── Queries and mutations ──────────────────────────────────────────────────
// No prose and no non-ASCII inside a #graphql literal: the text between the
// backticks goes to Shopify verbatim, and a comment there has taken this app's
// blog page down once already (CLAUDE.md).

/**
 * The read selection every step shares. Four levels although Shopify documents
 * three — a query that reads exactly as deep as the docs promise cannot tell
 * "there is no fourth level" from "we did not look", and this probe's whole
 * subject is what happens to items nobody looked at.
 */
const MENU_ITEM_FIELDS = `
  id
  title
  type
  url
  resourceId
  tags
`;

const MENU_READ_QUERY = `#graphql
  query menuWriteProbeRead($id: ID!) {
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

const MENU_CREATE_MUTATION = `#graphql
  mutation menuWriteProbeCreate($title: String!, $handle: String!, $items: [MenuItemCreateInput!]!) {
    menuCreate(title: $title, handle: $handle, items: $items) {
      menu {
        id
        handle
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const MENU_UPDATE_MUTATION = `#graphql
  mutation menuWriteProbeUpdate($id: ID!, $title: String!, $handle: String!, $items: [MenuItemUpdateInput!]!) {
    menuUpdate(id: $id, title: $title, handle: $handle, items: $items) {
      menu {
        id
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

const MENU_DELETE_MUTATION = `#graphql
  mutation menuWriteProbeDelete($id: ID!) {
    menuDelete(id: $id) {
      deletedMenuId
      userErrors {
        field
        message
      }
    }
  }
`;

const SAMPLE_RESOURCES_QUERY = `#graphql
  query menuWriteProbeSamples {
    products(first: 1) {
      nodes {
        id
        title
      }
    }
    collections(first: 1) {
      nodes {
        id
        title
      }
    }
  }
`;

/**
 * One real sample per resource-bound MenuItemType.
 *
 * Written flat rather than nested: an articles connection inside blogs would
 * multiply the query cost by the parent page size, the same rule the gallery
 * video sweep follows. Every connection asks for ONE node, which is all a
 * "does this type bind at all" measurement needs.
 *
 * `metaobjects` requires a type argument, so it is asked separately once the
 * definition list is known — a metaobject sample cannot be selected blind.
 */
const BOUND_SAMPLES_QUERY = `#graphql
  query menuWriteProbeBoundSamples {
    products(first: 1) {
      nodes {
        id
        title
      }
    }
    collections(first: 1) {
      nodes {
        id
        title
      }
    }
    pages(first: 1) {
      nodes {
        id
        title
      }
    }
    blogs(first: 1) {
      nodes {
        id
        title
      }
    }
    articles(first: 1) {
      nodes {
        id
        title
      }
    }
    shop {
      privacyPolicy {
        id
      }
      refundPolicy {
        id
      }
    }
    metaobjectDefinitions(first: 1) {
      nodes {
        type
      }
    }
  }
`;

const METAOBJECT_SAMPLE_QUERY = `#graphql
  query menuWriteProbeMetaobjectSample($type: String!) {
    metaobjects(first: 1, type: $type) {
      nodes {
        id
        displayName
      }
    }
  }
`;

const LOCALES_QUERY = `#graphql
  query menuWriteProbeLocales {
    shopLocales {
      locale
      primary
      published
    }
  }
`;

const LINK_TRANSLATABLE_QUERY = `#graphql
  query menuWriteProbeLink($id: ID!, $locale: String!) {
    translatableResource(resourceId: $id) {
      resourceId
      translatableContent {
        key
        value
        digest
      }
      translations(locale: $locale) {
        key
        value
        outdated
      }
    }
  }
`;

/**
 * The same read, but scoped to a market.
 *
 * A separate document rather than an optional argument on the one above: the
 * measured rule is that translations(marketId: null) returns the GLOBAL layer
 * ONLY (CLAUDE.md), so the two reads answer different questions and a caller
 * that passed null by accident would silently get the wrong one.
 */
const LINK_TRANSLATABLE_MARKET_QUERY = `#graphql
  query menuWriteProbeLinkMarket($id: ID!, $locale: String!, $marketId: ID!) {
    translatableResource(resourceId: $id) {
      resourceId
      translatableContent {
        key
        value
        digest
      }
      translations(locale: $locale, marketId: $marketId) {
        key
        value
        outdated
      }
    }
  }
`;

const MARKETS_QUERY = `#graphql
  query menuWriteProbeMarkets {
    markets(first: 10) {
      nodes {
        id
        name
        handle
        status
      }
    }
  }
`;

const REGISTER_MUTATION = `#graphql
  mutation menuWriteProbeRegister($resourceId: ID!, $translations: [TranslationInput!]!) {
    translationsRegister(resourceId: $resourceId, translations: $translations) {
      translations {
        key
        value
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * Introspection of the two input objects, run against the SHOP rather than
 * against shopify.dev: the schema proxy is unreachable from sandboxed
 * environments, and the shop's own schema is the one the app talks to anyway.
 */
const INPUT_INTROSPECTION_QUERY = `#graphql
  query menuWriteProbeSchema {
    createInput: __type(name: "MenuItemCreateInput") {
      name
      inputFields {
        name
        type {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
            }
          }
        }
      }
    }
    updateInput: __type(name: "MenuItemUpdateInput") {
      name
      inputFields {
        name
        type {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
            }
          }
        }
      }
    }
    itemType: __type(name: "MenuItemType") {
      name
      enumValues {
        name
      }
    }
  }
`;

// ── Report shape ───────────────────────────────────────────────────────────

interface ProbeItem {
  id: string;
  title: string;
  type: string | null;
  url: string | null;
  resourceId: string | null;
  tags: string[];
  depth: number;
  path: string;
}

interface SchemaField {
  name: string;
  type: string;
  required: boolean;
}

export interface MenuWriteProbeReport {
  generatedAt: string;
  shop: string;
  apiVersion: string;
  schema: {
    error?: string;
    createInput: SchemaField[];
    updateInput: SchemaField[];
    itemTypes: string[];
  };
  setup: {
    handle: string;
    menuId: string | null;
    boundResource: { type: string; id: string; title: string } | null;
    created: boolean;
    errors: string[];
  };
  baseline: {
    items: ProbeItem[];
    /** resourceId survived the CREATE round trip (null = nothing bound). */
    resourceIdStoredOnCreate: boolean | null;
  };
  rename: {
    attempted: boolean;
    targetItemId: string | null;
    targetPath: string | null;
    newTitle: string | null;
    echoedTitle: string | null;
    readBackTitle: string | null;
    idsStable: boolean | null;
    idChanges: Array<{ path: string; before: string; after: string }>;
    collateralTitleChanges: Array<{ path: string; before: string; after: string }>;
    resourceIdPreserved: boolean | null;
    itemCountBefore: number;
    itemCountAfter: number;
    errors: string[];
  };
  omission: {
    attempted: boolean;
    omittedItemId: string | null;
    omittedPath: string | null;
    stillPresentAfterwards: boolean | null;
    siblingsSurvived: boolean | null;
    errors: string[];
  };
  translation: {
    attempted: boolean;
    locale: string | null;
    linkId: string | null;
    /** The Link resource of a just-created menu item resolves at all. */
    linkResolved: boolean | null;
    registered: boolean | null;
    valueBeforeRename: string | null;
    valueAfterRename: string | null;
    outdatedAfterRename: boolean | null;
    digestChanged: boolean | null;
    errors: string[];
  };
  /**
   * Does a whole-tree write-back survive item types that are neither HTTP nor
   * resource-bound?
   *
   * The write path sends every field Shopify handed it, `url` included. A
   * default main menu's FRONTPAGE / SEARCH / CATALOG item comes back WITH a
   * url, and if the mutation refuses that pairing the single userError fails
   * the entire menuUpdate — no rename in that menu would ever land. Measured
   * in a SECOND throwaway menu so an item type this shop's schema does not
   * accept cannot block the measurements above.
   */
  /**
   * §2.1 — does an item keep its id when it is MOVED?
   *
   * The load-bearing one for the tree editor, and heavier than the rename
   * question: a translation lives on gid://shopify/Link/<the item's number>,
   * so if re-parenting mints a new id, EVERY drag loses that item's
   * translations and refreshMenuCache's orphan cleanup deletes the rows on the
   * next page load. One write does both halves of the question — the item is
   * hoisted to another parent AND its siblings are reordered.
   */
  move: {
    attempted: boolean;
    movedItemId: string | null;
    /** The id found at the item's NEW position, by title. */
    idAfterMove: string | null;
    idKept: boolean | null;
    /** Its subtree came along with it, ids intact. */
    childIdKept: boolean | null;
    /** Depth before and after, so "it moved at all" is visible in the report. */
    depthBefore: number | null;
    depthAfter: number | null;
    /** Reordered siblings keep their ids too. */
    siblingIdsKept: boolean | null;
    /** The translation registered before the move, read back on the same Link GID. */
    translationAfterMove: string | null;
    translationOutdated: boolean | null;
    errors: string[];
  };
  /**
   * §2.2 — does an item WITHOUT an id create a new one, and can the new id be
   * recovered by position? The editor's temp ids depend on the second half.
   */
  create: {
    attempted: boolean;
    /** Where the new item was placed in the sent list (1-based, top level). */
    sentAtPosition: number | null;
    createdId: string | null;
    /** The new item came back at the position we sent it at. */
    positionHeld: boolean | null;
    /** No existing item lost or changed its id in the same write. */
    existingIdsKept: boolean | null;
    /** A freshly created item's Link resource resolves and can be translated. */
    linkResolved: boolean | null;
    errors: string[];
  };
  /**
   * §2.3 — how deep does Shopify actually accept? Documented is three. The
   * editor's drag projection needs a measured number to clamp against, and the
   * write path a measured number to refuse past.
   */
  depth: {
    attempted: boolean;
    /**
     * depth -> accepted, with the refusal text when it was not.
     *
     * `observedDepth` is what a FRESH READ found, because "the mutation did not
     * complain" is not the same as "the tree was stored" — the echo rule, one
     * level up. It saturates at the read query's own four levels, which is
     * stated rather than hidden: past that the probe cannot see, and the write
     * path refuses there anyway.
     */
    results: Array<{ depth: number; accepted: boolean; observedDepth: number | null; error?: string }>;
    maxAccepted: number | null;
    /** How deep this probe's own read query can look. */
    readableDepth: number;
  };
  /**
   * §2.4 — what happens to a deleted item's translations on SHOPIFY's side?
   * Locally refreshMenuCache cleans up. This decides whether an accidental
   * delete is repairable by re-creating the item (it is not, if the new item
   * gets a new id — see `move` and `create`).
   */
  deleteTranslation: {
    attempted: boolean;
    linkId: string | null;
    valueBeforeDelete: string | null;
    /** After the item was deleted by omission. */
    resourceStillResolves: boolean | null;
    valueAfterDelete: string | null;
    errors: string[];
  };
  /**
   * WHICH write kills a menu item's translation?
   *
   * Measured 2026-08-23: after a rename the translation is still there
   * (outdated), and after the NEXT write — one that re-parented the item — it
   * is gone. The item kept its id throughout, so the Link GID we read is the
   * same one. Four candidate causes, and they have opposite consequences:
   *
   *   (a) re-parenting drops it            -> the tree editor must re-register
   *                                           after every move
   *   (b) reordering drops it              -> the same, for every drag at all
   *   (c) ANY further menuUpdate drops it  -> the SHIPPED rename feature loses
   *                                           translations whenever a second
   *                                           save touches the menu
   *   (d) an OUTDATED translation is
   *       dropped by the next write        -> the shipped feature promises
   *                                           "your translations are kept"
   *                                           and does not keep them
   *
   * One menu separates them: one item is never touched (control), one is
   * re-parented, one is renamed and then left alone through a further write,
   * one is only reordered. Every stage reads all of them, so the report shows
   * exactly which write dropped which value.
   *
   * MEASURED 2026-08-23: only RE-PARENTING drops it. The control survived five
   * whole-tree writes, an outdated translation survived two further ones, and
   * reordering within the same parent kept it. Two follow-up questions decide
   * how expensive the repair is, and both are measured here too:
   *
   *   CARRIED — a CHILD of the moved item, whose own parent did not change but
   *   whose ancestry did. MEASURED: it loses its translation as well, so
   *   moving a branch costs a re-registration for every item in it, not just
   *   for the one the merchant dragged.
   *
   *   RE-REGISTER — can the value simply be written again straight after the
   *   move? MEASURED: yes, with a digest read after the write. That is the
   *   whole mitigation, and it is proven rather than assumed.
   */
  translationDurability: {
    attempted: boolean;
    menuId: string | null;
    locale: string | null;
    /** role -> the Link GID watched for it. */
    links: Array<{ role: string; linkId: string }>;
    observations: Array<{ stage: string; role: string; value: string | null; outdated: boolean | null }>;
    /** Writing the value back right after the move — the proposed repair. */
    reRegisterAfterMove: { attempted: boolean; digestFound: boolean | null; restored: boolean | null };
    errors: string[];
  };
  /**
   * Can a menu item carry a MARKET-SCOPED translation — and does a move take
   * it too?
   *
   * The page has always written menu translations on the global layer only,
   * with the file header saying that market behaviour is unmeasured. That was
   * harmless while nothing here restructured menus. It stops being harmless
   * the moment a tree editor moves items: re-parenting destroys translations
   * (measured), the editor's repair re-registers what THIS APP can read, and a
   * market-scoped value written in Shopify's own editor is exactly what it
   * cannot read. So either such a value cannot exist — and the repair is
   * complete — or it can, and a drag silently destroys merchant content.
   */
  marketScoped: {
    attempted: boolean;
    /** Why the measurement could not run, when it could not. */
    reason?: string;
    marketId: string | null;
    marketName: string | null;
    locale: string | null;
    /** A market-scoped register was echoed AND read back. */
    storedAtAll: boolean | null;
    /** Whether the GLOBAL read shows the market value (it must not). */
    globalReadShowsIt: boolean | null;
    /** Still there after the item was re-parented. */
    survivesMove: boolean | null;
    /** If the move dropped it: can it be written again? */
    restorable: boolean | null;
    errors: string[];
  };
  /**
   * Does `resourceId` bind for EVERY resource-bound type, or only for the two
   * that were measured before the target picker existed?
   *
   * The picker offers seven types. PRODUCT and COLLECTION were measured with
   * the first probe run; the other five were an assumption, and an assumption
   * here fails the WHOLE save (menuUpdate is one call for the whole tree), not
   * just the one item. Per type: no sample on this shop, refused with the
   * message verbatim, or accepted and read back with the id we sent.
   */
  resourceBound: {
    attempted: boolean;
    menuId: string | null;
    /** type -> the sample GID that was sent, or null when the shop has none. */
    samples: Record<string, string | null>;
    createErrors: string[];
    /** type -> what came back: the resourceId Shopify stored, or null. */
    readBack: Record<string, string | null>;
    /** type -> did the stored id equal the one sent? null = not measured. */
    bound: Record<string, boolean | null>;
    /**
     * Retargeting an EXISTING item — the operation the target picker performs
     * and the one thing about it that was still an assumption: when an item is
     * sent back with a new `type` and NO `resourceId`, does Shopify drop the
     * old binding, or does the item keep pointing at the product while calling
     * itself an HTTP link? The write path omits a null `resourceId` rather
     * than sending it, so "omission clears" has to be true for the picker to
     * work at all.
     */
    retarget: {
      attempted: boolean;
      itemId: string | null;
      fromType: string | null;
      /** resourceId gone after the item was sent back as HTTP. */
      resourceIdCleared: boolean | null;
      /** The url we sent came back. */
      urlStored: boolean | null;
      /** Sent back to its original resource type: bound again. */
      reboundOk: boolean | null;
      /** …and the HTTP url did NOT survive that. */
      urlClearedOnRebind: boolean | null;
      errors: string[];
    };
    errors: string[];
  };
  typeRoundTrip: {
    attempted: boolean;
    menuId: string | null;
    typesTried: string[];
    createErrors: string[];
    /** What Shopify returned for each created item. */
    read: Array<{ type: string | null; title: string; url: string | null; resourceId: string | null }>;
    /** Write-back of the tree exactly as read — what the write path does. */
    asReadOk: boolean | null;
    asReadErrors: string[];
    /** Only attempted when the first one failed: same tree, url stripped off non-HTTP items. */
    withoutUrlOk: boolean | null;
    withoutUrlErrors: string[];
  };
  /**
   * Every menu this run created, and whether it went away again.
   *
   * A list rather than a field per menu: the probe now builds four (the main
   * one, one for item types, one per depth attempt), and a per-menu field
   * would be a new one to forget every time a measurement is added. Anything
   * left behind is named with its handle so it can be removed by hand.
   */
  cleanup: {
    menus: Array<{ handle: string; id: string; deleted: boolean; error?: string }>;
    allDeleted: boolean;
  };
  verdict: string[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

type GqlResult = { data?: Record<string, unknown>; errors?: Array<{ message: string }> };
type GqlRunner = (query: string, variables?: Record<string, unknown>) => Promise<GqlResult>;

interface RawItem {
  id: string;
  title: string;
  type?: string | null;
  url?: string | null;
  resourceId?: string | null;
  tags?: string[] | null;
  items?: RawItem[] | null;
}

/** Depth-first flatten, stamping a positional path so two runs can be compared. */
function flatten(items: RawItem[] | null | undefined, depth = 1, prefix: number[] = []): ProbeItem[] {
  const out: ProbeItem[] = [];
  (items ?? []).forEach((item, index) => {
    const path = [...prefix, index + 1];
    out.push({
      id: item.id,
      title: item.title,
      type: item.type ?? null,
      url: item.url ?? null,
      resourceId: item.resourceId ?? null,
      tags: item.tags ?? [],
      depth,
      path: path.join("."),
    });
    out.push(...flatten(item.items, depth + 1, path));
  });
  return out;
}

/**
 * The read tree turned back into update input.
 *
 * `edit` renames one item; `omit` drops one (and its subtree) so the omission
 * test can measure what Shopify does with an item nobody mentioned. Anything
 * the input does not accept is dropped here rather than sent: a resourceId of
 * null on an HTTP item is not the same as an absent key.
 */
function toUpdateInput(
  items: RawItem[] | null | undefined,
  options: { renameId?: string; renameTo?: string; omitId?: string },
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const item of items ?? []) {
    if (options.omitId && item.id === options.omitId) continue;
    const node: Record<string, unknown> = {
      id: item.id,
      title: options.renameId === item.id && options.renameTo ? options.renameTo : item.title,
      type: item.type,
    };
    if (item.url) node.url = item.url;
    if (item.resourceId) node.resourceId = item.resourceId;
    if (item.tags && item.tags.length > 0) node.tags = item.tags;
    const children = toUpdateInput(item.items, options);
    if (children.length > 0) node.items = children;
    out.push(node);
  }
  return out;
}

/** GraphQL type reference to a printable string plus its NON_NULL flag. */
function printType(type: unknown): { text: string; required: boolean } {
  const node = type as { kind?: string; name?: string | null; ofType?: unknown } | null;
  if (!node) return { text: "?", required: false };
  if (node.kind === "NON_NULL") {
    const inner = printType(node.ofType);
    return { text: inner.text, required: true };
  }
  if (node.kind === "LIST") {
    const inner = printType(node.ofType);
    return { text: `[${inner.text}]`, required: false };
  }
  return { text: node.name ?? node.kind ?? "?", required: false };
}

function schemaFields(raw: unknown): SchemaField[] {
  const fields = (raw as { inputFields?: Array<{ name: string; type: unknown }> } | null)?.inputFields ?? [];
  return fields.map((f) => {
    const printed = printType(f.type);
    return { name: f.name, type: printed.text, required: printed.required };
  });
}

function userErrorText(errors: unknown): string[] {
  const list = (errors as Array<{ field?: string[] | null; message: string }> | undefined) ?? [];
  return list.map((e) => `${(e.field ?? []).join(".") || "-"}: ${e.message}`);
}

function topLevelErrors(result: GqlResult): string[] {
  return (result.errors ?? []).map((e) => e.message);
}

/**
 * Move a subtree to the top level, in front of everything else.
 *
 * Both halves of the move question in one write: the item changes PARENT (out
 * of its branch, up to the root) and every remaining item changes POSITION. If
 * ids survive this, they survive any drag the editor can produce.
 */
function hoistToTop(items: RawItem[], itemId: string): RawItem[] {
  let lifted: RawItem | null = null;
  const strip = (nodes: RawItem[]): RawItem[] => {
    const out: RawItem[] = [];
    for (const node of nodes) {
      if (node.id === itemId) {
        lifted = node;
        continue;
      }
      out.push({ ...node, items: strip(node.items ?? []) });
    }
    return out;
  };
  const rest = strip(items);
  return lifted ? [lifted, ...rest] : rest;
}

// ── Route ──────────────────────────────────────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);
  return json({
    ok: true,
    hint: "POST with confirm=true to run the menu write probe. It creates and deletes its own throwaway menu.",
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);

  // Directly POST-reachable AND it writes, so the gate lives here — the same
  // class as the /api/ai handlers and the other probes.
  const settings = await db.aISettings.findUnique({
    where: { shop: session.shop },
    select: { subscriptionPlan: true },
  });
  if (!meetsPlan((settings?.subscriptionPlan || "free") as never, "pro")) {
    return json({ error: "gated" }, { status: 403 });
  }

  const formData = await request.formData().catch(() => null);
  // This probe creates a menu. That is not something to do because a URL was
  // opened, so it takes an explicit confirmation rather than defaulting to on.
  if (formData?.get("confirm") !== "true") {
    return json({ error: "confirm=true is required — this probe creates and deletes a throwaway menu." }, { status: 400 });
  }

  const run: GqlRunner = async (query, variables) => {
    const response = await admin.graphql(query, { variables: variables ?? {} });
    return (await response.json()) as GqlResult;
  };

  const stamp = `${Date.now()}`;
  const handle = `contentpilot-write-probe-${stamp}`;
  /**
   * Every menu created by this run, in creation order.
   *
   * The cleanup iterates this instead of naming menus one by one: the probe
   * now builds up to four, and a per-menu delete block is one to forget the
   * next time a measurement is added — which would leave a stray menu in a
   * merchant's shop.
   */
  const createdMenus: Array<{ handle: string; id: string }> = [];

  const report: MenuWriteProbeReport = {
    generatedAt: new Date().toISOString(),
    shop: session.shop,
    apiVersion: resolveApiVersionString(),
    schema: { createInput: [], updateInput: [], itemTypes: [] },
    setup: { handle, menuId: null, boundResource: null, created: false, errors: [] },
    baseline: { items: [], resourceIdStoredOnCreate: null },
    rename: {
      attempted: false,
      targetItemId: null,
      targetPath: null,
      newTitle: null,
      echoedTitle: null,
      readBackTitle: null,
      idsStable: null,
      idChanges: [],
      collateralTitleChanges: [],
      resourceIdPreserved: null,
      itemCountBefore: 0,
      itemCountAfter: 0,
      errors: [],
    },
    omission: {
      attempted: false,
      omittedItemId: null,
      omittedPath: null,
      stillPresentAfterwards: null,
      siblingsSurvived: null,
      errors: [],
    },
    translation: {
      attempted: false,
      locale: null,
      linkId: null,
      linkResolved: null,
      registered: null,
      valueBeforeRename: null,
      valueAfterRename: null,
      outdatedAfterRename: null,
      digestChanged: null,
      errors: [],
    },
    move: {
      attempted: false,
      movedItemId: null,
      idAfterMove: null,
      idKept: null,
      childIdKept: null,
      depthBefore: null,
      depthAfter: null,
      siblingIdsKept: null,
      translationAfterMove: null,
      translationOutdated: null,
      errors: [],
    },
    create: {
      attempted: false,
      sentAtPosition: null,
      createdId: null,
      positionHeld: null,
      existingIdsKept: null,
      linkResolved: null,
      errors: [],
    },
    depth: { attempted: false, results: [], maxAccepted: null, readableDepth: 4 },
    marketScoped: {
      attempted: false,
      marketId: null,
      marketName: null,
      locale: null,
      storedAtAll: null,
      globalReadShowsIt: null,
      survivesMove: null,
      restorable: null,
      errors: [],
    },
    translationDurability: {
      attempted: false,
      menuId: null,
      locale: null,
      links: [],
      observations: [],
      reRegisterAfterMove: { attempted: false, digestFound: null, restored: null },
      errors: [],
    },
    deleteTranslation: {
      attempted: false,
      linkId: null,
      valueBeforeDelete: null,
      resourceStillResolves: null,
      valueAfterDelete: null,
      errors: [],
    },
    resourceBound: {
      attempted: false,
      menuId: null,
      samples: {},
      createErrors: [],
      readBack: {},
      bound: {},
      retarget: {
        attempted: false,
        itemId: null,
        fromType: null,
        resourceIdCleared: null,
        urlStored: null,
        reboundOk: null,
        urlClearedOnRebind: null,
        errors: [],
      },
      errors: [],
    },
    typeRoundTrip: {
      attempted: false,
      menuId: null,
      typesTried: [],
      createErrors: [],
      read: [],
      asReadOk: null,
      asReadErrors: [],
      withoutUrlOk: null,
      withoutUrlErrors: [],
    },
    cleanup: { menus: [], allDeleted: true },
    verdict: [],
  };

  logger.info("[MENU-WRITE-PROBE] Starting", { context: "MenuWriteProbe", shop: session.shop, handle });

  try {
    // ── 0. Schema ──────────────────────────────────────────────────────────
    // Best effort: a shop with introspection disabled still gets every
    // empirical measurement below, and the empirical ones are the answer.
    try {
      const schemaResult = await run(INPUT_INTROSPECTION_QUERY);
      const errs = topLevelErrors(schemaResult);
      if (errs.length > 0) report.schema.error = errs.join("; ");
      report.schema.createInput = schemaFields(schemaResult.data?.createInput);
      report.schema.updateInput = schemaFields(schemaResult.data?.updateInput);
      report.schema.itemTypes =
        ((schemaResult.data?.itemType as { enumValues?: Array<{ name: string }> } | null)?.enumValues ?? []).map(
          (v) => v.name,
        );
    } catch (error) {
      report.schema.error = error instanceof Error ? error.message : String(error);
    }

    // ── 1. A resource to bind one item to ──────────────────────────────────
    // Without it the resourceId question cannot be answered at all — which is
    // reported as "not measured", never as "resourceId is fine".
    try {
      const samples = await run(SAMPLE_RESOURCES_QUERY);
      const product = (samples.data?.products as { nodes?: Array<{ id: string; title: string }> } | undefined)?.nodes?.[0];
      const collection = (samples.data?.collections as { nodes?: Array<{ id: string; title: string }> } | undefined)
        ?.nodes?.[0];
      if (product) report.setup.boundResource = { type: "PRODUCT", id: product.id, title: product.title };
      else if (collection) report.setup.boundResource = { type: "COLLECTION", id: collection.id, title: collection.title };
    } catch (error) {
      report.setup.errors.push(`Sample lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    // ── 2. Create the throwaway menu ───────────────────────────────────────
    const createItems: Array<Record<string, unknown>> = [
      {
        title: "CP Probe A",
        type: "HTTP",
        url: "https://example.com/cp-probe-a",
        items: [
          {
            title: "CP Probe A1",
            type: "HTTP",
            url: "https://example.com/cp-probe-a1",
            items: [
              {
                title: "CP Probe A1a",
                type: "HTTP",
                url: "https://example.com/cp-probe-a1a",
              },
            ],
          },
        ],
      },
    ];
    if (report.setup.boundResource) {
      createItems.push({
        title: "CP Probe B",
        type: report.setup.boundResource.type,
        resourceId: report.setup.boundResource.id,
      });
    }

    const createResult = await run(MENU_CREATE_MUTATION, {
      title: `ContentPilot write probe ${stamp}`,
      handle,
      items: createItems,
    });
    report.setup.errors.push(...topLevelErrors(createResult));
    const createPayload = createResult.data?.menuCreate as
      | { menu?: { id: string; handle: string } | null; userErrors?: unknown }
      | undefined;
    report.setup.errors.push(...userErrorText(createPayload?.userErrors));
    report.setup.menuId = createPayload?.menu?.id ?? null;
    report.setup.created = !!report.setup.menuId;
    if (report.setup.menuId) createdMenus.push({ handle, id: report.setup.menuId });

    if (!report.setup.menuId) {
      report.verdict.push("BLOCKED: the probe menu could not be created — nothing below was measured.");
      return json({ report });
    }
    const menuId = report.setup.menuId;

    // ── 3. Baseline read ───────────────────────────────────────────────────
    const readMenu = async (): Promise<{ items: RawItem[]; errors: string[] }> => {
      const result = await run(MENU_READ_QUERY, { id: menuId });
      const menu = result.data?.menu as { items?: RawItem[] } | null | undefined;
      return { items: menu?.items ?? [], errors: topLevelErrors(result) };
    };

    const baselineRead = await readMenu();
    report.setup.errors.push(...baselineRead.errors);
    report.baseline.items = flatten(baselineRead.items);
    if (report.setup.boundResource) {
      const bound = report.baseline.items.find((i) => i.title === "CP Probe B");
      report.baseline.resourceIdStoredOnCreate = bound?.resourceId === report.setup.boundResource.id;
    }

    const targetBefore = report.baseline.items.find((i) => i.title === "CP Probe A1");
    const grandchild = report.baseline.items.find((i) => i.title === "CP Probe A1a");

    // ── 4. Put a translation on the item we are about to rename ────────────
    // Ordered deliberately: the question is what a RENAME does to an existing
    // translation, so the translation has to exist first.
    const localesResult = await run(LOCALES_QUERY);
    const locales =
      (localesResult.data?.shopLocales as Array<{ locale: string; primary: boolean; published: boolean }> | undefined) ??
      [];
    const foreignLocale = locales.find((l) => !l.primary && l.published)?.locale ?? null;
    report.translation.locale = foreignLocale;

    let digestBefore: string | null = null;
    if (targetBefore && foreignLocale) {
      const linkId = linkGidForMenuItem(targetBefore.id);
      report.translation.linkId = linkId;
      if (linkId) {
        report.translation.attempted = true;
        try {
          const linkRead = await run(LINK_TRANSLATABLE_QUERY, { id: linkId, locale: foreignLocale });
          report.translation.errors.push(...topLevelErrors(linkRead));
          const resource = linkRead.data?.translatableResource as
            | { translatableContent?: Array<{ key: string; value: string | null; digest: string | null }> }
            | null
            | undefined;
          report.translation.linkResolved = !!resource;
          digestBefore = resource?.translatableContent?.find((c) => c.key === "title")?.digest ?? null;

          if (digestBefore) {
            const registerResult = await run(REGISTER_MUTATION, {
              resourceId: linkId,
              translations: [
                {
                  key: "title",
                  locale: foreignLocale,
                  value: `CP-PROBE-TRANSLATION-${stamp}`,
                  translatableContentDigest: digestBefore,
                },
              ],
            });
            report.translation.errors.push(...topLevelErrors(registerResult));
            const registerPayload = registerResult.data?.translationsRegister as
              | { translations?: Array<{ key: string; value: string }>; userErrors?: unknown }
              | undefined;
            report.translation.errors.push(...userErrorText(registerPayload?.userErrors));
            // The echo rule: an accepted mutation is not a stored value, so
            // the value is read back fresh before it counts as registered.
            const verifyRead = await run(LINK_TRANSLATABLE_QUERY, { id: linkId, locale: foreignLocale });
            const verifyResource = verifyRead.data?.translatableResource as
              | { translations?: Array<{ key: string; value: string; outdated: boolean }> }
              | null
              | undefined;
            report.translation.valueBeforeRename =
              verifyResource?.translations?.find((t) => t.key === "title")?.value ?? null;
            report.translation.registered = !!report.translation.valueBeforeRename;
          } else {
            report.translation.errors.push("No digest on the fresh menu item's Link resource — nothing could be registered.");
            report.translation.registered = false;
          }
        } catch (error) {
          report.translation.errors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }

    // ── 4b. A translation on the item the omission test will DELETE ────────
    // Registered here rather than later because it has to exist BEFORE the
    // deletion for the question to mean anything: what does Shopify do with a
    // translation whose menu item is gone.
    if (grandchild && foreignLocale) {
      const deletedLinkId = linkGidForMenuItem(grandchild.id);
      report.deleteTranslation.linkId = deletedLinkId;
      if (deletedLinkId) {
        report.deleteTranslation.attempted = true;
        try {
          const read = await run(LINK_TRANSLATABLE_QUERY, { id: deletedLinkId, locale: foreignLocale });
          report.deleteTranslation.errors.push(...topLevelErrors(read));
          const digest = (
            read.data?.translatableResource as
              | { translatableContent?: Array<{ key: string; digest: string | null }> }
              | null
              | undefined
          )?.translatableContent?.find((c) => c.key === "title")?.digest ?? null;
          if (digest) {
            const registered = await run(REGISTER_MUTATION, {
              resourceId: deletedLinkId,
              translations: [
                {
                  key: "title",
                  locale: foreignLocale,
                  value: `CP-PROBE-DOOMED-${stamp}`,
                  translatableContentDigest: digest,
                },
              ],
            });
            report.deleteTranslation.errors.push(...topLevelErrors(registered));
            const verify = await run(LINK_TRANSLATABLE_QUERY, { id: deletedLinkId, locale: foreignLocale });
            report.deleteTranslation.valueBeforeDelete =
              (
                verify.data?.translatableResource as
                  | { translations?: Array<{ key: string; value: string }> }
                  | null
                  | undefined
              )?.translations?.find((t) => t.key === "title")?.value ?? null;
          } else {
            report.deleteTranslation.errors.push("No digest — nothing could be registered on the doomed item.");
          }
        } catch (error) {
          report.deleteTranslation.errors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }

    // ── 5. The rename ──────────────────────────────────────────────────────
    if (targetBefore) {
      report.rename.attempted = true;
      report.rename.targetItemId = targetBefore.id;
      report.rename.targetPath = targetBefore.path;
      report.rename.newTitle = `CP Probe A1 RENAMED ${stamp}`;
      report.rename.itemCountBefore = report.baseline.items.length;

      const updateResult = await run(MENU_UPDATE_MUTATION, {
        id: menuId,
        title: `ContentPilot write probe ${stamp}`,
        handle,
        items: toUpdateInput(baselineRead.items, {
          renameId: targetBefore.id,
          renameTo: report.rename.newTitle,
        }),
      });
      report.rename.errors.push(...topLevelErrors(updateResult));
      const updatePayload = updateResult.data?.menuUpdate as
        | { menu?: { items?: RawItem[] } | null; userErrors?: unknown }
        | undefined;
      report.rename.errors.push(...userErrorText(updatePayload?.userErrors));
      const echoed = flatten(updatePayload?.menu?.items);
      report.rename.echoedTitle = echoed.find((i) => i.id === targetBefore.id)?.title ?? null;

      // A fresh read, not the echo. The echo is what the mutation SAYS it did;
      // every rule in this codebase about translations exists because those two
      // have been observed to differ.
      const afterRead = await readMenu();
      report.rename.errors.push(...afterRead.errors);
      const after = flatten(afterRead.items);
      report.rename.itemCountAfter = after.length;
      report.rename.readBackTitle = after.find((i) => i.path === targetBefore.path)?.title ?? null;

      // Ids compared BY POSITION: comparing by id would presuppose the answer.
      const byPathBefore = new Map(report.baseline.items.map((i) => [i.path, i]));
      let idsStable = true;
      for (const item of after) {
        const before = byPathBefore.get(item.path);
        if (!before) continue;
        if (before.id !== item.id) {
          idsStable = false;
          report.rename.idChanges.push({ path: item.path, before: before.id, after: item.id });
        }
        if (before.id !== targetBefore.id && before.title !== item.title) {
          report.rename.collateralTitleChanges.push({ path: item.path, before: before.title, after: item.title });
        }
      }
      report.rename.idsStable = idsStable;

      if (report.setup.boundResource) {
        const boundAfter = after.find((i) => i.title === "CP Probe B");
        report.rename.resourceIdPreserved = boundAfter?.resourceId === report.setup.boundResource.id;
      }

      // What the rename did to the translation registered in step 4.
      if (report.translation.registered && report.translation.linkId && foreignLocale) {
        try {
          const afterTranslation = await run(LINK_TRANSLATABLE_QUERY, {
            id: report.translation.linkId,
            locale: foreignLocale,
          });
          const resource = afterTranslation.data?.translatableResource as
            | {
                translatableContent?: Array<{ key: string; digest: string | null }>;
                translations?: Array<{ key: string; value: string; outdated: boolean }>;
              }
            | null
            | undefined;
          const row = resource?.translations?.find((t) => t.key === "title");
          report.translation.valueAfterRename = row?.value ?? null;
          report.translation.outdatedAfterRename = row?.outdated ?? null;
          const digestAfter = resource?.translatableContent?.find((c) => c.key === "title")?.digest ?? null;
          report.translation.digestChanged = digestBefore !== null && digestAfter !== null ? digestBefore !== digestAfter : null;
        } catch (error) {
          report.translation.errors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }

    // ── 5b. The MOVE (§2.1) ────────────────────────────────────────────────
    // The decisive measurement for a tree editor. The renamed depth-2 item is
    // hoisted to the top, in front of everything — one write that changes its
    // PARENT and every sibling's POSITION at once.
    if (targetBefore && report.rename.idsStable !== null) {
      report.move.attempted = true;
      report.move.movedItemId = targetBefore.id;
      report.move.depthBefore = targetBefore.depth;
      try {
        const beforeRead = await readMenu();
        report.move.errors.push(...beforeRead.errors);
        const beforeItems = flatten(beforeRead.items);
        const movedTitle = beforeItems.find((i) => i.id === targetBefore.id)?.title ?? "";

        const moveResult = await run(MENU_UPDATE_MUTATION, {
          id: menuId,
          title: `ContentPilot write probe ${stamp}`,
          handle,
          items: toUpdateInput(hoistToTop(beforeRead.items, targetBefore.id), {}),
        });
        report.move.errors.push(...topLevelErrors(moveResult));
        const movePayload = moveResult.data?.menuUpdate as { userErrors?: unknown } | undefined;
        report.move.errors.push(...userErrorText(movePayload?.userErrors));

        const afterRead = await readMenu();
        report.move.errors.push(...afterRead.errors);
        const afterItems = flatten(afterRead.items);

        // Matched by TITLE, not by id or position: matching by id would
        // presuppose the answer, and the position is what just changed.
        const movedAfter = afterItems.find((i) => i.title === movedTitle);
        report.move.idAfterMove = movedAfter?.id ?? null;
        report.move.depthAfter = movedAfter?.depth ?? null;
        report.move.idKept = movedAfter ? movedAfter.id === targetBefore.id : null;

        if (grandchild) {
          const childAfter = afterItems.find((i) => i.title === grandchild.title);
          report.move.childIdKept = childAfter ? childAfter.id === grandchild.id : null;
        }
        // Every item that did NOT move must still hold its id, even though its
        // position changed.
        const untouched = beforeItems.filter((i) => i.id !== targetBefore.id && i.id !== grandchild?.id);
        report.move.siblingIdsKept =
          untouched.length === 0
            ? null
            : untouched.every((before) => afterItems.some((a) => a.id === before.id && a.title === before.title));

        if (report.translation.registered && report.translation.linkId && foreignLocale) {
          const afterTranslation = await run(LINK_TRANSLATABLE_QUERY, {
            id: report.translation.linkId,
            locale: foreignLocale,
          });
          const row = (
            afterTranslation.data?.translatableResource as
              | { translations?: Array<{ key: string; value: string; outdated: boolean }> }
              | null
              | undefined
          )?.translations?.find((t) => t.key === "title");
          report.move.translationAfterMove = row?.value ?? null;
          report.move.translationOutdated = row?.outdated ?? null;
        }
      } catch (error) {
        report.move.errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    // ── 5c. CREATE by omitting the id (§2.2) ───────────────────────────────
    // MenuItemUpdateInput.id is optional (measured in the schema above), which
    // is presumably how a new item is added. "Presumably" is not a finding.
    {
      report.create.attempted = true;
      try {
        const beforeRead = await readMenu();
        report.create.errors.push(...beforeRead.errors);
        const beforeItems = flatten(beforeRead.items);
        const sent = toUpdateInput(beforeRead.items, {});
        // Appended LAST rather than first: the position is what the editor has
        // to map its temp id through, and the last slot is the one an
        // off-by-one would betray.
        sent.push({ title: `CP Probe NEW ${stamp}`, type: "HTTP", url: "https://example.com/cp-probe-new" });
        report.create.sentAtPosition = sent.length;

        const createResult = await run(MENU_UPDATE_MUTATION, {
          id: menuId,
          title: `ContentPilot write probe ${stamp}`,
          handle,
          items: sent,
        });
        report.create.errors.push(...topLevelErrors(createResult));
        const payload = createResult.data?.menuUpdate as { userErrors?: unknown } | undefined;
        report.create.errors.push(...userErrorText(payload?.userErrors));

        const afterRead = await readMenu();
        report.create.errors.push(...afterRead.errors);
        const topLevel = (afterRead.items ?? []) as RawItem[];
        const atPosition = topLevel[report.create.sentAtPosition - 1];
        const byTitle = flatten(afterRead.items).find((i) => i.title === `CP Probe NEW ${stamp}`);
        report.create.createdId = byTitle?.id ?? null;
        report.create.positionHeld = !!byTitle && !!atPosition && atPosition.id === byTitle.id;
        report.create.existingIdsKept = beforeItems.every((b) =>
          flatten(afterRead.items).some((a) => a.id === b.id),
        );

        // A brand-new item has to be translatable straight away, or the
        // editor's second save phase has nothing to write to.
        if (byTitle) {
          const newLinkId = linkGidForMenuItem(byTitle.id);
          if (newLinkId && foreignLocale) {
            const linkRead = await run(LINK_TRANSLATABLE_QUERY, { id: newLinkId, locale: foreignLocale });
            report.create.linkResolved = !!linkRead.data?.translatableResource;
          }
        }
      } catch (error) {
        report.create.errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    // ── 5b. Does `resourceId` bind for every resource-bound type? ──────────
    // Its own menu for the same reason as step 6: one type this shop refuses
    // must not take the rest of the run with it. And a failure here is worth
    // measuring precisely, because menuUpdate is one call for the whole tree —
    // a type the picker offers and the platform refuses fails the merchant's
    // ENTIRE save, not the one item.
    try {
      report.resourceBound.attempted = true;
      const boundSamples = await run(BOUND_SAMPLES_QUERY);
      report.resourceBound.errors.push(...topLevelErrors(boundSamples));
      const nodeId = (key: string) =>
        (boundSamples.data?.[key] as { nodes?: Array<{ id: string }> } | undefined)?.nodes?.[0]?.id ?? null;
      const shopData = boundSamples.data?.shop as
        | { privacyPolicy?: { id: string } | null; refundPolicy?: { id: string } | null }
        | undefined;

      const samples: Record<string, string | null> = {
        PRODUCT: nodeId("products"),
        COLLECTION: nodeId("collections"),
        PAGE: nodeId("pages"),
        BLOG: nodeId("blogs"),
        ARTICLE: nodeId("articles"),
        SHOP_POLICY: shopData?.privacyPolicy?.id ?? shopData?.refundPolicy?.id ?? null,
        METAOBJECT: null,
      };

      // Metaobjects need a type argument, so the definition list has to answer
      // first. No definitions ⇒ no sample ⇒ "not measured", never "refused".
      const definitionType = (
        boundSamples.data?.metaobjectDefinitions as { nodes?: Array<{ type: string }> } | undefined
      )?.nodes?.[0]?.type;
      if (definitionType) {
        const metaSample = await run(METAOBJECT_SAMPLE_QUERY, { type: definitionType });
        samples.METAOBJECT =
          (metaSample.data?.metaobjects as { nodes?: Array<{ id: string }> } | undefined)?.nodes?.[0]?.id ?? null;
      }
      report.resourceBound.samples = samples;

      const boundTypes = Object.entries(samples).filter(([, id]) => !!id) as Array<[string, string]>;
      // Types that ended up in the COMBINED menu — the one the retarget step
      // below writes to. A type measured by a solo retry lives elsewhere.
      const inCombinedMenu = new Set<string>();
      if (boundTypes.length > 0) {
        const boundHandle = `${handle}-bound`;
        const created = await run(MENU_CREATE_MUTATION, {
          title: `ContentPilot write probe bound ${stamp}`,
          handle: boundHandle,
          items: boundTypes.map(([type, id]) => ({
            title: `CP Bound ${type}`,
            type,
            resourceId: id,
          })),
        });
        report.resourceBound.createErrors.push(...topLevelErrors(created));
        const payload = created.data?.menuCreate as
          | { menu?: { id: string } | null; userErrors?: unknown }
          | undefined;
        report.resourceBound.createErrors.push(...userErrorText(payload?.userErrors));
        report.resourceBound.menuId = payload?.menu?.id ?? null;
        if (report.resourceBound.menuId) createdMenus.push({ handle: boundHandle, id: report.resourceBound.menuId });

        if (report.resourceBound.menuId) {
          const readResult = await run(MENU_READ_QUERY, { id: report.resourceBound.menuId });
          const readItems = ((readResult.data?.menu as { items?: RawItem[] } | null)?.items ?? []) as RawItem[];
          for (const [type, sent] of boundTypes) {
            const row = readItems.find((i) => i.title === `CP Bound ${type}`);
            const stored = row?.resourceId ?? null;
            report.resourceBound.readBack[type] = stored;
            // An item that is not in the read-back at all is UNMEASURED, not
            // refused: the create may have failed for an unrelated reason and
            // reporting that as "this type does not bind" is exactly the
            // failed-call-as-negative-answer trap.
            report.resourceBound.bound[type] = row ? stored === sent : null;
            if (row) inCombinedMenu.add(type);
          }
        }

        // One create for all seven is cheap and answers on a healthy shop —
        // but menuCreate is ALL-OR-NOTHING, so a single type the shop refuses
        // would leave every OTHER type reported as "not measured" and never
        // name the offending one. So whatever the combined attempt did not
        // answer is retried one menu at a time. Only then can a `false` mean
        // "this type refuses" rather than "something in the batch did".
        for (const [type, sent] of boundTypes) {
          if (inCombinedMenu.has(type)) continue;
          const soloHandle = `${handle}-bound-${type.toLowerCase().replace(/_/g, "-")}`;
          const solo = await run(MENU_CREATE_MUTATION, {
            title: `ContentPilot write probe bound ${type} ${stamp}`,
            handle: soloHandle,
            items: [{ title: `CP Bound ${type}`, type, resourceId: sent }],
          });
          const soloErrors = [
            ...topLevelErrors(solo),
            ...userErrorText((solo.data?.menuCreate as { userErrors?: unknown } | undefined)?.userErrors),
          ];
          const soloId = (solo.data?.menuCreate as { menu?: { id: string } | null } | undefined)?.menu?.id ?? null;
          if (soloId) createdMenus.push({ handle: soloHandle, id: soloId });
          if (!soloId) {
            // The type is what the platform refused, and the message says so.
            report.resourceBound.bound[type] = false;
            for (const e of soloErrors) report.resourceBound.createErrors.push(`${type}: ${e}`);
            continue;
          }
          const soloRead = await run(MENU_READ_QUERY, { id: soloId });
          const soloItems = ((soloRead.data?.menu as { items?: RawItem[] } | null)?.items ?? []) as RawItem[];
          const row = soloItems.find((i) => i.title === `CP Bound ${type}`);
          report.resourceBound.readBack[type] = row?.resourceId ?? null;
          report.resourceBound.bound[type] = row ? row.resourceId === sent : null;
        }
      }
      for (const [type, id] of Object.entries(samples)) {
        if (!id) report.resourceBound.bound[type] = null;
      }

      // ── 5c. Retargeting an existing item ─────────────────────────────────
      // The picker's real operation, and the assumption underneath it: the
      // write path OMITS a null resourceId rather than sending one, so
      // "omission clears the old binding" has to hold or a product link
      // retargeted to a URL would keep pointing at the product.
      const boundMenuId = report.resourceBound.menuId;
      // Only a type that is IN the combined menu can be retargeted there — a
      // type measured by a solo retry lives in a different menu.
      const reboundType = boundTypes.find(
        ([type]) => report.resourceBound.bound[type] === true && inCombinedMenu.has(type),
      );
      if (boundMenuId && reboundType) {
        const rt = report.resourceBound.retarget;
        rt.attempted = true;
        rt.fromType = reboundType[0];
        const retargetUrl = `https://example.com/cp-retarget-${stamp}`;
        const boundTitle = `CP Bound ${reboundType[0]}`;
        const boundHandle = `${handle}-bound`;
        const menuTitle = `ContentPilot write probe bound ${stamp}`;

        const readTree = async () => {
          const result = await run(MENU_READ_QUERY, { id: boundMenuId });
          return ((result.data?.menu as { items?: RawItem[] } | null)?.items ?? []) as RawItem[];
        };
        const writeTree = async (items: Array<Record<string, unknown>>) => {
          const result = await run(MENU_UPDATE_MUTATION, {
            id: boundMenuId,
            title: menuTitle,
            handle: boundHandle,
            items,
          });
          rt.errors.push(...topLevelErrors(result));
          const payload = result.data?.menuUpdate as { userErrors?: unknown } | undefined;
          rt.errors.push(...userErrorText(payload?.userErrors));
        };

        const before = await readTree();
        rt.itemId = before.find((i) => i.title === boundTitle)?.id ?? null;

        // Exactly what the editor sends: same tree, one item's target
        // replaced, no resourceId on it at all.
        await writeTree(
          toUpdateInput(before, {}).map((node) =>
            node.title === boundTitle
              ? { id: node.id, title: boundTitle, type: "HTTP", url: retargetUrl }
              : node,
          ),
        );
        const afterHttp = (await readTree()).find((i) => i.title === boundTitle);
        if (afterHttp) {
          rt.resourceIdCleared = !afterHttp.resourceId;
          rt.urlStored = afterHttp.url === retargetUrl;
        }

        // …and back, which is the other direction a merchant takes.
        const backTree = await readTree();
        await writeTree(
          toUpdateInput(backTree, {}).map((node) =>
            node.title === boundTitle
              ? { id: node.id, title: boundTitle, type: reboundType[0], resourceId: reboundType[1] }
              : node,
          ),
        );
        const afterRebind = (await readTree()).find((i) => i.title === boundTitle);
        if (afterRebind) {
          rt.reboundOk = afterRebind.resourceId === reboundType[1];
          rt.urlClearedOnRebind = afterRebind.url !== retargetUrl;
        }
      }
    } catch (error) {
      report.resourceBound.errors.push(error instanceof Error ? error.message : String(error));
    }

    // ── 6. Item types that are neither HTTP nor resource-bound ─────────────
    // Its own menu: a type this shop's schema will not create must not take
    // the omission test below down with it.
    const SPECIAL_TYPES = ["FRONTPAGE", "SEARCH", "CATALOG", "COLLECTIONS"];
    const typesToTry = SPECIAL_TYPES.filter(
      (t) => report.schema.itemTypes.length === 0 || report.schema.itemTypes.includes(t),
    );
    if (typesToTry.length > 0) {
      report.typeRoundTrip.attempted = true;
      report.typeRoundTrip.typesTried = typesToTry;
      const typesHandle = `${handle}-types`;
      try {
        const created = await run(MENU_CREATE_MUTATION, {
          title: `ContentPilot write probe types ${stamp}`,
          handle: typesHandle,
          items: typesToTry.map((type) => ({ title: `CP Probe ${type}`, type })),
        });
        report.typeRoundTrip.createErrors.push(...topLevelErrors(created));
        const payload = created.data?.menuCreate as
          | { menu?: { id: string } | null; userErrors?: unknown }
          | undefined;
        report.typeRoundTrip.createErrors.push(...userErrorText(payload?.userErrors));
        report.typeRoundTrip.menuId = payload?.menu?.id ?? null;
        if (report.typeRoundTrip.menuId) createdMenus.push({ handle: typesHandle, id: report.typeRoundTrip.menuId });

        if (report.typeRoundTrip.menuId) {
          const typesMenuId = report.typeRoundTrip.menuId;
          const readResult = await run(MENU_READ_QUERY, { id: typesMenuId });
          const readItems = ((readResult.data?.menu as { items?: RawItem[] } | null)?.items ?? []) as RawItem[];
          report.typeRoundTrip.read = readItems.map((i) => ({
            type: i.type ?? null,
            title: i.title,
            url: i.url ?? null,
            resourceId: i.resourceId ?? null,
          }));

          // Write-back #1: byte for byte what was read, which is exactly what
          // menu-write.server.ts sends.
          const asRead = await run(MENU_UPDATE_MUTATION, {
            id: typesMenuId,
            title: `ContentPilot write probe types ${stamp}`,
            handle: typesHandle,
            items: toUpdateInput(readItems, {}),
          });
          report.typeRoundTrip.asReadErrors.push(...topLevelErrors(asRead));
          const asReadPayload = asRead.data?.menuUpdate as { userErrors?: unknown } | undefined;
          report.typeRoundTrip.asReadErrors.push(...userErrorText(asReadPayload?.userErrors));
          report.typeRoundTrip.asReadOk = report.typeRoundTrip.asReadErrors.length === 0;

          // Write-back #2 only if the first failed: the same tree with `url`
          // dropped from every non-HTTP item. Two results, one rule — either
          // the url is the problem or it is not.
          if (!report.typeRoundTrip.asReadOk) {
            const stripped = toUpdateInput(readItems, {}).map((node) => {
              if (node.type === "HTTP") return node;
              const { url: _dropped, ...rest } = node as Record<string, unknown>;
              return rest;
            });
            const without = await run(MENU_UPDATE_MUTATION, {
              id: typesMenuId,
              title: `ContentPilot write probe types ${stamp}`,
              handle: typesHandle,
              items: stripped,
            });
            report.typeRoundTrip.withoutUrlErrors.push(...topLevelErrors(without));
            const withoutPayload = without.data?.menuUpdate as { userErrors?: unknown } | undefined;
            report.typeRoundTrip.withoutUrlErrors.push(...userErrorText(withoutPayload?.userErrors));
            report.typeRoundTrip.withoutUrlOk = report.typeRoundTrip.withoutUrlErrors.length === 0;
          }
        }
      } catch (error) {
        report.typeRoundTrip.createErrors.push(error instanceof Error ? error.message : String(error));
      }
    }

    // ── 7. The omission test ───────────────────────────────────────────────
    if (grandchild) {
      report.omission.attempted = true;
      report.omission.omittedItemId = grandchild.id;
      report.omission.omittedPath = grandchild.path;

      const currentRead = await readMenu();
      report.omission.errors.push(...currentRead.errors);
      const omitResult = await run(MENU_UPDATE_MUTATION, {
        id: menuId,
        title: `ContentPilot write probe ${stamp}`,
        handle,
        items: toUpdateInput(currentRead.items, { omitId: grandchild.id }),
      });
      report.omission.errors.push(...topLevelErrors(omitResult));
      const omitPayload = omitResult.data?.menuUpdate as { userErrors?: unknown } | undefined;
      report.omission.errors.push(...userErrorText(omitPayload?.userErrors));

      const afterOmit = await readMenu();
      report.omission.errors.push(...afterOmit.errors);
      const afterItems = flatten(afterOmit.items);
      report.omission.stillPresentAfterwards = afterItems.some((i) => i.id === grandchild.id);
      report.omission.siblingsSurvived = afterItems.some((i) => i.id === targetBefore?.id);

      // §2.4 — and what became of ITS translation? This decides whether an
      // accidental delete is repairable by re-creating the item, which it is
      // not if the re-created item gets a fresh id.
      if (report.deleteTranslation.attempted && report.deleteTranslation.linkId && foreignLocale) {
        try {
          const read = await run(LINK_TRANSLATABLE_QUERY, {
            id: report.deleteTranslation.linkId,
            locale: foreignLocale,
          });
          report.deleteTranslation.errors.push(...topLevelErrors(read));
          const resource = read.data?.translatableResource as
            | { translations?: Array<{ key: string; value: string }> }
            | null
            | undefined;
          // An ABSENT translatableResource is the answer here, not an
          // inconclusive read: the item is provably gone (the fresh read above
          // says so), so its Link having disappeared with it is a measurement.
          report.deleteTranslation.resourceStillResolves = !!resource;
          report.deleteTranslation.valueAfterDelete =
            resource?.translations?.find((t) => t.key === "title")?.value ?? null;
        } catch (error) {
          report.deleteTranslation.errors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
    // ── 7b. WHICH write kills a translation? ───────────────────────────────
    // Its own menu with four items, one per hypothesis. Everything is read
    // after every stage, because the interesting answer is not "it is gone"
    // but "it went away HERE and the others did not".
    if (foreignLocale) {
      report.translationDurability.attempted = true;
      report.translationDurability.locale = foreignLocale;
      const durHandle = `${handle}-dur`;
      try {
        const created = await run(MENU_CREATE_MUTATION, {
          title: `ContentPilot durability probe ${stamp}`,
          handle: durHandle,
          items: ["CONTROL", "MOVED", "RENAMED", "REORDERED", "MARKETED"].map((role) => ({
            title: `CP Probe ${role}`,
            type: "HTTP",
            url: `https://example.com/cp-probe-${role.toLowerCase()}`,
            // The moved item carries a child, so the report can tell "the item
            // I dragged" apart from "everything that came with it".
            ...(role === "MOVED"
              ? {
                  items: [
                    {
                      title: "CP Probe CARRIED",
                      type: "HTTP",
                      url: "https://example.com/cp-probe-carried",
                    },
                  ],
                }
              : {}),
          })),
        });
        report.translationDurability.errors.push(...topLevelErrors(created));
        const payload = created.data?.menuCreate as
          | { menu?: { id: string } | null; userErrors?: unknown }
          | undefined;
        report.translationDurability.errors.push(...userErrorText(payload?.userErrors));
        report.translationDurability.menuId = payload?.menu?.id ?? null;
        if (report.translationDurability.menuId) {
          createdMenus.push({ handle: durHandle, id: report.translationDurability.menuId });
        }

        const durMenuId = report.translationDurability.menuId;
        if (durMenuId) {
          const readDurMenu = async (): Promise<RawItem[]> => {
            const result = await run(MENU_READ_QUERY, { id: durMenuId });
            return ((result.data?.menu as { items?: RawItem[] } | null)?.items ?? []) as RawItem[];
          };
          const roleOf = (title: string) => title.replace("CP Probe ", "").split(" ")[0];

          const initial = await readDurMenu();
          const byRole = new Map<string, string>();
          for (const item of flatten(initial)) {
            const linkId = linkGidForMenuItem(item.id);
            if (linkId) byRole.set(roleOf(item.title), linkId);
          }
          report.translationDurability.links = [...byRole].map(([role, linkId]) => ({ role, linkId }));

          // Register one translation per item.
          for (const [role, linkId] of byRole) {
            const read = await run(LINK_TRANSLATABLE_QUERY, { id: linkId, locale: foreignLocale });
            const digest = (
              read.data?.translatableResource as
                | { translatableContent?: Array<{ key: string; digest: string | null }> }
                | null
                | undefined
            )?.translatableContent?.find((c) => c.key === "title")?.digest ?? null;
            if (!digest) {
              report.translationDurability.errors.push(`No digest for ${role} — it cannot take part.`);
              continue;
            }
            const registered = await run(REGISTER_MUTATION, {
              resourceId: linkId,
              translations: [
                {
                  key: "title",
                  locale: foreignLocale,
                  value: `CP-DUR-${role}-${stamp}`,
                  translatableContentDigest: digest,
                },
              ],
            });
            report.translationDurability.errors.push(...topLevelErrors(registered));
          }

          /** Reads every watched link and records one observation per role. */
          const observe = async (stage: string) => {
            for (const [role, linkId] of byRole) {
              const read = await run(LINK_TRANSLATABLE_QUERY, { id: linkId, locale: foreignLocale });
              const row = (
                read.data?.translatableResource as
                  | { translations?: Array<{ key: string; value: string; outdated: boolean }> }
                  | null
                  | undefined
              )?.translations?.find((t) => t.key === "title");
              report.translationDurability.observations.push({
                stage,
                role,
                value: row?.value ?? null,
                outdated: row?.outdated ?? null,
              });
            }
          };
          const writeTree = async (stage: string, items: Array<Record<string, unknown>>) => {
            const result = await run(MENU_UPDATE_MUTATION, {
              id: durMenuId,
              title: `ContentPilot durability probe ${stamp}`,
              handle: durHandle,
              items,
            });
            const errs = [...topLevelErrors(result)];
            const p = result.data?.menuUpdate as { userErrors?: unknown } | undefined;
            errs.push(...userErrorText(p?.userErrors));
            for (const e of errs) report.translationDurability.errors.push(`${stage}: ${e}`);
          };

          // ── The market-scoped question ───────────────────────────────
          // Registered here, on its own item, so it rides the SAME move write
          // as everything else and the answer is comparable.
          try {
            const marketsResult = await run(MARKETS_QUERY);
            report.marketScoped.errors.push(...topLevelErrors(marketsResult));
            const markets =
              (marketsResult.data?.markets as
                | { nodes?: Array<{ id: string; name: string; status: string }> }
                | undefined)?.nodes ?? [];
            // ACTIVE, never the deprecated `enabled` flag (CLAUDE.md).
            const market = markets.find((m) => m.status === "ACTIVE") ?? null;
            const marketedLink = byRole.get("MARKETED");
            if (!market) {
              report.marketScoped.reason = "This shop has no ACTIVE market — the question cannot be asked here.";
            } else if (!marketedLink) {
              report.marketScoped.reason = "The MARKETED probe item has no derivable Link GID.";
            } else {
              report.marketScoped.attempted = true;
              report.marketScoped.marketId = market.id;
              report.marketScoped.marketName = market.name;
              report.marketScoped.locale = foreignLocale;

              const read = await run(LINK_TRANSLATABLE_QUERY, { id: marketedLink, locale: foreignLocale });
              const digest = (
                read.data?.translatableResource as
                  | { translatableContent?: Array<{ key: string; digest: string | null }> }
                  | null
                  | undefined
              )?.translatableContent?.find((c) => c.key === "title")?.digest ?? null;
              if (!digest) {
                report.marketScoped.reason = "No digest on the MARKETED item — nothing could be registered.";
              } else {
                const registered = await run(REGISTER_MUTATION, {
                  resourceId: marketedLink,
                  translations: [
                    {
                      key: "title",
                      locale: foreignLocale,
                      value: `CP-DUR-MARKET-${stamp}`,
                      translatableContentDigest: digest,
                      marketId: market.id,
                    },
                  ],
                });
                report.marketScoped.errors.push(...topLevelErrors(registered));
                const registerPayload = registered.data?.translationsRegister as
                  | { userErrors?: unknown }
                  | undefined;
                report.marketScoped.errors.push(...userErrorText(registerPayload?.userErrors));

                // Echo is not storage: read it back under the SAME market.
                const marketRead = await run(LINK_TRANSLATABLE_MARKET_QUERY, {
                  id: marketedLink,
                  locale: foreignLocale,
                  marketId: market.id,
                });
                report.marketScoped.errors.push(...topLevelErrors(marketRead));
                report.marketScoped.storedAtAll = !!(
                  marketRead.data?.translatableResource as
                    | { translations?: Array<{ key: string; value: string }> }
                    | null
                    | undefined
                )?.translations?.find((t) => t.key === "title")?.value;

                // And the global layer must NOT show it, or the two layers are
                // one layer and every rule this app has about them is wrong.
                const globalRead = await run(LINK_TRANSLATABLE_QUERY, {
                  id: marketedLink,
                  locale: foreignLocale,
                });
                const globalValue = (
                  globalRead.data?.translatableResource as
                    | { translations?: Array<{ key: string; value: string }> }
                    | null
                    | undefined
                )?.translations?.find((t) => t.key === "title")?.value ?? null;
                report.marketScoped.globalReadShowsIt = globalValue === `CP-DUR-MARKET-${stamp}`;
              }
            }
          } catch (error) {
            report.marketScoped.errors.push(error instanceof Error ? error.message : String(error));
          }

          await observe("registered");

          // W1 — a write that changes NOTHING. If a translation dies here, the
          // cause is the write itself, and the shipped rename feature is
          // affected too.
          await writeTree("noop", toUpdateInput(await readDurMenu(), {}));
          await observe("afterNoopWrite");

          // W2 — MOVED goes under CONTROL. Nothing else changes.
          const beforeMove = await readDurMenu();
          const movedItem = flatten(beforeMove).find((i) => roleOf(i.title) === "MOVED");
          const marketedItem = flatten(beforeMove).find((i) => roleOf(i.title) === "MARKETED");
          if (movedItem) {
            // Both re-parents ride ONE write: MOVED under CONTROL and MARKETED
            // under REORDERED. Two writes would leave "was it the second write
            // rather than the move" open all over again.
            const liftedIds = new Set([movedItem.id, ...(marketedItem ? [marketedItem.id] : [])]);
            const rest = beforeMove.filter((i) => !liftedIds.has(i.id));
            const nested = rest.map((node) => {
              const role = roleOf(node.title);
              if (role === "CONTROL") {
                return { ...node, items: [...(node.items ?? []), beforeMove.find((i) => i.id === movedItem.id)!] };
              }
              if (role === "REORDERED" && marketedItem) {
                return { ...node, items: [...(node.items ?? []), beforeMove.find((i) => i.id === marketedItem.id)!] };
              }
              return node;
            });
            await writeTree("move", toUpdateInput(nested, {}));
          }
          await observe("afterMove");

          // Did the market layer go with it? And can it be written back?
          if (report.marketScoped.attempted && report.marketScoped.marketId) {
            const marketedLink = byRole.get("MARKETED");
            const marketId = report.marketScoped.marketId;
            if (marketedLink) {
              try {
                const after = await run(LINK_TRANSLATABLE_MARKET_QUERY, {
                  id: marketedLink,
                  locale: foreignLocale,
                  marketId,
                });
                report.marketScoped.survivesMove = !!(
                  after.data?.translatableResource as
                    | { translations?: Array<{ key: string; value: string }> }
                    | null
                    | undefined
                )?.translations?.find((t) => t.key === "title")?.value;

                if (report.marketScoped.survivesMove === false) {
                  const fresh = await run(LINK_TRANSLATABLE_QUERY, { id: marketedLink, locale: foreignLocale });
                  const digest = (
                    fresh.data?.translatableResource as
                      | { translatableContent?: Array<{ key: string; digest: string | null }> }
                      | null
                      | undefined
                  )?.translatableContent?.find((c) => c.key === "title")?.digest ?? null;
                  if (digest) {
                    await run(REGISTER_MUTATION, {
                      resourceId: marketedLink,
                      translations: [
                        {
                          key: "title",
                          locale: foreignLocale,
                          value: `CP-DUR-MARKET-REPAIRED-${stamp}`,
                          translatableContentDigest: digest,
                          marketId,
                        },
                      ],
                    });
                    const verify = await run(LINK_TRANSLATABLE_MARKET_QUERY, {
                      id: marketedLink,
                      locale: foreignLocale,
                      marketId,
                    });
                    report.marketScoped.restorable = !!(
                      verify.data?.translatableResource as
                        | { translations?: Array<{ key: string; value: string }> }
                        | null
                        | undefined
                    )?.translations?.find((t) => t.key === "title")?.value;
                  } else {
                    report.marketScoped.restorable = false;
                  }
                }
              } catch (error) {
                report.marketScoped.errors.push(error instanceof Error ? error.message : String(error));
              }
            }
          }

          // W3 — RENAMED is renamed. Its translation should survive as
          // outdated, which is what the earlier run measured.
          const beforeRename = await readDurMenu();
          const renamedItem = flatten(beforeRename).find((i) => roleOf(i.title) === "RENAMED");
          if (renamedItem) {
            await writeTree(
              "rename",
              toUpdateInput(beforeRename, { renameId: renamedItem.id, renameTo: `CP Probe RENAMED neu ${stamp}` }),
            );
          }
          await observe("afterRename");

          // W4 — another write that changes nothing. THIS is the one that
          // separates "outdated translations are collected on the next write"
          // from "the move did it".
          await writeTree("noop2", toUpdateInput(await readDurMenu(), {}));
          await observe("afterWriteFollowingRename");

          // W5 — REORDERED swaps to the front. Position only, same parent.
          const beforeReorder = await readDurMenu();
          const reordered = beforeReorder.find((i) => roleOf(i.title) === "REORDERED");
          if (reordered) {
            const others = beforeReorder.filter((i) => i.id !== reordered.id);
            await writeTree("reorder", toUpdateInput([reordered, ...others], {}));
          }
          await observe("afterReorder");

          // Can the dropped value simply be written again? If yes, the tree
          // editor's repair is "re-register after a move", and Phase 1 can be
          // built on it. If no, moving an item is a translation loss with no
          // remedy and the editor has to say so before the drag.
          const movedLink = byRole.get("MOVED");
          if (movedLink && !report.translationDurability.observations.find(
            (o) => o.stage === "afterReorder" && o.role === "MOVED",
          )?.value) {
            report.translationDurability.reRegisterAfterMove.attempted = true;
            const read = await run(LINK_TRANSLATABLE_QUERY, { id: movedLink, locale: foreignLocale });
            const digest = (
              read.data?.translatableResource as
                | { translatableContent?: Array<{ key: string; digest: string | null }> }
                | null
                | undefined
            )?.translatableContent?.find((c) => c.key === "title")?.digest ?? null;
            report.translationDurability.reRegisterAfterMove.digestFound = !!digest;
            if (digest) {
              await run(REGISTER_MUTATION, {
                resourceId: movedLink,
                translations: [
                  {
                    key: "title",
                    locale: foreignLocale,
                    value: `CP-DUR-REPAIRED-${stamp}`,
                    translatableContentDigest: digest,
                  },
                ],
              });
              const verify = await run(LINK_TRANSLATABLE_QUERY, { id: movedLink, locale: foreignLocale });
              report.translationDurability.reRegisterAfterMove.restored = !!(
                verify.data?.translatableResource as
                  | { translations?: Array<{ key: string; value: string }> }
                  | null
                  | undefined
              )?.translations?.find((t) => t.key === "title")?.value;
            }
          }
        }
      } catch (error) {
        report.translationDurability.errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    // ── 8. How deep does Shopify accept? (§2.3) ────────────────────────────
    // Shopify documents three levels. The editor's drag has to clamp somewhere
    // and the write path has to refuse somewhere; both need a MEASURED number,
    // not a documented one. Each depth gets its OWN menu, so a refusal at four
    // says nothing about five and neither disturbs anything above.
    report.depth.attempted = true;
    for (const depth of [3, 4, 5]) {
      const depthHandle = `${handle}-d${depth}`;
      // A chain of `depth` nested items, innermost first.
      let node: Record<string, unknown> = {
        title: `CP Probe L${depth}`,
        type: "HTTP",
        url: `https://example.com/cp-probe-l${depth}`,
      };
      for (let level = depth - 1; level >= 1; level -= 1) {
        node = {
          title: `CP Probe L${level}`,
          type: "HTTP",
          url: `https://example.com/cp-probe-l${level}`,
          items: [node],
        };
      }
      try {
        const result = await run(MENU_CREATE_MUTATION, {
          title: `ContentPilot depth probe ${depth} ${stamp}`,
          handle: depthHandle,
          items: [node],
        });
        const errors = [...topLevelErrors(result)];
        const payload = result.data?.menuCreate as
          | { menu?: { id: string } | null; userErrors?: unknown }
          | undefined;
        errors.push(...userErrorText(payload?.userErrors));
        const createdId = payload?.menu?.id ?? null;
        if (createdId) createdMenus.push({ handle: depthHandle, id: createdId });
        // Accepted means CREATED, not "no error": a mutation that answers
        // without userErrors and without a menu has stored nothing.
        const accepted = !!createdId && errors.length === 0;

        // And created is not stored either. A fresh read says how deep the
        // tree actually came back — the same reason every write in this app
        // re-reads instead of trusting its own mutation.
        let observedDepth: number | null = null;
        if (createdId) {
          const back = await run(MENU_READ_QUERY, { id: createdId });
          const items = flatten((back.data?.menu as { items?: RawItem[] } | null)?.items);
          observedDepth = items.length > 0 ? Math.max(...items.map((i) => i.depth)) : null;
        }

        report.depth.results.push({
          depth,
          accepted,
          observedDepth,
          error: accepted ? undefined : errors.join("; ") || "no menu returned",
        });
        if (accepted && observedDepth !== null && observedDepth >= Math.min(depth, report.depth.readableDepth)) {
          report.depth.maxAccepted = Math.max(report.depth.maxAccepted ?? 0, depth);
        }
      } catch (error) {
        report.depth.results.push({
          depth,
          accepted: false,
          observedDepth: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    report.setup.errors.push(`Probe aborted: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    // Every menu created above must go, even when a step threw. The handles
    // are stamped, so anything left behind can always be found by hand — and
    // the report says so rather than leaving the merchant to notice.
    for (const created of createdMenus) {
      try {
        const deleteResult = await run(MENU_DELETE_MUTATION, { id: created.id });
        const errors = [...topLevelErrors(deleteResult)];
        const payload = deleteResult.data?.menuDelete as
          | { deletedMenuId?: string | null; userErrors?: unknown }
          | undefined;
        errors.push(...userErrorText(payload?.userErrors));
        const deleted = !!payload?.deletedMenuId;
        report.cleanup.menus.push({
          handle: created.handle,
          id: created.id,
          deleted,
          error: deleted ? undefined : errors.join("; ") || "no deletedMenuId returned",
        });
      } catch (error) {
        report.cleanup.menus.push({
          handle: created.handle,
          id: created.id,
          deleted: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    report.cleanup.allDeleted = report.cleanup.menus.every((m) => m.deleted);
  }

  // ── Verdict ────────────────────────────────────────────────────────────────
  // Every line states what was measured, and an unmeasured question says so
  // rather than defaulting to the comfortable answer.
  const v = report.verdict;
  if (report.rename.attempted) {
    if (report.rename.readBackTitle === report.rename.newTitle) {
      v.push("RENAME: menuUpdate stores a changed item title (fresh read confirms it).");
    } else {
      v.push(`RENAME: FAILED — read back "${report.rename.readBackTitle ?? "(nothing)"}" instead of the new title.`);
    }
    if (report.rename.idsStable === true) {
      v.push("IDS: every MenuItem kept its id across the update — translations (gid://shopify/Link/<same number>) survive a rename.");
    } else if (report.rename.idsStable === false) {
      v.push(
        `IDS: ⚠️ Shopify reassigned ${report.rename.idChanges.length} item id(s). A rename ORPHANS those items' translations — the feature must migrate or refuse.`,
      );
    }
    if (report.rename.collateralTitleChanges.length > 0) {
      v.push(`⚠️ ${report.rename.collateralTitleChanges.length} untouched item(s) changed title as a side effect.`);
    }
    if (report.rename.itemCountAfter !== report.rename.itemCountBefore) {
      v.push(`⚠️ Item count changed ${report.rename.itemCountBefore} -> ${report.rename.itemCountAfter} on a pure rename.`);
    }
  }
  if (report.rename.resourceIdPreserved === true) {
    v.push("RESOURCE BINDING: a resource-bound item keeps its resourceId when it is sent back.");
  } else if (report.rename.resourceIdPreserved === false) {
    v.push("RESOURCE BINDING: ⚠️ the resourceId did NOT survive the round trip.");
  } else {
    v.push("RESOURCE BINDING: not measured (no product or collection to bind to).");
  }
  if (report.resourceBound.attempted) {
    const bound = Object.entries(report.resourceBound.bound);
    const ok = bound.filter(([, v2]) => v2 === true).map(([t]) => t);
    const refused = bound.filter(([, v2]) => v2 === false).map(([t]) => t);
    const unmeasured = bound.filter(([, v2]) => v2 === null).map(([t]) => t);
    if (ok.length > 0) v.push(`TARGET TYPES: resourceId binds for ${ok.join(", ")}.`);
    if (refused.length > 0) {
      // The expensive direction: the picker offers the type, the save fails
      // for the WHOLE tree. Loud on purpose.
      v.push(`TARGET TYPES: ⚠️ resourceId did NOT bind for ${refused.join(", ")} — the picker must not offer these.`);
    }
    if (unmeasured.length > 0) {
      v.push(`TARGET TYPES: not measured for ${unmeasured.join(", ")} (this shop has no sample of that resource).`);
    }
    if (report.resourceBound.createErrors.length > 0) {
      v.push(`TARGET TYPES: create reported ${report.resourceBound.createErrors.join(" | ")}`);
    }
    const rt = report.resourceBound.retarget;
    if (rt.attempted) {
      if (rt.resourceIdCleared === true) {
        v.push(
          `RETARGET: sending ${rt.fromType} back as HTTP without a resourceId CLEARED the binding` +
            `${rt.urlStored === true ? " and stored the new url" : rt.urlStored === false ? " but did NOT store the url ⚠️" : ""}.`,
        );
      } else if (rt.resourceIdCleared === false) {
        // The expensive answer: the picker would show an HTTP link that still
        // points at the product, and the write path would have to send an
        // explicit null instead of omitting the field.
        v.push("RETARGET: ⚠️ the old resourceId SURVIVED — omitting the field does not clear a binding.");
      }
      if (rt.reboundOk === true) {
        v.push(
          `RETARGET: binding it back to ${rt.fromType} worked` +
            `${rt.urlClearedOnRebind === false ? ", but the old HTTP url survived ⚠️" : "."}`,
        );
      } else if (rt.reboundOk === false) {
        v.push(`RETARGET: ⚠️ binding it back to ${rt.fromType} did not take.`);
      }
      for (const e of rt.errors) v.push(`RETARGET: error ${e}`);
    }
  }
  if (report.omission.stillPresentAfterwards === true) {
    v.push("OMISSION: an item left out of the list SURVIVED — menuUpdate is not a full replace.");
  } else if (report.omission.stillPresentAfterwards === false) {
    v.push("OMISSION: an item left out of the list was DELETED — menuUpdate replaces the whole tree, as the write path assumes.");
  }
  if (report.translation.registered) {
    if (report.translation.valueAfterRename) {
      v.push(
        `TRANSLATION: survived the rename${report.translation.outdatedAfterRename ? " and is flagged outdated" : " and is NOT flagged outdated"}.`,
      );
    } else {
      v.push("TRANSLATION: ⚠️ gone after the rename — a primary edit destroys the translation.");
    }
  } else if (report.translation.attempted) {
    v.push("TRANSLATION: not measured — the probe translation could not be registered.");
  }
  if (report.move.attempted) {
    if (report.move.idKept === true) {
      v.push(
        `MOVE: an item keeps its id when it is re-parented and its siblings reordered (depth ${report.move.depthBefore} -> ${report.move.depthAfter})${report.move.childIdKept === true ? ", and its subtree comes along with its ids" : ""} — a tree editor may drag freely.`,
      );
      if (report.move.translationAfterMove) {
        v.push(
          `MOVE: the moved item's translation is still there${report.move.translationOutdated ? " (flagged outdated)" : ""} — moving does not lose it.`,
        );
      } else if (report.translation.registered) {
        v.push("MOVE: ⚠️ the moved item's translation is GONE after the move.");
      }
    } else if (report.move.idKept === false) {
      v.push(
        "MOVE: ⚠️ Shopify minted a NEW id for the moved item. Every drag would orphan that item's translations — a tree editor needs a translation migration before it may ship.",
      );
    } else {
      v.push("MOVE: not measured — the moved item could not be found again by title.");
    }
    if (report.move.siblingIdsKept === false) {
      v.push("MOVE: ⚠️ items that did NOT move lost their ids when the order changed.");
    }
  }
  if (report.create.attempted) {
    if (report.create.createdId) {
      v.push(
        `CREATE: an item sent without an id is created (${report.create.createdId})${report.create.positionHeld ? ", at exactly the position it was sent at, so a temp id can be resolved by position" : " — but NOT at the position it was sent at, so position cannot map a temp id"}${report.create.existingIdsKept === false ? ". ⚠️ Existing items lost their ids in the same write." : ""}`,
      );
      if (report.create.linkResolved === false) {
        v.push("CREATE: ⚠️ the new item's Link resource does not resolve yet — its translation cannot be written in the same save.");
      }
    } else {
      v.push("CREATE: ⚠️ an item without an id did NOT appear — adding items needs another route.");
    }
  }
  if (report.translationDurability.attempted) {
    const at = (stage: string, role: string) =>
      report.translationDurability.observations.find((o) => o.stage === stage && o.role === role);
    const lost = (role: string, stage: string, previous: string) =>
      !!at(previous, role)?.value && !at(stage, role)?.value;

    // The control decides which of the four hypotheses is even in play, so it
    // is reported first and in its own words.
    if (lost("CONTROL", "afterNoopWrite", "registered")) {
      v.push(
        "TRANSLATION DURABILITY: ⚠️⚠️ a menuUpdate that changes NOTHING already destroys an untouched item's translation. Every save on this page loses translations — the shipped rename feature included.",
      );
    } else if (!at("afterReorder", "CONTROL")?.value && at("registered", "CONTROL")?.value) {
      v.push(
        "TRANSLATION DURABILITY: ⚠️ the untouched control item lost its translation somewhere along the run — see the stage table for which write did it.",
      );
    } else if (at("afterReorder", "CONTROL")?.value) {
      v.push("TRANSLATION DURABILITY: an untouched item keeps its translation across five whole-tree writes.");
    }

    if (lost("MOVED", "afterMove", "afterNoopWrite")) {
      v.push(
        "TRANSLATION DURABILITY: ⚠️ RE-PARENTING drops the moved item's translation (its id survives). A tree editor must re-register after every move.",
      );
    } else if (at("afterMove", "MOVED")?.value) {
      v.push("TRANSLATION DURABILITY: re-parenting keeps the moved item's translation.");
    }

    if (at("registered", "CARRIED")) {
      if (lost("CARRIED", "afterMove", "afterNoopWrite")) {
        v.push(
          "TRANSLATION DURABILITY: ⚠️ a CHILD that merely came along with the move lost its translation too — moving a branch costs a re-registration for every item in it.",
        );
      } else if (at("afterMove", "CARRIED")?.value) {
        v.push(
          "TRANSLATION DURABILITY: a child that came along with the move KEPT its translation — only the item whose parent actually changed loses it.",
        );
      }
    }
    if (report.marketScoped.attempted) {
      if (report.marketScoped.storedAtAll === false) {
        v.push(
          "MARKET LAYER: a market-scoped translation could NOT be stored on a menu item — so a move cannot destroy one, and the editor's repair is complete.",
        );
      } else if (report.marketScoped.storedAtAll) {
        v.push(
          `MARKET LAYER: a menu item CAN hold a market-scoped translation (${report.marketScoped.marketName ?? "?"})${report.marketScoped.globalReadShowsIt ? " — ⚠️ and the GLOBAL read returns it too, so the two layers are not separate here" : ""}.`,
        );
        if (report.marketScoped.survivesMove === false) {
          v.push(
            report.marketScoped.restorable
              ? "MARKET LAYER: ⚠️ a move destroys it as well, and it CAN be written back — so the editor's repair must cover every market, not just the global layer."
              : "MARKET LAYER: ⚠️⚠️ a move destroys it and it could NOT be written back. Dragging an item would lose market content irrecoverably — that needs a warning in front of the drag.",
          );
        } else if (report.marketScoped.survivesMove) {
          v.push("MARKET LAYER: it SURVIVES the move — only the global layer is dropped.");
        }
      }
    } else if (report.marketScoped.reason) {
      v.push(`MARKET LAYER: not measured — ${report.marketScoped.reason}`);
    }
    if (report.translationDurability.reRegisterAfterMove.attempted) {
      v.push(
        report.translationDurability.reRegisterAfterMove.restored
          ? "TRANSLATION DURABILITY: the dropped value can be written again straight after the move — the repair works, and the editor can do it per moved item."
          : `TRANSLATION DURABILITY: ⚠️ the value could NOT be written again after the move (${report.translationDurability.reRegisterAfterMove.digestFound ? "digest was there" : "no digest"}) — moving an item is an unrepairable translation loss.`,
      );
    }
    if (lost("REORDERED", "afterReorder", "afterWriteFollowingRename")) {
      v.push("TRANSLATION DURABILITY: ⚠️ REORDERING alone drops the translation — even a same-parent drag.");
    } else if (at("afterReorder", "REORDERED")?.value) {
      v.push("TRANSLATION DURABILITY: reordering within the same parent keeps the translation.");
    }

    if (lost("RENAMED", "afterWriteFollowingRename", "afterRename")) {
      v.push(
        "TRANSLATION DURABILITY: ⚠️⚠️ an OUTDATED translation is destroyed by the NEXT write. The shipped rename feature promises to keep translations when the merchant switched the purge off, and does not keep them.",
      );
    } else if (at("afterWriteFollowingRename", "RENAMED")?.value) {
      v.push("TRANSLATION DURABILITY: an outdated translation survives further writes.");
    }
  }
  if (report.depth.attempted) {
    const accepted = report.depth.results.filter((r) => r.accepted).map((r) => r.depth);
    const refused = report.depth.results.filter((r) => !r.accepted).map((r) => r.depth);
    const unverifiable = report.depth.results.filter(
      (r) => r.accepted && r.observedDepth !== null && r.observedDepth < Math.min(r.depth, report.depth.readableDepth),
    );
    v.push(
      `DEPTH: accepted ${accepted.join(", ") || "none"}${refused.length > 0 ? `; refused ${refused.join(", ")}` : ""} — confirmed by a fresh read up to ${report.depth.maxAccepted ?? "(nothing)"} level(s). Past ${report.depth.readableDepth} this probe cannot look, and the write path refuses there anyway.`,
    );
    if (unverifiable.length > 0) {
      v.push(
        `DEPTH: ⚠️ ${unverifiable.map((r) => r.depth).join(", ")} level(s) were accepted by the mutation but came back SHALLOWER on a fresh read — Shopify stored less than it was sent.`,
      );
    }
  }
  if (report.deleteTranslation.attempted && report.omission.stillPresentAfterwards === false) {
    if (report.deleteTranslation.valueAfterDelete) {
      v.push("DELETE: ⚠️ the deleted item's translation is still stored on its Link resource.");
    } else {
      v.push(
        `DELETE: the deleted item's translation is gone with it (its Link resource ${report.deleteTranslation.resourceStillResolves ? "still resolves but holds nothing" : "no longer resolves"}) — an accidental delete is not undone by re-creating the item.`,
      );
    }
  }
  if (report.typeRoundTrip.asReadOk === true) {
    v.push(
      `ITEM TYPES: a whole-tree write-back with url present is accepted for ${report.typeRoundTrip.typesTried.join(", ")} — the write path may keep sending what it read.`,
    );
  } else if (report.typeRoundTrip.asReadOk === false) {
    v.push(
      report.typeRoundTrip.withoutUrlOk
        ? "ITEM TYPES: ⚠️ the write-back is REFUSED while url is present on a non-HTTP item, and accepted without it — the write path must strip url for those types."
        : "ITEM TYPES: ⚠️ the write-back is REFUSED for these types, and dropping url does not fix it — see the errors below.",
    );
  } else if (report.typeRoundTrip.attempted) {
    v.push("ITEM TYPES: not measured — the second probe menu could not be created.");
  }
  const leftBehind = report.cleanup.menus.filter((m) => !m.deleted);
  if (leftBehind.length > 0) {
    v.push(
      `⚠️ CLEANUP FAILED — delete these menus by hand in the Shopify admin: ${leftBehind.map((m) => m.handle).join(", ")}.`,
    );
  }

  logger.info("[MENU-WRITE-PROBE] Done", {
    context: "MenuWriteProbe",
    shop: session.shop,
    created: report.setup.created,
    menusCreated: report.cleanup.menus.length,
    allDeleted: report.cleanup.allDeleted,
    idsStable: String(report.rename.idsStable),
  });

  return json({ report });
}
