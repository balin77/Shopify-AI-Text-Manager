/**
 * Policies Page - UNIFIED VERSION
 *
 * Migrated to use the unified content editor system.
 * Compare to app.policies.old.tsx - we went from ~605 lines to ~175 lines (71% reduction!)
 *
 * Note: Policies only have a "body" field that's editable. The title is read-only
 * and set automatically by Shopify based on the policy type.
 */

import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { Text, BlockStack, Card } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { MainNavigation } from "../components/MainNavigation";
import { ContentTypeNavigation } from "../components/ContentTypeNavigation";
import { UnifiedContentEditor } from "../components/UnifiedContentEditor";
import { useUnifiedContentEditor } from "../hooks/useUnifiedContentEditor";
import { handleUnifiedContentActions } from "../actions/unified-content.actions";
import { POLICIES_CONFIG } from "../config/content-fields.config";
import { useI18n } from "../contexts/I18nContext";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { useEffect } from "react";

// ============================================================================
// LOADER - Load data from database
// ============================================================================

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  try {
    const { db } = await import("../db.server");

    // Load shopLocales
    const localesResponse = await admin.graphql(
      `#graphql
        query getShopLocales {
          shopLocales {
            locale
            name
            primary
            published
          }
        }`
    );

    const localesData = await localesResponse.json();
    const shopLocales = localesData.data?.shopLocales || [];
    const primaryLocale = shopLocales.find((l: any) => l.primary)?.locale || "de";

    // Load policies from database (synced by background sync)
    const [policies, allTranslations] = await Promise.all([
      db.shopPolicy.findMany({
        where: { shop: session.shop },
        orderBy: { type: 'asc' },
      }),
      db.contentTranslation.findMany({
        where: { resourceType: 'ShopPolicy' }
      }),
    ]);

    // Group translations by resourceId
    const translationsByResource = allTranslations.reduce((acc: Record<string, any[]>, trans) => {
      if (!acc[trans.resourceId]) {
        acc[trans.resourceId] = [];
      }
      acc[trans.resourceId].push(trans);
      return acc;
    }, {});

    // Transform policies with translations
    const transformedPolicies = policies.map(p => ({
      id: p.id,
      title: p.title,
      body: p.body,
      type: p.type,
      url: p.url,
      translations: translationsByResource[p.id] || [],
    }));

    return json({
      policies: transformedPolicies,
      shop: session.shop,
      shopLocales,
      primaryLocale,
      error: null
    });
  } catch (error: any) {
    console.error("[POLICIES-LOADER] Error:", error);
    return json({
      policies: [],
      shop: session.shop,
      shopLocales: [],
      primaryLocale: "de",
      error: error.message
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
  const { policies, shopLocales, primaryLocale, error } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const { t } = useI18n();
  const { showInfoBox } = useInfoBox();

  // Initialize unified content editor
  const editor = useUnifiedContentEditor({
    config: POLICIES_CONFIG,
    items: policies,
    shopLocales,
    primaryLocale,
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
    <>
      <MainNavigation />
      <ContentTypeNavigation />
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
      />
    </>
  );
}
