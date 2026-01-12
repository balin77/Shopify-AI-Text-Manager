/**
 * Content Hub - Navigation center for miscellaneous content types
 *
 * This route now handles only:
 * - Menus (read-only)
 * - Templates (Theme content, read-only)
 * - Metaobjects (coming soon)
 * - Shop Metadata (coming soon)
 *
 * Other content types have their own routes:
 * - Collections: /app/collections
 * - Blogs: /app/blog
 * - Pages: /app/pages
 * - Policies: /app/policies
 */

import { useState, useEffect } from "react";
import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import {
  Page,
  Card,
  Text,
  BlockStack,
  InlineStack,
  ResourceList,
  ResourceItem,
  Button,
  Banner,
  TextField,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { MainNavigation } from "../components/MainNavigation";
import { ContentTypeNavigation } from "../components/ContentTypeNavigation";
import { ThemeContentViewer } from "../components/ThemeContentViewer";
import { useI18n } from "../contexts/I18nContext";
import { ContentService } from "../services/content.service";

type ContentType = "collections" | "blogs" | "pages" | "policies" | "menus" | "templates" | "metaobjects" | "shopMetadata";

const getContentTypes = (t: any) => [
  { id: "collections" as ContentType, label: t.content.collections, icon: "📂", description: t.content.collectionsDescription, path: "/app/collections" },
  { id: "blogs" as ContentType, label: t.content.blogs, icon: "📝", description: t.content.blogsDescription, path: "/app/blog" },
  { id: "pages" as ContentType, label: t.content.pages, icon: "📄", description: t.content.pagesDescription, path: "/app/pages" },
  { id: "policies" as ContentType, label: t.content.policies, icon: "📋", description: t.content.policiesDescription, path: "/app/policies" },
  { id: "menus" as ContentType, label: t.content.menus, icon: "🍔", description: t.content.menusDescription },
  { id: "templates" as ContentType, label: t.content.templates, icon: "🧪", description: "Theme translatable resources..." },
  { id: "metaobjects" as ContentType, label: t.content.metaobjects, icon: "🗂️", description: t.content.metaobjectsDescription, comingSoon: true },
  { id: "shopMetadata" as ContentType, label: t.content.shopMetadata, icon: "🏷️", description: t.content.shopMetadataDescription, comingSoon: true },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  try {
    // Get requested content type from URL
    const url = new URL(request.url);
    const requestedType = url.searchParams.get("type") as ContentType | null;

    // Load shopLocales
    const localesResponse = await admin.graphql(
      `#graphql
        query getShopLocales {
          shopLocales {
            locale
            name
            primary
            published
          }
        }`
    );

    const localesData = await localesResponse.json();
    const shopLocales = localesData.data?.shopLocales || [];
    const primaryLocale = shopLocales.find((l: any) => l.primary)?.locale || "de";

    // Initialize data
    let metadata = {};
    let menus: any[] = [];
    let themes: any[] = [];
    let metaobjects: any[] = [];

    // Load requested content type
    if (requestedType === "menus" || requestedType === "shopMetadata" || requestedType === "templates" || requestedType === "metaobjects") {
      const contentService = new ContentService(admin);
      const data = await contentService.getAllContent();
      metadata = data.metadata;
      menus = data.menus;
      themes = data.themes;
      metaobjects = data.metaobjects;
    }

    return json({
      metadata,
      menus,
      themes,
      metaobjects,
      shop: session.shop,
      shopLocales,
      primaryLocale,
      requestedType,
      error: null
    });
  } catch (error: any) {
    console.error("[CONTENT-LOADER] Error:", error);
    return json({
      metadata: {},
      menus: [],
      themes: [],
      metaobjects: [],
      shop: session.shop,
      shopLocales: [],
      primaryLocale: "de",
      requestedType: null,
      error: error.message
    }, { status: 500 });
  }
};

export default function ContentHub() {
  const { metadata, menus, themes, metaobjects, shop, shopLocales, primaryLocale, requestedType, error } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t } = useI18n();

  const CONTENT_TYPES = getContentTypes(t);

  // Get initial type from URL or localStorage
  const getInitialType = (): ContentType => {
    const urlType = searchParams.get("type") as ContentType;
    if (urlType) return urlType;

    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("lastContentHubType");
      if (stored) return stored as ContentType;
    }

    return "collections"; // default
  };

  const [selectedType, setSelectedType] = useState<ContentType>(getInitialType());
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [currentLanguage, setCurrentLanguage] = useState(primaryLocale);

  // Initialize URL on mount
  useEffect(() => {
    const urlType = searchParams.get("type");
    if (!urlType) {
      navigate(`?type=${selectedType}`, { replace: true });
    }
  }, []);

  // Update URL and localStorage when type changes
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("lastContentHubType", selectedType);
    }
    const urlType = searchParams.get("type");
    if (urlType !== selectedType) {
      navigate(`?type=${selectedType}`, { replace: true });
    }
  }, [selectedType, navigate]);

  // Update selectedType from URL
  useEffect(() => {
    const urlType = searchParams.get("type") as ContentType;
    if (urlType && urlType !== selectedType) {
      setSelectedType(urlType);
    }
  }, [searchParams]);

  // Get current items based on selected type
  const getCurrentItems = () => {
    if (selectedType === "menus") {
      return menus.map((m: any) => ({ ...m, type: "menus" }));
    } else if (selectedType === "metaobjects") {
      return metaobjects.map((m: any) => ({ ...m, title: m.displayName, type: "metaobjects" }));
    } else if (selectedType === "templates") {
      return themes.map((t: any) => ({ ...t, title: t.name, type: "templates" }));
    }
    return [];
  };

  const currentItems = getCurrentItems();
  const selectedItem = currentItems.find((item: any) => item.id === selectedItemId);

  // Recursive function to render menu items
  const renderMenuItem = (item: any, index: number, path: number[]): JSX.Element => {
    const label = `Menu Item ${path.join('.')}`;

    return (
      <div key={item.id || index} style={{ marginBottom: "0.5rem" }}>
        <TextField
          label={label}
          value={item.title}
          onChange={() => {}}
          disabled
          autoComplete="off"
        />
        {item.items && item.items.length > 0 && (
          <div style={{ marginLeft: "1.5rem", marginTop: "0.5rem" }}>
            {item.items.map((subItem: any, subIndex: number) =>
              renderMenuItem(subItem, subIndex, [...path, subIndex + 1])
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <Page fullWidth>
      <MainNavigation />
      <ContentTypeNavigation />

      {/* Main Content Area */}
      <div style={{ height: "calc(100vh - 120px)", display: "flex", gap: "1rem", padding: "1rem", overflow: "hidden" }}>
        {/* Left Sidebar - Items List */}
        <div style={{ width: "350px", flexShrink: 0 }}>
          <Card padding="0">
            <div style={{ padding: "1rem", borderBottom: "1px solid #e1e3e5" }}>
              <Text as="h2" variant="headingMd">
                {CONTENT_TYPES.find((t: any) => t.id === selectedType)?.label} ({currentItems.length})
              </Text>
            </div>
            <div style={{ maxHeight: "calc(100vh - 200px)", overflowY: "auto" }}>
              {currentItems.length > 0 ? (
                <ResourceList
                  resourceName={{ singular: t.content.entry, plural: t.content.entries }}
                  items={currentItems}
                  renderItem={(item: any) => {
                    const { id, title } = item;
                    const isSelected = selectedItemId === id;

                    return (
                      <ResourceItem
                        id={id}
                        onClick={() => setSelectedItemId(id)}
                      >
                        <Text as="p" variant="bodyMd" fontWeight={isSelected ? "bold" : "regular"}>
                          {title}
                        </Text>
                      </ResourceItem>
                    );
                  }}
                />
              ) : (
                <div style={{ padding: "2rem", textAlign: "center" }}>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {t.content.noEntries}
                  </Text>
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* Middle: Content Viewer */}
        <div style={{ flex: 1, overflow: "auto", minWidth: 0 }}>
          {error && (
            <div style={{ marginBottom: "1rem" }}>
              <Banner title={t.content.error} tone="critical"><p>{error}</p></Banner>
            </div>
          )}

          <Card padding="600">
            {selectedItem ? (
              <BlockStack gap="500">
                {/* Language Selector - Only for templates */}
                {selectedType === "templates" && (
                  <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                    {shopLocales.map((locale: any) => (
                      <Button
                        key={locale.locale}
                        variant={currentLanguage === locale.locale ? "primary" : undefined}
                        onClick={() => setCurrentLanguage(locale.locale)}
                        size="slim"
                      >
                        {locale.name} {locale.primary && `(${t.content.primaryLanguageSuffix})`}
                      </Button>
                    ))}
                  </div>
                )}

                {/* Item ID */}
                <Text as="p" variant="bodySm" tone="subdued">
                  {t.content.idPrefix} {selectedItem.id.split("/").pop()}
                </Text>

                {/* Menu Items Section (only for menus) */}
                {selectedType === "menus" && selectedItem.items && (
                  <Card>
                    <BlockStack gap="400">
                      {/* API Limitation Banner */}
                      <Banner tone="warning">
                        <p>{t.content.menuLimitation}</p>
                      </Banner>

                      <Text as="h3" variant="headingMd">
                        Menu Items
                      </Text>
                      {selectedItem.items.map((item: any, index: number) =>
                        renderMenuItem(item, index, [index + 1])
                      )}
                    </BlockStack>
                  </Card>
                )}

                {/* Theme Content Viewer (only for templates) */}
                {selectedType === "templates" && selectedItem && (
                  <ThemeContentViewer
                    themeResource={selectedItem}
                    currentLanguage={currentLanguage}
                    shopLocales={shopLocales}
                  />
                )}

                {/* Metaobjects Placeholder */}
                {selectedType === "metaobjects" && (
                  <Banner tone="info">
                    <p>Metaobjects support is coming soon!</p>
                  </Banner>
                )}

                {/* Shop Metadata Placeholder */}
                {selectedType === "shopMetadata" && (
                  <Banner tone="info">
                    <p>Shop metadata support is coming soon!</p>
                  </Banner>
                )}
              </BlockStack>
            ) : (
              <div style={{ textAlign: "center", padding: "4rem 2rem" }}>
                <Text as="p" variant="headingLg" tone="subdued">{t.content.selectFromList}</Text>
              </div>
            )}
          </Card>
        </div>
      </div>
    </Page>
  );
}
