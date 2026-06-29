/**
 * SEO Audit Dashboard (SEO_TAB_IMPLEMENTATION_PLAN.md Phase 1).
 *
 * Reads the DB content cache (never a live API sweep) via analyzeStore, scores
 * every item with the shared pure computeSeoScore, and presents store-wide
 * aggregates: average score, distribution, score-by-type, the most common
 * problems, and a worst-offenders list whose rows deep-link into the editor
 * (?select=<GID>) through useAppNavigation so Shopify session params survive.
 */

import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Button,
  ProgressBar,
  Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { SeoSectionLayout } from "../components/seo/SeoSectionLayout";
import { scoreTone } from "../utils/seo-score";
import { analyzeStore, type AuditType } from "../services/seo/audit.service";
import type { Plan } from "../config/plans";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { db } = await import("../db.server");

  const settings = await db.aISettings.findUnique({
    where: { shop: session.shop },
    select: {
      subscriptionPlan: true,
      seoTitleSuffixEnabled: true,
      seoTitleSuffix: true,
    },
  });

  const plan = (settings?.subscriptionPlan || "free") as Plan;
  const suffix =
    settings?.seoTitleSuffixEnabled && settings.seoTitleSuffix ? settings.seoTitleSuffix : "";
  const seoTitleEffectiveLimit = suffix ? 60 - suffix.length : 60;

  const audit = await analyzeStore(session.shop, { db, seoTitleEffectiveLimit, plan });
  return json({ audit });
};

/** Editor list route per audited type — target of the row deep-link. */
const TYPE_PATH: Record<AuditType, string> = {
  product: "/app/products",
  collection: "/app/collections",
  article: "/app/blog",
  page: "/app/pages",
};

export default function SeoDashboard() {
  const { audit } = useLoaderData<typeof loader>();
  const { t } = useI18n();
  const { handleNavigate } = useAppNavigation();
  const d = (t.seo as any).dashboard;

  const openInEditor = (type: AuditType, id: string) => {
    handleNavigate(TYPE_PATH[type], { searchParams: new URLSearchParams({ select: id }) });
  };

  if (audit.totalScanned === 0) {
    return (
      <SeoSectionLayout sectionId="overview">
        <Card>
          <div style={{ padding: "1rem" }}>
            <Text as="p" tone="subdued">
              {d.noData}
            </Text>
          </div>
        </Card>
      </SeoSectionLayout>
    );
  }

  return (
    <SeoSectionLayout sectionId="overview">
      <BlockStack gap="400">
        {audit.capped && (
          <Banner tone="info">
            {d.cappedNote
              .replace("{scanned}", String(audit.totalScanned))
              .replace("{total}", String(audit.totalAvailable))}
          </Banner>
        )}

        {/* Headline score + distribution */}
        <InlineStack gap="400" align="start" blockAlign="stretch" wrap>
          <div style={{ flex: "1 1 220px" }}>
            <Card>
              <BlockStack gap="200">
                <Text as="p" variant="bodySm" tone="subdued">
                  {d.averageScore}
                </Text>
                <Text as="p" variant="heading2xl" fontWeight="bold">
                  {audit.averageScore}
                </Text>
                <ProgressBar
                  progress={audit.averageScore}
                  tone={scoreTone(audit.averageScore) as any}
                  size="small"
                />
                <Text as="p" variant="bodySm" tone="subdued">
                  {d.itemsScanned}: {audit.totalScanned}
                </Text>
              </BlockStack>
            </Card>
          </div>

          <div style={{ flex: "2 1 320px" }}>
            <Card>
              <BlockStack gap="200">
                <DistributionRow
                  label={d.distributionGood}
                  count={audit.distribution.good}
                  total={audit.totalScanned}
                  tone="success"
                />
                <DistributionRow
                  label={d.distributionMedium}
                  count={audit.distribution.medium}
                  total={audit.totalScanned}
                  tone="warning"
                />
                <DistributionRow
                  label={d.distributionPoor}
                  count={audit.distribution.poor}
                  total={audit.totalScanned}
                  tone="critical"
                />
              </BlockStack>
            </Card>
          </div>
        </InlineStack>

        {/* Score by content type */}
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">
              {d.byType}
            </Text>
            {audit.byType.map((s) => (
              <InlineStack key={s.type} gap="300" blockAlign="center">
                <div style={{ width: "120px" }}>
                  <Text as="span" variant="bodyMd">
                    {d.types[s.type] || s.type}
                  </Text>
                </div>
                <div style={{ width: "48px" }}>
                  <Badge tone={scoreTone(s.avgScore) as any}>{String(s.avgScore)}</Badge>
                </div>
                <div style={{ flex: 1, minWidth: "120px" }}>
                  <ProgressBar
                    progress={s.avgScore}
                    tone={scoreTone(s.avgScore) as any}
                    size="small"
                  />
                </div>
                <Text as="span" variant="bodySm" tone="subdued">
                  {s.count}
                </Text>
              </InlineStack>
            ))}
          </BlockStack>
        </Card>

        {/* Most common problems */}
        {audit.problems.length > 0 && (
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">
                {d.problemsTitle}
              </Text>
              {audit.problems.map((p) => (
                <InlineStack key={p.code} gap="200" align="space-between" blockAlign="center">
                  <Text as="span" variant="bodyMd">
                    {d.problems[p.code] || p.code}
                  </Text>
                  <Badge tone="attention">
                    {d.affectedItems.replace("{count}", String(p.count))}
                  </Badge>
                </InlineStack>
              ))}
            </BlockStack>
          </Card>
        )}

        {/* Worst offenders */}
        {audit.worstOffenders.length > 0 && (
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">
                {d.worstOffenders}
              </Text>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ textAlign: "left", borderBottom: "1px solid #e1e3e5" }}>
                      <th style={{ padding: "6px 8px" }}>
                        <Text as="span" variant="bodySm" tone="subdued">{d.colItem}</Text>
                      </th>
                      <th style={{ padding: "6px 8px" }}>
                        <Text as="span" variant="bodySm" tone="subdued">{d.colType}</Text>
                      </th>
                      <th style={{ padding: "6px 8px" }}>
                        <Text as="span" variant="bodySm" tone="subdued">{d.colScore}</Text>
                      </th>
                      <th style={{ padding: "6px 8px" }}>
                        <Text as="span" variant="bodySm" tone="subdued">{d.colIssues}</Text>
                      </th>
                      <th style={{ padding: "6px 8px" }} />
                    </tr>
                  </thead>
                  <tbody>
                    {audit.worstOffenders.map((row) => (
                      <tr key={`${row.type}:${row.id}`} style={{ borderBottom: "1px solid #f1f2f3" }}>
                        <td style={{ padding: "6px 8px", maxWidth: "320px" }}>
                          <Text as="span" variant="bodyMd" truncate>
                            {row.title || row.id}
                          </Text>
                        </td>
                        <td style={{ padding: "6px 8px" }}>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {d.types[row.type] || row.type}
                          </Text>
                        </td>
                        <td style={{ padding: "6px 8px" }}>
                          <Badge tone={scoreTone(row.score) as any}>{String(row.score)}</Badge>
                        </td>
                        <td style={{ padding: "6px 8px" }}>
                          <Text as="span" variant="bodySm">{row.issueCount}</Text>
                        </td>
                        <td style={{ padding: "6px 8px", textAlign: "right" }}>
                          <Button variant="plain" onClick={() => openInEditor(row.type, row.id)}>
                            {d.openInEditor}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </SeoSectionLayout>
  );
}

function DistributionRow({
  label,
  count,
  total,
  tone,
}: {
  label: string;
  count: number;
  total: number;
  tone: "success" | "warning" | "critical";
}) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <InlineStack gap="300" blockAlign="center">
      <div style={{ width: "120px" }}>
        <Text as="span" variant="bodyMd">
          {label}
        </Text>
      </div>
      <div style={{ flex: 1, minWidth: "120px" }}>
        <ProgressBar progress={pct} tone={tone as any} size="small" />
      </div>
      <div style={{ width: "48px", textAlign: "right" }}>
        <Text as="span" variant="bodySm" tone="subdued">
          {count}
        </Text>
      </div>
    </InlineStack>
  );
}
