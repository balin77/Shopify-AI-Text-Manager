/**
 * Menus — translate navigation items, at every level.
 *
 * This page used to say "Shopify does not support translating menu items" and
 * render every field disabled. That was an assumption, never a measurement,
 * and it has since been measured to be wrong (2026-08, live shop,
 * /api/menu-translation-probe under Settings -> Probes -> Translation;
 * identical on 2025-10 and 2026-07):
 *
 *   - Every menu item at EVERY depth has its own Link resource with the single
 *     key title. 59 links for 59 items across depths 1-3, none absent.
 *   - gid://shopify/MenuItem/<n> corresponds to gid://shopify/Link/<n> — the
 *     SAME number — so a child is addressable without any enumeration.
 *   - Registering on such a Link echoes, a fresh read returns the value, and
 *     removing it is confirmed too: the full cycle, on a depth-3 item.
 *   - What does NOT work is the documented enumeration:
 *     nestedTranslatableResources(resourceType: LINK) returns ZERO links for
 *     every menu at every depth. Reading menus as untranslatable is what that
 *     empty answer looks like from the inside — which is how the wrong claim
 *     got here in the first place.
 *
 * The page is a full menu EDITOR, not a translation surface with a rename
 * bolted on: drag to reorder and re-nest, add and delete items, edit titles.
 * All of it is one write (menuUpdate takes the whole item list), so there is
 * exactly one writer — saveMenuTree — and the rename-only path this started
 * as was retired rather than kept beside it: two whole-tree writers on one
 * menu means the second one refuses over the first one's own result.
 *
 * The dangerous half of that mutation is what menu-tree.server.ts is about:
 * an item not in the list is DELETED, and re-parenting destroys an item's
 * translations (measured). Neither is visible from here; the page's job is to
 * SAY what is about to happen — the change summary, the deletion warning, and
 * the drift refusal that names what somebody else changed.
 *
 * Still NOT offered, and deliberately: changing where an item points (needs a
 * resource picker per type) and the menu's own title and handle — a handle is
 * what a theme references, and renaming it unhooks the menu from the
 * storefront without saying so.
 *
 * The item column is the shared UnifiedItemList, not a bespoke one: below
 * 900px `.desktop-only` hides it and the navbar's compact selector takes over,
 * which only works for pages that register their items with ItemSelectorContext.
 *
 * Still unmeasured and therefore not claimed anywhere in the UI: whether a
 * translated sub-item RENDERS in the storefront navigation. Shopify's own
 * editor writes the same resource, so it is likely — but likely is not
 * measured, and this file has already paid for that difference once.
 */

import { useState, useEffect, useMemo, useCallback, useRef, type ReactElement } from "react";
import { useLoaderData, useFetcher, useRevalidator } from "react-router";
import {
  Page,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Banner,
  Button,
  TextField,
  Tooltip,
} from "@shopify/polaris";
import { RefreshIcon } from "@shopify/polaris-icons";
import { useI18n } from "../contexts/I18nContext";
import { PlanAccessGate } from "../components/PlanAccessGate";
import { AppSaveBar } from "../components/AppSaveBar";
import { DisabledActionTooltip } from "../components/DisabledActionTooltip";
import { HelpTooltip } from "../components/HelpTooltip";
import { useDeleteItem } from "../hooks/useDeleteItem";
import { DeleteItemModal } from "../components/create/DeleteItemModal";
import { UnifiedItemList, type UnifiedItem } from "../components/unified/UnifiedItemList";
import { UnifiedLanguageBar, shouldRenderLanguageBar } from "../components/unified/UnifiedLanguageBar";
import { useItemSelector } from "../contexts/ItemSelectorContext";
import type { ShopLocale, TranslatableItem, ContentType } from "../types/content-editor.types";
// The translation-state colours and the per-field action footer live here.
// The stylesheet is imported per component in this codebase, not globally, so
// a page that uses `bg-missing-translation` / `bg-untranslated` / the footer
// classes without this import renders them as plain unstyled markup.
import "../styles/AIEditableField.css";
import "../styles/MenuTreeRow.css";
import { createContentLoader } from "~/utils/loader-factory.server";
import {
  flattenMenuItems,
  diffMenuTranslations,
  linkGidForMenuItem as linkGidForNode,
  type FlatMenuItem,
} from "~/services/menu-translations.shared";
import { menuStructureFingerprint } from "~/services/menu-write.shared";
import {
  diffMenuTrees,
  editorNodesFromRawTree,
  isEmptyMenuTreeDiff,
  removeNode,
  updateNode,
  validateEditorTree,
  appendNode,
  idsUnder,
  type MenuEditorNode,
} from "~/services/menu-tree.shared";
import { MenuTreeEditor, newMenuNode } from "~/components/menus/MenuTreeEditor";
import {
  MenuTargetPicker,
  type MenuTargetPickerStrings,
} from "~/components/menus/MenuTargetPicker";
import type { ActionFunctionArgs } from "react-router";

/** What the loader hands the client per Link GID. */
interface LinkTranslationDTO {
  primaryTitle: string | null;
  translatable: boolean;
  byLocale: Record<string, string>;
}

// ============================================================================
// LOADER — menu sync + every Link translation of the shop
// ============================================================================

export const loader = createContentLoader({
  logPrefix: "MENUS",
  resourceType: null, // Menu itself carries only its admin-only name.
  itemsKey: "menus",

  async loadData(ctx) {
    // Every tree, every load. Menus have no Shopify webhook, and the previous
    // incremental sync only fetched menus MISSING from the DB — so a tree was
    // read once and never again: items added in Shopify never showed up, and
    // deleted ones kept rendering as "not translatable". One query for the
    // whole shop replaces the per-menu round trips it used to make.
    try {
      const { ShopifyApiGateway } = await import("~/services/shopify-api-gateway.service");
      const { refreshMenuCache } = await import("~/services/menu-translations.server");
      await refreshMenuCache(
        new ShopifyApiGateway(ctx.admin, ctx.session.shop),
        ctx.db,
        ctx.session.shop,
      );
    } catch (error) {
      // A thrown Response is the framework's business, not a refresh failure:
      // createContentLoader turns a 401 into "delete the stale session, show
      // Session expired, re-authenticate on the next request". Swallowing it
      // would leave a revoked token serving cached menus with every field
      // disabled — forever, since nothing would ever trigger the recovery.
      if (error instanceof Response) throw error;
      // Anything else shows the CACHED menus rather than an error page —
      // stale navigation labels are worth more than no page at all, and the
      // save path re-reads from Shopify anyway.
      const { logger } = await import("~/utils/logger.server");
      logger.error("[MENUS-LOADER] Menu refresh failed — serving cached menus", {
        context: "Menus",
        shop: ctx.session.shop,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const menus = await ctx.db.menu.findMany({
      where: { shop: ctx.session.shop },
      orderBy: { title: "asc" },
    });

    return { items: menus, ids: [] };
  },

  /**
   * The Link sweep. Shop-wide rather than per-menu on purpose: the per-menu
   * nested connection returns nothing, and the sweep costs one query for the
   * whole shop in every locale at once. It is read LIVE rather than from
   * ContentTranslation because a shop that translated its menus in Shopify's
   * own editor has values this app has never seen — showing empty fields over
   * them would invite overwriting work the merchant already did.
   */
  async extraData(ctx) {
    // PUBLISHED and non-primary. An unpublished locale is not served to any
    // customer, so offering to translate into it would spend the merchant's
    // time on text nobody can reach — the same filter app.bulk.tsx applies.
    // `published` comes from getCachedShopLocales at runtime; the loader
    // factory's ShopLocale type predates the field, hence the widening. An
    // ABSENT flag counts as published — never gate a feature on a lookup that
    // did not answer.
    const foreignLocales = (ctx.shopLocales as Array<{
      locale: string;
      primary: boolean;
      published?: boolean;
    }>)
      .filter((l) => l.published !== false && !l.primary)
      .map((l) => l.locale);

    // Every menu item's `resourceId`, resolved to a title the merchant reads.
    // Independent of the locale question below and of whether the link sweep
    // succeeds: a target picker that shows raw GIDs is one nobody can check,
    // and this is a handful of cache lookups grouped by resource type.
    const targetTitles = await loadMenuTargetTitles(ctx);

    if (foreignLocales.length === 0) {
      return {
        linkTranslations: {} as Record<string, LinkTranslationDTO>,
        linkSweepTruncated: false,
        targetTitles,
      };
    }

    try {
      const { ShopifyApiGateway } = await import("~/services/shopify-api-gateway.service");
      const { fetchShopLinkTranslations } = await import("~/services/menu-translations.server");
      const gateway = new ShopifyApiGateway(ctx.admin, ctx.session.shop);
      const sweep = await fetchShopLinkTranslations(gateway, foreignLocales);

      const linkTranslations: Record<string, LinkTranslationDTO> = {};
      for (const [linkId, row] of sweep.rows) {
        linkTranslations[linkId] = {
          primaryTitle: row.primaryTitle,
          // No digest means translationsRegister cannot be called for it, so
          // the field must not pretend to be editable.
          translatable: !!row.digest,
          byLocale: row.byLocale,
        };
      }
      return { linkTranslations, linkSweepTruncated: sweep.truncated, targetTitles };
    } catch (error) {
      // Same rule as the refresh above: a 401 belongs to the loader factory's
      // session recovery, not to this catch.
      if (error instanceof Response) throw error;
      const { logger } = await import("~/utils/logger.server");
      logger.error("[MENUS-LOADER] Link sweep failed", {
        context: "Menus",
        shop: ctx.session.shop,
        error: error instanceof Error ? error.message : String(error),
      });
      // An empty map with truncated=true reads as "incomplete", never as
      // "these items are untranslatable" — the exact distinction this page
      // got wrong for years.
      return {
        linkTranslations: {} as Record<string, LinkTranslationDTO>,
        linkSweepTruncated: true,
        targetTitles,
      };
    }
  },

  errorFallback: {
    linkTranslations: {} as Record<string, LinkTranslationDTO>,
    linkSweepTruncated: false,
    targetTitles: {} as Record<string, string>,
  },
});

/**
 * GID → title for every target in every menu of the shop.
 *
 * Its own function because it must never take the page down: a menu whose
 * items point at resources this app has not synced still has to render, with
 * those rows naming the type and the raw id instead of a label. Failure is
 * therefore an empty map, not a throw.
 */
async function loadMenuTargetTitles(ctx: {
  db: typeof import("~/db.server").db;
  session: { shop: string };
}): Promise<Record<string, string>> {
  try {
    const { collectMenuResourceIds, resolveMenuTargetTitles } = await import(
      "~/services/menu-targets.server"
    );
    const rows = await ctx.db.menu.findMany({
      where: { shop: ctx.session.shop },
      select: { items: true },
    });
    const ids: string[] = [];
    for (const row of rows) collectMenuResourceIds(row.items, ids);
    return await resolveMenuTargetTitles(ctx.db, ctx.session.shop, ids);
  } catch {
    return {};
  }
}

// ============================================================================
// ACTION — save one locale's menu-item translations
// ============================================================================

export async function action({ request }: ActionFunctionArgs) {
  const { authenticate } = await import("../shopify.server");
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("~/db.server");
  const { canAccessContentType } = await import("~/utils/planUtils");
  const { isValidLocale } = await import("~/utils/validation");

  // Directly POST-reachable, so the plan gate lives here as well as in the UI.
  const settings = await db.aISettings.findUnique({
    where: { shop: session.shop },
    select: { subscriptionPlan: true },
  });
  if (!canAccessContentType((settings?.subscriptionPlan || "free") as never, "menus")) {
    return Response.json({ success: false, error: "gated" }, { status: 403 });
  }

  const formData = await request.formData();

  /**
   * Deleting a whole menu — the ONE delete path of the app, third entrance.
   *
   * Not a menu-local mutation: `deleteContentObject` already owns the echo
   * rule (Shopify must hand the id back — `userErrors: []` is not success),
   * the id/type agreement check, the plan gate and the cache purge, and a
   * second copy of those for menus is how one of them ends up missing. The
   * purge knows that a menu's translations hang off its ITEMS' Link ids and
   * has to collect them before the row goes.
   */
  if (formData.get("action") === "deleteContent") {
    const { deleteContentObject } = await import("~/actions/content/delete.actions");
    return deleteContentObject({
      admin,
      session,
      db,
      plan: ((settings?.subscriptionPlan || "free") as never),
      resource: "menu",
      gid: String(formData.get("resourceId") || ""),
    });
  }

  // Per-LOCALE payload, not a single locale. The per-entry buttons write into
  // several languages at once ("translate into all languages"), and the native
  // save bar is one button for whatever is pending — so a save that could only
  // carry one language would silently drop the rest of the merchant's work.
  let byLocale: Record<string, Array<{ linkId: string; value: string }>> = {};
  try {
    const parsed = JSON.parse(String(formData.get("changesByLocale") || "{}"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [locale, entries] of Object.entries(parsed)) {
        if (!isValidLocale(locale) || !Array.isArray(entries)) continue;
        byLocale[locale] = entries
          .filter((c) => c && typeof c.linkId === "string" && typeof c.value === "string")
          .map((c) => ({ linkId: c.linkId, value: String(c.value).trim() }));
      }
    }
  } catch {
    return Response.json({ success: false, error: "Malformed changes" }, { status: 400 });
  }

  /**
   * The PRIMARY-language payload: the whole item TREE.
   *
   * One payload rather than "renames here, structure there", because
   * menuUpdate rewrites the whole tree either way — two payloads would be two
   * sequential whole-tree writes on one menu, and the second one's drift check
   * would fail against the first one's result. The fingerprint travels with
   * it: it pins the tree the page was rendered from, and the server refuses
   * the write when Shopify's current tree no longer matches.
   */
  let treePayload: { menuId: string; fingerprint: string; tree: unknown } | null = null;
  try {
    const raw = String(formData.get("treeChanges") || "");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (
        typeof parsed?.menuId === "string" &&
        typeof parsed?.fingerprint === "string" &&
        Array.isArray(parsed?.tree)
      ) {
        treePayload = { menuId: parsed.menuId, fingerprint: parsed.fingerprint, tree: parsed.tree };
      }
    }
  } catch {
    return Response.json({ success: false, error: "Malformed changes" }, { status: 400 });
  }

  const locales = Object.keys(byLocale).filter((l) => byLocale[l].length > 0);
  if (locales.length === 0 && !treePayload) {
    return Response.json({ success: true, saved: {}, failures: [] });
  }

  const { ShopifyApiGateway } = await import("~/services/shopify-api-gateway.service");
  const { fetchShopLinkTranslations, saveMenuLinkTranslations } = await import(
    "~/services/menu-translations.server"
  );
  const gateway = new ShopifyApiGateway(admin, session.shop);

  /**
   * The tree write runs BEFORE the translations, and the order is not
   * cosmetic. A confirmed rename may purge that item's translations, a MOVE
   * destroys them outright (measured) and the write path restores them itself,
   * and the digest every translation is written against belongs to the primary
   * text. Writing the tree first means the sweep below reads the digests of
   * the NEW titles, and a translation typed in the same session lands after
   * both the purge and the repair rather than into them.
   */
  let treeResult: Awaited<ReturnType<typeof import("~/services/menu-tree.server").saveMenuTree>> | null = null;
  if (treePayload) {
    const { saveMenuTree } = await import("~/services/menu-tree.server");
    const { getCachedShopLocales } = await import("~/utils/shop-locales-cache.server");
    const { fetchShopMarkets } = await import("~/services/sync-utils");
    // An empty locale list means the LOOKUP failed, never "one locale" — the
    // repair and the purge then simply have no scope, which is the harmless
    // direction. fetchShopMarkets degrades to [] the same way, so a shop
    // without `read_markets` gets the global layer and no error.
    const shopLocales = await getCachedShopLocales(admin, session.shop);
    const foreignLocales = shopLocales
      .filter((l) => !l.primary && (l as { published?: boolean }).published !== false)
      .map((l) => l.locale);
    // Bound, exactly like every other caller (product-sync, metaobject-sync):
    // an inline wrapper here would be a second opinion about the gateway's
    // signature, and it is the one thing this call does not need.
    const markets = await fetchShopMarkets(admin.graphql.bind(admin));
    treeResult = await saveMenuTree(gateway, db, session.shop, {
      menuId: treePayload.menuId,
      fingerprint: treePayload.fingerprint,
      // The client's tree is a claim, not an authority: saveMenuTree validates
      // every node against Shopify's own fresh read before anything is sent.
      tree: treePayload.tree as never,
      foreignLocales,
      marketIds: markets.map((m) => m.id),
    });
  }

  if (locales.length === 0) {
    return Response.json({ success: true, saved: {}, failures: [], tree: treeResult });
  }

  // Digests are re-read server-side and NEVER taken from the client — the same
  // rule the bulk editor follows for its column universe. It doubles as the
  // authorization check on the ids themselves: the sweep is scoped to this
  // shop, so an id it does not contain cannot be written, and this action can
  // never become a generic "translate any Link" endpoint. ONE sweep serves
  // every locale: the digest belongs to the primary value, not to a language.
  let sweep;
  try {
    sweep = await fetchShopLinkTranslations(gateway, []);
  } catch (error) {
    // Without this the whole action throws, the error boundary renders and
    // the merchant's unsaved draft is gone — while every OTHER failure on
    // this path is reported per item and keeps the draft on screen.
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        saved: {},
        failures: [],
        tree: treeResult,
      },
      { status: 502 },
    );
  }

  const saved: Record<string, string[]> = {};
  const failures: Array<{ linkId: string; locale: string; message: string }> = [];

  // translationsRegister addresses ONE resource, so a save is one round trip
  // per item per language: five languages over sixty items is 300 calls in a
  // single HTTP request, which is a timeout, not a save. The bulk editor bounds
  // the same shape at MAX_SYNC_SAVE. Here the budget is spent in order and the
  // remainder is simply not written — those entries stay in the draft (they
  // never reach `saved`), so pressing save again continues where this stopped,
  // and the response says how many are left rather than pretending to be done.
  const MAX_WRITES_PER_SAVE = 100;
  let budget = MAX_WRITES_PER_SAVE;
  let deferred = 0;

  for (const locale of locales) {
    const entries = [];
    for (const change of byLocale[locale]) {
      if (budget <= 0) {
        deferred += 1;
        continue;
      }
      const row = sweep.rows.get(change.linkId);
      if (!row) {
        failures.push({ linkId: change.linkId, locale, message: "Unknown menu item for this shop." });
        continue;
      }
      entries.push({ linkId: change.linkId, value: change.value, digest: row.digest });
      budget -= 1;
    }

    const result = await saveMenuLinkTranslations(
      gateway,
      db,
      session.shop,
      locale,
      "", // Global only — a market-scoped menu translation is unmeasured.
      entries,
    );
    saved[locale] = result.savedLinkIds;
    for (const failure of result.failures) failures.push({ ...failure, locale });
  }

  return Response.json({ success: true, saved, failures, deferred, tree: treeResult });
}

// ============================================================================
// UI
// ============================================================================

export default function MenusPage() {
  const { menus, shopLocales, primaryLocale, error, linkTranslations, linkSweepTruncated, targetTitles } =
    useLoaderData<typeof loader>();
  const { t, locale: appLocale } = useI18n();
  // The "reload" the drift banner offers. A revalidation, not a page reload:
  // it re-reads the loader and keeps the merchant's unsaved drafts in state,
  // which is what makes "reload and save again" an instruction rather than a
  // request to retype.
  const revalidator = useRevalidator();
  const { registerItems, clearItems } = useItemSelector();
  type SaveResponse = {
    success: boolean;
    error?: string;
    saved?: Record<string, string[]>;
    failures?: Array<{ linkId: string; locale: string; message: string }>;
    /** Changes the server's per-request write budget did not reach. */
    deferred?: number;
    /**
     * The rename half. Its shape is re-declared here rather than imported from
     * menu-write.server: a type-only import would be erased, but the import
     * line is one refactor away from pulling a server module into the client
     * bundle, which the build refuses and typecheck does not catch.
     */
    tree?: TreeSaveResult | null;
  };
  /**
   * The tree write's outcome. Re-declared here rather than imported from
   * menu-tree.server: a type-only import would be erased, but the import line
   * is one refactor away from pulling a server module into the client bundle,
   * which the build refuses and typecheck does not catch.
   */
  type TreeSaveResult = {
    status:
      | "ok"
      | "menuMissing"
      | "readFailed"
      | "structureChanged"
      | "invalidTree"
      | "unknownItems"
      | "writeFailed";
    diff: {
      renamed: Array<{ id: string; from: string; to: string }>;
      reparented: Array<{ id: string }>;
      reordered: string[];
      retargeted: Array<{ id: string }>;
      created: string[];
      deleted: string[];
    };
    createdIds: Record<string, string>;
    reassignedItemIds: Array<{ before: string; after: string }>;
    problems: Array<{ key: string; code: string; title: string }>;
    foreignChanges?: {
      added: string[];
      removed: string[];
      renamed: Array<{ from: string; to: string }>;
      moved: string[];
      retargeted: string[];
    };
    translationRepair: { restored: number; failed: Array<{ linkId: string; message: string }> };
    purgedLinkIds: string[];
    purgedTranslationCount: number;
    message?: string;
  };

  /** The manual save bar. */
  const fetcher = useFetcher<SaveResponse>();
  /**
   * The per-entry buttons' own save. A SECOND fetcher on purpose: sharing one
   * would make the save bar spin for an action it did not start, and would let
   * one response prune the other's draft bookkeeping.
   */
  const autoFetcher = useFetcher<SaveResponse>();

  const [selectedMenuId, setSelectedMenuId] = useState<string | null>(null);
  const [activeLocale, setActiveLocale] = useState<string>(primaryLocale);
  /**
   * locale -> linkId -> pending value.
   *
   * Keyed by LOCALE, not just by link: the per-entry buttons fill several
   * languages from one click, and a draft that only ever held the language on
   * screen would throw the rest away the moment the merchant looked at it.
   */
  const [draftByLocale, setDraftByLocale] = useState<Record<string, Record<string, string>>>({});
  const [busyLinkIds, setBusyLinkIds] = useState<Set<string>>(new Set());
  /**
   * menuId -> the tree the merchant is building.
   *
   * Per MENU rather than one tree, so switching menus keeps unsaved work — the
   * same rule the translation drafts follow. Absent means "unchanged": the
   * base tree is derived from the loader, so a draft is only stored once
   * something is actually edited.
   */
  const [treeDrafts, setTreeDrafts] = useState<Record<string, MenuEditorNode[]>>({});
  /** Mints keys for new items. A counter, never the title — two items may share one. */
  const newNodeSeq = useRef(0);
  /** Exactly which tree the in-flight save submitted, captured at click time. */
  const submittedTreeRef = useRef<MenuEditorNode[] | null>(null);
  /**
   * The last tree write's outcome — state, not `fetcher.data`.
   *
   * The same reason the auto-save's failures are state: fetcher.data survives
   * until the NEXT submit, and the drift banner offers a Reload button. Read
   * straight from the fetcher, that banner would still be on screen after the
   * merchant pressed it, i.e. a button that visibly does nothing.
   */
  const [treeResult, setTreeResult] = useState<TreeSaveResult | null>(null);
  /**
   * Values written by the translate / copy buttons while their save is in
   * flight.
   *
   * Deliberately NOT the draft. Those buttons persist by themselves, so their
   * result is never unsaved work and the save bar must not appear for it —
   * a bar that pops up after an action that already saved asks the merchant to
   * confirm something that is done. They are shown from here until the loader
   * comes back carrying them, and only a FAILED one is moved into the draft,
   * where the bar is then exactly right: there really is unsaved work.
   */
  const [autoPending, setAutoPending] = useState<Record<string, Record<string, string>>>({});
  /** The last auto-save's outcome. See the settle effect for why it is state. */
  const [autoFailures, setAutoFailures] = useState<
    Array<{ linkId: string; locale: string; message: string }>
  >([]);
  const [autoError, setAutoError] = useState<string | undefined>(undefined);
  /** Exactly what the in-flight save submitted, captured at click time. */
  const submittedRef = useRef<Record<string, Array<{ linkId: string; value: string }>> | null>(null);
  const [translateError, setTranslateError] = useState<string | null>(null);

  const localeList = useMemo(
    () => (shopLocales || []).filter((l: any) => l.primary || l.published !== false),
    [shopLocales],
  );
  const foreignLocales = useMemo(
    () => localeList.filter((l: any) => !l.primary).map((l: any) => l.locale as string),
    [localeList],
  );
  // Single-language shops keep every action VISIBLE and disabled with a reason
  // — hiding them reads as a missing feature. Only the locale bar disappears.
  const singleLocaleHint = foreignLocales.length === 0 ? t.common?.requiresSecondLanguage : undefined;

  /**
   * Languages switched OFF by a Ctrl+click on their button.
   *
   * Stored as the disabled set, not the enabled one — the shop's locale list
   * comes from the loader and can grow on a revalidation, and a language that
   * appears while the page is open must default to ON rather than silently
   * dropping out of the next "into every language" click. In memory only, for
   * one session, exactly like the content editor's `enabledLanguages` and the
   * bulk editor's `disabledLocales`.
   *
   * It narrows the BULK buttons and nothing else: a switched-off language can
   * still be viewed, typed into and saved by hand, and its missing-translation
   * markers stay on — the merchant took it out of one action, not out of the
   * shop.
   */
  const [disabledLocales, setDisabledLocales] = useState<string[]>([]);
  const enabledLanguages = useMemo(
    () =>
      localeList
        .map((l: any) => l.locale as string)
        .filter((locale: string) => !disabledLocales.includes(locale)),
    [localeList, disabledLocales],
  );
  /** What "translate into all languages" / "copy into all languages" write. */
  const bulkTargetLocales = useMemo(
    () => foreignLocales.filter((locale: string) => !disabledLocales.includes(locale)),
    [foreignLocales, disabledLocales],
  );
  const toggleLanguage = useCallback(
    (locale: string) => {
      // The primary language is the source of every bulk action; switching it
      // off would leave the buttons with nothing to read from.
      if (locale === primaryLocale) return;
      setDisabledLocales((prev) =>
        prev.includes(locale) ? prev.filter((l) => l !== locale) : [...prev, locale],
      );
    },
    [primaryLocale],
  );
  /** Every other language switched off — the bulk buttons have no target. */
  const allTargetsOffHint =
    !singleLocaleHint && bulkTargetLocales.length === 0
      ? t.content?.menuAllLanguagesOff
      : undefined;
  const isPrimary = activeLocale === primaryLocale;

  const parsedMenus = useMemo(
    () => (menus || []).map((menu: any) => ({ ...menu, flat: flattenMenuItems(menu.items) })),
    [menus],
  );
  const selectedMenu = parsedMenus.find((m: any) => m.id === selectedMenuId);

  useEffect(() => {
    if (parsedMenus.length > 0 && !selectedMenuId) setSelectedMenuId(parsedMenus[0].id);
  }, [parsedMenus, selectedMenuId]);

  // ── Values ───────────────────────────────────────────────────────────────

  /**
   * Whether the sweep actually told us about this link. A link with no row is
   * UNKNOWN, not untranslated — the sweep may have failed or hit its page cap.
   * Every "is something missing here" question below goes through this first,
   * because painting unknown as missing is how a page ends up showing a blue
   * dot, a pulsing language button and a "not translatable" hint on the same
   * field at the same time.
   */
  const isKnown = useCallback(
    (linkId: string): boolean => !!(linkTranslations || {})[linkId],
    [linkTranslations],
  );

  /** What Shopify holds for a locale — the diff baseline. */
  const savedFor = useCallback(
    (locale: string, linkId: string): string =>
      ((linkTranslations || {})[linkId] as LinkTranslationDTO | undefined)?.byLocale?.[locale] ?? "",
    [linkTranslations],
  );
  /**
   * What is on screen. A manual edit wins over an auto-saved value still in
   * flight (the merchant typed later), and both win over what is stored.
   */
  const valueFor = useCallback(
    (locale: string, linkId: string): string =>
      draftByLocale[locale]?.[linkId] ?? autoPending[locale]?.[linkId] ?? savedFor(locale, linkId),
    [draftByLocale, autoPending, savedFor],
  );
  const isMissingIn = useCallback(
    (locale: string, linkId: string): boolean =>
      isKnown(linkId) && !valueFor(locale, linkId).trim(),
    [isKnown, valueFor],
  );

  const setDraftValue = useCallback((locale: string, linkId: string, value: string) => {
    setDraftByLocale((prev) => ({ ...prev, [locale]: { ...(prev[locale] ?? {}), [linkId]: value } }));
  }, []);

  // ── What a save would write ──────────────────────────────────────────────

  /**
   * The links the merchant can currently SEE. Drafts are keyed by Link GID
   * across the whole shop, so without this scope a Save pressed in one menu
   * would publish an edit parked in another — and the save bar would appear
   * for changes that are nowhere on screen.
   */
  const visibleLinkIds = useMemo(
    () =>
      new Set(
        ((selectedMenu?.flat ?? []) as FlatMenuItem[])
          .map((i) => i.linkId)
          .filter((id): id is string => !!id),
      ),
    [selectedMenu],
  );

  const changesByLocale = useMemo(() => {
    const out: Record<string, Array<{ linkId: string; value: string }>> = {};
    for (const locale of foreignLocales) {
      const scoped: Record<string, string> = {};
      for (const [linkId, value] of Object.entries(draftByLocale[locale] ?? {})) {
        if (visibleLinkIds.has(linkId)) scoped[linkId] = value;
      }
      const baseline: Record<string, string> = {};
      for (const linkId of Object.keys(scoped)) baseline[linkId] = savedFor(locale, linkId);
      const changes = diffMenuTranslations(baseline, scoped);
      if (changes.length > 0) out[locale] = changes;
    }
    return out;
  }, [foreignLocales, draftByLocale, visibleLinkIds, savedFor]);

  /**
   * The tree as Shopify holds it, and the tree the merchant is building.
   *
   * The BASE comes from the cache the page was rendered from — the same tree
   * the fingerprint is built from, so what the server compares against and
   * what the merchant sees are one thing.
   */
  const baseTree = useMemo(
    () => editorNodesFromRawTree(selectedMenu?.items),
    [selectedMenu],
  );
  const tree = (selectedMenuId && treeDrafts[selectedMenuId]) || baseTree;

  /**
   * The fingerprint each draft was built ON TOP OF.
   *
   * A draft is a set of edits against ONE version of the tree. If Shopify's
   * version moves underneath it — which is exactly what the reload after a
   * drift refusal fetches — the draft no longer describes the merchant's
   * intent: it is missing every foreign change, and because menuUpdate deletes
   * what it is not sent, saving it would REMOVE an item somebody else just
   * added. The fingerprint check on the server cannot catch that, because the
   * page would send the FRESH fingerprint, which matches.
   *
   * A ref rather than state: nothing renders from it, and it must be readable
   * inside the effect below without adding a render pass.
   */
  const draftBaseRef = useRef<Record<string, string>>({});

  const setTree = useCallback(
    (next: MenuEditorNode[]) => {
      if (!selectedMenuId) return;
      if (!draftBaseRef.current[selectedMenuId]) {
        draftBaseRef.current[selectedMenuId] = menuStructureFingerprint(selectedMenu?.items);
      }
      // A new edit is the merchant answering the notice; it has said its piece.
      setDroppedDraftMenus((prev) => (prev.length === 0 ? prev : []));
      setTreeDrafts((prev) => ({ ...prev, [selectedMenuId]: next }));
    },
    [selectedMenuId, selectedMenu],
  );

  const treeDiff = useMemo(() => diffMenuTrees(baseTree, tree), [baseTree, tree]);
  const treeChanged = !isEmptyMenuTreeDiff(treeDiff);
  const treeChangeCount =
    treeDiff.renamed.length +
    treeDiff.reparented.length +
    treeDiff.reordered.length +
    treeDiff.retargeted.length +
    treeDiff.created.length +
    treeDiff.deleted.length;
  /**
   * What Shopify would refuse, found while typing rather than on save.
   *
   * menuUpdate carries the WHOLE tree, so one bad item fails every other edit
   * with it — which is why this both marks the field and blocks the save.
   */
  const treeProblems = useMemo(() => validateEditorTree(tree), [tree]);
  const problemByKey = useMemo(() => {
    const out: Record<string, string> = {};
    for (const problem of treeProblems) out[problem.key] = problem.code;
    return out;
  }, [treeProblems]);

  /** The primary title as the BASE tree holds it — the rename comparison. */
  const baseTitleById = useMemo(() => {
    const out: Record<string, string> = {};
    const walk = (nodes: MenuEditorNode[]) => {
      for (const n of nodes) {
        if (n.id) out[n.id] = n.title;
        walk(n.children ?? []);
      }
    };
    walk(baseTree);
    return out;
  }, [baseTree]);

  /**
   * The tree the merchant is looking at, as the server will compare it.
   *
   * Built from the RAW cached items rather than the editor tree: the
   * fingerprint has to describe the tree BEFORE the edits, which is exactly
   * what the server re-reads and compares.
   */
  const menuFingerprint = useMemo(
    () => menuStructureFingerprint(selectedMenu?.items),
    [selectedMenu],
  );

  const changeCount = useMemo(
    () => treeChangeCount + Object.values(changesByLocale).reduce((sum, list) => sum + list.length, 0),
    [treeChangeCount, changesByLocale],
  );
  const isSaving = fetcher.state !== "idle";

  const onSave = useCallback(() => {
    if (changeCount === 0) return;
    // The banner said the tree was blocked; nothing enforced it. menuUpdate
    // carries the WHOLE tree, so submitting a known-bad item spends a round
    // trip to be told what we already knew — and takes every other edit in the
    // same save down with it.
    if (treeProblems.length > 0) return;
    // Captured HERE, synchronously, not in an effect: an effect that also
    // depends on changesByLocale re-captures while the request is in flight,
    // so a keystroke made during the save would match the response and get
    // deleted from the draft — silently reverting what the merchant just typed.
    submittedRef.current = changesByLocale;
    submittedTreeRef.current = treeChanged ? tree : null;
    setTreeResult(null);
    const fd = new FormData();
    fd.set("changesByLocale", JSON.stringify(changesByLocale));
    if (treeChanged && selectedMenuId) {
      // The fingerprint travels WITH the tree: it is what lets the server
      // refuse a write-back over a menu somebody else has moved since this
      // page was rendered.
      fd.set("treeChanges", JSON.stringify({ menuId: selectedMenuId, fingerprint: menuFingerprint, tree }));
    }
    fetcher.submit(fd, { method: "post" });
  }, [changeCount, changesByLocale, treeProblems, treeChanged, tree, menuFingerprint, selectedMenuId, fetcher]);

  const onDiscard = useCallback(() => {
    // Only what this save bar would have written. The bar appears for the
    // VISIBLE menu, so discarding edits parked in another menu would throw
    // away work the merchant was never told was at stake.
    setDraftByLocale((prev) => {
      const next: Record<string, Record<string, string>> = {};
      for (const [locale, entries] of Object.entries(prev)) {
        const kept: Record<string, string> = {};
        for (const [linkId, value] of Object.entries(entries)) {
          if (!visibleLinkIds.has(linkId)) kept[linkId] = value;
        }
        next[locale] = kept;
      }
      return next;
    });
    // Same scope rule for the tree: only the visible menu's draft goes.
    if (selectedMenuId) {
      delete draftBaseRef.current[selectedMenuId];
      setTreeDrafts((prev) => {
        const next = { ...prev };
        delete next[selectedMenuId];
        return next;
      });
    }
    setTranslateError(null);
  }, [visibleLinkIds, selectedMenuId]);

  // Confirmed values return through the loader on revalidation, so the draft
  // only drops what was saved — and only where it still equals what was sent.
  // Anything edited again mid-save, and anything that FAILED, stays put.
  useEffect(() => {
    const saved = fetcher.data?.saved;
    const submitted = submittedRef.current;
    if (!saved || !submitted) return;
    setDraftByLocale((prev) => {
      const next = { ...prev };
      for (const [locale, linkIds] of Object.entries(saved)) {
        const sent = new Map((submitted[locale] ?? []).map((c) => [c.linkId, c.value]));
        const bucket = { ...(next[locale] ?? {}) };
        for (const linkId of linkIds) {
          if ((bucket[linkId] ?? "").trim() === sent.get(linkId)) delete bucket[linkId];
        }
        next[locale] = bucket;
      }
      return next;
    });
  }, [fetcher.data]);

  /**
   * A confirmed tree save drops the draft — but only if it is still the tree
   * that was sent.
   *
   * The comparison is by reference: the draft is replaced wholesale on every
   * edit, so an identical reference means nothing has been touched since the
   * submit. A merchant who kept dragging during the save keeps their work.
   */
  useEffect(() => {
    const tree = fetcher.data?.tree;
    if (!tree) return;
    setTreeResult(tree);
    if (tree.status !== "ok") return;
    const submitted = submittedTreeRef.current;
    setTreeDrafts((prev) => {
      const next = { ...prev };
      for (const [menuId, draft] of Object.entries(prev)) {
        if (draft === submitted) {
          delete next[menuId];
          // …and the base it was built on, or the next edit would be measured
          // against a tree two saves old and read as stale on the next reload.
          delete draftBaseRef.current[menuId];
        }
      }
      return next;
    });
  }, [fetcher.data]);

  /**
   * A finished revalidation retires the last tree report. The refusal it
   * describes was about a tree that has just been replaced, and leaving it up
   * would make the Reload button look broken.
   */
  const revalidatorState = revalidator.state;
  const wasRevalidatingRef = useRef(false);
  useEffect(() => {
    if (revalidatorState !== "idle") {
      wasRevalidatingRef.current = true;
      return;
    }
    if (!wasRevalidatingRef.current) return;
    wasRevalidatingRef.current = false;
    setTreeResult(null);
  }, [revalidatorState]);

  /**
   * A draft whose tree moved in Shopify is DROPPED, and the merchant is told.
   *
   * This is the other half of the drift refusal. The banner says "somebody
   * changed this menu, reload" — and the reload used to bring the new tree in
   * while keeping the old draft on top of it. Two things followed, one
   * cosmetic and one not: the save bar lit up over a diff the merchant had not
   * produced, and that diff was their own edit PLUS a reversal of every
   * foreign change — so saving would have deleted an item somebody else had
   * just added. The server could not refuse it either, because the page would
   * by then be sending the FRESH fingerprint.
   *
   * A draft built on the SAME tree survives untouched: a reload that changed
   * nothing must not cost the merchant their unsaved work, which is the whole
   * reason this button revalidates instead of reloading the page.
   */
  const [droppedDraftMenus, setDroppedDraftMenus] = useState<string[]>([]);
  useEffect(() => {
    const stale: string[] = [];
    for (const menu of parsedMenus as Array<{ id: string; title: string; items?: unknown }>) {
      const base = draftBaseRef.current[menu.id];
      if (!base) continue;
      if (base !== menuStructureFingerprint(menu.items)) stale.push(menu.id);
    }
    if (stale.length === 0) return;
    const titles = (parsedMenus as Array<{ id: string; title: string }>)
      .filter((m) => stale.includes(m.id))
      .map((m) => m.title);
    for (const id of stale) delete draftBaseRef.current[id];
    setTreeDrafts((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const id of stale) {
        if (id in next) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setDroppedDraftMenus(titles);
  }, [parsedMenus]);

  // ── AI translate / copy, per entry ───────────────────────────────────────

  const withBusy = useCallback(async (linkId: string, run: () => Promise<void>) => {
    setBusyLinkIds((prev) => new Set(prev).add(linkId));
    try {
      await run();
    } finally {
      setBusyLinkIds((prev) => {
        const next = new Set(prev);
        next.delete(linkId);
        return next;
      });
    }
  }, []);

  /**
   * One AI translation. Deliberately the PURE `translateField` action, which
   * translates and returns without persisting: the result lands in the draft
   * and is written by the page's own echo-verified save. Menus must not gain
   * a second write path.
   */
  const translateOne = useCallback(
    async (linkId: string, sourceText: string, targetLocale: string): Promise<string | null> => {
      const fd = new FormData();
      fd.set("action", "translateField");
      fd.set("contentType", "menus");
      fd.set("itemId", linkId);
      fd.set("fieldType", "title");
      fd.set("sourceText", sourceText);
      fd.set("targetLocale", targetLocale);
      fd.set("primaryLocale", primaryLocale);
      const response = await fetch("/api/ai", { method: "POST", body: fd });
      const payload = (await response.json()) as { success?: boolean; translatedValue?: string; error?: string };
      if (!payload?.success || typeof payload.translatedValue !== "string") {
        throw new Error(payload?.error || `HTTP ${response.status}`);
      }
      return payload.translatedValue;
    },
    [primaryLocale],
  );

  /**
   * Persist one entry's values right away, through the SAME action the save
   * bar uses — one echo-verified write path, no second one for buttons.
   *
   * The values go to `autoPending` rather than the draft, so the save bar
   * never appears for work that is already on its way: these actions save by
   * themselves, and a bar asking to confirm them afterwards is a question the
   * merchant has no reason to answer.
   */
  const autoSave = useCallback(
    (valuesByLocale: Record<string, string>, linkId: string) => {
      const entries = Object.entries(valuesByLocale).filter(([, value]) => !!value.trim());
      if (entries.length === 0) return;

      setAutoPending((prev) => {
        const next = { ...prev };
        for (const [locale, value] of entries) {
          next[locale] = { ...(next[locale] ?? {}), [linkId]: value };
        }
        return next;
      });
      // And drop any manual edit of the same field. `valueFor` resolves the
      // draft FIRST, so a leftover draft entry would hide the value that was
      // just saved, keep the save bar claiming an unsaved change, and let the
      // next Save write the old text back over it.
      setDraftByLocale((prev) => {
        const next = { ...prev };
        for (const [locale] of entries) {
          if (!next[locale] || !(linkId in next[locale])) continue;
          const bucket = { ...next[locale] };
          delete bucket[linkId];
          next[locale] = bucket;
        }
        return next;
      });

      const changesByLocale: Record<string, Array<{ linkId: string; value: string }>> = {};
      for (const [locale, value] of entries) changesByLocale[locale] = [{ linkId, value }];

      setAutoFailures([]);
      setAutoError(undefined);
      const fd = new FormData();
      fd.set("changesByLocale", JSON.stringify(changesByLocale));
      autoFetcher.submit(fd, { method: "post" });
    },
    [autoFetcher],
  );

  /**
   * Settle every pending value when the auto-save answers.
   *
   * Confirmed ones simply drop — the loader revalidation carries them now.
   * EVERYTHING else moves into the draft: a per-item failure, a transport
   * error that saved nothing, a value the server's write budget did not
   * reach. Only two outcomes are acceptable for a value the merchant can
   * see — it is stored, or it is visibly unsaved with the save bar offering
   * a retry. Leaving it "pending" would be a third one: shown as if saved,
   * with its button spinning forever.
   *
   * A second auto-save still in flight can be rescued into the draft by this
   * too. That is self-healing rather than wrong: when its own response lands
   * the loader carries the same value, the diff against it is empty, and the
   * save bar goes away by itself.
   */
  // Mirrored in a ref so the settle effect can read the pending values without
  // depending on them (which would re-run it on its own writes) and without
  // calling setState from inside another updater — updaters run in the render
  // phase and StrictMode invokes them twice.
  const autoPendingRef = useRef(autoPending);
  useEffect(() => {
    autoPendingRef.current = autoPending;
  }, [autoPending]);

  useEffect(() => {
    const data = autoFetcher.data;
    if (!data || autoFetcher.state !== "idle") return;

    const pending = autoPendingRef.current;
    const rescued: Array<{ locale: string; linkId: string; value: string }> = [];
    for (const [locale, entries] of Object.entries(pending)) {
      const confirmed = new Set(data.saved?.[locale] ?? []);
      for (const [linkId, value] of Object.entries(entries)) {
        if (!confirmed.has(linkId)) rescued.push({ locale, linkId, value });
      }
    }
    if (rescued.length > 0) {
      setDraftByLocale((draft) => {
        const merged = { ...draft };
        for (const r of rescued) {
          merged[r.locale] = { ...(merged[r.locale] ?? {}), [r.linkId]: r.value };
        }
        return merged;
      });
    }
    if (Object.keys(pending).length > 0) setAutoPending({});

    // Held as state rather than read from the fetcher: `autoFetcher.data`
    // survives until the NEXT auto-save, so a failure reported straight from it
    // would still be on screen after the merchant fixed the same item through
    // the save bar, with only a reload to clear it.
    setAutoFailures(data.failures ?? []);
    setAutoError(data.error);
  }, [autoFetcher.data, autoFetcher.state]);

  /** Primary view: translate this entry into every other language, and save. */
  const translateToAll = useCallback(
    (item: FlatMenuItem, sourceText: string) => {
      if (!item.linkId || !sourceText.trim()) return;
      const linkId = item.linkId;
      setTranslateError(null);
      void withBusy(linkId, async () => {
        const values: Record<string, string> = {};
        for (const locale of bulkTargetLocales) {
          try {
            const value = await translateOne(linkId, sourceText, locale);
            if (value) values[locale] = value;
          } catch (e) {
            setTranslateError(e instanceof Error ? e.message : String(e));
          }
        }
        autoSave(values, linkId);
      });
    },
    [bulkTargetLocales, translateOne, autoSave, withBusy],
  );

  /** Primary view: put the primary label into every other language, and save. */
  const copyToAll = useCallback(
    (item: FlatMenuItem, sourceText: string) => {
      if (!item.linkId || !sourceText.trim()) return;
      const values: Record<string, string> = {};
      for (const locale of bulkTargetLocales) values[locale] = sourceText;
      autoSave(values, item.linkId);
    },
    [bulkTargetLocales, autoSave],
  );

  /** Foreign view: translate this entry from the primary language, and save. */
  const translateFromPrimary = useCallback(
    (item: FlatMenuItem, sourceText: string) => {
      if (!item.linkId || !sourceText.trim()) return;
      const linkId = item.linkId;
      setTranslateError(null);
      void withBusy(linkId, async () => {
        try {
          const value = await translateOne(linkId, sourceText, activeLocale);
          if (value) autoSave({ [activeLocale]: value }, linkId);
        } catch (e) {
          setTranslateError(e instanceof Error ? e.message : String(e));
        }
      });
    },
    [activeLocale, translateOne, autoSave, withBusy],
  );

  /**
   * The whole menu at once — the same pair every other content page has.
   *
   * Built from the SAME primitives the per-entry buttons use (translateOne +
   * autoSave), not from a second write path: one echo-verified save either
   * way, and a bulk run that behaved differently from the single one would be
   * two features wearing one label. Sequential on purpose — the AI endpoint is
   * one request per item per language, and firing a menu's worth at once buys
   * no wall clock while making a failure impossible to attribute.
   */
  const [bulkBusy, setBulkBusy] = useState(false);

  const translateWholeMenu = useCallback(async () => {
    const items = (selectedMenu?.flat ?? []) as FlatMenuItem[];
    const targets = isPrimary ? bulkTargetLocales : [activeLocale];
    if (targets.length === 0) return;
    setBulkBusy(true);
    setTranslateError(null);
    try {
      for (const item of items) {
        if (!item.linkId) continue;
        const row = (linkTranslations || {})[item.linkId] as LinkTranslationDTO | undefined;
        if (!row?.translatable) continue;
        const source = row.primaryTitle ?? item.title;
        if (!source.trim()) continue;
        const values: Record<string, string> = {};
        for (const locale of targets) {
          try {
            const value = await translateOne(item.linkId, source, locale);
            if (value) values[locale] = value;
          } catch (e) {
            // One item's failure is reported and the run continues: the
            // alternative is a half-translated menu with no way to tell which
            // half, which is the per-cell rule the bulk editor follows too.
            setTranslateError(e instanceof Error ? e.message : String(e));
          }
        }
        autoSave(values, item.linkId);
      }
    } finally {
      setBulkBusy(false);
    }
  }, [selectedMenu, isPrimary, bulkTargetLocales, activeLocale, linkTranslations, translateOne, autoSave]);

  /**
   * Empty every translation of this menu — in the active language, or in all
   * of them from the primary view.
   *
   * It only fills the DRAFT with empty values; nothing is removed until the
   * merchant saves, and Discard puts it all back. That is why there is no
   * confirmation dialog: the save bar already is one, and it names the count.
   */
  const clearWholeMenu = useCallback(() => {
    const targets = isPrimary ? foreignLocales : [activeLocale];
    if (targets.length === 0) return;
    const ids = [...visibleLinkIds];
    setDraftByLocale((prev) => {
      const next = { ...prev };
      for (const locale of targets) {
        const bucket = { ...(next[locale] ?? {}) };
        for (const linkId of ids) bucket[linkId] = "";
        next[locale] = bucket;
      }
      return next;
    });
  }, [isPrimary, foreignLocales, activeLocale, visibleLinkIds]);

  /** Foreign view: take the primary label over as-is, and save. */
  const copyFromPrimary = useCallback(
    (item: FlatMenuItem, sourceText: string) => {
      if (!item.linkId || !sourceText.trim()) return;
      autoSave({ [activeLocale]: sourceText }, item.linkId);
    },
    [activeLocale, autoSave],
  );

  // ── The menu picker ──────────────────────────────────────────────────────

  /**
   * A menu is incomplete when any of its links lacks a STORED value in any
   * language. Deliberately blind to the draft: a dot that reacts to typing
   * would re-run registerItems (seven setStates in the provider, every
   * consumer re-rendered) on each keystroke — and it would also claim work is
   * done that nobody has saved yet.
   */
  const menuHasMissing = useCallback(
    (flat: FlatMenuItem[]): boolean =>
      foreignLocales.some((locale) =>
        flat.some((item) => item.linkId && isKnown(item.linkId) && !savedFor(locale, item.linkId).trim()),
      ),
    [foreignLocales, isKnown, savedFor],
  );

  const selectorItems: UnifiedItem[] = useMemo(
    () =>
      parsedMenus.map((m: any) => ({
        id: m.id,
        title: m.title,
        subtitle: m.handle,
        // The blue dot every other content list uses for the same state.
        hasMissingTranslations: menuHasMissing(m.flat),
        missingTranslationsTooltip: t.content?.menuMissingTranslations,
      })),
    [parsedMenus, menuHasMissing, t],
  );

  useEffect(() => {
    registerItems({
      items: selectorItems,
      selectedItemId: selectedMenuId,
      onItemSelect: (id: string) => setSelectedMenuId(id),
      resourceName: {
        singular: t.content?.menu || "Menu",
        plural: t.content?.menus || "Menus",
      },
      t: { searchPlaceholder: t.content?.searchPlaceholder },
    });
  }, [selectorItems, selectedMenuId, registerItems, t]);
  useEffect(() => () => clearItems(), [clearItems]);

  // ── The language bar ─────────────────────────────────────────────────────

  /**
   * The bar colours each language button from ONE item's translation status,
   * so a menu is collapsed into one synthetic entry per language — present
   * only when every item of the menu has a value there. The `menus` branch in
   * field-validation.utils.ts reads exactly that shape; the value itself is
   * never displayed, it only has to be non-empty.
   */
  const languageBarItem = useMemo<TranslatableItem | null>(() => {
    if (!selectedMenu) return null;
    const links = ((selectedMenu.flat ?? []) as FlatMenuItem[])
      .map((i) => i.linkId)
      .filter((id): id is string => !!id);
    const translations = foreignLocales
      .filter((locale) => links.every((linkId) => !isMissingIn(locale, linkId)))
      .map((locale) => ({ key: "title", locale, value: selectedMenu.title }));
    return { id: selectedMenu.id, title: selectedMenu.title, translations } as unknown as TranslatableItem;
  }, [selectedMenu, foreignLocales, isMissingIn]);

  // ── Rendering one menu item ──────────────────────────────────────────────

  /**
   * One row's editable field.
   *
   * On the PRIMARY language it edits the item's title in the tree; on a
   * foreign one it edits that item's translation. Same row, same position,
   * different value — which is why the tree is one state for every language
   * and only the field changes.
   */
  /**
   * Everything the target picker says, in the merchant's language.
   *
   * Assembled here and not inside the picker because the picker is a control
   * and the app's words live in the i18n bundles — the same split every other
   * component in this tree follows. Memoised on the bundle: a menu renders one
   * picker per row, and rebuilding seven labels per row per keystroke is the
   * kind of cost that only shows up on a shop with a large navigation.
   */
  const targetPickerStrings = useMemo<MenuTargetPickerStrings>(() => {
    const c = t.content as Record<string, unknown> | undefined;
    const str = (key: string, fallback: string) =>
      typeof c?.[key] === "string" ? (c[key] as string) : fallback;
    const dict = (key: string) => (c?.[key] as Record<string, string> | undefined) ?? {};
    return {
      label: str("menuTargetLabel", "Target"),
      placeholder: str("menuTargetPlaceholder", "Search or paste a URL …"),
      useUrl: (value: string) =>
        str("menuTargetUseUrl", "Use this URL: {url}").replace("{url}", value),
      groupLabels: dict("menuTargetGroups"),
      typeNames: dict("menuTargetTypeNames"),
      targetlessGroup: str("menuTargetFixedGroup", "Fixed destinations"),
      targetlessLabels: dict("menuTargetTypes"),
      moreMatches: str("menuTargetMore", "More matches — narrow the search"),
      lookupFailed: str("menuTargetLookupFailed", "Part of the search failed."),
      noMatches: str("menuTargetNoMatches", "Nothing found."),
      searching: str("menuTargetSearching", "Searching …"),
      unresolved: (type: string, id: string) =>
        str("menuTargetUnresolved", "{type}: {id}").replace("{type}", type).replace("{id}", id),
      resolved: (type: string, title: string) =>
        str("menuTargetResolved", "{type}: {title}").replace("{type}", type).replace("{title}", title),
      noTarget: str("menuTargetNone", "No target chosen yet."),
      blogsFromArticles: str("menuTargetBlogsNote", ""),
    };
  }, [t]);

  const renderField = (node: MenuEditorNode) => {
    const linkId = node.id ? linkGidForNode(node.id) : null;
    const row = linkId ? ((linkTranslations || {})[linkId] as LinkTranslationDTO | undefined) : undefined;
    const primaryTitle = node.title;
    const canTranslate = !!linkId && !!row?.translatable && !singleLocaleHint;
    const editable = isPrimary || canTranslate;
    const value = isPrimary ? node.title : linkId ? valueFor(activeLocale, linkId) : "";
    const problem = problemByKey[node.key];

    // The app's two translation-state colours, same classes as everywhere
    // else: BLUE on a primary field whose translation is missing somewhere,
    // YELLOW on a foreign field that has no value yet. A brand-new item has
    // neither — it has no Link resource until it is saved.
    const missingSomewhere =
      !!linkId && foreignLocales.some((locale) => isMissingIn(locale, linkId));
    const background = isPrimary
      ? missingSomewhere
        ? "bg-missing-translation"
        : "bg-white"
      : linkId && isMissingIn(activeLocale, linkId)
        ? "bg-untranslated"
        : "bg-white";

    return (
      <div className={`ai-editable-field-wrapper ${background}`}>
        <TextField
          label={
            <Text as="span" variant="bodySm">
              {isPrimary ? (node.id ? primaryTitle || t.content?.menuNewItem : t.content?.menuNewItem) : primaryTitle}
            </Text>
          }
          value={value}
          onChange={(next) => {
            if (!editable) return;
            if (isPrimary) {
              setTree(updateNode(tree, node.key, { title: next }));
              return;
            }
            if (!linkId) return;
            setDraftValue(activeLocale, linkId, next);
          }}
          placeholder={isPrimary ? undefined : primaryTitle}
          disabled={!editable}
          error={problem && problem !== "missingTarget" ? problemMessage(problem) : undefined}
          helpText={
            // A brand-new item cannot be translated yet: its Link resource
            // does not exist until Shopify has created the item. Said in
            // place, because an empty disabled field explains nothing.
            !isPrimary && !node.id
              ? t.content?.menuTranslateAfterSave
              : !isPrimary && (!linkId || !row?.translatable)
                ? linkSweepTruncated
                  ? t.content?.menuListIncomplete
                  : t.content?.menuNotTranslatable
                : undefined
          }
          autoComplete="off"
        />
      </div>
    );
  };

  /**
   * Where the item POINTS — the row's second box, beside the name.
   *
   * On the primary language ONLY, and that is not a layout decision: a target
   * is one link for every language, so a foreign tab that could change it
   * would be retargeting the whole shop's navigation from a translation
   * screen. Returning null is how the row learns it has one box, not two.
   */
  const renderTarget = (node: MenuEditorNode) => {
    if (!isPrimary) return null;
    const problem = problemByKey[node.key];
    return (
      <MenuTargetPicker
        type={node.type}
        url={node.url}
        resourceId={node.resourceId}
        targetTitles={targetTitles ?? {}}
        onChange={(patch) => setTree(updateNode(tree, node.key, patch))}
        error={problem === "missingTarget" ? t.content?.menuTargetRequired : undefined}
        strings={targetPickerStrings}
      />
    );
  };

  /** The per-item translate / copy pair. */
  const renderRowActions = (node: MenuEditorNode) => {
    const linkId = node.id ? linkGidForNode(node.id) : null;
    if (!linkId) return null;
    const row = (linkTranslations || {})[linkId] as LinkTranslationDTO | undefined;
    if (!row?.translatable) return null;

    const item: FlatMenuItem = {
      menuItemId: node.id as string,
      linkId,
      title: node.title,
      depth: 1,
      path: [1],
    };
    const primaryTitle = node.title;
    const canTranslate = !singleLocaleHint;
    const busy = busyLinkIds.has(linkId) || isAutoSaving(linkId);
    // An unsaved title change blocks this item's pair: the source would be the
    // OLD text (the new one is not stored yet), and saving afterwards would
    // purge exactly the translation the button just produced.
    const pendingRename = !!node.id && (baseTitleById[node.id] ?? "") !== node.title;
    const actionHint =
      singleLocaleHint ??
      (pendingRename
        ? t.content?.menuSaveRenameFirst
        : isPrimary
          ? allTargetsOffHint
          : undefined);
    const blocked = !canTranslate || pendingRename || !!(isPrimary && allTargetsOffHint);

    return (
      <>
        <DisabledActionTooltip hint={actionHint}>
          <Button
            size="slim"
            loading={busy}
            disabled={blocked || !primaryTitle.trim() || busy}
            onClick={() =>
              isPrimary ? translateToAll(item, primaryTitle) : translateFromPrimary(item, primaryTitle)
            }
          >
            🌍 {isPrimary ? t.content?.menuTranslateAll : t.content?.menuTranslateFromPrimary}
          </Button>
        </DisabledActionTooltip>
        <DisabledActionTooltip hint={actionHint}>
          <Button
            size="slim"
            disabled={blocked || !primaryTitle.trim() || busy}
            onClick={() => (isPrimary ? copyToAll(item, primaryTitle) : copyFromPrimary(item, primaryTitle))}
          >
            📋 {isPrimary ? t.content?.menuCopyAll : t.content?.menuCopyFromPrimary}
          </Button>
        </DisabledActionTooltip>
      </>
    );
  };

  /** One message per validation code — the field says what is wrong, in place. */
  const problemMessage = (code: string): string | undefined => {
    switch (code) {
      case "emptyTitle":
        return t.content?.menuTitleRequired;
      case "missingTarget":
        return t.content?.menuTargetRequired;
      case "tooDeep":
        return t.content?.menuMaxDepthReached;
      default:
        return t.content?.menuItemInvalid;
    }
  };

  /**
   * Deleting the whole menu.
   *
   * The same hook, dialog and server path as every other content delete —
   * including the two-step confirmation that makes the merchant type the
   * name. A menu is exactly the case that guard exists for: it takes every
   * item with it, and each item's translations go with its Link resource for
   * good (measured — re-creating the item mints a new id, so the values do
   * not come back).
   *
   * On success the selection moves to another menu rather than staying on a
   * GID that no longer exists, and the loader is re-read.
   */
  const deleteMenu = useDeleteItem({
    onDeleted: () => {
      setSelectedMenuId(
        (parsedMenus as Array<{ id: string }>).find((m) => m.id !== selectedMenuId)?.id ?? null,
      );
      revalidator.revalidate();
    },
  });

  /** The tree write's outcome, or undefined when the last save had none. */
  const treeStatus = treeResult?.status;

  /** The change list over the save button, in the merchant's own words. */
  const treeSummary = useMemo(() => {
    if (!treeChanged) return null;
    const parts: string[] = [];
    const say = (key: string | undefined, count: number) => {
      if (count > 0 && key) parts.push(key.replace("{count}", String(count)));
    };
    say(t.content?.menuTreeRenamed, treeDiff.renamed.length);
    say(t.content?.menuTreeMoved, treeDiff.reparented.length);
    say(t.content?.menuTreeReordered, treeDiff.reordered.length);
    say(t.content?.menuTreeRetargeted, treeDiff.retargeted.length);
    say(t.content?.menuTreeCreated, treeDiff.created.length);
    say(t.content?.menuTreeDeleted, treeDiff.deleted.length);
    return (t.content?.menuTreeSummary || "{count}: {detail}")
      .replace("{count}", String(treeChangeCount))
      .replace("{detail}", parts.join(", "));
  }, [treeChanged, treeChangeCount, treeDiff, t]);

  /** A failure has to name the item to be actionable — an id tail is not one. */
  const titleForLink = useCallback(
    (linkId: string): string => {
      for (const menu of parsedMenus) {
        const hit = (menu.flat as FlatMenuItem[]).find((i) => i.linkId === linkId);
        if (hit) return hit.title;
      }
      return linkId.split("/").pop() ?? linkId;
    },
    [parsedMenus],
  );

  /** A link is busy while its auto-save is in flight — `autoPending` holds it
   *  from submit until the loader carries the value, which is exactly that
   *  window. No extra state to keep in sync. */
  const isAutoSaving = useCallback(
    (linkId: string): boolean => Object.values(autoPending).some((byLink) => linkId in byLink),
    [autoPending],
  );

  // Both save paths report into the same banner: a failure from a per-entry
  // button is no less important than one from the save bar.
  const failures = [...(fetcher.data?.failures ?? []), ...autoFailures];
  const saveError = fetcher.data?.error ?? autoError;

  return (
    <PlanAccessGate contentType="menus">
      <Page fullWidth>
        {/* The native Shopify save bar, not an in-page button: App Bridge
            projects it above the embedded app and it is what "Built for
            Shopify" requires in place of a custom save control. */}
        <AppSaveBar
          hasChanges={changeCount > 0}
          onSave={onSave}
          onDiscard={onDiscard}
          loading={isSaving}
          saveText={t.content?.save}
          discardText={t.content?.discard}
        />
        {/* The frame every Polaris page in this app uses. `.app-page-content`
            is what makes responsive.css zero Polaris' own Page/Page__Content
            inset (0 24px sides, 20px top, 8px bottom) and own the single
            gutter via --app-page-padding instead. Without the class those
            rules do not match, so this page was rendering Polaris' asymmetric
            inset PLUS a hardcoded 1rem of its own — visibly more padding than
            anywhere else. The width class caps the FRAME, adds no padding of
            its own, and <Page fullWidth> has to stay or Polaris' ~1000px cap
            wins first. `-start` rather than `-full`: this page has no item
            sidebar, so nothing else stops the right column from growing on a
            wide screen — capped at the item column PLUS the shared reading
            width, left-aligned so the item column stays flush with the gutter.

            The frame also owns the height, which retires the viewport calc
            this page used to do by hand. `.app-page-content > *` makes its
            SINGLE child the scroll container, so the flex row below is that
            one child. */}
        <div className="app-page-content app-page-width-start">
          <div style={{ display: "flex", gap: "var(--app-page-padding)", minHeight: 0, overflow: "hidden" }}>
            {/* The shared item column, not a hand-built one. Two things came with
                the bespoke version and both were bugs: it was invisible to the
                mobile navbar selector (see registerItems above), and it hardcoded
                its own list chrome instead of the search, sorting and pagination
                every other content tab has. UnifiedItemList owns its own width
                token, so none is set here. `desktop-only` is what hands the list
                over to the navbar below 900px. */}
            <div className="desktop-only" style={{ flexShrink: 0, height: "100%" }}>
              <UnifiedItemList
                items={selectorItems}
                selectedItemId={selectedMenuId}
                onItemSelect={setSelectedMenuId}
                resourceName={{
                  singular: t.content?.menu || "Menu",
                  plural: t.content?.menus || "Menus",
                }}
                searchPlaceholder={t.content?.searchPlaceholder}
                sortOptions={[{ field: "title", label: t.content?.title || "Title" }]}
                t={{
                  searchPlaceholder: t.content?.searchPlaceholder,
                  paginationOf: t.content?.paginationOf || "of",
                  paginationPrevious: t.content?.paginationPrevious || "Previous",
                  paginationNext: t.content?.paginationNext || "Next",
                  sortTooltip: t.content?.sortTooltip,
                  noItemsFound: t.content?.noEntries,
                }}
              />
            </div>

            {/* Right: the selected menu's items, in the active language */}
            <div style={{ flex: 1, overflow: "auto", minWidth: 0 }}>
              <BlockStack gap="400">
              {error && (
                <Banner title={t.content?.error || "Error"} tone="critical">
                  <p>{error}</p>
                </Banner>
              )}

              {/* The app's standard language bar, in its OWN card above the
                  content — the same shape every other content page has. It
                  disappears entirely on a single-language shop (one permanently
                  active button is noise, not a choice), and `shouldRenderLanguageBar`
                  is what keeps the card from staying behind as an empty box. */}
              {shouldRenderLanguageBar({ localeCount: localeList.length }) && (
                <Card padding="400">
                  <UnifiedLanguageBar
                    shopLocales={localeList as ShopLocale[]}
                    currentLanguage={activeLocale}
                    primaryLocale={primaryLocale}
                    selectedItem={languageBarItem}
                    contentType={"menus" as ContentType}
                    hasChanges={changeCount > 0}
                    onLanguageChange={setActiveLocale}
                    enabledLanguages={enabledLanguages}
                    onToggleLanguage={toggleLanguage}
                    showTranslateAll={false}
                    showReloadButton={false}
                    t={{ primaryLocaleSuffix: t.content?.primaryLanguageSuffix }}
                  />
                </Card>
              )}

              {/* The operations row every content page has: what happens to
                  the TEXT on the left, what happens to the MENU on the right,
                  in its own card between the language bar and the content —
                  the same three-card rhythm as UnifiedContentEditor. */}
              {selectedMenu && (
                <Card padding="400">
                  <InlineStack align="space-between" blockAlign="center" gap="300">
                    <InlineStack gap="200" blockAlign="center">
                      <DisabledActionTooltip hint={singleLocaleHint ?? (isPrimary ? allTargetsOffHint : undefined)}>
                        <Button
                          size="slim"
                          loading={bulkBusy}
                          disabled={bulkBusy || !!singleLocaleHint || !!(isPrimary && allTargetsOffHint)}
                          onClick={() => void translateWholeMenu()}
                        >
                          {bulkBusy
                            ? (t.content?.translating || "…")
                            : (t.content?.translateAll || "🌍 Translate All")}
                        </Button>
                      </DisabledActionTooltip>
                      <DisabledActionTooltip hint={singleLocaleHint}>
                        <Button size="slim" tone="critical" disabled={!!singleLocaleHint} onClick={clearWholeMenu}>
                          🗑️ {t.content?.clearAll || "Clear All"}
                        </Button>
                      </DisabledActionTooltip>
                    </InlineStack>

                    <InlineStack gap="200" blockAlign="center">
                      {isPrimary && (
                        <Button
                          size="slim"
                          onClick={() => {
                            newNodeSeq.current += 1;
                            setTree(appendNode(tree, newMenuNode(newNodeSeq.current)));
                          }}
                        >
                          {t.content?.menuAddItem}
                        </Button>
                      )}
                      {/* Reload is a REVALIDATION here, not a per-item sync
                          endpoint: the loader re-reads every menu from Shopify
                          on each run, so re-running it IS the reload — and it
                          keeps unsaved drafts, which a page reload would not. */}
                      <Tooltip content={t.content?.menuReload || "Reload"}>
                        <Button
                          size="slim"
                          icon={RefreshIcon}
                          accessibilityLabel={t.content?.menuReload || "Reload"}
                          loading={revalidator.state !== "idle"}
                          onClick={() => revalidator.revalidate()}
                        />
                      </Tooltip>
                      {/* The bar's own ❓, at the far right: five buttons whose
                          scopes differ (one item, every item, this language,
                          every language) and whose costs differ — a merchant
                          should be able to read what "clear all" empties
                          BEFORE pressing it, not from the undo they do not
                          have. */}
                      <HelpTooltip helpKey="menuActionBar" position="below" />
                      {/* The whole menu. Last in the row and the only critical
                          control in it — and only on the primary language,
                          because deleting a menu from a translation tab is not
                          a translation act. */}
                      {isPrimary && (
                        <Button
                          size="slim"
                          tone="critical"
                          variant="tertiary"
                          onClick={() =>
                            deleteMenu.request({
                              id: selectedMenu.id,
                              title: selectedMenu.title,
                              resource: "menu",
                            })
                          }
                        >
                          {t.content?.menuDeleteMenu || "Delete menu"}
                        </Button>
                      )}
                    </InlineStack>
                  </InlineStack>
                </Card>
              )}

              <Card>
                {selectedMenu ? (
                  <BlockStack gap="500">
                    {foreignLocales.length === 0 && (
                      <Banner tone="info">
                        <p>{t.content?.menuNeedsSecondLanguage}</p>
                      </Banner>
                    )}

                    {/* Said, never silent. The reload brought a tree that no
                        longer matches what the merchant's unsaved edits were
                        made against, so those edits were dropped — keeping
                        them would have written a deletion of somebody else's
                        item. Losing work without being told is the one thing
                        worse than losing it. */}
                    {droppedDraftMenus.length > 0 && (
                      <Banner
                        tone="warning"
                        onDismiss={() => setDroppedDraftMenus([])}
                      >
                        <p>
                          {(t.content?.menuDraftDropped || "{menus}").replace(
                            "{menus}",
                            droppedDraftMenus.join(", "),
                          )}
                        </p>
                      </Banner>
                    )}

                    {/* The drift refusal. It is not a failure of the merchant's
                        edit — nothing was written and their draft is untouched —
                        so it offers the one action that resolves it instead of
                        asking them to reload the browser (which would throw the
                        draft away). */}
                    {treeStatus === "structureChanged" && (
                      <Banner
                        tone="warning"
                        action={{
                          content: t.content?.menuReloadAndRetry || "Reload",
                          onAction: () => revalidator.revalidate(),
                          loading: revalidator.state !== "idle",
                        }}
                      >
                        <BlockStack gap="100">
                          <Text as="p">{t.content?.menuTreeDriftIntro}</Text>
                          {/* Named, not counted: "the menu changed" does not
                              tell a merchant whether reloading costs them
                              anything. */}
                          {(treeResult?.foreignChanges?.renamed ?? []).map((r, i) => (
                            <Text as="p" variant="bodySm" key={`r${i}`}>
                              {r.from} → {r.to}
                            </Text>
                          ))}
                          {[
                            ...(treeResult?.foreignChanges?.added ?? []),
                            ...(treeResult?.foreignChanges?.removed ?? []),
                            ...(treeResult?.foreignChanges?.moved ?? []),
                            ...(treeResult?.foreignChanges?.retargeted ?? []),
                          ].map((title, i) => (
                            <Text as="p" variant="bodySm" key={`o${i}`}>
                              {title}
                            </Text>
                          ))}
                        </BlockStack>
                      </Banner>
                    )}

                    {/* Every other tree status. They share one banner because
                        they share one consequence — nothing was written — and
                        the server's own message says which one it was. */}
                    {treeStatus && treeStatus !== "ok" && treeStatus !== "structureChanged" && (
                      <Banner tone="critical">
                        <p>
                          {`${t.content?.menuTreeSaveFailed ?? ""} ${treeResult?.message ?? ""}`.trim()}
                        </p>
                      </Banner>
                    )}

                    {/* The rail the write path exists to keep unfired: if
                        Shopify ever mints new MenuItem ids on an update, those
                        items' translations are stranded on the old ids and
                        nothing but this line can tell the merchant. */}
                    {(treeResult?.reassignedItemIds?.length ?? 0) > 0 && (
                      <Banner tone="critical">
                        <p>{t.content?.menuRenameIdsReassigned}</p>
                      </Banner>
                    )}

                    {/* Measured: re-parenting destroys an item's translations
                        and its whole branch's. The save puts them back; when
                        one could not be restored, that is the merchant's to
                        know rather than ours to bury in a log. */}
                    {(treeResult?.translationRepair?.failed?.length ?? 0) > 0 && (
                      <Banner tone="critical">
                        <p>
                          {(t.content?.menuTreeRepairFailed || "").replace(
                            "{count}",
                            String(treeResult?.translationRepair?.failed?.length ?? 0),
                          )}
                        </p>
                      </Banner>
                    )}

                    {/* The SUCCESSFUL repair says nothing a merchant can act
                        on: their translations are where they left them, which
                        is what they expected. Only the FAILED one above is
                        news. (The restore itself is logged server-side.) */}

                    {(treeResult?.purgedTranslationCount ?? 0) > 0 && (
                      <Banner tone="info">
                        <p>
                          {(t.content?.menuRenamePurgedTranslations || "").replace(
                            "{count}",
                            String(treeResult?.purgedTranslationCount ?? 0),
                          )}
                        </p>
                      </Banner>
                    )}

                    {/* Pending work, said before the save rather than after:
                        what is about to change, and — separately and louder —
                        what is about to be deleted. */}
                    {treeSummary && (
                      <Banner tone="info">
                        <p>{treeSummary}</p>
                      </Banner>
                    )}

                    {treeDiff.deleted.length > 0 && (
                      <Banner tone="warning">
                        <p>
                          {(t.content?.menuDeleteWarning || "").replace(
                            "{count}",
                            String(treeDiff.deleted.length),
                          )}
                        </p>
                      </Banner>
                    )}

                    {(treeProblems.length > 0 || (treeResult?.problems?.length ?? 0) > 0) && (
                      <Banner tone="critical">
                        <BlockStack gap="100">
                          <Text as="p">{t.content?.menuTreeInvalid}</Text>
                          {/* The server's own refusal names items too — it
                              validates the tree again against Shopify's fresh
                              read, and a problem only it can see (an id that
                              vanished) would otherwise render as a bare
                              "could not be saved". */}
                          {(treeResult?.problems ?? []).map((p, index) => (
                            <Text as="p" variant="bodySm" key={`${index}-${p.key}`}>
                              {p.title || p.key}: {problemMessage(p.code)}
                            </Text>
                          ))}
                        </BlockStack>
                      </Banner>
                    )}

                    {linkSweepTruncated && (
                      <Banner tone="warning">
                        <p>{t.content?.menuListIncomplete}</p>
                      </Banner>
                    )}

                    {translateError && (
                      <Banner tone="critical">
                        <p>
                          {t.content?.menuTranslateFailed} {translateError}
                        </p>
                      </Banner>
                    )}

                    {!!fetcher.data?.deferred && (
                      <Banner tone="warning">
                        <p>{t.content?.menuSaveDeferred}</p>
                      </Banner>
                    )}

                    {failures.length > 0 && (
                      <Banner tone="critical">
                        <BlockStack gap="100">
                          <Text as="p">{t.content?.menuSaveFailed}</Text>
                          {/* Indexed: the same locale/link can legitimately
                              appear from both save paths, and a shared React
                              key would collapse them into one warning-emitting
                              row. */}
                          {failures.map((f, index) => (
                            <Text as="p" variant="bodySm" key={`${index}-${f.locale}-${f.linkId}`}>
                              {titleForLink(f.linkId)} ({f.locale}): {f.message}
                            </Text>
                          ))}
                        </BlockStack>
                      </Banner>
                    )}

                    {/* Every failure mode of the action reaches the merchant.
                        Reporting only the gated one made a 502 from the digest
                        re-read look like a Save button that does nothing. */}
                    {saveError && (
                      <Banner tone="critical">
                        <p>
                          {saveError === "gated"
                            ? t.content?.upgradeRequired || "Upgrade required"
                            : `${t.content?.menuSaveFailed ?? ""} ${saveError}`.trim()}
                        </p>
                      </Banner>
                    )}

                    <MenuTreeEditor
                      nodes={tree}
                      onChange={setTree}
                      // Structure is edited in the PRIMARY language only. It is
                      // language-independent in Shopify, but a delete pressed on
                      // a French tab removes the item from every language, and an
                      // item ADDED there cannot be named — its title field is a
                      // translation of a primary value that does not exist yet.
                      structureLocked={!isPrimary}
                      renderField={renderField}
                      renderTarget={renderTarget}
                      renderActions={renderRowActions}
                      onDelete={(node) => setTree(removeNode(tree, node.key))}
                      onAddChild={(node) => {
                        // A child is appended to the node the merchant pressed
                        // on; the top-level button below adds a sibling at the
                        // end. Both mint their key from a counter, never from
                        // the title.
                        newNodeSeq.current += 1;
                        const child = newMenuNode(newNodeSeq.current);
                        setTree(
                          updateNode(tree, node.key, {}).map(function graft(n): MenuEditorNode {
                            if (n.key === node.key) return { ...n, children: [...(n.children ?? []), child] };
                            return { ...n, children: (n.children ?? []).map(graft) };
                          }),
                        );
                      }}
                      strings={{
                        dragHandle: t.content?.menuDragHandle || "Move",
                        addChild: t.content?.menuAddChild || "Sub-item",
                        deleteItem: t.content?.menuDeleteItem || "Delete",
                        maxDepthReached: t.content?.menuMaxDepthReached || "Three levels",
                      }}
                    />

                  </BlockStack>
                ) : (
                  <div style={{ textAlign: "center", padding: "4rem 2rem" }}>
                    <Text as="p" variant="headingLg" tone="subdued">
                      {t.content?.selectFromList || "Select a menu from the list"}
                    </Text>
                  </div>
                )}
              </Card>
              </BlockStack>
            </div>
          </div>
        </div>
      </Page>

      {deleteMenu.target && (
        <DeleteItemModal
          open={!!deleteMenu.target}
          onClose={deleteMenu.cancel}
          item={deleteMenu.target}
          onConfirm={deleteMenu.confirm}
          deleting={deleteMenu.deleting}
          error={deleteMenu.error}
          t={t.content?.deleteModal}
        />
      )}
    </PlanAccessGate>
  );
}
