/**
 * Theme Templates Management - View and manage theme translatable content
 *
 * Displays theme content grouped by resource type with full editing capabilities
 */

import { useState, useEffect, useRef } from "react";
import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Page,
  Card,
  Text,
  BlockStack,
  ResourceList,
  ResourceItem,
  Button,
  Banner,
  InlineStack,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { MainNavigation } from "../components/MainNavigation";
import { ContentTypeNavigation } from "../components/ContentTypeNavigation";
import { ThemeContentViewer } from "../components/ThemeContentViewer";
import { useI18n } from "../contexts/I18nContext";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  try {
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

    // LAZY LOADING: Only load navigation metadata, not the full content
    const { db } = await import("../db.server");

    // OPTIMIZED: Use groupBy to get unique groups with counts in a single efficient query
    // This uses Prisma's aggregation which is executed at the database level
    const groupsWithCounts = await db.themeContent.groupBy({
      by: ['groupId', 'groupName', 'groupIcon'],
      where: { shop: session.shop },
      _count: {
        groupId: true
      }
    });

    // Create lightweight navigation items (sorted alphabetically)
    const themes = groupsWithCounts
      .map(group => ({
        id: `group_${group.groupId}`,
        title: group.groupName,
        name: group.groupName,
        icon: group.groupIcon,
        groupId: group.groupId,
        role: 'THEME_GROUP',
        contentCount: group._count.groupId
      }))
      .sort((a, b) => a.title.localeCompare(b.title)); // Alphabetical sort

    return json({
      themes,
      shop: session.shop,
      shopLocales,
      primaryLocale,
      error: null
    });
  } catch (error: any) {
    console.error("[TEMPLATES-LOADER] Error:", error);
    return json({
      themes: [],
      shop: session.shop,
      shopLocales: [],
      primaryLocale: "de",
      error: error.message
    }, { status: 500 });
  }
};

export default function TemplatesPage() {
  const { themes, shop, shopLocales, primaryLocale, error } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const { t } = useI18n();
  const saveButtonRef = useRef<HTMLDivElement>(null);

  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [currentLanguage, setCurrentLanguage] = useState(primaryLocale);
  const [loadedThemes, setLoadedThemes] = useState<Record<string, any>>({});
  const [isLoading, setIsLoading] = useState(false);

  // Editable state
  const [editableValues, setEditableValues] = useState<Record<string, string>>({});
  const [originalValues, setOriginalValues] = useState<Record<string, string>>({});
  const [aiSuggestions, setAiSuggestions] = useState<Record<string, string>>({});
  const [htmlModes, setHtmlModes] = useState<Record<string, "html" | "rendered">>({});
  const [loadedTranslations, setLoadedTranslations] = useState<Record<string, any[]>>({});

  // Get current group ID
  const currentGroupId = selectedItemId ? themes.find((t: any) => t.id === selectedItemId)?.groupId : null;
  const selectedItem = currentGroupId ? loadedThemes[currentGroupId] : null;


  // Check for changes
  const hasChanges = Object.keys(editableValues).some(
    key => editableValues[key] !== originalValues[key]
  );

  // Auto-select and load first item on mount
  useEffect(() => {
    if (themes.length > 0 && !selectedItemId) {
      const firstTheme = themes[0];
      setSelectedItemId(firstTheme.id);
      loadThemeData(firstTheme.groupId);
    }
  }, [themes]);

  // Function to load theme data on-demand
  const loadThemeData = async (groupId: string) => {
    // Check if already loaded
    if (loadedThemes[groupId]) {
      return;
    }

    setIsLoading(true);
    try {
      const response = await fetch(`/api/templates/${groupId}`);

      if (!response.ok) {
        throw new Error('Failed to load theme data');
      }
      const data = await response.json();

      setLoadedThemes(prev => ({
        ...prev,
        [groupId]: data.theme
      }));
    } catch (error) {
      console.error('Error loading theme data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // Load translations when language changes (for non-primary locales)
  useEffect(() => {
    if (!selectedItem || !currentGroupId) {
      console.log('[TEMPLATES] Skipping load - no selectedItem or currentGroupId');
      return;
    }

    console.log('[TEMPLATES] Loading content for:', {
      currentGroupId,
      currentLanguage,
      isPrimary: currentLanguage === primaryLocale,
      contentCount: selectedItem.translatableContent?.length
    });

    if (currentLanguage === primaryLocale) {
      // Load primary locale values
      const values: Record<string, string> = {};
      selectedItem.translatableContent?.forEach((item: any) => {
        values[item.key] = item.value || "";
      });

      console.log('[TEMPLATES] Primary locale - loaded', Object.keys(values).length, 'fields');

      // Only update if values actually changed (prevent infinite loop)
      const hasChanged = Object.keys(values).length !== Object.keys(editableValues).length ||
        Object.keys(values).some(key => values[key] !== editableValues[key]);

      if (hasChanged) {
        console.log('[TEMPLATES] Updating editableValues for primary locale');
        setEditableValues(values);
        setOriginalValues({ ...values });
      }
    } else {
      // Check if translations are already loaded
      const translationKey = `${currentGroupId}_${currentLanguage}`;
      const hasTranslations = loadedTranslations[translationKey];

      console.log('[TEMPLATES] Non-primary locale:', {
        translationKey,
        hasTranslations: !!hasTranslations,
        translationCount: hasTranslations?.length || 0,
        fetcherState: fetcher.state
      });

      if (!hasTranslations) {
        // Only load if not already loading
        if (fetcher.state === 'idle') {
          console.log('[TEMPLATES] Fetching translations for', currentLanguage);
          // Load translations
          const formData = new FormData();
          formData.append("action", "loadTranslations");
          formData.append("locale", currentLanguage);

          fetcher.submit(formData, {
            method: "POST",
            action: `/api/templates/${currentGroupId}`
          });
        }
      } else {
        // Use loaded translations
        const values: Record<string, string> = {};
        selectedItem.translatableContent?.forEach((item: any) => {
          const translation = hasTranslations.find((t: any) => t.key === item.key);
          values[item.key] = translation?.value || "";
        });

        console.log('[TEMPLATES] Using cached translations - loaded', Object.keys(values).length, 'fields');

        // Only update if values actually changed (prevent infinite loop)
        const hasChanged = Object.keys(values).length !== Object.keys(editableValues).length ||
          Object.keys(values).some(key => values[key] !== editableValues[key]);

        if (hasChanged) {
          console.log('[TEMPLATES] Updating editableValues from cached translations');
          setEditableValues(values);
          setOriginalValues({ ...values });
        }
      }
    }
    // IMPORTANT: We include loadedTranslations in dependencies to trigger when translations are loaded
    // The hasChanged check prevents infinite loops
  }, [selectedItem, currentLanguage, currentGroupId, primaryLocale, fetcher.state, loadedTranslations]);

  // Handle loaded translations from fetcher
  useEffect(() => {
    if (fetcher.data?.success && 'translations' in fetcher.data && 'locale' in fetcher.data) {
      const { translations, locale } = fetcher.data as any;
      const translationKey = `${currentGroupId}_${locale}`;

      console.log('[TEMPLATES] Fetcher returned translations:', {
        translationKey,
        translationCount: translations.length,
        locale,
        currentLanguage,
        isCurrentLanguage: locale === currentLanguage
      });

      setLoadedTranslations(prev => ({
        ...prev,
        [translationKey]: translations
      }));

      // Update editable values if this is the current language
      if (locale === currentLanguage && selectedItem) {
        const values: Record<string, string> = {};
        selectedItem.translatableContent?.forEach((item: any) => {
          const translation = translations.find((t: any) => t.key === item.key);
          values[item.key] = translation?.value || "";
        });
        console.log('[TEMPLATES] Directly updating editableValues from fetcher:', Object.keys(values).length, 'fields');
        setEditableValues(values);
        setOriginalValues({ ...values });
      }
    }
  }, [fetcher.data, currentLanguage, currentGroupId, selectedItem]);

  // Handle AI generation response
  useEffect(() => {
    if (fetcher.data?.success && 'generatedContent' in fetcher.data && 'fieldKey' in fetcher.data) {
      const { generatedContent, fieldKey } = fetcher.data as any;
      setAiSuggestions(prev => ({
        ...prev,
        [fieldKey]: generatedContent
      }));
    }
  }, [fetcher.data]);

  // Handle translated field response
  useEffect(() => {
    if (fetcher.data?.success && 'translatedValue' in fetcher.data && 'fieldKey' in fetcher.data) {
      const { translatedValue, fieldKey } = fetcher.data as any;
      setEditableValues(prev => ({
        ...prev,
        [fieldKey]: translatedValue
      }));
    }
  }, [fetcher.data]);

  // Handle translateAll response
  useEffect(() => {
    if (fetcher.data?.success && 'translatedFields' in fetcher.data) {
      const { translatedFields } = fetcher.data as any;
      setEditableValues(prev => ({
        ...prev,
        ...translatedFields
      }));
    }
  }, [fetcher.data]);

  // Handle item click: load data if not loaded, then select
  const handleItemClick = (itemId: string, groupId: string) => {
    if (hasChanges) {
      if (!confirm(t.content?.unsavedChanges || "You have unsaved changes. Do you want to discard them?")) {
        return;
      }
    }

    // If clicking the same item, force reload by clearing state
    const isSameItem = selectedItemId === itemId;

    console.log('[TEMPLATES] handleItemClick:', {
      itemId,
      groupId,
      isSameItem,
      currentLanguage,
      primaryLocale,
      isDataLoaded: !!loadedThemes[groupId]
    });

    setAiSuggestions({});

    if (isSameItem) {
      // Force reload: directly reload the values from the cached theme data
      console.log('[TEMPLATES] Same item clicked - force reloading values');

      const themeData = loadedThemes[groupId];
      if (themeData && themeData.translatableContent) {
        // Reload values based on current language
        if (currentLanguage === primaryLocale) {
          // Reload primary locale values
          const values: Record<string, string> = {};
          themeData.translatableContent.forEach((item: any) => {
            values[item.key] = item.value || "";
          });
          console.log('[TEMPLATES] Reloading primary locale values:', Object.keys(values).length, 'fields');
          setEditableValues(values);
          setOriginalValues({ ...values });
        } else {
          // Reload translation values
          const translationKey = `${groupId}_${currentLanguage}`;
          const translations = loadedTranslations[translationKey];

          if (translations) {
            const values: Record<string, string> = {};
            themeData.translatableContent.forEach((item: any) => {
              const translation = translations.find((t: any) => t.key === item.key);
              values[item.key] = translation?.value || "";
            });
            console.log('[TEMPLATES] Reloading translation values:', Object.keys(values).length, 'fields');
            setEditableValues(values);
            setOriginalValues({ ...values });
          }
        }
      }
    } else {
      // Different item: clear state and load new data
      console.log('[TEMPLATES] Different item clicked - clearing state and loading data');
      setSelectedItemId(itemId);
      setEditableValues({});
      setOriginalValues({});
      loadThemeData(groupId);
    }
  };

  const handleLanguageChange = (locale: string) => {
    if (hasChanges) {
      if (!confirm(t.content?.unsavedChanges || "You have unsaved changes. Do you want to discard them?")) {
        return;
      }
    }

    setCurrentLanguage(locale);
    setAiSuggestions({});
  };

  const handleValueChange = (key: string, value: string) => {
    setEditableValues(prev => ({
      ...prev,
      [key]: value
    }));
  };

  const handleGenerateAI = (fieldKey: string) => {
    if (!currentGroupId) return;

    const formData = new FormData();
    formData.append("action", "generateAIText");
    formData.append("fieldKey", fieldKey);
    formData.append("currentValue", editableValues[fieldKey] || "");

    fetcher.submit(formData, {
      method: "POST",
      action: `/api/templates/${currentGroupId}`
    });
  };

  const handleTranslate = (fieldKey: string) => {
    if (!currentGroupId || !selectedItem) return;

    // Get source text from primary locale
    const sourceItem = selectedItem.translatableContent?.find((item: any) => item.key === fieldKey);
    const sourceText = sourceItem?.value || "";

    if (!sourceText) {
      alert(t.content?.noSourceText || "No source text available for translation");
      return;
    }

    const formData = new FormData();
    formData.append("action", "translateField");
    formData.append("fieldKey", fieldKey);
    formData.append("sourceText", sourceText);
    formData.append("targetLocale", currentLanguage);
    formData.append("primaryLocale", primaryLocale);

    fetcher.submit(formData, {
      method: "POST",
      action: `/api/templates/${currentGroupId}`
    });
  };

  const handleTranslateAll = () => {
    if (!currentGroupId) return;

    const formData = new FormData();
    formData.append("action", "translateAll");
    formData.append("primaryLocale", primaryLocale);
    formData.append("targetLocale", currentLanguage);

    fetcher.submit(formData, {
      method: "POST",
      action: `/api/templates/${currentGroupId}`
    });
  };

  const handleAcceptSuggestion = (fieldKey: string) => {
    const suggestion = aiSuggestions[fieldKey];
    if (suggestion) {
      setEditableValues(prev => ({
        ...prev,
        [fieldKey]: suggestion
      }));
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

  const handleSave = () => {
    if (!currentGroupId || !hasChanges) return;

    // Collect only changed fields
    const changedFields: Record<string, string> = {};
    Object.keys(editableValues).forEach(key => {
      if (editableValues[key] !== originalValues[key]) {
        changedFields[key] = editableValues[key];
      }
    });

    const formData = new FormData();
    formData.append("action", "updateContent");
    formData.append("locale", currentLanguage);
    formData.append("primaryLocale", primaryLocale);
    formData.append("updatedFields", JSON.stringify(changedFields));

    fetcher.submit(formData, {
      method: "POST",
      action: `/api/templates/${currentGroupId}`
    });

    // Update original values
    setOriginalValues({ ...editableValues });
  };

  const handleDiscard = () => {
    setEditableValues({ ...originalValues });
    setAiSuggestions({});
  };

  return (
    <Page fullWidth>
      <MainNavigation />
      <ContentTypeNavigation />

      <div style={{ height: "calc(100vh - 120px)", display: "flex", gap: "1rem", padding: "1rem", overflow: "hidden" }}>
        {/* Left Sidebar - Theme Resources List */}
        <div style={{ width: "350px", flexShrink: 0 }}>
          <Card padding="0">
            <div style={{ padding: "1rem", borderBottom: "1px solid #e1e3e5" }}>
              <Text as="h2" variant="headingMd">
                {t.content?.templates || "Theme Content"} ({themes.length})
              </Text>
            </div>
            <div style={{ maxHeight: "calc(100vh - 200px)", overflowY: "auto" }}>
              {themes.length > 0 ? (
                <ResourceList
                  resourceName={{ singular: "Resource", plural: "Resources" }}
                  items={themes}
                  renderItem={(item: any) => {
                    const { id, title, icon, contentCount, groupId } = item;
                    const isSelected = selectedItemId === id;

                    return (
                      <ResourceItem
                        id={id}
                        onClick={() => handleItemClick(id, groupId)}
                      >
                        <BlockStack gap="100">
                          <Text as="p" variant="bodyMd" fontWeight={isSelected ? "bold" : "regular"}>
                            {icon && <span style={{ marginRight: "0.5rem" }}>{icon}</span>}
                            {title}
                          </Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            {contentCount} translatable fields
                          </Text>
                        </BlockStack>
                      </ResourceItem>
                    );
                  }}
                />
              ) : (
                <div style={{ padding: "2rem", textAlign: "center" }}>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {t.content?.noEntries || "No theme resources found"}
                  </Text>
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* Middle: Theme Content Viewer */}
        <div style={{ flex: 1, overflow: "auto", minWidth: 0 }}>
          {error && (
            <div style={{ marginBottom: "1rem" }}>
              <Banner title={t.content?.error || "Error"} tone="critical"><p>{error}</p></Banner>
            </div>
          )}

          <Card padding="600">
            {isLoading ? (
              <div style={{ textAlign: "center", padding: "4rem 2rem" }}>
                <BlockStack gap="300">
                  <Text as="p" variant="headingLg">
                    Loading...
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Loading theme content data
                  </Text>
                </BlockStack>
              </div>
            ) : selectedItem ? (
              <BlockStack gap="500">
                {/* Language Selector & Save Buttons */}
                <InlineStack align="space-between" blockAlign="center">
                  <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                    {shopLocales.map((locale: any) => (
                      <Button
                        key={locale.locale}
                        variant={currentLanguage === locale.locale ? "primary" : undefined}
                        onClick={() => handleLanguageChange(locale.locale)}
                        size="slim"
                      >
                        {locale.name} {locale.primary && `(${t.content?.primaryLanguageSuffix || "Primary"})`}
                      </Button>
                    ))}
                  </div>

                  {/* Save/Discard Buttons */}
                  {hasChanges && (
                    <div ref={saveButtonRef} style={{ display: "flex", gap: "0.5rem" }}>
                      <Button onClick={handleDiscard} size="slim">
                        {t.content?.discard || "Discard"}
                      </Button>
                      <Button
                        variant="primary"
                        onClick={handleSave}
                        loading={fetcher.state === "submitting"}
                        size="slim"
                      >
                        {t.content?.save || "Save"}
                      </Button>
                    </div>
                  )}
                </InlineStack>

                {/* Item ID */}
                <Text as="p" variant="bodySm" tone="subdued">
                  {t.content?.idPrefix || "ID:"} {selectedItem.id.split("/").pop()}
                </Text>

                {/* Success Banner */}
                {fetcher.data?.success && fetcher.state === "idle" && !('translations' in fetcher.data) && !('generatedContent' in fetcher.data) && !('translatedValue' in fetcher.data) && !('translatedFields' in fetcher.data) && (
                  <Banner tone="success">
                    <p>{t.content?.saveSuccess || "Changes saved successfully!"}</p>
                  </Banner>
                )}

                {/* Theme Content Viewer */}
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
              </BlockStack>
            ) : (
              <div style={{ textAlign: "center", padding: "4rem 2rem" }}>
                <Text as="p" variant="headingLg" tone="subdued">
                  {t.content?.selectFromList || "Select a theme resource from the list"}
                </Text>
              </div>
            )}
          </Card>
        </div>
      </div>
    </Page>
  );
}
