/**
 * On-page & indexability section (PLAN_SEO_CRAWL_EXPANSION §3) — Pro+.
 *
 * The SECOND view of the one crawl. `/app/seo/crawl` answers "is my shop being
 * delivered" (reachable, fast, not broken); this tab answers "is what gets
 * delivered any good, and may Google index it". Same `seoCrawl` task, same
 * latest `SeoCrawlSnapshot`, same header component — there is never a second
 * crawl (§0.2).
 *
 * Head-drift and duplicate titles moved here from the crawl tab (§3.8): they
 * are on-page quality, they were in the wrong place, and moving them takes two
 * DB round-trips plus an Admin API call OFF the crawl loader.
 *
 * Plan gate is `pro`, identical to the crawl's, and that is load-bearing: a
 * Free shop can never have a snapshot, so an ungated tab would be permanently
 * empty rather than merely locked.
 */

import { data as json, type LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { useState } from "react";
import { Card, BlockStack, InlineGrid, InlineStack, Text, Badge, Banner } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { SeoSectionLayout } from "../components/seo/SeoSectionLayout";
import { CrawlSnapshotHeader } from "../components/seo/CrawlSnapshotHeader";
import {
  ReportGrid,
  ReportRow,
  CapNotice,
  EditAction,
  PageLink,
  SubsectionHeading,
  CsvExportButton,
  ACTION_COLUMNS,
  STATUS_COLUMNS,
} from "../components/seo/crawl/ReportTable";
import { Tile } from "../components/seo/crawl/Tile";
import { meetsPlan } from "../utils/planUtils";
import type { Plan } from "../config/plans";
import type { AuditType } from "../services/seo/audit.service";
import type { SnapshotHeaderView } from "../services/seo/crawl.shared";
// Loader-only imports. `onpage.service` pulls in `crawl.service` (and with it
// `url-resolver.server`), so nothing here may be referenced from the rendered
// component — the loader is stripped from the client build and these are
// tree-shaken with it. Same rule as SLOW_PAGE_WARN_MS living in crawl.shared.
import {
  analyzeIndexability,
  analyzeCanonicals,
  analyzeHeadings,
  findMissingMetaDescriptions,
  findImagesWithoutAlt,
  findThinPages,
  canonicalHostFromPages,
  selfCanonicalPages,
  THIN_MIN_SAMPLE,
  type OnPageRow,
  type IndexabilityFinding,
  type CanonicalFinding,
  type OnPageIssueRow,
  type ThinPageRow,
} from "../services/seo/onpage.service";

const TYPE_PATH: Record<AuditType, string> = {
  product: "/app/products",
  collection: "/app/collections",
  article: "/app/blog",
  page: "/app/pages",
};

const UI_ROW_CAP = 100;

/** Ids double as the `?tab=` deep-link values the SEO dashboard's problem
 *  buckets navigate with — keep in sync with DEEP_LINK_FOR_PROBLEM in
 *  app.seo._index.tsx. */
const CATEGORY_IDS = [
  "indexability",
  "canonicals",
  "h1",
  "meta",
  "thin",
  "images",
  "headDrift",
  "duplicates",
] as const;
type CategoryId = (typeof CATEGORY_IDS)[number];

interface HeadDriftRow {
  url: string;
  resourceType: AuditType;
  resourceId: string;
  title: string;
  crawledTitle: string;
  dbTitle: string;
}

interface DuplicateGroupRow {
  title: string;
  urls: Array<{
    url: string;
    resourceType: string | null;
    resourceId: string | null;
    locale: string;
  }>;
}

const SHOP_NAME_QUERY = `#graphql
  query seoOnPageShopName {
    shop { name }
  }
`;

async function fetchShopName(admin: any, fallbackShop: string): Promise<string> {
  try {
    const res = await admin.graphql(SHOP_NAME_QUERY);
    const j: any = await res.json();
    return j?.data?.shop?.name || fallbackShop.replace(/\.myshopify\.com$/, "");
  } catch {
    return fallbackShop.replace(/\.myshopify\.com$/, "");
  }
}

async function loadPlan(db: any, shop: string): Promise<Plan> {
  const settings = await db.aISettings.findUnique({ where: { shop }, select: { subscriptionPlan: true } });
  return (settings?.subscriptionPlan || "free") as Plan;
}

/** Static example for the gated state — mirrors the crawl tab's, never the DB. */
const EXAMPLE_SNAPSHOT: SnapshotHeaderView = {
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  status: "completed",
  errorCode: null,
  blockedBy: null,
  pagesCrawled: 412,
  totalDiscovered: 412,
};

const EMPTY_LISTS = {
  indexabilityProblems: [] as IndexabilityFinding[],
  indexabilityExpected: [] as IndexabilityFinding[],
  nofollowOnly: [] as IndexabilityFinding[],
  indexabilityUnknown: 0,
  indexabilityConsidered: 0,
  canonicals: [] as CanonicalFinding[],
  h1Missing: [] as OnPageIssueRow[],
  h1Multiple: [] as OnPageIssueRow[],
  h1SameAsTitle: [] as OnPageIssueRow[],
  metaMissing: [] as OnPageIssueRow[],
  metaDuplicates: [] as DuplicateGroupRow[],
  thin: [] as ThinPageRow[],
  thinSkippedTypes: [] as Array<{ resourceType: string; pageCount: number }>,
  images: [] as OnPageIssueRow[],
  headDrift: [] as HeadDriftRow[],
  duplicates: [] as DuplicateGroupRow[],
  /** Handed to the component rather than imported there — see the import note. */
  thinMinSample: THIN_MIN_SAMPLE,
  parseStateKnown: false,
  totals: {
    indexability: 0,
    indexabilityExpected: 0,
    nofollowOnly: 0,
    canonicals: 0,
    h1: 0,
    h1Missing: 0,
    h1Multiple: 0,
    h1SameAsTitle: 0,
    meta: 0,
    thin: 0,
    images: 0,
    headDrift: 0,
    duplicates: 0,
    metaDuplicates: 0,
  },
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");
  const shop = session.shop;

  const plan = await loadPlan(db, shop);
  if (!meetsPlan(plan, "pro")) {
    return json({ gated: true, running: false, snapshot: EXAMPLE_SNAPSHOT, ...EMPTY_LISTS });
  }

  // Loader-only imports: both modules pull `url-resolver.server` in
  // transitively, which must never reach the client bundle.
  const { loadLatestSnapshot, toHeaderView, loadExpectedNoindexReasons } = await import(
    "../services/seo/crawl-snapshot.server"
  );
  const { computeHeadDrift, groupDuplicateTitles, groupDuplicateValues, normalizeMetaDescription } =
    await import("../services/seo/crawl.service");
  const { fetchPrimaryDomain } = await import("../utils/shop-domain.server");

  const latest = await loadLatestSnapshot(db, shop);
  if (!latest.row) {
    return json({ gated: false, running: latest.running, snapshot: null, ...EMPTY_LISTS });
  }

  // ALL rows, not just the 2xx ones: "canonical points at a 404" is only
  // answerable if the 404 row is in the map. Only 2xx rows are ever JUDGED
  // (every rule filters on the status itself) — the rest are lookup targets.
  const pages: OnPageRow[] = await db.seoCrawlPage.findMany({
    where: { shop, snapshotId: latest.row.id },
    select: {
      url: true,
      title: true,
      metaDesc: true,
      canonical: true,
      metaRobots: true,
      xRobotsTag: true,
      indexabilityKnown: true,
      h1Count: true,
      h1First: true,
      wordCount: true,
      imgCount: true,
      imgMissingAlt: true,
      statusCode: true,
      redirectHops: true,
      resourceType: true,
      resourceId: true,
      locale: true,
    },
  });

  // §3.2 — what makes a `noindex` EXPECTED rather than a finding.
  const expectedByResource = await loadExpectedNoindexReasons(db, shop);

  const [shopName, primaryDomain] = await Promise.all([
    fetchShopName(admin, shop),
    fetchPrimaryDomain(admin, shop),
  ]);

  const indexability = analyzeIndexability(pages, expectedByResource);
  // The host comes from the crawled URLs, never from `fetchPrimaryDomain` —
  // that one falls back to the myshopify host on a throttled Admin call, and
  // every canonical would then read as "foreign domain". The looked-up domain
  // is passed as an ALIAS instead, so a canonical spelled either way collapses.
  const canonicalHost = canonicalHostFromPages(pages);
  const canonicals = canonicalHost
    ? analyzeCanonicals(pages, canonicalHost, [shop, primaryDomain])
    : [];
  const headings = analyzeHeadings(pages);
  const metaMissing = findMissingMetaDescriptions(pages);
  const images = findImagesWithoutAlt(pages);
  const thin = findThinPages(pages);

  const okPages = pages.filter((p) => p.statusCode >= 200 && p.statusCode < 300);
  // Duplicates are judged ONLY on pages Google would index under their own URL.
  // Shopify answers 200 for a translated product under its primary handle
  // behind every locale prefix (/es/products/<german-handle>, /fr/…), each
  // serving the untranslated title and canonicalising to the properly
  // translated URL — so grouping by title alone reports one product as five
  // duplicates on every multilingual shop.
  const indexablePages = selfCanonicalPages(okPages, canonicalHost, [shop, primaryDomain]);
  // Totals BEFORE the slice — taking `.length` of an already-sliced array is
  // how a tile ends up reporting the cap ("100") as the answer.
  const duplicatesAll = groupDuplicateTitles(
    indexablePages.map((p) => ({ url: p.url, title: p.title })),
    shopName,
  );
  const metaDuplicatesAll = groupDuplicateValues(
    indexablePages.map((p) => ({ url: p.url, value: p.metaDesc })),
    normalizeMetaDescription,
  );

  // Each grouped URL carries its resource back, so a duplicate row can offer
  // the editor directly instead of making the merchant hunt for the product.
  const rowByUrl = new Map(pages.map((p) => [p.url, p]));
  const withResources = (groups: { title: string; urls: string[] }[]): DuplicateGroupRow[] =>
    groups.map((group) => ({
      title: group.title,
      urls: group.urls.map((url) => {
        const row = rowByUrl.get(url);
        return {
          url,
          resourceType: row?.resourceType ?? null,
          resourceId: row?.resourceId ?? null,
          locale: row?.locale ?? "",
        };
      }),
    }));
  const duplicates = withResources(duplicatesAll.slice(0, UI_ROW_CAP));
  const metaDuplicates = withResources(metaDuplicatesAll.slice(0, UI_ROW_CAP));

  // §3.8 — head drift moved over from the crawl tab, comparison rule unchanged.
  const headDriftCandidates = pages
    .filter(
      (p) =>
        p.resourceId &&
        p.resourceType &&
        p.resourceType !== "unknown" &&
        p.locale === "" &&
        p.statusCode >= 200 &&
        p.statusCode < 300,
    )
    .map((p) => ({
      resourceType: p.resourceType as AuditType,
      resourceId: p.resourceId as string,
      crawledTitle: p.title,
    }));
  // `count` is the TRUE total, `items` the capped slice — the tile must show
  // the former, or every shop past 100 findings reads exactly "100".
  const headDriftResult = await computeHeadDrift(db, shop, headDriftCandidates, shopName, UI_ROW_CAP);
  const urlByResource = new Map(
    pages
      .filter((p) => p.resourceId && p.resourceType)
      .map((p) => [`${p.resourceType}:${p.resourceId}`, p.url]),
  );
  const headDrift: HeadDriftRow[] = headDriftResult.items.map((i) => ({
    url: urlByResource.get(`${i.type}:${i.id}`) || "",
    resourceType: i.type,
    resourceId: i.id,
    title: i.title,
    crawledTitle: i.crawledTitle,
    dbTitle: i.dbTitle,
  }));

  return json({
    gated: false,
    running: latest.running,
    snapshot: toHeaderView(latest),
    indexabilityProblems: indexability.problems.slice(0, UI_ROW_CAP),
    indexabilityExpected: indexability.expected.slice(0, UI_ROW_CAP),
    nofollowOnly: indexability.nofollowOnly.slice(0, UI_ROW_CAP),
    indexabilityUnknown: indexability.unknownCount,
    indexabilityConsidered: indexability.consideredCount,
    canonicals: canonicals.slice(0, UI_ROW_CAP),
    h1Missing: headings.missing.slice(0, UI_ROW_CAP),
    h1Multiple: headings.multiple.slice(0, UI_ROW_CAP),
    h1SameAsTitle: headings.sameAsTitle.slice(0, UI_ROW_CAP),
    metaMissing: metaMissing.slice(0, UI_ROW_CAP),
    metaDuplicates,
    thin: thin.pages.slice(0, UI_ROW_CAP),
    thinSkippedTypes: thin.skippedTypes,
    images: images.slice(0, UI_ROW_CAP),
    headDrift,
    duplicates,
    thinMinSample: THIN_MIN_SAMPLE,
    // §2.2/§2.3 — this snapshot records whether a page's body was parsed. The
    // two categories built on the NEW columns (images, "H1 equals title") are
    // unmeasurable without it and must say "unknown" rather than "none found".
    parseStateKnown: headings.sameAsTitleKnown,
    // TRUE totals, before every UI_ROW_CAP slice above: the tiles and the
    // "showing N of M" notices both read these, so neither can quietly report
    // the cap as the answer.
    totals: {
      indexability: indexability.problems.length,
      indexabilityExpected: indexability.expected.length,
      nofollowOnly: indexability.nofollowOnly.length,
      canonicals: canonicals.length,
      h1: headings.missing.length + headings.multiple.length,
      h1Missing: headings.missing.length,
      h1Multiple: headings.multiple.length,
      h1SameAsTitle: headings.sameAsTitle.length,
      meta: metaMissing.length,
      thin: thin.pages.length,
      images: images.length,
      headDrift: headDriftResult.count,
      duplicates: duplicatesAll.length,
      metaDuplicates: metaDuplicatesAll.length,
    },
  });
};

export default function SeoOnPage() {
  const data = useLoaderData<typeof loader>();
  const { t } = useI18n();
  const { handleNavigate } = useAppNavigation();
  const o = (t.seo as any).onpagePage as Record<string, string>;

  const [searchParams] = useSearchParams();
  const requested = searchParams.get("tab") as CategoryId | null;
  const [activeTab, setActiveTab] = useState<CategoryId>(
    requested && CATEGORY_IDS.includes(requested) ? requested : "indexability",
  );

  const openInEditor = (type: AuditType, id: string) => {
    handleNavigate(TYPE_PATH[type], { searchParams: new URLSearchParams({ select: id }) });
  };
  const editorCell = (resourceType: string | null, resourceId: string | null) =>
    resourceType && resourceType !== "unknown" && resourceId ? (
      <EditAction label={o.openInEditor} onClick={() => openInEditor(resourceType as AuditType, resourceId)} />
    ) : null;

  const CATEGORY_LABEL: Record<CategoryId, string> = {
    indexability: o.tabIndexability,
    canonicals: o.tabCanonicals,
    h1: o.tabH1,
    meta: o.tabMeta,
    thin: o.tabThin,
    images: o.tabImages,
    headDrift: o.tabHeadDrift,
    duplicates: o.tabDuplicates,
  };

  const snapshot = data.snapshot;
  /** §1.1 — the snapshot predates the indexability columns (or every page of
   *  it failed). Saying "unknown" is the whole point: an empty metaRobots is
   *  NOT evidence that everything is indexable. */
  const indexabilityUnknownAll =
    data.indexabilityConsidered > 0 && data.indexabilityUnknown === data.indexabilityConsidered;

  const issueList = (
    rows: OnPageIssueRow[],
    emptyText: string,
    hint: string | undefined,
    total: number,
    /** Template for the trailing badge, e.g. "{detail} Bilder ohne Alt-Text".
     *  Without it a bare "6/66" reads as a score, which is how it was read. */
    detailTemplate?: string,
  ) => (
    <BlockStack gap="200">
      {rows.length === 0 ? (
        <Text as="p" tone="subdued">{emptyText}</Text>
      ) : (
        <>
          {hint && <Text as="p" variant="bodySm" tone="subdued">{hint}</Text>}
          <CapNotice shown={rows.length} total={total} template={o.rowCapHint} />
          <ReportGrid columns={STATUS_COLUMNS}>
            {rows.map((row) => (
              <ReportRow
                key={row.url}
                cells={[
                  <BlockStack gap="050">
                    <PageLink url={row.url} />
                    {row.title && <Text as="span" variant="bodySm" tone="subdued">{row.title}</Text>}
                  </BlockStack>,
                  row.detail ? (
                    <Badge>{detailTemplate ? detailTemplate.replace("{detail}", row.detail) : row.detail}</Badge>
                  ) : null,
                  editorCell(row.resourceType, row.resourceId),
                ]}
              />
            ))}
          </ReportGrid>
        </>
      )}
    </BlockStack>
  );

  const duplicateList = (
    groups: DuplicateGroupRow[],
    emptyText: string,
    hint: string | undefined,
    total: number,
  ) => (
    <BlockStack gap="200">
      {groups.length === 0 ? (
        <Text as="p" tone="subdued">{emptyText}</Text>
      ) : (
        <>
          {hint && <Text as="p" variant="bodySm" tone="subdued">{hint}</Text>}
          <CapNotice shown={groups.length} total={total} template={o.rowCapHint} />
          {groups.map((g) => (
            <BlockStack key={g.title} gap="100">
              <Text as="span" variant="bodySm" fontWeight="semibold">{g.title}</Text>
              <ReportGrid columns={ACTION_COLUMNS}>
                {g.urls.map((u) => (
                  <ReportRow
                    key={u.url}
                    cells={[
                      <InlineStack gap="100" blockAlign="center" wrap>
                        <PageLink url={u.url} />
                        {u.locale && <Badge>{u.locale}</Badge>}
                      </InlineStack>,
                      editorCell(u.resourceType, u.resourceId),
                    ]}
                  />
                ))}
              </ReportGrid>
            </BlockStack>
          ))}
        </>
      )}
    </BlockStack>
  );

  const body = (
    <BlockStack gap="400">
      <Banner tone="info" title={o.introTitle}>
        <Text as="p" variant="bodyMd">{o.introBody}</Text>
      </Banner>

      <CrawlSnapshotHeader snapshot={snapshot} running={data.running} gated={data.gated}>
        {snapshot && (
          <InlineGrid columns={{ xs: 2, sm: 3, md: 4, lg: 4 }} gap="300">
            <Tile
              label={o.tileIndexability}
              value={indexabilityUnknownAll ? "—" : data.totals.indexability}
              hint={indexabilityUnknownAll ? o.indexabilityUnknownHint : undefined}
              onClick={() => setActiveTab("indexability")}
              selected={activeTab === "indexability"}
            />
            <Tile
              label={o.tileCanonicals}
              value={data.totals.canonicals}
              onClick={() => setActiveTab("canonicals")}
              selected={activeTab === "canonicals"}
            />
            <Tile
              label={o.tileH1}
              value={data.totals.h1}
              onClick={() => setActiveTab("h1")}
              selected={activeTab === "h1"}
            />
            <Tile
              label={o.tileMeta}
              value={data.totals.meta}
              onClick={() => setActiveTab("meta")}
              selected={activeTab === "meta"}
            />
            <Tile
              label={o.tileThin}
              value={data.totals.thin}
              onClick={() => setActiveTab("thin")}
              selected={activeTab === "thin"}
            />
            <Tile
              label={o.tileImages}
              // "—", not 0: on a snapshot predating the imgCount columns there
              // is nothing to count, which is not the same as "all fine".
              value={data.parseStateKnown ? data.totals.images : "—"}
              hint={
                !data.parseStateKnown
                  ? o.categoryUnknownHint
                  : data.totals.images > 0
                    ? o.imagesTileHint
                    : undefined
              }
              onClick={() => setActiveTab("images")}
              selected={activeTab === "images"}
            />
            <Tile
              label={o.tileHeadDrift}
              value={data.totals.headDrift}
              onClick={() => setActiveTab("headDrift")}
              selected={activeTab === "headDrift"}
            />
            <Tile
              label={o.tileDuplicates}
              value={data.totals.duplicates}
              onClick={() => setActiveTab("duplicates")}
              selected={activeTab === "duplicates"}
            />
          </InlineGrid>
        )}
      </CrawlSnapshotHeader>

      {snapshot && (
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center" gap="200">
              <Text as="h3" variant="headingMd">{CATEGORY_LABEL[activeTab]}</Text>
              {/* Exports the FULL category, not the UI_ROW_CAP slice (§5.3). */}
              <CsvExportButton
                path="/app/seo/onpage/export"
                category={activeTab}
                label={o.exportCsv}
                emptyLabel={o.exportCsvEmpty}
              />
            </InlineStack>

            {activeTab === "indexability" && (
              <BlockStack gap="300">
                <Text as="p" variant="bodySm" tone="subdued">{o.indexabilityHint}</Text>
                {indexabilityUnknownAll ? (
                  // Never claim "all good" from an empty column (§1.1).
                  <Banner tone="info">{o.indexabilityUnknownBanner}</Banner>
                ) : (
                  <>
                    {data.indexabilityProblems.length === 0 ? (
                      <Text as="p" tone="subdued">{o.emptyIndexability}</Text>
                    ) : (
                      <>
                        <Banner tone="critical">{o.indexabilityProblemHint}</Banner>
                        <CapNotice
                          shown={data.indexabilityProblems.length}
                          total={data.totals.indexability}
                          template={o.rowCapHint}
                        />
                        <ReportGrid columns={STATUS_COLUMNS}>
                          {data.indexabilityProblems.map((f) => (
                            <ReportRow
                              key={f.url}
                              cells={[
                                <BlockStack gap="050">
                                  <PageLink url={f.url} />
                                  {f.title && (
                                    <Text as="span" variant="bodySm" tone="subdued">{f.title}</Text>
                                  )}
                                </BlockStack>,
                                <InlineStack gap="100">
                                  <Badge tone="critical">{o.badgeNoindex}</Badge>
                                  {/* Marked, not judged (§3.2 nr. 3). */}
                                  {f.localePrefixed && <Badge>{o.badgeLocalePrefixed}</Badge>}
                                </InlineStack>,
                                editorCell(f.resourceType, f.resourceId),
                              ]}
                            />
                          ))}
                        </ReportGrid>
                      </>
                    )}

                    {data.indexabilityExpected.length > 0 && (
                      <BlockStack gap="200">
                        <SubsectionHeading title={o.expectedNoindexTitle} hint={o.expectedNoindexHint} />
                        <ReportGrid columns={ACTION_COLUMNS}>
                          {data.indexabilityExpected.map((f) => (
                            <ReportRow
                              key={f.url}
                              cells={[
                                <PageLink url={f.url} />,
                                <Badge>
                                  {o[`expectedReason_${f.expectedReason}`] || (f.expectedReason ?? "")}
                                </Badge>,
                              ]}
                            />
                          ))}
                        </ReportGrid>
                      </BlockStack>
                    )}

                    {data.nofollowOnly.length > 0 && (
                      <BlockStack gap="200">
                        <SubsectionHeading title={o.nofollowTitle} hint={o.nofollowHint} />
                        <ReportGrid columns={ACTION_COLUMNS}>
                          {data.nofollowOnly.map((f) => (
                            <ReportRow
                              key={f.url}
                              cells={[
                                <PageLink url={f.url} />,
                                <Badge tone="attention">{o.badgeNofollow}</Badge>,
                              ]}
                            />
                          ))}
                        </ReportGrid>
                      </BlockStack>
                    )}

                    {data.indexabilityUnknown > 0 && (
                      <Text as="p" variant="bodySm" tone="subdued">
                        {o.indexabilityPartialUnknown.replace(
                          "{count}",
                          String(data.indexabilityUnknown),
                        )}
                      </Text>
                    )}
                  </>
                )}
              </BlockStack>
            )}

            {activeTab === "canonicals" && (
              <BlockStack gap="200">
                <Text as="p" variant="bodySm" tone="subdued">{o.canonicalHint}</Text>
                {data.canonicals.length === 0 ? (
                  <Text as="p" tone="subdued">{o.emptyCanonicals}</Text>
                ) : (
                  <>
                  <CapNotice
                    shown={data.canonicals.length}
                    total={data.totals.canonicals}
                    template={o.rowCapHint}
                  />
                  <ReportGrid columns={STATUS_COLUMNS}>
                    {data.canonicals.map((f) => (
                      <ReportRow
                        key={`${f.url}:${f.issue}`}
                        cells={[
                          <BlockStack gap="050">
                            <PageLink url={f.url} />
                            {f.target && (
                              <InlineStack gap="100" blockAlign="center" wrap>
                                <Text as="span" variant="bodySm" tone="subdued">
                                  {o.canonicalTargetLabel}:
                                </Text>
                                <PageLink url={f.target} />
                              </InlineStack>
                            )}
                          </BlockStack>,
                          <Badge tone={CANONICAL_TONE[f.issue]}>{o[`canonicalIssue_${f.issue}`] || f.issue}</Badge>,
                          editorCell(f.resourceType, f.resourceId),
                        ]}
                      />
                    ))}
                  </ReportGrid>
                  </>
                )}
              </BlockStack>
            )}

            {activeTab === "h1" && (
              <BlockStack gap="300">
                <BlockStack gap="200">
                  <SubsectionHeading title={o.h1MissingTitle} hint={o.h1MissingHint} />
                  {issueList(data.h1Missing, o.emptyH1Missing, undefined, data.totals.h1Missing)}
                </BlockStack>
                <BlockStack gap="200">
                  <SubsectionHeading title={o.h1MultipleTitle} hint={o.h1MultipleHint} />
                  {issueList(data.h1Multiple, o.emptyH1Multiple, undefined, data.totals.h1Multiple, o.h1MultipleBadge)}
                </BlockStack>
                <BlockStack gap="200">
                  <SubsectionHeading title={o.h1SameTitle} hint={o.h1SameHint} />
                  {/* Needs h1First, a new column — unmeasurable on an older
                      snapshot, and "none found" would be a claim (§1.1). */}
                  {data.parseStateKnown ? (
                    issueList(data.h1SameAsTitle, o.emptyH1Same, undefined, data.totals.h1SameAsTitle)
                  ) : (
                    <Banner tone="info">{o.categoryUnknownBanner}</Banner>
                  )}
                </BlockStack>
              </BlockStack>
            )}

            {activeTab === "meta" && (
              <BlockStack gap="300">
                <BlockStack gap="200">
                  <SubsectionHeading title={o.metaMissingTitle} hint={o.metaMissingHint} />
                  {issueList(data.metaMissing, o.emptyMetaMissing, undefined, data.totals.meta)}
                </BlockStack>
                <BlockStack gap="200">
                  <SubsectionHeading title={o.metaDuplicateTitle} hint={o.metaDuplicateHint} />
                  {duplicateList(data.metaDuplicates, o.emptyMetaDuplicates, undefined, data.totals.metaDuplicates)}
                </BlockStack>
              </BlockStack>
            )}

            {activeTab === "thin" && (
              <BlockStack gap="200">
                <Text as="p" variant="bodySm" tone="subdued">{o.thinHint}</Text>
                {data.thinSkippedTypes.length > 0 && (
                  // Said out loud rather than silently omitted: a percentile
                  // over six pages is noise (§3.5).
                  <Banner tone="info">
                    {o.thinSkippedTypesHint
                      .replace("{types}", data.thinSkippedTypes.map((s) => s.resourceType).join(", "))
                      .replace("{min}", String(data.thinMinSample))}
                  </Banner>
                )}
                {data.thin.length === 0 ? (
                  <Text as="p" tone="subdued">{o.emptyThin}</Text>
                ) : (
                  <>
                  <CapNotice shown={data.thin.length} total={data.totals.thin} template={o.rowCapHint} />
                  <ReportGrid columns={STATUS_COLUMNS}>
                    {data.thin.map((row) => (
                      <ReportRow
                        key={row.url}
                        cells={[
                          <BlockStack gap="050">
                            <PageLink url={row.url} />
                            {row.title && <Text as="span" variant="bodySm" tone="subdued">{row.title}</Text>}
                          </BlockStack>,
                          <Badge tone="attention">
                            {o.thinWordCount.replace("{count}", String(row.wordCount))}
                          </Badge>,
                          editorCell(row.resourceType, row.resourceId),
                        ]}
                      />
                    ))}
                  </ReportGrid>
                  </>
                )}
              </BlockStack>
            )}

            {activeTab === "images" &&
              (data.parseStateKnown ? (
                issueList(data.images, o.emptyImages, o.imagesHint, data.totals.images, o.imagesBadge)
              ) : (
                <Banner tone="info">{o.categoryUnknownBanner}</Banner>
              ))}

            {activeTab === "headDrift" && (
              <BlockStack gap="200">
                <Text as="p" variant="bodySm" tone="subdued">{o.headDriftHint}</Text>
                {data.headDrift.length === 0 ? (
                  <Text as="p" tone="subdued">{o.emptyHeadDrift}</Text>
                ) : (
                  <ReportGrid columns={ACTION_COLUMNS}>
                    {data.headDrift.map((h) => (
                      <ReportRow
                        key={`${h.resourceType}:${h.resourceId}`}
                        cells={[
                          <BlockStack gap="050">
                            {h.url && <PageLink url={h.url} />}
                            <Text as="span" variant="bodySm" tone="subdued">
                              {o.colCrawledTitle}: {h.crawledTitle || "—"}
                            </Text>
                            <Text as="span" variant="bodySm">{o.colDbTitle}: {h.dbTitle || "—"}</Text>
                          </BlockStack>,
                          <EditAction
                            label={o.openInEditor}
                            onClick={() => openInEditor(h.resourceType, h.resourceId)}
                          />,
                        ]}
                      />
                    ))}
                  </ReportGrid>
                )}
              </BlockStack>
            )}

            {activeTab === "duplicates" &&
              duplicateList(data.duplicates, o.emptyDuplicates, o.duplicatesHint, data.totals.duplicates)}
          </BlockStack>
        </Card>
      )}
    </BlockStack>
  );

  if (data.gated) {
    return (
      <SeoSectionLayout
        sectionId="onpage"
        lockedExtra={
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">{o.upgradeExampleTitle}</Text>
              <InlineGrid columns={{ xs: 2, sm: 3, md: 6 }} gap="300">
                <Tile label={o.tileIndexability} value={2} />
                <Tile label={o.tileCanonicals} value={4} />
                <Tile label={o.tileH1} value={7} />
                <Tile label={o.tileMeta} value={12} />
                <Tile label={o.tileThin} value={5} />
                <Tile label={o.tileDuplicates} value={3} />
              </InlineGrid>
            </BlockStack>
          </Card>
        }
      >
        {null}
      </SeoSectionLayout>
    );
  }

  return <SeoSectionLayout sectionId="onpage">{body}</SeoSectionLayout>;
}

/** Severity per §3.3 — a broken/foreign/noindex canonical costs the page its
 *  ranking outright, the rest weaken a signal. */
const CANONICAL_TONE: Record<CanonicalFinding["issue"], "critical" | "warning"> = {
  missing: "warning",
  targetBroken: "critical",
  targetRedirects: "warning",
  crossHost: "critical",
  chain: "warning",
  targetNoindex: "critical",
};
