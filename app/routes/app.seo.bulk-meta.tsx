/**
 * Manual bulk-meta editor (SEO_TAB_IMPLEMENTATION_PLAN.md Anhang C3) — Basic+.
 *
 * A spreadsheet-like grid for editing Title / SEO-Title / Meta-Description /
 * Handle across the catalog, one content type at a time. Complements the AI
 * bulk-fix (app.seo._index.tsx's "Fix with AI") for merchants who'd rather
 * type the values themselves.
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
  IndexTable,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { SeoSectionLayout } from "../components/seo/SeoSectionLayout";
import { getFormString, getFormJSON } from "../utils/form-data.utils";
import { meetsPlan } from "../utils/planUtils";
import { isValidShopifyGID } from "../utils/validation";
import type { Plan } from "../config/plans";
import {
  computeDiff,
  applyBulkMetaDiff,
  loadBulkMetaPage,
  BULK_META_TYPES,
  BULK_META_FIELDS,
  BULK_META_PAGE_SIZE,
  MAX_SYNC_SAVE,
  type BulkMetaType,
  type BulkMetaRow,
  type BulkMetaDiffEntry,
  type BulkMetaFailure,
} from "../services/seo/bulk-meta.service";

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
      setEdits({});
      setQueuedBanner(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bulkFetcher.state, bulkFetcher.data]);

  const setEdit = (id: string, field: string, value: string) => {
    setEdits((prev) => ({ ...prev, [`${id}:${field}`]: value }));
  };
  const valueFor = (row: BulkMetaRow, field: keyof BulkMetaRow) =>
    edits[`${row.id}:${field}`] ?? (row[field] as string);

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
      bulkFetcher.submit(
        { action: "seoBulkMeta", contentType: "products", diff: JSON.stringify(dirty) },
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

  const typeOptions = (BULK_META_TYPES as BulkMetaType[]).map((rt) => ({ label: b.types[rt], value: rt }));

  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  const hasPrev = page > 1;
  const hasNext = to < total;

  const saveError = saveFetcher.data && !saveFetcher.data.ok ? b.errorGeneric : null;
  const bulkError = bulkFetcher.data && !bulkFetcher.data.success ? bulkFetcher.data.error || b.errorGeneric : null;

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

              <div style={{ maxWidth: "220px" }}>
                <Select label={b.typeLabel} options={typeOptions} value={type} onChange={handleTypeChange} />
              </div>

              {rows.length === 0 ? (
                <Text as="p" tone="subdued">
                  {b.noRows}
                </Text>
              ) : (
                <BlockStack gap="200">
                  <IndexTable
                    itemCount={rows.length}
                    selectable={false}
                    headings={[
                      { title: b.colTitle },
                      { title: b.colSeoTitle },
                      { title: b.colMetaDescription },
                      { id: "handle", title: b.colHandle, tooltipContent: b.handleWarning },
                      { title: "" },
                    ]}
                  >
                    {(rows as BulkMetaRow[]).map((row, index) => (
                      <IndexTable.Row id={row.id} key={row.id} position={index}>
                        <IndexTable.Cell>
                          <div style={{ minWidth: "160px" }}>
                            <TextField
                              label=""
                              labelHidden
                              autoComplete="off"
                              value={valueFor(row, "title")}
                              onChange={(v) => setEdit(row.id, "title", v)}
                            />
                          </div>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <div style={{ minWidth: "160px" }}>
                            <TextField
                              label=""
                              labelHidden
                              autoComplete="off"
                              value={valueFor(row, "seoTitle")}
                              onChange={(v) => setEdit(row.id, "seoTitle", v)}
                            />
                          </div>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <div style={{ minWidth: "220px" }}>
                            <TextField
                              label=""
                              labelHidden
                              autoComplete="off"
                              multiline={2}
                              value={valueFor(row, "seoDescription")}
                              onChange={(v) => setEdit(row.id, "seoDescription", v)}
                            />
                          </div>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <div style={{ minWidth: "160px" }}>
                            <TextField
                              label=""
                              labelHidden
                              autoComplete="off"
                              value={valueFor(row, "handle")}
                              onChange={(v) => setEdit(row.id, "handle", v)}
                            />
                          </div>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <InlineStack align="end">
                            <Button
                              variant="plain"
                              onClick={() =>
                                handleNavigate(TYPE_EDITOR_PATH[row.type], {
                                  searchParams: new URLSearchParams({ select: row.id }),
                                })
                              }
                            >
                              {b.openInEditor}
                            </Button>
                          </InlineStack>
                        </IndexTable.Cell>
                      </IndexTable.Row>
                    ))}
                  </IndexTable>

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

          {/* Sticky save bar — only shown once there's something dirty to act on. */}
          {dirty.length > 0 && (
            <div
              style={{
                position: "sticky",
                bottom: 0,
                zIndex: 1,
                background: "var(--p-color-bg-surface, #fff)",
                paddingTop: "0.5rem",
              }}
            >
              <Card>
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="span" variant="bodyMd">
                    {b.dirtyCount.replace("{count}", String(dirty.length))}
                  </Text>
                  <InlineStack gap="200">
                    <Button onClick={handleDiscard} disabled={saving}>
                      {b.discardButton}
                    </Button>
                    <Button variant="primary" onClick={handleSave} loading={saving}>
                      {b.saveButton}
                    </Button>
                  </InlineStack>
                </InlineStack>
              </Card>
            </div>
          )}
        </BlockStack>
      )}
    </SeoSectionLayout>
  );
}
