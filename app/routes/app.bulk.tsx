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

import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useRevalidator } from "@remix-run/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Card, BlockStack, InlineStack, Text, Button, Select, Banner } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { PlanAccessGate } from "../components/PlanAccessGate";
import { AppSaveBar } from "../components/AppSaveBar";
import { getFormString, getFormJSON } from "../utils/form-data.utils";
import { meetsPlan } from "../utils/planUtils";
import { PLAN_CONFIG, type Plan } from "../config/plans";
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
  BULK_ROW_TYPES,
  BULK_ROW_TYPE_TO_CONTENT_TYPE,
  BULK_FILTER_IDS,
  BULK_PAGE_SIZES,
  BULK_DEFAULT_PAGE_SIZE,
  MAX_SYNC_SAVE,
  MAX_TASK_CALLS,
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
  type PriceAction,
  type ProductColumnCaps,
} from "../services/bulk-editor/columns.shared";
import { debugLog } from "../utils/debug";
// Server-only I/O — referenced exclusively from loader/action, which Remix
// strips from the client build.
import { loadBulkRows, getShopCurrencyCode } from "../services/bulk-editor/load.server";
import { applyBulkDiff } from "../services/bulk-editor/apply.server";
import { findInvalidLocaleOrMarket } from "../services/bulk-editor/translations.server";
import {
  buildServerColumnsByType,
  loadProductMetafieldColumnSpecs,
  productColumnCapsForPlan,
} from "../services/bulk-editor/columns.server";
import { BulkGrid } from "../components/bulk-editor/BulkGrid";
import { ColumnPickerModal } from "../components/bulk-editor/ColumnPickerModal";
import { FilterBar } from "../components/bulk-editor/FilterBar";
import { PriceActionsPopover } from "../components/bulk-editor/PriceActionsPopover";
import {
  TranslateMissingModal,
  type TranslateMissingMode,
} from "../components/bulk-editor/TranslateMissingModal";

async function loadPlan(db: any, shop: string): Promise<Plan> {
  const settings = await db.aISettings.findUnique({
    where: { shop },
    select: { subscriptionPlan: true },
  });
  return (settings?.subscriptionPlan || "free") as Plan;
}

/** Row types the shop's plan may edit here: the supported types intersected
 * with PLAN_CONFIG[plan].contentTypes (Plan §3.4 — fixes the §0.4
 * inconsistency where Basic shops were offered articles). */
function allowedTypesForPlan(plan: Plan): BulkRowType[] {
  const contentTypes = PLAN_CONFIG[plan].contentTypes as string[];
  return BULK_ROW_TYPES.filter((t) => contentTypes.includes(BULK_ROW_TYPE_TO_CONTENT_TYPE[t]));
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
  /** Shop-specific metafield columns (Plan §4.1) — plain specs; the client
   * builds the descriptors via buildColumnsForType. */
  metafieldColumns: MetafieldColumnSpec[];
  /** Plan-gated dynamic product column capabilities (Plan §10.7). */
  productCaps: ProductColumnCaps;
  /** PUBLISHED shop locales, primary first (Phase 4 language selector). */
  locales: { locale: string; name: string; primary: boolean }[];
  /** ACTIVE markets (loadMarkets gates on status === 'ACTIVE' — CLAUDE.md). */
  markets: { id: string; name: string }[];
  /** Pro gate for the "translate missing" AI action (Plan §10.7). */
  aiTranslateAllowed: boolean;
  /** Shop-wide currency (Plan §5.2), shown as a money-column header suffix.
   * "" when unknown or not a variant view. */
  currencyCode: string;
}

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
      metafieldColumns: [],
      productCaps: NO_PRODUCT_CAPS,
      locales: [],
      markets: [],
      aiTranslateAllowed: false,
      currencyCode: "",
    });
  }

  const allowedTypes = allowedTypesForPlan(plan);
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

  const [{ rows, total, translationFilterApproximate }, currencyCode] = await Promise.all([
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
    metafieldColumns,
    productCaps,
    locales,
    markets,
    aiTranslateAllowed: meetsPlan(plan, "pro"),
    currencyCode,
  });
};

type ActionResult =
  | { ok: true; saved: number; failures: BulkFailure[] }
  | { ok: false; error: string };

export const action = async ({ request }: ActionFunctionArgs): Promise<Response> => {
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
  const allowedTypes = allowedTypesForPlan(plan);
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

  const result = await applyBulkDiff({ db, shop, admin, columnsByType }, diff);
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
};

interface BulkFetcherResult {
  success: boolean;
  error?: string;
  taskId?: string;
  total?: number;
}

interface TranslateFetcherResult {
  success: boolean;
  error?: string;
  taskId?: string;
  total?: number;
  /** True when the filter set has no empty cells to translate. */
  none?: boolean;
}

/** Task.result payload of a completed bulkEditorTranslate run (see
 * bulk-editor-translate.handler.ts). */
interface TranslateTaskResult {
  mode: "preview" | "save";
  suggestions?: BulkDiffEntry[];
  failures?: { rowId: string; columnId?: string; message: string }[];
  saved?: number;
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
function loadColumnPrefs(type: BulkRowType, allColumns: ColumnDescriptor[]): string[] {
  if (typeof window === "undefined") return DEFAULT_COLUMNS[type];
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
  return DEFAULT_COLUMNS[type];
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
  const translateFetcher = useFetcher<TranslateFetcherResult>();

  const [edits, setEdits] = useState<Record<string, string>>({});
  const [lastFailures, setLastFailures] = useState<BulkFailure[]>([]);
  const [lastSavedCount, setLastSavedCount] = useState<number | null>(null);
  const [queuedBanner, setQueuedBanner] = useState(false);
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [overBudgetBanner, setOverBudgetBanner] = useState(false);
  /** "{count} cells updated" feedback after a price bulk action (Plan §5.6). */
  const [priceActionBanner, setPriceActionBanner] = useState<number | null>(null);
  const [translateModalOpen, setTranslateModalOpen] = useState(false);
  const [translateBanner, setTranslateBanner] = useState<
    | { kind: "running" }
    | { kind: "applied"; count: number }
    | { kind: "saved"; count: number; failed: number }
    | { kind: "none" }
    | { kind: "failed"; message?: string }
    | null
  >(null);
  /** Running bulkEditorTranslate task being polled (Plan §6.5 preview flow). */
  const [translateTask, setTranslateTask] = useState<{ id: string; mode: TranslateMissingMode } | null>(null);

  /** True when a foreign locale is selected — the grid then edits the
   * translation layer (Plan §1.3: language is a dimension, not a 2nd editor). */
  const isForeign = locale !== "";

  // Foreign baselines seen so far, accumulated ACROSS locale/market switches:
  // `rowId → (localeKey → value)`. computeDiff compares an edit against the
  // loaded translation of ITS OWN locale — without this accumulation,
  // switching locales would drop the baselines of the previous locale and a
  // deliberate clear there would silently stop counting as a change.
  const foreignBaselinesRef = useRef<Record<string, Record<string, string>>>({});

  // Full column universe for the current type: static per-type columns plus
  // (for products) the shop's enabled metafield columns, the option column
  // pairs and the main-image alt-text column (Phase 2). The specs come from
  // the loader; the descriptors are built client-side with the same pure
  // builder the server uses for validation.
  const allColumns = useMemo(
    () => buildColumnsForType(type, data.metafieldColumns, data.productCaps),
    [type, data.metafieldColumns, data.productCaps],
  );

  // Column visibility — merchant-picked, persisted per type. Rehydrated
  // whenever `type` changes so switching Products↔Pages restores each
  // type's saved layout (not a shared one that would leak fields).
  const [visibleColumnIds, setVisibleColumnIds] = useState<string[]>(() =>
    loadColumnPrefs(type, allColumns),
  );
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    setVisibleColumnIds(loadColumnPrefs(type, allColumns));
    // Re-run on type switches only — allColumns identity churns on every
    // revalidation but its CONTENT for a given type is stable, and the
    // rendered set is re-sanitized against it in activeColumns anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);

  // A navigation to a different page/type/filter set starts from a clean
  // slate — stale edits from a different page would silently target the
  // wrong rows otherwise. Deliberately keyed on the URL state rather than
  // [rows]: a partial-failure save calls revalidator.revalidate() to refresh
  // `rows` WITHOUT navigating, and that must NOT wipe the edits still held
  // for the rows that failed (see the saveFetcher effect below).
  // locale/marketId are deliberately NOT in this list — switching the
  // language/market KEEPS unsaved edits (they live under their own key
  // segments, Plan §6.4).
  useEffect(() => {
    setEdits({});
    setLastFailures([]);
    setLastSavedCount(null);
    setOverBudgetBanner(false);
    setPriceActionBanner(null);
    foreignBaselinesRef.current = {};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, page, pageSize, search, data.sort, filters.join(",")]);

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
    return (rows as BulkRow[]).map((row) => {
      const previous = acc[row.id];
      if (!previous && !row.foreignValues) return row;
      const merged: Record<string, string> = {};
      for (const [key, value] of Object.entries(previous ?? {})) {
        if (loadedPrefixes.some((prefix) => key.startsWith(prefix))) continue;
        merged[key] = value;
      }
      Object.assign(merged, row.foreignValues ?? {});
      acc[row.id] = merged;
      return { ...row, foreignValues: merged };
    });
  }, [rows, locale, marketId]);

  const dirty = useMemo(() => computeDiff(mergedRows, allColumns, edits), [mergedRows, allColumns, edits]);
  const dirtyRowIds = useMemo(() => new Set(dirty.map((d) => d.rowId)), [dirty]);

  // Variant rows: rowId → productId for the per-product call estimate
  // (Plan §5.4 — one productVariantsBulkUpdate per product).
  const variantProductIdByRowId = useMemo(() => {
    if (type !== "variant") return undefined;
    const map: Record<string, string> = {};
    for (const row of mergedRows) {
      if (row.productId) map[row.id] = row.productId;
    }
    return map;
  }, [type, mergedRows]);

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
      // Keep only the edits of CELLS that failed — their typed values stay in
      // the form for retry (Plan §0.2 no. 5, refined to cell granularity in
      // §4.4); everything saved is dropped. Row-level failures (no columnId —
      // single-mutation types) keep the whole row's edits.
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
      setEdits((prev) => {
        const next: Record<string, string> = {};
        for (const [key, value] of Object.entries(prev)) {
          const parsed = parseEditKey(key);
          if (!parsed) continue;
          if (
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
    setEdits((prev) => ({ ...prev, [editKeyFor(row, column)]: value }));
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

  /** Navigate with updated grid params (all state is in the URL, §3.3).
   * handleNavigate merges with the current params, so untouched ones —
   * including Shopify's host/shop/embedded — survive. */
  const navigateGrid = (overrides: Record<string, string>) => {
    setQueuedBanner(false);
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(overrides)) params.set(key, value);
    handleNavigate("/app/bulk", { searchParams: params, replace: true });
  };

  const handleTypeChange = (value: string) =>
    navigateGrid({ type: value, page: "1", sort: "", f: filters.join(",") });
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

  const handleSave = () => {
    if (dirty.length === 0 || saving) return;
    // §10.1: report a budget overrun BEFORE submitting — not 20 minutes into
    // a task run.
    if (estimatedCalls > MAX_TASK_CALLS) {
      setOverBudgetBanner(true);
      return;
    }
    setOverBudgetBanner(false);
    // §10.5: summary only — never cell values.
    debugLog.bulkDiff("saving", {
      cells: dirty.length,
      rows: new Set(dirty.map((d) => d.rowId)).size,
      calls: estimatedCalls,
      path: dirty.length > MAX_SYNC_SAVE ? "task" : "sync",
    });
    if (dirty.length > MAX_SYNC_SAVE) {
      // `contentType` must be a VALID_CONTENT_TYPES value ("products", not
      // "product") — /api/ai validates it before dispatching to the handler.
      bulkFetcher.submit(
        {
          action: "seoBulkMeta",
          contentType: BULK_ROW_TYPE_TO_CONTENT_TYPE[type],
          diff: JSON.stringify(dirty),
        },
        { method: "post", action: "/api/ai" },
      );
    } else {
      saveFetcher.submit(
        { actionType: "saveBulkEdits", diff: JSON.stringify(dirty) },
        { method: "post" },
      );
    }
  };

  const handleDiscard = () => {
    setEdits({});
    setLastFailures([]);
    setLastSavedCount(null);
    setOverBudgetBanner(false);
    setPriceActionBanner(null);
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

  const handlePriceAction = (action: PriceAction) => {
    let applied = 0;
    setEdits((prev) => {
      const next = { ...prev };
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
      return next;
    });
    setPriceActionBanner(applied);
  };

  // ── "Translate missing" (Plan §6.5) ──────────────────────────────────────

  const foreignLocales = useMemo(
    () => data.locales.filter((l) => !l.primary).map((l) => ({ locale: l.locale, name: l.name })),
    [data.locales],
  );

  /** AI-translatable columns: base FIELD columns only (Phase-4 scope) —
   * handle is deliberately excluded (bulk-generating URL slugs is a guided
   * single-editor concern); metafield/option/alt columns are Phase 4b. */
  const aiColumns = useMemo(
    () => allColumns.filter((c) => c.kind === "field" && c.translatable && c.id !== "field.handle"),
    [allColumns],
  );

  /** Mode of the just-requested translate run — the poller needs it before
   * the task result arrives. */
  const pendingTranslateModeRef = useRef<TranslateMissingMode>("preview");

  const handleTranslateStart = (choice: { columnId: string; targetLocale: string; mode: TranslateMissingMode }) => {
    setTranslateModalOpen(false);
    setTranslateBanner(null);
    translateFetcher.submit(
      {
        action: "bulkEditorTranslate",
        contentType: BULK_ROW_TYPE_TO_CONTENT_TYPE[type],
        rowType: type,
        columnId: choice.columnId,
        targetLocale: choice.targetLocale,
        mode: choice.mode,
        search,
        filters: filters.join(","),
      },
      { method: "post", action: "/api/ai" },
    );
    // Remember the requested mode for the poller below (the task row itself
    // doesn't carry it back in a queryable way before completion).
    pendingTranslateModeRef.current = choice.mode;
  };

  useEffect(() => {
    if (translateFetcher.state !== "idle" || !translateFetcher.data) return;
    const result = translateFetcher.data;
    if (result.success && result.none) {
      setTranslateBanner({ kind: "none" });
    } else if (result.success && result.taskId) {
      setTranslateBanner({ kind: "running" });
      setTranslateTask({ id: result.taskId, mode: pendingTranslateModeRef.current });
    } else if (!result.success) {
      setTranslateBanner({ kind: "failed", message: result.error });
    }
    // Only react when the fetcher settles with new data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [translateFetcher.state, translateFetcher.data]);

  // Poll the detached task (same /api/task-result pattern as the content
  // editors). Preview mode merges the suggestions into the edit map — the
  // merchant reviews them as ordinary dirty cells and saves through the
  // normal verified pipeline; save mode just reports and revalidates.
  useEffect(() => {
    if (!translateTask) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/task-result?taskId=${encodeURIComponent(translateTask.id)}`, {
          headers: { Accept: "application/json" },
        });
        if (!res.ok || cancelled) return;
        const payload = (await res.json()) as {
          task?: { status: string; result?: string | null; error?: string | null };
        };
        const task = payload.task;
        if (!task || (task.status !== "completed" && task.status !== "failed") || cancelled) return;

        setTranslateTask(null);
        if (task.status === "failed") {
          setTranslateBanner({ kind: "failed", message: task.error ?? undefined });
          return;
        }
        let parsed: TranslateTaskResult | null = null;
        try {
          parsed = task.result ? (JSON.parse(task.result) as TranslateTaskResult) : null;
        } catch {
          parsed = null;
        }
        if (parsed?.mode === "preview") {
          const suggestions = parsed.suggestions ?? [];
          let appliedCount = 0;
          setEdits((prev) => {
            const next = { ...prev };
            for (const s of suggestions) {
              const key = makeEditKey(s.rowId, s.locale, s.marketId, s.columnId);
              // Never overwrite something the merchant typed meanwhile.
              if (key in next) continue;
              next[key] = s.value;
              appliedCount++;
            }
            return next;
          });
          setTranslateBanner({ kind: "applied", count: appliedCount });
        } else {
          const failed = new Set((parsed?.failures ?? []).map((f) => f.rowId)).size;
          setTranslateBanner({ kind: "saved", count: parsed?.saved ?? 0, failed });
          revalidator.revalidate();
        }
      } catch {
        // transient poll error — next tick retries
      }
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [translateTask]);

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
      saveColumnPrefs(type, ordered);
      return ordered;
    });
  };

  const resetColumns = () => {
    const def = DEFAULT_COLUMNS[type];
    setVisibleColumnIds(def);
    saveColumnPrefs(type, def);
  };

  /** Column heading resolution: static columns via t.bulkEditor.columns.*,
   * metafield columns verbatim (shop-defined "namespace.key" — never
   * translated, §10.4), option columns via the {position} templates, img.alt
   * via its own key. */
  const columnHeading = (col: ColumnDescriptor): string => {
    if (col.kind === "metafield") return col.label;
    if (col.kind === "option") {
      const template = col.optionField === "name" ? b.columns.optionName : b.columns.optionValues;
      return template.replace("{position}", String(col.optionPosition ?? 0));
    }
    if (col.id === "img.alt") return b.columns.imgAlt;
    const heading = (b.columns as unknown as Record<string, string>)[col.label] ?? col.label;
    // Money columns carry the shop currency as a suffix (Plan §5.2) — the
    // currency is shop-wide, never per cell.
    if (col.inputType === "money" && data.currencyCode) {
      return `${heading} (${data.currencyCode})`;
    }
    return heading;
  };

  const typeOptions = allowedTypes.map((rt) => ({ label: b.types[rt], value: rt }));

  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  const hasPrev = page > 1;
  const hasNext = to < total;

  const saveError = saveFetcher.data && !saveFetcher.data.ok ? b.errorGeneric : null;
  const bulkError = bulkFetcher.data && !bulkFetcher.data.success ? bulkFetcher.data.error || b.errorGeneric : null;

  // Which columns actually render — the merchant's selection, restricted to
  // valid columns for this type (defensive against preserved localStorage
  // from a previous release listing a since-removed column).
  const activeColumns = useMemo(
    () =>
      visibleColumnIds
        .map((id) => allColumns.find((c) => c.id === id))
        .filter((c): c is ColumnDescriptor => !!c),
    [visibleColumnIds, allColumns],
  );

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

  const translateBusy = translateFetcher.state !== "idle" || translateTask !== null;

  const localeOptions = data.locales.map((l) => ({
    label: l.primary ? `${l.name} ${b.primaryLocaleSuffix}` : l.name,
    // "" = primary — same sentinel as the edit-map/URL segments.
    value: l.primary ? "" : l.locale,
  }));
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
                {otherLocaleComboCount > 0 && (
                  <Banner tone="info">
                    {b.unsavedOtherLocales.replace("{count}", String(otherLocaleComboCount))}
                  </Banner>
                )}
                {translateBanner?.kind === "running" && (
                  <Banner tone="info">{b.translateMissing.running}</Banner>
                )}
                {translateBanner?.kind === "applied" && (
                  <Banner
                    tone="success"
                    onDismiss={() => setTranslateBanner(null)}
                  >
                    {b.translateMissing.applied.replace("{count}", String(translateBanner.count))}
                  </Banner>
                )}
                {translateBanner?.kind === "saved" && (
                  <Banner
                    tone={translateBanner.failed > 0 ? "warning" : "success"}
                    onDismiss={() => setTranslateBanner(null)}
                  >
                    {b.translateMissing.savedResult
                      .replace("{count}", String(translateBanner.count))
                      .replace("{failed}", String(translateBanner.failed))}
                  </Banner>
                )}
                {translateBanner?.kind === "none" && (
                  <Banner tone="info" onDismiss={() => setTranslateBanner(null)}>
                    {b.translateMissing.noneMissing}
                  </Banner>
                )}
                {translateBanner?.kind === "failed" && (
                  <Banner tone="critical" onDismiss={() => setTranslateBanner(null)}>
                    {translateBanner.message || b.translateMissing.failed}
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
                    {localeOptions.length > 1 && (
                      <div style={{ maxWidth: "220px", flex: "0 0 200px" }}>
                        <Select
                          label={b.languageLabel}
                          options={localeOptions}
                          value={locale}
                          onChange={handleLocaleChange}
                        />
                      </div>
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
                    {data.aiTranslateAllowed && foreignLocales.length > 0 && aiColumns.length > 0 && (
                      <Button onClick={() => setTranslateModalOpen(true)} loading={translateBusy}>
                        {b.translateMissing.button}
                      </Button>
                    )}
                    <Button onClick={() => setPickerOpen(true)}>{b.chooseColumns}</Button>
                  </InlineStack>
                </InlineStack>

                <FilterBar
                  search={search}
                  onSearchCommit={handleSearchCommit}
                  filters={filters}
                  onFiltersChange={handleFiltersChange}
                  showTranslationFilter={locale !== ""}
                  variantFilters={type === "variant"}
                  pageSize={pageSize}
                  onPageSizeChange={handlePageSizeChange}
                  onlyChanged={onlyChanged}
                  onOnlyChangedChange={setOnlyChanged}
                  strings={{
                    searchPlaceholder: type === "variant" ? b.searchPlaceholderVariant : b.searchPlaceholder,
                    searchLabel: b.searchLabel,
                    filtersLabel: b.filtersLabel,
                    filterMissingSeoTitle: b.filters.missingSeoTitle,
                    filterMissingSeoDescription: b.filters.missingSeoDescription,
                    filterMissingTranslation: b.filters.missingTranslation,
                    filterMissingSku: b.filters.missingSku,
                    filterMissingPrice: b.filters.missingPrice,
                    filterCompareAtNotAbovePrice: b.filters.compareAtNotAbovePrice,
                    pageSizeLabel: b.pageSizeLabel,
                    onlyChangedLabel: b.onlyChanged,
                  }}
                />

                {visibleRows.length === 0 ? (
                  <Text as="p" tone="subdued">
                    {onlyChanged && rows.length > 0 ? b.noChangedRows : b.noRows}
                  </Text>
                ) : (
                  <BlockStack gap="200">
                    <BulkGrid
                      rows={visibleRows}
                      type={type}
                      columns={activeColumns}
                      valueFor={valueFor}
                      isDirty={isDirtyCell}
                      setEdit={setEdit}
                      isForeignLocale={isForeign}
                      ghostFor={ghostFor}
                      notTranslatableTooltip={b.notTranslatableTooltip}
                      failuresByCell={failuresByCell}
                      rowLevelFailures={rowLevelFailures}
                      sort={sort}
                      onSortToggle={handleSortToggle}
                      openInEditorLabel={b.openInEditor}
                      onOpenInEditor={(row) =>
                        handleNavigate(TYPE_EDITOR_PATH[row.type], {
                          // Variant rows open their PRODUCT in the editor.
                          searchParams: new URLSearchParams({ select: row.productId ?? row.id }),
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
                      }}
                      sortButtonLabel={b.sortButtonLabel}
                      caption={b.types[type]}
                    />

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

            <TranslateMissingModal
              open={translateModalOpen}
              onClose={() => setTranslateModalOpen(false)}
              columns={aiColumns}
              columnLabel={columnHeading}
              locales={foreignLocales}
              defaultLocale={locale}
              busy={translateBusy}
              onStart={handleTranslateStart}
              strings={{
                title: b.translateMissing.title,
                intro: b.translateMissing.intro,
                columnLabel: b.translateMissing.columnLabel,
                targetLocaleLabel: b.translateMissing.targetLocaleLabel,
                modeLabel: b.translateMissing.modeLabel,
                modePreview: b.translateMissing.modePreview,
                modeSave: b.translateMissing.modeSave,
                start: b.translateMissing.start,
                cancel: b.translateMissing.cancel,
                marketHint: b.translateMissing.marketHint,
              }}
            />

            <ColumnPickerModal
              open={pickerOpen}
              onClose={() => setPickerOpen(false)}
              allColumns={allColumns}
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
