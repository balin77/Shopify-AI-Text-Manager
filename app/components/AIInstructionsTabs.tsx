import { useState, useEffect } from "react";
import { BlockStack, Text, Button, InlineStack, Card } from "@shopify/polaris";
import { AIInstructionFieldGroup } from "./AIInstructionFieldGroup";
import { SaveDiscardButtons } from "./SaveDiscardButtons";
import {
  getDefaultInstructions,
  getDefaultForField,
  type EntityType
} from "../constants/aiInstructionsDefaults";
import type { FetcherWithComponents } from "@remix-run/react";
import { useI18n } from "../contexts/I18nContext";

interface Instructions {
  // Products
  productTitleFormat: string;
  productTitleInstructions: string;
  productDescriptionFormat: string;
  productDescriptionInstructions: string;
  productHandleFormat: string;
  productHandleInstructions: string;
  productSeoTitleFormat: string;
  productSeoTitleInstructions: string;
  productMetaDescFormat: string;
  productMetaDescInstructions: string;
  productAltTextFormat: string;
  productAltTextInstructions: string;

  // Collections
  collectionTitleFormat: string;
  collectionTitleInstructions: string;
  collectionDescriptionFormat: string;
  collectionDescriptionInstructions: string;
  collectionHandleFormat: string;
  collectionHandleInstructions: string;
  collectionSeoTitleFormat: string;
  collectionSeoTitleInstructions: string;
  collectionMetaDescFormat: string;
  collectionMetaDescInstructions: string;

  // Blogs
  blogTitleFormat: string;
  blogTitleInstructions: string;
  blogDescriptionFormat: string;
  blogDescriptionInstructions: string;
  blogHandleFormat: string;
  blogHandleInstructions: string;
  blogSeoTitleFormat: string;
  blogSeoTitleInstructions: string;
  blogMetaDescFormat: string;
  blogMetaDescInstructions: string;

  // Pages
  pageTitleFormat: string;
  pageTitleInstructions: string;
  pageDescriptionFormat: string;
  pageDescriptionInstructions: string;
  pageHandleFormat: string;
  pageHandleInstructions: string;
  pageSeoTitleFormat: string;
  pageSeoTitleInstructions: string;
  pageMetaDescFormat: string;
  pageMetaDescInstructions: string;

  // Policies
  policyDescriptionFormat: string;
  policyDescriptionInstructions: string;
}

interface AIInstructionsTabsProps {
  instructions: Instructions;
  fetcher: FetcherWithComponents<any>;
  readOnly?: boolean;
  onHasChangesChange?: (hasChanges: boolean) => void;
}

export function AIInstructionsTabs({ instructions, fetcher, readOnly = false, onHasChangesChange }: AIInstructionsTabsProps) {
  const { t } = useI18n();
  const [selectedTab, setSelectedTab] = useState(0);
  const [localInstructions, setLocalInstructions] = useState<Instructions>(instructions);
  const [htmlModes, setHtmlModes] = useState<Record<string, "html" | "rendered">>({});

  const tabs = [
    {
      id: 'products',
      content: t.settings.tabProducts,
      panelID: 'products-panel',
    },
    {
      id: 'collections',
      content: t.settings.tabCollections,
      panelID: 'collections-panel',
    },
    {
      id: 'blogs',
      content: t.settings.tabBlogs,
      panelID: 'blogs-panel',
    },
    {
      id: 'pages',
      content: t.settings.tabPages,
      panelID: 'pages-panel',
    },
    {
      id: 'policies',
      content: t.settings.tabPolicies,
      panelID: 'policies-panel',
    },
  ];

  const currentEntityType = tabs[selectedTab].id as EntityType;

  const handleFieldChange = (field: string, value: string) => {
    if (readOnly) return; // Prevent changes in read-only mode
    setLocalInstructions({ ...localInstructions, [field]: value });
  };

  // Map full field names (e.g., 'productTitleFormat') to EntityInstructions keys (e.g., 'titleFormat')
  const getEntityFieldName = (fullFieldName: string, entityType: EntityType): string => {
    const prefix = entityType === 'products' ? 'product' :
                   entityType === 'collections' ? 'collection' :
                   entityType === 'blogs' ? 'blog' :
                   entityType === 'pages' ? 'page' : 'policy';

    // Remove prefix to get the field name: 'productTitleFormat' -> 'TitleFormat'
    const withoutPrefix = fullFieldName.replace(new RegExp(`^${prefix}`, 'i'), '');

    // Lowercase first letter: 'TitleFormat' -> 'titleFormat'
    return withoutPrefix.charAt(0).toLowerCase() + withoutPrefix.slice(1);
  };

  const handleResetFormatField = (formatField: string, entityType: EntityType) => {
    const entityFieldName = getEntityFieldName(formatField, entityType);
    const defaultValue = getDefaultForField(entityType, entityFieldName as any);
    setLocalInstructions({ ...localInstructions, [formatField]: defaultValue });
  };

  const handleResetInstructionsField = (instructionsField: string, entityType: EntityType) => {
    const entityFieldName = getEntityFieldName(instructionsField, entityType);
    const defaultValue = getDefaultForField(entityType, entityFieldName as any);
    setLocalInstructions({ ...localInstructions, [instructionsField]: defaultValue });
  };

  const handleResetAll = () => {
    const defaults = getDefaultInstructions(currentEntityType);
    setLocalInstructions({ ...localInstructions, ...defaults });
  };

  const handleSave = () => {
    const formData = new FormData();
    formData.append("actionType", "saveInstructions");

    // Add all instruction fields to FormData
    Object.entries(localInstructions).forEach(([key, value]) => {
      formData.append(key, value);
    });

    fetcher.submit(formData, { method: "POST" });
  };

  const handleToggleHtmlMode = (fieldName: string) => {
    setHtmlModes((prev) => ({
      ...prev,
      [fieldName]: prev[fieldName] === "html" ? "rendered" : "html",
    }));
  };

  // Check if there are unsaved changes
  const hasChanges = JSON.stringify(localInstructions) !== JSON.stringify(instructions);

  // Propagate hasChanges to parent component
  useEffect(() => {
    if (onHasChangesChange) {
      onHasChangesChange(hasChanges);
    }
  }, [hasChanges, onHasChangesChange]);

  const handleDiscard = () => {
    setLocalInstructions(instructions);
  };

  return (
    <Card>
      <BlockStack gap="500">
        {/* Header with Title and Save/Discard Buttons */}
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingLg">
            {t.settings.aiInstructions}
          </Text>
          {!readOnly && (
            <SaveDiscardButtons
              hasChanges={hasChanges}
              onSave={handleSave}
              onDiscard={handleDiscard}
              saveText={t.products?.saveChanges || "Änderungen speichern"}
              discardText={t.content?.discardChanges || "Verwerfen"}
              action="saveInstructions"
              fetcherState={fetcher.state}
              fetcherFormData={fetcher.formData}
            />
          )}
        </InlineStack>

        {/* Description */}
        <Text as="p" variant="bodyMd" tone="subdued">
          {readOnly
            ? t.settings.defaultInstructionsReadOnly
            : t.settings.aiInstructionsDescription
          }
        </Text>

        {/* Custom Tab Navigation */}
        <div style={{
          background: "#f6f6f7",
          borderRadius: "8px",
          padding: "1rem",
          borderBottom: "1px solid #e1e3e5",
        }}>
        <InlineStack gap="400">
          {tabs.map((tab, index) => {
            const isActive = selectedTab === index;
            return (
              <button
                key={tab.id}
                onClick={() => setSelectedTab(index)}
                style={{
                  textDecoration: "none",
                  padding: "1rem 0.5rem",
                  transition: "border-color 0.2s",
                  background: "none",
                  border: "none",
                  borderBottom: isActive ? "3px solid #303030" : "3px solid transparent",
                  cursor: "pointer",
                }}
              >
                <Text
                  as="span"
                  variant="bodyMd"
                  fontWeight={isActive ? "bold" : "regular"}
                  tone="base"
                >
                  {tab.content}
                </Text>
              </button>
            );
          })}
        </InlineStack>
      </div>

      {/* Tab Content */}
      <div style={{ opacity: readOnly ? 0.6 : 1, pointerEvents: readOnly ? "none" : "auto" }}>
        <BlockStack gap="400" inlineAlign="stretch">
            {/* PRODUCTS TAB */}
            {selectedTab === 0 && (
              <>
                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldAltText}
                  formatValue={localInstructions.productAltTextFormat}
                  instructionsValue={localInstructions.productAltTextInstructions}
                  onFormatChange={(v) => handleFieldChange('productAltTextFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('productAltTextInstructions', v)}
                  onResetFormat={() => handleResetFormatField('productAltTextFormat', 'products')}
                  onResetInstructions={() => handleResetInstructionsField('productAltTextInstructions', 'products')}
                  formatPlaceholder={t.settings.productAltTextFormatPlaceholder}
                  instructionsPlaceholder={t.settings.productAltTextInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                />

                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldTitle}
                  formatValue={localInstructions.productTitleFormat}
                  instructionsValue={localInstructions.productTitleInstructions}
                  onFormatChange={(v) => handleFieldChange('productTitleFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('productTitleInstructions', v)}
                  onResetFormat={() => handleResetFormatField('productTitleFormat', 'products')}
                  onResetInstructions={() => handleResetInstructionsField('productTitleInstructions', 'products')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder={t.settings.productTitleFormatPlaceholder}
                  instructionsPlaceholder={t.settings.productTitleInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                />

                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldDescription}
                  formatValue={localInstructions.productDescriptionFormat}
                  instructionsValue={localInstructions.productDescriptionInstructions}
                  onFormatChange={(v) => handleFieldChange('productDescriptionFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('productDescriptionInstructions', v)}
                  onResetFormat={() => handleResetFormatField('productDescriptionFormat', 'products')}
                  onResetInstructions={() => handleResetInstructionsField('productDescriptionInstructions', 'products')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder={t.settings.productDescriptionFormatPlaceholder}
                  instructionsPlaceholder={t.settings.productDescriptionInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                  isHtmlField={true}
                  htmlMode={htmlModes['productDescriptionFormat'] || 'rendered'}
                  onToggleHtmlMode={() => handleToggleHtmlMode('productDescriptionFormat')}
                />

                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldUrlHandle}
                  formatValue={localInstructions.productHandleFormat}
                  instructionsValue={localInstructions.productHandleInstructions}
                  onFormatChange={(v) => handleFieldChange('productHandleFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('productHandleInstructions', v)}
                  onResetFormat={() => handleResetFormatField('productHandleFormat', 'products')}
                  onResetInstructions={() => handleResetInstructionsField('productHandleInstructions', 'products')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder={t.settings.productHandleFormatPlaceholder}
                  instructionsPlaceholder={t.settings.productHandleInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                />

                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldSeoTitle}
                  formatValue={localInstructions.productSeoTitleFormat}
                  instructionsValue={localInstructions.productSeoTitleInstructions}
                  onFormatChange={(v) => handleFieldChange('productSeoTitleFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('productSeoTitleInstructions', v)}
                  onResetFormat={() => handleResetFormatField('productSeoTitleFormat', 'products')}
                  onResetInstructions={() => handleResetInstructionsField('productSeoTitleInstructions', 'products')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder={t.settings.productSeoTitleFormatPlaceholder}
                  instructionsPlaceholder={t.settings.productSeoTitleInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                />

                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldMetaDescription}
                  formatValue={localInstructions.productMetaDescFormat}
                  instructionsValue={localInstructions.productMetaDescInstructions}
                  onFormatChange={(v) => handleFieldChange('productMetaDescFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('productMetaDescInstructions', v)}
                  onResetFormat={() => handleResetFormatField('productMetaDescFormat', 'products')}
                  onResetInstructions={() => handleResetInstructionsField('productMetaDescInstructions', 'products')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder={t.settings.productMetaDescFormatPlaceholder}
                  instructionsPlaceholder={t.settings.productMetaDescInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                />
              </>
            )}

            {/* COLLECTIONS TAB */}
            {selectedTab === 1 && (
              <>
                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldTitle}
                  formatValue={localInstructions.collectionTitleFormat}
                  instructionsValue={localInstructions.collectionTitleInstructions}
                  onFormatChange={(v) => handleFieldChange('collectionTitleFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('collectionTitleInstructions', v)}
                  onResetFormat={() => handleResetFormatField('collectionTitleFormat', 'collections')}
                  onResetInstructions={() => handleResetInstructionsField('collectionTitleInstructions', 'collections')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder={t.settings.collectionTitleFormatPlaceholder}
                  instructionsPlaceholder={t.settings.collectionTitleInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                />

                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldDescription}
                  formatValue={localInstructions.collectionDescriptionFormat}
                  instructionsValue={localInstructions.collectionDescriptionInstructions}
                  onFormatChange={(v) => handleFieldChange('collectionDescriptionFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('collectionDescriptionInstructions', v)}
                  onResetFormat={() => handleResetFormatField('collectionDescriptionFormat', 'collections')}
                  onResetInstructions={() => handleResetInstructionsField('collectionDescriptionInstructions', 'collections')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder={t.settings.collectionDescriptionFormatPlaceholder}
                  instructionsPlaceholder={t.settings.collectionDescriptionInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                  isHtmlField={true}
                  htmlMode={htmlModes['collectionDescriptionFormat'] || 'rendered'}
                  onToggleHtmlMode={() => handleToggleHtmlMode('collectionDescriptionFormat')}
                />

                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldUrlHandle}
                  formatValue={localInstructions.collectionHandleFormat}
                  instructionsValue={localInstructions.collectionHandleInstructions}
                  onFormatChange={(v) => handleFieldChange('collectionHandleFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('collectionHandleInstructions', v)}
                  onResetFormat={() => handleResetFormatField('collectionHandleFormat', 'collections')}
                  onResetInstructions={() => handleResetInstructionsField('collectionHandleInstructions', 'collections')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder={t.settings.collectionHandleFormatPlaceholder}
                  instructionsPlaceholder={t.settings.collectionHandleInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                />

                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldSeoTitle}
                  formatValue={localInstructions.collectionSeoTitleFormat}
                  instructionsValue={localInstructions.collectionSeoTitleInstructions}
                  onFormatChange={(v) => handleFieldChange('collectionSeoTitleFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('collectionSeoTitleInstructions', v)}
                  onResetFormat={() => handleResetFormatField('collectionSeoTitleFormat', 'collections')}
                  onResetInstructions={() => handleResetInstructionsField('collectionSeoTitleInstructions', 'collections')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder={t.settings.collectionSeoTitleFormatPlaceholder}
                  instructionsPlaceholder={t.settings.collectionSeoTitleInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                />

                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldMetaDescription}
                  formatValue={localInstructions.collectionMetaDescFormat}
                  instructionsValue={localInstructions.collectionMetaDescInstructions}
                  onFormatChange={(v) => handleFieldChange('collectionMetaDescFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('collectionMetaDescInstructions', v)}
                  onResetFormat={() => handleResetFormatField('collectionMetaDescFormat', 'collections')}
                  onResetInstructions={() => handleResetInstructionsField('collectionMetaDescInstructions', 'collections')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder={t.settings.collectionMetaDescFormatPlaceholder}
                  instructionsPlaceholder={t.settings.collectionMetaDescInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                />
              </>
            )}

            {/* BLOGS TAB */}
            {selectedTab === 2 && (
              <>
                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldTitle}
                  formatValue={localInstructions.blogTitleFormat}
                  instructionsValue={localInstructions.blogTitleInstructions}
                  onFormatChange={(v) => handleFieldChange('blogTitleFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('blogTitleInstructions', v)}
                  onResetFormat={() => handleResetFormatField('blogTitleFormat', 'blogs')}
                  onResetInstructions={() => handleResetInstructionsField('blogTitleInstructions', 'blogs')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder={t.settings.blogTitleFormatPlaceholder}
                  instructionsPlaceholder={t.settings.blogTitleInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                />

                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldContent}
                  formatValue={localInstructions.blogDescriptionFormat}
                  instructionsValue={localInstructions.blogDescriptionInstructions}
                  onFormatChange={(v) => handleFieldChange('blogDescriptionFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('blogDescriptionInstructions', v)}
                  onResetFormat={() => handleResetFormatField('blogDescriptionFormat', 'blogs')}
                  onResetInstructions={() => handleResetInstructionsField('blogDescriptionInstructions', 'blogs')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder={t.settings.blogDescriptionFormatPlaceholder}
                  instructionsPlaceholder={t.settings.blogDescriptionInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                  isHtmlField={true}
                  htmlMode={htmlModes['blogDescriptionFormat'] || 'rendered'}
                  onToggleHtmlMode={() => handleToggleHtmlMode('blogDescriptionFormat')}
                />

                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldUrlHandle}
                  formatValue={localInstructions.blogHandleFormat}
                  instructionsValue={localInstructions.blogHandleInstructions}
                  onFormatChange={(v) => handleFieldChange('blogHandleFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('blogHandleInstructions', v)}
                  onResetFormat={() => handleResetFormatField('blogHandleFormat', 'blogs')}
                  onResetInstructions={() => handleResetInstructionsField('blogHandleInstructions', 'blogs')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder={t.settings.blogHandleFormatPlaceholder}
                  instructionsPlaceholder={t.settings.blogHandleInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                />

                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldSeoTitle}
                  formatValue={localInstructions.blogSeoTitleFormat}
                  instructionsValue={localInstructions.blogSeoTitleInstructions}
                  onFormatChange={(v) => handleFieldChange('blogSeoTitleFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('blogSeoTitleInstructions', v)}
                  onResetFormat={() => handleResetFormatField('blogSeoTitleFormat', 'blogs')}
                  onResetInstructions={() => handleResetInstructionsField('blogSeoTitleInstructions', 'blogs')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder={t.settings.blogSeoTitleFormatPlaceholder}
                  instructionsPlaceholder={t.settings.blogSeoTitleInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                />

                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldMetaDescription}
                  formatValue={localInstructions.blogMetaDescFormat}
                  instructionsValue={localInstructions.blogMetaDescInstructions}
                  onFormatChange={(v) => handleFieldChange('blogMetaDescFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('blogMetaDescInstructions', v)}
                  onResetFormat={() => handleResetFormatField('blogMetaDescFormat', 'blogs')}
                  onResetInstructions={() => handleResetInstructionsField('blogMetaDescInstructions', 'blogs')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder={t.settings.blogMetaDescFormatPlaceholder}
                  instructionsPlaceholder={t.settings.blogMetaDescInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                />
              </>
            )}

            {/* PAGES TAB */}
            {selectedTab === 3 && (
              <>
                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldTitle}
                  formatValue={localInstructions.pageTitleFormat}
                  instructionsValue={localInstructions.pageTitleInstructions}
                  onFormatChange={(v) => handleFieldChange('pageTitleFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('pageTitleInstructions', v)}
                  onResetFormat={() => handleResetFormatField('pageTitleFormat', 'pages')}
                  onResetInstructions={() => handleResetInstructionsField('pageTitleInstructions', 'pages')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder={t.settings.pageTitleFormatPlaceholder}
                  instructionsPlaceholder={t.settings.pageTitleInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                />

                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldContent}
                  formatValue={localInstructions.pageDescriptionFormat}
                  instructionsValue={localInstructions.pageDescriptionInstructions}
                  onFormatChange={(v) => handleFieldChange('pageDescriptionFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('pageDescriptionInstructions', v)}
                  onResetFormat={() => handleResetFormatField('pageDescriptionFormat', 'pages')}
                  onResetInstructions={() => handleResetInstructionsField('pageDescriptionInstructions', 'pages')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder={t.settings.pageDescriptionFormatPlaceholder}
                  instructionsPlaceholder={t.settings.pageDescriptionInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                  isHtmlField={true}
                  htmlMode={htmlModes['pageDescriptionFormat'] || 'rendered'}
                  onToggleHtmlMode={() => handleToggleHtmlMode('pageDescriptionFormat')}
                />

                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldUrlHandle}
                  formatValue={localInstructions.pageHandleFormat}
                  instructionsValue={localInstructions.pageHandleInstructions}
                  onFormatChange={(v) => handleFieldChange('pageHandleFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('pageHandleInstructions', v)}
                  onResetFormat={() => handleResetFormatField('pageHandleFormat', 'pages')}
                  onResetInstructions={() => handleResetInstructionsField('pageHandleInstructions', 'pages')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder={t.settings.pageHandleFormatPlaceholder}
                  instructionsPlaceholder={t.settings.pageHandleInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                />
              </>
            )}

            {/* POLICIES TAB */}
            {selectedTab === 4 && (
              <>
                <Text as="p" variant="bodyMd" tone="subdued">
                  {t.settings.policyNotice}
                </Text>

                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldContent}
                  formatValue={localInstructions.policyDescriptionFormat}
                  instructionsValue={localInstructions.policyDescriptionInstructions}
                  onFormatChange={(v) => handleFieldChange('policyDescriptionFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('policyDescriptionInstructions', v)}
                  onResetFormat={() => handleResetFormatField('policyDescriptionFormat', 'policies')}
                  onResetInstructions={() => handleResetInstructionsField('policyDescriptionInstructions', 'policies')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder={t.settings.policyDescriptionFormatPlaceholder}
                  instructionsPlaceholder={t.settings.policyDescriptionInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                  isHtmlField={true}
                  htmlMode={htmlModes['policyDescriptionFormat'] || 'rendered'}
                  onToggleHtmlMode={() => handleToggleHtmlMode('policyDescriptionFormat')}
                />
              </>
            )}
        </BlockStack>
      </div>

      {/* Reset All Button at bottom */}
      {!readOnly && (
        <div style={{ paddingTop: "1rem", borderTop: "1px solid #e1e3e5" }}>
          <InlineStack align="start">
            <Button onClick={handleResetAll} tone="critical">
              {t.settings?.resetAllFields || "Alle Felder zurücksetzen"}
            </Button>
          </InlineStack>
        </div>
      )}
    </BlockStack>
    </Card>
  );
}
