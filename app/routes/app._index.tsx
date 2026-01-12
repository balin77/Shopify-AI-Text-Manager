/**
 * Main Overview - Landing page for all app sections
 *
 * This page provides quick navigation to all main areas:
 * - Products management
 * - Content management (Collections, Blogs, Pages, Policies, etc.)
 */

import { useEffect } from "react";
import { useNavigate, useFetcher } from "@remix-run/react";
import { Page, Card, Text, BlockStack, InlineStack } from "@shopify/polaris";
import { MainNavigation } from "../components/MainNavigation";
import { useI18n } from "../contexts/I18nContext";

export default function AppOverview() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const fetcher = useFetcher();

  // Trigger initial sync on app start
  useEffect(() => {
    // Only trigger if not already loading/submitting and no data yet
    if (fetcher.state === 'idle' && !fetcher.data) {
      console.log('[APP] Triggering initial background sync...');
      fetcher.submit(
        {},
        {
          method: 'POST',
          action: '/api/sync-content?types=pages,policies,themes'
        }
      );
    }
  }, []);

  // Log sync status (optional - helps with debugging)
  useEffect(() => {
    if (fetcher.state === 'submitting') {
      console.log('[APP] Background sync in progress...');
    } else if (fetcher.state === 'loading') {
      console.log('[APP] Background sync finishing...');
    } else if (fetcher.data) {
      console.log('[APP] Background sync complete:', fetcher.data);
    }
  }, [fetcher.state, fetcher.data]);

  const sections = [
    {
      id: "products",
      label: t.products?.title || "Products",
      icon: "🛍️",
      description: t.products?.description || "Manage product information, translations, and SEO",
      path: "/app/products",
    },
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
              Welcome to Shopify API Connector
            </Text>
            <Text as="p" variant="bodyLg" tone="subdued">
              Manage all aspects of your store in one place. Select a section to get started.
            </Text>
          </BlockStack>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
              gap: "1rem",
            }}
          >
            {sections.map((section) => (
              <Card key={section.id}>
                <button
                  onClick={() => !section.comingSoon && navigate(section.path)}
                  disabled={section.comingSoon}
                  style={{
                    all: "unset",
                    cursor: section.comingSoon ? "not-allowed" : "pointer",
                    display: "block",
                    width: "100%",
                    opacity: section.comingSoon ? 0.6 : 1,
                  }}
                >
                  <BlockStack gap="300">
                    <InlineStack gap="300" blockAlign="center">
                      <span style={{ fontSize: "2rem" }}>{section.icon}</span>
                      <Text as="h2" variant="headingMd">
                        {section.label}
                      </Text>
                      {section.comingSoon && (
                        <Text as="span" variant="bodySm" tone="subdued">
                          (Coming Soon)
                        </Text>
                      )}
                    </InlineStack>
                    <Text as="p" variant="bodyMd" tone="subdued">
                      {section.description}
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
