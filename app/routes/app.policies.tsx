/**
 * Policies Page - UNIFIED VERSION
 *
 * Migrated to use the unified content editor system.
 * Compare to app.policies.old.tsx - we went from ~605 lines to ~175 lines (71% reduction!)
 *
 * Note: Policies only have a "body" field that's editable. The title is read-only
 * and set automatically by Shopify based on the policy type.
 */

import { data as json, type LoaderFunctionArgs, type ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useRevalidator } from "react-router";
import { Text, BlockStack, Card } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { UnifiedContentEditor } from "../components/UnifiedContentEditor";
import { useUnifiedContentEditor } from "../hooks/useUnifiedContentEditor";
import { handleUnifiedContentActions } from "../actions/unified-content.actions";
import { POLICIES_CONFIG } from "../config/content-fields.config";
import { useI18n } from "../contexts/I18nContext";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { PlanAccessGate } from "../components/PlanAccessGate";
import { useEffect } from "react";
import type { ContentItem } from "../types/content-editor.types";
import { measurePageLoad } from "~/utils/performance.client";
import { logger } from "~/utils/logger.server";
import type { FetcherData } from "~/types/content-editor.types";

// ============================================================================
// LOADER - Load data from database
// ============================================================================

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  try {
    const { db } = await import("../db.server");
    const { loadAISettingsForValidation } = await import("../utils/loader-helpers");
    const { ShopifyContentService } = await import("../../src/services/shopify-content.service");
    const { buildMarketTranslations } = await import("../utils/market-translations.server");

    // Load shopLocales and policies from Shopify in parallel
    const [localesResponse, policiesResponse, aiSettings, marketsResult] = await Promise.all([
      admin.graphql(
        `#graphql
          query getShopLocales {
            shopLocales {
              locale
              name
              primary
              published
            }
          }`
      ),
      // Load policies directly from Shopify (not from DB)
      // This reduces database storage for multi-tenant SaaS
      admin.graphql(
        `#graphql
          query getShopPolicies {
            shop {
              shopPolicies {
                id
                type
                title
                body
                url
              }
            }
          }`
      ),
      loadAISettingsForValidation(db, session.shop),
      new ShopifyContentService(admin as never).loadMarkets(),
    ]);

    const markets = marketsResult.markets;

    const localesData = await localesResponse.json();
    const shopLocales = localesData.data?.shopLocales || [];
    const primaryLocale = shopLocales.find((l: any) => l.primary)?.locale || "en";

    const policiesData = await policiesResponse.json();
    const policies = policiesData.data?.shop?.shopPolicies || [];

    // Fetch translations scoped to this shop's policy IDs
    const policyIds = policies.map((p: any) => p.id);
    const allTranslations = await db.contentTranslation.findMany({
      where: { shop: session.shop, resourceType: 'ShopPolicy', resourceId: { in: policyIds } }
    });

    // Group translations by resourceId. Global rows (marketId "") feed the
    // per-item `translations` array; market-specific rows (marketId !== "") are
    // surfaced separately so resolve() can layer them over the global values.
    const translationsByResource = allTranslations.reduce((acc: Record<string, any[]>, trans) => {
      if ((trans.marketId ?? "") !== "") return acc;
      if (!acc[trans.resourceId]) {
        acc[trans.resourceId] = [];
      }
      acc[trans.resourceId].push(trans);
      return acc;
    }, {});
    const marketRowsByResource = allTranslations.reduce((acc: Record<string, any[]>, trans) => {
      if ((trans.marketId ?? "") === "") return acc;
      if (!acc[trans.resourceId]) {
        acc[trans.resourceId] = [];
      }
      acc[trans.resourceId].push(trans);
      return acc;
    }, {});

    // Transform policies (data from Shopify, translations from DB)
    const transformedPolicies = policies.map((p: any) => ({
      id: p.id,
      title: p.title,
      body: p.body,
      type: p.type,
      url: p.url,
      translations: translationsByResource[p.id] || [],
      marketTranslations: buildMarketTranslations(marketRowsByResource[p.id] || []),
    }));

    return json({
      policies: transformedPolicies,
      shop: session.shop,
      shopLocales,
      primaryLocale,
      markets,
      error: null,
      aiSettings,
    });
  } catch (error: unknown) {
    if (error instanceof Response) throw error;
    logger.error("[POLICIES-LOADER] Error", { error: error instanceof Error ? error.message : String(error) });
    return json({
      policies: [],
      shop: session.shop,
      shopLocales: [],
      primaryLocale: "en",
      markets: [],
      error: "Failed to load policies",
      aiSettings: null,
    }, { status: 500 });
  }
};

// ============================================================================
// ACTION - Handle all actions via unified handler
// ============================================================================

export const action = async (args: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(args.request);
  const formData = await args.request.formData();

  // Load AI settings
  const { db } = await import("../db.server");
  const [aiSettings, aiInstructions] = await Promise.all([
    db.aISettings.findUnique({ where: { shop: session.shop } }),
    db.aIInstructions.findUnique({ where: { shop: session.shop } }),
  ]);

  // Use unified action handler (encryption is handled automatically)
  return handleUnifiedContentActions({
    admin,
    session,
    formData,
    contentConfig: POLICIES_CONFIG,
    db,
    aiSettings,
    aiInstructions,
  });
};

// ============================================================================
// COMPONENT - Just configuration, no logic!
// ============================================================================

// Helper function for policy type names
function getPolicyTypeName(type: string, t: any) {
  const typeMap: Record<string, string> = {
    'CONTACT_INFORMATION': t.content?.policyTypes?.contactInformation || 'Kontaktinformationen',
    'LEGAL_NOTICE': t.content?.policyTypes?.legalNotice || 'Impressum',
    'PRIVACY_POLICY': t.content?.policyTypes?.privacyPolicy || 'Datenschutzerklärung',
    'REFUND_POLICY': t.content?.policyTypes?.refundPolicy || 'Rückerstattungsrichtlinie',
    'SHIPPING_POLICY': t.content?.policyTypes?.shippingPolicy || 'Versandrichtlinie',
    'TERMS_OF_SERVICE': t.content?.policyTypes?.termsOfService || 'Nutzungsbedingungen',
    'TERMS_OF_SALE': t.content?.policyTypes?.termsOfSale || 'Verkaufsbedingungen',
    'SUBSCRIPTION_POLICY': t.content?.policyTypes?.subscriptionPolicy || 'Abonnementrichtlinie',
  };
  return typeMap[type] || type;
}

export default function PoliciesPage() {
  const { policies, shopLocales, primaryLocale, markets, error, aiSettings } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<FetcherData>();
  const revalidator = useRevalidator();
  const { t } = useI18n();
  const { showInfoBox } = useInfoBox();

  // Initialize unified content editor
  const editor = useUnifiedContentEditor({
    config: POLICIES_CONFIG,
    items: policies as ContentItem[],
    shopLocales,
    primaryLocale,
    markets,
    fetcher,
    showInfoBox,
    t,
  });

  // Show loader error
  useEffect(() => {
    if (error) {
      showInfoBox(error, "critical", t.content?.error || "Error");
    }
  }, [error, showInfoBox, t]);

  // Measure page load performance
  useEffect(() => {
    measurePageLoad('PoliciesPage', {
      policyCount: policies.length,
    });
  }, [policies]);

  // Custom render for policy list items (show type as subtitle)
  const renderListItem = (item: any, isSelected: boolean) => {
    return (
      <BlockStack gap="100">
        <Text as="p" variant="bodyMd" fontWeight={isSelected ? "bold" : "regular"}>
          {item.title || getPolicyTypeName(item.type, t)}
        </Text>
        <Text as="p" variant="bodySm" tone="subdued">
          {getPolicyTypeName(item.type, t)}
        </Text>
      </BlockStack>
    );
  };

  return (
    <PlanAccessGate contentType="policies">
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        <UnifiedContentEditor
          config={POLICIES_CONFIG}
          items={policies}
          shopLocales={shopLocales}
          primaryLocale={primaryLocale}
          editor={editor}
          fetcherState={fetcher.state}
          fetcherFormData={fetcher.formData}
          t={t}
          renderListItem={renderListItem}
          revalidator={revalidator}
          sortOptions={[
            { field: "title", label: "Title" },
          ]}
        />
      </div>
    </div>
    </PlanAccessGate>
  );
}
