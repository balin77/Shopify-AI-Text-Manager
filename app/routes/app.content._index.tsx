/**
 * Content Overview - Landing page for all content management
 *
 * This page provides quick navigation to all content types
 */

import { useNavigate } from "@remix-run/react";
import { Page, Card, Text, BlockStack, InlineStack } from "@shopify/polaris";
import { MainNavigation } from "../components/MainNavigation";
import { useI18n } from "../contexts/I18nContext";

export default function ContentOverview() {
  const navigate = useNavigate();
  const { t } = useI18n();

  const contentTypes = [
    {
      id: "collections",
      label: t.content?.collections || "Collections",
      icon: "📂",
      description: t.content?.collectionsDescription || "Manage product collections",
      path: "/app/collections",
    },
    {
      id: "blogs",
      label: t.content?.blogs || "Blogs & Articles",
      icon: "📝",
      description: t.content?.blogsDescription || "Manage blog posts and articles",
      path: "/app/blog",
    },
    {
      id: "pages",
      label: t.content?.pages || "Pages",
      icon: "📄",
      description: t.content?.pagesDescription || "Manage store pages",
      path: "/app/pages",
    },
    {
      id: "policies",
      label: t.content?.policies || "Shop Policies",
      icon: "📋",
      description: t.content?.policiesDescription || "Manage shop policies",
      path: "/app/policies",
    },
    {
      id: "menus",
      label: t.content?.menus || "Menus",
      icon: "🍔",
      description: t.content?.menusDescription || "View store navigation menus (read-only)",
      path: "/app/menus",
    },
    {
      id: "templates",
      label: t.content?.templates || "Theme Content",
      icon: "🧪",
      description: "View and manage theme translatable content",
      path: "/app/templates",
    },
    {
      id: "metaobjects",
      label: t.content?.metaobjects || "Metaobjects",
      icon: "🗂️",
      description: t.content?.metaobjectsDescription || "Manage custom content types",
      path: "/app/metaobjects",
      comingSoon: true,
    },
    {
      id: "metadata",
      label: t.content?.shopMetadata || "Shop Metadata",
      icon: "🏷️",
      description: t.content?.shopMetadataDescription || "Manage store metadata fields",
      path: "/app/metadata",
      comingSoon: true,
    },
  ];

  return (
    <Page fullWidth>
      <MainNavigation />

      <div style={{ padding: "2rem" }}>
        <BlockStack gap="600">
          <BlockStack gap="200">
            <Text as="h1" variant="heading2xl">
              {t.content?.title || "Content Management"}
            </Text>
            <Text as="p" variant="bodyLg" tone="subdued">
              Manage all your store content in one place. Select a content type to get started.
            </Text>
          </BlockStack>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
              gap: "1rem",
            }}
          >
            {contentTypes.map((type) => (
              <Card key={type.id}>
                <button
                  onClick={() => !type.comingSoon && navigate(type.path)}
                  disabled={type.comingSoon}
                  style={{
                    all: "unset",
                    cursor: type.comingSoon ? "not-allowed" : "pointer",
                    display: "block",
                    width: "100%",
                    opacity: type.comingSoon ? 0.6 : 1,
                  }}
                >
                  <BlockStack gap="300">
                    <InlineStack gap="300" blockAlign="center">
                      <span style={{ fontSize: "2rem" }}>{type.icon}</span>
                      <Text as="h2" variant="headingMd">
                        {type.label}
                      </Text>
                      {type.comingSoon && (
                        <Text as="span" variant="bodySm" tone="subdued">
                          (Coming Soon)
                        </Text>
                      )}
                    </InlineStack>
                    <Text as="p" variant="bodyMd" tone="subdued">
                      {type.description}
                    </Text>
                  </BlockStack>
                </button>
              </Card>
            ))}
          </div>
        </BlockStack>
      </div>
    </Page>
  );
}
