/**
 * Manual bulk-meta editor (SEO_TAB_IMPLEMENTATION_PLAN.md Anhang C3) — Basic+.
 *
 * A spreadsheet-like grid for editing every field an entry offers (Title,
 * Description/Body, SEO-Title, Meta-Description, Handle, plus type-specific
 * fields like productType/status/summary). A column picker modal lets the
 * merchant choose which cells to see; a thumbnail column shows the primary
 * image (read-only). Complements the AI bulk-fix (app.seo._index.tsx's "Fix
 * with AI") for merchants who'd rather type the values themselves.
 *
 * Diff-only save-all: only cells whose value actually changed are submitted
 * (computeDiff, app/services/seo/bulk-meta.service.ts). Up to MAX_SYNC_SAVE
 * dirty rows save synchronously through this route's own action; anything
 * bigger is routed to the shared /api/ai "seoBulkMeta" action instead, which
 * runs it as a detached, heartbeat-updated Task (same shape as the "Fix with
 * AI" bulk action, minus the AI call).
 */

import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useRevalidator } from "@remix-run/react";
import { useEffect, useMemo, useState } from "react";
import {
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  TextField,
  Select,
  Banner,
  Modal,
  Checkbox,
  Tooltip,
  Thumbnail,
} from "@shopify/polaris";
import { EditIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { SeoSectionLayout } from "../components/seo/SeoSectionLayout";
import { AppSaveBar } from "../components/AppSaveBar";
import { getFormString, getFormJSON } from "../utils/form-data.utils";
import { meetsPlan } from "../utils/planUtils";
import { isValidShopifyGID } from "../utils/validation";
import type { Plan } from "../config/plans";
// Pure/client-safe pieces from the shared module — the component uses them,
// so importing them from bulk-meta.service would drag server-only code
// (ShopifyApiGateway → logger.server) into the client bundle.
import {
  computeDiff,
  isFieldAllowedForType,
  BULK_META_TYPES,
  BULK_META_FIELDS,
  BULK_META_FIELDS_BY_TYPE,
  BULK_META_READONLY_BY_TYPE,
  BULK_META_PAGE_SIZE,
  MAX_SYNC_SAVE,
  type BulkMetaType,
  type BulkMetaField,
  type BulkMetaReadOnlyColumn,
  type BulkMetaRow,
  type BulkMetaDiffEntry,
  type BulkMetaFailure,
} from "../services/seo/bulk-meta.shared";
// Server-only I/O — referenced exclusively from loader/action, which Remix
// strips from the client build.
import { applyBulkMetaDiff, loadBulkMetaPage } from "../services/seo/bulk-meta.service";

async function loadPlan(db: any, shop: string): Promise<Plan> {
  const settings = await db.aISettings.findUnique({
    where: { shop },
    select: { subscriptionPlan: true },
  });
  return (settings?.subscriptionPlan || "free") as Plan;
}

interface LoaderData {
  gated: boolean;
  rows: BulkMetaRow[];
  type: BulkMetaType;
  page: number;
  total: number;
  pageSize: number;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { db } = await import("../db.server");
  const shop = session.shop;

  const plan = await loadPlan(db, shop);
  if (!meetsPlan(plan, "basic")) {
    return json<LoaderData>({
      gated: true,
      rows: [],
      type: "product",
      page: 1,
      total: 0,
      pageSize: BULK_META_PAGE_SIZE,
    });
  }

  const url = new URL(request.url);
  const rawType = url.searchParams.get("type") || "product";
  const type: BulkMetaType = (BULK_META_TYPES as string[]).includes(rawType)
    ? (rawType as BulkMetaType)
    : "product";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const skip = (page - 1) * BULK_META_PAGE_SIZE;

  const { rows, total } = await loadBulkMetaPage(db, shop, type, { skip, take: BULK_META_PAGE_SIZE });

  return json<LoaderData>({ gated: false, rows, type, page, total, pageSize: BULK_META_PAGE_SIZE });
};

type ActionResult =
  | { ok: true; saved: number; failures: BulkMetaFailure[] }
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
  if (getFormString(form, "actionType") !== "saveBulkMeta") {
    return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
  }

  const diff = getFormJSON<BulkMetaDiffEntry[]>(form, "diff");
  if (!Array.isArray(diff) || diff.length === 0) {
    return json<ActionResult>({ ok: false, error: "empty" }, { status: 400 });
  }
  // Never trust the client diff blindly, even on the synchronous path — same
  // GID + field allowlist checks as the task path (seo-bulk-meta.handler.ts).
  const valid = diff.every(
    (e) =>
      e &&
      typeof e.id === "string" &&
      isValidShopifyGID(e.id) &&
      (BULK_META_TYPES as string[]).includes(e.type) &&
      typeof e.field === "string" &&
      (BULK_META_FIELDS as string[]).includes(e.field) &&
      typeof e.value === "string",
  );
  if (!valid) {
    return json<ActionResult>({ ok: false, error: "invalid" }, { status: 400 });
  }
  // Defensive only — the client routes >MAX_SYNC_SAVE dirty rows to /api/ai
  // "seoBulkMeta" instead of posting here.
  if (diff.length > MAX_SYNC_SAVE) {
    return json<ActionResult>({ ok: false, error: "tooLarge" }, { status: 400 });
  }

  const result = await applyBulkMetaDiff({ db, shop, admin }, diff);
  return json<ActionResult>({ ok: true, saved: result.saved, failures: result.failures });
};

/** Deep-link target per content type for the row's "open in editor" action. */
const TYPE_EDITOR_PATH: Record<BulkMetaType, string> = {
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

/** Localstorage key holding the user's per-type visible column selection.
 * Namespaced by type so switching Product↔Collection remembers each. */
const COLUMNS_STORAGE_KEY = "contentpilot:bulkMeta:columns";

/** Combined column identity — either an editable field or a read-only meta
 * column. The grid renders in the same order the user selects them. */
type BulkColumn = BulkMetaField | BulkMetaReadOnlyColumn;

/** Which columns are visible by default when the merchant first opens the
 * grid for a type. Product defaults to a compact "Bild + Meta" view to fit
 * on-screen without horizontal scrolling for the common case. */
const DEFAULT_COLUMNS: Record<BulkMetaType, BulkColumn[]> = {
  product: ["image", "title", "productType", "handle", "seoTitle", "seoDescription"],
  collection: ["image", "title", "handle", "seoTitle", "seoDescription"],
  article: ["image", "title", "summary", "handle", "seoTitle", "seoDescription"],
  page: ["title", "handle", "seoTitle", "seoDescription"],
};

/** All possible columns for a type, in canonical (picker) order. */
function allColumnsForType(type: BulkMetaType): BulkColumn[] {
  return [...BULK_META_READONLY_BY_TYPE[type], ...BULK_META_FIELDS_BY_TYPE[type]];
}

/** Column width per field — keeps the grid predictable when horizontal
 * scrolling kicks in. Longer-text fields get more room; single-line fields
 * stay compact. */
function columnMinWidth(col: BulkColumn): number {
  switch (col) {
    case "image":
      return 72;
    case "blogTitle":
      return 140;
    case "title":
    case "handle":
    case "productType":
      return 180;
    case "status":
      return 130;
    case "seoTitle":
      return 200;
    case "summary":
      return 240;
    case "seoDescription":
    case "descriptionHtml":
    case "body":
      return 280;
  }
}

/** True if a column is read-only (image, blogTitle) — those never appear in
 * BULK_META_FIELDS_BY_TYPE, so this is just a set check. */
function isReadOnlyColumn(col: BulkColumn): col is BulkMetaReadOnlyColumn {
  return col === "image" || col === "blogTitle";
}

/**
 * Restore the merchant's saved column selection for a type, or fall back to
 * the default set. Stale columns (from an older release that offered a field
 * we've since removed) are filtered out silently.
 */
function loadColumnPrefs(type: BulkMetaType): BulkColumn[] {
  if (typeof window === "undefined") return DEFAULT_COLUMNS[type];
  try {
    const raw = window.localStorage.getItem(COLUMNS_STORAGE_KEY);
    if (!raw) return DEFAULT_COLUMNS[type];
    const all = JSON.parse(raw) as Partial<Record<BulkMetaType, BulkColumn[]>>;
    const saved = all[type];
    if (!Array.isArray(saved) || saved.length === 0) return DEFAULT_COLUMNS[type];
    const allowed = new Set<BulkColumn>(allColumnsForType(type));
    const filtered = saved.filter((c) => allowed.has(c));
    return filtered.length > 0 ? filtered : DEFAULT_COLUMNS[type];
  } catch {
    return DEFAULT_COLUMNS[type];
  }
}

function saveColumnPrefs(type: BulkMetaType, cols: BulkColumn[]) {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(COLUMNS_STORAGE_KEY);
    const all = (raw ? JSON.parse(raw) : {}) as Partial<Record<BulkMetaType, BulkColumn[]>>;
    all[type] = cols;
    window.localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // localStorage may be unavailable (private mode / SSR mismatch) — the
    // grid still works, we just don't remember the selection for next time.
  }
}

export default function SeoBulkMeta() {
  const { gated, rows, type, page, total, pageSize } = useLoaderData<typeof loader>();
  const { t } = useI18n();
  const { handleNavigate } = useAppNavigation();
  const revalidator = useRevalidator();
  const b = t.seo.bulkMetaPage;

  const saveFetcher = useFetcher<ActionResult>();
  const bulkFetcher = useFetcher<BulkFetcherResult>();

  const [edits, setEdits] = useState<Record<string, string>>({});
  const [lastFailures, setLastFailures] = useState<BulkMetaFailure[]>([]);
  const [lastSavedCount, setLastSavedCount] = useState<number | null>(null);
  const [queuedBanner, setQueuedBanner] = useState(false);

  // Column visibility — merchant-picked, persisted per type. Rehydrated
  // whenever `type` changes so switching Products↔Pages restores each
  // type's saved layout (not a shared one that would leak fields).
  const [visibleColumns, setVisibleColumns] = useState<BulkColumn[]>(() => loadColumnPrefs(type));
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    setVisibleColumns(loadColumnPrefs(type));
  }, [type]);

  // A navigation to a different page/type starts from a clean slate — stale
  // edits from a different page/type would silently target the wrong rows
  // otherwise. Deliberately keyed on [type, page] rather than [rows]: a
  // partial-failure save calls revalidator.revalidate() to refresh `rows`
  // WITHOUT navigating, and that must NOT wipe the edits still held for the
  // rows that failed (see the saveFetcher effect below).
  useEffect(() => {
    setEdits({});
    setLastFailures([]);
    setLastSavedCount(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, page]);

  const dirty = useMemo(() => computeDiff(rows as BulkMetaRow[], edits), [rows, edits]);

  const saving = saveFetcher.state !== "idle" || bulkFetcher.state !== "idle";

  useEffect(() => {
    if (saveFetcher.state !== "idle" || !saveFetcher.data) return;
    if (saveFetcher.data.ok) {
      const failedIds = new Set(saveFetcher.data.failures.map((f) => f.id));
      setEdits((prev) => {
        const next: Record<string, string> = {};
        for (const [key, value] of Object.entries(prev)) {
          const id = key.slice(0, key.lastIndexOf(":"));
          if (failedIds.has(id)) next[key] = value;
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

  const setEdit = (id: string, field: BulkMetaField, value: string) => {
    setEdits((prev) => ({ ...prev, [`${id}:${field}`]: value }));
  };
  const valueFor = (row: BulkMetaRow, field: BulkMetaField): string => {
    const editKey = `${row.id}:${field}`;
    if (editKey in edits) return edits[editKey];
    return (row[field] as string | undefined) ?? "";
  };

  const handleTypeChange = (value: string) => {
    setQueuedBanner(false);
    handleNavigate("/app/seo/bulk-meta", {
      searchParams: new URLSearchParams({ type: value }),
      replace: true,
    });
  };

  const goToPage = (nextPage: number) => {
    setQueuedBanner(false);
    handleNavigate("/app/seo/bulk-meta", {
      searchParams: new URLSearchParams({ type, page: String(nextPage) }),
      replace: true,
    });
  };

  const handleSave = () => {
    if (dirty.length === 0 || saving) return;
    if (dirty.length > MAX_SYNC_SAVE) {
      // `contentType` is currently ignored by seo-bulk-meta.handler.ts (it
      // drives off each diff entry's own `type`), but sending the actual
      // current type makes request logs / Tasks tab records honest instead of
      // labeling every async save as "products".
      bulkFetcher.submit(
        { action: "seoBulkMeta", contentType: type, diff: JSON.stringify(dirty) },
        { method: "post", action: "/api/ai" },
      );
    } else {
      saveFetcher.submit(
        { actionType: "saveBulkMeta", diff: JSON.stringify(dirty) },
        { method: "post" },
      );
    }
  };

  const handleDiscard = () => {
    setEdits({});
    setLastFailures([]);
    setLastSavedCount(null);
  };

  const toggleColumn = (col: BulkColumn) => {
    setVisibleColumns((prev) => {
      const next = prev.includes(col) ? prev.filter((c) => c !== col) : [...prev, col];
      // Preserve canonical order — otherwise the column re-appears at the
      // end after re-checking it, which feels wrong to merchants used to a
      // stable layout.
      const canonical = allColumnsForType(type);
      const ordered = canonical.filter((c) => next.includes(c));
      saveColumnPrefs(type, ordered);
      return ordered;
    });
  };

  const resetColumns = () => {
    const def = DEFAULT_COLUMNS[type];
    setVisibleColumns(def);
    saveColumnPrefs(type, def);
  };

  const typeOptions = (BULK_META_TYPES as BulkMetaType[]).map((rt) => ({ label: b.types[rt], value: rt }));

  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  const hasPrev = page > 1;
  const hasNext = to < total;

  const saveError = saveFetcher.data && !saveFetcher.data.ok ? b.errorGeneric : null;
  const bulkError = bulkFetcher.data && !bulkFetcher.data.success ? bulkFetcher.data.error || b.errorGeneric : null;

  // Which columns actually render — filter out any the merchant deselected,
  // but never render an editable column that isn't valid for this type
  // (defensive: DEFAULT_COLUMNS is per-type, but preserved localStorage from
  // a previous release might list a since-removed field).
  const activeColumns = visibleColumns.filter((c) =>
    isReadOnlyColumn(c)
      ? BULK_META_READONLY_BY_TYPE[type].includes(c)
      : isFieldAllowedForType(type, c),
  );

  return (
    <SeoSectionLayout sectionId="bulkMeta">
      {gated ? null : (
        <BlockStack gap="400">
          <Card>
            <BlockStack gap="300">
              <Text as="p" variant="bodySm" tone="subdued">
                {b.intro}
              </Text>

              {queuedBanner && <Banner tone="success">{b.queuedBanner}</Banner>}
              {bulkError && <Banner tone="critical">{bulkError}</Banner>}
              {saveError && <Banner tone="critical">{saveError}</Banner>}
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
                      <Text as="p" variant="bodySm" key={`${f.type}:${f.id}`}>
                        {f.id}: {f.message}
                      </Text>
                    ))}
                  </BlockStack>
                </Banner>
              )}

              <InlineStack align="space-between" blockAlign="end" gap="200">
                <div style={{ maxWidth: "220px", flex: "0 0 220px" }}>
                  <Select label={b.typeLabel} options={typeOptions} value={type} onChange={handleTypeChange} />
                </div>
                <Button onClick={() => setPickerOpen(true)}>{b.chooseColumns}</Button>
              </InlineStack>

              {rows.length === 0 ? (
                <Text as="p" tone="subdued">
                  {b.noRows}
                </Text>
              ) : (
                <BlockStack gap="200">
                  <BulkMetaGrid
                    rows={rows as BulkMetaRow[]}
                    type={type}
                    columns={activeColumns}
                    valueFor={valueFor}
                    setEdit={setEdit}
                    edits={edits}
                    openInEditorLabel={b.openInEditor}
                    onOpenInEditor={(row) =>
                      handleNavigate(TYPE_EDITOR_PATH[row.type], {
                        searchParams: new URLSearchParams({ select: row.id }),
                      })
                    }
                    columnHeading={b.columns}
                    statusOptions={b.statusOptions}
                    handleWarning={b.handleWarning}
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

          {/* Native App Bridge save bar — same one used by the content editors
              (see AppSaveBar). Renders above the embedded app, outside the
              iframe, and satisfies the Built-for-Shopify requirement to use
              Shopify's native save/discard UI instead of custom buttons. */}
          <AppSaveBar
            hasChanges={dirty.length > 0}
            onSave={handleSave}
            onDiscard={handleDiscard}
            loading={saving}
            saveText={b.saveButton}
            discardText={b.discardButton}
          />

          <Modal
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            title={b.columnPicker.title}
            primaryAction={{ content: b.columnPicker.done, onAction: () => setPickerOpen(false) }}
            secondaryActions={[{ content: b.columnPicker.reset, onAction: resetColumns }]}
          >
            <Modal.Section>
              <BlockStack gap="200">
                <Text as="p" tone="subdued">
                  {b.columnPicker.intro}
                </Text>
                <BlockStack gap="100">
                  {allColumnsForType(type).map((col) => (
                    <Checkbox
                      key={col}
                      label={b.columns[col]}
                      checked={visibleColumns.includes(col)}
                      onChange={() => toggleColumn(col)}
                    />
                  ))}
                </BlockStack>
              </BlockStack>
            </Modal.Section>
          </Modal>
        </BlockStack>
      )}
    </SeoSectionLayout>
  );
}

// ─── Grid ─────────────────────────────────────────────────────────────────

interface BulkMetaGridProps {
  rows: BulkMetaRow[];
  type: BulkMetaType;
  columns: BulkColumn[];
  valueFor: (row: BulkMetaRow, field: BulkMetaField) => string;
  setEdit: (id: string, field: BulkMetaField, value: string) => void;
  edits: Record<string, string>;
  openInEditorLabel: string;
  onOpenInEditor: (row: BulkMetaRow) => void;
  columnHeading: Record<BulkColumn, string>;
  statusOptions: { active: string; draft: string; archived: string };
  handleWarning: string;
  /** Visually-hidden `<caption>` — pass the localized content-type label
   * (e.g. "Products") so screen readers can announce what the grid is. */
  caption: string;
}

/**
 * Excel-like grid: borderless textareas that auto-grow with content, tight
 * padding, horizontal scrolling when columns don't fit, a pencil icon for
 * "Open in editor" (matching the SEO overview tab), and a read-only image
 * thumbnail column for products/collections/articles.
 *
 * Implemented as CSS Grid (not <table>) because the merchant wants the
 * textarea in every cell to fill the whole cell — the classic <td h:1px>
 * table trick collapsed to 0 inside the embedded-iframe layout chain, so
 * short values still only rendered a 30-px-tall textarea at the top of a
 * taller row and clicks below the text missed. CSS Grid stretches cells
 * with align-items:stretch by default, and children with min-height:100%
 * reliably reference the cell's rendered height. `display:contents` on
 * each row div lets its cells participate in the outer grid, so columns
 * still align vertically and cells in the same visual row share height.
 * Semantics are preserved via ARIA (role="table"/"row"/"cell"/"columnheader").
 */
function BulkMetaGrid({
  rows,
  type,
  columns,
  valueFor,
  setEdit,
  edits,
  openInEditorLabel,
  onOpenInEditor,
  columnHeading,
  statusOptions,
  handleWarning,
  caption,
}: BulkMetaGridProps) {
  // Grid track sizing — one `minmax(<colMin>px, 1fr)` per data column plus a
  // fixed 48-px track for the trailing pencil-icon action cell. `1fr` so
  // columns share leftover horizontal space when the grid is wider than the
  // sum of minimums; the enclosing overflow-x wrapper kicks in when even
  // the minimums don't fit.
  const gridTemplateColumns =
    columns.map((c) => `minmax(${columnMinWidth(c)}px, 1fr)`).join(" ") + " 48px";

  return (
    <div style={{ overflowX: "auto", width: "100%" }} className="cp-bulk-meta-scroll">
      <style>{`
        .cp-bulk-meta-grid {
          display: grid;
          min-width: 100%;
          width: max-content;
        }
        /* display:contents makes each row-div disappear as a box; its
           children (the cells) become direct grid items of .cp-bulk-meta-grid,
           so all cells share ONE set of column tracks (column alignment) and
           browser Grid layout groups them into implicit rows of length =
           columns.length + 1. Cells in the same implicit row automatically
           stretch to the tallest cell's height (align-items:stretch is the
           Grid default). */
        .cp-bulk-meta-row {
          display: contents;
        }
        .cp-bulk-meta-th,
        .cp-bulk-meta-cell,
        .cp-bulk-meta-actions {
          padding: 4px 6px;
          border-bottom: 1px solid var(--p-color-border, #e1e3e5);
          box-sizing: border-box;
          display: flex;
          flex-direction: column;
        }
        .cp-bulk-meta-th {
          text-align: left;
          font-weight: 500;
          font-size: 12px;
          color: var(--p-color-text-secondary, #6d7175);
          background: var(--p-color-bg-surface-secondary, #f6f6f7);
          position: sticky;
          top: 0;
          z-index: 1;
        }
        .cp-bulk-meta-actions {
          align-items: flex-end;
          justify-content: flex-start;
        }
        /* Stretch the Polaris multiline TextField vertically to fill the
           cell. Polaris' default is align-items:center + auto height, which
           left short values as a 30-px-tall control at the top of a taller
           row. min-height (not height) keeps autogrow working: the internal
           __Resizer can still push the cell taller when content demands. */
        .cp-bulk-meta-cell > * {
          flex: 1 1 auto;
          min-height: 100%;
        }
        .cp-bulk-meta-cell .Polaris-TextField {
          background: transparent;
          align-items: stretch;
          min-height: 100%;
        }
        .cp-bulk-meta-cell .Polaris-TextField__Input,
        .cp-bulk-meta-cell textarea {
          overflow: hidden !important;
          resize: none !important;
          min-height: 100% !important;
          box-sizing: border-box;
        }
      `}</style>
      <div
        role="table"
        aria-label={caption}
        className="cp-bulk-meta-grid"
        style={{ gridTemplateColumns }}
      >
        <div role="row" className="cp-bulk-meta-row">
          {columns.map((col) => (
            <div key={col} role="columnheader" className="cp-bulk-meta-th">
              {col === "handle" ? (
                <Tooltip content={handleWarning}>
                  <span>{columnHeading[col]}</span>
                </Tooltip>
              ) : (
                columnHeading[col]
              )}
            </div>
          ))}
          <div role="columnheader" className="cp-bulk-meta-th" aria-hidden="true" />
        </div>
        {rows.map((row) => (
          <div key={row.id} role="row" className="cp-bulk-meta-row">
            {columns.map((col) => (
              <div key={col} role="cell" className="cp-bulk-meta-cell">
                <BulkMetaCell
                  row={row}
                  column={col}
                  type={type}
                  valueFor={valueFor}
                  setEdit={setEdit}
                  edits={edits}
                  statusOptions={statusOptions}
                />
              </div>
            ))}
            <div role="cell" className="cp-bulk-meta-actions">
              <Tooltip content={openInEditorLabel}>
                <Button
                  variant="plain"
                  size="slim"
                  icon={EditIcon}
                  accessibilityLabel={openInEditorLabel}
                  onClick={() => onOpenInEditor(row)}
                />
              </Tooltip>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface BulkMetaCellProps {
  row: BulkMetaRow;
  column: BulkColumn;
  type: BulkMetaType;
  valueFor: (row: BulkMetaRow, field: BulkMetaField) => string;
  setEdit: (id: string, field: BulkMetaField, value: string) => void;
  edits: Record<string, string>;
  statusOptions: { active: string; draft: string; archived: string };
}

function BulkMetaCell({ row, column, valueFor, setEdit, edits, statusOptions }: BulkMetaCellProps) {
  // Read-only meta columns first — no edit path, just render the value.
  if (column === "image") {
    if (!row.imageUrl) {
      // Empty spacer keeps row height consistent with rows that DO have a
      // thumbnail, avoiding a bouncy layout as the merchant scrolls.
      return <div style={{ width: 48, height: 48 }} />;
    }
    return (
      <Thumbnail source={row.imageUrl} alt={row.imageAlt ?? ""} size="small" />
    );
  }
  if (column === "blogTitle") {
    return (
      <Text as="span" variant="bodySm" tone="subdued">
        {row.blogTitle ?? ""}
      </Text>
    );
  }

  // Editable fields.
  const field = column;
  const value = valueFor(row, field);
  const isDirty = `${row.id}:${field}` in edits;

  if (field === "status") {
    // Non-null in the schema, but a partial sync could leave it "" — show a
    // placeholder row instead of silently defaulting the display to ACTIVE
    // (which would cause a no-op click to write ACTIVE where the DB had "").
    const hasStatus = value === "ACTIVE" || value === "DRAFT" || value === "ARCHIVED";
    return (
      <Select
        label=""
        labelHidden
        options={[
          ...(hasStatus
            ? []
            : [{ label: "—", value: "", disabled: true } as const]),
          { label: statusOptions.active, value: "ACTIVE" },
          { label: statusOptions.draft, value: "DRAFT" },
          { label: statusOptions.archived, value: "ARCHIVED" },
        ]}
        value={hasStatus ? value : ""}
        onChange={(v) => setEdit(row.id, field, v)}
      />
    );
  }

  // Every editable text cell is multi-line + autogrow. Merchant asked for
  // this explicitly: cells that used to be single-line (title, handle,
  // productType, seoTitle) would clip long content invisibly at the visible
  // column width. Multi-line + autogrow means long values wrap and become
  // fully visible, and table-layout naturally makes the row as tall as its
  // tallest cell so short cells sit at their content height in the same row.
  // No maxHeight on purpose — merchant explicitly asked for no inner
  // scrollbars anywhere; very long HTML pastes therefore produce very tall
  // rows (the pencil icon jumps to the full editor for real long-form work).
  return (
    <TextField
      label=""
      labelHidden
      autoComplete="off"
      variant="borderless"
      multiline
      value={value}
      onChange={(v) => setEdit(row.id, field, v)}
      tone={isDirty ? "magic" : undefined}
    />
  );
}
