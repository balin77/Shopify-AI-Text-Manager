/**
 * Bulk editor — "translate missing" page (successor of the one-column
 * TranslateMissingModal).
 *
 * Own route (not a modal): the candidate list is paginated, expandable and
 * carries its own toolbar, which does not fit a dialog inside the Shopify
 * iframe. `app.bulk_.translate` — the trailing "_" opts OUT of nesting under
 * app.bulk (which has no <Outlet/>) while keeping the URL /app/bulk/translate.
 *
 * What it does:
 * - lists every item of the CURRENT grid filter that lacks at least one
 *   translation, with one checkbox per item and one per missing field
 *   (scanMissingTranslations — the same scan the task re-runs before writing);
 * - lets the merchant switch target languages on/off (LocaleToggleBar);
 * - starts the detached `bulkEditorTranslate` task, which fills ONLY the
 *   missing values and writes them through applyBulkDiff — the one verified
 *   write path (echo check, digest rule, DB mirror).
 *
 * Deliberately NOT here:
 * - no preview mode. The old modal merged suggestions into the grid's edit map;
 *   from a separate route that map no longer exists, and reviewing suggestions
 *   for several languages at once was never possible anyway (the grid shows one
 *   locale at a time). Only empty cells are filled, so nothing is overwritten —
 *   the result is reviewed (and editable) in the grid afterwards.
 * - no market dimension. Translations are written GLOBALLY (marketId ""); a
 *   market override stays a per-cell decision in the grid.
 */

import { data as json, type LoaderFunctionArgs } from "react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLoaderData, useFetcher, useRevalidator } from "react-router";
import { Badge, Banner, BlockStack, Box, Button, Card, InlineStack, Text } from "@shopify/polaris";
import { ArrowLeftIcon } from "@shopify/polaris-icons";
import type { PrismaClient } from "@prisma/client";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { PlanAccessGate } from "../components/PlanAccessGate";
import { meetsPlan } from "../utils/planUtils";
import { type Plan } from "../config/plans";
import { getLocalizedLanguageName } from "../utils/contentEditor.utils";
import { bulkColumnHeading } from "../services/bulk-editor/labels.shared";
import {
  BULK_FILTER_IDS,
  BULK_ROW_TYPE_TO_CONTENT_TYPE,
  type BulkFilterId,
  type BulkRowType,
  type ColumnDescriptor,
} from "../services/bulk-editor/columns.shared";
import {
  MAX_TRANSLATE_UNITS,
  TRANSLATE_MISSING_PAGE_SIZE,
  allSelectionState,
  countSelectedUnits,
  deselectAllPairs,
  initialTranslateSelection,
  selectAllPairs,
  serializeTranslateSelection,
  setItemSelected,
  setPairSelected,
  translatePairKey,
  TRANSLATE_DEFAULT_OFF_COLUMN_IDS,
  type MissingItem,
  type TranslateSelection,
} from "../services/bulk-editor/translate-missing.shared";
// Server-only I/O — referenced exclusively from the loader, which React Router
// strips from the client build.
import {
  allowedRowTypesForPlan,
  buildServerColumnsByType,
} from "../services/bulk-editor/columns.server";
import {
  scanMissingTranslations,
  translateCandidateColumns,
} from "../services/bulk-editor/missing-translations.server";
import { LocaleToggleBar } from "../components/bulk-editor/LocaleToggleBar";
import { MissingTranslationList } from "../components/bulk-editor/MissingTranslationList";

interface TranslateLoaderData {
  gated: boolean;
  type: BulkRowType;
  search: string;
  filters: BulkFilterId[];
  moType: string;
  /** Published FOREIGN locales — the possible targets. */
  foreignLocales: { locale: string; name: string }[];
  /** Target languages currently switched on (URL param `langs`). */
  activeLocales: string[];
  /** Candidate columns of this type — descriptors, so the page can label them
   * exactly like the grid does. */
  columns: ColumnDescriptor[];
  /** Page slice of the candidate list. */
  items: MissingItem[];
  page: number;
  totalItems: number;
  /** columnId → locale → missing units across the WHOLE scan window. */
  unitsByColumnLocale: Record<string, Record<string, number>>;
  scanTruncated: boolean;
  matchedRows: number;
  scannedRows: number;
  /** A bulkEditorTranslate task already running for this shop (single-flight). */
  runningTaskId: string | null;
}

async function loadPlan(db: PrismaClient, shop: string): Promise<Plan> {
  const settings = await db.aISettings.findUnique({
    where: { shop },
    select: { subscriptionPlan: true },
  });
  return (settings?.subscriptionPlan || "free") as Plan;
}

const EMPTY_DATA: Omit<TranslateLoaderData, "gated"> = {
  type: "product",
  search: "",
  filters: [],
  moType: "",
  foreignLocales: [],
  activeLocales: [],
  columns: [],
  items: [],
  page: 1,
  totalItems: 0,
  unitsByColumnLocale: {},
  scanTruncated: false,
  matchedRows: 0,
  scannedRows: 0,
  runningTaskId: null,
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");
  const shop = session.shop;

  const plan = await loadPlan(db, shop);
  // Pro gate (Plan §10.7) — the same tier the task itself enforces; this only
  // drives the UI, /api/ai checks again.
  if (!meetsPlan(plan, "pro")) {
    return json<TranslateLoaderData>({ gated: true, ...EMPTY_DATA });
  }

  const url = new URL(request.url);
  const allowedTypes = allowedRowTypesForPlan(plan);
  const rawType = url.searchParams.get("type") || "product";
  const type: BulkRowType = (allowedTypes as string[]).includes(rawType)
    ? (rawType as BulkRowType)
    : allowedTypes[0] ?? "product";
  const search = url.searchParams.get("q") || "";
  const filters = (url.searchParams.get("f") || "")
    .split(",")
    .filter((f): f is BulkFilterId => (BULK_FILTER_IDS as string[]).includes(f));
  const page = Math.max(1, parseInt(url.searchParams.get("tp") || "1", 10) || 1);

  const { getCachedShopLocales } = await import("../utils/shop-locales-cache.server");
  // NEVER gate on a failed lookup: getCachedShopLocales resolves with [] on
  // non-401 errors (CLAUDE.md), which is "lookup failed", not "one language".
  const shopLocales = await getCachedShopLocales(admin, shop).catch(() => []);
  const foreign = shopLocales
    .filter((l) => l.published && !l.primary)
    .map((l) => ({ locale: l.locale, name: l.name || l.locale }));

  // Metaobject rows are only schema-homogeneous per definition type (Plan §7) —
  // the grid always carries a concrete moType, the page inherits it.
  let moType = "";
  if (type === "metaobject") {
    const definitions = await db.metaobjectDefinition.findMany({
      where: { shop },
      select: { type: true },
      orderBy: { type: "asc" },
    });
    const rawMoType = url.searchParams.get("moType") || "";
    moType = definitions.some((d) => d.type === rawMoType) ? rawMoType : definitions[0]?.type ?? "";
  }

  const columnsByType = await buildServerColumnsByType(db, shop, plan);
  const columns = translateCandidateColumns(columnsByType[type], type, moType);

  // Target languages: URL param, validated against the published foreign
  // locales; absent/empty ⇒ all of them.
  const rawLangs = (url.searchParams.get("langs") ?? "").split(",").filter(Boolean);
  const activeLocales = url.searchParams.has("langs")
    ? rawLangs.filter((l) => foreign.some((f) => f.locale === l))
    : foreign.map((f) => f.locale);

  const runningTask = await db.task.findFirst({
    where: { shop, type: "bulkEditorTranslate", status: { in: ["pending", "running"] } },
    select: { id: true },
  });

  const base: TranslateLoaderData = {
    ...EMPTY_DATA,
    gated: false,
    type,
    search,
    filters,
    moType,
    foreignLocales: foreign,
    activeLocales,
    columns,
    page,
    runningTaskId: runningTask?.id ?? null,
  };
  if (foreign.length === 0 || columns.length === 0 || activeLocales.length === 0) {
    return json<TranslateLoaderData>(base);
  }

  const scan = await scanMissingTranslations(db, shop, {
    type,
    search,
    filters,
    moType,
    foreignLocales: foreign.map((f) => f.locale),
    columns,
    admin,
  });

  // Items whose missing languages are ALL switched off are not part of this
  // run — they drop out of the list (and out of the paging), while every
  // item's `locales` stays complete so the client's exception bookkeeping
  // survives a language toggle.
  const visible = scan.items.filter((item) =>
    item.columns.some((c) => c.locales.some((l) => activeLocales.includes(l))),
  );
  const from = (page - 1) * TRANSLATE_MISSING_PAGE_SIZE;

  return json<TranslateLoaderData>({
    ...base,
    items: visible.slice(from, from + TRANSLATE_MISSING_PAGE_SIZE),
    totalItems: visible.length,
    unitsByColumnLocale: scan.unitsByColumnLocale,
    scanTruncated: scan.scanTruncated,
    matchedRows: scan.matchedRows,
    scannedRows: scan.scannedRows,
  });
};

interface TranslateFetcherResult {
  success: boolean;
  error?: string;
  code?: string;
  taskId?: string;
  /** Units the run will actually process. */
  total?: number;
  /** Units that did not fit into MAX_TRANSLATE_UNITS. */
  skippedOverCap?: number;
  none?: boolean;
}

interface TranslateTaskResult {
  /** Counted in UNITS (row × field × language), like the page's own summary. */
  saved?: number;
  failed?: number;
  /** Handles whose translation equalled the primary handle (or normalized to
   * nothing) — skipped on purpose, not failures. */
  skippedHandles?: number;
}

type ResultBanner =
  | { kind: "running" }
  | { kind: "done"; saved: number; failed: number; skippedHandles: number; overCap: number }
  | { kind: "none" }
  | { kind: "failed"; message?: string };

export default function BulkTranslateMissingPage() {
  const data = useLoaderData<typeof loader>() as TranslateLoaderData;
  const { t, locale: appLocale } = useI18n();
  const b = t.bulkEditor;
  const tm = b.translateMissing;
  const { handleNavigate } = useAppNavigation();
  const revalidator = useRevalidator();
  const startFetcher = useFetcher<TranslateFetcherResult>();

  const columnIds = useMemo(() => data.columns.map((c) => c.id), [data.columns]);
  const [selection, setSelection] = useState<TranslateSelection>(() =>
    initialTranslateSelection(data.columns.map((c) => c.id)),
  );
  // A run started in an earlier visit (or in another tab) is picked up on
  // mount — single-flight is per shop, so this is THE run, and the page must
  // show its state instead of an idle-looking start button.
  const [banner, setBanner] = useState<ResultBanner | null>(
    data.runningTaskId ? { kind: "running" } : null,
  );
  const [taskId, setTaskId] = useState<string | null>(data.runningTaskId);
  /** pairKey → the pair's FULL missing-locale list, accumulated across pages.
   * countSelectedUnits needs it for pairs the merchant deselected on a page
   * they have since left. */
  const missingLocalesByPair = useRef<Map<string, string[]>>(new Map());
  /** Units of the run just started — the cap notice needs them after the fact. */
  const startedOverCap = useRef(0);

  useEffect(() => {
    for (const item of data.items) {
      for (const column of item.columns) {
        missingLocalesByPair.current.set(translatePairKey(item.rowId, column.columnId), column.locales);
      }
    }
  }, [data.items]);

  const columnById = useMemo(() => {
    const map = new Map<string, ColumnDescriptor>();
    for (const column of data.columns) map.set(column.id, column);
    return map;
  }, [data.columns]);

  const columnLabel = (columnId: string) => {
    const column = columnById.get(columnId);
    return column ? bulkColumnHeading(column, b) : columnId;
  };
  const localeLabel = (locale: string) => {
    const match = data.foreignLocales.find((l) => l.locale === locale);
    return getLocalizedLanguageName(locale, appLocale, match?.name);
  };

  const selectedUnits = useMemo(
    () =>
      countSelectedUnits(
        selection,
        data.unitsByColumnLocale,
        data.activeLocales,
        missingLocalesByPair.current,
      ),
    // missingLocalesByPair is a ref filled in the effect above; `data.items`
    // changing is what can change its contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selection, data.unitsByColumnLocale, data.activeLocales, data.items],
  );

  const busy = startFetcher.state !== "idle" || taskId !== null;
  const canStart = selectedUnits > 0 && data.activeLocales.length > 0 && !busy;

  /** Every other view param (type, q, f, moType, the Shopify session params)
   * is preserved by handleNavigate — only what changes is passed here. */
  const navigateWith = (params: Record<string, string>) => {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) searchParams.set(key, value);
    handleNavigate("/app/bulk/translate", { searchParams, replace: true });
  };

  // ── Language toggles live in the URL: the server filters the candidate list
  // by them, so a toggle is a (replacing) navigation, not local state. An
  // emptied list is a legitimate state ("nothing selected"), never a silent
  // fallback to "all" — that would translate languages the merchant switched off.
  const toggleLocale = (locale: string) => {
    const next = data.activeLocales.includes(locale)
      ? data.activeLocales.filter((l) => l !== locale)
      : [...data.activeLocales, locale];
    navigateWith({ langs: next.join(","), tp: "1" });
  };

  const goToPage = (page: number) => navigateWith({ tp: String(page) });

  const handleStart = () => {
    setBanner(null);
    startFetcher.submit(
      {
        action: "bulkEditorTranslate",
        contentType: BULK_ROW_TYPE_TO_CONTENT_TYPE[data.type],
        rowType: data.type,
        moType: data.moType,
        locales: data.activeLocales.join(","),
        search: data.search,
        filters: data.filters.join(","),
        selection: JSON.stringify(serializeTranslateSelection(selection)),
      },
      { method: "post", action: "/api/ai" },
    );
  };

  useEffect(() => {
    if (startFetcher.state !== "idle" || !startFetcher.data) return;
    const result = startFetcher.data;
    if (result.success && result.none) {
      setBanner({ kind: "none" });
    } else if (result.success && result.taskId) {
      startedOverCap.current = result.skippedOverCap ?? 0;
      setBanner({ kind: "running" });
      setTaskId(result.taskId);
    } else if (!result.success) {
      setBanner({ kind: "failed", message: result.error });
      if (result.code === "ALREADY_RUNNING" && result.taskId) setTaskId(result.taskId);
    }
    // Only react when the fetcher settles with new data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startFetcher.state, startFetcher.data]);

  // Poll the detached task (same /api/task-result pattern as the editors).
  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/task-result?taskId=${encodeURIComponent(taskId)}`, {
          headers: { Accept: "application/json" },
        });
        if (!res.ok || cancelled) return;
        const payload = (await res.json()) as {
          task?: { status: string; result?: string | null; error?: string | null };
        };
        const task = payload.task;
        if (!task || (task.status !== "completed" && task.status !== "failed") || cancelled) return;

        setTaskId(null);
        if (task.status === "failed" && !task.result) {
          setBanner({ kind: "failed", message: task.error ?? undefined });
          return;
        }
        let parsed: TranslateTaskResult | null = null;
        try {
          parsed = task.result ? (JSON.parse(task.result) as TranslateTaskResult) : null;
        } catch {
          parsed = null;
        }
        setBanner({
          kind: "done",
          saved: parsed?.saved ?? 0,
          failed: parsed?.failed ?? 0,
          skippedHandles: parsed?.skippedHandles ?? 0,
          overCap: startedOverCap.current,
        });
        // The translated rows are no longer candidates — reload the list and
        // start from a clean selection.
        setSelection(initialTranslateSelection(columnIds));
        missingLocalesByPair.current = new Map();
        revalidator.revalidate();
      } catch {
        // transient — the next tick retries
      }
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  const from = data.totalItems === 0 ? 0 : (data.page - 1) * TRANSLATE_MISSING_PAGE_SIZE + 1;
  const to = Math.min(data.page * TRANSLATE_MISSING_PAGE_SIZE, data.totalItems);
  const hasPrev = data.page > 1;
  const hasNext = to < data.totalItems;

  const overCapNow = Math.max(0, selectedUnits - MAX_TRANSLATE_UNITS);

  return (
    <div style={{ padding: "1rem", maxWidth: "1200px", margin: "0 auto", width: "100%", boxSizing: "border-box" }}>
      <PlanAccessGate minPlan="pro">
        {data.gated ? null : (
          <BlockStack gap="400">
            <InlineStack gap="200" blockAlign="center">
              <Button icon={ArrowLeftIcon} onClick={() => handleNavigate("/app/bulk")}>
                {tm.back}
              </Button>
              <Text as="h2" variant="headingLg">
                {tm.title}
              </Text>
              <Badge>{b.types[data.type]}</Badge>
            </InlineStack>
            <Text as="p" variant="bodyMd" tone="subdued">
              {tm.intro}
            </Text>

            {banner?.kind === "running" && <Banner tone="info">{tm.running}</Banner>}
            {banner?.kind === "none" && <Banner tone="info">{tm.noneMissing}</Banner>}
            {banner?.kind === "failed" && (
              <Banner tone="critical">{banner.message || tm.failed}</Banner>
            )}
            {banner?.kind === "done" && (
              <Banner tone={banner.failed > 0 ? "warning" : "success"}>
                <BlockStack gap="100">
                  <Text as="p">
                    {tm.savedResult
                      .replace("{saved}", String(banner.saved))
                      .replace("{failed}", String(banner.failed))}
                  </Text>
                  {banner.skippedHandles > 0 && (
                    <Text as="p">{tm.skippedHandles.replace("{count}", String(banner.skippedHandles))}</Text>
                  )}
                  {banner.overCap > 0 && (
                    <Text as="p">
                      {tm.runTruncated
                        .replace("{max}", String(MAX_TRANSLATE_UNITS))
                        .replace("{rest}", String(banner.overCap))}
                    </Text>
                  )}
                </BlockStack>
              </Banner>
            )}
            {data.scanTruncated && (
              <Banner tone="warning">
                {tm.scanTruncated
                  .replace("{scanned}", String(data.scannedRows))
                  .replace("{total}", String(data.matchedRows))}
              </Banner>
            )}

            <Card>
              <BlockStack gap="400">
                <LocaleToggleBar
                  locales={data.foreignLocales}
                  active={data.activeLocales}
                  onToggle={toggleLocale}
                  disabled={busy}
                  appLocale={appLocale}
                  strings={{
                    label: tm.languagesLabel,
                    activeHint: tm.languageActiveHint,
                    inactiveHint: tm.languageInactiveHint,
                    singleTarget: tm.singleTarget,
                  }}
                />
                <Text as="p" variant="bodySm" tone="subdued">
                  {tm.globalHint}
                </Text>

                {data.foreignLocales.length === 0 ? (
                  <Text as="p" tone="subdued">
                    {t.common.requiresSecondLanguage}
                  </Text>
                ) : data.activeLocales.length === 0 ? (
                  <Text as="p" tone="subdued">
                    {tm.noLanguages}
                  </Text>
                ) : data.totalItems === 0 ? (
                  <Text as="p" tone="subdued">
                    {tm.empty}
                  </Text>
                ) : (
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="span" variant="bodySm" tone="subdued">
                        {tm.pageInfo
                          .replace("{from}", String(from))
                          .replace("{to}", String(to))
                          .replace("{total}", String(data.totalItems))}
                      </Text>
                      <InlineStack gap="200">
                        <Button disabled={!hasPrev} onClick={() => goToPage(data.page - 1)}>
                          {b.prevPage}
                        </Button>
                        <Button disabled={!hasNext} onClick={() => goToPage(data.page + 1)}>
                          {b.nextPage}
                        </Button>
                      </InlineStack>
                    </InlineStack>

                    <MissingTranslationList
                      items={data.items}
                      activeLocales={data.activeLocales}
                      selection={selection}
                      headerState={allSelectionState(selection)}
                      onToggleAll={(checked) =>
                        setSelection(checked ? selectAllPairs() : deselectAllPairs())
                      }
                      onToggleItem={(item, checked) =>
                        setSelection((prev) => setItemSelected(prev, item, checked))
                      }
                      onTogglePair={(rowId, columnId, checked) =>
                        setSelection((prev) => setPairSelected(prev, rowId, columnId, checked))
                      }
                      columnLabel={columnLabel}
                      localeLabel={localeLabel}
                      warnColumnIds={TRANSLATE_DEFAULT_OFF_COLUMN_IDS}
                      strings={{
                        selectAll: tm.selectAll,
                        itemSummary: tm.itemSummary,
                        warnHandle: tm.warnHandle,
                        expand: tm.expand,
                        collapse: tm.collapse,
                      }}
                    />

                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="span" variant="bodySm" tone="subdued">
                        {tm.pageInfo
                          .replace("{from}", String(from))
                          .replace("{to}", String(to))
                          .replace("{total}", String(data.totalItems))}
                      </Text>
                      <InlineStack gap="200">
                        <Button disabled={!hasPrev} onClick={() => goToPage(data.page - 1)}>
                          {b.prevPage}
                        </Button>
                        <Button disabled={!hasNext} onClick={() => goToPage(data.page + 1)}>
                          {b.nextPage}
                        </Button>
                      </InlineStack>
                    </InlineStack>
                  </BlockStack>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="p" variant="bodyMd">
                  {tm.summary.replace("{units}", String(selectedUnits))}
                </Text>
                {overCapNow > 0 && (
                  <Text as="p" variant="bodySm" tone="caution">
                    {tm.capNotice
                      .replace("{max}", String(MAX_TRANSLATE_UNITS))
                      .replace("{rest}", String(overCapNow))}
                  </Text>
                )}
                <Text as="p" variant="bodySm" tone="subdued">
                  {tm.startHint}
                </Text>
                <Box>
                  <Button variant="primary" disabled={!canStart} loading={busy} onClick={handleStart}>
                    {tm.start}
                  </Button>
                </Box>
              </BlockStack>
            </Card>
          </BlockStack>
        )}
      </PlanAccessGate>
    </div>
  );
}
