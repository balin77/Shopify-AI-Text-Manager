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

  const handleClick = (e: React.MouseEvent, path: string) => {
    e.preventDefault();
    e.stopPropagation();

    // Force navigation using window.location in embedded context
    if (typeof window !== "undefined") {
      // Check if we're in an embedded Shopify context
      const isEmbedded = window.self !== window.top;

      if (isEmbedded) {
        // In embedded context, use window.location to force full page navigation
        window.top!.location.href = path;
      } else {
        // In standalone context, use Remix navigation
        navigate(path);
      }
    }
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
              onClick={(e) => handleClick(e, tab.path)}
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
