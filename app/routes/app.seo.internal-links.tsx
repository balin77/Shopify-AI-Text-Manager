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
 * Accepting is a two-step flow and the merchant picks how much of it to see:
 * "Prüfen" runs only step 1 and shows the before/after modal (confirm or reject
 * from there), "Annehmen" runs both in one go.
 *   1. `previewAccept` computes the cheerio-based insertion against the CURRENT
 *      DB content and returns before/after HTML — nothing is written yet.
 *   2. `accept` recomputes it and saves through `handleUnifiedContentActions`,
 *      the same entry point the editor routes use (CLAUDE.md invariant: one
 *      write path), then marks the suggestion accepted.
 *
 * Both live in the /api/seo-internal-links RESOURCE route, not in this file:
 * the page fires them with raw fetch so several rows can run at once, and with
 * `v3_singleFetch` a raw POST to a page route comes back as an HTML document
 * whose JSON body cannot be read. See that route's header.
 *
 * "Alle annehmen" / "Alle ablehnen" do the same to the whole listed set
 * (filters included, all pages) in ONE request — see the same file.
 *
 * "Übersetzungen mitführen" (on by default, hidden on single-language shops)
 * rides along on every accept. Without it an accept is an ordinary primary
 * save, and a primary save purges the foreign translations of the field it
 * touched — which for a link insertion means losing translations for text that
 * did not change. With it the purge is skipped and the same link is written
 * into each existing translation, pointing at the localized URL. See
 * internal-links-translate.server.ts.
 */

import { data as json, type LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useRevalidator } from "react-router";
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
  Checkbox,
  type ComplexAction,
} from "@shopify/polaris";
import { ChevronLeftIcon, ChevronRightIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { SeoSectionLayout } from "../components/seo/SeoSectionLayout";
import { SeoHelpBanner } from "../components/seo/SeoHelpBanner";
import { meetsPlan } from "../utils/planUtils";
import type { Plan } from "../config/plans";
import { getCachedShopLocales } from "../utils/shop-locales-cache.server";
import { RESOURCE_ROUTE, INTERNAL_LINKS_API, BULK_ACCEPT_LIMIT } from "../services/seo/internal-links-routes";
import {
  FILTER_TYPES,
  parseView,
  parseTypeFilter,
  suggestionWhere,
  type FilterType,
  type View,
} from "../services/seo/internal-links-query";

/** Suggestions per page (both views). Server-side — see the header note. */
export const PAGE_SIZE = 20;

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

/** What /api/seo-internal-links answers, across all of its actionTypes. */
interface ActionResult {
  success: boolean;
  error?: string;
  /** "STALE" — the anchor text is gone from the current content. */
  code?: string;
  /** previewAccept */
  before?: string;
  after?: string;
  /** rejectAll */
  rejected?: number;
  /** acceptAll */
  accepted?: number;
  failed?: number;
  remaining?: number;
  /** accept + acceptAll, when "Übersetzungen mitführen" is on: how many foreign
   *  translations got the link, and how many kept their text without one. */
  translationsLinked?: number;
  translationsUnlinked?: number;
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

async function loadPlan(db: any, shop: string): Promise<{ plan: Plan; carryTranslations: boolean }> {
  const settings = await db.aISettings.findUnique({
    where: { shop },
    select: { subscriptionPlan: true, seoLinksCarryTranslations: true },
  });
  return {
    plan: (settings?.subscriptionPlan || "free") as Plan,
    // A shop that has never touched the switch has no row (or a NULL from an
    // older client) — both mean "on", the default the feature ships with.
    carryTranslations: settings?.seoLinksCarryTranslations ?? true,
  };
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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");
  const shop = session.shop;

  const { plan, carryTranslations } = await loadPlan(db, shop);
  if (!meetsPlan(plan, "pro")) {
    return json({
      gated: true,
      running: false,
      lastRun: null as string | null,
      primaryLocale: "",
      hasForeignLocales: false,
      carryTranslations,
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
  // Drives the "carry translations" toggle: on a single-language shop there is
  // nothing to carry, so the option is not shown at all.
  const hasForeignLocales = shopLocales.some((l) => l.published && !l.primary);

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
    hasForeignLocales,
    carryTranslations,
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
  // rows do (accept, reject, restore) runs on raw fetch instead, see `post`.
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

  // Persisted per shop (AISettings.seoLinksCarryTranslations), defaulting to on:
  // losing hand-written translations to a formatting-level edit is the
  // surprising outcome, so it is the one the merchant has to opt INTO. Seeded
  // from the loader and NOT re-synced from it afterwards — the local value is
  // what the merchant just clicked, and a revalidation mid-toggle must not
  // flip the box back under their cursor.
  const [carryTranslations, setCarryTranslations] = useState(data.carryTranslations);
  const carryActive = data.hasForeignLocales && carryTranslations;

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
  // Raw fetch rather than useFetcher on purpose: a fetcher has ONE slot, so
  // starting a second accept while the first is running replaces the in-flight
  // request and the first row's spinner never clears. A fetch per click gives
  // every row its own lifecycle, which is what makes accepting several
  // suggestions in parallel work at all.
  //
  // It goes to the /api resource route, NOT to this page's own action: with
  // `v3_singleFetch` a raw POST to a page route is a document request, so the
  // response would be HTML and its JSON unreadable.
  const post = async (fields: Record<string, string>): Promise<ActionResult | null> => {
    const formData = new FormData();
    for (const [key, value] of Object.entries(fields)) formData.set(key, value);
    const resp = await fetch(INTERNAL_LINKS_API, { method: "POST", body: formData });
    return (await resp.json().catch(() => null)) as ActionResult | null;
  };

  const setBusy = (id: string, busy: boolean) =>
    setBusyIds((prev) => (busy ? [...prev, id] : prev.filter((entry) => entry !== id)));

  // With parallel rows the banner has several writers, so a later success must
  // not hide an error the merchant hasn't read yet.
  const reportError = (message: string) => setBanner({ tone: "critical", message });
  const reportSuccess = (message: string) =>
    setBanner((prev) => (prev?.tone === "critical" ? prev : { tone: "success", message }));

  // A vanished anchor is the one failure with a real explanation for the
  // merchant ("regenerate"), so it keeps its own message in both flows.
  const previewErrorMessage = (result: ActionResult | null) =>
    result?.code === "STALE" ? c.previewStaleError : result?.error || c.previewLoadError;
  const acceptErrorMessage = (result: ActionResult | null) =>
    result?.code === "STALE" ? c.previewStaleError : result?.error || c.acceptSaveError;

  /** "Link gespeichert." plus, when the carry step ran, what happened to the
   *  translations — the whole point of the toggle is that the merchant can see
   *  they are still there. */
  const acceptSuccessMessage = (result: ActionResult | null) => {
    let message = c.acceptSuccess;
    const linked = result?.translationsLinked ?? 0;
    const unlinked = result?.translationsUnlinked ?? 0;
    if (linked > 0) message += c.acceptTranslationsLinked.replace("{count}", String(linked));
    if (unlinked > 0) message += c.acceptTranslationsKept.replace("{count}", String(unlinked));
    return message;
  };

  /** Every accept carries the toggle. Sent as an explicit flag rather than
   *  relying on a server default, so the endpoint's behaviour always matches
   *  what the checkbox on screen says — the stored preference only decides how
   *  the box comes up, never what an in-flight accept does. */
  const acceptFields = () => ({ carryTranslations: carryActive ? "1" : "0" });

  /**
   * Flip the box now, store the preference in the background. The checkbox is
   * not a form field of the accepts (those send their own flag), so the write
   * is allowed to lag; only a REJECTED write matters, and then the box goes
   * back so it never shows a setting the shop does not actually have.
   */
  const changeCarryTranslations = async (checked: boolean) => {
    setCarryTranslations(checked);
    try {
      const result = await post({
        actionType: "setCarryTranslations",
        carryTranslations: checked ? "1" : "0",
      });
      if (result?.success) return;
      setCarryTranslations(!checked);
      reportError(result?.error || c.actionError);
    } catch {
      setCarryTranslations(!checked);
      reportError(c.actionError);
    }
  };

  const submitRowAction = async (row: SuggestionRow, actionType: "reject" | "restore") => {
    setBusy(row.id, true);
    try {
      const result = await post({ actionType, suggestionId: row.id });
      if (result?.success) reportSuccess(actionType === "reject" ? c.rejectSuccess : c.restoreSuccess);
      else reportError(result?.error || c.actionError);
    } catch {
      reportError(c.actionError);
    } finally {
      setBusy(row.id, false);
      revalidatorRef.current.revalidate();
    }
  };

  /** "Annehmen" in the list — one request; the endpoint inserts, saves and
   *  marks the suggestion accepted (see api.seo-internal-links). */
  const acceptSuggestion = async (row: SuggestionRow) => {
    setBusy(row.id, true);
    try {
      const result = await post({ actionType: "accept", suggestionId: row.id, ...acceptFields() });
      if (result?.success) reportSuccess(acceptSuccessMessage(result));
      else reportError(acceptErrorMessage(result));
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
    previewFetcher.submit(formData, { method: "post", action: INTERNAL_LINKS_API });
  };

  useEffect(() => {
    if (previewFetcher.state !== "idle" || !previewFetcher.data) return;
    if (!previewFetcher.data.success) setPreviewError(previewErrorMessage(previewFetcher.data));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewFetcher.state, previewFetcher.data]);

  /** Confirm button of the preview modal — the same `accept` call the list's
   *  button makes, but failures are reported inside the modal (which stays
   *  open) instead of in the page banner. */
  const confirmAccept = async () => {
    const row = previewRow;
    if (!row || !previewFetcher.data?.success) return;

    setConfirming(true);
    try {
      const result = await post({ actionType: "accept", suggestionId: row.id, ...acceptFields() });
      if (!result?.success) {
        setPreviewError(acceptErrorMessage(result));
        return;
      }
      reportSuccess(acceptSuccessMessage(result));
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
      const result = await post({
        actionType: kind === "accept" ? "acceptAll" : "rejectAll",
        view: data.view,
        from: data.fromFilter,
        to: data.toFilter,
        ...(kind === "accept" ? acceptFields() : {}),
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
      const linked = result.translationsLinked ?? 0;
      const unlinked = result.translationsUnlinked ?? 0;
      if (linked > 0) message += c.acceptTranslationsLinked.replace("{count}", String(linked));
      if (unlinked > 0) message += c.acceptTranslationsKept.replace("{count}", String(unlinked));
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
      <SeoHelpBanner title={c.introTitle}>
        <Text as="p" variant="bodyMd">{c.introBody}</Text>
      </SeoHelpBanner>

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

          {/* Applies to every accept below — single row, preview modal and
              "Alle annehmen" alike, which is why it sits with the operations
              and not inside a row. */}
          {data.hasForeignLocales && (
            <Checkbox
              label={c.carryTranslationsLabel}
              helpText={c.carryTranslationsHelp}
              checked={carryTranslations}
              onChange={changeCarryTranslations}
              disabled={bulkBusy}
            />
          )}

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
