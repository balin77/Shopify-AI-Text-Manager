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

import { useState, useEffect, useRef, type ReactElement } from "react";
import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate, useSearchParams, useFetcher } from "@remix-run/react";
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
import { useNavigationHeight } from "../contexts/NavigationHeightContext";
import { ContentService } from "../services/content.service";
import { contentEditorStyles } from "../utils/contentEditor.utils";
import { CONTENT_MAX_HEIGHT } from "../constants/layout";
import { logger } from "~/utils/logger.server";

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
    logger.error("[CONTENT-LOADER] Error", { context: "Content", error: error.message, stack: error.stack });
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
  const fetcher = useFetcher();
  const { t } = useI18n();
  const { getTotalNavHeight } = useNavigationHeight();
  const saveButtonRef = useRef<HTMLDivElement>(null);

  const CONTENT_TYPES = getContentTypes(t);

  // Get initial type from URL or localStorage
  const getInitialType = (): ContentType | null => {
    const urlType = searchParams.get("type") as ContentType;
    if (urlType) return urlType;

    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("lastContentHubType");
      if (stored && ["menus", "templates", "metaobjects", "shopMetadata"].includes(stored)) {
        return stored as ContentType;
      }
    }

    // If no type specified and no valid localStorage, redirect to collections
    return null;
  };

  const [selectedType, setSelectedType] = useState<ContentType | null>(getInitialType());
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [currentLanguage, setCurrentLanguage] = useState(primaryLocale);

  // Templates editable state
  const [editableValues, setEditableValues] = useState<Record<string, string>>({});
  const [originalValues, setOriginalValues] = useState<Record<string, string>>({});
  const [aiSuggestions, setAiSuggestions] = useState<Record<string, string>>({});
  const [htmlModes, setHtmlModes] = useState<Record<string, "html" | "rendered">>({});
  const [loadedTranslations, setLoadedTranslations] = useState<Record<string, any[]>>({});

  // Check for changes
  const hasChanges = Object.keys(editableValues).some(
    key => editableValues[key] !== originalValues[key]
  );

  // Initialize - redirect to collections if no type specified
  useEffect(() => {
    const urlType = searchParams.get("type");
    if (!urlType) {
      // Clear localStorage to prevent auto-selecting menus
      if (typeof window !== "undefined") {
        localStorage.removeItem("lastContentHubType");
      }
      // Always redirect to collections when accessing /app/content without type
      navigate("/app/collections", { replace: true });
    }
  }, [searchParams, navigate]);

  // Update URL and localStorage when type changes
  useEffect(() => {
    if (selectedType) {
      if (typeof window !== "undefined") {
        localStorage.setItem("lastContentHubType", selectedType);
      }
      const urlType = searchParams.get("type");
      if (urlType !== selectedType) {
        navigate(`?type=${selectedType}`, { replace: true });
      }
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

  // Load template values when item or language changes
  useEffect(() => {
    if (selectedType !== "templates" || !selectedItem) {
      return;
    }

    console.log('[CONTENT-TEMPLATES] Loading values for:', {
      currentLanguage,
      primaryLocale,
      hasContent: !!selectedItem.translatableContent,
      contentLength: selectedItem.translatableContent?.length
    });

    if (currentLanguage === primaryLocale) {
      // Load primary locale values
      const values: Record<string, string> = {};
      selectedItem.translatableContent?.forEach((item: any) => {
        values[item.key] = item.value || "";
      });
      console.log('[CONTENT-TEMPLATES] Primary values loaded:', Object.keys(values).length);
      setEditableValues(values);
      setOriginalValues({ ...values });
    } else {
      // For foreign languages, populate from translations if available
      const values: Record<string, string> = {};
      selectedItem.translatableContent?.forEach((item: any) => {
        const translation = selectedItem.translations?.find(
          (t: any) => t.locale === currentLanguage && t.key === item.key
        );
        values[item.key] = translation?.value || "";
      });
      setEditableValues(values);
      setOriginalValues({ ...values });
    }
  }, [selectedItem, currentLanguage, primaryLocale, selectedType]);

  // Template handlers (placeholder for now - TODO: implement full functionality)
  const handleValueChange = (key: string, value: string) => {
    setEditableValues(prev => ({ ...prev, [key]: value }));
  };

  const handleGenerateAI = (fieldKey: string) => {
    console.log('[CONTENT-TEMPLATES] Generate AI for:', fieldKey);
    // TODO: Implement AI generation
  };

  const handleTranslate = (fieldKey: string) => {
    console.log('[CONTENT-TEMPLATES] Translate field:', fieldKey);
    // TODO: Implement translation
  };

  const handleTranslateAll = () => {
    console.log('[CONTENT-TEMPLATES] Translate all');
    // TODO: Implement translate all
  };

  const handleAcceptSuggestion = (fieldKey: string) => {
    const suggestion = aiSuggestions[fieldKey];
    if (suggestion) {
      setEditableValues(prev => ({ ...prev, [fieldKey]: suggestion }));
      setAiSuggestions(prev => {
        const newSuggestions = { ...prev };
        delete newSuggestions[fieldKey];
        return newSuggestions;
      });
    }
  };

  const handleRejectSuggestion = (fieldKey: string) => {
    setAiSuggestions(prev => {
      const newSuggestions = { ...prev };
      delete newSuggestions[fieldKey];
      return newSuggestions;
    });
  };

  const handleToggleHtmlMode = (fieldKey: string) => {
    setHtmlModes(prev => ({
      ...prev,
      [fieldKey]: prev[fieldKey] === "html" ? "rendered" : "html"
    }));
  };

  // Recursive function to render menu items
  const renderMenuItem = (item: any, index: number, path: number[]): ReactElement => {
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
      <div style={{ height: `calc(100vh - ${getTotalNavHeight()}px)`, display: "flex", gap: "1rem", padding: "1rem", overflow: "hidden" }}>
        {/* Left Sidebar - Items List */}
        <div style={{ width: "350px", flexShrink: 0 }}>
          <Card padding="0">
            <div style={{ padding: "1rem", borderBottom: "1px solid #e1e3e5" }}>
              <Text as="h2" variant="headingMd">
                {CONTENT_TYPES.find((t: any) => t.id === selectedType)?.label} ({currentItems.length})
              </Text>
            </div>
            <div style={{ maxHeight: CONTENT_MAX_HEIGHT, overflowY: "auto" }}>
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
                    primaryLocale={primaryLocale}
                    editableValues={editableValues}
                    onValueChange={handleValueChange}
                    aiSuggestions={aiSuggestions}
                    onGenerateAI={handleGenerateAI}
                    onTranslate={handleTranslate}
                    onTranslateAll={handleTranslateAll}
                    onAcceptSuggestion={handleAcceptSuggestion}
                    onRejectSuggestion={handleRejectSuggestion}
                    isLoading={fetcher.state === "submitting"}
                    htmlModes={htmlModes}
                    onToggleHtmlMode={handleToggleHtmlMode}
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
