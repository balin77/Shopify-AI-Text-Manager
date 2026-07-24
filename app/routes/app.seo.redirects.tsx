/**
 * Redirects & 404 section (SEO_TAB_IMPLEMENTATION_PLAN.md Phase 3 / A4).
 *
 * - Native URL redirect management via the Admin API (list/create/update/delete),
 *   paginated + searchable, with inline edit and CSV import/export.
 * - A "frequent 404s" panel fed by the self-hosted Seo404Hit collector, with a
 *   one-click "create redirect" that prefills the missing path and marks the
 *   hit redirected. When a fuzzy-matching handle exists on the shop, the target
 *   field is pre-suggested (placeholder only).
 *
 * All writes go through the route action; the page uses fetchers so it stays put.
 */

import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useSearchParams } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import {
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  TextField,
  Banner,
  IndexTable,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { useConfirm } from "../contexts/ConfirmContext";
import { SeoSectionLayout } from "../components/seo/SeoSectionLayout";
import { HelpTooltip } from "../components/HelpTooltip";
import {
  listRedirects,
  createRedirect,
  updateRedirect,
  deleteRedirect,
  list404Hits,
  set404Status,
  validateRedirect,
  suggestRedirectTarget,
  type Hit404,
} from "../services/seo/redirects.service";
import {
  parseRedirectsCsv,
  type RedirectCsvError,
} from "../services/seo/redirects-csv";
import {
  GET_PRODUCT_HANDLES,
  GET_COLLECTION_HANDLES,
  GET_PAGE_HANDLES,
} from "../graphql/content.queries";
import { getFormString } from "../utils/form-data.utils";

const IMPORT_ROW_CAP = 1000;

type HitWithSuggestion = Omit<Hit404, "firstSeenAt" | "lastSeenAt"> & {
  firstSeenAt: string | Date;
  lastSeenAt: string | Date;
  suggestedTarget: string | null;
};

interface LoaderData {
  redirects: Array<{ id: string; path: string; target: string }>;
  hasNextPage: boolean;
  endCursor: string | null;
  q: string;
  hits: HitWithSuggestion[];
}

type ExportPayload = { csv: string; filename: string; rowCount: number };

async function fetchAllHandles(admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"]): Promise<string[]> {
  // Missing scopes (products/collections/pages) or a shop-side hiccup on any
  // single fetch degrades to an empty list for that resource — suggestions are
  // best-effort, not a source of truth.
  const safeFetch = async (query: string, prefix: string): Promise<string[]> => {
    try {
      const res = await admin.graphql(query, { variables: { first: 250 } });
      const body = await res.json();
      const key = prefix === "/products/" ? "products" : prefix === "/collections/" ? "collections" : "pages";
      const edges = body?.data?.[key]?.edges ?? [];
      return edges
        .map((e: { node?: { handle?: string } }) => e?.node?.handle)
        .filter((h: unknown): h is string => typeof h === "string" && h.length > 0)
        .map((h: string) => `${prefix}${h}`);
    } catch {
      return [];
    }
  };
  const [products, collections, pages] = await Promise.all([
    safeFetch(GET_PRODUCT_HANDLES, "/products/"),
    safeFetch(GET_COLLECTION_HANDLES, "/collections/"),
    safeFetch(GET_PAGE_HANDLES, "/pages/"),
  ]);
  return [...products, ...collections, ...pages];
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");

  const url = new URL(request.url);
  const q = url.searchParams.get("q") || "";
  const after = url.searchParams.get("after") || null;

  const [redirectsResult, hits, handles] = await Promise.all([
    listRedirects(admin, { first: 50, after, query: q }),
    list404Hits(db, session.shop, { status: "new", limit: 100 }),
    fetchAllHandles(admin),
  ]);

  const enrichedHits: HitWithSuggestion[] = hits.map((h) => ({
    ...h,
    suggestedTarget: suggestRedirectTarget(handles, h.path),
  }));

  return json({
    redirects: redirectsResult.redirects,
    hasNextPage: redirectsResult.hasNextPage,
    endCursor: redirectsResult.endCursor,
    q,
    hits: enrichedHits,
  });
};

type ImportError = { row: number; path: string; error: string };
type ActionResult =
  | { ok: true; kind: "created" | "updated" | "deleted" | "dismissed" }
  | { ok: true; kind: "imported"; created: number; skipped: number; errors: ImportError[] }
  | { ok: false; error: string; detail?: string };

export const action = async ({ request }: ActionFunctionArgs): Promise<Response> => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");
  const form = await request.formData();
  const actionType = getFormString(form, "actionType");

  if (actionType === "createRedirect" || actionType === "createFromHit") {
    const path = getFormString(form, "path");
    const target = getFormString(form, "target");
    const err = validateRedirect({ path, target });
    if (err) return json<ActionResult>({ ok: false, error: err }, { status: 400 });

    const res = await createRedirect(admin, { path, target });
    if (res.userErrors.length > 0 || !res.redirect) {
      const detail = res.userErrors.map((e) => e.message).filter(Boolean).join("; ") || undefined;
      return json<ActionResult>({ ok: false, error: "createFailed", detail }, { status: 400 });
    }
    if (actionType === "createFromHit") {
      const hitId = getFormString(form, "hitId");
      if (hitId) await set404Status(db, session.shop, hitId, "redirected");
    }
    return json<ActionResult>({ ok: true, kind: "created" });
  }

  if (actionType === "updateRedirect") {
    const id = getFormString(form, "id");
    const path = getFormString(form, "path");
    const target = getFormString(form, "target");
    const err = validateRedirect({ path, target });
    if (err) return json<ActionResult>({ ok: false, error: err }, { status: 400 });

    const res = await updateRedirect(admin, id, { path, target });
    if (res.userErrors.length > 0 || !res.redirect) {
      const detail = res.userErrors.map((e) => e.message).filter(Boolean).join("; ") || undefined;
      return json<ActionResult>({ ok: false, error: "updateFailed", detail }, { status: 400 });
    }
    return json<ActionResult>({ ok: true, kind: "updated" });
  }

  if (actionType === "deleteRedirect") {
    const id = getFormString(form, "id");
    if (id) await deleteRedirect(admin, id);
    return json<ActionResult>({ ok: true, kind: "deleted" });
  }

  if (actionType === "dismiss404") {
    const hitId = getFormString(form, "hitId");
    if (hitId) await set404Status(db, session.shop, hitId, "dismissed");
    return json<ActionResult>({ ok: true, kind: "dismissed" });
  }

  if (actionType === "importCsv") {
    const payloadRaw = getFormString(form, "payload");
    let payload: { rows: Array<{ path: string; target: string; csvRow: number }>; errors: RedirectCsvError[] };
    try {
      const parsed = JSON.parse(payloadRaw);
      if (!parsed || !Array.isArray(parsed.rows) || !Array.isArray(parsed.errors)) {
        throw new Error("bad shape");
      }
      payload = parsed;
    } catch {
      return json<ActionResult>({ ok: false, error: "importParseFailed" }, { status: 400 });
    }
    if (payload.rows.length > IMPORT_ROW_CAP) {
      return json<ActionResult>({ ok: false, error: "importTooLarge" }, { status: 400 });
    }

    let created = 0;
    let skipped = payload.errors.length;
    // Pre-errors from the parser (e.g. unsupportedRegex) start the list;
    // per-row validation and Shopify-userError entries are appended below.
    const errors: ImportError[] = payload.errors.map((e) => ({
      row: e.row,
      path: e.path,
      error: e.error,
    }));
    // In-CSV duplicates: catch these BEFORE hitting Shopify — otherwise the
    // second row surfaces as a generic "Path is already taken" userError
    // (createFailed), which is indistinguishable from a duplicate against
    // an EXISTING redirect on the shop. Explicit `duplicateInCsv` lets the
    // merchant know it's their own file that has the dupe.
    const seenPaths = new Set<string>();
    // Sequential — Shopify rate-limits burst redirect creates and there is no
    // batch mutation for urlRedirectCreate.
    for (const row of payload.rows) {
      const path = String(row.path ?? "").trim();
      const target = String(row.target ?? "").trim();
      const err = validateRedirect({ path, target });
      if (err) {
        skipped++;
        errors.push({ row: row.csvRow, path, error: err });
        continue;
      }
      if (seenPaths.has(path)) {
        skipped++;
        errors.push({ row: row.csvRow, path, error: "duplicateInCsv" });
        continue;
      }
      seenPaths.add(path);
      const res = await createRedirect(admin, { path, target });
      if (res.userErrors.length > 0 || !res.redirect) {
        skipped++;
        errors.push({ row: row.csvRow, path, error: "createFailed" });
        continue;
      }
      created++;
    }
    errors.sort((a, b) => a.row - b.row);
    return json<ActionResult>({ ok: true, kind: "imported", created, skipped, errors });
  }

  return json<ActionResult>({ ok: false, error: "createFailed" }, { status: 400 });
};

export default function SeoRedirects() {
  // Defensive defaults: if the loader ever bails to an error boundary or
  // `useLoaderData` returns a partial payload, the render still yields empty
  // sections rather than throwing "Cannot read properties of undefined".
  const raw = (useLoaderData() as Partial<LoaderData>) ?? {};
  const loaderRedirects = raw.redirects ?? [];
  const loaderHasNextPage = raw.hasNextPage ?? false;
  const loaderEndCursor = raw.endCursor ?? null;
  const q = raw.q ?? "";
  const hits = raw.hits ?? [];
  const { t } = useI18n();
  const { handleNavigate } = useAppNavigation();
  const confirm = useConfirm();
  const r = t.seo.redirectsPage;

  const createFetcher = useFetcher<ActionResult>();
  const rowFetcher = useFetcher<ActionResult>();
  const importFetcher = useFetcher<ActionResult>();
  const exportFetcher = useFetcher<ExportPayload>();
  // Dedicated fetcher for "Load more" — GET requests to the same loader, kept
  // separate from rowFetcher (used for 404-hit row actions/deletes) so paging
  // never cancels/gets cancelled by an unrelated row action.
  const loadMoreFetcher = useFetcher<LoaderData>();

  // Prefilled by the crawl tab's "Redirect anlegen" deep-link
  // (?newFrom=<path>, PLAN_SEO_SUITE_COMPLETION.md §3.4) — a broken link's
  // target path, so the merchant only has to fill in the "to" side.
  const [searchParams] = useSearchParams();
  const [from, setFrom] = useState(() => searchParams.get("newFrom") || "");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState(q);
  const [hitTargets, setHitTargets] = useState<Record<string, string>>({});

  // Client-side accumulated redirect list so "Load more" appends a page
  // instead of the navigation replacing it. Re-synced to the server's first
  // page whenever the loader re-runs (new search, or a mutation revalidated
  // this route) — otherwise stale/deleted rows could linger in the list.
  const [items, setItems] = useState(loaderRedirects);
  const [cursor, setCursor] = useState(loaderEndCursor);
  const [hasMore, setHasMore] = useState(loaderHasNextPage);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [pendingEditId, setPendingEditId] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPath, setEditPath] = useState("");
  const [editTarget, setEditTarget] = useState("");

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setItems(loaderRedirects);
    setCursor(loaderEndCursor);
    setHasMore(loaderHasNextPage);
  }, [loaderRedirects, loaderEndCursor, loaderHasNextPage]);

  useEffect(() => {
    if (loadMoreFetcher.state === "idle" && loadMoreFetcher.data) {
      const data = loadMoreFetcher.data;
      setItems((prev) => [...prev, ...data.redirects]);
      setCursor(data.endCursor);
      setHasMore(data.hasNextPage);
    }
  }, [loadMoreFetcher.state, loadMoreFetcher.data]);

  useEffect(() => {
    if (createFetcher.state === "idle" && createFetcher.data?.ok && createFetcher.data.kind === "created") {
      setFrom("");
      setTo("");
    }
  }, [createFetcher.state, createFetcher.data]);

  useEffect(() => {
    if (rowFetcher.state === "idle") {
      setPendingDeleteId(null);
      if (rowFetcher.data?.ok && rowFetcher.data.kind === "updated") {
        setEditingId(null);
        setPendingEditId(null);
      }
      if (rowFetcher.data && !rowFetcher.data.ok) {
        setPendingEditId(null);
      }
    }
  }, [rowFetcher.state, rowFetcher.data]);

  // Surface the Shopify userError message when the action forwarded one
  // (`detail`) — e.g. "Path is already taken" or a scope-permission complaint.
  // Without it the merchant only sees the generic i18n string and has no idea
  // whether to change the path, re-authorize, or contact support.
  const appendDetail = (base: string, detail?: string): string =>
    detail ? `${base} (${detail})` : base;

  const createError =
    createFetcher.data && !createFetcher.data.ok
      ? appendDetail(
          (r.errors as Record<string, string>)[createFetcher.data.error] || r.errors.createFailed,
          createFetcher.data.detail,
        )
      : null;

  const rowError =
    rowFetcher.data && !rowFetcher.data.ok
      ? appendDetail(
          (r.errors as Record<string, string>)[rowFetcher.data.error] || r.errors.createFailed,
          rowFetcher.data.detail,
        )
      : null;

  const importError =
    importFetcher.data && !importFetcher.data.ok
      ? appendDetail(
          (r.errors as Record<string, string>)[importFetcher.data.error] || r.errors.createFailed,
          importFetcher.data.detail,
        )
      : null;

  const importResult =
    importFetcher.state === "idle" && importFetcher.data?.ok && importFetcher.data.kind === "imported"
      ? importFetcher.data
      : null;

  const submitSearch = () => {
    const params = new URLSearchParams();
    params.set("q", search);
    params.set("after", "");
    handleNavigate("/app/seo/redirects", { searchParams: params });
  };

  const loadMore = () => {
    if (!cursor) return;
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    params.set("after", cursor);
    loadMoreFetcher.load(`/app/seo/redirects?${params.toString()}`);
  };

  const handleDeleteRedirect = async (redirect: { id: string; path: string }) => {
    const ok = await confirm({
      title: r.deleteConfirmTitle || "Delete this redirect?",
      message:
        r.deleteConfirmBody ||
        `This will permanently delete the redirect from "${redirect.path}". This can't be undone.`,
      confirmLabel: r.deleteButton,
      destructive: true,
    });
    if (!ok) return;
    setPendingDeleteId(redirect.id);
    rowFetcher.submit({ actionType: "deleteRedirect", id: redirect.id }, { method: "post" });
  };

  const beginEdit = (redirect: { id: string; path: string; target: string }) => {
    setEditingId(redirect.id);
    setEditPath(redirect.path);
    setEditTarget(redirect.target);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditPath("");
    setEditTarget("");
  };

  const saveEdit = (id: string) => {
    setPendingEditId(id);
    rowFetcher.submit(
      { actionType: "updateRedirect", id, path: editPath, target: editTarget },
      { method: "post" },
    );
  };

  // Guards the effect below so one export click yields exactly one download —
  // otherwise switching locales or a fetcher re-render would re-fire the
  // Blob build against the same cached response.
  const consumedExportKey = useRef<string | null>(null);
  const handleExport = () => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    // Keying by URL is enough: a re-search yields a different URL and lets
    // the effect fire again for the same route load.
    exportFetcher.load(`/app/seo/redirects/export?${params.toString()}`);
  };

  useEffect(() => {
    if (exportFetcher.state !== "idle" || !exportFetcher.data) return;
    const key = exportFetcher.data.filename + ":" + exportFetcher.data.rowCount;
    if (consumedExportKey.current === key) return;
    consumedExportKey.current = key;

    const blob = new Blob([exportFetcher.data.csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = exportFetcher.data.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [exportFetcher.state, exportFetcher.data]);

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleImportFile = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    ev.target.value = "";
    if (!file) return;
    let text: string;
    try {
      text = await file.text();
    } catch {
      importFetcher.submit(
        { actionType: "importCsv", payload: "not-json" },
        { method: "post" },
      );
      return;
    }
    let payload: ReturnType<typeof parseRedirectsCsv>;
    try {
      payload = parseRedirectsCsv(text);
    } catch {
      importFetcher.submit(
        { actionType: "importCsv", payload: "not-json" },
        { method: "post" },
      );
      return;
    }
    importFetcher.submit(
      { actionType: "importCsv", payload: JSON.stringify(payload) },
      { method: "post" },
    );
  };

  return (
    <SeoSectionLayout sectionId="redirects">
      <BlockStack gap="400">
        <Banner tone="info" title={r.helpTitle}>
          <BlockStack gap="200">
            <Text as="p" variant="bodyMd">{r.helpBody1}</Text>
            <Text as="p" variant="bodyMd">{r.helpBody2}</Text>
          </BlockStack>
        </Banner>

        {/* Frequent 404s */}
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">
              {r.fourOhFourTitle}
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              {r.fourOhFourIntro}
            </Text>
            {rowError && <Banner tone="critical">{rowError}</Banner>}

            {hits.length === 0 ? (
              <Text as="p" tone="subdued">
                {r.no404s}
              </Text>
            ) : (
              <IndexTable
                itemCount={hits.length}
                selectable={false}
                headings={[
                  { title: r.hitPathColumn },
                  { title: r.hitCountColumn },
                  { title: "" },
                ]}
              >
                {hits.map((hit, index) => {
                  const typed = hitTargets[hit.id] ?? "";
                  const placeholder = hit.suggestedTarget || r.targetForHitPlaceholder;
                  const effectiveTarget = typed.trim() || (hit.suggestedTarget ?? "");
                  return (
                    <IndexTable.Row id={hit.id} key={hit.id} position={index}>
                      <IndexTable.Cell>
                        <div style={{ maxWidth: "300px" }}>
                          <Text as="span" variant="bodyMd" truncate>
                            {hit.path}
                          </Text>
                        </div>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" variant="bodySm">{hit.count}</Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <InlineStack gap="200" blockAlign="center" wrap={false}>
                          <div style={{ flex: 1, minWidth: "140px" }}>
                            <TextField
                              label=""
                              labelHidden
                              autoComplete="off"
                              placeholder={placeholder}
                              value={typed}
                              onChange={(v) => setHitTargets((m) => ({ ...m, [hit.id]: v }))}
                            />
                          </div>
                          {hit.suggestedTarget && !typed.trim() && (
                            <Button
                              size="slim"
                              variant="plain"
                              onClick={() =>
                                setHitTargets((m) => ({ ...m, [hit.id]: hit.suggestedTarget! }))
                              }
                            >
                              {r.useSuggestion}
                            </Button>
                          )}
                          <Button
                            variant="primary"
                            size="slim"
                            disabled={!effectiveTarget.trim()}
                            onClick={() =>
                              rowFetcher.submit(
                                {
                                  actionType: "createFromHit",
                                  path: hit.path,
                                  target: effectiveTarget,
                                  hitId: hit.id,
                                },
                                { method: "post" },
                              )
                            }
                          >
                            {r.createRedirectFromHit}
                          </Button>
                          <Button
                            size="slim"
                            onClick={() =>
                              rowFetcher.submit(
                                { actionType: "dismiss404", hitId: hit.id },
                                { method: "post" },
                              )
                            }
                          >
                            {r.dismiss}
                          </Button>
                        </InlineStack>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  );
                })}
              </IndexTable>
            )}
          </BlockStack>
        </Card>

        {/* Create redirect */}
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h3" variant="headingMd">
                {r.redirectsTitle}
              </Text>
              <InlineStack gap="200" blockAlign="center">
                <Button
                  onClick={handleImportClick}
                  loading={importFetcher.state !== "idle"}
                >
                  {r.importCsvButton}
                </Button>
                <Button onClick={handleExport} loading={exportFetcher.state !== "idle"}>{r.exportCsvButton}</Button>
                <HelpTooltip helpKey="redirectsCsvFormat" position="below" />
              </InlineStack>
            </InlineStack>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              style={{ display: "none" }}
              onChange={handleImportFile}
            />
            {createError && <Banner tone="critical">{createError}</Banner>}
            {importError && <Banner tone="critical">{importError}</Banner>}
            {importResult && (
              <Banner tone={importResult.errors.length > 0 ? "warning" : "success"}>
                <BlockStack gap="100">
                  <Text as="p">
                    {r.importResultSummary
                      .replace("{{created}}", String(importResult.created))
                      .replace("{{skipped}}", String(importResult.skipped))}
                  </Text>
                  {importResult.errors.length > 0 && (
                    <BlockStack gap="050">
                      <Text as="p" variant="bodySm" fontWeight="semibold">
                        {r.importResultErrors}
                      </Text>
                      {importResult.errors.slice(0, 5).map((e) => (
                        <Text as="p" variant="bodySm" key={`${e.row}-${e.path}`}>
                          #{e.row} {e.path}: {(r.errors as Record<string, string>)[e.error] || e.error}
                        </Text>
                      ))}
                    </BlockStack>
                  )}
                </BlockStack>
              </Banner>
            )}
            <InlineStack gap="200" blockAlign="end" wrap>
              <div style={{ flex: "1 1 200px" }}>
                <TextField
                  label={r.fromLabel}
                  autoComplete="off"
                  placeholder={r.fromPlaceholder}
                  value={from}
                  onChange={setFrom}
                />
              </div>
              <div style={{ flex: "1 1 200px" }}>
                <TextField
                  label={r.toLabel}
                  autoComplete="off"
                  placeholder={r.toPlaceholder}
                  value={to}
                  onChange={setTo}
                />
              </div>
              <Button
                variant="primary"
                loading={createFetcher.state !== "idle"}
                onClick={() =>
                  createFetcher.submit(
                    { actionType: "createRedirect", path: from, target: to },
                    { method: "post" },
                  )
                }
              >
                {r.createButton}
              </Button>
            </InlineStack>

            {/* Search */}
            <InlineStack gap="200" blockAlign="end">
              <div style={{ flex: 1 }}>
                <TextField
                  label=""
                  labelHidden
                  autoComplete="off"
                  placeholder={r.searchPlaceholder}
                  value={search}
                  onChange={setSearch}
                />
              </div>
              <Button onClick={submitSearch}>{r.searchButton}</Button>
            </InlineStack>

            {/* Redirect list */}
            {items.length === 0 ? (
              <Text as="p" tone="subdued">
                {r.noRedirects}
              </Text>
            ) : (
              <IndexTable
                itemCount={items.length}
                selectable={false}
                headings={[
                  { title: r.pathColumn },
                  { title: r.targetColumn },
                  { title: "" },
                ]}
              >
                {items.map((redirect, index) => {
                  const isEditing = editingId === redirect.id;
                  const rowBusy = rowFetcher.state !== "idle";
                  return (
                    <IndexTable.Row id={redirect.id} key={redirect.id} position={index}>
                      <IndexTable.Cell>
                        {isEditing ? (
                          <TextField
                            label=""
                            labelHidden
                            autoComplete="off"
                            value={editPath}
                            onChange={setEditPath}
                          />
                        ) : (
                          <div style={{ maxWidth: "280px" }}>
                            <Text as="span" variant="bodyMd" truncate>{redirect.path}</Text>
                          </div>
                        )}
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {isEditing ? (
                          <TextField
                            label=""
                            labelHidden
                            autoComplete="off"
                            value={editTarget}
                            onChange={setEditTarget}
                          />
                        ) : (
                          <div style={{ maxWidth: "280px" }}>
                            <Text as="span" variant="bodyMd" truncate>{redirect.target}</Text>
                          </div>
                        )}
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <InlineStack align="end" gap="200">
                          {isEditing ? (
                            <>
                              <Button
                                variant="primary"
                                size="slim"
                                loading={rowBusy && pendingEditId === redirect.id}
                                disabled={rowBusy && pendingEditId !== redirect.id}
                                onClick={() => saveEdit(redirect.id)}
                              >
                                {r.saveButton}
                              </Button>
                              <Button
                                size="slim"
                                disabled={rowBusy && pendingEditId === redirect.id}
                                onClick={cancelEdit}
                              >
                                {r.cancelButton}
                              </Button>
                            </>
                          ) : (
                            <>
                              <Button
                                variant="plain"
                                disabled={rowBusy}
                                onClick={() => beginEdit(redirect)}
                              >
                                {r.editButton}
                              </Button>
                              <Button
                                variant="plain"
                                tone="critical"
                                loading={rowBusy && pendingDeleteId === redirect.id}
                                disabled={rowBusy && pendingDeleteId !== redirect.id}
                                onClick={() => handleDeleteRedirect(redirect)}
                              >
                                {r.deleteButton}
                              </Button>
                            </>
                          )}
                        </InlineStack>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  );
                })}
              </IndexTable>
            )}

            {hasMore && (
              <InlineStack align="center">
                <Button onClick={loadMore} loading={loadMoreFetcher.state !== "idle"}>
                  {r.loadMore}
                </Button>
              </InlineStack>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </SeoSectionLayout>
  );
}
