/**
 * SettingsPlanTab — plan selection and billing management tab for Settings.
 *
 * Extracted from app.settings.tsx to keep that route file focused on layout.
 */

import { useState, type ReactNode } from "react";
import { useRevalidator } from "react-router";
import {
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Card,
  Divider,
  Button,
  Banner,
  Modal,
} from "@shopify/polaris";
import { PLAN_CONFIG, PLAN_DISPLAY_NAMES, type Plan } from "../config/plans";
import {
  getNextPlanUpgrade,
  getMinimumPlanForSeoFeature,
  isApproachingLimit,
  type ResourceType,
} from "../utils/planUtils";
import { contentTypeLimit, getPlanCardHighlights } from "../utils/planDiff";
import { getAvailablePlans, type BillingPlan } from "../config/billing";
import { useI18n } from "../contexts/I18nContext";
import { formatNumber } from "../utils/format";
import { SettingsUsageLimitsTab } from "./SettingsUsageLimitsTab";

/**
 * Wraps a plan-card value in <strong> when the row differs from the tier below.
 * The row LABEL is already bold, so only the value changes weight — the same
 * treatment the WebP-concurrency row had before this became a general rule.
 */
function PlanValue({ highlight, children }: { highlight: boolean; children: ReactNode }) {
  return highlight ? <strong>{children}</strong> : <>{children}</>;
}

interface SettingsPlanTabProps {
  subscriptionPlan: string;
  inTrial: boolean;
  trialRemainingDays: number;
  isTestStore: boolean;
  /**
   * Non-null when Shopify billing is bypassed for this shop (dev/custom-app
   * build or an allow-listed test-billing shop). Drives the "switching plans
   * is free" notice above the plan grid.
   */
  devPlanMode: "override" | "test-billing" | null;
  productCount: number;
  localeCount: number;
  collectionCount: number;
  articleCount: number;
  pageCount: number;
  themeTranslationCount: number;
  imageOperationCount: number;
  t: any;
}

export function SettingsPlanTab({
  subscriptionPlan,
  inTrial,
  trialRemainingDays,
  isTestStore,
  devPlanMode,
  productCount,
  localeCount,
  collectionCount,
  articleCount,
  pageCount,
  themeTranslationCount,
  imageOperationCount,
  t,
}: SettingsPlanTabProps) {
  const revalidator = useRevalidator();
  const { locale } = useI18n(); // R4-UX6: locale-aware number grouping
  const [planLoading, setPlanLoading] = useState<string | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  // R4-UX7: native window.confirm is a focus trap inside the embedded admin
  // iframe, isn't Polaris, and the browser's "prevent additional dialogs"
  // option silently bypasses it → a downgrade with NO confirmation. Use a
  // Polaris Modal (same pattern as the image-delete confirm).
  const [downgradeConfirmOpen, setDowngradeConfirmOpen] = useState(false);
  const availablePlans = getAvailablePlans();

  const performDowngrade = async () => {
    setDowngradeConfirmOpen(false);
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
  };

  const handleSelectPlan = async (plan: BillingPlan) => {
    if (plan === "free") {
      setDowngradeConfirmOpen(true);
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
  // Tier named in the SEO upsell note on locked cards — derived from
  // PLAN_CONFIG, so re-tiering Search Console rewrites the copy by itself.
  const seoUpsellPlan = getMinimumPlanForSeoFeature("searchConsole");

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
        /* Equal-height plan cards: the grid stretches each cell to the tallest
           row, but the Polaris Card inside only takes its content height.
           Force the Card chrome (root + padding box) to fill the cell so every
           card matches the largest one. */
        .plan-card-cell > div { flex: 1 1 auto; display: flex; flex-direction: column; }
        .plan-card-cell > div > div { flex: 1 1 auto; display: flex; flex-direction: column; }
      `}</style>

      {planError && (
        <Banner tone="critical" title={t.common.error} onDismiss={() => setPlanError(null)}>
          <p>{planError}</p>
        </Banner>
      )}

      {isTestStore && (
        <Banner tone="info" title="Test Store">
          <p>
            This is a development/test store. All plan subscriptions are free and will not be
            charged. You can freely switch between plans for testing purposes.
          </p>
        </Banner>
      )}

      {devPlanMode && (
        <Banner tone="success" title={t.settings?.devPlanFreeTitle || "Switching plans is free"}>
          <p>
            {t.settings?.devPlanFreeMessage ||
              "Billing is disabled for this shop. You can switch between any of the plans below freely, with no charge."}
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
          // Bold whatever this tier adds over the card below it — new rows and
          // rows whose number changed. Derived from PLAN_CONFIG in planDiff.ts,
          // never from thresholds written into this file.
          const highlights = getPlanCardHighlights(id);
          const isCurrentPlan = id === subscriptionPlan;
          const price = config ? `€${config.price.toFixed(2)}${t.settings.perMonth}` : t.settings.free;
          const shouldPulse = hasApproachingLimit && nextPlan === id;

          return (
            <div
              key={id}
              className={`plan-card-cell${shouldPulse ? " plan-card-pulse" : ""}`}
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
                        <PlanValue highlight={highlights.rows.locales}>
                          {planDetails.maxLocales === Infinity
                            ? t.settings.unlimited
                            : planDetails.maxLocales}
                        </PlanValue>
                      </Text>
                      <Text as="p" variant="bodyMd">
                        <strong>{t.settings.images}:</strong>{" "}
                        <PlanValue highlight={highlights.rows.images}>
                          {planDetails.productImages === "all"
                            ? t.settings.allImages
                            : t.settings.featuredImageOnly}
                        </PlanValue>
                      </Text>
                      {/* WebP conversion only ever runs inside the Pro+ image
                          suite (variantImageManager) and is hard-gated by the
                          monthlyImageOperations quota (0 on Free/Basic → the
                          /api/convert-webp route fails closed). Showing a
                          "2 parallel" concurrency value on Free/Basic was
                          misleading — the feature is unreachable there. Gate
                          the row on the same flag that unlocks the suite. */}
                      {planDetails.variantImageManager && (
                        <Text as="p" variant="bodyMd">
                          <strong>{t.settings.webpConversion}:</strong>{" "}
                          <PlanValue highlight={highlights.rows.webpConversion}>
                            {t.settings.webpConversionParallel.replace(
                              "{count}",
                              String(planDetails.maxConcurrentWebpConversions),
                            )}
                            {/* "2× faster" only where the number actually went
                                UP — not merely where the row is new. */}
                            {highlights.webpFasterThanPrevious
                              ? ` (${t.settings.webpConversionFaster})`
                              : ""}
                          </PlanValue>
                        </Text>
                      )}
                      {planDetails.monthlyImageOperations > 0 && (
                        <Text as="p" variant="bodyMd">
                          <strong>{t.settings.monthlyImageOperations}:</strong>{" "}
                          <PlanValue highlight={highlights.rows.imageOperations}>
                            {formatNumber(planDetails.monthlyImageOperations, locale)}
                          </PlanValue>
                        </Text>
                      )}
                      <Text as="p" variant="bodyMd">
                        <strong>{t.settings.contentTypes}:</strong>
                      </Text>
                      <BlockStack gap="100">
                        {planDetails.contentTypes.map((type) => {
                          // The numbers come from planDiff.contentTypeLimit, the
                          // same reader the highlight comparison uses — the two
                          // cannot drift apart into "bold, but same number".
                          const rawLimit = contentTypeLimit(planDetails, type);
                          const limit =
                            rawLimit === null
                              ? null
                              : rawLimit === Infinity
                                ? t.settings.unlimited
                                : rawLimit === 0
                                  ? "—"
                                  : formatNumber(rawLimit, locale);
                          let note = limit ? ` (${limit})` : "";
                          if (type === "menus") {
                            note = ` (${t.settings.readOnly || "read-only"})`;
                          }

                          return (
                            <Text
                              key={type}
                              as="p"
                              variant="bodySm"
                              tone="success"
                              fontWeight={highlights.contentTypes.has(type) ? "bold" : undefined}
                            >
                              ✓ {type}{note}
                            </Text>
                          );
                        })}
                      </BlockStack>

                      <Text as="p" variant="bodyMd">
                        <strong>{t.settings.imageFeaturesTitle}:</strong>
                      </Text>
                      <BlockStack gap="100">
                        {planDetails.variantImageManager ? (
                          [
                            t.settings.featureImageManager,
                            t.settings.featureVariantGallery,
                            t.settings.featureSkuGenerator,
                            t.settings.featureBulkAltText,
                            t.settings.featureBulkImageUpload,
                          ].map((label) => (
                            <Text
                              key={label}
                              as="p"
                              variant="bodySm"
                              tone="success"
                              fontWeight={highlights.rows.imageTools ? "bold" : undefined}
                            >
                              ✓ {label}
                            </Text>
                          ))
                        ) : (
                          // Free + Basic differ in what they actually offer for
                          // images: Free shows only the featured image, Basic
                          // shows ALL product images and lets the merchant
                          // generate alt text via AI. The shared "native gallery
                          // only" copy that used to live here was wrong on both
                          // counts (it's the app's own simple gallery, and Basic
                          // does more than Free) — see plans.ts `productImages`.
                          <>
                            <Text
                              as="p"
                              variant="bodySm"
                              tone="success"
                              fontWeight={highlights.rows.imageTools ? "bold" : undefined}
                            >
                              ✓{" "}
                              {planDetails.productImages === "all"
                                ? t.settings.featureBasicImages
                                : t.settings.featureFreeImages}
                            </Text>
                            <Text as="p" variant="bodySm" tone="subdued">
                              {t.settings.featureImagesProNote}
                            </Text>
                          </>
                        )}
                      </BlockStack>

                      {/* SEO tools. Same reading order as the image block: what
                          every tier gets first, then the paid unlocks. Bolding
                          follows the card-wide rule (planDiff.ts) — the audit
                          line is identical on every tier and therefore never
                          bold. Values come from PLAN_CONFIG[].seo — never
                          hardcode them here. */}
                      <Text as="p" variant="bodyMd">
                        <strong>{t.settings.seoFeaturesTitle}:</strong>
                      </Text>
                      <BlockStack gap="100">
                        <Text as="p" variant="bodySm" tone="success">
                          ✓ {t.settings.seoFeatureAudit}
                        </Text>
                        <Text
                          as="p"
                          variant="bodySm"
                          tone="success"
                          fontWeight={highlights.rows.seoBulkBatch ? "bold" : undefined}
                        >
                          ✓{" "}
                          {t.settings.seoFeatureBulkBatch.replace(
                            "{count}",
                            formatNumber(planDetails.seo.bulkBatchSize, locale),
                          )}
                        </Text>
                        {planDetails.seo.maxTrackedKeywords > 0 && (
                          <Text
                            as="p"
                            variant="bodySm"
                            tone="success"
                            fontWeight={highlights.rows.seoKeywords ? "bold" : undefined}
                          >
                            ✓{" "}
                            {t.settings.seoFeatureKeywords.replace(
                              "{count}",
                              formatNumber(planDetails.seo.maxTrackedKeywords, locale),
                            )}
                          </Text>
                        )}
                        {planDetails.seo.scoreHistoryDays > 0 && (
                          <Text
                            as="p"
                            variant="bodySm"
                            tone="success"
                            fontWeight={highlights.rows.seoScoreHistory ? "bold" : undefined}
                          >
                            ✓{" "}
                            {t.settings.seoFeatureScoreHistory.replace(
                              "{days}",
                              formatNumber(planDetails.seo.scoreHistoryDays, locale),
                            )}
                          </Text>
                        )}
                        {planDetails.seo.gscProperties > 0 && (
                          <Text
                            as="p"
                            variant="bodySm"
                            tone="success"
                            fontWeight={highlights.rows.seoSearchConsole ? "bold" : undefined}
                          >
                            ✓{" "}
                            {t.settings.seoFeatureSearchConsole
                              .replace("{properties}", formatNumber(planDetails.seo.gscProperties, locale))
                              .replace("{days}", formatNumber(planDetails.seo.gscHistoryDays, locale))}
                          </Text>
                        )}
                        {planDetails.seo.monthlyIndexNowSubmissions > 0 && (
                          <Text
                            as="p"
                            variant="bodySm"
                            tone="success"
                            fontWeight={highlights.rows.seoIndexNow ? "bold" : undefined}
                          >
                            ✓{" "}
                            {t.settings.seoFeatureIndexNow.replace(
                              "{count}",
                              formatNumber(planDetails.seo.monthlyIndexNowSubmissions, locale),
                            )}
                          </Text>
                        )}
                        {planDetails.seo.scheduledAudit && (
                          <Text
                            as="p"
                            variant="bodySm"
                            tone="success"
                            fontWeight={highlights.rows.seoScheduledAudit ? "bold" : undefined}
                          >
                            ✓ {t.settings.seoFeatureScheduledAudit}
                          </Text>
                        )}
                        {planDetails.seo.scheduledCrawl && (
                          <Text
                            as="p"
                            variant="bodySm"
                            tone="success"
                            fontWeight={highlights.rows.seoScheduledCrawl ? "bold" : undefined}
                          >
                            ✓ {t.settings.seoFeatureScheduledCrawl}
                          </Text>
                        )}
                        {/* Upsell line only when ALL three named unlocks are
                            still locked here, with the tier derived from the
                            config — otherwise re-tiering one of them would
                            print "✓ IndexNow" and "IndexNow from Pro" on the
                            same card. */}
                        {planDetails.seo.gscProperties === 0 &&
                          planDetails.seo.scoreHistoryDays === 0 &&
                          planDetails.seo.monthlyIndexNowSubmissions === 0 &&
                          seoUpsellPlan && (
                            <Text as="p" variant="bodySm" tone="subdued">
                              {t.settings.seoFeatureProNote.replace(
                                "{plan}",
                                PLAN_DISPLAY_NAMES[seoUpsellPlan],
                              )}
                            </Text>
                          )}
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

      {/* Active trial banner for paid-plan users currently in the Shopify trial */}
      {inTrial && (
        <Banner tone="info">
          <Text as="p">
            {t.settings?.trialPeriod
              ? t.settings.trialPeriod.replace('{days}', String(trialRemainingDays))
              : `Sie befinden sich in der ${trialRemainingDays}-tägigen Testphase.`}
          </Text>
        </Banner>
      )}

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
        imageOperationCount={imageOperationCount}
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

      {/* R4-UX7: Polaris downgrade confirmation (replaces window.confirm) */}
      <Modal
        open={downgradeConfirmOpen}
        onClose={() => setDowngradeConfirmOpen(false)}
        title={t.settings?.confirmDowngradeTitle || "Switch to the free plan?"}
        primaryAction={{
          content: t.settings?.downgrade || "Downgrade",
          onAction: performDowngrade,
          destructive: true,
        }}
        secondaryActions={[
          {
            content: t.common?.cancel || "Cancel",
            onAction: () => setDowngradeConfirmOpen(false),
          },
        ]}
      >
        <Modal.Section>
          <Text as="p">{t.settings.confirmDowngrade}</Text>
        </Modal.Section>
      </Modal>
    </BlockStack>
  );
}
