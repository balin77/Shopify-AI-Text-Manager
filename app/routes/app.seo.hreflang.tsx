/**
 * hreflang audit section (SEO_TAB_IMPLEMENTATION_PLAN.md Phase 4 / A5).
 *
 * Read-only audit: per published secondary locale, how much of the publishable
 * catalog is actually translated (so the native hreflang alternates point at
 * real translations, not identical content). Missing items deep-link into the
 * editor (?select=<GID>) where the merchant can translate them.
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
import { useState } from "react";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { SeoSectionLayout } from "../components/seo/SeoSectionLayout";
import { scoreTone } from "../utils/seo-score";
import { analyzeHreflang, type HreflangType } from "../services/seo/hreflang.service";

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
  const { t } = useI18n();
  const { handleNavigate } = useAppNavigation();
  const h = (t.seo as any).hreflangPage;

  const openInEditor = (type: HreflangType, id: string) => {
    handleNavigate(TYPE_PATH[type], { searchParams: new URLSearchParams({ select: id }) });
  };

  return (
    <SeoSectionLayout sectionId="hreflang">
      <BlockStack gap="400">
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

        {result.capped && <Banner tone="info">{h.cappedNote}</Banner>}

        {result.localesUnavailable ? (
          <Card>
            <div style={{ padding: "1rem" }}>
              <Text as="p" tone="subdued">
                {h.localesUnavailable}
              </Text>
            </div>
          </Card>
        ) : (
          result.coverage.map((loc) => (
            <LocaleCoverageCard
              key={loc.locale}
              loc={loc}
              h={h}
              types={(t.seo as any).dashboard.types}
              onOpen={openInEditor}
            />
          ))
        )}
      </BlockStack>
    </SeoSectionLayout>
  );
}

function LocaleCoverageCard({
  loc,
  h,
  types,
  onOpen,
}: {
  loc: {
    locale: string;
    name: string;
    translated: number;
    publishableScanned: number;
    coveragePct: number;
    missing: Array<{ resourceType: HreflangType; resourceId: string; title: string }>;
    missingTotal: number;
  };
  h: any;
  types: Record<string, string>;
  onOpen: (type: HreflangType, id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? loc.missing : loc.missing.slice(0, VISIBLE_MISSING);

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
              .replace("{translated}", String(loc.translated))
              .replace("{total}", String(loc.publishableScanned))}
          </Text>
        </InlineStack>

        <ProgressBar progress={loc.coveragePct} tone={scoreTone(loc.coveragePct) as any} size="small" />

        {loc.missingTotal === 0 ? (
          <Text as="p" variant="bodySm" tone="subdued">
            {h.allTranslated}
          </Text>
        ) : (
          <BlockStack gap="200">
            <Text as="p" variant="bodySm" fontWeight="semibold">
              {h.missingTitle.replace("{count}", String(loc.missingTotal))}
            </Text>
            {visible.map((item) => (
              <InlineStack key={`${item.resourceType}:${item.resourceId}`} align="space-between" blockAlign="center">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="span" variant="bodySm" tone="subdued">
                    {types[item.resourceType] || item.resourceType}
                  </Text>
                  <Text as="span" variant="bodyMd" truncate>
                    {item.title || item.resourceId}
                  </Text>
                </InlineStack>
                <Button variant="plain" onClick={() => onOpen(item.resourceType, item.resourceId)}>
                  {h.translate}
                </Button>
              </InlineStack>
            ))}
            {loc.missing.length > VISIBLE_MISSING && (
              <Button variant="plain" onClick={() => setExpanded((v) => !v)}>
                {expanded ? h.showLess : h.showMore.replace("{count}", String(loc.missing.length - VISIBLE_MISSING))}
              </Button>
            )}
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}
