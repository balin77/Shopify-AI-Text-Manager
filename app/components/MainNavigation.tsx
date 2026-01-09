import { Link, useLocation } from "@remix-run/react";
import { InlineStack, Text } from "@shopify/polaris";

export function MainNavigation() {
  const location = useLocation();

  const tabs = [
    { id: "products", label: "Produkte", path: "/app" },
    { id: "content", label: "Andere Inhalte", path: "/app/content" },
    { id: "settings", label: "Einstellungen", path: "/app/settings" },
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
            <Link
              key={tab.id}
              to={tab.path}
              style={{
                textDecoration: "none",
                padding: "1rem 0.5rem",
                borderBottom: isActive ? "2px solid #008060" : "2px solid transparent",
                transition: "border-color 0.2s",
              }}
            >
              <Text
                as="span"
                variant="bodyMd"
                fontWeight={isActive ? "semibold" : "regular"}
                tone={isActive ? undefined : "subdued"}
              >
                {tab.label}
              </Text>
            </Link>
          );
        })}
      </InlineStack>
    </div>
  );
}
