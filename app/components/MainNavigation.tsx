import { Link, useLocation, useFetcher } from "@remix-run/react";
import { InlineStack, Text, Badge } from "@shopify/polaris";
import { useI18n } from "../contexts/I18nContext";
import { useEffect } from "react";

export function MainNavigation() {
  const location = useLocation();
  const { t } = useI18n();
  const fetcher = useFetcher();

  // Poll for active tasks
  useEffect(() => {
    // Initial load
    fetcher.load("/app/tasks?index");

    // Poll every 5 seconds
    const interval = setInterval(() => {
      fetcher.load("/app/tasks?index");
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  // Count active tasks (pending, queued, running)
  const activeTasks = fetcher.data?.tasks?.filter((task: any) =>
    ['pending', 'queued', 'running'].includes(task.status)
  ).length || 0;

  const tabs = [
    { id: "products", label: t.nav.products, path: "/app" },
    { id: "content", label: t.nav.otherContent, path: "/app/content" },
    { id: "tasks", label: t.nav.tasks, path: "/app/tasks", badge: activeTasks },
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
            <Link
              key={tab.id}
              to={tab.path}
              style={{
                textDecoration: "none",
                padding: "1rem 0.5rem",
                borderBottom: isActive ? "3px solid #303030" : "2px solid transparent",
                transition: "border-color 0.2s",
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
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
              {tab.badge !== undefined && tab.badge > 0 && (
                <Badge tone="info" size="small">
                  {tab.badge}
                </Badge>
              )}
            </Link>
          );
        })}
      </InlineStack>
    </div>
  );
}
