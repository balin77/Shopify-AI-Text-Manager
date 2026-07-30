/**
 * Internal Linking Suggestions section (PLAN_SEO_SUITE_COMPLETION.md §4.2,
 * Phase 2) — Pro+.
 *
 * "Vorschläge generieren" kicks off the detached "seoInternalLinks" Task
 * through the shared /api/ai route (same fire-and-forget + poll pattern as
 * the crawl section's "Jetzt scannen").
 *
 * TWO LISTS, one route: the operations bar switches between `view=open`
 * (status "pending") and `view=rejected` (status "dismissed") via the URL, so
 * the loader — not the client — decides what is listed, counted and paged.
 * Both views are server-paginated (PAGE_SIZE per page, type filters applied in
 * SQL) because the rejected list grows without a cap, unlike the pending list
 * (MAX_PENDING_PER_SHOP). A rejected suggestion can still be accepted later
 * from its list, or moved back to "open" ("restore").
 *
 * Rejecting is permanent (`dismissedUntil: null` → never revived by a later
 * run, and the anchor is fed into the next run's synonym prompt as a
 * do-not-repeat — see internal-links.service.ts's header). There is
 * deliberately no "ignore for 90 days" action; rows that still carry a future
 * `dismissedUntil` from that removed action simply show up in the rejected
 * list until it lapses.
 *
 * Accept is a two-step flow — which is why the row button says "Prüfen" and not
 * "Akzeptieren": it only opens the preview, and the merchant can still accept OR
 * reject from inside the modal.
 *   1. "previewAccept" (this route's action) computes the cheerio-based
 *      insertion server-side (internal-links.service.ts's
 *      `insertLinkIntoHtml`) against the CURRENT DB content and returns
 *      before/after HTML — nothing is written yet.
 *   2. On confirm, the client submits the new HTML straight to the real
 *      per-resource-type editor route's `action` (`/app/products`,
 *      `/app/collections`, `/app/blog`, `/app/pages` — same
 *      `handleUnifiedContentActions` those routes already use for every
 *      other save). This is the ONLY write path — there is no parallel save
 *      handler here (CLAUDE.md architecture invariant). Only once that save
 *      succeeds does the client mark the suggestion "accepted"
 *      (`markAccepted`, also on this route).
 */

import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useRevalidator } from "@remix-run/react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Button,
  ButtonGroup,
  Banner,
  Select,
  Modal,
} from "@shopify/polaris";
import { ChevronLeftIcon, ChevronRightIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { SeoSectionLayout } from "../components/seo/SeoSectionLayout";
import { getFormString } from "../utils/form-data.utils";
import { meetsPlan } from "../utils/planUtils";
import type { Plan } from "../config/plans";
import { getCachedShopLocales } from "../utils/shop-locales-cache.server";
import { insertLinkIntoHtml, targetUrlPath } from "../services/seo/internal-links.service";

// resourceType -> the real editor route + field key that resourceType saves
// through (contentConfig field key from content-fields.config.tsx). The
// SAME map as crawl.tsx's TYPE_PATH / the dashboard's TYPE_PATH, extended
// with the field the Accept flow writes.
const RESOURCE_ROUTE: Record<string, { path: string; fieldKey: "description" | "body" }> = {
  Product: { path: "/app/products", fieldKey: "description" },
  Collection: { path: "/app/collections", fieldKey: "description" },
  Article: { path: "/app/blog", fieldKey: "body" },
  Page: { path: "/app/pages", fieldKey: "body" },
};

const FILTER_TYPES = ["Product", "Collection", "Article", "Page"] as const;
type FilterType = (typeof FILTER_TYPES)[number];

/** Suggestions per page (both views). Server-side — see the header note. */
export const PAGE_SIZE = 20;

const VIEWS = ["open", "rejected"] as const;
type View = (typeof VIEWS)[number];

/** URL `view` -> the DB status that view lists. */
const VIEW_STATUS: Record<View, string> = { open: "pending", rejected: "dismissed" };

interface SuggestionRow {
  id: string;
  fromResourceType: FilterType;
  fromResourceId: string;
  fromTitle: string;
  anchorText: string;
  toResourceType: FilterType;
  toResourceId: string;
  toTitle: string;
  confidence: number;
}

const EXAMPLE_ROWS: SuggestionRow[] = [
  {
    id: "example-1",
    fromResourceType: "Article",
    fromResourceId: "example",
    fromTitle: "5 Tipps für die Wohnzimmer-Deko",
    anchorText: "Keramikvase",
    toResourceType: "Product",
    toResourceId: "example",
    toTitle: "Grüne Keramikvase",
    confidence: 0.85,
  },
  {
    id: "example-2",
    fromResourceType: "Page",
    fromResourceId: "example",
    fromTitle: "Über uns",
    anchorText: "handgefertigte Vasen",
    toResourceType: "Collection",
    toResourceId: "example",
    toTitle: "Vasen",
    confidence: 0.7,
  },
];

async function loadPlan(db: any, shop: string): Promise<Plan> {
  const settings = await db.aISettings.findUnique({ where: { shop }, select: { subscriptionPlan: true } });
  return (settings?.subscriptionPlan || "free") as Plan;
}

/** id -> {title, handle} across all four resource types, batched. */
async function resolveTitles(
  db: any,
  shop: string,
  idsByType: Record<FilterType, Set<string>>,
): Promise<Map<string, { title: string; handle: string }>> {
  const [products, collections, articles, pages] = await Promise.all([
    idsByType.Product.size
      ? db.product.findMany({ where: { shop, id: { in: Array.from(idsByType.Product) } }, select: { id: true, title: true, handle: true } })
      : Promise.resolve([]),
    idsByType.Collection.size
      ? db.collection.findMany({ where: { shop, id: { in: Array.from(idsByType.Collection) } }, select: { id: true, title: true, handle: true } })
      : Promise.resolve([]),
    idsByType.Article.size
      ? db.article.findMany({ where: { shop, id: { in: Array.from(idsByType.Article) } }, select: { id: true, title: true, handle: true } })
      : Promise.resolve([]),
    idsByType.Page.size
      ? db.page.findMany({ where: { shop, id: { in: Array.from(idsByType.Page) } }, select: { id: true, title: true, handle: true } })
      : Promise.resolve([]),
  ]);
  const map = new Map<string, { title: string; handle: string }>();
  for (const p of products as Array<{ id: string; title: string; handle: string }>) map.set(`Product:${p.id}`, { title: p.title, handle: p.handle });
  for (const c of collections as Array<{ id: string; title: string; handle: string }>) map.set(`Collection:${c.id}`, { title: c.title, handle: c.handle });
  for (const a of articles as Array<{ id: string; title: string; handle: string }>) map.set(`Article:${a.id}`, { title: a.title, handle: a.handle });
  for (const p of pages as Array<{ id: string; title: string; handle: string }>) map.set(`Page:${p.id}`, { title: p.title, handle: p.handle });
  return map;
}

function parseView(raw: string | null): View {
  return VIEWS.includes(raw as View) ? (raw as View) : "open";
}

function parseTypeFilter(raw: string | null): FilterType | null {
  return FILTER_TYPES.includes(raw as FilterType) ? (raw as FilterType) : null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");
  const shop = session.shop;

  const plan = await loadPlan(db, shop);
  if (!meetsPlan(plan, "pro")) {
    return json({
      gated: true,
      running: false,
      lastRun: null as string | null,
      primaryLocale: "",
      view: "open" as View,
      fromFilter: "all",
      toFilter: "all",
      page: 1,
      pageSize: PAGE_SIZE,
      total: EXAMPLE_ROWS.length,
      openCount: EXAMPLE_ROWS.length,
      rejectedCount: 0,
      rows: EXAMPLE_ROWS,
    });
  }

  const url = new URL(request.url);
  const view = parseView(url.searchParams.get("view"));
  const fromFilter = parseTypeFilter(url.searchParams.get("from"));
  const toFilter = parseTypeFilter(url.searchParams.get("to"));

  // Filters live in the WHERE clause, not in the client — otherwise page 1 of
  // a filtered list would only contain whatever survived filtering out of the
  // first unfiltered page.
  const where = {
    shop,
    status: VIEW_STATUS[view],
    ...(fromFilter ? { fromResourceType: fromFilter } : {}),
    ...(toFilter ? { toResourceType: toFilter } : {}),
  };

  const shopLocales = await getCachedShopLocales(admin, shop).catch(() => []);
  const primaryLocale = shopLocales.find((l) => l.primary)?.locale ?? "";

  const [runningTask, lastTask, total, openCount, rejectedCount] = await Promise.all([
    db.task.findFirst({ where: { shop, type: "seoInternalLinks", status: "running" }, select: { id: true } }),
    db.task.findFirst({
      where: { shop, type: "seoInternalLinks", status: { in: ["completed", "failed"] } },
      orderBy: { completedAt: "desc" },
      select: { completedAt: true },
    }),
    db.seoInternalLinkSuggestion.count({ where }),
    db.seoInternalLinkSuggestion.count({ where: { shop, status: "pending" } }),
    db.seoInternalLinkSuggestion.count({ where: { shop, status: "dismissed" } }),
  ]);

  // Clamp instead of 404ing: a page that existed before a reject/accept (or
  // before a filter change) must not leave the merchant on an empty list.
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const requestedPage = Number.parseInt(url.searchParams.get("page") || "1", 10);
  const page = Math.min(Math.max(Number.isFinite(requestedPage) ? requestedPage : 1, 1), totalPages);

  const suggestions = await db.seoInternalLinkSuggestion.findMany({
    where,
    // Rejected rows are most useful newest-first (what did I just turn down?);
    // open ones highest-confidence-first. `id` breaks ties so paging is stable.
    orderBy: view === "rejected" ? [{ updatedAt: "desc" }, { id: "asc" }] : [{ confidence: "desc" }, { id: "asc" }],
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
  });

  const idsByType: Record<FilterType, Set<string>> = {
    Product: new Set(),
    Collection: new Set(),
    Article: new Set(),
    Page: new Set(),
  };
  for (const s of suggestions) {
    idsByType[s.fromResourceType as FilterType]?.add(s.fromResourceId);
    idsByType[s.toResourceType as FilterType]?.add(s.toResourceId);
  }
  const titleMap = await resolveTitles(db, shop, idsByType);

  const rows: SuggestionRow[] = suggestions.map((s) => ({
    id: s.id,
    fromResourceType: s.fromResourceType as FilterType,
    fromResourceId: s.fromResourceId,
    fromTitle: titleMap.get(`${s.fromResourceType}:${s.fromResourceId}`)?.title ?? s.fromResourceId,
    anchorText: s.anchorText,
    toResourceType: s.toResourceType as FilterType,
    toResourceId: s.toResourceId,
    toTitle: titleMap.get(`${s.toResourceType}:${s.toResourceId}`)?.title ?? s.toResourceId,
    confidence: s.confidence,
  }));

  return json({
    gated: false,
    running: !!runningTask,
    lastRun: lastTask?.completedAt ? lastTask.completedAt.toISOString() : null,
    primaryLocale,
    view,
    fromFilter: fromFilter ?? "all",
    toFilter: toFilter ?? "all",
    page,
    pageSize: PAGE_SIZE,
    total,
    openCount,
    rejectedCount,
    rows,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { db } = await import("../db.server");
  const shop = session.shop;
  const formData = await request.formData();
  const actionType = getFormString(formData, "actionType");
  const suggestionId = getFormString(formData, "suggestionId");

  const suggestion = suggestionId
    ? await db.seoInternalLinkSuggestion.findFirst({ where: { id: suggestionId, shop } })
    : null;
  if (!suggestion) {
    return json({ success: false, error: "Suggestion not found" }, { status: 404 });
  }

  if (actionType === "reject") {
    // Permanent: `dismissedUntil: null` is never revived by a later run, and
    // the anchor is passed into the next run's synonym prompt as a
    // do-not-repeat (internal-links.service.ts, rejectedAnchorsByTarget).
    await db.seoInternalLinkSuggestion.update({
      where: { id: suggestion.id },
      data: { status: "dismissed", dismissedUntil: null },
    });
    return json({ success: true });
  }

  if (actionType === "restore") {
    // Back to the open list. Clearing `dismissedUntil` keeps the row a normal
    // pending suggestion (and drops it out of the rejection feedback).
    await db.seoInternalLinkSuggestion.update({
      where: { id: suggestion.id },
      data: { status: "pending", dismissedUntil: null },
    });
    return json({ success: true });
  }

  if (actionType === "markAccepted") {
    await db.seoInternalLinkSuggestion.update({
      where: { id: suggestion.id },
      data: { status: "accepted", dismissedUntil: null },
    });
    return json({ success: true });
  }

  if (actionType === "previewAccept") {
    const fromRoute = RESOURCE_ROUTE[suggestion.fromResourceType];
    if (!fromRoute) {
      return json({ success: false, error: "Unsupported source resource type" }, { status: 400 });
    }

    // Current content — always read fresh (not the value at suggestion-
    // generation time), so a stale suggestion is detected instead of
    // silently overwriting an edit made since.
    let currentHtml: string | null = null;
    if (suggestion.fromResourceType === "Product") {
      const row = await db.product.findFirst({ where: { id: suggestion.fromResourceId, shop }, select: { descriptionHtml: true } });
      currentHtml = row?.descriptionHtml ?? null;
    } else if (suggestion.fromResourceType === "Collection") {
      const row = await db.collection.findFirst({ where: { id: suggestion.fromResourceId, shop }, select: { descriptionHtml: true } });
      currentHtml = row?.descriptionHtml ?? null;
    } else if (suggestion.fromResourceType === "Article") {
      const row = await db.article.findFirst({ where: { id: suggestion.fromResourceId, shop }, select: { body: true } });
      currentHtml = row?.body ?? null;
    } else if (suggestion.fromResourceType === "Page") {
      const row = await db.page.findFirst({ where: { id: suggestion.fromResourceId, shop }, select: { body: true } });
      currentHtml = row?.body ?? null;
    }

    if (currentHtml === null) {
      return json({ success: false, error: "Source content not found" }, { status: 404 });
    }

    let targetHandle: string | null = null;
    if (suggestion.toResourceType === "Product") {
      targetHandle = (await db.product.findFirst({ where: { id: suggestion.toResourceId, shop }, select: { handle: true } }))?.handle ?? null;
    } else if (suggestion.toResourceType === "Collection") {
      targetHandle = (await db.collection.findFirst({ where: { id: suggestion.toResourceId, shop }, select: { handle: true } }))?.handle ?? null;
    }
    if (!targetHandle) {
      return json({ success: false, error: "Target content not found" }, { status: 404 });
    }

    const href = targetUrlPath({ resourceType: suggestion.toResourceType as "Product" | "Collection", handle: targetHandle });
    const result = insertLinkIntoHtml(currentHtml, suggestion.anchorText, href);

    if (!result.inserted) {
      return json({ success: false, code: "STALE", error: "Anchor text not found in current content" }, { status: 409 });
    }

    return json({
      success: true,
      before: currentHtml,
      after: result.html,
      savePath: fromRoute.path,
      fieldKey: fromRoute.fieldKey,
      itemId: suggestion.fromResourceId,
    });
  }

  return json({ success: false, error: `Unknown actionType: ${actionType}` }, { status: 400 });
};

function formatDate(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/**
 * Fixed column grid for a suggestion's three lines. Every line uses the SAME
 * template, so the arrow, the type badges and the titles line up vertically
 * down the whole list — a plain InlineStack per line drifts as soon as one row
 * says "Kollektion" and the next says "Produkt".
 */
const ROW_GRID: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1.25rem 7.5rem minmax(0, 1fr)",
  alignItems: "center",
  // Grid blockifies its items, so without this a Badge (inline-flex) would
  // stretch to the full 7.5rem column instead of hugging its label.
  justifyItems: "start",
  columnGap: "0.5rem",
  rowGap: "0.125rem",
};

export default function SeoInternalLinks() {
  const data = useLoaderData<typeof loader>();
  const { t } = useI18n();
  const { handleNavigate } = useAppNavigation();
  const c = (t.seo as any).internalLinksPage as Record<string, string>;
  const resourceTypeLabel = (t.tasks as any).resourceType as Record<string, string>;

  const typeLabel = (type: FilterType): string => {
    if (type === "Article") return resourceTypeLabel.blog;
    return resourceTypeLabel[type.toLowerCase()] || type;
  };

  const generateFetcher = useFetcher<{ success: boolean; error?: string; taskId?: string }>();
  const rowFetcher = useFetcher<{ success: boolean; error?: string }>();
  const previewFetcher = useFetcher<{
    success: boolean;
    error?: string;
    code?: string;
    before?: string;
    after?: string;
    savePath?: string;
    fieldKey?: "description" | "body";
    itemId?: string;
  }>();
  const saveFetcher = useFetcher<{ success: boolean; error?: string }>();

  const [generateStarted, setGenerateStarted] = useState(false);
  const [banner, setBanner] = useState<{ tone: "critical" | "success"; message: string } | null>(null);
  const generateStartedAtRef = useRef(0);

  const [previewRow, setPreviewRow] = useState<SuggestionRow | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    if (generateFetcher.state !== "idle" || !generateFetcher.data) return;
    if (generateFetcher.data.success) {
      generateStartedAtRef.current = Date.now();
      setGenerateStarted(true);
    } else {
      setBanner({ tone: "critical", message: generateFetcher.data.error || c.generateStartError });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generateFetcher.state, generateFetcher.data]);

  const generating = data.running || generateStarted;

  const revalidator = useRevalidator();
  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;
  useEffect(() => {
    if (!generating) return;
    const interval = setInterval(() => revalidatorRef.current.revalidate(), 3000);
    return () => clearInterval(interval);
  }, [generating]);
  useEffect(() => {
    if (!generateStarted || data.running) return;
    if (Date.now() - generateStartedAtRef.current > 5000) setGenerateStarted(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.running, generateStarted]);

  const handleGenerate = () => {
    if (data.gated || generating || generateFetcher.state !== "idle") return;
    setBanner(null);
    const formData = new FormData();
    formData.append("action", "seoInternalLinks");
    formData.append("contentType", "products");
    generateFetcher.submit(formData, { method: "post", action: "/api/ai" });
  };

  // View / filter / page all live in the URL so the loader owns paging.
  // `handleNavigate` (not raw navigate) keeps the Shopify session params — it
  // MERGES over the current query string, so "no filter" has to be an explicit
  // value ("all", which the loader parses as no filter) rather than a delete.
  const goTo = (params: Record<string, string>) => {
    handleNavigate("/app/seo/internal-links", {
      searchParams: new URLSearchParams(params),
      replace: true,
    });
  };

  const submitRowAction = (row: SuggestionRow, actionType: "reject" | "restore") => {
    const formData = new FormData();
    formData.append("actionType", actionType);
    formData.append("suggestionId", row.id);
    rowFetcher.submit(formData, { method: "post" });
  };

  useEffect(() => {
    if (rowFetcher.state !== "idle" || !rowFetcher.data) return;
    if (rowFetcher.data.success) {
      revalidatorRef.current.revalidate();
    } else {
      setBanner({ tone: "critical", message: rowFetcher.data.error || c.actionError });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowFetcher.state, rowFetcher.data]);

  const openPreview = (row: SuggestionRow) => {
    setPreviewRow(row);
    setPreviewError(null);
    const formData = new FormData();
    formData.append("actionType", "previewAccept");
    formData.append("suggestionId", row.id);
    previewFetcher.submit(formData, { method: "post" });
  };

  useEffect(() => {
    if (previewFetcher.state !== "idle" || !previewFetcher.data) return;
    if (!previewFetcher.data.success) {
      setPreviewError(
        previewFetcher.data.code === "STALE" ? c.previewStaleError : previewFetcher.data.error || c.previewLoadError,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewFetcher.state, previewFetcher.data]);

  const confirmAccept = () => {
    const preview = previewFetcher.data;
    if (!previewRow || !preview?.success || !preview.savePath || !preview.fieldKey || !preview.itemId) return;

    const formData = new FormData();
    formData.append("action", "updateContent");
    formData.append("itemId", preview.itemId);
    formData.append("locale", data.primaryLocale);
    formData.append("primaryLocale", data.primaryLocale);
    formData.append(preview.fieldKey, preview.after || "");
    formData.append("changedFields", JSON.stringify([preview.fieldKey]));

    saveFetcher.submit(formData, { method: "post", action: preview.savePath });
  };

  useEffect(() => {
    if (saveFetcher.state !== "idle" || !saveFetcher.data || !previewRow) return;
    if (saveFetcher.data.success) {
      const formData = new FormData();
      formData.append("actionType", "markAccepted");
      formData.append("suggestionId", previewRow.id);
      rowFetcher.submit(formData, { method: "post" });
      setBanner({ tone: "success", message: c.acceptSuccess });
      setPreviewRow(null);
    } else {
      setPreviewError(saveFetcher.data.error || c.acceptSaveError);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveFetcher.state, saveFetcher.data]);

  // Reject straight out of the preview modal — the point of the modal is that
  // the merchant inspects the insertion before deciding, so "no" has to be
  // reachable from there too, not only from the list row behind it.
  const rejectFromPreview = () => {
    if (!previewRow) return;
    submitRowAction(previewRow, "reject");
    setBanner({ tone: "success", message: c.rejectSuccess });
    setPreviewRow(null);
  };

  const openInEditor = (type: FilterType, id: string) => {
    const path = RESOURCE_ROUTE[type]?.path;
    if (path) handleNavigate(path, { searchParams: new URLSearchParams({ select: id }) });
  };

  const rejectedView = data.view === "rejected";
  const rows = data.rows;
  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const firstOnPage = data.total === 0 ? 0 : (data.page - 1) * data.pageSize + 1;
  const lastOnPage = Math.min(data.page * data.pageSize, data.total);

  const suggestionRow = (row: SuggestionRow) => (
    <div
      key={row.id}
      style={{
        border: "1px solid var(--p-color-border-secondary)",
        borderRadius: 8,
        padding: "0.75rem",
        background: "var(--p-color-bg-surface)",
      }}
    >
      <InlineStack gap="300" align="space-between" blockAlign="start" wrap>
        <div style={{ ...ROW_GRID, flex: "1 1 22rem" }}>
          {/* Line 1 — source */}
          <span />
          <Badge>{typeLabel(row.fromResourceType)}</Badge>
          <div style={{ maxWidth: "100%" }}>
            <Button variant="plain" onClick={() => openInEditor(row.fromResourceType, row.fromResourceId)}>
              {row.fromTitle}
            </Button>
          </div>

          {/* Line 2 — the mentioned text, aligned under the titles */}
          <span />
          <Text as="span" variant="bodySm" tone="subdued" truncate>
            {c.colAnchor}
          </Text>
          <Text as="span" variant="bodySm" tone="subdued">
            {`„${row.anchorText}“`}
          </Text>

          {/* Line 3 — target */}
          <Text as="span" variant="bodySm" tone="subdued">
            →
          </Text>
          <Badge tone="info">{typeLabel(row.toResourceType)}</Badge>
          <div style={{ maxWidth: "100%" }}>
            <Button variant="plain" onClick={() => openInEditor(row.toResourceType, row.toResourceId)}>
              {row.toTitle}
            </Button>
          </div>
        </div>

        <InlineStack gap="200" blockAlign="center">
          <Badge tone={row.confidence >= 0.8 ? "success" : row.confidence >= 0.6 ? "attention" : undefined}>
            {`${Math.round(row.confidence * 100)}%`}
          </Badge>
          <Button size="slim" variant="primary" onClick={() => openPreview(row)}>
            {c.review}
          </Button>
          {rejectedView ? (
            <Button size="slim" onClick={() => submitRowAction(row, "restore")} disabled={rowFetcher.state !== "idle"}>
              {c.restore}
            </Button>
          ) : (
            <Button size="slim" tone="critical" onClick={() => submitRowAction(row, "reject")} disabled={rowFetcher.state !== "idle"}>
              {c.reject}
            </Button>
          )}
        </InlineStack>
      </InlineStack>
    </div>
  );

  const body = (
    <BlockStack gap="400">
      <Banner tone="info" title={c.introTitle}>
        <Text as="p" variant="bodyMd">{c.introBody}</Text>
      </Banner>

      <Card>
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
            <ButtonGroup variant="segmented">
              <Button
                pressed={!rejectedView}
                onClick={() => goTo({ view: "open", page: "1" })}
              >
                {c.viewOpen.replace("{count}", String(data.openCount))}
              </Button>
              <Button
                pressed={rejectedView}
                onClick={() => goTo({ view: "rejected", page: "1" })}
              >
                {c.viewRejected.replace("{count}", String(data.rejectedCount))}
              </Button>
            </ButtonGroup>
            <InlineStack gap="300" blockAlign="center" wrap>
              <Text as="p" variant="bodySm" tone="subdued">
                {data.lastRun ? c.lastGenerated.replace("{time}", formatDate(data.lastRun)) : c.neverGenerated}
              </Text>
              <Button
                variant="primary"
                onClick={handleGenerate}
                disabled={data.gated || generating || generateFetcher.state !== "idle"}
                loading={generateFetcher.state !== "idle"}
              >
                {c.generateButton}
              </Button>
            </InlineStack>
          </InlineStack>

          {banner && (
            <Banner tone={banner.tone} onDismiss={() => setBanner(null)}>
              {banner.message}
            </Banner>
          )}
          {!banner && generating && <Banner tone="info">{c.generating}</Banner>}
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="300">
          {rejectedView && (
            <Text as="p" variant="bodySm" tone="subdued">
              {c.rejectedHint}
            </Text>
          )}

          <InlineStack gap="300" wrap>
            <div style={{ minWidth: 180 }}>
              <Select
                label={c.filterFromLabel}
                options={[{ label: c.filterAll, value: "all" }, ...FILTER_TYPES.map((ft) => ({ label: typeLabel(ft), value: ft }))]}
                value={data.fromFilter}
                onChange={(value) => goTo({ from: value, page: "1" })}
              />
            </div>
            <div style={{ minWidth: 180 }}>
              <Select
                label={c.filterToLabel}
                options={[{ label: c.filterAll, value: "all" }, ...FILTER_TYPES.map((ft) => ({ label: typeLabel(ft), value: ft }))]}
                value={data.toFilter}
                onChange={(value) => goTo({ to: value, page: "1" })}
              />
            </div>
          </InlineStack>

          {rows.length === 0 ? (
            <Text as="p" tone="subdued">{rejectedView ? c.emptyRejected : c.empty}</Text>
          ) : (
            <BlockStack gap="200">{rows.map(suggestionRow)}</BlockStack>
          )}

          {totalPages > 1 && (
            <InlineStack align="space-between" blockAlign="center">
              <Text as="p" variant="bodySm" tone="subdued">
                {c.paginationRange
                  .replace("{start}", String(firstOnPage))
                  .replace("{end}", String(lastOnPage))
                  .replace("{total}", String(data.total))}
              </Text>
              <InlineStack gap="200" blockAlign="center">
                <Button
                  icon={ChevronLeftIcon}
                  accessibilityLabel={c.paginationPrevious}
                  disabled={data.page <= 1}
                  onClick={() => goTo({ page: String(data.page - 1) })}
                />
                <Text as="span" variant="bodySm">{`${data.page} / ${totalPages}`}</Text>
                <Button
                  icon={ChevronRightIcon}
                  accessibilityLabel={c.paginationNext}
                  disabled={data.page >= totalPages}
                  onClick={() => goTo({ page: String(data.page + 1) })}
                />
              </InlineStack>
            </InlineStack>
          )}
        </BlockStack>
      </Card>
    </BlockStack>
  );

  const previewLoading = previewFetcher.state !== "idle";
  const previewData = previewFetcher.data;

  const modal = (
    <Modal
      open={!!previewRow}
      onClose={() => setPreviewRow(null)}
      title={c.previewModalTitle}
      primaryAction={{
        content: c.previewConfirm,
        disabled: previewLoading || !previewData?.success,
        loading: saveFetcher.state !== "idle",
        onAction: confirmAccept,
      }}
      secondaryActions={[
        // Already-rejected rows only get "close" here — the row itself offers
        // "restore", which is the meaningful action in that view.
        ...(rejectedView
          ? []
          : [{
              content: c.reject,
              destructive: true,
              disabled: rowFetcher.state !== "idle" || saveFetcher.state !== "idle",
              onAction: rejectFromPreview,
            }]),
        { content: c.previewCancel, onAction: () => setPreviewRow(null) },
      ]}
    >
      <Modal.Section>
        <BlockStack gap="300">
          <Text as="p" variant="bodyMd">{c.previewModalIntro}</Text>
          {previewError && <Banner tone="critical">{previewError}</Banner>}
          {previewLoading && !previewError && <Text as="p" tone="subdued">…</Text>}
          {previewData?.success && (
            <BlockStack gap="300">
              <BlockStack gap="100">
                <Text as="h4" variant="headingSm">{c.previewBeforeLabel}</Text>
                <div
                  style={{ border: "1px solid var(--p-color-border)", borderRadius: 8, padding: "0.75rem" }}
                  dangerouslySetInnerHTML={{ __html: previewData.before || "" }}
                />
              </BlockStack>
              <BlockStack gap="100">
                <Text as="h4" variant="headingSm">{c.previewAfterLabel}</Text>
                <div
                  style={{ border: "1px solid var(--p-color-border-success)", borderRadius: 8, padding: "0.75rem" }}
                  dangerouslySetInnerHTML={{ __html: previewData.after || "" }}
                />
              </BlockStack>
            </BlockStack>
          )}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );

  if (data.gated) {
    return (
      <SeoSectionLayout
        sectionId="internalLinks"
        lockedExtra={
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">{c.upgradeExampleTitle}</Text>
              <BlockStack gap="200">
                {EXAMPLE_ROWS.map((row) => (
                  <InlineStack key={row.id} gap="300" align="space-between" blockAlign="center" wrap>
                    <Text as="span" variant="bodySm">
                      {row.fromTitle} → „{row.anchorText}“ → {row.toTitle}
                    </Text>
                    <Badge>{`${Math.round(row.confidence * 100)}%`}</Badge>
                  </InlineStack>
                ))}
              </BlockStack>
            </BlockStack>
          </Card>
        }
      >
        {null}
      </SeoSectionLayout>
    );
  }

  return (
    <SeoSectionLayout sectionId="internalLinks">
      {body}
      {modal}
    </SeoSectionLayout>
  );
}
