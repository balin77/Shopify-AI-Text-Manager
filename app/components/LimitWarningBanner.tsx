import { useState, useEffect } from "react";
import { Banner } from "@shopify/polaris";
import { Link } from "@remix-run/react";
import { usePlan } from "../contexts/PlanContext";
import type { ResourceType } from "../utils/planUtils";

interface LimitWarningBannerProps {
  productCount: number;
  localeCount: number;
  collectionCount: number;
  articleCount: number;
  pageCount: number;
  themeTranslationCount: number;
  t: any;
}

const DISMISS_KEY = "limitWarningBannerDismissed";

export function LimitWarningBanner({
  productCount,
  localeCount,
  collectionCount,
  articleCount,
  pageCount,
  themeTranslationCount,
  t,
}: LimitWarningBannerProps) {
  const [isDismissed, setIsDismissed] = useState(false);
  const { getResourcesApproachingLimits, getNextPlanUpgrade, isAtLimit } = usePlan();

  const counts: Record<ResourceType, number> = {
    products: productCount,
    locales: localeCount,
    collections: collectionCount,
    articles: articleCount,
    pages: pageCount,
    themeTranslations: themeTranslationCount,
  };

  const approachingResources = getResourcesApproachingLimits(counts);
  const atLimitResources = approachingResources.filter(r => isAtLimit(r, counts[r]));
  const nextPlan = getNextPlanUpgrade();

  // Check localStorage on mount
  useEffect(() => {
    const dismissed = sessionStorage.getItem(DISMISS_KEY);
    if (dismissed) {
      setIsDismissed(true);
    }
  }, []);

  const handleDismiss = () => {
    sessionStorage.setItem(DISMISS_KEY, "true");
    setIsDismissed(true);
  };

  // Don't show if dismissed or no warnings
  if (isDismissed || approachingResources.length === 0) {
    return null;
  }

  const resourceLabels: Record<ResourceType, string> = {
    products: t.settings?.usageProducts || "Produkte",
    locales: t.settings?.usageLocales || "Sprachen",
    collections: t.settings?.usageCollections || "Kollektionen",
    articles: t.settings?.usageArticles || "Artikel",
    pages: t.settings?.usagePages || "Seiten",
    themeTranslations: t.settings?.usageThemeTranslations || "Theme-Ubersetzungen",
  };

  const hasAtLimit = atLimitResources.length > 0;
  const tone = hasAtLimit ? "critical" : "warning";
  const title = hasAtLimit
    ? (t.settings?.limitReachedTitle || "Plan-Limit erreicht")
    : (t.settings?.limitWarningTitle || "Plan-Limits werden erreicht");

  const resourceList = approachingResources.map(r => resourceLabels[r]).join(", ");

  return (
    <div style={{ padding: "0 1rem" }}>
      <Banner
        tone={tone}
        title={title}
        onDismiss={handleDismiss}
      >
        <p>
          {hasAtLimit
            ? (t.settings?.limitReachedDescription || "Sie haben das Limit erreicht fur: {resources}").replace("{resources}", resourceList)
            : (t.settings?.limitWarningDescription || "Sie nahern sich Ihren Plan-Limits fur: {resources}").replace("{resources}", resourceList)
          }
        </p>
        {nextPlan && (
          <p style={{ marginTop: "0.5rem" }}>
            <Link to="/app/settings?section=usage" style={{ color: tone === "critical" ? "#d72c0d" : "#b98900", textDecoration: "underline", fontWeight: "bold" }}>
              {t.settings?.viewUsage || "Nutzung anzeigen"}
            </Link>
            {" | "}
            <Link to="/app/settings?section=plan" style={{ color: tone === "critical" ? "#d72c0d" : "#b98900", textDecoration: "underline" }}>
              {t.settings?.upgradePlan || "Plan upgraden"}
            </Link>
          </p>
        )}
      </Banner>
    </div>
  );
}
