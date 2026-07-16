/**
 * Translation SEO section — locale-aware coverage (title, SEO title, meta
 * description) for the ONE secondary locale the merchant picks via
 * ?auditLocale=. Deep-links to the editor reuse the ?select=<GID> pattern
 * shared with the overview and hreflang pages; the editor understands no
 * locale param yet, so the merchant switches languages there manually.
 *
 * Extracted out of the SEO overview into its own sub-tab so it lives beside
 * hreflang (the other translation-oriented audit) instead of buried at the
 * bottom of the dashboard.
 */

import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { useState } from "react";
import {
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  ProgressBar,
  Banner,
  Select,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { SeoSectionLayout } from "../components/seo/SeoSectionLayout";
import { progressTone } from "../utils/seo-score";
import {
  analyzeLocale,
  LOCALE_AUDIT_FIELDS,
  type AuditType,
  type LocaleAudit,
  type LocaleAuditField,
  type LocaleMissingItemRef,
} from "../services/seo/audit.service";
import { getCachedShopLocales } from "../utils/shop-locales-cache.server";
import type { Plan } from "../config/plans";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");

  const settings = await db.aISettings.findUnique({
    where: { shop: session.shop },
    select: { subscriptionPlan: true },
  });
  const plan = (settings?.subscriptionPlan || "free") as Plan;

  const shopLocales = await getCachedShopLocales(admin, session.shop);
  const secondaryLocales: { locale: string; name: string }[] = shopLocales
    .filter((l: any) => l.published && !l.primary)
    .map((l: any) => ({ locale: String(l.locale), name: String(l.name) }));

  const requestedAuditLocale = new URL(request.url).searchParams.get("auditLocale") || "";
  let auditLocale: string | null = null;
  let localeAudit: LocaleAudit | null = null;
  if (requestedAuditLocale && secondaryLocales.some((l) => l.locale === requestedAuditLocale)) {
    auditLocale = requestedAuditLocale;
    localeAudit = await analyzeLocale(session.shop, requestedAuditLocale, { db, plan });
  }

  return json({ secondaryLocales, auditLocale, localeAudit });
};

const TYPE_PATH: Record<AuditType, string> = {
  product: "/app/products",
  collection: "/app/collections",
  article: "/app/blog",
  page: "/app/pages",
};

/** How many merged missing-item rows to show before "show more" — mirrors
 * app.seo.hreflang.tsx's VISIBLE_MISSING. */
const VISIBLE_LOCALE_MISSING = 10;

interface MergedMissingRow {
  type: AuditType;
  id: string;
  title: string;
  missingFields: LocaleAuditField[];
}

/** Merge the three independent per-field missing-item lists into one row per
 * item, so the UI shows a single "here's what's missing" list instead of
 * three overlapping ones. Purely a display concern — the service keeps
 * per-field lists because that's what the coverage math needs. */
function mergeMissingRows(totals: LocaleAudit["totals"]): MergedMissingRow[] {
  const byKey = new Map<string, MergedMissingRow>();
  for (const field of LOCALE_AUDIT_FIELDS) {
    for (const item of totals[field].missing as LocaleMissingItemRef[]) {
      const key = `${item.type}:${item.id}`;
      let row = byKey.get(key);
      if (!row) {
        row = { type: item.type, id: item.id, title: item.title, missingFields: [] };
        byKey.set(key, row);
      }
      row.missingFields.push(field);
    }
  }
  return [...byKey.values()].sort(
    (a, b) => b.missingFields.length - a.missingFields.length || a.title.localeCompare(b.title),
  );
}

export default function SeoTranslations() {
  const { secondaryLocales, auditLocale, localeAudit } = useLoaderData<typeof loader>();
  const { t } = useI18n();
  const { handleNavigate } = useAppNavigation();
  const d = t.seo.dashboard.translationSeo;
  const types = t.seo.dashboard.types;
  const cappedNoteTemplate = t.seo.dashboard.cappedNote;
  const openInEditorLabel = t.seo.dashboard.openInEditor;

  const [expanded, setExpanded] = useState(false);

  // Locale-picker change replaces the current history entry (no back-button
  // stop per selection) and keeps every other param (shop/host/embedded, …)
  // via useAppNavigation's merge. Empty value clears the selection.
  const onLocaleChange = (locale: string) => {
    handleNavigate("/app/seo/translations", {
      searchParams: new URLSearchParams({ auditLocale: locale }),
      replace: true,
    });
  };

  const openInEditor = (type: AuditType, id: string) => {
    handleNavigate(TYPE_PATH[type], { searchParams: new URLSearchParams({ select: id }) });
  };

  if (secondaryLocales.length === 0) {
    return (
      <SeoSectionLayout sectionId="translationSeo">
        <Card>
          <div style={{ padding: "1rem" }}>
            <Text as="p" tone="subdued">
              {d.noSecondaryLocales}
            </Text>
          </div>
        </Card>
      </SeoSectionLayout>
    );
  }

  const options = [
    { label: d.localePlaceholder, value: "" },
    ...secondaryLocales.map((l) => ({ label: `${l.name} (${l.locale})`, value: l.locale })),
  ];

  const mergedMissing = localeAudit ? mergeMissingRows(localeAudit.totals) : [];
  const visibleMissing = expanded ? mergedMissing : mergedMissing.slice(0, VISIBLE_LOCALE_MISSING);

  return (
    <SeoSectionLayout sectionId="translationSeo">
      <Card>
        <BlockStack gap="300">
          <div style={{ maxWidth: "320px" }}>
            <Select
              label={d.localeLabel}
              labelHidden
              options={options}
              value={auditLocale ?? ""}
              onChange={onLocaleChange}
            />
          </div>

          {!localeAudit ? (
            <Text as="p" variant="bodySm" tone="subdued">
              {d.chooseLocaleHint}
            </Text>
          ) : (
            <BlockStack gap="300">
              {localeAudit.capped && (
                <Banner tone="info">
                  {cappedNoteTemplate
                    .replace("{scanned}", String(localeAudit.totalItems))
                    .replace("{total}", String(localeAudit.totalAvailable))}
                </Banner>
              )}

              {LOCALE_AUDIT_FIELDS.map((field) => {
                const coverage = localeAudit.totals[field];
                return (
                  <InlineStack key={field} gap="300" blockAlign="center">
                    <div style={{ width: "140px" }}>
                      <Text as="span" variant="bodyMd">
                        {d.fields[field]}
                      </Text>
                    </div>
                    <div style={{ flex: 1, minWidth: "120px" }}>
                      <ProgressBar
                        progress={coverage.coveragePct}
                        tone={progressTone(coverage.coveragePct)}
                        size="small"
                      />
                    </div>
                    <div style={{ minWidth: "130px", textAlign: "right" }}>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {coverage.missingTotal === 0
                          ? d.allTranslated
                          : d.missingCount
                              .replace("{count}", String(coverage.missingTotal))
                              .replace("{total}", String(coverage.total))}
                      </Text>
                    </div>
                  </InlineStack>
                );
              })}

              {mergedMissing.length > 0 && (
                <BlockStack gap="200">
                  <Text as="p" variant="bodySm" fontWeight="semibold">
                    {d.missingItemsTitle.replace("{count}", String(mergedMissing.length))}
                  </Text>
                  {visibleMissing.map((row) => (
                    <InlineStack
                      key={`${row.type}:${row.id}`}
                      align="space-between"
                      blockAlign="center"
                    >
                      <InlineStack gap="200" blockAlign="center">
                        <Text as="span" variant="bodySm" tone="subdued">
                          {types[row.type] || row.type}
                        </Text>
                        <Text as="span" variant="bodyMd" truncate>
                          {row.title || row.id}
                        </Text>
                        <Text as="span" variant="bodySm" tone="subdued">
                          ({row.missingFields.map((f) => d.fields[f]).join(", ")})
                        </Text>
                      </InlineStack>
                      <Button variant="plain" onClick={() => openInEditor(row.type, row.id)}>
                        {openInEditorLabel}
                      </Button>
                    </InlineStack>
                  ))}
                  {mergedMissing.length > VISIBLE_LOCALE_MISSING && (
                    <Button variant="plain" onClick={() => setExpanded((v) => !v)}>
                      {expanded
                        ? d.showLess
                        : d.showMore.replace(
                            "{count}",
                            String(mergedMissing.length - VISIBLE_LOCALE_MISSING),
                          )}
                    </Button>
                  )}
                </BlockStack>
              )}
            </BlockStack>
          )}
        </BlockStack>
      </Card>
    </SeoSectionLayout>
  );
}
