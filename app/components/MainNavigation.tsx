import { NavLink, useLocation } from "@remix-run/react";
import { InlineStack, Text } from "@shopify/polaris";
import { useI18n } from "../contexts/I18nContext";

export function MainNavigation() {
  const location = useLocation();
  const { t } = useI18n();

  console.log("🧭 [MainNavigation] Current pathname:", location.pathname);

  const tabs = [
    { id: "products", label: t.nav.products, path: "/app" },
    { id: "content", label: t.nav.otherContent, path: "/app/content" },
    { id: "tasks", label: t.nav.tasks, path: "/app/tasks" },
    { id: "settings", label: t.nav.settings, path: "/app/settings" },
  ];

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
            <NavLink
              key={tab.id}
              to={tab.path}
              prefetch="none"
              onClick={(e) => {
                console.log("🖱️ [MainNavigation] Tab clicked:", tab.id, "->", tab.path);
                console.log("🖱️ [MainNavigation] Current location:", location.pathname);
              }}
              style={{
                textDecoration: "none",
                padding: "1rem 0.5rem",
                borderBottom: isActive ? "3px solid #303030" : "2px solid transparent",
                transition: "border-color 0.2s",
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
            </NavLink>
          );
        })}
      </InlineStack>
    </div>
  );
}
