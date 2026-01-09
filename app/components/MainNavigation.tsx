import { useLocation, useNavigate } from "@remix-run/react";
import { InlineStack, Text } from "@shopify/polaris";
import { useI18n } from "../contexts/I18nContext";
import { useEffect, useRef } from "react";

export function MainNavigation() {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useI18n();
  const appBridgeRef = useRef<any>(null);

  const tabs = [
    { id: "products", label: t.nav.products, path: "/app" },
    { id: "content", label: t.nav.otherContent, path: "/app/content" },
    { id: "tasks", label: t.nav.tasks, path: "/app/tasks" },
    { id: "settings", label: t.nav.settings, path: "/app/settings" },
  ];

  useEffect(() => {
    // Initialize Shopify App Bridge if in embedded context
    if (typeof window !== "undefined" && (window as any).shopify?.environment) {
      try {
        const shopifyConfig = (window as any).shopifyConfig;
        if (shopifyConfig && (window as any).shopify?.createApp) {
          appBridgeRef.current = (window as any).shopify.createApp({
            apiKey: shopifyConfig.apiKey,
            host: shopifyConfig.host,
          });
        }
      } catch (error) {
        console.error("Failed to initialize Shopify App Bridge:", error);
      }
    }
  }, []);

  const handleNavigation = (path: string) => {
    // Check if we're in Shopify embedded context
    if (appBridgeRef.current && (window as any).shopify?.Redirect) {
      try {
        const Redirect = (window as any).shopify.Redirect.create(appBridgeRef.current);
        Redirect.dispatch((window as any).shopify.Redirect.Action.APP, path);
      } catch (error) {
        console.error("App Bridge navigation failed, falling back to navigate:", error);
        navigate(path);
      }
    } else {
      // Fallback to regular navigation
      navigate(path);
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
            <button
              key={tab.id}
              onClick={() => handleNavigation(tab.path)}
              style={{
                textDecoration: "none",
                padding: "1rem 0.5rem",
                borderBottom: isActive ? "3px solid #303030" : "3px solid transparent",
                transition: "border-color 0.2s",
                background: "none",
                border: "none",
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
