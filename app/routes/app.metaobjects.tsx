/**
 * Metaobjects — entries of every metaobject definition in the shop.
 *
 * The item LIST stays the list of TYPES, deliberately (PLAN_METAOBJECTS_EDITOR
 * §4.1): types are two-digit, entries can be four-digit, and `?select=`,
 * `registerItems` (mobile) and the product editor's deep links all hang off the
 * type level. The EDITOR area is where an entry became an object: one card per
 * entry, with every field this app can honestly edit, a delete button that says
 * what it would cost, and a swatch where the type describes a colour.
 *
 * Four defects this page carried are fixed here rather than worked around:
 *
 * - Only the first 25 entries of a type were ever shown while the header said
 *   how many there really are: the API accepted `page`/`limit`/`search` from the
 *   start and the page called it without any of them. Now it drives them, and
 *   the editor's own search + pagination strip renders them.
 * - Creating an entry asked for the type again although one is selected, and
 *   then did not show the new entry. Now the type is prefilled and the list
 *   reloads FOCUSED on the new entry — unless the cache sync failed, in which
 *   case jumping to it would land on nothing and the banner says so instead.
 * - The type row offered Delete and Duplicate. A type is not a deletable
 *   object; the buttons are gone from it and the delete lives per entry.
 * - The entries stood in their cards and their COLOURS stood somewhere else:
 *   a colour, a file reference and a taxonomy reference carry
 *   `translationKey: "" + supportsTranslation: false` -- one value per SHOP,
 *   not per locale -- which is the exact shape `isAttributeField` reads as a
 *   merchandising attribute, so the editor routed them into the page-wide
 *   "Details" card at the bottom. The page then showed the entries and, far
 *   below them, a flat list of every entry's colour. `groupId` now vetoes that
 *   routing (content-attributes.shared.ts): a field that names a group renders
 *   in that group's card, and the header swatch below finally finds a control
 *   to open.
 *
 * `?select=` accepts an ENTRY GID and resolves it to its type SERVER-side
 * (§8): the client list only holds types, so an entry id matched nothing and
 * the deep link from the product editor opened a blank page.
 */

import { useEffect, useState, useMemo, useRef, useCallback } from "react";
import { type ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useRevalidator, useSearchParams } from "react-router";
import {
  resolveMetaobjectSelection,
  type MetaobjectTypeItem,
} from "../services/metaobject-select.shared";
import { authenticate } from "../shopify.server";
import { UnifiedContentEditor } from "../components/UnifiedContentEditor";
import { useUnifiedContentEditor } from "../hooks/useUnifiedContentEditor";
import { handleUnifiedContentActions } from "../actions/unified-content.actions";
import { METAOBJECTS_CONFIG } from "../config/content-fields.config";
import { useI18n } from "../contexts/I18nContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { PlanAccessGate } from "../components/PlanAccessGate";
import { MetaobjectEntryCard, type MetaobjectEntryUsage } from "../components/metaobjects/MetaobjectEntryCard";
import { DeleteItemModal } from "../components/create/DeleteItemModal";
import { useDeleteItem } from "../hooks/useDeleteItem";
import type { ContentItem, RenderedGroupField } from "../types/content-editor.types";
import { measurePageLoad } from "~/utils/performance.client";
import { createContentLoader } from "~/utils/loader-factory.server";
import { logger } from "~/utils/logger.server";
import type { FetcherData } from "~/types/content-editor.types";
import {
  metaobjectFieldSpecs,
  metaobjectWriteAccess,
  type MetaobjectDefinitionFieldLike,
  type MetaobjectEntryLike,
} from "~/services/metaobject-fields.shared";
import type { MetaobjectUsage } from "~/services/metaobject-usage.server";

/** Entries per page of the editor area. Matches the API's own default. */
const ENTRY_PAGE_SIZE = 25;

// ============================================================================
// LOADER - Load metaobject types (entries are lazy-loaded per type)
// ============================================================================

export const loader = createContentLoader({
  logPrefix: "METAOBJECTS",
  resourceType: "Metaobject",
  itemsKey: "metaobjects",

  async loadData(ctx) {
    const { db } = await import("../db.server");

    // LAZY LOADING: Load navigation metadata (type list) from DB
    const definitions = await db.metaobjectDefinition.findMany({
      where: {
        shop: ctx.session.shop
      },
      orderBy: {
        name: 'asc'
      }
    });

    if (definitions.length === 0) {
      return { items: [], ids: [] };
    }

    // One count query for ALL types instead of one per type: a shop with 40
    // definitions used to spend 40 round trips on a number in a subtitle.
    const counts = await db.metaobject.groupBy({
      by: ["type"],
      where: { shop: ctx.session.shop },
      _count: { _all: true },
    });
    const countByType = new Map(counts.map((c) => [c.type, c._count._all]));

    const metaobjectTypes = definitions.map((definition) => ({
      id: `metaobject_type_${definition.type}`,
      type: definition.type,
      title: definition.name,
      handle: definition.type,
      definitionName: definition.name,
      definitionId: definition.id,
      role: "METAOBJECT_TYPE",
      contentCount: countByType.get(definition.type) ?? 0,
      metaobjects: [], // Empty - loaded on demand via /api/metaobjects/<type>
      translations: [], // Empty - loaded on demand
    }));

    logger.debug('[METAOBJECTS-LOADER] Type list built', {
      types: metaobjectTypes.length,
      shop: ctx.session.shop,
    });

    // A `?select=` carrying a Metaobject GID -- what the product editor sends
    // for a linked option value -- names an ENTRY, and this page's items are
    // TYPES (`metaobject_type_<type>`). Only the server can bridge that: the
    // cache knows which type an entry belongs to. Resolved here so the client
    // has an id it can actually match, instead of a GID that matches nothing.
    let selectedType: string | undefined;
    const select = new URL(ctx.request.url).searchParams.get("select") ?? "";
    if (select.startsWith("gid://shopify/Metaobject/")) {
      try {
        const entry = await db.metaobject.findFirst({
          where: { shop: ctx.session.shop, id: select },
          select: { type: true },
        });
        selectedType = entry?.type ?? undefined;
      } catch {
        // An unresolvable id is a page that opens where it usually does, which
        // is what happened before this link existed.
        selectedType = undefined;
      }
    }

    return {
      items: metaobjectTypes,
      ids: metaobjectTypes.map((t) => t.id),
      selectedType,
      // The ENTRY, not just its type: the editor area lists entry cards, so a
      // deep link can open on the card itself rather than merely on the right
      // type. Null when the id resolved to nothing — a missed preselection,
      // never a wrong one.
      selectedEntryId: selectedType ? select : null,
    };
  },
});

// ============================================================================
// ACTION - Handle all actions via unified handler
// ============================================================================

export const action = async (args: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(args.request);
  const formData = await args.request.formData();

  // Load AI settings
  const { db } = await import("../db.server");
  const [aiSettings, aiInstructions] = await Promise.all([
    db.aISettings.findUnique({ where: { shop: session.shop } }),
    db.aIInstructions.findUnique({ where: { shop: session.shop } }),
  ]);

  // Use unified action handler
  return handleUnifiedContentActions({
    admin,
    session,
    formData,
    contentConfig: METAOBJECTS_CONFIG,
    db,
    aiSettings,
    aiInstructions,
  });
};

// ============================================================================
// COMPONENT
// ============================================================================

interface LoadedEntries {
  id: string;
  /** The DEFINITION's Shopify GID. The `id` above is the pseudo type row. */
  definitionId?: string;
  definitionName?: string;
  metaobjects: MetaobjectEntryLike[];
  fieldDefinitions?: MetaobjectDefinitionFieldLike[];
  adminAccess?: string | null;
  filePreviews?: Record<string, string>;
  translations: Array<{ key: string; value: string; locale: string }>;
  marketTranslations?: Record<string, Record<string, Record<string, string>>>;
  contentCount?: number;
  pagination?: {
    page: number;
    limit: number;
    totalCount: number;
    totalPages: number;
    search: string;
  };
}

export default function MetaobjectsPage() {
  const {
    metaobjects,
    shopLocales,
    primaryLocale,
    markets,
    error,
    // The type `?select=` resolved to, when it carried an entry GID. NOT the
    // type currently selected — that one follows the merchant's clicks and is
    // derived below.
    selectedType: preselectedType,
    selectedEntryId,
    // The loader factory's generic widens whatever `loadData` adds beyond
    // `items`/`ids`, so the two resolved fields are named here rather than
    // being carried as `unknown` into every consumer.
  } = useLoaderData<typeof loader>() as ReturnType<typeof useLoaderData<typeof loader>> & {
    selectedType?: string;
    selectedEntryId?: string | null;
  };
  const fetcher = useFetcher<FetcherData>();
  const entryFetcher = useFetcher<{ success?: boolean; error?: string; metaobject?: LoadedEntries }>();
  const usageFetcher = useFetcher<{ success?: boolean; usage?: Record<string, MetaobjectUsage> }>();
  const revalidator = useRevalidator();
  const { t } = useI18n();
  const { showInfoBox } = useInfoBox();
  const { handleNavigate } = useAppNavigation();
  const [searchParams] = useSearchParams();

  /** Entries of the CURRENT type/page/search — replaced on every load. */
  const [loaded, setLoaded] = useState<LoadedEntries | null>(null);
  const [entryPage, setEntryPage] = useState(1);
  const [entrySearch, setEntrySearch] = useState("");
  /** The entry to land on: a deep link, or the one just created. */
  const [focusEntryId, setFocusEntryId] = useState<string | null>(selectedEntryId ?? null);
  /**
   * The entry created in THIS session, which is a different thing from the one
   * being scrolled to: a deep link from the product editor also focuses an
   * entry, and badging it "Just created" would state something untrue about an
   * entry that may be years old.
   */
  const [justCreatedId, setJustCreatedId] = useState<string | null>(null);
  const [usage, setUsage] = useState<Record<string, MetaobjectUsage>>({});
  const [entryError, setEntryError] = useState<string | null>(null);
  /** What is currently in flight, so a stale response cannot overwrite a newer one. */
  const requestedRef = useRef<string | null>(null);
  /** Bumped to force a re-fetch of a request that is otherwise identical. */
  const [reloadNonce, setReloadNonce] = useState(0);

  // The selected type's item, augmented with whatever the entry loader
  // returned. Only the SELECTED type carries entries — the others are the
  // navigation rows they always were.
  const augmentedMetaobjects = useMemo(() => {
    return metaobjects.map((item: Record<string, unknown>) => {
      if (!loaded || loaded.id !== item.id) return item;
      return {
        ...item,
        metaobjects: loaded.metaobjects,
        fieldDefinitions: loaded.fieldDefinitions,
        filePreviews: loaded.filePreviews,
        translations: loaded.translations,
        marketTranslations: loaded.marketTranslations,
        contentCount: loaded.contentCount ?? item.contentCount,
      };
    });
  }, [metaobjects, loaded]);

  // Resolve ?select= URL param to an initial item ID (e.g. linked from product options)
  // `selectedType` is set by the loader when `?select=` carried a Metaobject GID.
  const selectParam = searchParams.get("select");
  const initialItemId = useMemo(
    // The rule lives in its own module because it is not testable inline —
    // which is how it shipped wrong. See `metaobject-select.shared.ts`.
    () => resolveMetaobjectSelection(metaobjects as MetaobjectTypeItem[], selectParam, preselectedType),
    [selectParam, preselectedType, metaobjects],
  );

  const editor = useUnifiedContentEditor({
    config: METAOBJECTS_CONFIG,
    items: augmentedMetaobjects as unknown as ContentItem[],
    shopLocales,
    primaryLocale,
    markets,
    fetcher,
    showInfoBox,
    t,
    initialItemId,
  });

  const selectedItemId = editor.state.selectedItemId;
  const selectedType = useMemo(() => {
    const item = metaobjects.find((m: { id: string; type?: string }) => m.id === selectedItemId);
    return item?.type ?? null;
  }, [metaobjects, selectedItemId]);

  // A different type is a different list: page and search belong to the list
  // being looked at, not to the page. Carrying them across would show "page 3
  // of 1" and an empty result the merchant did not ask for.
  const prevTypeRef = useRef<string | null>(selectedType);
  useEffect(() => {
    if (prevTypeRef.current === selectedType) return;
    prevTypeRef.current = selectedType;
    setEntryPage(1);
    setEntrySearch("");
    setLoaded(null);
    setUsage({});
    setEntryError(null);
    setJustCreatedId(null);
  }, [selectedType]);

  // ── Load the selected type's entries ────────────────────────────────────
  const requestKey = selectedType
    ? `${selectedType}::${entryPage}::${entrySearch}::${focusEntryId ?? ""}::${reloadNonce}`
    : null;

  useEffect(() => {
    if (!selectedType || !requestKey) return;
    if (requestedRef.current === requestKey) return;
    requestedRef.current = requestKey;
    setEntryError(null);
    const params = new URLSearchParams({
      page: String(entryPage),
      limit: String(ENTRY_PAGE_SIZE),
    });
    if (entrySearch) params.set("search", entrySearch);
    if (focusEntryId) params.set("focus", focusEntryId);
    entryFetcher.load(`/api/metaobjects/${encodeURIComponent(selectedType)}?${params.toString()}`);
    // entryFetcher is intentionally not a dependency — its identity changes on
    // every state transition and the effect would re-fire mid-flight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedType, requestKey, entryPage, entrySearch, focusEntryId, reloadNonce]);

  useEffect(() => {
    if (entryFetcher.state !== "idle" || !entryFetcher.data) return;
    const data = entryFetcher.data;
    if (data.success === false || !data.metaobject) {
      // A FAILED load is not "this type has no entries" — the cards would
      // otherwise report an empty type to a merchant who has fifty.
      setEntryError(typeof data.error === "string" ? data.error : "Could not load the entries of this type.");
      return;
    }
    setLoaded(data.metaobject);
    if (data.metaobject.pagination) setEntryPage(data.metaobject.pagination.page);
  }, [entryFetcher.state, entryFetcher.data]);

  // ── Usage, per visible entry (three-valued — see metaobject-usage.server) ─
  const visibleEntryIds = useMemo(
    () => (loaded?.metaobjects ?? []).map((m) => m.id),
    [loaded],
  );
  const usageKeyRef = useRef<string>("");
  useEffect(() => {
    if (visibleEntryIds.length === 0) return;
    const key = visibleEntryIds.join(",");
    if (usageKeyRef.current === key) return;
    usageKeyRef.current = key;
    usageFetcher.load(`/api/metaobject-usage?ids=${encodeURIComponent(key)}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleEntryIds]);

  useEffect(() => {
    if (usageFetcher.state !== "idle" || !usageFetcher.data?.success) return;
    setUsage((prev) => ({ ...prev, ...(usageFetcher.data?.usage ?? {}) }));
  }, [usageFetcher.state, usageFetcher.data]);

  /**
   * Reload the current type's entries — after a create or a delete.
   *
   * The nonce is what makes it a reload: the load effect keys on the request it
   * describes (type, page, search, focus), and after a delete none of those
   * change. Clearing the ref alone would not re-run the effect, and the entry
   * area would sit in its loading state until something else moved.
   */
  const reloadEntries = useCallback(() => {
    usageKeyRef.current = "";
    setLoaded(null);
    setReloadNonce((n) => n + 1);
  }, []);

  // ── Delete one entry ────────────────────────────────────────────────────
  const deleteItem = useDeleteItem({
    // The delete action refuses a still-referenced entry with a CODE; the
    // sentence lives in the three i18n files, not in the server.
    translateError: useCallback(
      (key: string) => {
        const value = (t.content as unknown as Record<string, unknown> | undefined)?.[key];
        return typeof value === "string" ? value : undefined;
      },
      [t],
    ),
    onDeleted: (target) => {
      showInfoBox(
        (t.content?.deletedMessage || "“{name}” was deleted.").replace("{name}", target.title || target.id),
        "success",
        t.content?.success || "Success!",
      );
      setFocusEntryId(null);
      // A deleted TYPE has no entries left to reload: asking the entry loader
      // for it would fetch an id that is gone. Only the page's own data is
      // revalidated, and the editor's existing "the selected item disappeared"
      // effect moves the selection to the first remaining type — re-selecting
      // here as well would be a second answer to the same question.
      if (target.resource === "metaobjectDefinition") {
        setLoaded(null);
        setUsage({});
        setEntryError(null);
        revalidator.revalidate();
        return;
      }
      reloadEntries();
      // The type row's entry COUNT lives in the page loader's data.
      revalidator.revalidate();
    },
  });

  // ── Create an entry of the selected type ────────────────────────────────
  const createPrefill = useMemo(
    () => (selectedType ? { type: selectedType } : undefined),
    [selectedType],
  );

  const handleItemCreated = useCallback(
    (info: { id: string; resource: string; synced: boolean }) => {
      if (info.resource !== "metaobject") return;
      // Not synced ⇒ the entry exists in Shopify but not in the cache, so it is
      // on no page of this list. Focusing it would ask the loader for an id it
      // cannot find; the create banner already offers a reload.
      if (!info.synced) return;
      setFocusEntryId(info.id);
      setJustCreatedId(info.id);
      setEntrySearch("");
      reloadEntries();
    },
    [reloadEntries],
  );

  // ── The entry cards ─────────────────────────────────────────────────────
  const entryById = useMemo(() => {
    const map = new Map<string, MetaobjectEntryLike>();
    for (const entry of loaded?.metaobjects ?? []) map.set(entry.id, entry);
    return map;
  }, [loaded]);

  /**
   * §7.2 — may this app write entries of the selected definition?
   *
   * "unknown" behaves exactly as the page did before this existed: nothing is
   * locked and nothing is promised. Only a definition Shopify KNOWN-refuses
   * locks the controls, and then the card says so instead of letting the
   * merchant type into fields whose save can only fail.
   */
  const writeAccess = useMemo(
    () => metaobjectWriteAccess(loaded?.adminAccess),
    [loaded],
  );

  /**
   * Deleting the whole TYPE — the definition, and with it every entry.
   *
   * The route supplies this because only the route has the definition's GID:
   * the item list's own id is the pseudo row `metaobject_type_<type>`, which is
   * not a Shopify object at all, and sending it is how this page once grew a
   * Delete that 400ed after the merchant had typed the name into the
   * confirmation.
   *
   * `disabledReason` is a STRING and always says why, never a bare greyed
   * button. Two reasons exist: the definition is not loaded yet (the page is
   * still fetching, so there is no id to delete), and Shopify refusing our
   * writes on this definition (§7.2) — which is not measured to cover
   * definition DELETES, so it is treated as "we do not know that we may" and
   * refuses rather than offering a destructive call on a guess.
   */
  const containerAction = useMemo(() => {
    if (!selectedType) return null;
    const definitionId = loaded?.definitionId;
    const disabledReason = !definitionId
      ? t.content?.deleteContainerNotLoaded || "Still loading this type."
      : writeAccess === "readOnly"
        ? t.content?.metaobjectEntryReadOnlyDefinition ||
          "This app cannot change entries of this definition."
        : null;
    return {
      label: t.content?.deleteContainerButtonLabel || "Delete type",
      disabledReason,
      onAction: () => {
        if (!definitionId) return;
        deleteItem.request({
          id: definitionId,
          title: loaded?.definitionName || selectedType,
          resource: "metaobjectDefinition" as const,
          // From the cache, and the dialog says so: Shopify neither asks about
          // the entries nor reports how many it removed.
          cascadeCount: loaded?.contentCount ?? loaded?.metaobjects?.length ?? 0,
        });
      },
    };
  }, [selectedType, loaded, writeAccess, t, deleteItem]);

  const cardTexts = useMemo(
    () => ({
      handleLabel: t.content?.metaobjectEntryHandle,
      noEditableFields: t.content?.metaobjectEntryNoEditableFields,
      unsupportedTitle: t.content?.metaobjectEntryUnsupportedTitle,
      unsupportedHint: t.content?.metaobjectEntryUnsupportedHint,
      deleteLabel: t.content?.metaobjectEntryDelete,
      deleteInUse: t.content?.metaobjectEntryDeleteInUse,
      usageChecking: t.content?.metaobjectEntryUsageChecking,
      usageNone: t.content?.metaobjectEntryUsageNone,
      usageKnown: t.content?.metaobjectEntryUsageKnown,
      usageUnknown: t.content?.metaobjectEntryUsageUnknown,
      syncProducts: t.content?.metaobjectEntrySyncProducts,
      createdBadge: t.content?.metaobjectEntryCreated,
      editColor: t.content?.metaobjectEntryEditColor,
      colorInvalid: t.content?.metaobjectEntryColorInvalid,
      readOnlyDefinition: t.content?.metaobjectEntryReadOnlyDefinition,
      readOnlyUnknown: t.content?.metaobjectEntryReadOnlyUnknown,
    }),
    [t],
  );

  const renderFieldGroup = useCallback(
    (groupId: string, rendered: RenderedGroupField[]) => {
      const entry = entryById.get(groupId);
      if (!entry) return null;
      const specs = metaobjectFieldSpecs(entry, loaded?.fieldDefinitions);
      const title =
        entry.displayName || entry.handle || entry.id.split("/").pop() || entry.id;
      // The swatch reads the entry's OWN colour / image fields — Shopify's
      // derived `ProductOptionValue.swatch` belongs to a product and is not
      // available here. Both sides go through `resolveSwatch`, so the dot the
      // variants card paints and the dot here cannot disagree.
      const colourSpec = specs.find((s) => s.role === "color");
      const fileSpec = specs.find((s) => s.role === "file");
      const swatch =
        colourSpec?.rawValue || fileSpec?.rawValue
          ? {
              color: colourSpec?.rawValue || null,
              imageUrl: fileSpec?.rawValue ? loaded?.filePreviews?.[fileSpec.rawValue] ?? null : null,
            }
          : null;

      // The COLOUR control moves into the card header, where the dot already
      // is. It is in `rendered` at all only because a grouped field is never
      // read as a merchandising attribute -- while it was, this lookup found
      // nothing on every entry and the dot was a picture with no control
      // behind it. Picked out BY KEY, never by position: the field order follows the
      // definition and an index would silently grab the wrong control the
      // moment a merchant reorders their definition. It is only lifted while
      // it is actually editable — in a foreign locale or on a refused
      // definition it stays in the body as a read-only field, because a
      // popover behind a dot is a place to EDIT, not a place to hide a value.
      const colourEditable = writeAccess !== "readOnly" && editor.state.currentLanguage === primaryLocale;
      const colourEntry =
        colourSpec && colourEditable
          ? rendered.find((r) => r.field.key === colourSpec.compoundKey)
          : undefined;
      const bodyFields = rendered.filter((r) => r !== colourEntry);

      const raw = usage[groupId];
      const entryUsage: MetaobjectEntryUsage = !raw
        ? { state: "loading" }
        : raw.known
          ? { state: "known", products: raw.products }
          : { state: "unknown", reason: raw.reason === "noProducts" ? "noProducts" : "lookupFailed" };

      return (
        <MetaobjectEntryCard
          entryId={entry.id}
          title={title}
          handle={entry.handle}
          swatch={swatch}
          unsupportedFields={specs
            .filter((s) => s.role === "unsupported")
            .map((s) => ({ label: s.label, fieldType: s.fieldType }))}
          justCreated={justCreatedId === entry.id}
          readOnlyReason={writeAccess === "readOnly" ? "refused" : undefined}
          usage={entryUsage}
          onDelete={() => deleteItem.request({ id: entry.id, title, resource: "metaobject" })}
          // The products tab is where a sync is started. A hard
          // `window.location` would drop the embedded session parameters and
          // bounce the merchant through OAuth for a link.
          onSyncProducts={() => handleNavigate("/app/products")}
          colorControl={colourEntry?.node}
          colorValue={colourEntry?.value}
          // MEASURED (PLAN_METAOBJECTS_EDITOR V3, 2026-08-19): writing this
          // field moved `ProductOptionValue.swatch` on a linked product. The
          // app may therefore say what the edit reaches — right at the control
          // rather than in a help page nobody opens.
          colorNote={t.content?.metaobjectEntryColorStorefrontNote}
          t={cardTexts}
        >
          {bodyFields.map((r) => r.node)}
        </MetaobjectEntryCard>
      );
    },
    [
      entryById,
      loaded,
      usage,
      justCreatedId,
      deleteItem,
      cardTexts,
      handleNavigate,
      writeAccess,
      editor.state.currentLanguage,
      primaryLocale,
      t,
    ],
  );

  // Entries with NO editable field still get a card — deriving the order from
  // the FIELDS alone would drop exactly the entry that has nothing to edit,
  // and an entry that silently disappears is the defect this page is fixing.
  const fieldGroupOrder = useMemo(
    () => (loaded?.metaobjects ?? []).map((m) => m.id),
    [loaded],
  );

  const fieldPagination = useMemo(() => {
    if (!loaded?.pagination) return null;
    return {
      page: loaded.pagination.page,
      limit: loaded.pagination.limit,
      totalCount: loaded.pagination.totalCount,
      totalPages: loaded.pagination.totalPages,
      search: loaded.pagination.search ?? entrySearch,
      // The strip pages ENTRIES here. Its default noun is "fields", which on
      // this page counted entries and named their parts.
      noun: t.content?.metaobjectEntriesNoun,
    };
  }, [loaded, entrySearch, t]);

  // Show loader error
  useEffect(() => {
    if (error) {
      showInfoBox(error, "critical", t.content?.error || "Error");
    }
  }, [error, showInfoBox, t]);

  useEffect(() => {
    if (entryError) {
      showInfoBox(entryError, "critical", t.content?.error || "Error");
    }
  }, [entryError, showInfoBox, t]);

  // Measure page load performance
  useEffect(() => {
    measurePageLoad('MetaobjectsPage', {
      metaobjectCount: metaobjects.length,
    });
  }, [metaobjects]);

  const entriesLoading = entryFetcher.state !== "idle" || (!!selectedType && !loaded && !entryError);

  return (
    <PlanAccessGate contentType="metaobjects">
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        <UnifiedContentEditor
          config={METAOBJECTS_CONFIG}
          items={augmentedMetaobjects as unknown as ContentItem[]}
          shopLocales={shopLocales}
          primaryLocale={primaryLocale}
          editor={editor}
          fetcherState={fetcher.state}
          fetcherFormData={fetcher.formData}
          t={t}
          hideItemListImages={true}
          hideItemListStatusBars={true}
          revalidator={revalidator}
          isFieldsLoading={entriesLoading}
          fieldsReadOnly={writeAccess === "readOnly"}
          containerAction={containerAction}
          fieldPagination={fieldPagination}
          fieldSearchPlaceholder={t.content?.metaobjectsSearchEntries}
          onFieldPageChange={(page) => {
            // An explicit page change outranks a focus: the merchant is
            // browsing now, and re-snapping to the focused entry would make the
            // arrows do nothing.
            setFocusEntryId(null);
            setEntryPage(page);
          }}
          onFieldSearch={(search) => {
            setFocusEntryId(null);
            setEntrySearch(search);
            setEntryPage(1);
          }}
          renderFieldGroup={renderFieldGroup}
          fieldGroupOrder={fieldGroupOrder}
          createPrefill={createPrefill}
          onItemCreated={handleItemCreated}
        />
      </div>

      {deleteItem.target && (
        <DeleteItemModal
          open={!!deleteItem.target}
          onClose={deleteItem.cancel}
          item={deleteItem.target}
          onConfirm={deleteItem.confirm}
          deleting={deleteItem.deleting}
          error={deleteItem.error}
          t={t.content?.deleteModal}
        />
      )}
    </div>
    </PlanAccessGate>
  );
}
