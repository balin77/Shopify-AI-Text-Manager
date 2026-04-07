/**
 * SettingsPlanTab — plan selection and billing management tab for Settings.
 *
 * Extracted from app.settings.tsx to keep that route file focused on layout.
 */

import { useState } from "react";
import { useRevalidator } from "@remix-run/react";
import {
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Card,
  Divider,
  Button,
  Banner,
} from "@shopify/polaris";
import { PLAN_CONFIG, PLAN_DISPLAY_NAMES, type Plan } from "../config/plans";
import { getNextPlanUpgrade, isApproachingLimit, type ResourceType } from "../utils/planUtils";
import { getAvailablePlans, type BillingPlan } from "../config/billing";
import { SettingsUsageLimitsTab } from "./SettingsUsageLimitsTab";

interface SettingsPlanTabProps {
  subscriptionPlan: string;
  isTestStore: boolean;
  isDevMode: boolean;
  productCount: number;
  localeCount: number;
  collectionCount: number;
  articleCount: number;
  pageCount: number;
  themeTranslationCount: number;
  t: any;
}

export function SettingsPlanTab({
  subscriptionPlan,
  isTestStore,
  isDevMode,
  productCount,
  localeCount,
  collectionCount,
  articleCount,
  pageCount,
  themeTranslationCount,
  t,
}: SettingsPlanTabProps) {
  const revalidator = useRevalidator();
  const [planLoading, setPlanLoading] = useState<string | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const availablePlans = getAvailablePlans();

  const handleSelectPlan = async (plan: BillingPlan) => {
    if (plan === "free") {
      if (window.confirm(t.settings.confirmDowngrade)) {
        setPlanLoading("free");
        setPlanError(null);

        try {
          const response = await fetch("/api/billing/cancel-subscription", { method: "POST" });
          if (!response.ok) throw new Error("Failed to cancel subscription");
          revalidator.revalidate();
          setPlanLoading(null);
        } catch (err) {
          setPlanError(err instanceof Error ? err.message : t.settings.errorOccurred);
          setPlanLoading(null);
        }
      }
      return;
    }

    setPlanLoading(plan);
    setPlanError(null);

    try {
      const response = await fetch("/api/billing/create-subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to create subscription");

      // In development mode, revalidate loaders to refresh plan data
      if (data.directUpdate) {
        revalidator.revalidate();
        setPlanLoading(null);
        return;
      }

      if (data.confirmationUrl) {
        // Must open in top-level window — Shopify billing blocks iframes
        window.open(data.confirmationUrl, "_top");
      }
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : t.settings.errorOccurred);
      setPlanLoading(null);
    }
  };

  const counts: Record<ResourceType, number> = {
    products: productCount,
    locales: localeCount,
    collections: collectionCount,
    articles: articleCount,
    pages: pageCount,
    themeTranslations: themeTranslationCount,
  };
  const hasApproachingLimit = (Object.keys(counts) as ResourceType[]).some((r) =>
    isApproachingLimit(subscriptionPlan as Plan, r, counts[r])
  );
  const nextPlan = getNextPlanUpgrade(subscriptionPlan as Plan);

  return (
    <BlockStack gap="400">
      {/* Pulse animation styles */}
      <style>{`
        @keyframes pulseYellow {
          0%, 100% { box-shadow: 0 0 0 0 rgba(234, 179, 8, 0.7); }
          50% { box-shadow: 0 0 20px 8px rgba(234, 179, 8, 0.4); }
        }
        .plan-card-pulse {
          animation: pulseYellow 2s ease-in-out infinite;
          border: 2px solid #eab308 !important;
          border-radius: 12px;
        }
      `}</style>

      {planError && (
        <Banner tone="critical" title={t.common.error} onDismiss={() => setPlanError(null)}>
          <p>{planError}</p>
        </Banner>
      )}

      {isDevMode && (
        <Banner tone="info" title="Development Mode">
          <p>
            {t.settings?.devModeBanner ||
              "Development-Modus: Alle Pläne sind frei wählbar. Planwechsel werden direkt in der Datenbank gespeichert, ohne die Shopify Billing API zu verwenden."}
          </p>
        </Banner>
      )}

      {isTestStore && !isDevMode && (
        <Banner tone="info" title="Test Store">
          <p>
            This is a development/test store. All plan subscriptions are free and will not be
            charged. You can freely switch between plans for testing purposes.
          </p>
        </Banner>
      )}

      <Text as="h2" variant="headingLg">
        {t.settings.availablePlans}
      </Text>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: "16px",
          alignItems: "stretch",
        }}
      >
        {availablePlans.map(({ id, config }) => {
          const planDetails = PLAN_CONFIG[id];
          const isCurrentPlan = id === subscriptionPlan;
          const price = config ? `€${config.price.toFixed(2)}${t.settings.perMonth}` : t.settings.free;
          const shouldPulse = hasApproachingLimit && nextPlan === id;

          return (
            <div
              key={id}
              className={shouldPulse ? "plan-card-pulse" : ""}
              style={{ display: "flex", flexDirection: "column", height: "100%" }}
            >
              <Card>
                <div
                  style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: "400px" }}
                >
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="start">
                      <Text as="h3" variant="headingMd">
                        {PLAN_DISPLAY_NAMES[id]}
                      </Text>
                      {isCurrentPlan && <Badge tone="success">{t.settings.active}</Badge>}
                    </InlineStack>

                    <Text as="p" variant="headingLg" fontWeight="bold">
                      {price}
                    </Text>

                    <Divider />

                    <BlockStack gap="200">
                      <Text as="p" variant="bodyMd">
                        <strong>{t.settings?.usageLocales || "Sprachen"}:</strong>{" "}
                        {planDetails.maxLocales}
                      </Text>
                      <Text as="p" variant="bodyMd">
                        <strong>{t.settings.images}:</strong>{" "}
                        {planDetails.productImages === "all"
                          ? t.settings.allImages
                          : t.settings.featuredImageOnly}
                      </Text>
                      <Text as="p" variant="bodyMd">
                        <strong>{t.settings.contentTypes}:</strong>
                      </Text>
                      <BlockStack gap="100">
                        {planDetails.contentTypes.map((type) => {
                          const getLimitText = () => {
                            switch (type) {
                              case "products":
                                return planDetails.maxProducts === Infinity
                                  ? t.settings.unlimited
                                  : planDetails.maxProducts.toLocaleString();
                              case "collections":
                                return planDetails.maxCollections.toLocaleString();
                              case "articles":
                                return planDetails.maxArticles.toLocaleString();
                              case "pages":
                                return planDetails.maxPages.toLocaleString();
                              case "templates":
                                return planDetails.maxThemeTranslations === 0
                                  ? "—"
                                  : planDetails.maxThemeTranslations.toLocaleString();
                              default:
                                return null;
                            }
                          };

                          const limit = getLimitText();
                          let note = limit ? ` (${limit})` : "";
                          if (type === "menus") {
                            note = ` (${t.settings.readOnly || "read-only"})`;
                          }

                          return (
                            <Text key={type} as="p" variant="bodySm" tone="success">
                              ✓ {type}{note}
                            </Text>
                          );
                        })}
                      </BlockStack>
                    </BlockStack>
                  </BlockStack>

                  <div style={{ marginTop: "auto", paddingTop: "16px" }}>
                    <Button
                      variant={isCurrentPlan ? "secondary" : "primary"}
                      disabled={isCurrentPlan || planLoading !== null}
                      loading={planLoading === id}
                      onClick={() => handleSelectPlan(id)}
                      fullWidth
                    >
                      {isCurrentPlan
                        ? t.settings.currentPlanButton
                        : (() => {
                            const planHierarchy: BillingPlan[] = ["free", "basic", "pro", "max"];
                            const currentIndex = planHierarchy.indexOf(subscriptionPlan as BillingPlan);
                            const targetIndex = planHierarchy.indexOf(id);
                            return targetIndex < currentIndex
                              ? t.settings.downgrade
                              : t.settings.upgrade || "Upgrade";
                          })()}
                    </Button>
                  </div>
                </div>
              </Card>
            </div>
          );
        })}
      </div>

      {/* Trial info for free plan users */}
      {subscriptionPlan === "free" && (
        <Banner tone="info">
          <Text as="p">
            {t.settings?.trialInfo ||
              "Alle kostenpflichtigen Pläne beinhalten eine 7-tägige kostenlose Testphase. Sie werden erst nach Ablauf der Testphase belastet."}
          </Text>
        </Banner>
      )}

      {/* Usage & Limits */}
      <SettingsUsageLimitsTab
        productCount={productCount}
        localeCount={localeCount}
        collectionCount={collectionCount}
        articleCount={articleCount}
        pageCount={pageCount}
        themeTranslationCount={themeTranslationCount}
        t={t}
        hideUpgradeCard
      />

      <Card>
        <BlockStack gap="200">
          <Text as="h3" variant="headingMd">
            {t.settings.planNotes}
          </Text>
          <Text as="p" variant="bodyMd" tone="subdued">
            • {t.settings.planNote1}
          </Text>
          <Text as="p" variant="bodyMd" tone="subdued">
            • {t.settings.planNote2}
          </Text>
          <Text as="p" variant="bodyMd" tone="subdued">
            • {t.settings.planNote3}
          </Text>
          <Text as="p" variant="bodyMd" tone="subdued">
            • {t.settings.planNote4}
          </Text>
        </BlockStack>
      </Card>
    </BlockStack>
  );
}
