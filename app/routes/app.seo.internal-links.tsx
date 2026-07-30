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
 * Accept is a two-step flow, and BOTH steps run whichever button was used:
 * "Prüfen" stops between them to show the before/after modal (where the
 * merchant can then confirm or reject), "Annehmen" chains straight through.
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
 *
 * Row actions run on raw fetch, NOT useFetcher: a fetcher has a single slot, so
 * a second accept would cancel the first and leave its row spinning forever.
 * Several suggestions can therefore be applied at the same time, each row
 * locking only itself.
 *
 * "Alle annehmen" / "Alle ablehnen" do the same to the whole listed set
 * (filters included, all pages) in ONE request:
 *   - rejectAll is a single updateMany.
 *   - acceptAll runs the two steps above server-side — same
 *     `handleUnifiedContentActions` entry point, just called in-process. It is
 *     capped at BULK_ACCEPT_LIMIT per request and applies suggestions grouped
 *     by source item (see groupSuggestionsBySource) so links into the same item
 *     never race each other.
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
  type ComplexAction,
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
import { insertLinkIntoHtml, targetUrlPath, groupSuggestionsBySource } from "../services/seo/internal-links.service";

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

/**
 * "Alle annehmen" applies at most this many suggestions per click. Each one is
 * a full editor save (Shopify mutation + stale-translation purge), so the whole
 * pending list — up to MAX_PENDING_PER_SHOP = 200 — would run far past any
 * sensible request duration. The response reports what is left so the merchant
 * can simply click again; "Alle ablehnen" has no such cap because it is a
 * single UPDATE.
 */
export const BULK_ACCEPT_LIMIT = 25;

/**
 * How many source items "Alle annehmen" applies at the same time. Suggestions
 * that share a source item are NEVER parallel (see acceptAll) — each insertion
 * is computed from the content the previous one wrote, so racing them would
 * silently drop a link.
 */
const BULK_ACCEPT_CONCURRENCY = 3;

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

/** Everything this route's action (and the editor route's save) can answer. */
interface ActionResult {
  success: boolean;
  error?: string;
  code?: string;
  before?: string;
  after?: string;
  savePath?: string;
  fieldKey?: "description" | "body";
  itemId?: string;
  /** rejectAll */
  rejected?: number;
  /** acceptAll */
  accepted?: number;
  failed?: number;
  remaining?: number;
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

/**
 * The listed set: view + type filters, in SQL. The bulk actions reuse it so
 * "alle" means exactly the suggestions the merchant is looking at — never the
 * whole table. Filters must not live in the client (see the loader).
 */
function suggestionWhere(shop: string, view: View, fromFilter: FilterType | null, toFilter: FilterType | null) {
  return {
    shop,
    status: VIEW_STATUS[view],
    ...(fromFilter ? { fromResourceType: fromFilter } : {}),
    ...(toFilter ? { toResourceType: toFilter } : {}),
  };
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
  const where = suggestionWhere(shop, view, fromFilter, toFilter);

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

/** A suggestion row as the action handles it (Prisma model, kept loose here). */
type SuggestionRecord = {
  id: string;
  fromResourceType: string;
  fromResourceId: string;
  toResourceType: string;
  toResourceId: string;
  anchorText: string;
};

/**
 * Where the accepted link would go: the source's CURRENT content with the
 * anchor linked. Always read fresh from the DB (not the content captured at
 * suggestion time), so an edit made since the scan is detected as STALE instead
 * of being silently overwritten. Shared by the preview and by "Alle annehmen",
 * which is why it also returns everything the save needs.
 */
async function computeInsertion(
  db: any,
  shop: string,
  suggestion: SuggestionRecord,
): Promise<
  | { ok: true; before: string; after: string; savePath: string; fieldKey: "description" | "body"; itemId: string }
  | { ok: false; code: "UNSUPPORTED" | "STALE" | "SOURCE_MISSING" | "TARGET_MISSING"; error: string }
> {
  const fromRoute = RESOURCE_ROUTE[suggestion.fromResourceType];
  if (!fromRoute) {
    return { ok: false, code: "UNSUPPORTED", error: "Unsupported source resource type" };
  }

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
    return { ok: false, code: "SOURCE_MISSING", error: "Source content not found" };
  }

  let targetHandle: string | null = null;
  if (suggestion.toResourceType === "Product") {
    targetHandle = (await db.product.findFirst({ where: { id: suggestion.toResourceId, shop }, select: { handle: true } }))?.handle ?? null;
  } else if (suggestion.toResourceType === "Collection") {
    targetHandle = (await db.collection.findFirst({ where: { id: suggestion.toResourceId, shop }, select: { handle: true } }))?.handle ?? null;
  }
  if (!targetHandle) {
    return { ok: false, code: "TARGET_MISSING", error: "Target content not found" };
  }

  const href = targetUrlPath({ resourceType: suggestion.toResourceType as "Product" | "Collection", handle: targetHandle });
  const result = insertLinkIntoHtml(currentHtml, suggestion.anchorText, href);
  if (!result.inserted) {
    return { ok: false, code: "STALE", error: "Anchor text not found in current content" };
  }

  return {
    ok: true,
    before: currentHtml,
    after: result.html,
    savePath: fromRoute.path,
    fieldKey: fromRoute.fieldKey,
    itemId: suggestion.fromResourceId,
  };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");
  const shop = session.shop;
  const formData = await request.formData();
  const actionType = getFormString(formData, "actionType");
  const suggestionId = getFormString(formData, "suggestionId");

  // This action is POST-reachable independently of the loader's gate, so it
  // has to check the plan itself — every path below writes to the shop.
  const plan = await loadPlan(db, shop);
  if (!meetsPlan(plan, "pro")) {
    return json({ success: false, error: "This feature requires the Pro plan" }, { status: 403 });
  }

  // ── Bulk actions (no suggestionId — they act on the listed set) ────────────
  if (actionType === "rejectAll" || actionType === "acceptAll") {
    const where = suggestionWhere(
      shop,
      parseView(getFormString(formData, "view")),
      parseTypeFilter(getFormString(formData, "from")),
      parseTypeFilter(getFormString(formData, "to")),
    );

    if (actionType === "rejectAll") {
      // One statement for the whole filtered view — same semantics as rejecting
      // each row by hand (permanent, feeds the next run's do-not-repeat list).
      const { count } = await db.seoInternalLinkSuggestion.updateMany({
        where,
        data: { status: "dismissed", dismissedUntil: null },
      });
      return json({ success: true, rejected: count });
    }

    const batch = await db.seoInternalLinkSuggestion.findMany({
      where,
      orderBy: [{ confidence: "desc" }, { id: "asc" }],
      take: BULK_ACCEPT_LIMIT,
    });
    if (batch.length === 0) {
      return json({ success: true, accepted: 0, failed: 0, remaining: 0 });
    }

    // The save goes through the very same handler the editor routes use — there
    // is no second write path (CLAUDE.md architecture invariant), this just
    // calls it server-side instead of over HTTP.
    const [{ handleUnifiedContentActions }, configs, aiSettings, aiInstructions, shopLocales] = await Promise.all([
      import("../actions/unified-content.actions"),
      import("../config/content-fields.config"),
      db.aISettings.findUnique({ where: { shop } }),
      db.aIInstructions.findUnique({ where: { shop } }),
      getCachedShopLocales(admin, shop).catch(() => []),
    ]);
    const configByType: Record<string, any> = {
      Product: configs.PRODUCTS_CONFIG,
      Collection: configs.COLLECTIONS_CONFIG,
      Article: configs.BLOGS_CONFIG,
      Page: configs.PAGES_CONFIG,
    };
    const primaryLocale = shopLocales.find((l) => l.primary)?.locale ?? "";

    const acceptOne = async (suggestion: SuggestionRecord): Promise<boolean> => {
      try {
        const insertion = await computeInsertion(db, shop, suggestion);
        if (!insertion.ok) return false;

        const contentConfig = configByType[suggestion.fromResourceType];
        if (!contentConfig) return false;

        const saveForm = new FormData();
        saveForm.set("action", "updateContent");
        saveForm.set("itemId", insertion.itemId);
        saveForm.set("locale", primaryLocale);
        saveForm.set("primaryLocale", primaryLocale);
        saveForm.set(insertion.fieldKey, insertion.after);
        saveForm.set("changedFields", JSON.stringify([insertion.fieldKey]));

        const response = await handleUnifiedContentActions({
          admin,
          session,
          formData: saveForm,
          contentConfig,
          db,
          aiSettings,
          aiInstructions,
        });
        const body = (await response.json().catch(() => null)) as { success?: boolean } | null;
        return !!body?.success;
      } catch {
        return false;
      }
    };

    // Suggestions that share a source item run in order (each insertion builds
    // on the content the previous save wrote); different source items run
    // concurrently, bounded so a batch doesn't hammer Shopify's rate limit.
    const queue = groupSuggestionsBySource(batch as SuggestionRecord[]);
    const acceptedIds: string[] = [];
    let failed = 0;

    const worker = async () => {
      for (;;) {
        const group = queue.shift();
        if (!group) return;
        for (const suggestion of group) {
          if (await acceptOne(suggestion)) acceptedIds.push(suggestion.id);
          else failed++;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(BULK_ACCEPT_CONCURRENCY, queue.length) }, () => worker()),
    );

    if (acceptedIds.length > 0) {
      await db.seoInternalLinkSuggestion.updateMany({
        where: { shop, id: { in: acceptedIds } },
        data: { status: "accepted", dismissedUntil: null },
      });
    }

    // Failures stay in the list, so `remaining` includes them — the client only
    // suggests another round when there is more left than just this run's
    // failures (a suggestion whose anchor text is gone never succeeds).
    const remaining = await db.seoInternalLinkSuggestion.count({ where });
    return json({ success: true, accepted: acceptedIds.length, failed, remaining });
  }

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
    const insertion = await computeInsertion(db, shop, suggestion);
    if (!insertion.ok) {
      const status = insertion.code === "STALE" ? 409 : insertion.code === "UNSUPPORTED" ? 400 : 404;
      return json({ success: false, code: insertion.code, error: insertion.error }, { status });
    }

    return json({
      success: true,
      before: insertion.before,
      after: insertion.after,
      savePath: insertion.savePath,
      fieldKey: insertion.fieldKey,
      itemId: insertion.itemId,
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
  // The preview MODAL is the only single-slot flow left on a fetcher — it blocks
  // the UI while it is open, so it can never overlap with itself. Everything the
  // rows do (accept, reject, restore) runs on raw fetch instead, see postSelf.
  const previewFetcher = useFetcher<ActionResult>();

  const [generateStarted, setGenerateStarted] = useState(false);
  const [banner, setBanner] = useState<{ tone: "critical" | "success"; message: string } | null>(null);
  const generateStartedAtRef = useRef(0);

  // Suggestion shown in the before/after modal ("Prüfen"), plus its inline error
  // and the in-flight state of its confirm button.
  const [previewRow, setPreviewRow] = useState<SuggestionRow | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  // Ids of the rows with a request in flight — an array, not a single id,
  // because several rows may be accepting/rejecting at the same time.
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const [bulkRunning, setBulkRunning] = useState<"accept" | "reject" | null>(null);
  const [bulkConfirm, setBulkConfirm] = useState<"accept" | "reject" | null>(null);

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

  // ── Requests ───────────────────────────────────────────────────────────────
  // Row actions use raw fetch rather than useFetcher on purpose: a fetcher has
  // ONE slot, so starting a second accept while the first is running replaces
  // the in-flight request and the first row's spinner never clears. A fetch per
  // click gives every row its own lifecycle, which is what makes accepting
  // several suggestions in parallel work at all.
  const postSelf = async (fields: Record<string, string>): Promise<ActionResult | null> => {
    const formData = new FormData();
    for (const [key, value] of Object.entries(fields)) formData.set(key, value);
    // Post to this very route (the search string carries view/filters/session).
    const resp = await fetch(window.location.pathname + window.location.search, {
      method: "POST",
      body: formData,
    });
    return (await resp.json().catch(() => null)) as ActionResult | null;
  };

  // The save itself goes to the real editor route — the ONE write path.
  const postSave = async (preview: ActionResult): Promise<ActionResult | null> => {
    if (!preview.savePath || !preview.fieldKey || !preview.itemId) return null;
    const formData = new FormData();
    formData.set("action", "updateContent");
    formData.set("itemId", preview.itemId);
    formData.set("locale", data.primaryLocale);
    formData.set("primaryLocale", data.primaryLocale);
    formData.set(preview.fieldKey, preview.after || "");
    formData.set("changedFields", JSON.stringify([preview.fieldKey]));
    const resp = await fetch(preview.savePath, { method: "POST", body: formData });
    return (await resp.json().catch(() => null)) as ActionResult | null;
  };

  const setBusy = (id: string, busy: boolean) =>
    setBusyIds((prev) => (busy ? [...prev, id] : prev.filter((entry) => entry !== id)));

  // With parallel rows the banner has several writers, so a later success must
  // not hide an error the merchant hasn't read yet.
  const reportError = (message: string) => setBanner({ tone: "critical", message });
  const reportSuccess = (message: string) =>
    setBanner((prev) => (prev?.tone === "critical" ? prev : { tone: "success", message }));

  const previewErrorMessage = (result: ActionResult | null) =>
    result?.code === "STALE" ? c.previewStaleError : result?.error || c.previewLoadError;

  const submitRowAction = async (row: SuggestionRow, actionType: "reject" | "restore") => {
    setBusy(row.id, true);
    try {
      const result = await postSelf({ actionType, suggestionId: row.id });
      if (result?.success) reportSuccess(actionType === "reject" ? c.rejectSuccess : c.restoreSuccess);
      else reportError(result?.error || c.actionError);
    } catch {
      reportError(c.actionError);
    } finally {
      setBusy(row.id, false);
      revalidatorRef.current.revalidate();
    }
  };

  /** "Annehmen" in the list: preview + save + markAccepted, no modal. */
  const acceptSuggestion = async (row: SuggestionRow) => {
    setBusy(row.id, true);
    try {
      const preview = await postSelf({ actionType: "previewAccept", suggestionId: row.id });
      if (!preview?.success) {
        reportError(previewErrorMessage(preview));
        return;
      }
      const saved = await postSave(preview);
      if (!saved?.success) {
        reportError(saved?.error || c.acceptSaveError);
        return;
      }
      await postSelf({ actionType: "markAccepted", suggestionId: row.id });
      reportSuccess(c.acceptSuccess);
    } catch {
      reportError(c.acceptSaveError);
    } finally {
      setBusy(row.id, false);
      revalidatorRef.current.revalidate();
    }
  };

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
    if (!previewFetcher.data.success) setPreviewError(previewErrorMessage(previewFetcher.data));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewFetcher.state, previewFetcher.data]);

  /** Confirm button of the preview modal — same two steps as acceptSuggestion,
   *  but it reports failures inside the modal instead of closing it. */
  const confirmAccept = async () => {
    const preview = previewFetcher.data;
    const row = previewRow;
    if (!row || !preview?.success) return;

    setConfirming(true);
    try {
      const saved = await postSave(preview);
      if (!saved?.success) {
        setPreviewError(saved?.error || c.acceptSaveError);
        return;
      }
      await postSelf({ actionType: "markAccepted", suggestionId: row.id });
      reportSuccess(c.acceptSuccess);
      setPreviewRow(null);
    } catch {
      setPreviewError(c.acceptSaveError);
    } finally {
      setConfirming(false);
      revalidatorRef.current.revalidate();
    }
  };

  // Reject straight out of the preview modal — the point of the modal is that
  // the merchant inspects the insertion before deciding, so "no" has to be
  // reachable from there too, not only from the list row behind it.
  const rejectFromPreview = () => {
    const row = previewRow;
    if (!row) return;
    setPreviewRow(null);
    void submitRowAction(row, "reject");
  };

  /** "Alle annehmen" / "Alle ablehnen": ONE request that does the whole listed
   *  set server-side (accept is capped per run — see BULK_ACCEPT_LIMIT). */
  const runBulk = async (kind: "accept" | "reject") => {
    setBulkConfirm(null);
    setBulkRunning(kind);
    setBanner(null);
    try {
      const result = await postSelf({
        actionType: kind === "accept" ? "acceptAll" : "rejectAll",
        view: data.view,
        from: data.fromFilter,
        to: data.toFilter,
      });
      if (!result?.success) {
        reportError(result?.error || c.actionError);
        return;
      }
      if (kind === "reject") {
        setBanner({ tone: "success", message: c.bulkRejectResult.replace("{count}", String(result.rejected ?? 0)) });
        return;
      }
      const accepted = result.accepted ?? 0;
      const failed = result.failed ?? 0;
      const remaining = result.remaining ?? 0;
      let message = c.bulkAcceptResult.replace("{accepted}", String(accepted));
      if (failed > 0) message += c.bulkAcceptFailed.replace("{failed}", String(failed));
      // Only invite another round when there is more left than the failures of
      // this run — a suggestion whose anchor text is gone never succeeds, so
      // "click again" would be an endless loop.
      if (remaining > failed) message += c.bulkAcceptRemaining.replace("{remaining}", String(remaining));
      setBanner({ tone: failed > 0 ? "critical" : "success", message });
    } catch {
      reportError(c.actionError);
    } finally {
      setBulkRunning(null);
      revalidatorRef.current.revalidate();
    }
  };

  const openInEditor = (type: FilterType, id: string) => {
    const path = RESOURCE_ROUTE[type]?.path;
    if (path) handleNavigate(path, { searchParams: new URLSearchParams({ select: id }) });
  };

  const rejectedView = data.view === "rejected";
  const rows = data.rows;
  // Only the row that was clicked locks up — other rows stay clickable so
  // several suggestions can be applied at once. A bulk run locks everything,
  // since it is rewriting the very list underneath.
  //
  // Exception: rows that write into the SAME source item lock each other. Both
  // would compute their insertion from the content as it is now, so the save
  // that lands second would drop the first link (the server-side bulk accept
  // avoids this by grouping — see groupSuggestionsBySource).
  const sourceKey = (row: SuggestionRow) => `${row.fromResourceType}:${row.fromResourceId}`;
  const busySources = new Set(rows.filter((row) => busyIds.includes(row.id)).map(sourceKey));
  const rowBusy = (row: SuggestionRow) =>
    busyIds.includes(row.id) || busySources.has(sourceKey(row)) || bulkRunning !== null;
  const bulkBusy = bulkRunning !== null || busyIds.length > 0 || generating;
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

        {/* Same three roles, same order and same button styles as the modal
            footer (neutral · critical · primary), so the modal reads as a
            zoomed-in version of the row rather than a different set of choices. */}
        <InlineStack gap="200" blockAlign="center">
          <Badge tone={row.confidence >= 0.8 ? "success" : row.confidence >= 0.6 ? "attention" : undefined}>
            {`${Math.round(row.confidence * 100)}%`}
          </Badge>
          <Button size="slim" onClick={() => openPreview(row)} disabled={rowBusy(row)}>
            {c.review}
          </Button>
          {rejectedView ? (
            <Button size="slim" onClick={() => void submitRowAction(row, "restore")} disabled={rowBusy(row)}>
              {c.restore}
            </Button>
          ) : (
            <Button size="slim" tone="critical" onClick={() => void submitRowAction(row, "reject")} disabled={rowBusy(row)}>
              {c.reject}
            </Button>
          )}
          <Button
            size="slim"
            variant="primary"
            onClick={() => void acceptSuggestion(row)}
            disabled={rowBusy(row)}
            loading={busyIds.includes(row.id)}
          >
            {c.accept}
          </Button>
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

          {/* Filters and the bulk actions share one row: both act on exactly
              the same set — everything the filters currently select, across all
              pages, not just the page on screen. Hence the {count} in the
              labels, which is the filtered total. */}
          <InlineStack gap="300" align="space-between" blockAlign="end" wrap>
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

            {!rejectedView && (
              <InlineStack gap="200" blockAlign="center">
                <Button
                  tone="critical"
                  onClick={() => setBulkConfirm("reject")}
                  disabled={bulkBusy || data.total === 0}
                  loading={bulkRunning === "reject"}
                >
                  {c.bulkReject.replace("{count}", String(data.total))}
                </Button>
                <Button
                  variant="primary"
                  onClick={() => setBulkConfirm("accept")}
                  disabled={bulkBusy || data.total === 0}
                  loading={bulkRunning === "accept"}
                >
                  {c.bulkAccept.replace("{count}", String(data.total))}
                </Button>
              </InlineStack>
            )}
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

  // Polaris renders a `destructive: true` modal action as a FILLED red button,
  // while the list's reject button is the outlined `tone="critical"` one. That
  // outlined look is the one we keep in both places, so pass `tone` straight
  // through: buttonFrom() spreads any extra prop onto the underlying Button,
  // ComplexAction just doesn't type it (hence the assertion).
  const rejectAction = {
    content: c.reject,
    tone: "critical",
    disabled: confirming,
    onAction: rejectFromPreview,
  } as ComplexAction;

  const modal = (
    <Modal
      open={!!previewRow}
      onClose={() => setPreviewRow(null)}
      title={c.previewModalTitle}
      primaryAction={{
        content: c.previewConfirm,
        disabled: previewLoading || !previewData?.success,
        loading: confirming,
        onAction: () => void confirmAccept(),
      }}
      // Order mirrors the list row: neutral, reject, confirm.
      secondaryActions={[
        { content: c.previewCancel, onAction: () => setPreviewRow(null) },
        // Already-rejected rows only get "close" here — the row itself offers
        // "restore", which is the meaningful action in that view.
        ...(rejectedView ? [] : [rejectAction]),
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

  // Both bulk actions rewrite the merchant's live content (or throw suggestions
  // away permanently), so neither fires straight off the button.
  const bulkModal = (
    <Modal
      open={bulkConfirm !== null}
      onClose={() => setBulkConfirm(null)}
      title={bulkConfirm === "accept" ? c.bulkAcceptConfirmTitle : c.bulkRejectConfirmTitle}
      primaryAction={{
        content: bulkConfirm === "accept" ? c.accept : c.reject,
        ...(bulkConfirm === "reject" ? { tone: "critical" } : {}),
        onAction: () => void runBulk(bulkConfirm === "accept" ? "accept" : "reject"),
      } as ComplexAction}
      secondaryActions={[{ content: c.previewCancel, onAction: () => setBulkConfirm(null) }]}
    >
      <Modal.Section>
        <Text as="p" variant="bodyMd">
          {(bulkConfirm === "accept" ? c.bulkAcceptConfirmBody : c.bulkRejectConfirmBody)
            .replace("{count}", String(data.total))
            .replace("{limit}", String(BULK_ACCEPT_LIMIT))}
        </Text>
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
      {bulkModal}
    </SeoSectionLayout>
  );
}
