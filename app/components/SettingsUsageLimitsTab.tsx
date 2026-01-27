import { useEffect } from "react";
import { Card, Text, BlockStack, Banner, ProgressBar, InlineStack, Button } from "@shopify/polaris";
import { usePlan } from "../contexts/PlanContext";
import type { ResourceType } from "../utils/planUtils";
import { useNavigate, useFetcher } from "@remix-run/react";
import { StoragePieChart, type StorageData } from "./StoragePieChart";

interface SettingsUsageLimitsTabProps {
  productCount: number;
  localeCount: number;
  collectionCount: number;
  articleCount: number;
  pageCount: number;
  themeTranslationCount: number;
  t: any;
  hideUpgradeCard?: boolean;
}

interface UsageRowProps {
  label: string;
  current: number;
  max: number;
  percentage: number;
  isApproaching: boolean;
  isAtLimit: boolean;
  disabled?: boolean;
  t: any;
}

function UsageRow({ label, current, max, percentage, isApproaching, isAtLimit, disabled, t }: UsageRowProps) {
  const getProgressTone = (): "highlight" | "primary" | "success" | "critical" => {
    if (isAtLimit) return "critical";
    if (isApproaching) return "highlight";
    if (percentage > 50) return "highlight";
    return "success";
  };

  const getStatusText = () => {
    if (disabled) return t.settings?.featureDisabled || "Nicht verfugbar";
    if (isAtLimit) return t.settings?.usageAtLimit || "Limit erreicht";
    if (isApproaching) return t.settings?.usageNearLimit || "Limit fast erreicht";
    return "";
  };

  const formatMax = (max: number) => {
    if (max === Infinity) return t.settings?.usageUnlimited || "Unbegrenzt";
    return max.toLocaleString();
  };

  return (
    <div style={{
      padding: "1rem",
      background: isAtLimit ? "#fff5f5" : isApproaching ? "#fff8e6" : "#f6f6f7",
      borderRadius: "8px",
      borderLeft: isAtLimit ? "4px solid #d72c0d" : isApproaching ? "4px solid #ffc453" : "4px solid transparent"
    }}>
      <BlockStack gap="200">
        <InlineStack align="space-between">
          <Text as="span" fontWeight="semibold">{label}</Text>
          <Text as="span" tone={disabled ? "subdued" : undefined}>
            {disabled ? "0 / 0" : `${current.toLocaleString()} / ${formatMax(max)}`}
          </Text>
        </InlineStack>

        {!disabled && max !== Infinity && (
          <ProgressBar
            progress={percentage}
            tone={getProgressTone()}
            size="small"
          />
        )}

        {disabled && (
          <Text as="p" tone="subdued" variant="bodySm">
            {t.settings?.upgradeForMore || "Upgrade fur mehr"}
          </Text>
        )}

        {!disabled && getStatusText() && (
          <InlineStack align="space-between">
            <Text as="span" tone={isAtLimit ? "critical" : "caution"} variant="bodySm">
              {getStatusText()}
            </Text>
            <Text as="span" tone="subdued" variant="bodySm">
              {percentage}%
            </Text>
          </InlineStack>
        )}

        {!disabled && !getStatusText() && max !== Infinity && (
          <Text as="span" tone="subdued" variant="bodySm" alignment="end">
            {percentage}%
          </Text>
        )}
      </BlockStack>
    </div>
  );
}

export function SettingsUsageLimitsTab({
  productCount,
  localeCount,
  collectionCount,
  articleCount,
  pageCount,
  themeTranslationCount,
  t,
  hideUpgradeCard = false,
}: SettingsUsageLimitsTabProps) {
  const {
    plan,
    getPlanLimits,
    getUsagePercentage,
    isApproachingLimit,
    isAtLimit,
    getResourcesApproachingLimits,
    getNextPlanUpgrade,
    getPlanDisplayName
  } = usePlan();
  const navigate = useNavigate();

  // Fetch storage stats
  const storageFetcher = useFetcher<{
    success?: boolean;
    stats?: {
      products: number;
      collections: number;
      articles: number;
      pages: number;
      policies: number;
      themeContent: number;
      translations: number;
      total: number;
    };
  }>();

  useEffect(() => {
    if (storageFetcher.state === "idle" && !storageFetcher.data) {
      storageFetcher.load("/api/storage-stats");
    }
  }, [storageFetcher]);

  // Prepare storage data for pie chart
  const storageChartData: StorageData[] = storageFetcher.data?.stats
    ? [
        {
          label: t.settings?.usageProducts || "Produkte",
          value: storageFetcher.data.stats.products,
          color: "#008060", // Shopify green
        },
        {
          label: t.settings?.usageCollections || "Kollektionen",
          value: storageFetcher.data.stats.collections,
          color: "#5c6ac4", // Indigo
        },
        {
          label: t.settings?.usageArticles || "Artikel",
          value: storageFetcher.data.stats.articles,
          color: "#006fbb", // Blue
        },
        {
          label: t.settings?.usagePages || "Seiten",
          value: storageFetcher.data.stats.pages,
          color: "#9c6ade", // Purple
        },
        {
          label: t.settings?.usagePolicies || "Richtlinien",
          value: storageFetcher.data.stats.policies,
          color: "#47c1bf", // Teal
        },
        {
          label: t.settings?.usageThemeContent || "Theme-Inhalte",
          value: storageFetcher.data.stats.themeContent,
          color: "#f49342", // Orange
        },
        {
          label: t.settings?.usageTranslations || "Ubersetzungen",
          value: storageFetcher.data.stats.translations,
          color: "#de3618", // Red
        },
      ]
    : [];

  const limits = getPlanLimits();

  const counts: Record<ResourceType, number> = {
    products: productCount,
    locales: localeCount,
    collections: collectionCount,
    articles: articleCount,
    pages: pageCount,
    themeTranslations: themeTranslationCount,
  };

  const approachingResources = getResourcesApproachingLimits(counts);
  const hasWarnings = approachingResources.length > 0;
  const nextPlan = getNextPlanUpgrade();

  const resourceLabels: Record<ResourceType, string> = {
    products: t.settings?.usageProducts || "Produkte",
    locales: t.settings?.usageLocales || "Sprachen",
    collections: t.settings?.usageCollections || "Kollektionen",
    articles: t.settings?.usageArticles || "Artikel",
    pages: t.settings?.usagePages || "Seiten",
    themeTranslations: t.settings?.usageThemeTranslations || "Theme-Ubersetzungen",
  };

  const getResourceData = (resource: ResourceType) => ({
    label: resourceLabels[resource],
    current: counts[resource],
    max: limits[`max${resource.charAt(0).toUpperCase() + resource.slice(1)}` as keyof typeof limits] as number,
    percentage: getUsagePercentage(resource, counts[resource]),
    isApproaching: isApproachingLimit(resource, counts[resource]),
    isAtLimit: isAtLimit(resource, counts[resource]),
    disabled: (limits[`max${resource.charAt(0).toUpperCase() + resource.slice(1)}` as keyof typeof limits] as number) === 0,
  });

  return (
    <>
      {hasWarnings && (
        <Banner
          title={t.settings?.limitWarningTitle || "Plan-Limits werden erreicht"}
          tone="warning"
          action={!hideUpgradeCard && nextPlan ? {
            content: t.settings?.upgradeForMore || "Plan upgraden",
            onAction: () => navigate("/app/settings?section=plan")
          } : undefined}
        >
          <p>
            {(t.settings?.limitWarningDescription || "Sie nahern sich Ihren Plan-Limits fur: {resources}").replace(
              "{resources}",
              approachingResources.map(r => resourceLabels[r]).join(", ")
            )}
          </p>
        </Banner>
      )}

      <Card>
        <BlockStack gap="400">
          <InlineStack align="space-between">
            <Text as="h2" variant="headingMd">
              {t.settings?.currentUsage || "Aktuelle Nutzung"}
            </Text>
            <Text as="span" tone="subdued">
              Plan: {getPlanDisplayName()}
            </Text>
          </InlineStack>

          <Text as="p" tone="subdued">
            {t.settings?.usageLimitsDescription || "Ubersicht Ihrer aktuellen Nutzung im Vergleich zu den Plan-Limits."}
          </Text>

          <BlockStack gap="300">
            <Text as="h3" variant="headingSm">
              {t.settings?.usageProducts || "Produkte"} & Content
            </Text>

            <UsageRow {...getResourceData("products")} t={t} />
            <UsageRow {...getResourceData("collections")} t={t} />
            <UsageRow {...getResourceData("articles")} t={t} />
            <UsageRow {...getResourceData("pages")} t={t} />
          </BlockStack>

          <BlockStack gap="300">
            <Text as="h3" variant="headingSm">
              {t.settings?.usageLocales || "Sprachen"} & {t.settings?.usageThemeTranslations || "Theme-Ubersetzungen"}
            </Text>

            <UsageRow {...getResourceData("locales")} t={t} />
            <UsageRow {...getResourceData("themeTranslations")} t={t} />
          </BlockStack>
        </BlockStack>
      </Card>

      {/* Storage Pie Chart */}
      <StoragePieChart
        data={storageChartData}
        title={t.settings?.storageUsage || "Speichernutzung"}
        loading={storageFetcher.state === "loading"}
        t={t}
      />

      {!hideUpgradeCard && nextPlan && (
        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              {t.settings?.upgradeForMore || "Mehr Kapazitat benotigt?"}
            </Text>
            <Text as="p">
              {(t.settings?.upgradeDescription || "Upgraden Sie auf {plan} fur hohere Limits.").replace(
                "{plan}",
                nextPlan.charAt(0).toUpperCase() + nextPlan.slice(1)
              )}
            </Text>
            <Button
              variant="primary"
              onClick={() => navigate("/app/settings?section=plan")}
            >
              {t.settings?.viewPlans || "Plane anzeigen"}
            </Button>
          </BlockStack>
        </Card>
      )}
    </>
  );
}
