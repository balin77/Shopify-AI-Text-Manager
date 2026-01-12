/**
 * ContentTypeNavigation - Horizontal navigation for all content types
 *
 * This component provides consistent navigation across all content management pages
 */

import { useNavigate, useLocation } from "@remix-run/react";
import { InlineStack, Text } from "@shopify/polaris";
import { useI18n } from "../contexts/I18nContext";

type ContentType = "collections" | "blogs" | "pages" | "policies" | "menus" | "templates" | "metaobjects" | "shopMetadata";

interface ContentTypeConfig {
  id: ContentType;
  label: string;
  icon: string;
  description: string;
  path: string;
  comingSoon?: boolean;
}

export function ContentTypeNavigation() {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useI18n();

  const contentTypes: ContentTypeConfig[] = [
    { id: "collections", label: t.content.collections, icon: "📂", description: t.content.collectionsDescription, path: "/app/collections" },
    { id: "blogs", label: t.content.blogs, icon: "📝", description: t.content.blogsDescription, path: "/app/blog" },
    { id: "pages", label: t.content.pages, icon: "📄", description: t.content.pagesDescription, path: "/app/pages" },
    { id: "policies", label: t.content.policies, icon: "📋", description: t.content.policiesDescription, path: "/app/policies" },
    { id: "menus", label: t.content.menus, icon: "🍔", description: t.content.menusDescription, path: "/app/content?type=menus" },
    { id: "templates", label: t.content.templates, icon: "🧪", description: "Theme translatable resources...", path: "/app/content?type=templates" },
    { id: "metaobjects", label: t.content.metaobjects, icon: "🗂️", description: t.content.metaobjectsDescription, path: "/app/content?type=metaobjects", comingSoon: true },
    { id: "shopMetadata", label: t.content.shopMetadata, icon: "🏷️", description: t.content.shopMetadataDescription, path: "/app/content?type=shopMetadata", comingSoon: true },
  ];

  // Determine which tab is currently active based on the location
  const getActiveType = (): string | null => {
    if (location.pathname === "/app/collections") return "collections";
    if (location.pathname === "/app/blog") return "blogs";
    if (location.pathname === "/app/pages") return "pages";
    if (location.pathname === "/app/policies") return "policies";
    if (location.pathname === "/app/content") {
      const params = new URLSearchParams(location.search);
      return params.get("type") || "menus";
    }
    return null;
  };

  const activeType = getActiveType();

  return (
    <div style={{ borderBottom: "1px solid #e1e3e5", background: "white", padding: "1rem" }}>
      <InlineStack gap="300">
        {contentTypes.map((type) => (
          <button
            key={type.id}
            onClick={() => {
              if (!type.comingSoon) {
                navigate(type.path);
              }
            }}
            disabled={type.comingSoon}
            style={{
              padding: "0.75rem 1.5rem",
              border: activeType === type.id ? "2px solid #008060" : "1px solid #c9cccf",
              borderRadius: "8px",
              background: activeType === type.id ? "#f1f8f5" : type.comingSoon ? "#f6f6f7" : "white",
              cursor: type.comingSoon ? "not-allowed" : "pointer",
              transition: "all 0.2s",
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              opacity: type.comingSoon ? 0.5 : 1,
            }}
          >
            <span style={{ fontSize: "1.2rem" }}>{type.icon}</span>
            <Text
              as="span"
              variant="bodyMd"
              fontWeight={activeType === type.id ? "semibold" : "regular"}
            >
              {type.label}
            </Text>
            {type.comingSoon && (
              <Text as="span" variant="bodySm" tone="subdued">
                (Coming Soon)
              </Text>
            )}
          </button>
        ))}
      </InlineStack>
    </div>
  );
}
