import { useLocation, useNavigate } from "@remix-run/react";
import { InlineStack, Text, Button, Badge } from "@shopify/polaris";
import { useI18n } from "../contexts/I18nContext";
import { useDevMode } from "../contexts/DevModeContext";

export function MainNavigation() {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useI18n();
  const { isDevMode, toggleDevMode } = useDevMode();

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

  return (
    <div
      style={{
        borderBottom: "1px solid #e1e3e5",
        background: "white",
        padding: "0 1rem",
      }}
    >
      <InlineStack gap="400" align="space-between" blockAlign="center">
        <InlineStack gap="400">
          {tabs.map((tab) => {
            const isActive = location.pathname.startsWith(tab.path);

            return (
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
                <Text
                  as="span"
                  variant="bodyMd"
                  fontWeight={isActive ? "bold" : "regular"}
                  tone="base"
                >
                  {tab.label}
                </Text>
              </button>
            );
          })}
        </InlineStack>

        {/* Dev Mode Toggle */}
        <InlineStack gap="200" blockAlign="center">
          {isDevMode && (
            <>
              <button
                onClick={() => handleClick("/app/translatable-debug", "translatable-debug")}
                style={{
                  textDecoration: "none",
                  padding: "0.5rem 1rem",
                  background: location.pathname === "/app/translatable-debug" ? "#f1f1f1" : "transparent",
                  border: "1px solid #c9cccf",
                  borderRadius: "4px",
                  cursor: "pointer",
                  fontSize: "0.875rem",
                }}
              >
                <Text as="span" variant="bodySm">
                  🔍 Debug Translations
                </Text>
              </button>
              <Badge tone="info">Dev Mode</Badge>
            </>
          )}
          <Button
            size="slim"
            onClick={toggleDevMode}
            tone={isDevMode ? "success" : "base"}
          >
            {isDevMode ? "🛠️ Dev ON" : "🛠️ Dev OFF"}
          </Button>
        </InlineStack>
      </InlineStack>
    </div>
  );
}
