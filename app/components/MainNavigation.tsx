import { useLocation, useNavigate, useFetcher, useMatches } from "@remix-run/react";
import { InlineStack, Text, Banner, ButtonGroup, Button, Tooltip } from "@shopify/polaris";
import { useI18n } from "../contexts/I18nContext";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { usePlan } from "../contexts/PlanContext";
import { type Plan } from "../config/plans";
import { useState } from "react";

export function MainNavigation() {
  const location = useLocation();
  const navigate = useNavigate();
  const matches = useMatches();
  const { t } = useI18n();
  const { infoBox, hideInfoBox } = useInfoBox();
  const { plan, getPlanDisplayName, getMaxProducts } = usePlan();
  const fetcher = useFetcher();
  const [isChangingPlan, setIsChangingPlan] = useState(false);

  // Get product count from products route loader data
  const productsRouteData = matches.find((match) => match.id === "routes/app.products")?.data as any;
  const productCount = productsRouteData?.productCount;
  const maxProducts = getMaxProducts();

  const tabs = [
    { id: "products", label: t.nav.products, path: "/app/products" },
    { id: "content", label: t.nav.otherContent, path: "/app/content" },
    { id: "tasks", label: t.nav.tasks, path: "/app/tasks" },
    { id: "settings", label: t.nav.settings, path: "/app/settings" },
  ];

  const handleClick = (path: string, tabId: string) => {
    console.log("🖱️ [MainNavigation] Tab clicked:", tabId, "->", path);
    console.log("🎯 [MainNavigation] Using client-side navigation (SPA)");

    // Preserve critical URL parameters for Shopify embedded app session
    const searchParams = new URLSearchParams(location.search);
    const newPath = `${path}?${searchParams.toString()}`;

    console.log("🖱️ [MainNavigation] Navigating to:", newPath);
    navigate(newPath);
  };

  const handlePlanChange = async (newPlan: Plan) => {
    if (newPlan === plan || isChangingPlan) return;

    console.log("🔄 [MainNavigation] Changing plan:", plan, "->", newPlan);
    setIsChangingPlan(true);

    try {
      fetcher.submit(
        { plan: newPlan },
        { method: "POST", action: "/api/update-plan", encType: "application/json" }
      );

      // Reload the page after plan change to refresh all data
      setTimeout(() => {
        window.location.reload();
      }, 1000);
    } catch (error) {
      console.error("❌ [MainNavigation] Error changing plan:", error);
      setIsChangingPlan(false);
    }
  };

  const plans: Plan[] = ["free", "basic", "pro", "max"];

  return (
    <>
      {/* Navigation und InfoBox */}
      <div
        style={{
          background: "white",
          borderBottom: "1px solid #e1e3e5",
        }}
      >
        {/* Einzeilige Leiste mit Navigation, Plan Selector und InfoBox */}
        <div style={{ display: "flex", alignItems: "center", padding: "1rem", gap: "2rem" }}>
          {/* Navigation Tabs */}
          <InlineStack gap="400">
            {tabs.map((tab) => {
              const isActive = location.pathname.startsWith(tab.path);
              const showProductCount = tab.id === "products" && productCount !== undefined;
              const isAtLimit = showProductCount && productCount >= maxProducts && maxProducts !== Infinity;

              const tabContent = (
                <button
                  key={tab.id}
                  onClick={() => handleClick(tab.path, tab.id)}
                  style={{
                    textDecoration: "none",
                    padding: "1rem 0.5rem",
                    transition: "border-color 0.2s",
                    background: "none",
                    border: "none",
                    borderBottom: isActive ? "3px solid #303030" : "3px solid transparent",
                    cursor: "pointer",
                  }}
                >
                  <InlineStack gap="200" blockAlign="center">
                    <Text
                      as="span"
                      variant="bodyMd"
                      fontWeight={isActive ? "bold" : "regular"}
                      tone="base"
                    >
                      {tab.label}
                    </Text>
                    {showProductCount && (
                      <Text
                        as="span"
                        variant="bodySm"
                        tone={isAtLimit ? "critical" : "subdued"}
                      >
                        ({productCount})
                      </Text>
                    )}
                  </InlineStack>
                </button>
              );

              // Wrap with tooltip if at product limit
              if (isAtLimit && plan === "free") {
                return (
                  <Tooltip key={tab.id} content="Upgrade to Basic for 100 products">
                    {tabContent}
                  </Tooltip>
                );
              }

              return tabContent;
            })}
          </InlineStack>

          {/* Plan Selector */}
          <div style={{ marginLeft: "auto" }}>
            <ButtonGroup variant="segmented">
              {plans.map((planOption) => (
                <Button
                  key={planOption}
                  pressed={plan === planOption}
                  onClick={() => handlePlanChange(planOption)}
                  disabled={isChangingPlan}
                  size="slim"
                >
                  {planOption.charAt(0).toUpperCase() + planOption.slice(1)}
                </Button>
              ))}
            </ButtonGroup>
          </div>

          {/* InfoBox auf gleicher Ebene - schlanke Variante */}
          {infoBox && (
            <div
              style={{
                flex: 1,
                maxWidth: "600px",
                display: "flex",
                alignItems: "center",
                padding: "0.5rem 1rem",
                borderRadius: "4px",
                backgroundColor:
                  infoBox.tone === "success" ? "#e8f5e9" :
                  infoBox.tone === "critical" ? "#ffebee" :
                  infoBox.tone === "warning" ? "#fff3e0" :
                  "#e3f2fd",
                border: `1px solid ${
                  infoBox.tone === "success" ? "#4caf50" :
                  infoBox.tone === "critical" ? "#f44336" :
                  infoBox.tone === "warning" ? "#ff9800" :
                  "#2196f3"
                }`,
                fontSize: "14px",
                gap: "0.5rem"
              }}
            >
              <span style={{ flex: 1, color: "#202223" }}>
                {infoBox.message}
              </span>
              <button
                onClick={hideInfoBox}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: "0.25rem",
                  display: "flex",
                  alignItems: "center",
                  color: "#202223",
                  opacity: 0.6,
                  fontSize: "18px",
                  lineHeight: 1
                }}
                aria-label="Schließen"
              >
                ×
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
