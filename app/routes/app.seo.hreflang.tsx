/**
 * hreflang audit section (SEO_TAB_IMPLEMENTATION_PLAN.md Phase 4 / A5).
 *
 * Read-only audit: per published secondary locale, how much of the publishable
 * catalog is actually translated (so the native hreflang alternates point at
 * real translations, not identical content). This is also the app's ONE
 * language-coverage view — it answers "what exactly is missing" per content
 * TYPE and per FIELD here rather than in a second dashboard. Missing items deep
 * link into the editor (?select=<GID>) where the merchant can translate them.
 */

import { data as json, type LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import {
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Button,
  ProgressBar,
  Banner,
  Divider,
} from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { SeoSectionLayout } from "../components/seo/SeoSectionLayout";
import { SeoHelpBanner } from "../components/seo/SeoHelpBanner";
import { scoreTone, progressTone } from "../utils/seo-score";
import { formatNumber } from "../utils/format";
import { analyzeHreflang } from "../services/seo/hreflang.service";
import type {
  HreflangType,
  LocaleCoverage,
  TranslationKey,
  TypeCoverage,
} from "../services/seo/hreflang-coverage.shared";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");
  const result = await analyzeHreflang(session.shop, { db, admin });
  return json({ result });
};

const TYPE_PATH: Record<HreflangType, string> = {
  product: "/app/products",
  collection: "/app/collections",
  article: "/app/blog",
  page: "/app/pages",
};

/** How many missing items to list before "show more" per locale. */
const VISIBLE_MISSING = 10;

export default function SeoHreflang() {
  const { result } = useLoaderData<typeof loader>();
  const { t, locale: uiLocale } = useI18n();
  const { handleNavigate } = useAppNavigation();
  const h = t.seo.hreflangPage;

  const openInEditor = (type: HreflangType, id: string) => {
    handleNavigate(TYPE_PATH[type], { searchParams: new URLSearchParams({ select: id }) });
  };

  return (
    <SeoSectionLayout sectionId="hreflang">
      <BlockStack gap="400">
        <SeoHelpBanner title={h.helpTitle}>
          <BlockStack gap="200">
            <Text as="p" variant="bodyMd">{h.helpBody1}</Text>
            <Text as="p" variant="bodyMd">{h.helpBody2}</Text>
            <Text as="p" variant="bodyMd" tone="subdued">{h.scopeNote}</Text>
          </BlockStack>
        </SeoHelpBanner>

        {/* x-default / primary status */}
        <Card>
          <BlockStack gap="200">
            <InlineStack gap="200" blockAlign="center">
              <Text as="span" variant="bodyMd">
                {h.primaryLocale}:
              </Text>
              {result.primaryLocale ? (
                <Badge tone="success">{result.primaryLocale}</Badge>
              ) : (
                <Badge tone="critical">{h.noPrimary}</Badge>
              )}
            </InlineStack>
            <Text as="p" variant="bodySm" tone="subdued">
              {result.hasXDefault ? h.xDefaultOk : h.noXDefault}
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              {h.marketDomainHint}
            </Text>
          </BlockStack>
        </Card>

        {/* The percentage changed meaning when the per-field check landed, so it
            says so rather than reading as a regression the merchant caused. */}
        {!result.localesUnavailable && <Banner tone="info">{h.meaningNote}</Banner>}

        {result.capped && <Banner tone="info">{h.cappedNote}</Banner>}

        {result.localesUnavailable ? (
          <Card>
            <div style={{ padding: "1rem" }}>
              <Text as="p" tone="subdued">
                {h.localesUnavailable}
              </Text>
            </div>
          </Card>
        ) : result.coverage.length === 0 ? (
          // Nothing cached at all. Saying so beats rendering an empty section:
          // silence reads as "there is nothing to fix".
          <Card>
            <div style={{ padding: "1rem" }}>
              <Text as="p" tone="subdued">
                {h.nothingCached}
              </Text>
            </div>
          </Card>
        ) : (
          result.coverage.map((loc) => (
            <LocaleCoverageCard
              key={loc.locale}
              loc={loc}
              h={h}
              types={t.seo.dashboard.types}
              uiLocale={uiLocale}
              onOpen={openInEditor}
            />
          ))
        )}
      </BlockStack>
    </SeoSectionLayout>
  );
}

/** "SEO title: 12 · Description: 4" — only the fields that really are missing. */
function fieldGapLine(
  gaps: TypeCoverage["fieldGaps"],
  h: any,
  uiLocale: string,
): string | null {
  const parts = gaps
    .filter((g) => g.missing > 0)
    .map((g) =>
      h.fieldGapCount
        .replace("{label}", fieldLabel(h, g.key))
        .replace("{count}", formatNumber(g.missing, uiLocale)),
    );
  return parts.length > 0 ? parts.join(" · ") : null;
}

function fieldLabel(h: any, key: TranslationKey): string {
  return h.fields?.[key] || key;
}

function TypeCoverageRow({
  type,
  h,
  types,
  uiLocale,
}: {
  type: TypeCoverage;
  h: any;
  types: Record<string, string>;
  uiLocale: string;
}) {
  const label = types[type.resourceType] || type.resourceType;
  // Three states, and collapsing any two of them makes a confident wrong claim.
  // An empty cache is never evidence, so a type nobody synced reads as "not
  // scanned" — never as 0 missing or 100% done. A type that IS cached but has
  // nothing publishable (an all-draft catalogue) is a different answer, and
  // telling that merchant to sync would never change the outcome.
  const measured = type.known && type.scanned > 0;
  const gapLine = measured ? fieldGapLine(type.fieldGaps, h, uiLocale) : null;

  return (
    <BlockStack gap="100">
      <InlineStack align="space-between" blockAlign="center" gap="200">
        <InlineStack gap="200" blockAlign="center">
          <Text as="span" variant="bodyMd">{label}</Text>
          {measured ? (
            <Badge tone={scoreTone(type.coveragePct) as any}>{`${type.coveragePct}%`}</Badge>
          ) : (
            <Badge tone="attention">{h.typeNotScanned}</Badge>
          )}
        </InlineStack>
        {measured && (
          <Text as="span" variant="bodySm" tone="subdued">
            {h.typeSummary
              .replace("{complete}", formatNumber(type.complete, uiLocale))
              .replace("{scanned}", formatNumber(type.scanned, uiLocale))}
          </Text>
        )}
      </InlineStack>

      {measured ? (
        <ProgressBar
          progress={type.coveragePct}
          tone={progressTone(type.coveragePct)}
          size="small"
        />
      ) : (
        <Text as="p" variant="bodySm" tone="subdued">
          {type.known ? h.typeNothingPublishable : h.typeNotScannedHint}
        </Text>
      )}

      {/* A percentage over a capped sample is a different claim from one over
          the whole type, so the bar says which of the two it is. */}
      {measured && type.capped && (
        <Text as="p" variant="bodySm" tone="subdued">
          {h.typeCapped
            .replace("{scanned}", formatNumber(type.scanned, uiLocale))
            .replace("{total}", formatNumber(type.cachedTotal, uiLocale))}
        </Text>
      )}

      {gapLine && (
        <Text as="p" variant="bodySm" tone="subdued">
          {h.fieldGapsTitle}: {gapLine}
        </Text>
      )}
    </BlockStack>
  );
}

function LocaleCoverageCard({
  loc,
  h,
  types,
  uiLocale,
  onOpen,
}: {
  loc: LocaleCoverage;
  h: any;
  types: Record<string, string>;
  uiLocale: string;
  onOpen: (type: HreflangType, id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? loc.missing : loc.missing.slice(0, VISIBLE_MISSING);
  const overallGaps = fieldGapLine(loc.fieldGaps, h, uiLocale);

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h3" variant="headingMd">
              {loc.name} ({loc.locale})
            </Text>
            <Badge tone={scoreTone(loc.coveragePct) as any}>{`${loc.coveragePct}%`}</Badge>
          </InlineStack>
          <Text as="span" variant="bodySm" tone="subdued">
            {h.coverageSummary
              .replace("{translated}", formatNumber(loc.translated, uiLocale))
              .replace("{total}", formatNumber(loc.publishableScanned, uiLocale))}
          </Text>
        </InlineStack>

        <ProgressBar progress={loc.coveragePct} tone={progressTone(loc.coveragePct)} size="small" />

        {overallGaps && (
          <Text as="p" variant="bodySm" tone="subdued">
            {h.fieldGapsTitle}: {overallGaps}
          </Text>
        )}

        <Divider />

        <BlockStack gap="200">
          <Text as="p" variant="bodySm" fontWeight="semibold">
            {h.byTypeTitle}
          </Text>
          {loc.byType.map((type) => (
            <TypeCoverageRow
              key={type.resourceType}
              type={type}
              h={h}
              types={types}
              uiLocale={uiLocale}
            />
          ))}
        </BlockStack>

        <Divider />

        {loc.missingTotal === 0 ? (
          <Text as="p" variant="bodySm" tone="subdued">
            {h.allTranslated}
          </Text>
        ) : (
          <BlockStack gap="200">
            <Text as="p" variant="bodySm" fontWeight="semibold">
              {h.missingTitle.replace("{count}", formatNumber(loc.missingTotal, uiLocale))}
            </Text>
            {visible.map((item) => (
              <InlineStack
                key={`${item.resourceType}:${item.resourceId}`}
                align="space-between"
                blockAlign="center"
                gap="200"
              >
                <BlockStack gap="050">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="span" variant="bodySm" tone="subdued">
                      {types[item.resourceType] || item.resourceType}
                    </Text>
                    <Text as="span" variant="bodyMd" truncate>
                      {item.title || item.resourceId}
                    </Text>
                  </InlineStack>
                  <Text as="span" variant="bodySm" tone="subdued">
                    {h.missingFields.replace(
                      "{fields}",
                      item.missingKeys.map((key) => fieldLabel(h, key)).join(", "),
                    )}
                  </Text>
                </BlockStack>
                <Button variant="plain" onClick={() => onOpen(item.resourceType, item.resourceId)}>
                  {h.translate}
                </Button>
              </InlineStack>
            ))}
            {loc.missing.length > VISIBLE_MISSING && (
              <Button variant="plain" onClick={() => setExpanded((v) => !v)}>
                {expanded
                  ? h.showLess
                  : h.showMore.replace(
                      "{count}",
                      formatNumber(loc.missing.length - VISIBLE_MISSING, uiLocale),
                    )}
              </Button>
            )}
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}
