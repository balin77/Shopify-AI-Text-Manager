/**
 * The on-page half of the crawl report (PLAN_SEO_CRAWL_EXPANSION §3.7).
 *
 * A COMPONENT rather than a route since the two reports became two steps of one
 * tab: `/app/seo/crawl` owns the snapshot header, the step tiles and the
 * `?view=` state, and renders either the delivery sections or these.
 *
 * Split into tiles and sections because they land in different places — the
 * tiles go INSIDE the shared snapshot header card (so both steps look the same
 * there), the sections in their own card below it.
 */

import { Card, BlockStack, InlineGrid, InlineStack, Text, Badge, Banner } from "@shopify/polaris";
import { useI18n } from "../../../contexts/I18nContext";
import { useAppNavigation } from "../../../hooks/useAppNavigation";
import {
  ReportGrid,
  ReportRow,
  CapNotice,
  EditAction,
  PageLink,
  MaybeLink,
  SubsectionHeading,
  AiFixButton,
  CsvExportButton,
  ACTION_COLUMNS,
  STATUS_COLUMNS,
} from "./ReportTable";
import { Tile } from "./Tile";
import type { AuditType } from "../../../services/seo/audit.service";
import type { OnPageReport, DuplicateGroupRow } from "../../../services/seo/onpage-report.server";
import type { OnPageIssueRow, CanonicalFinding } from "../../../services/seo/onpage.service";

const TYPE_PATH: Record<AuditType, string> = {
  product: "/app/products",
  collection: "/app/collections",
  article: "/app/blog",
  page: "/app/pages",
};

/** Ids double as the `?tab=` deep-link values the SEO dashboard's problem
 *  buckets navigate with — keep in sync with DEEP_LINK_FOR_PROBLEM in
 *  app.seo._index.tsx. */
export const ONPAGE_CATEGORY_IDS = [
  "indexability",
  "canonicals",
  "h1",
  "meta",
  "thin",
  "images",
  "headDrift",
  "duplicates",
] as const;
export type OnPageCategoryId = (typeof ONPAGE_CATEGORY_IDS)[number];

/** §1.1 — the snapshot predates the indexability columns (or every page of it
 *  failed). Saying "unknown" is the whole point: an empty metaRobots is NOT
 *  evidence that everything is indexable. */
function isIndexabilityUnknown(data: OnPageReport): boolean {
  return data.indexabilityConsidered > 0 && data.indexabilityUnknown === data.indexabilityConsidered;
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

export function OnPageTiles({
  data,
  activeTab,
  onSelect,
}: {
  data: OnPageReport;
  activeTab: OnPageCategoryId;
  onSelect: (tab: OnPageCategoryId) => void;
}) {
  const { t } = useI18n();
  const o = (t.seo as any).onpagePage as Record<string, string>;
  const indexabilityUnknownAll = isIndexabilityUnknown(data);
  const setActiveTab = onSelect;
  return (
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
  );
}

export function OnPageSections({
  data,
  activeTab,
}: {
  data: OnPageReport;
  activeTab: OnPageCategoryId;
}) {
  const { t } = useI18n();
  const { handleNavigate } = useAppNavigation();
  const o = (t.seo as any).onpagePage as Record<string, string>;
  const indexabilityUnknownAll = isIndexabilityUnknown(data);

  const openInEditor = (type: AuditType, id: string) => {
    handleNavigate(TYPE_PATH[type], { searchParams: new URLSearchParams({ select: id }) });
  };
  const editorCell = (resourceType: string | null, resourceId: string | null) =>
    resourceType && resourceType !== "unknown" && resourceId ? (
      <EditAction label={o.openInEditor} onClick={() => openInEditor(resourceType as AuditType, resourceId)} />
    ) : null;

  const CATEGORY_LABEL: Record<OnPageCategoryId, string> = {
    indexability: o.tabIndexability,
    canonicals: o.tabCanonicals,
    h1: o.tabH1,
    meta: o.tabMeta,
    thin: o.tabThin,
    images: o.tabImages,
    headDrift: o.tabHeadDrift,
    duplicates: o.tabDuplicates,
  };

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

  return (
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
                                {/* As SERVED — often relative, and on a
                                    crossHost finding possibly not a URL. */}
                                <MaybeLink value={f.target} base={f.url} />
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
                  {data.metaMissing.length > 0 && (
                    <AiFixButton
                      problemCode="metaDescriptionMissing"
                      label={o.aiFixMeta}
                      caveat={o.aiFixMetaCaveat}
                      startedLabel={o.aiFixStarted}
                      errorLabel={o.aiFixError}
                    />
                  )}
                  {issueList(data.metaMissing, o.emptyMetaMissing, undefined, data.totals.meta)}
                </BlockStack>
                <BlockStack gap="200">
                  <SubsectionHeading title={o.metaDuplicateTitle} hint={o.metaDuplicateHint} />
                  {data.metaDuplicates.length > 0 && (
                    <AiFixButton
                      problemCode="duplicateSeoDescription"
                      label={o.aiFixMetaDuplicates}
                      caveat={o.aiFixMetaCaveat}
                      startedLabel={o.aiFixStarted}
                      errorLabel={o.aiFixError}
                    />
                  )}
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

            {activeTab === "duplicates" && (
              <BlockStack gap="200">
                {data.duplicates.length > 0 && (
                  <AiFixButton
                    problemCode="duplicateSeoTitle"
                    label={o.aiFixDuplicateTitles}
                    caveat={o.aiFixTitleCaveat}
                    startedLabel={o.aiFixStarted}
                    errorLabel={o.aiFixError}
                  />
                )}
                {duplicateList(data.duplicates, o.emptyDuplicates, o.duplicatesHint, data.totals.duplicates)}
              </BlockStack>
            )}
          </BlockStack>
        </Card>
  );
}

