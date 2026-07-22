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
import { useEffect, useMemo, useState } from "react";
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
  makeEditKey,
  parseEditKey,
  parseSortParam,
  serializeSortParam,
  primaryValueForColumn,
  isValidBulkDiffEntry,
  BULK_ROW_TYPES,
  BULK_ROW_TYPE_TO_CONTENT_TYPE,
  BULK_COLUMNS_BY_TYPE,
  BULK_FILTER_IDS,
  BULK_PAGE_SIZES,
  BULK_DEFAULT_PAGE_SIZE,
  MAX_SYNC_SAVE,
  MAX_VISIBLE_COLUMNS,
  type BulkRowType,
  type BulkRow,
  type BulkSort,
  type BulkFilterId,
  type BulkDiffEntry,
  type BulkFailure,
  type ColumnDescriptor,
} from "../services/bulk-editor/columns.shared";
// Server-only I/O — referenced exclusively from loader/action, which Remix
// strips from the client build.
import { loadBulkRows } from "../services/bulk-editor/load.server";
import { applyBulkDiff } from "../services/bulk-editor/apply.server";
import { BulkGrid } from "../components/bulk-editor/BulkGrid";
import { ColumnPickerModal } from "../components/bulk-editor/ColumnPickerModal";
import { FilterBar } from "../components/bulk-editor/FilterBar";

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
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
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
  const locale = url.searchParams.get("locale") || "";
  const marketId = url.searchParams.get("market") || "";
  const sort = parseSortParam(type, url.searchParams.get("sort"));

  const { rows, total, translationFilterApproximate } = await loadBulkRows(db, shop, {
    type,
    locale,
    marketId,
    search,
    filters,
    sort,
    skip: (page - 1) * pageSize,
    take: pageSize,
  });

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
  // (seo-bulk-meta.handler.ts).
  const allowedTypes = allowedTypesForPlan(plan);
  if (!diff.every((e) => isValidBulkDiffEntry(e, allowedTypes))) {
    return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
  }
  // Defensive only — the client routes >MAX_SYNC_SAVE dirty cells to /api/ai
  // "seoBulkMeta" instead of posting here.
  if (diff.length > MAX_SYNC_SAVE) {
    return json<ActionResult>({ ok: false, error: "tooLarge" }, { status: 400 });
  }

  const result = await applyBulkDiff({ db, shop, admin }, diff);
  return json<ActionResult>({ ok: true, saved: result.saved, failures: result.failures });
};

/** Deep-link target per content type for the row's "open in editor" action. */
const TYPE_EDITOR_PATH: Record<BulkRowType, string> = {
  product: "/app/products",
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
 * removed) are filtered out silently; the visible set is capped at
 * MAX_VISIBLE_COLUMNS.
 */
function loadColumnPrefs(type: BulkRowType): string[] {
  if (typeof window === "undefined") return DEFAULT_COLUMNS[type];
  const allowed = new Set(BULK_COLUMNS_BY_TYPE[type].map((c) => c.id));
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
  const { t } = useI18n();
  const { handleNavigate } = useAppNavigation();
  const revalidator = useRevalidator();
  const b = t.bulkEditor;

  const sort = useMemo(() => parseSortParam(type, data.sort), [type, data.sort]);

  const saveFetcher = useFetcher<ActionResult>();
  const bulkFetcher = useFetcher<BulkFetcherResult>();

  const [edits, setEdits] = useState<Record<string, string>>({});
  const [lastFailures, setLastFailures] = useState<BulkFailure[]>([]);
  const [lastSavedCount, setLastSavedCount] = useState<number | null>(null);
  const [queuedBanner, setQueuedBanner] = useState(false);
  const [onlyChanged, setOnlyChanged] = useState(false);

  // Column visibility — merchant-picked, persisted per type. Rehydrated
  // whenever `type` changes so switching Products↔Pages restores each
  // type's saved layout (not a shared one that would leak fields).
  const [visibleColumnIds, setVisibleColumnIds] = useState<string[]>(() => loadColumnPrefs(type));
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    setVisibleColumnIds(loadColumnPrefs(type));
  }, [type]);

  // A navigation to a different page/type/filter set starts from a clean
  // slate — stale edits from a different page would silently target the
  // wrong rows otherwise. Deliberately keyed on the URL state rather than
  // [rows]: a partial-failure save calls revalidator.revalidate() to refresh
  // `rows` WITHOUT navigating, and that must NOT wipe the edits still held
  // for the rows that failed (see the saveFetcher effect below).
  useEffect(() => {
    setEdits({});
    setLastFailures([]);
    setLastSavedCount(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, page, pageSize, search, data.sort, filters.join(",")]);

  const allColumns = BULK_COLUMNS_BY_TYPE[type];
  const dirty = useMemo(() => computeDiff(rows as BulkRow[], allColumns, edits), [rows, allColumns, edits]);
  const dirtyRowIds = useMemo(() => new Set(dirty.map((d) => d.rowId)), [dirty]);

  const saving = saveFetcher.state !== "idle" || bulkFetcher.state !== "idle";

  useEffect(() => {
    if (saveFetcher.state !== "idle" || !saveFetcher.data) return;
    if (saveFetcher.data.ok) {
      // Keep only the edits of rows that failed — their typed values stay in
      // the form for retry (Plan §0.2 no. 5); everything saved is dropped.
      const failedIds = new Set(saveFetcher.data.failures.map((f) => f.rowId));
      setEdits((prev) => {
        const next: Record<string, string> = {};
        for (const [key, value] of Object.entries(prev)) {
          const parsed = parseEditKey(key);
          if (parsed && failedIds.has(parsed.rowId)) next[key] = value;
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

  // Phase 1 edits always target the primary language / all markets — the
  // locale/market URL params only steer the missing-translation filter until
  // the selectors land in Phase 4. The key format carries the segments
  // already so the edit map never has to migrate again.
  const editKeyFor = (row: BulkRow, column: ColumnDescriptor) => makeEditKey(row.id, "", "", column.id);

  const setEdit = (row: BulkRow, column: ColumnDescriptor, value: string) => {
    setEdits((prev) => ({ ...prev, [editKeyFor(row, column)]: value }));
  };
  const valueFor = (row: BulkRow, column: ColumnDescriptor): string => {
    const editKey = editKeyFor(row, column);
    if (editKey in edits) return edits[editKey];
    return primaryValueForColumn(row, column);
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
    if (dirty.length > MAX_SYNC_SAVE) {
      // `contentType` is currently ignored by seo-bulk-meta.handler.ts (it
      // drives off each diff entry's own `rowType`), but sending the actual
      // current type makes request logs / Tasks tab records honest.
      bulkFetcher.submit(
        { action: "seoBulkMeta", contentType: type, diff: JSON.stringify(dirty) },
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
  };

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

  const failuresByRowId = useMemo(
    () => new Map(lastFailures.map((f) => [f.rowId, f.message] as const)),
    [lastFailures],
  );

  const visibleRows = onlyChanged ? (rows as BulkRow[]).filter((r) => dirtyRowIds.has(r.id)) : (rows as BulkRow[]);

  // aria-live status for screen readers: announce save results (§2 ARIA).
  const liveMessage =
    lastSavedCount !== null
      ? lastFailures.length > 0
        ? b.saveSuccessWithFailures
            .replace("{saved}", String(lastSavedCount))
            .replace("{failed}", String(lastFailures.length))
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
                {data.translationFilterApproximate && (
                  <Banner tone="warning">{b.filterApproximateBanner}</Banner>
                )}
                {lastSavedCount !== null && (
                  <Banner tone={lastFailures.length > 0 ? "warning" : "success"}>
                    {lastFailures.length > 0
                      ? b.saveSuccessWithFailures
                          .replace("{saved}", String(lastSavedCount))
                          .replace("{failed}", String(lastFailures.length))
                      : b.saveSuccess.replace("{count}", String(lastSavedCount))}
                  </Banner>
                )}
                {lastFailures.length > 0 && (
                  <Banner tone="critical" title={b.saveFailuresTitle}>
                    <BlockStack gap="100">
                      {lastFailures.map((f) => (
                        <Text as="p" variant="bodySm" key={`${f.rowType}:${f.rowId}`}>
                          {f.rowId}: {f.message}
                        </Text>
                      ))}
                    </BlockStack>
                  </Banner>
                )}

                <InlineStack align="space-between" blockAlign="end" gap="200" wrap>
                  <div style={{ maxWidth: "220px", flex: "0 0 220px" }}>
                    <Select label={b.typeLabel} options={typeOptions} value={type} onChange={handleTypeChange} />
                  </div>
                  <Button onClick={() => setPickerOpen(true)}>{b.chooseColumns}</Button>
                </InlineStack>

                <FilterBar
                  search={search}
                  onSearchCommit={handleSearchCommit}
                  filters={filters}
                  onFiltersChange={handleFiltersChange}
                  showTranslationFilter={locale !== ""}
                  pageSize={pageSize}
                  onPageSizeChange={handlePageSizeChange}
                  onlyChanged={onlyChanged}
                  onOnlyChangedChange={setOnlyChanged}
                  strings={{
                    searchPlaceholder: b.searchPlaceholder,
                    searchLabel: b.searchLabel,
                    filtersLabel: b.filtersLabel,
                    filterMissingSeoTitle: b.filters.missingSeoTitle,
                    filterMissingSeoDescription: b.filters.missingSeoDescription,
                    filterMissingTranslation: b.filters.missingTranslation,
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
                      failuresByRowId={failuresByRowId}
                      sort={sort}
                      onSortToggle={handleSortToggle}
                      openInEditorLabel={b.openInEditor}
                      onOpenInEditor={(row) =>
                        handleNavigate(TYPE_EDITOR_PATH[row.type], {
                          searchParams: new URLSearchParams({ select: row.id }),
                        })
                      }
                      columnHeading={(col) => (b.columns as Record<string, string>)[col.label] ?? col.label}
                      statusOptions={b.statusOptions}
                      handleWarning={b.handleWarning}
                      readOnlyTooltip={b.readOnlyTooltip}
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

            <ColumnPickerModal
              open={pickerOpen}
              onClose={() => setPickerOpen(false)}
              allColumns={allColumns}
              visibleColumnIds={visibleColumnIds}
              onToggle={toggleColumn}
              onReset={resetColumns}
              columnLabel={(col) => (b.columns as Record<string, string>)[col.label] ?? col.label}
              strings={{
                title: b.columnPicker.title,
                intro: b.columnPicker.intro,
                done: b.columnPicker.done,
                reset: b.columnPicker.reset,
                limitHint: b.columnPicker.limitHint,
              }}
            />
          </BlockStack>
        )}
      </PlanAccessGate>
    </div>
  );
}
