/**
 * Bulk editor route (docs/plans/PLAN_BULK_EDITOR.md §3 — Phase 1) — Basic+.
 *
 * The tabular editor across the whole catalog: a spreadsheet-like grid over
 * products/collections/articles/pages with merchant-picked columns,
 * server-side search/filter/sort and diff-only saving. Successor of the SEO
 * bulk-meta editor — /app/seo/bulk-meta 302-redirects here.
 *
 * Diff-only save-all: only cells whose value actually changed are submitted
 * (computeDiff, app/services/bulk-editor/columns.shared.ts). Up to
 * MAX_SYNC_SAVE dirty cells save synchronously through this route's own
 * action; anything bigger is routed to the shared /api/ai "seoBulkMeta"
 * action instead (the task type keeps its historical name — renaming would
 * break running tasks), which runs it as a detached, heartbeat-updated Task.
 *
 * All grid state lives in the URL (?type=&locale=&market=&q=&f=&sort=&page=
 * &pageSize=) and navigation goes through useAppNavigation() so the Shopify
 * session params (host/shop/embedded) survive.
 */

import { data as json, type LoaderFunctionArgs, type ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useRevalidator } from "react-router";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Card, BlockStack, InlineStack, Text, Button, Select, Banner, Modal, Tooltip } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { PlanAccessGate } from "../components/PlanAccessGate";
import { DisabledActionTooltip } from "../components/DisabledActionTooltip";
import { AppSaveBar } from "../components/AppSaveBar";
import { getFormString, getFormJSON } from "../utils/form-data.utils";
import { getLocalizedLanguageName } from "../utils/contentEditor.utils";
import { bulkColumnHeading } from "../services/bulk-editor/labels.shared";
import { meetsPlan } from "../utils/planUtils";
import { type Plan } from "../config/plans";
// Pure/client-safe pieces from the shared module — the component uses them,
// so they must not drag server-only code into the client bundle (see the
// module-head comment in columns.shared.ts).
import {
  computeDiff,
  estimateCalls,
  makeEditKey,
  parseEditKey,
  parseSortParam,
  serializeSortParam,
  resolveCellValue,
  buildColumnsForType,
  isValidBulkDiffEntry,
  parseMoney,
  formatMoneyForDisplay,
  applyPriceAction,
  BULK_ROW_TYPE_TO_AI_CONTENT_TYPE,
  BULK_COLUMNS_BY_TYPE,
  BULK_FILTER_IDS,
  canonicalFieldNameForColumn,
  aiFieldKey,
  isListShapedColumn,
  columnCanHaveCellActions,
  LIST_DISPLAY_SEPARATOR,
  IMAGE_ROW_ALT_COLUMN_ID,
  BULK_PAGE_SIZES,
  BULK_DEFAULT_PAGE_SIZE,
  FILTER_IDS_BY_SET,
  filterSetForType,
  MAX_SYNC_SAVE,
  MAX_TASK_CALLS,
  MAX_BULK_TASK_ITEMS,
  MAX_VISIBLE_COLUMNS,
  VAR_PRICE_COLUMN_ID,
  VAR_COMPARE_AT_COLUMN_ID,
  type BulkRowType,
  type BulkRow,
  type BulkSort,
  type BulkFilterId,
  type BulkDiffEntry,
  type BulkFailure,
  type ColumnDescriptor,
  type MetafieldColumnSpec,
  type MetaobjectColumnSpec,
  type PriceAction,
  type ProductColumnCaps,
} from "../services/bulk-editor/columns.shared";
// CSV limits + delimiter choice (§8.1/§8.2) — client-safe module.
import {
  CSV_EXPORT_MAX_ROWS,
  CSV_IMPORT_MAX_BYTES,
  delimiterForAppLanguage,
} from "../services/bulk-editor/csv.shared";
// Excel-paste rectangle + undo stack (§8.3/§8.4) — client-safe pure pieces.
import {
  isRectClipboard,
  parseClipboardRect,
  distributeRect,
  pushSnapshot,
  popSnapshot,
  type EditMapSnapshot,
} from "../services/bulk-editor/grid-interactions.shared";
import { debugLog } from "../utils/debug";
// Server-only I/O — referenced exclusively from loader/action, which Remix
// strips from the client build.
import { loadBulkRows, getShopCurrencyCode } from "../services/bulk-editor/load.server";
import { applyBulkDiff } from "../services/bulk-editor/apply.server";
import { findInvalidLocaleOrMarket } from "../services/bulk-editor/translations.server";
import {
  allowedRowTypesForPlan,
  buildServerColumnsByType,
  loadMetaobjectColumnSpecs,
  loadProductMetafieldColumnSpecs,
  productColumnCapsForPlan,
} from "../services/bulk-editor/columns.server";
import { BulkGrid, type CellTranslationStatus } from "../components/bulk-editor/BulkGrid";
import { CsvImportModal } from "../components/bulk-editor/CsvImportModal";
// Type-only imports from the resource routes / server service — erased at
// compile time, so nothing server-only reaches the client bundle.
import type { BulkCsvExportPayload } from "./app.bulk.export";
import type { CsvImportActionResult } from "./app.bulk.import";
import type { CsvImportPreview } from "../services/bulk-editor/csv-import.server";
import { BulkLanguageBar, shouldRenderBulkLanguageBar } from "../components/bulk-editor/BulkLanguageBar";
import type { BulkCellActions } from "../components/bulk-editor/BulkCell";
import { ColumnPickerModal } from "../components/bulk-editor/ColumnPickerModal";
import { FilterBar } from "../components/bulk-editor/FilterBar";
import { PriceActionsPopover } from "../components/bulk-editor/PriceActionsPopover";
import type { DataResponse } from "~/types/data-response";

async function loadPlan(db: any, shop: string): Promise<Plan> {
  const settings = await db.aISettings.findUnique({
    where: { shop },
    select: { subscriptionPlan: true },
  });
  return (settings?.subscriptionPlan || "free") as Plan;
}

interface LoaderData {
  gated: boolean;
  allowedTypes: BulkRowType[];
  rows: BulkRow[];
  type: BulkRowType;
  page: number;
  pageSize: number;
  total: number;
  search: string;
  filters: BulkFilterId[];
  /** Serialized sort param or null. */
  sort: string | null;
  locale: string;
  marketId: string;
  translationFilterApproximate: boolean;
  /** Image view: the shop never ran a media-library sync, so every image
   * outside the product catalogue is missing from the list. */
  mediaLibraryNeverSynced: boolean;
  /** Shop-specific metafield columns (Plan §4.1) — plain specs; the client
   * builds the descriptors via buildColumnsForType. */
  metafieldColumns: MetafieldColumnSpec[];
  /** Shop-specific metaobject field columns across ALL definitions (Phase 5,
   * Plan §7) — the client narrows rendering to the selected moType. */
  metaobjectColumns: MetaobjectColumnSpec[];
  /** The shop's MetaobjectDefinition types for the toolbar's type filter. */
  metaobjectTypes: { type: string; name: string }[];
  /** Selected metaobject definition type. Metaobjects are only
   * schema-homogeneous per type (Plan §7), so a selection is effectively
   * mandatory — the loader defaults to the FIRST definition (alphabetical)
   * instead of showing the union of every schema. "" only when the shop has
   * no definitions at all. */
  moType: string;
  /** Plan-gated dynamic product column capabilities (Plan §10.7). */
  productCaps: ProductColumnCaps;
  /** PUBLISHED shop locales, primary first (Phase 4 language selector). */
  locales: { locale: string; name: string; primary: boolean }[];
  /** ACTIVE markets (loadMarkets gates on status === 'ACTIVE' — CLAUDE.md). */
  markets: { id: string; name: string }[];
  /** Pro gate for the "translate missing" AI action (Plan §10.7). */
  aiTranslateAllowed: boolean;
  /** Pro gate for CSV import (Plan §10.7 — export stays Basic). The server
   * gate lives in app.bulk.import.tsx; this only drives the button state. */
  csvImportAllowed: boolean;
  /** Shop-wide currency (Plan §5.2), shown as a money-column header suffix.
   * "" when unknown or not a variant view. */
  currencyCode: string;
}

/** The alt column of the IMAGE row type — the preview modal shows its value
 * (the grid's own resolution, so a foreign view shows the translation). */
const ALT_PREVIEW_COLUMN = BULK_COLUMNS_BY_TYPE.image.find((c) => c.id === IMAGE_ROW_ALT_COLUMN_ID)!;

const NO_PRODUCT_CAPS: ProductColumnCaps = { metafields: false, options: false, imageAlt: false };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");
  const shop = session.shop;

  const plan = await loadPlan(db, shop);
  if (!meetsPlan(plan, "basic")) {
    return json<LoaderData>({
      gated: true,
      allowedTypes: [],
      rows: [],
      type: "product",
      page: 1,
      pageSize: BULK_DEFAULT_PAGE_SIZE,
      total: 0,
      search: "",
      filters: [],
      sort: null,
      locale: "",
      marketId: "",
      translationFilterApproximate: false,
      mediaLibraryNeverSynced: false,
      metafieldColumns: [],
      metaobjectColumns: [],
      metaobjectTypes: [],
      moType: "",
      productCaps: NO_PRODUCT_CAPS,
      locales: [],
      markets: [],
      aiTranslateAllowed: false,
      csvImportAllowed: false,
      currencyCode: "",
    });
  }

  const allowedTypes = allowedRowTypesForPlan(plan);
  const url = new URL(request.url);
  const rawType = url.searchParams.get("type") || "product";
  const type: BulkRowType = (allowedTypes as string[]).includes(rawType)
    ? (rawType as BulkRowType)
    : allowedTypes[0] ?? "product";

  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const rawPageSize = parseInt(url.searchParams.get("pageSize") || "", 10);
  const pageSize = (BULK_PAGE_SIZES as readonly number[]).includes(rawPageSize)
    ? rawPageSize
    : BULK_DEFAULT_PAGE_SIZE;
  const search = url.searchParams.get("q") || "";
  const filters = (url.searchParams.get("f") || "")
    .split(",")
    .filter((f): f is BulkFilterId => (BULK_FILTER_IDS as string[]).includes(f));
  const sort = parseSortParam(type, url.searchParams.get("sort"));

  // Language + market dimension (Phase 4). Both cached/degrading loaders:
  // locales via the 60-s shop-locales cache, markets ACTIVE-gated inside
  // loadMarkets (CLAUDE.md: status === 'ACTIVE', never the deprecated
  // `enabled`; secondary markets without own web presences stay listed).
  const { getCachedShopLocales } = await import("../utils/shop-locales-cache.server");
  const { ShopifyContentService } = await import("../../src/services/shopify-content.service");
  const [shopLocales, marketsResult] = await Promise.all([
    getCachedShopLocales(admin, shop).catch(() => []),
    new ShopifyContentService(admin as never).loadMarkets().catch(() => ({ markets: [] })),
  ]);
  const locales = shopLocales
    .filter((l) => l.published || l.primary)
    .sort((a, b) => Number(b.primary) - Number(a.primary))
    .map((l) => ({ locale: l.locale, name: l.name || l.locale, primary: l.primary }));
  const markets = marketsResult.markets.map((m) => ({ id: m.id, name: m.name }));

  // URL params are validated, never trusted: an unknown locale collapses to
  // "" (primary) instead of silently mislabeling primary content as a
  // translation; a market requires a foreign locale (primary is always
  // global) and must be one of the ACTIVE markets.
  const rawLocale = url.searchParams.get("locale") || "";
  const locale = locales.some((l) => !l.primary && l.locale === rawLocale) ? rawLocale : "";
  const rawMarket = url.searchParams.get("market") || "";
  const marketId = locale !== "" && markets.some((m) => m.id === rawMarket) ? rawMarket : "";

  // Dynamic product columns (Phase 2): the metafield column source is the
  // enabled-definitions ∩ translatable-types set — the same filter the
  // product editor uses (Plan §4.1) — gated on the plan's cache caps (§10.7).
  const productCaps = productColumnCapsForPlan(plan);
  const metafieldColumns =
    type === "product" && productCaps.metafields
      ? await loadProductMetafieldColumnSpecs(db, shop)
      : [];

  // Metaobject view (Phase 5): definition types for the toolbar filter plus
  // the field-column specs (union over all definitions — display narrows to
  // the selected type client-side). Selection defaults to the FIRST
  // definition; metaobjects are only schema-homogeneous per type (Plan §7).
  let metaobjectTypes: { type: string; name: string }[] = [];
  let metaobjectColumns: MetaobjectColumnSpec[] = [];
  let moType = "";
  if (type === "metaobject") {
    const definitions = await db.metaobjectDefinition.findMany({
      where: { shop },
      select: { type: true, name: true },
      orderBy: { type: "asc" },
    });
    metaobjectTypes = definitions.map((d) => ({ type: d.type, name: d.name || d.type }));
    metaobjectColumns = await loadMetaobjectColumnSpecs(db, shop);
    const rawMoType = url.searchParams.get("moType") || "";
    moType = metaobjectTypes.some((t) => t.type === rawMoType)
      ? rawMoType
      : metaobjectTypes[0]?.type ?? "";
  }

  const [{ rows, total, translationFilterApproximate, mediaLibraryNeverSynced }, currencyCode] = await Promise.all([
    loadBulkRows(db, shop, {
      type,
      locale,
      marketId,
      search,
      filters,
      sort,
      skip: (page - 1) * pageSize,
      take: pageSize,
      productCells: { metafieldSpecs: metafieldColumns, caps: productCaps },
      // Blog rows are live-fetched (Phase 5, Plan §7) — the loader needs the
      // admin client; other types ignore it.
      admin,
      moType,
      // Primary-view "missing translation" (blue) colour needs the published
      // foreign locales (already loaded above).
      foreignLocales: shopLocales.filter((l) => l.published && !l.primary).map((l) => l.locale),
    }),
    // Currency suffix for the money columns (Plan §5.2) — variant view only;
    // process-cached, so this is one query per shop per boot.
    type === "variant" ? getShopCurrencyCode(admin, shop) : Promise.resolve(""),
  ]);

  return json<LoaderData>({
    gated: false,
    allowedTypes,
    rows,
    type,
    page,
    pageSize,
    total,
    search,
    filters,
    sort: sort ? serializeSortParam(sort) : null,
    locale,
    marketId,
    translationFilterApproximate,
    mediaLibraryNeverSynced: mediaLibraryNeverSynced ?? false,
    metafieldColumns,
    metaobjectColumns,
    metaobjectTypes,
    moType,
    productCaps,
    locales,
    markets,
    aiTranslateAllowed: meetsPlan(plan, "pro"),
    csvImportAllowed: meetsPlan(plan, "pro"),
    currencyCode,
  });
};

type ActionResult =
  | { ok: true; saved: number; failures: BulkFailure[] }
  | { ok: false; error: string };

export const action = async ({ request }: ActionFunctionArgs): Promise<DataResponse> => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");
  const shop = session.shop;

  const plan = await loadPlan(db, shop);
  if (!meetsPlan(plan, "basic")) {
    return json<ActionResult>({ ok: false, error: "gated" }, { status: 403 });
  }

  const form = await request.formData();
  if (getFormString(form, "actionType") !== "saveBulkEdits") {
    return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
  }

  const diff = getFormJSON<BulkDiffEntry[]>(form, "diff");
  if (!Array.isArray(diff) || diff.length === 0) {
    return json<ActionResult>({ ok: false, error: "empty" }, { status: 400 });
  }
  // Never trust the client diff blindly, even on the synchronous path — same
  // GID + column allowlist + plan-type checks as the task path
  // (seo-bulk-meta.handler.ts). The column universe is built SERVER-side, so
  // mf.-columns are checked against the shop's enabled definitions, not
  // against client claims (Plan §4.1).
  const allowedTypes = allowedRowTypesForPlan(plan);
  const columnsByType = await buildServerColumnsByType(db, shop, plan);
  if (!diff.every((e) => isValidBulkDiffEntry(e, allowedTypes, columnsByType))) {
    return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
  }
  // Phase 4 data-integrity gate: foreign locales must be PUBLISHED shop
  // locales, markets must be ACTIVE — an unknown locale must never reach
  // translationsRegister (it could otherwise silently misfile content).
  const localeError = await findInvalidLocaleOrMarket(admin, shop, diff);
  if (localeError) {
    return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
  }
  // Defensive only — the client routes >MAX_SYNC_SAVE dirty cells to /api/ai
  // "seoBulkMeta" instead of posting here.
  if (diff.length > MAX_SYNC_SAVE) {
    return json<ActionResult>({ ok: false, error: "tooLarge" }, { status: 400 });
  }

  // Phase 4b: the published foreign locales are the target set for the
  // primary-save stale-translation invalidation (cached read).
  const { getCachedShopLocales } = await import("../utils/shop-locales-cache.server");
  const foreignLocales = (await getCachedShopLocales(admin, shop).catch(() => []))
    .filter((l) => l.published && !l.primary)
    .map((l) => l.locale);

  const result = await applyBulkDiff({ db, shop, admin, columnsByType, foreignLocales }, diff);
  return json<ActionResult>({ ok: true, saved: result.saved, failures: result.failures });
};

/** Deep-link target per content type for the row's "open in editor" action.
 * Variant rows jump to their PRODUCT (row.productId) — variants have no
 * standalone editor page. */
const TYPE_EDITOR_PATH: Record<BulkRowType, string> = {
  product: "/app/products",
  variant: "/app/products",
  collection: "/app/collections",
  article: "/app/blog",
  page: "/app/pages",
  blog: "/app/blog",
  policy: "/app/policies",
  metaobject: "/app/metaobjects",
  // Image rows open their PRODUCT (row.productId) — media have no own page.
  image: "/app/products",
};

interface BulkFetcherResult {
  success: boolean;
  error?: string;
  taskId?: string;
  total?: number;
}

/** Localstorage key holding the user's per-type visible column selection
 * (new-format column ids). Namespaced by type so switching
 * Product↔Collection remembers each. */
const COLUMNS_STORAGE_KEY = "contentpilot:bulkEditor:columns";
/** Pre-rework key (flat field names). Read once as a fallback so merchants
 * keep their layout across the rename; writes go to the new key only. */
const LEGACY_COLUMNS_STORAGE_KEY = "contentpilot:bulkMeta:columns";

/** Which columns are visible by default when the merchant first opens the
 * grid for a type. Product defaults to a compact "image + meta" view to fit
 * on-screen without horizontal scrolling for the common case. */
const DEFAULT_COLUMNS: Record<BulkRowType, string[]> = {
  product: ["image", "field.title", "field.productType", "field.handle", "field.seoTitle", "field.seoDescription"],
  variant: ["image", "productTitle", "variantTitle", "var.sku", "var.price", "var.compareAtPrice", "var.barcode"],
  collection: ["image", "field.title", "field.handle", "field.seoTitle", "field.seoDescription"],
  article: ["image", "field.title", "field.summary", "field.handle", "field.seoTitle", "field.seoDescription"],
  page: ["field.title", "field.handle", "field.seoTitle", "field.seoDescription"],
  blog: ["field.title", "field.handle", "field.seoTitle", "field.seoDescription"],
  policy: ["policyTitle", "field.body"],
  // Metaobject defaults are computed per selected definition type (context
  // columns + the type's field columns) — see defaultColumnsFor() below.
  metaobject: ["moDisplayName", "moHandle"],
  image: ["image", "imageUsage", "position", "field.altText"],
};

/** Maps a legacy stored column name ("title", "image", "blogTitle") to the
 * descriptor id ("field.title", "image", "blogTitle"). */
function migrateLegacyColumnName(name: string): string {
  return name === "image" || name === "blogTitle" ? name : `field.${name}`;
}

function readColumnStore(key: string): Partial<Record<BulkRowType, string[]>> | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as Partial<Record<BulkRowType, string[]>>;
  } catch {
    return null;
  }
}

/**
 * Restore the merchant's saved column selection for a type (new key first,
 * then the pre-rework key with name migration), or fall back to the default
 * set. Stale columns (from an older release that offered a field we've since
 * removed — or a metafield definition disabled in the meantime) are filtered
 * out silently; the visible set is capped at MAX_VISIBLE_COLUMNS.
 */
function loadColumnPrefs(
  type: BulkRowType,
  allColumns: ColumnDescriptor[],
  defaults: string[] = DEFAULT_COLUMNS[type],
): string[] {
  if (typeof window === "undefined") return defaults;
  const allowed = new Set(allColumns.map((c) => c.id));
  const sanitize = (cols: string[]): string[] | null => {
    const filtered = cols.filter((c) => allowed.has(c)).slice(0, MAX_VISIBLE_COLUMNS);
    return filtered.length > 0 ? filtered : null;
  };

  const stored = readColumnStore(COLUMNS_STORAGE_KEY)?.[type];
  if (Array.isArray(stored) && stored.length > 0) {
    const cols = sanitize(stored);
    if (cols) return cols;
  }
  const legacy = readColumnStore(LEGACY_COLUMNS_STORAGE_KEY)?.[type];
  if (Array.isArray(legacy) && legacy.length > 0) {
    const cols = sanitize(legacy.map(migrateLegacyColumnName));
    if (cols) return cols;
  }
  return defaults;
}

function saveColumnPrefs(type: BulkRowType, cols: string[]) {
  if (typeof window === "undefined") return;
  try {
    const all = readColumnStore(COLUMNS_STORAGE_KEY) ?? {};
    all[type] = cols;
    window.localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // localStorage may be unavailable (private mode / SSR mismatch) — the
    // grid still works, we just don't remember the selection for next time.
  }
}

export default function BulkEditor() {
  const data = useLoaderData<typeof loader>();
  const { gated, rows, allowedTypes, type, page, pageSize, total, search, filters, locale, marketId } = data;
  const { t, locale: uiLocale } = useI18n();
  const { handleNavigate } = useAppNavigation();
  const revalidator = useRevalidator();
  const b = t.bulkEditor;

  const sort = useMemo(() => parseSortParam(type, data.sort), [type, data.sort]);

  const saveFetcher = useFetcher<ActionResult>();
  const bulkFetcher = useFetcher<BulkFetcherResult>();
  // CSV export (§8.1) — same resource-route + Blob-download pattern as the
  // redirects export; the response carries the ready CSV string (BOM inside).
  const exportFetcher = useFetcher<BulkCsvExportPayload>();
  // CSV import preview (§8.2) — the server parses/diffs, this client only
  // shows the preview and, after confirmation, submits the returned diff
  // through the NORMAL save pipeline (submitDiff below).
  const importFetcher = useFetcher<CsvImportActionResult>();
  /** Manual trigger for the media-library cache — the image view is empty
   * beyond product media until it has run once. */
  const syncMediaLibraryFetcher = useFetcher();
  /** Row whose image is shown large (§ image cell). Null = modal closed. */
  const [previewRow, setPreviewRow] = useState<BulkRow | null>(null);
  /**
   * Foreign locales the per-cell "…into all active languages" actions target.
   * In-memory and defaulted to all, exactly like the content editor's
   * enabledLanguages — a Ctrl+click on a language button flips one off.
   */
  const [disabledLocales, setDisabledLocales] = useState<string[]>([]);

  const [edits, setEdits] = useState<Record<string, string>>({});
  const [lastFailures, setLastFailures] = useState<BulkFailure[]>([]);
  const [lastSavedCount, setLastSavedCount] = useState<number | null>(null);
  const [queuedBanner, setQueuedBanner] = useState(false);
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [overBudgetBanner, setOverBudgetBanner] = useState(false);
  /** "X cells, maximum 500 per save" refusal (Finding 2) — set to the cell
   * count of the refused diff. */
  const [cellLimitBanner, setCellLimitBanner] = useState<number | null>(null);
  /** "{count} cells updated" feedback after a price bulk action (Plan §5.6). */
  const [priceActionBanner, setPriceActionBanner] = useState<number | null>(null);
  // ── CSV export/import + paste/undo state (Phase 6) ───────────────────────
  const [exportError, setExportError] = useState<string | null>(null);
  /** One-download guard: the effect below fires on every render while the
   * fetcher holds data — remember what was already downloaded. */
  const downloadedExportKeyRef = useRef<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importPreview, setImportPreview] = useState<CsvImportPreview | null>(null);
  const importFileRef = useRef<HTMLInputElement>(null);
  /** "12 × 3 cells pasted" feedback (§8.3) with its undo action. */
  const [pasteBanner, setPasteBanner] = useState<{
    rows: number;
    cols: number;
    applied: number;
    skipped: number;
  } | null>(null);
  /** Inverse of the last paste: affected keys → previous value (undefined =
   * key did not exist). The banner's undo restores EXACTLY these entries —
   * robust even if the merchant typed elsewhere in between. */
  const pasteInverseRef = useRef<{ key: string; prev: string | undefined }[] | null>(null);
  const pasteCounterRef = useRef(0);
  /** Undo history (§8.4): edit-map snapshots, coalesced per cell burst,
   * capped at UNDO_STACK_LIMIT. Ctrl/Cmd+Z pops — NOT the browser's
   * per-textarea undo. Redo is deliberately not offered (see
   * grid-interactions.shared.ts head comment). Lives in a ref: pushing must
   * not re-render the grid. */
  const undoStackRef = useRef<EditMapSnapshot[]>([]);
  /** Always the CURRENT edit map, also inside an async handler that closed
   * over an older render — the undo snapshot of a cell action needs it. */
  const editsRef = useRef<Record<string, string>>({});
  /** Bumped whenever the edit map is thrown away (discard, type switch): a
   * cell action started before the bump drops its late response. */
  const cellActionEpochRef = useRef(0);

  /** True when a foreign locale is selected — the grid then edits the
   * translation layer (Plan §1.3: language is a dimension, not a 2nd editor). */
  const isForeign = locale !== "";

  // Foreign baselines seen so far, accumulated ACROSS locale/market switches:
  // `rowId → (localeKey → value)`. computeDiff compares an edit against the
  // loaded translation of ITS OWN locale — without this accumulation,
  // switching locales would drop the baselines of the previous locale and a
  // deliberate clear there would silently stop counting as a change.
  const foreignBaselinesRef = useRef<Record<string, Record<string, string>>>({});

  // ROW baselines seen so far, accumulated ACROSS page/search/filter changes
  // (Finding 1) — the same §6.4 pattern as foreignBaselinesRef, one level up:
  // edits survive paging, so the diff needs the load baseline of rows that
  // are no longer on the current page. Rows the loader JUST delivered win
  // wholesale over their accumulated snapshot. Keyed per row id; cleared on
  // type/moType switches together with the edits. Kept in a ref (not state):
  // it only feeds memo computations that already re-run when `rows` changes.
  const accumulatedRowsRef = useRef<Map<string, BulkRow>>(new Map());

  // Full column universe for the current type: static per-type columns plus
  // (for products) the shop's enabled metafield columns, the option column
  // pairs and the main-image alt-text column (Phase 2), and (for
  // metaobjects) every definition's field columns (Phase 5). The specs come
  // from the loader; the descriptors are built client-side with the same
  // pure builder the server uses for validation.
  const allColumns = useMemo(
    () => buildColumnsForType(type, data.metafieldColumns, data.productCaps, data.metaobjectColumns),
    [type, data.metafieldColumns, data.productCaps, data.metaobjectColumns],
  );

  // The columns the CURRENT VIEW may show: for metaobjects, field columns of
  // other definition types are cut (the toolbar's type filter keeps the grid
  // schema-homogeneous, Plan §7) — the full union stays in `allColumns` for
  // the diff pipeline.
  const typeScopedColumns = useMemo(
    () =>
      type === "metaobject"
        ? allColumns.filter((c) => c.kind !== "mofield" || c.moType === data.moType)
        : allColumns,
    [type, allColumns, data.moType],
  );

  /** Default visible set: static per type, except metaobjects — their
   * defaults are the context columns plus the SELECTED definition's field
   * columns (each type has a different schema, so a static list can't work). */
  const defaultColumnsFor = (): string[] =>
    type === "metaobject"
      ? typeScopedColumns.map((c) => c.id).slice(0, MAX_VISIBLE_COLUMNS)
      : DEFAULT_COLUMNS[type];

  // Column visibility — merchant-picked, persisted per type. Rehydrated
  // whenever `type` changes so switching Products↔Pages restores each
  // type's saved layout (not a shared one that would leak fields).
  // Metaobject views skip localStorage: prefs stored under one moType would
  // degrade every other type to its two context columns — the per-type
  // default recomputes on each switch instead (documented Phase-5 decision).
  const [visibleColumnIds, setVisibleColumnIds] = useState<string[]>(() =>
    type === "metaobject" ? defaultColumnsFor() : loadColumnPrefs(type, allColumns),
  );
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    setVisibleColumnIds(
      type === "metaobject" ? defaultColumnsFor() : loadColumnPrefs(type, allColumns),
    );
    // Re-run on type/moType switches only — allColumns identity churns on
    // every revalidation but its CONTENT for a given type is stable, and the
    // rendered set is re-sanitized against it in activeColumns anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, data.moType]);

  // Only a TYPE (or metaobject-type) switch starts from a clean slate — its
  // edits would target columns/rows of a different schema. Everything else
  // (page, pageSize, search, sort, filters) KEEPS unsaved edits (Finding 1):
  // edits are keyed by rowId, so they can never target the wrong row, and
  // the accumulated row baselines (accumulatedRowsRef) keep them diffable
  // across paging — the same §6.4 pattern that already keeps edits across
  // locale/market switches. Deliberately keyed on the URL state rather than
  // [rows]: a partial-failure save calls revalidator.revalidate() to refresh
  // `rows` WITHOUT navigating, and that must NOT wipe the edits still held
  // for the rows that failed (see the saveFetcher effect below).
  useEffect(() => {
    setEdits({});
    setLastFailures([]);
    setLastSavedCount(null);
    setOverBudgetBanner(false);
    setCellLimitBanner(null);
    setPriceActionBanner(null);
    foreignBaselinesRef.current = {};
    accumulatedRowsRef.current = new Map();
    // Undo history and paste feedback die with the edits they describe —
    // popping a snapshot from a different type would resurrect edits that
    // silently target the wrong rows (§8.4).
    undoStackRef.current = [];
    pasteInverseRef.current = null;
    setPasteBanner(null);
    // Same reason as in handleDiscard: a cell action started on the previous
    // type must not land an edit keyed by a foreign GID in this type's map.
    cellActionEpochRef.current += 1;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, data.moType]);

  // Rows with the ACCUMULATED foreign baselines merged in: the loader only
  // ships the current locale/market's translations; baselines of previously
  // visited combos are kept so cross-locale edits diff correctly (see
  // foreignBaselinesRef). For the combos the loader JUST covered, its data is
  // authoritative WHOLESALE — accumulated keys of those combos are dropped
  // first, so a translation that was cleared on Shopify doesn't resurrect
  // from the stale accumulation.
  const mergedRows = useMemo(() => {
    const loadedPrefixes =
      locale === ""
        ? []
        : marketId !== ""
          ? [`${locale}|${marketId}|`, `${locale}||`]
          : [`${locale}||`];
    const acc = foreignBaselinesRef.current;
    const accRows = accumulatedRowsRef.current;
    return (rows as BulkRow[]).map((row) => {
      const previous = acc[row.id];
      let result = row;
      if (previous || row.foreignValues) {
        const merged: Record<string, string> = {};
        for (const [key, value] of Object.entries(previous ?? {})) {
          if (loadedPrefixes.some((prefix) => key.startsWith(prefix))) continue;
          merged[key] = value;
        }
        Object.assign(merged, row.foreignValues ?? {});
        acc[row.id] = merged;
        result = { ...row, foreignValues: merged };
      }
      // Row-baseline accumulation (Finding 1): freshly loaded rows replace
      // their accumulated snapshot WHOLESALE — the loader is authoritative.
      accRows.set(result.id, result);
      return result;
    });
  }, [rows, locale, marketId]);

  // The diff universe (Finding 1): the current page's rows PLUS the
  // accumulated baselines of previously visited pages/filter sets, so edits
  // that survived paging stay dirty and saveable. Rows never visited this
  // session have NO baseline — computeDiff drops their edits (never diff
  // without a baseline) and offPageEditCount surfaces them below.
  const diffRows = useMemo(() => {
    const currentIds = new Set(mergedRows.map((r) => r.id));
    const extra: BulkRow[] = [];
    for (const row of accumulatedRowsRef.current.values()) {
      if (!currentIds.has(row.id)) extra.push(row);
    }
    return extra.length === 0 ? mergedRows : [...mergedRows, ...extra];
  }, [mergedRows]);

  const dirty = useMemo(() => computeDiff(diffRows, allColumns, edits), [diffRows, allColumns, edits]);
  const dirtyRowIds = useMemo(() => new Set(dirty.map((d) => d.rowId)), [dirty]);

  // Edits whose row has never been loaded this session (Finding 1): typically
  // AI-preview suggestions for rows beyond the current page. They are KEPT in
  // the map (they become saveable once their row loads while paging) but
  // cannot be part of a save yet — the banner makes that explicit instead of
  // letting them vanish silently.
  const offPageEditCount = useMemo(() => {
    const known = accumulatedRowsRef.current;
    let count = 0;
    for (const key of Object.keys(edits)) {
      const parsed = parseEditKey(key);
      if (parsed && !known.has(parsed.rowId)) count++;
    }
    return count;
    // accumulatedRowsRef mutates when diffRows recomputes — depend on it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edits, diffRows]);

  // Variant rows: rowId → productId for the per-product call estimate
  // (Plan §5.4 — one productVariantsBulkUpdate per product).
  const variantProductIdByRowId = useMemo(() => {
    if (type !== "variant") return undefined;
    const map: Record<string, string> = {};
    for (const row of diffRows) {
      if (row.productId) map[row.id] = row.productId;
    }
    return map;
  }, [type, diffRows]);

  // §10.1: refuse an over-budget save BEFORE submitting.
  const estimatedCalls = useMemo(
    () => estimateCalls(dirty, allColumns, variantProductIdByRowId ? { variantProductIdByRowId } : undefined),
    [dirty, allColumns, variantProductIdByRowId],
  );

  // "Unsaved changes in N other languages/markets" (Plan §6.4) — edits are
  // kept across locale switches, so make their existence visible.
  const otherLocaleComboCount = useMemo(() => {
    const current = `${locale}|${marketId}`;
    const combos = new Set<string>();
    for (const entry of dirty) {
      const combo = `${entry.locale}|${entry.marketId}`;
      if (combo !== current) combos.add(combo);
    }
    return combos.size;
  }, [dirty, locale, marketId]);

  const saving = saveFetcher.state !== "idle" || bulkFetcher.state !== "idle";

  useEffect(() => {
    if (saveFetcher.state !== "idle" || !saveFetcher.data) return;
    if (saveFetcher.data.ok) {
      // Prune ONLY the edit keys that were part of the SUBMITTED diff
      // (Finding 1) — edits that never made it into the diff (rows without a
      // loaded baseline, e.g. AI suggestions for pages not visited yet) must
      // survive the save, otherwise they are silently lost. Of the submitted
      // keys, the ones that FAILED keep their typed values for retry
      // (Plan §0.2 no. 5, cell granularity per §4.4); row-level failures (no
      // columnId — single-mutation types) keep the whole row's edits.
      const failures = saveFetcher.data.failures;
      // Cell keys carry the locale/market segments (Phase 4) so only the
      // failed LANGUAGE's edit is kept — the same cell saved fine in another
      // locale is dropped normally.
      const failedCells = new Set(
        failures
          .filter((f) => f.columnId)
          .map((f) => `${f.rowId}|${f.locale ?? ""}|${f.marketId ?? ""}|${f.columnId}`),
      );
      const failedRows = new Set(failures.filter((f) => !f.columnId).map((f) => f.rowId));
      const submitted = lastSubmittedKeysRef.current;
      setEdits((prev) => {
        const next: Record<string, string> = {};
        for (const [key, value] of Object.entries(prev)) {
          const parsed = parseEditKey(key);
          if (!parsed) continue;
          if (
            !submitted.has(key) ||
            failedRows.has(parsed.rowId) ||
            failedCells.has(`${parsed.rowId}|${parsed.locale}|${parsed.marketId}|${parsed.columnId}`)
          ) {
            next[key] = value;
          }
        }
        return next;
      });
      setLastFailures(saveFetcher.data.failures);
      setLastSavedCount(saveFetcher.data.saved);
      // Undo snapshots taken before the save describe a pre-save world —
      // popping one would resurrect just-saved values as dirty edits (§8.4).
      undoStackRef.current = [];
      pasteInverseRef.current = null;
      setPasteBanner(null);
      revalidator.revalidate();
    }
    // Only react when the fetcher settles with new data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveFetcher.state, saveFetcher.data]);

  useEffect(() => {
    if (bulkFetcher.state !== "idle" || !bulkFetcher.data) return;
    if (bulkFetcher.data.success) {
      // Deliberately DO NOT clear edits here: the async path enqueues a Task
      // whose per-row outcome (successes AND failures) is surfaced later in
      // the Tasks tab, not here. If we cleared edits now and any row failed
      // in the background, the merchant would lose their typed values with
      // no way to retry. Merchant clears them explicitly via "Discard" once
      // the task completes.
      setQueuedBanner(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bulkFetcher.state, bulkFetcher.data]);

  // Edits target the SELECTED language/market (Phase 4): primary is
  // ("", ""), a foreign locale carries its locale + market segments in the
  // key, so switching the selectors keeps every combo's unsaved edits apart.
  const editKeyFor = (row: BulkRow, column: ColumnDescriptor) =>
    makeEditKey(row.id, locale, isForeign ? marketId : "", column.id);

  const setEdit = (row: BulkRow, column: ColumnDescriptor, value: string) => {
    const key = editKeyFor(row, column);
    // Undo history (§8.4): snapshot BEFORE the change, coalesced on the edit
    // key — a typing burst into one cell is ONE undo step (pushSnapshot drops
    // pushes whose tag matches the stack top), so `edits` from this render's
    // closure is exactly the pre-burst map for the push that sticks.
    undoStackRef.current = pushSnapshot(undoStackRef.current, { edits, tag: key });
    setEdits((prev) => ({ ...prev, [key]: value }));
  };
  const valueFor = (row: BulkRow, column: ColumnDescriptor): string => {
    const editKey = editKeyFor(row, column);
    if (editKey in edits) return edits[editKey];
    // Money cells (Plan §5.5): the stored value is the normalized dot form;
    // UNTOUCHED cells display it localized (Intl.NumberFormat in the app
    // language). Once the merchant types, their raw input shows verbatim and
    // computeDiff normalizes it back — so both directions round-trip.
    if (column.inputType === "money") {
      return formatMoneyForDisplay(resolveCellValue(row, column).value, uiLocale);
    }
    if (!isForeign) return resolveCellValue(row, column).value;
    // Foreign view: non-translatable columns show the primary value (they
    // render read-only/grey); translatable ones show the loaded translation
    // of the selected locale+market layer — an empty cell renders the ghost.
    if (!column.translatable) return resolveCellValue(row, column).value;
    return row.foreignValues?.[`${locale}|${marketId}|${column.id}`] ?? "";
  };
  /** Ghost for an empty foreign cell (Plan §6.4): under a market override the
   * GLOBAL translation of the same locale, otherwise the primary value. */
  const ghostFor = (row: BulkRow, column: ColumnDescriptor): string => {
    if (!isForeign) return "";
    if (marketId !== "") {
      const global = row.foreignValues?.[`${locale}||${column.id}`];
      if (global) return global;
    }
    return resolveCellValue(row, column).value;
  };
  const isDirtyCell = (row: BulkRow, column: ColumnDescriptor): boolean =>
    editKeyFor(row, column) in edits;

  /** Field colour, mirroring the single editor (Plan §2): "untranslated"
   * (yellow) when the CURRENTLY SELECTED language has no value for this field,
   * "missingTranslation" (blue) when — on the primary view — the primary value
   * exists but some foreign locale lacks the translation. Only translatable
   * columns colour; uses valueFor so it updates live as the merchant types. */
  const cellTranslationStatus = (row: BulkRow, column: ColumnDescriptor): CellTranslationStatus => {
    if (!column.translatable) return null;
    // Cells this ROW cannot back at all (an option position the product does
    // not have, a linked option, an uncached metafield) are structurally empty
    // — colouring them "untranslated" would mark four permanent yellow cells
    // on every single-option product.
    if (resolveCellValue(row, column).readOnlyReason) return null;
    const value = valueFor(row, column).trim();
    if (isForeign) return value === "" ? "untranslated" : null;
    if (value === "") return "untranslated";
    return row.untranslatedColumnIds?.includes(column.id) ? "missingTranslation" : null;
  };

  /** Locale code → app-language display name, for the blue-cell tooltip. Same
   * helper the single editor uses; falls back to the Shopify name / the code. */
  const localeNameByCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of data.locales) m.set(l.locale, getLocalizedLanguageName(l.locale, uiLocale, l.name));
    return m;
  }, [data.locales, uiLocale]);

  /** Tooltip for a blue "missingTranslation" cell: lists the foreign languages
   * that still lack a translation, e.g. "Missing translations: French, Italian".
   * The grid only asks for this on cells it already coloured blue. */
  const cellTranslationTooltip = (row: BulkRow, column: ColumnDescriptor): string | null => {
    if (isForeign) return null;
    const missing = row.untranslatedLocalesByColumnId?.[column.id];
    if (!missing || missing.length === 0) return null;
    const names = missing.map((loc) => localeNameByCode.get(loc) ?? loc).join(", ");
    return `${t.common.missingTranslations} ${names}`;
  };

  /** Navigate with updated grid params (all state is in the URL, §3.3).
   * handleNavigate merges with the current params, so untouched ones —
   * including Shopify's host/shop/embedded — survive. */
  const navigateGrid = (overrides: Record<string, string>) => {
    setQueuedBanner(false);
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(overrides)) params.set(key, value);
    handleNavigate("/app/bulk", { searchParams: params, replace: true });
  };

  const handleTypeChange = (value: string) => {
    // Finding 13: prune the carried-over filter ids to the ones the NEW type
    // actually speaks (same FILTER_IDS_BY_SET source the FilterBar renders
    // from) — otherwise e.g. `missingSku` silently rides into a product view.
    const validIds = FILTER_IDS_BY_SET[filterSetForType(value as BulkRowType)];
    navigateGrid({
      type: value,
      page: "1",
      sort: "",
      f: filters.filter((f) => validIds.includes(f)).join(","),
      moType: "",
    });
  };
  /** Metaobject definition-type filter (Phase 5) — resets the page like any
   * other filter; edits are cleared by the reset effect (they would target
   * columns the new schema doesn't render). */
  const handleMoTypeChange = (value: string) => navigateGrid({ moType: value, page: "1" });
  // Language/market switches deliberately do NOT reset the page — the edits
  // (and the merchant's position) survive the switch (Plan §6.4). Selecting
  // the primary language clears the market (primary is always global).
  const handleLocaleChange = (value: string) =>
    navigateGrid({ locale: value, ...(value === "" ? { market: "" } : {}) });
  const handleMarketChange = (value: string) => navigateGrid({ market: value });
  const goToPage = (nextPage: number) => navigateGrid({ page: String(nextPage) });
  const handleSearchCommit = (q: string) => navigateGrid({ q, page: "1" });
  const handleFiltersChange = (next: BulkFilterId[]) => navigateGrid({ f: next.join(","), page: "1" });
  const handlePageSizeChange = (size: number) => navigateGrid({ pageSize: String(size), page: "1" });
  const handleSortToggle = (column: ColumnDescriptor) => {
    // none → asc → desc → none
    const next: BulkSort | null =
      sort?.columnId !== column.id
        ? { columnId: column.id, direction: "asc" }
        : sort.direction === "asc"
          ? { columnId: column.id, direction: "desc" }
          : null;
    navigateGrid({ sort: next ? serializeSortParam(next) : "", page: "1" });
  };

  /** Edit keys of the last SUBMITTED diff — the post-save prune removes
   * exactly these (minus failures), never edits that were not part of the
   * save (Finding 1). */
  const lastSubmittedKeysRef = useRef<Set<string>>(new Set());

  /** ONE submission path for both entrances (grid edits AND the confirmed
   * CSV-import diff, §8.2 step 4): ≤MAX_SYNC_SAVE cells through this route's
   * action, anything bigger through the /api/ai seoBulkMeta task. */
  const submitDiff = (diffToSave: BulkDiffEntry[]) => {
    if (diffToSave.length === 0 || saving) return;
    // Finding 2: the task path rejects >MAX_BULK_TASK_ITEMS diff entries
    // (= cells) with a 400 — refuse HERE with a clear message instead of
    // after the server round-trip.
    if (diffToSave.length > MAX_BULK_TASK_ITEMS) {
      setCellLimitBanner(diffToSave.length);
      return;
    }
    setCellLimitBanner(null);
    lastSubmittedKeysRef.current = new Set(
      diffToSave.map((d) => makeEditKey(d.rowId, d.locale, d.marketId, d.columnId)),
    );
    // §10.5: summary only — never cell values.
    debugLog.bulkDiff("saving", {
      cells: diffToSave.length,
      rows: new Set(diffToSave.map((d) => d.rowId)).size,
      calls: estimatedCalls,
      path: diffToSave.length > MAX_SYNC_SAVE ? "task" : "sync",
    });
    if (diffToSave.length > MAX_SYNC_SAVE) {
      // `contentType` must be a VALID_CONTENT_TYPES value ("products", not
      // "product") — /api/ai validates it before dispatching to the handler.
      bulkFetcher.submit(
        {
          action: "seoBulkMeta",
          contentType: BULK_ROW_TYPE_TO_AI_CONTENT_TYPE[type],
          diff: JSON.stringify(diffToSave),
        },
        { method: "post", action: "/api/ai" },
      );
    } else {
      saveFetcher.submit(
        { actionType: "saveBulkEdits", diff: JSON.stringify(diffToSave) },
        { method: "post" },
      );
    }
  };

  const handleSave = () => {
    if (dirty.length === 0 || saving) return;
    // §10.1: report a budget overrun BEFORE submitting — not 20 minutes into
    // a task run.
    if (estimatedCalls > MAX_TASK_CALLS) {
      setOverBudgetBanner(true);
      return;
    }
    setOverBudgetBanner(false);
    submitDiff(dirty);
  };

  const handleDiscard = () => {
    // Any cell action still in flight belongs to the edit set being thrown
    // away: without this its response would write the translations back into
    // the emptied map AND push a snapshot of the discarded edits, so one
    // Ctrl+Z would resurrect everything the merchant just discarded.
    cellActionEpochRef.current += 1;
    setEdits({});
    setLastFailures([]);
    setLastSavedCount(null);
    setOverBudgetBanner(false);
    setCellLimitBanner(null);
    setPriceActionBanner(null);
    undoStackRef.current = [];
    pasteInverseRef.current = null;
    setPasteBanner(null);
  };

  // ── Keyboard: Esc reset + Ctrl/Cmd+Z undo (§8.4) ─────────────────────────

  /** Esc on a cell: drop its edit-map entry — the cell re-renders its load
   * baseline. Pushed to the undo stack (unique tag), so Ctrl+Z restores it. */
  const resetCell = (row: BulkRow, column: ColumnDescriptor) => {
    const key = editKeyFor(row, column);
    if (!(key in edits)) return;
    undoStackRef.current = pushSnapshot(undoStackRef.current, {
      edits,
      tag: `esc|${key}|${Date.now()}`,
    });
    setEdits((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const performUndo = () => {
    const popped = popSnapshot(undoStackRef.current);
    if (!popped) return;
    undoStackRef.current = popped.stack;
    setEdits(popped.snapshot.edits);
  };

  /** Grid-scoped capture handler: Ctrl/Cmd+Z inside the grid walks the
   * edit-map history instead of the browser's per-textarea undo (§8.4).
   * Capture phase, so the textarea never sees the event. Scoped to the grid
   * wrapper — search field, modals etc. keep their native undo. */
  const handleUndoKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "z") {
      e.preventDefault();
      e.stopPropagation();
      performUndo();
    }
  };

  // ── Excel/Sheets rectangle paste (§8.3) ──────────────────────────────────
  // NOTE: displayColumns/visibleRows are declared further down (with the rest
  // of the render-time derivations) — these handlers only run on events,
  // after the whole component body has executed.

  const handlePasteRect = (startRow: number, startCol: number, text: string): boolean => {
    if (!isRectClipboard(text)) return false; // normal paste into the cell
    const rect = parseClipboardRect(text);
    // Editability matrix over the VISIBLE rows × display columns: per-row
    // resolution (linked options, missing mediaId, …) plus the foreign-locale
    // translatable rule — same verdicts the cells themselves render with.
    const editable = visibleRows.map((row) =>
      displayColumns.map((col) => {
        const resolved = resolveCellValue(row, col);
        return resolved.editable && (!isForeign || col.translatable);
      }),
    );
    const dist = distributeRect(rect, editable, startRow, startCol);
    if (dist.cells.length > 0) {
      const tag = `paste|${++pasteCounterRef.current}`;
      undoStackRef.current = pushSnapshot(undoStackRef.current, { edits, tag });
      const inverse: { key: string; prev: string | undefined }[] = [];
      setEdits((prev) => {
        const next = { ...prev };
        for (const cell of dist.cells) {
          const key = editKeyFor(visibleRows[cell.row], displayColumns[cell.col]);
          inverse.push({ key, prev: key in prev ? prev[key] : undefined });
          next[key] = cell.value;
        }
        return next;
      });
      pasteInverseRef.current = inverse;
    }
    setPasteBanner({
      rows: dist.rows,
      cols: dist.cols,
      applied: dist.cells.length,
      skipped: dist.skippedReadOnly,
    });
    return true;
  };

  /** Banner undo (§8.3): restores exactly the paste-affected entries via the
   * stored inverse — robust even if the merchant typed elsewhere since. */
  const undoPaste = () => {
    const inverse = pasteInverseRef.current;
    if (inverse) {
      undoStackRef.current = pushSnapshot(undoStackRef.current, {
        edits,
        tag: `pasteundo|${Date.now()}`,
      });
      setEdits((prev) => {
        const next = { ...prev };
        for (const { key, prev: previous } of inverse) {
          if (previous === undefined) delete next[key];
          else next[key] = previous;
        }
        return next;
      });
      pasteInverseRef.current = null;
    }
    setPasteBanner(null);
  };

  // ── CSV export (§8.1) ────────────────────────────────────────────────────

  const handleExport = () => {
    setExportError(null);
    const params = new URLSearchParams({
      type,
      locale,
      market: isForeign ? marketId : "",
      q: search,
      f: filters.join(","),
      sort: data.sort ?? "",
      columns: visibleColumnIds.join(","),
      // Metaobject views export the selected definition type only (§8.1
      // "current view"); empty for every other type.
      moType: data.moType,
      // The APP language picks the delimiter (§8.1: ; for de/es, , for en).
      lang: uiLocale,
    });
    exportFetcher.load(`/app/bulk/export?${params.toString()}`);
  };

  useEffect(() => {
    if (exportFetcher.state !== "idle" || !exportFetcher.data) return;
    const payload = exportFetcher.data;
    if (payload.error) {
      setExportError(
        payload.error === "tooLarge"
          ? b.csv.exportTooLarge
              .replace("{total}", String(payload.total ?? 0))
              .replace("{max}", String(payload.max ?? CSV_EXPORT_MAX_ROWS))
          : b.csv.exportFailed,
      );
      return;
    }
    if (!payload.csv || !payload.filename) return;
    const key = `${payload.filename}:${payload.generatedAt ?? 0}`;
    if (downloadedExportKeyRef.current === key) return;
    downloadedExportKeyRef.current = key;
    const blob = new Blob([payload.csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = payload.filename;
    a.click();
    URL.revokeObjectURL(url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportFetcher.state, exportFetcher.data]);

  // ── CSV import (§8.2 — Pro; preview first, save through submitDiff) ──────

  const handleImportFile = async (file: File) => {
    setImportError(null);
    // UX pre-check only — the server re-enforces the byte cap (§8.2).
    if (file.size > CSV_IMPORT_MAX_BYTES) {
      setImportError(b.csv.fileTooLarge.replace("{max}", "5"));
      return;
    }
    const text = await file.text();
    importFetcher.submit(
      {
        actionType: "csvImportPreview",
        type,
        locale,
        market: isForeign ? marketId : "",
        csv: text,
      },
      { method: "post", action: "/app/bulk/import" },
    );
  };

  useEffect(() => {
    if (importFetcher.state !== "idle" || !importFetcher.data) return;
    const result = importFetcher.data;
    if (result.ok) {
      setImportPreview(result);
    } else {
      setImportError(
        result.error === "tooLarge"
          ? b.csv.fileTooLarge.replace("{max}", "5")
          : result.error === "tooManyRows"
            ? b.csv.tooManyRows.replace("{max}", "10000")
            : result.error === "empty"
              ? b.csv.emptyFile
              : result.error === "noIdColumn"
                ? b.csv.noIdColumn
                : b.csv.importFailed,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importFetcher.state, importFetcher.data]);

  const importOverBudget = (importPreview?.estimatedCalls ?? 0) > MAX_TASK_CALLS;
  // Finding 2: >MAX_SYNC_SAVE cells route to the task path, which caps one
  // save at MAX_BULK_TASK_ITEMS cells — block the confirm (with the reason
  // shown in the modal) instead of 400ing after a confirmed preview.
  const importOverCellLimit = (importPreview?.cellsChanged ?? 0) > MAX_BULK_TASK_ITEMS;

  const handleImportConfirm = () => {
    if (!importPreview || importOverBudget || importOverCellLimit) return;
    const diff = importPreview.diff;
    setImportPreview(null);
    submitDiff(diff);
  };

  // ── Price bulk actions (Plan §5.6) ───────────────────────────────────────
  // Applied to the CURRENT (filtered, loaded) selection — i.e. the rows the
  // grid shows right now. Results go into the EDIT MAP only: preview,
  // correction and saving all run through the normal diff pipeline.

  /** Effective current price of a row: pending edit first, then baseline —
   * normalized; null when empty/unparseable. */
  const currentPriceOf = (row: BulkRow): string | null => {
    const editKey = makeEditKey(row.id, "", "", VAR_PRICE_COLUMN_ID);
    const raw = editKey in edits ? edits[editKey] : row.price ?? "";
    const parsed = parseMoney(raw);
    return parsed.ok ? parsed.value : null;
  };

  /** Unique-tag counter for price-action undo snapshots (§8.4 — batch
   * operations never coalesce). */
  const priceActionCounterRef = useRef(0);

  const handlePriceAction = (action: PriceAction) => {
    // Computed OUTSIDE setEdits so the undo snapshot (Finding 10) is only
    // pushed when the action actually changed something — same batch-tag
    // pattern as the rectangle paste (grid-interactions.shared.ts).
    let applied = 0;
    const next = { ...edits };
    for (const row of visibleRows) {
      if (row.type !== "variant") continue;
      const current = currentPriceOf(row);
      if (action.id === "compareAtFromPrice") {
        if (current === null) continue;
        next[makeEditKey(row.id, "", "", VAR_COMPARE_AT_COLUMN_ID)] = formatMoneyForDisplay(current, uiLocale);
        applied++;
        continue;
      }
      const result = applyPriceAction(current ?? "", action);
      if (result === null) continue;
      // Store the LOCALIZED form — that is what the merchant reviews in the
      // cell; computeDiff normalizes it back before comparing/submitting.
      next[makeEditKey(row.id, "", "", VAR_PRICE_COLUMN_ID)] = formatMoneyForDisplay(result, uiLocale);
      applied++;
    }
    if (applied > 0) {
      undoStackRef.current = pushSnapshot(undoStackRef.current, {
        edits,
        tag: `price|${++priceActionCounterRef.current}`,
      });
      setEdits(next);
    }
    setPriceActionBanner(applied);
  };

  // ── "Translate missing" (Plan §6.5) ──────────────────────────────────────

  const foreignLocales = useMemo(
    () => data.locales.filter((l) => !l.primary).map((l) => ({ locale: l.locale, name: l.name })),
    [data.locales],
  );

  // Set when the shop has no foreign locale to translate INTO: the translate
  // action is then greyed out with this as its tooltip. `data.locales` is the
  // published set, so this covers "one language" and "secondary not published".
  // An EMPTY list means the loader's locale lookup failed (it catches to []),
  // not "one language" — never gate on that (CLAUDE.md single-language rules).
  const singleLocaleHint =
    data.locales.length > 0 && foreignLocales.length === 0
      ? t.common?.requiresSecondLanguage
      : undefined;

  // ── Per-cell actions (§ the content editor's field footer, per grid cell) ──

  /** Cells with a running action — keyed `${rowId}|${columnId}`. */
  const [busyCells, setBusyCells] = useState<Set<string>>(new Set());
  const [cellActionError, setCellActionError] = useState<string | null>(null);

  const setCellBusy = (key: string, busy: boolean) => {
    setBusyCells((prev) => {
      const next = new Set(prev);
      if (busy) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  /** Every action writes into the EDIT MAP, never to Shopify: the merchant
   * reviews the result in the grid and saves it through the normal pipeline.
   *
   * `epoch` is the value cellActionEpochRef held when the action STARTED. A
   * discard or a type switch bumps it, which is how a late AI response knows
   * its edit map no longer exists and drops itself. */
  const applyCellEdits = (entries: { key: string; value: string }[], epoch: number) => {
    if (entries.length === 0 || epoch !== cellActionEpochRef.current) return;
    // editsRef, not the `edits` of the render this handler closed over: a
    // fan-out awaits several AI calls, and anything the merchant typed while
    // it ran must be IN the undo snapshot — otherwise one Ctrl+Z silently
    // discards those keystrokes along with the translations.
    undoStackRef.current = pushSnapshot(undoStackRef.current, {
      edits: editsRef.current,
      tag: `cellAction|${++priceActionCounterRef.current}`,
    });
    setEdits((prev) => {
      const next = { ...prev };
      for (const entry of entries) next[entry.key] = entry.value;
      return next;
    });
  };

  /** POST to /api/ai and return the parsed payload, or null on failure.
   * Mirrors the single editor's guard (useUnifiedContentEditor): a session
   * timeout or a proxy error answers with an HTML page, and calling .json()
   * on it surfaces `Unexpected token '<'` instead of a usable message. */
  const postAi = async (body: Record<string, string>): Promise<Record<string, unknown> | null> => {
    try {
      const response = await fetch("/api/ai", {
        method: "POST",
        body: new URLSearchParams(body),
        headers: { Accept: "application/json" },
      });
      if (!response.headers.get("content-type")?.includes("application/json")) {
        await response.text().catch(() => "");
        setCellActionError(response.status === 401 ? b.cellActions.sessionExpired : b.errorGeneric);
        return null;
      }
      const payload = (await response.json()) as Record<string, unknown>;
      if (!payload.success) {
        setCellActionError(typeof payload.error === "string" ? payload.error : b.errorGeneric);
        return null;
      }
      return payload;
    } catch (err: unknown) {
      setCellActionError(err instanceof Error ? err.message : String(err));
      return null;
    }
  };

  // Kept current on every render; async cell actions read it instead of the
  // `edits` their closure captured.
  editsRef.current = edits;

  /** The row's PRIMARY value for a column — the source every translate/copy
   * action starts from, regardless of which language is on screen. */
  const primarySourceValue = (row: BulkRow, column: ColumnDescriptor): string => {
    const primaryKey = makeEditKey(row.id, "", "", column.id);
    return edits[primaryKey] ?? resolveCellValue(row, column).value;
  };

  const handleCellImprove = async (row: BulkRow, column: ColumnDescriptor) => {
    const cellKey = `${row.id}|${column.id}`;
    // The menu items are disabled while busy, but a double-activation can
    // still slip between the click and the re-render — and a second run means
    // a second provider call and a second (stale) undo snapshot.
    if (busyCells.has(cellKey)) return;
    const epoch = cellActionEpochRef.current;
    setCellActionError(null);
    setCellBusy(cellKey, true);
    const payload = await postAi({
      action: "generateAIText",
      contentType: BULK_ROW_TYPE_TO_AI_CONTENT_TYPE[row.type],
      itemId: row.id,
      fieldType: aiFieldKey(column),
      currentValue: valueFor(row, column),
      contextTitle: row.title,
      mainLanguage: localeNameByCode.get(locale || primaryLocaleCode) ?? "",
    });
    setCellBusy(cellKey, false);
    const generated = payload?.generatedContent;
    if (typeof generated === "string" && generated.trim() !== "") {
      applyCellEdits(
        [{ key: makeEditKey(row.id, locale, isForeign ? marketId : "", column.id), value: generated }],
        epoch,
      );
    }
  };

  /**
   * Target languages of a fan-out action. On the PRIMARY view that is every
   * active foreign language; in a FOREIGN view it is just the language on
   * screen — the same narrowing the content editor does, where the button
   * turns from "translate to all" into "translate from the primary language".
   */
  const fanOutTargets = (): string[] =>
    // A foreign view fills the language on screen — unless that language is
    // itself switched off. The bar lets a plain click switch TO a red locale
    // (viewing it is legitimate); writing into it from an action the red
    // button says is off would not be.
    isForeign ? (enabledLocales.includes(locale) ? [locale] : []) : enabledLocales;

  /**
   * Translates one cell into one locale. Option-values and list metafields are
   * "|"-joined lists of independent entries, so they go entry by entry and are
   * rejoined — handing the model the whole blob loses the separator or the
   * entry count, which either hard-fails the save (options carry a count
   * check) or silently collapses an N-entry list into one.
   */
  const translateCellValue = async (
    row: BulkRow,
    column: ColumnDescriptor,
    source: string,
    target: string,
  ): Promise<string | null> => {
    const request = async (text: string): Promise<string | null> => {
      const payload = await postAi({
        action: "translateField",
        contentType: BULK_ROW_TYPE_TO_AI_CONTENT_TYPE[row.type],
        itemId: row.id,
        fieldType: aiFieldKey(column),
        sourceText: text,
        targetLocale: target,
        primaryLocale: primaryLocaleCode,
      });
      const translated = payload?.translatedValue;
      return typeof translated === "string" && translated.trim() !== "" ? translated : null;
    };

    if (!isListShapedColumn(column)) return request(source);

    const parts = source.split(LIST_DISPLAY_SEPARATOR.trim()).map((part) => part.trim());
    const out: string[] = [];
    for (const part of parts) {
      if (part === "") return null;
      const translated = await request(part);
      // One failed entry fails the whole cell: a partially translated list
      // would be written as the complete list.
      if (translated === null) return null;
      out.push(translated.trim());
    }
    return out.join(LIST_DISPLAY_SEPARATOR);
  };

  const handleCellTranslateAll = async (row: BulkRow, column: ColumnDescriptor) => {
    const cellKey = `${row.id}|${column.id}`;
    if (busyCells.has(cellKey)) return;
    const source = primarySourceValue(row, column);
    if (source.trim() === "") {
      // The content editor says so explicitly in the same situation; a silent
      // return is indistinguishable from a broken button.
      setCellActionError(b.cellActions.emptySource);
      return;
    }
    const epoch = cellActionEpochRef.current;
    setCellActionError(null);
    setCellBusy(cellKey, true);
    const entries: { key: string; value: string }[] = [];
    const failed: string[] = [];
    for (const target of fanOutTargets()) {
      const translated = await translateCellValue(row, column, source, target);
      if (translated === null) {
        failed.push(localeNameByCode.get(target) ?? target);
        continue;
      }
      // In a foreign view the edit lands in the layer on screen (market
      // included); fanning out from the primary view writes GLOBAL
      // translations, because a market override is a per-cell decision.
      entries.push({ key: makeEditKey(row.id, target, isForeign ? marketId : "", column.id), value: translated });
    }
    setCellBusy(cellKey, false);
    applyCellEdits(entries, epoch);
    // postAi already reported the LAST error; without this the merchant cannot
    // tell WHICH languages of a multi-locale fan-out are missing.
    if (failed.length > 0 && epoch === cellActionEpochRef.current) {
      setCellActionError(`${b.cellActions.someLocalesFailed}: ${failed.join(", ")}`);
    }
  };

  const handleCellCopyAll = (row: BulkRow, column: ColumnDescriptor) => {
    const source = primarySourceValue(row, column);
    if (source.trim() === "") {
      setCellActionError(b.cellActions.emptySource);
      return;
    }
    setCellActionError(null);
    applyCellEdits(
      fanOutTargets().map((target) => ({
        key: makeEditKey(row.id, target, isForeign ? marketId : "", column.id),
        value: source,
      })),
      cellActionEpochRef.current,
    );
  };

  /**
   * Which actions a cell offers. Improve is FIELD columns only — the AI
   * prompts are built from the content configs' field definitions, and a
   * metafield/option key would produce a generic, weak prompt. Translate/copy
   * need a translatable column and at least one active foreign language.
   */
  const cellActionsFor = (row: BulkRow, column: ColumnDescriptor): BulkCellActions | undefined => {
    if (!resolveCellValue(row, column).editable) return undefined;
    if (column.inputType === "select" || column.inputType === "money" || column.inputType === "number") {
      return undefined;
    }
    const canImprove = column.kind === "field" && row.type !== "image";
    // Primary view: fan out into every active language. Foreign view: fill the
    // language on screen from the primary value — the editor's own narrowing.
    const canFanOut = column.translatable && fanOutTargets().length > 0;
    // A translatable column always OFFERS the two fan-out entries; when they
    // cannot run they stay visible and disabled with the reason (CLAUDE.md:
    // hiding them reads as "the feature is missing"). singleLocaleHint is
    // undefined when the locale lookup merely failed — never gate on that, and
    // do not then tell the merchant to use a language bar that is not on
    // screen either.
    const noLanguageReason = isForeign
      ? b.cellActions.viewedLanguageOff
      : shouldRenderBulkLanguageBar(data.locales.length)
        ? b.cellActions.noActiveLanguage
        : b.cellActions.noLanguagesAvailable;
    const fanOutDisabledReason = canFanOut
      ? undefined
      : column.translatable
        ? (singleLocaleHint ?? noLanguageReason)
        : undefined;
    // Copying a handle verbatim is guaranteed to fail the save: apply.server
    // rejects a handle translation identical to the primary handle, because
    // duplicate slugs across locales break Shopify's routing. Translating one
    // is fine — that is what produces a DIFFERENT slug.
    const copyDisabledReason =
      column.id === "field.handle" ? b.cellActions.handleCopyBlocked : undefined;
    if (!canImprove && !canFanOut && !fanOutDisabledReason) return undefined;
    return {
      ...(canImprove ? { onImprove: () => void handleCellImprove(row, column) } : {}),
      ...(canFanOut ? { onTranslateAll: () => void handleCellTranslateAll(row, column) } : {}),
      ...(canFanOut && !copyDisabledReason ? { onCopyAll: () => handleCellCopyAll(row, column) } : {}),
      ...(fanOutDisabledReason ? { fanOutDisabledReason } : {}),
      ...(copyDisabledReason ? { copyDisabledReason } : {}),
      busy: busyCells.has(`${row.id}|${column.id}`),
      // The content editor's own labels (t.products.*), not a second set:
      // the two surfaces offer the same three actions and must not drift
      // apart in wording. Primary view fans out ("Translate" / "Copy to all
      // languages"), a foreign view fills the language on screen.
      labels: {
        menu: b.cellActions.menu,
        busy: b.cellActions.busy,
        improve: t.products.aiImprove,
        translateAll: isForeign ? t.products.translateFromPrimary : t.products.translate,
        copyAll: isForeign ? t.products.copy : t.products.copyToAllLocales,
      },
    };
  };

  /** Whether this type has anything the translate page could work on at all.
   * Deliberately a coarse client check (the page itself applies the exact
   * candidate rule, translateCandidateColumns) — it only decides whether the
   * entry button is offered. */
  const hasTranslatableColumns = useMemo(
    () => allColumns.some((c) => c.translatable && (c.kind === "field" || c.kind === "mofield")),
    [allColumns],
  );

  /** "Translate missing" now lives on its own route (/app/bulk/translate) —
   * the candidate list with per-item/per-field checkboxes, paging and the
   * target-language bar does not fit a dialog. handleNavigate carries the
   * current view params (type, q, f, moType) over, so the page starts on the
   * merchant's current filter set. */
  const openTranslatePage = () => handleNavigate("/app/bulk/translate", { searchParams: new URLSearchParams({ tp: "1" }) });

  const toggleColumn = (columnId: string) => {
    setVisibleColumnIds((prev) => {
      const has = prev.includes(columnId);
      // Refuse the (MAX+1)th column — the picker disables the checkbox, this
      // is the defensive second half.
      if (!has && prev.length >= MAX_VISIBLE_COLUMNS) return prev;
      const next = has ? prev.filter((c) => c !== columnId) : [...prev, columnId];
      // Preserve canonical order — otherwise the column re-appears at the
      // end after re-checking it, which feels wrong to merchants used to a
      // stable layout.
      const ordered = allColumns.map((c) => c.id).filter((id) => next.includes(id));
      // Metaobject prefs are per-session only (see the visibleColumnIds
      // comment above) — persisting one type's field set would break every
      // other definition type.
      if (type !== "metaobject") saveColumnPrefs(type, ordered);
      return ordered;
    });
  };

  const resetColumns = () => {
    const def = defaultColumnsFor();
    setVisibleColumnIds(def);
    if (type !== "metaobject") saveColumnPrefs(type, def);
  };

  /** Column heading resolution: static columns via t.bulkEditor.columns.*,
   * metafield columns verbatim (shop-defined "namespace.key" — never
   * translated, §10.4), option columns via the {position} templates, img.alt
   * via its own key. */
  /** Column heading resolution — shared with the translate page so both label
   * the same column identically (labels.shared.ts). */
  const columnHeading = (col: ColumnDescriptor): string => bulkColumnHeading(col, b, data.currencyCode);

  const typeOptions = allowedTypes.map((rt) => ({ label: b.types[rt], value: rt }));

  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  const hasPrev = page > 1;
  const hasNext = to < total;

  /** Page info + prev/next, rendered BOTH above and below the grid (§3.3) so
   * the merchant sees the count and can page without scrolling to the bottom. */
  const renderPagination = () => (
    <InlineStack align="space-between" blockAlign="center">
      <Text as="span" variant="bodySm" tone="subdued">
        {b.pageInfo
          .replace("{from}", String(from))
          .replace("{to}", String(to))
          .replace("{total}", String(total))}
      </Text>
      <InlineStack gap="200">
        <Button disabled={!hasPrev} onClick={() => goToPage(page - 1)}>
          {b.prevPage}
        </Button>
        <Button disabled={!hasNext} onClick={() => goToPage(page + 1)}>
          {b.nextPage}
        </Button>
      </InlineStack>
    </InlineStack>
  );

  const saveError = saveFetcher.data && !saveFetcher.data.ok ? b.errorGeneric : null;
  const bulkError = bulkFetcher.data && !bulkFetcher.data.success ? bulkFetcher.data.error || b.errorGeneric : null;

  // Which columns actually render — the merchant's selection, restricted to
  // valid columns for this type (defensive against preserved localStorage
  // from a previous release listing a since-removed column).
  const activeColumns = useMemo(
    () =>
      visibleColumnIds
        // typeScopedColumns, not allColumns: a metaobject view must never
        // render another definition type's field columns (Phase 5).
        .map((id) => typeScopedColumns.find((c) => c.id === id))
        .filter((c): c is ColumnDescriptor => !!c),
    [visibleColumnIds, typeScopedColumns],
  );

  /** The columns the grid actually renders cells for (its own image-column
   * exclusion) — paste coordinates from BulkGrid arrive in THIS space. */
  const displayColumns = useMemo(() => activeColumns.filter((c) => c.id !== "image"), [activeColumns]);

  // Cell-granular failures (Plan §4.4): failures with a columnId mark exactly
  // that cell; row-level failures (single-mutation types) fall back to the
  // row's dirty cells.
  const { failuresByCell, rowLevelFailures } = useMemo(() => {
    const byCell = new Map<string, string>();
    const rowLevel = new Map<string, string>();
    for (const f of lastFailures) {
      // Only failures of the CURRENTLY shown language/market mark cells —
      // a failure in another locale stays visible via the banner (and its
      // edit is kept in the map for when the merchant switches back).
      if ((f.locale ?? "") !== locale || (f.marketId ?? "") !== marketId) continue;
      if (f.columnId) byCell.set(`${f.rowId}|${f.columnId}`, f.message);
      else rowLevel.set(f.rowId, f.message);
    }
    return { failuresByCell: byCell, rowLevelFailures: rowLevel };
  }, [lastFailures, locale, marketId]);

  const failedRowCount = useMemo(
    () => new Set(lastFailures.map((f) => f.rowId)).size,
    [lastFailures],
  );

  // Client-side money validation (Finding 3): negative/unparseable and —
  // new — AMBIGUOUS amounts ("1.299") mark their cell immediately, localized,
  // instead of first surfacing after a failed save. Money columns are
  // primary-only (translatable:false), so this never collides with the
  // locale-filtered server failures above; a server failure for the same
  // cell wins (it reflects what actually happened on save).
  const moneyErrorsByCell = useMemo(() => {
    const map = new Map<string, string>();
    if (isForeign) return map;
    const moneyColumnIds = new Set(allColumns.filter((c) => c.inputType === "money").map((c) => c.id));
    if (moneyColumnIds.size === 0) return map;
    for (const [key, value] of Object.entries(edits)) {
      const parsed = parseEditKey(key);
      if (!parsed || parsed.locale !== "" || !moneyColumnIds.has(parsed.columnId)) continue;
      const result = parseMoney(value);
      if (result.ok) continue;
      map.set(
        `${parsed.rowId}|${parsed.columnId}`,
        result.error === "ambiguous"
          ? b.moneyErrors.ambiguous
          : result.error === "negative"
            ? b.moneyErrors.negative
            : b.moneyErrors.invalid,
      );
    }
    return map;
  }, [edits, allColumns, isForeign, b]);

  const cellFailuresForGrid = useMemo(() => {
    if (moneyErrorsByCell.size === 0) return failuresByCell;
    const merged = new Map(moneyErrorsByCell);
    // Server-reported failures override the local pre-save validation.
    for (const [key, message] of failuresByCell) merged.set(key, message);
    return merged;
  }, [failuresByCell, moneyErrorsByCell]);

  // Banner list: several failed cells of one row often share one root cause —
  // dedupe by (row, message) so the banner stays readable.
  const bannerFailures = useMemo(() => {
    const seen = new Set<string>();
    return lastFailures.filter((f) => {
      const key = `${f.rowId}|${f.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [lastFailures]);

  const visibleRows = onlyChanged ? mergedRows.filter((r) => dirtyRowIds.has(r.id)) : mergedRows;

  // >100-variant hint (Plan §5.1): the sync caps at variants(first:100) —
  // point merchants at the Shopify admin for the remainder.
  const showMoreVariantsHint = type === "variant" && rows.some((r) => (r as BulkRow).hasMoreVariants);


  /** The shop's primary locale code — the AI endpoints want the real code,
   * not the grid's "" sentinel. */
  const primaryLocaleCode = data.locales.find((l) => l.primary)?.locale ?? "";

  /** Published foreign locales minus the ones switched off. */
  const enabledLocales = useMemo(
    () => data.locales.filter((l) => !l.primary && !disabledLocales.includes(l.locale)).map((l) => l.locale),
    [data.locales, disabledLocales],
  );

  const handleToggleLocale = (loc: string) => {
    setDisabledLocales((prev) => (prev.includes(loc) ? prev.filter((l) => l !== loc) : [...prev, loc]));
  };

  const marketOptions = [
    { label: b.allMarkets, value: "" },
    ...data.markets.map((m) => ({ label: m.name, value: m.id })),
  ];

  // aria-live status for screen readers: announce save results (§2 ARIA).
  const liveMessage =
    lastSavedCount !== null
      ? failedRowCount > 0
        ? b.saveSuccessWithFailures
            .replace("{saved}", String(lastSavedCount))
            .replace("{failed}", String(failedRowCount))
        : b.saveSuccess.replace("{count}", String(lastSavedCount))
      : "";

  return (
    <div style={{ padding: "1rem", maxWidth: "1600px", margin: "0 auto", width: "100%", boxSizing: "border-box" }}>
      <PlanAccessGate minPlan="basic">
        {gated ? null : (
          <BlockStack gap="400">
            <BlockStack gap="100">
              <Text as="h2" variant="headingLg">
                {b.title}
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                {b.intro}
              </Text>
            </BlockStack>

            <Card>
              <BlockStack gap="300">
                <div
                  aria-live="polite"
                  role="status"
                  style={{
                    position: "absolute",
                    width: 1,
                    height: 1,
                    padding: 0,
                    margin: -1,
                    overflow: "hidden",
                    clip: "rect(0 0 0 0)",
                    whiteSpace: "nowrap",
                    border: 0,
                  }}
                >
                  {liveMessage}
                </div>

                {queuedBanner && <Banner tone="success">{b.queuedBanner}</Banner>}
                {bulkError && <Banner tone="critical">{bulkError}</Banner>}
                {saveError && <Banner tone="critical">{saveError}</Banner>}
                {overBudgetBanner && (
                  <Banner tone="critical">
                    {b.budgetExceeded
                      .replace("{calls}", String(estimatedCalls))
                      .replace("{max}", String(MAX_TASK_CALLS))}
                  </Banner>
                )}
                {cellLimitBanner !== null && (
                  <Banner tone="critical" onDismiss={() => setCellLimitBanner(null)}>
                    {b.cellLimitExceeded
                      .replace("{cells}", String(cellLimitBanner))
                      .replace("{max}", String(MAX_BULK_TASK_ITEMS))}
                  </Banner>
                )}
                {otherLocaleComboCount > 0 && (
                  <Banner tone="info">
                    {b.unsavedOtherLocales.replace("{count}", String(otherLocaleComboCount))}
                  </Banner>
                )}
                {offPageEditCount > 0 && (
                  <Banner tone="info">
                    {b.offPageEdits.replace("{count}", String(offPageEditCount))}
                  </Banner>
                )}
                {exportError && (
                  <Banner tone="critical" onDismiss={() => setExportError(null)}>
                    {exportError}
                  </Banner>
                )}
                {importError && (
                  <Banner tone="critical" onDismiss={() => setImportError(null)}>
                    {importError}
                  </Banner>
                )}
                {pasteBanner && (
                  <Banner
                    tone={pasteBanner.applied > 0 ? "success" : "info"}
                    onDismiss={() => setPasteBanner(null)}
                    action={
                      pasteBanner.applied > 0
                        ? { content: b.paste.undo, onAction: undoPaste }
                        : undefined
                    }
                  >
                    {(pasteBanner.skipped > 0 ? b.paste.appliedWithSkipped : b.paste.applied)
                      .replace("{rows}", String(pasteBanner.rows))
                      .replace("{cols}", String(pasteBanner.cols))
                      .replace("{skipped}", String(pasteBanner.skipped))}
                  </Banner>
                )}
                {cellActionError && (
                  <Banner tone="critical" onDismiss={() => setCellActionError(null)}>
                    {cellActionError}
                  </Banner>
                )}
                {data.mediaLibraryNeverSynced && (
                  <Banner
                    tone="info"
                    action={{
                      content: b.mediaLibrary.syncButton,
                      onAction: () => syncMediaLibraryFetcher.submit({}, { method: "post", action: "/api/sync-media-library" }),
                      loading: syncMediaLibraryFetcher.state !== "idle",
                    }}
                  >
                    {b.mediaLibrary.neverSynced}
                  </Banner>
                )}
                {syncMediaLibraryFetcher.state === "idle" &&
                  syncMediaLibraryFetcher.data &&
                  !(syncMediaLibraryFetcher.data as { success?: boolean }).success && (
                    <Banner tone="critical">
                      {(syncMediaLibraryFetcher.data as { error?: string }).error || b.errorGeneric}
                    </Banner>
                  )}
                {data.translationFilterApproximate && (
                  <Banner tone="warning">{b.filterApproximateBanner}</Banner>
                )}
                {showMoreVariantsHint && <Banner tone="info">{b.moreVariantsBanner}</Banner>}
                {priceActionBanner !== null && (
                  <Banner
                    tone={priceActionBanner > 0 ? "success" : "info"}
                    onDismiss={() => setPriceActionBanner(null)}
                  >
                    {b.priceActions.applied.replace("{count}", String(priceActionBanner))}
                  </Banner>
                )}
                {lastSavedCount !== null && (
                  <Banner tone={failedRowCount > 0 ? "warning" : "success"}>
                    {failedRowCount > 0
                      ? b.saveSuccessWithFailures
                          .replace("{saved}", String(lastSavedCount))
                          .replace("{failed}", String(failedRowCount))
                      : b.saveSuccess.replace("{count}", String(lastSavedCount))}
                  </Banner>
                )}
                {bannerFailures.length > 0 && (
                  <Banner tone="critical" title={b.saveFailuresTitle}>
                    <BlockStack gap="100">
                      {bannerFailures.map((f) => (
                        <Text as="p" variant="bodySm" key={`${f.rowType}:${f.rowId}:${f.columnId ?? ""}`}>
                          {f.rowId}: {f.message}
                        </Text>
                      ))}
                    </BlockStack>
                  </Banner>
                )}

                <InlineStack align="space-between" blockAlign="end" gap="200" wrap>
                  <InlineStack gap="200" blockAlign="end" wrap>
                    <div style={{ maxWidth: "220px", flex: "0 0 220px" }}>
                      <Select label={b.typeLabel} options={typeOptions} value={type} onChange={handleTypeChange} />
                    </div>
                    {type === "metaobject" && data.metaobjectTypes.length > 0 && (
                      <div style={{ maxWidth: "220px", flex: "0 0 200px" }}>
                        <Select
                          label={b.metaobjectTypeLabel}
                          options={data.metaobjectTypes.map((t) => ({ label: t.name, value: t.type }))}
                          value={data.moType}
                          onChange={handleMoTypeChange}
                        />
                      </div>
                    )}
                    {/* Language buttons instead of a dropdown, with the
                        editors' Ctrl+click semantics — see BulkLanguageBar. */}
                    {shouldRenderBulkLanguageBar(data.locales.length) && (
                      <BulkLanguageBar
                        locales={data.locales}
                        currentLocale={locale}
                        enabledLocales={enabledLocales}
                        onSelect={handleLocaleChange}
                        onToggle={handleToggleLocale}
                        appLocale={uiLocale}
                        strings={{
                          groupLabel: b.languageBarLabel,
                          primarySuffix: b.primaryLocaleSuffix,
                          enabledHint: b.languageBar.enabledHint,
                          disabledHint: b.languageBar.disabledHint,
                        }}
                      />
                    )}
                    {isForeign && data.markets.length > 0 && (
                      <div style={{ maxWidth: "220px", flex: "0 0 200px" }}>
                        <Select
                          label={b.marketLabel}
                          options={marketOptions}
                          value={marketId}
                          onChange={handleMarketChange}
                        />
                      </div>
                    )}
                  </InlineStack>
                  <InlineStack gap="200" blockAlign="end">
                    {type === "variant" && !isForeign && (
                      <PriceActionsPopover
                        disabled={visibleRows.length === 0 || saving}
                        strings={{
                          button: b.priceActions.button,
                          actionLabel: b.priceActions.actionLabel,
                          amountLabel: b.priceActions.amountLabel,
                          apply: b.priceActions.apply,
                          actions: b.priceActions.actions,
                        }}
                        onApply={handlePriceAction}
                      />
                    )}
                    {/* Single-language shop: the button stays visible but
                        greyed out with the reason (CLAUDE.md single-language
                        rules) — hiding it reads as "the feature is missing". */}
                    {data.aiTranslateAllowed && hasTranslatableColumns && (
                      <DisabledActionTooltip hint={singleLocaleHint}>
                        <Button onClick={openTranslatePage} disabled={!!singleLocaleHint}>
                          {b.translateMissing.button}
                        </Button>
                      </DisabledActionTooltip>
                    )}
                    <Button onClick={handleExport} loading={exportFetcher.state !== "idle"}>
                      {b.csv.exportButton}
                    </Button>
                    {data.csvImportAllowed ? (
                      <Button
                        onClick={() => importFileRef.current?.click()}
                        loading={importFetcher.state !== "idle"}
                      >
                        {b.csv.importButton}
                      </Button>
                    ) : (
                      // Pro gate (§10.7) — the button stays visible but
                      // disabled with the plan hint; the server enforces the
                      // same gate in app.bulk.import.tsx.
                      <Tooltip content={b.csv.importProTooltip}>
                        <Button disabled>{b.csv.importButton}</Button>
                      </Tooltip>
                    )}
                    <Button onClick={() => setPickerOpen(true)}>{b.chooseColumns}</Button>
                  </InlineStack>
                </InlineStack>
                <input
                  ref={importFileRef}
                  type="file"
                  accept=".csv,text/csv,text/plain"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleImportFile(file);
                    // Selecting the SAME file again must re-fire onChange.
                    e.target.value = "";
                  }}
                />

                <FilterBar
                  search={search}
                  onSearchCommit={handleSearchCommit}
                  filters={filters}
                  onFiltersChange={handleFiltersChange}
                  showTranslationFilter={locale !== ""}
                  filterSet={filterSetForType(type)}
                  pageSize={pageSize}
                  onPageSizeChange={handlePageSizeChange}
                  onlyChanged={onlyChanged}
                  onOnlyChangedChange={setOnlyChanged}
                  strings={{
                    searchPlaceholder:
                      type === "variant"
                        ? b.searchPlaceholderVariant
                        : type === "policy"
                          ? b.searchPlaceholderPolicy
                          : b.searchPlaceholder,
                    searchLabel: b.searchLabel,
                    filtersLabel: b.filtersLabel,
                    filterMissingSeoTitle: b.filters.missingSeoTitle,
                    filterMissingSeoDescription: b.filters.missingSeoDescription,
                    filterMissingTranslation: b.filters.missingTranslation,
                    filterMissingSku: b.filters.missingSku,
                    filterMissingPrice: b.filters.missingPrice,
                    filterCompareAtNotAbovePrice: b.filters.compareAtNotAbovePrice,
                    filterMissingAltText: b.filters.missingAltText,
                    pageSizeLabel: b.pageSizeLabel,
                    onlyChangedLabel: b.onlyChanged,
                  }}
                />

                {total > 0 && renderPagination()}

                {visibleRows.length === 0 ? (
                  <Text as="p" tone="subdued">
                    {onlyChanged && rows.length > 0 ? b.noChangedRows : b.noRows}
                  </Text>
                ) : (
                  <BlockStack gap="200">
                    {/* Capture wrapper: Ctrl/Cmd+Z inside the grid = edit-map
                        history (§8.4), scoped so search/modals keep native
                        undo. */}
                    {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
                    <div onKeyDownCapture={handleUndoKeyDown}>
                    <BulkGrid
                      rows={visibleRows}
                      type={type}
                      columns={activeColumns}
                      valueFor={valueFor}
                      isDirty={isDirtyCell}
                      setEdit={setEdit}
                      isForeignLocale={isForeign}
                      ghostFor={ghostFor}
                      translationStatus={cellTranslationStatus}
                      translationTooltip={cellTranslationTooltip}
                      notTranslatableTooltip={b.notTranslatableTooltip}
                      failuresByCell={cellFailuresForGrid}
                      rowLevelFailures={rowLevelFailures}
                      sort={sort}
                      onSortToggle={handleSortToggle}
                      openInEditorLabel={b.openInEditor}
                      cellActions={cellActionsFor}
                      onPreviewImage={setPreviewRow}
                      previewImageLabel={b.imagePreview.open}
                      onOpenInEditor={(row) =>
                        handleNavigate(TYPE_EDITOR_PATH[row.type], {
                          // Variant and image rows open their PRODUCT. A library
                          // image belongs to none — open the list unselected
                          // instead of sending a MediaImage gid as a product id.
                          ...(row.type === "image" && !row.productId
                            ? {}
                            : { searchParams: new URLSearchParams({ select: row.productId ?? row.id }) }),
                        })
                      }
                      columnHeading={columnHeading}
                      statusOptions={b.statusOptions}
                      handleWarning={b.handleWarning}
                      readOnlyTooltips={{
                        column: b.readOnlyTooltip,
                        richText: b.readOnlyReasons.richText,
                        linkedOption: b.readOnlyReasons.linkedOption,
                        missingOption: b.readOnlyReasons.missingOption,
                        legacyOptionValues: b.readOnlyReasons.legacyOptionValues,
                        missingImage: b.readOnlyReasons.missingImage,
                        missingMediaId: b.readOnlyReasons.missingMediaId,
                        wrongMetaobjectType: b.readOnlyReasons.wrongMetaobjectType,
                        listSeparatorInValue: b.readOnlyReasons.listSeparatorInValue,
                      }}
                      sortButtonLabel={b.sortButtonLabel}
                      caption={b.types[type]}
                      onResetCell={resetCell}
                      onPasteRect={handlePasteRect}
                    />
                    </div>

                    {renderPagination()}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>

            {/* Native App Bridge save bar — same one used by the content
                editors (see AppSaveBar). Renders above the embedded app,
                outside the iframe, and satisfies the Built-for-Shopify
                requirement to use Shopify's native save/discard UI instead
                of custom buttons. */}
            <AppSaveBar
              hasChanges={dirty.length > 0}
              onSave={handleSave}
              onDiscard={handleDiscard}
              loading={saving}
              saveText={b.saveButton}
              discardText={b.discardButton}
            />

            {/* Image preview: the grid thumbnail is far too small to judge an
                alt text against, so the image cell opens it large. The jump to
                the full editor lives here too — it used to be the thumbnail's
                own click target. */}
            <Modal
              open={previewRow !== null}
              onClose={() => setPreviewRow(null)}
              title={previewRow?.imageUsage || previewRow?.productTitle || previewRow?.title || b.imagePreview.title}
              secondaryActions={[{ content: b.imagePreview.close, onAction: () => setPreviewRow(null) }]}
              {...(previewRow && (previewRow.type !== "image" || previewRow.productId)
                ? {
                    primaryAction: {
                      content: b.openInEditor,
                      onAction: () => {
                        const row = previewRow;
                        setPreviewRow(null);
                        handleNavigate(TYPE_EDITOR_PATH[row.type], {
                          searchParams: new URLSearchParams({ select: row.productId ?? row.id }),
                        });
                      },
                    },
                  }
                : {})}
            >
              <Modal.Section>
                <BlockStack gap="300" inlineAlign="center">
                  {previewRow?.imageUrl && (
                    <img
                      src={previewRow.imageUrl}
                      alt={previewRow.imageAlt ?? previewRow.altText ?? ""}
                      style={{ maxWidth: "100%", maxHeight: "60vh", objectFit: "contain" }}
                    />
                  )}
                  {/* The alt text is what this grid is about. Image rows carry
                      it as their own (translatable) cell — every other type
                      only has the thumbnail's alt for context. */}
                  <Text as="p" variant="bodySm" tone="subdued" alignment="center">
                    {(previewRow?.type === "image"
                      ? valueFor(previewRow, ALT_PREVIEW_COLUMN)
                      : (previewRow?.imageAlt ?? "")) || b.imagePreview.noAlt}
                  </Text>
                </BlockStack>
              </Modal.Section>
            </Modal>

            <CsvImportModal
              open={importPreview !== null}
              preview={importPreview}
              columnLabel={(columnId) => {
                const column = allColumns.find((c) => c.id === columnId);
                return column ? columnHeading(column) : columnId;
              }}
              overBudget={importOverBudget}
              maxCalls={MAX_TASK_CALLS}
              overCellLimit={importOverCellLimit}
              maxCells={MAX_BULK_TASK_ITEMS}
              busy={saving}
              onConfirm={handleImportConfirm}
              onCancel={() => setImportPreview(null)}
              strings={{
                title: b.csv.preview.title,
                summary: b.csv.preview.summary,
                noChanges: b.csv.preview.noChanges,
                clearHint: b.csv.preview.clearHint,
                unknownColumns: b.csv.preview.unknownColumns,
                ignoredColumns: b.csv.preview.ignoredColumns,
                rowErrorsTitle: b.csv.preview.rowErrorsTitle,
                rowErrorMissingId: b.csv.preview.rowErrorMissingId,
                rowErrorUnknownId: b.csv.preview.rowErrorUnknownId,
                rowErrorUnknownHandle: b.csv.preview.rowErrorUnknownHandle,
                rowErrorAmbiguousHandle: b.csv.preview.rowErrorAmbiguousHandle,
                moreRowErrors: b.csv.preview.moreRowErrors,
                changesHeading: b.csv.preview.changesHeading,
                moreChanges: b.csv.preview.moreChanges,
                emptyValue: b.csv.preview.emptyValue,
                overBudget: b.budgetExceeded,
                overCellLimit: b.cellLimitExceeded,
                apply: b.csv.preview.apply,
                cancel: b.csv.preview.cancel,
              }}
            />

            <ColumnPickerModal
              open={pickerOpen}
              onClose={() => setPickerOpen(false)}
              allColumns={typeScopedColumns}
              visibleColumnIds={visibleColumnIds}
              onToggle={toggleColumn}
              onReset={resetColumns}
              columnLabel={columnHeading}
              strings={{
                title: b.columnPicker.title,
                intro: b.columnPicker.intro,
                done: b.columnPicker.done,
                reset: b.columnPicker.reset,
                limitHint: b.columnPicker.limitHint,
                searchPlaceholder: b.columnPicker.searchPlaceholder,
                noMatches: b.columnPicker.noMatches,
                groups: b.columnPicker.groups,
              }}
            />
          </BlockStack>
        )}
      </PlanAccessGate>
    </div>
  );
}
