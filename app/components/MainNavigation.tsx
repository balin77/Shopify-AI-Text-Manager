import { useLocation, useNavigate } from "@remix-run/react";
import { InlineStack, Text } from "@shopify/polaris";
import { useI18n } from "../contexts/I18nContext";

export function MainNavigation() {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useI18n();

  console.log("🧭 [MainNavigation] Current pathname:", location.pathname);

  const tabs = [
    { id: "products", label: t.nav.products, path: "/app" },
    { id: "content", label: t.nav.otherContent, path: "/app/content" },
    { id: "tasks", label: t.nav.tasks, path: "/app/tasks" },
    { id: "setup", label: "Setup", path: "/app/setup" },
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
      <InlineStack gap="400">
        {tabs.map((tab) => {
          const isActive =
            tab.path === "/app"
              ? location.pathname === "/app" || location.pathname === "/app/"
              : location.pathname.startsWith(tab.path);

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
    </div>
  );
}
