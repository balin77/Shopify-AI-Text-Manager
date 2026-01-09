import { useLocation, useNavigate } from "@remix-run/react";
import { InlineStack, Text } from "@shopify/polaris";
import { useI18n } from "../contexts/I18nContext";

export function MainNavigation() {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useI18n();

  const tabs = [
    { id: "products", label: t.nav.products, path: "/app" },
    { id: "content", label: t.nav.otherContent, path: "/app/content" },
    { id: "tasks", label: t.nav.tasks, path: "/app/tasks" },
    { id: "settings", label: t.nav.settings, path: "/app/settings" },
  ];

  const handleNavClick = (e: React.MouseEvent<HTMLAnchorElement>, path: string) => {
    e.preventDefault();

    // Get current URL parameters
    const currentUrl = new URL(window.location.href);
    const params = currentUrl.searchParams;

    // Build new URL with all current parameters
    const newUrl = new URL(path, window.location.origin);
    params.forEach((value, key) => {
      newUrl.searchParams.set(key, value);
    });

    console.log("=== NAVIGATION ===");
    console.log("Navigating to:", newUrl.toString());

    // Use window.location.assign for reliable navigation in iframe
    window.location.assign(newUrl.toString());
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
            <a
              key={tab.id}
              href={tab.path}
              onClick={(e) => handleNavClick(e, tab.path)}
              style={{
                textDecoration: "none",
                padding: "1rem 0.5rem",
                borderBottom: isActive ? "3px solid #303030" : "3px solid transparent",
                transition: "border-color 0.2s",
                display: "inline-block",
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
            </a>
          );
        })}
      </InlineStack>
    </div>
  );
}
