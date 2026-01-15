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
      content: 'Produkte',
      panelID: 'products-panel',
    },
    {
      id: 'collections',
      content: 'Collections',
      panelID: 'collections-panel',
    },
    {
      id: 'blogs',
      content: 'Blogs',
      panelID: 'blogs-panel',
    },
    {
      id: 'pages',
      content: 'Seiten',
      panelID: 'pages-panel',
    },
    {
      id: 'policies',
      content: 'Richtlinien',
      panelID: 'policies-panel',
    },
  ];

  const currentEntityType = tabs[selectedTab].id as EntityType;

  const handleFieldChange = (field: string, value: string) => {
    if (readOnly) return; // Prevent changes in read-only mode
    setLocalInstructions({ ...localInstructions, [field]: value });
  };

  const handleResetFormatField = (formatField: string, entityType: EntityType) => {
    const defaultValue = getDefaultForField(entityType, formatField as any);
    setLocalInstructions({ ...localInstructions, [formatField]: defaultValue });
  };

  const handleResetInstructionsField = (instructionsField: string, entityType: EntityType) => {
    const defaultValue = getDefaultForField(entityType, instructionsField as any);
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
                  fieldName="Alt-Text (Bilder)"
                  formatValue={localInstructions.productAltTextFormat}
                  instructionsValue={localInstructions.productAltTextInstructions}
                  onFormatChange={(v) => handleFieldChange('productAltTextFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('productAltTextInstructions', v)}
                  onResetFormat={() => handleResetFormatField('productAltTextFormat', 'products')}
                  onResetInstructions={() => handleResetInstructionsField('productAltTextInstructions', 'products')}
                  formatPlaceholder="z.B. Premium Leder Geldbörse aus dunkelbraunem Vollrindleder"
                  instructionsPlaceholder="z.B. 60-125 Zeichen, beschreibe was zu sehen ist, sachlich"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                />

                <AIInstructionFieldGroup
                  fieldName="Titel"
                  formatValue={localInstructions.productTitleFormat}
                  instructionsValue={localInstructions.productTitleInstructions}
                  onFormatChange={(v) => handleFieldChange('productTitleFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('productTitleInstructions', v)}
                  onResetFormat={() => handleResetFormatField('productTitleFormat', 'products')}
                  onResetInstructions={() => handleResetInstructionsField('productTitleInstructions', 'products')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder="z.B. Premium Leder Geldbörse - Elegant & Langlebig"
                  instructionsPlaceholder="z.B. Maximal 60 Zeichen, Material und Hauptmerkmal nennen"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                />

                <AIInstructionFieldGroup
                  fieldName="Beschreibung"
                  formatValue={localInstructions.productDescriptionFormat}
                  instructionsValue={localInstructions.productDescriptionInstructions}
                  onFormatChange={(v) => handleFieldChange('productDescriptionFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('productDescriptionInstructions', v)}
                  onResetFormat={() => handleResetFormatField('productDescriptionFormat', 'products')}
                  onResetInstructions={() => handleResetInstructionsField('productDescriptionInstructions', 'products')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder="z.B. <h2>Handwerkskunst in Perfektion</h2><p>Premium Leder...</p>"
                  instructionsPlaceholder="z.B. 150-250 Wörter, H2/H3 nutzen, Storytelling verwenden"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                  isHtmlField={true}
                  htmlMode={htmlModes['productDescriptionFormat'] || 'rendered'}
                  onToggleHtmlMode={() => handleToggleHtmlMode('productDescriptionFormat')}
                />

                <AIInstructionFieldGroup
                  fieldName="URL-Handle"
                  formatValue={localInstructions.productHandleFormat}
                  instructionsValue={localInstructions.productHandleInstructions}
                  onFormatChange={(v) => handleFieldChange('productHandleFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('productHandleInstructions', v)}
                  onResetFormat={() => handleResetFormatField('productHandleFormat', 'products')}
                  onResetInstructions={() => handleResetInstructionsField('productHandleInstructions', 'products')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder="z.B. premium-leder-geldboerse"
                  instructionsPlaceholder="z.B. Nur Kleinbuchstaben, Bindestriche, keine Umlaute, max 50 Zeichen"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                />

                <AIInstructionFieldGroup
                  fieldName="SEO-Titel"
                  formatValue={localInstructions.productSeoTitleFormat}
                  instructionsValue={localInstructions.productSeoTitleInstructions}
                  onFormatChange={(v) => handleFieldChange('productSeoTitleFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('productSeoTitleInstructions', v)}
                  onResetFormat={() => handleResetFormatField('productSeoTitleFormat', 'products')}
                  onResetInstructions={() => handleResetInstructionsField('productSeoTitleInstructions', 'products')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder="z.B. Premium Leder Geldbörse kaufen | Handgefertigt"
                  instructionsPlaceholder="z.B. 50-60 Zeichen, Hauptkeyword am Anfang, Call-to-Action"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                />

                <AIInstructionFieldGroup
                  fieldName="Meta-Beschreibung"
                  formatValue={localInstructions.productMetaDescFormat}
                  instructionsValue={localInstructions.productMetaDescInstructions}
                  onFormatChange={(v) => handleFieldChange('productMetaDescFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('productMetaDescInstructions', v)}
                  onResetFormat={() => handleResetFormatField('productMetaDescFormat', 'products')}
                  onResetInstructions={() => handleResetInstructionsField('productMetaDescInstructions', 'products')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder="z.B. Handgefertigte Premium Leder Geldbörse. Zeitlos, langlebig..."
                  instructionsPlaceholder="z.B. 150-160 Zeichen, 2-3 Keywords, Handlungsaufforderung"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                />
              </>
            )}

            {/* COLLECTIONS TAB */}
            {selectedTab === 1 && (
              <>
                <AIInstructionFieldGroup
                  fieldName="Titel"
                  formatValue={localInstructions.collectionTitleFormat}
                  instructionsValue={localInstructions.collectionTitleInstructions}
                  onFormatChange={(v) => handleFieldChange('collectionTitleFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('collectionTitleInstructions', v)}
                  onResetFormat={() => handleResetFormatField('collectionTitleFormat', 'collections')}
                  onResetInstructions={() => handleResetInstructionsField('collectionTitleInstructions', 'collections')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder="z.B. Leder Accessoires - Handgefertigt & Zeitlos"
                  instructionsPlaceholder="z.B. Maximal 50 Zeichen, Kategorie + USP"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                />

                <AIInstructionFieldGroup
                  fieldName="Beschreibung"
                  formatValue={localInstructions.collectionDescriptionFormat}
                  instructionsValue={localInstructions.collectionDescriptionInstructions}
                  onFormatChange={(v) => handleFieldChange('collectionDescriptionFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('collectionDescriptionInstructions', v)}
                  onResetFormat={() => handleResetFormatField('collectionDescriptionFormat', 'collections')}
                  onResetInstructions={() => handleResetInstructionsField('collectionDescriptionInstructions', 'collections')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder="z.B. <h2>Handgefertigte Leder Accessoires</h2><p>Entdecken Sie...</p>"
                  instructionsPlaceholder="z.B. 100-200 Wörter, Übersicht der Kategorie"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                  isHtmlField={true}
                  htmlMode={htmlModes['collectionDescriptionFormat'] || 'rendered'}
                  onToggleHtmlMode={() => handleToggleHtmlMode('collectionDescriptionFormat')}
                />

                <AIInstructionFieldGroup
                  fieldName="URL-Handle"
                  formatValue={localInstructions.collectionHandleFormat}
                  instructionsValue={localInstructions.collectionHandleInstructions}
                  onFormatChange={(v) => handleFieldChange('collectionHandleFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('collectionHandleInstructions', v)}
                  onResetFormat={() => handleResetFormatField('collectionHandleFormat', 'collections')}
                  onResetInstructions={() => handleResetInstructionsField('collectionHandleInstructions', 'collections')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder="z.B. leder-accessoires"
                  instructionsPlaceholder="z.B. Nur Kleinbuchstaben, keine Umlaute, max 40 Zeichen"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                />

                <AIInstructionFieldGroup
                  fieldName="SEO-Titel"
                  formatValue={localInstructions.collectionSeoTitleFormat}
                  instructionsValue={localInstructions.collectionSeoTitleInstructions}
                  onFormatChange={(v) => handleFieldChange('collectionSeoTitleFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('collectionSeoTitleInstructions', v)}
                  onResetFormat={() => handleResetFormatField('collectionSeoTitleFormat', 'collections')}
                  onResetInstructions={() => handleResetInstructionsField('collectionSeoTitleInstructions', 'collections')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder="z.B. Leder Accessoires kaufen | Handgefertigt"
                  instructionsPlaceholder="z.B. 50-60 Zeichen, Category-Keyword am Anfang"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                />

                <AIInstructionFieldGroup
                  fieldName="Meta-Beschreibung"
                  formatValue={localInstructions.collectionMetaDescFormat}
                  instructionsValue={localInstructions.collectionMetaDescInstructions}
                  onFormatChange={(v) => handleFieldChange('collectionMetaDescFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('collectionMetaDescInstructions', v)}
                  onResetFormat={() => handleResetFormatField('collectionMetaDescFormat', 'collections')}
                  onResetInstructions={() => handleResetInstructionsField('collectionMetaDescInstructions', 'collections')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder="z.B. Hochwertige Leder Accessoires. Geldbörsen, Gürtel & mehr..."
                  instructionsPlaceholder="z.B. 150-160 Zeichen, Kategorie beschreiben, 2-3 Beispiele"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                />
              </>
            )}

            {/* BLOGS TAB */}
            {selectedTab === 2 && (
              <>
                <AIInstructionFieldGroup
                  fieldName="Titel"
                  formatValue={localInstructions.blogTitleFormat}
                  instructionsValue={localInstructions.blogTitleInstructions}
                  onFormatChange={(v) => handleFieldChange('blogTitleFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('blogTitleInstructions', v)}
                  onResetFormat={() => handleResetFormatField('blogTitleFormat', 'blogs')}
                  onResetInstructions={() => handleResetInstructionsField('blogTitleInstructions', 'blogs')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder="z.B. 5 Tipps für die richtige Pflege Ihrer Lederprodukte"
                  instructionsPlaceholder="z.B. Maximal 60 Zeichen, Zahlen verwenden, Nutzen kommunizieren"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                />

                <AIInstructionFieldGroup
                  fieldName="Inhalt"
                  formatValue={localInstructions.blogDescriptionFormat}
                  instructionsValue={localInstructions.blogDescriptionInstructions}
                  onFormatChange={(v) => handleFieldChange('blogDescriptionFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('blogDescriptionInstructions', v)}
                  onResetFormat={() => handleResetFormatField('blogDescriptionFormat', 'blogs')}
                  onResetInstructions={() => handleResetInstructionsField('blogDescriptionInstructions', 'blogs')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder="z.B. <h2>1. Regelmäßiges Reinigen</h2><p>Entfernen Sie...</p>"
                  instructionsPlaceholder="z.B. 300-800 Wörter, H2/H3 Struktur, informativ"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                  isHtmlField={true}
                  htmlMode={htmlModes['blogDescriptionFormat'] || 'rendered'}
                  onToggleHtmlMode={() => handleToggleHtmlMode('blogDescriptionFormat')}
                />

                <AIInstructionFieldGroup
                  fieldName="URL-Handle"
                  formatValue={localInstructions.blogHandleFormat}
                  instructionsValue={localInstructions.blogHandleInstructions}
                  onFormatChange={(v) => handleFieldChange('blogHandleFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('blogHandleInstructions', v)}
                  onResetFormat={() => handleResetFormatField('blogHandleFormat', 'blogs')}
                  onResetInstructions={() => handleResetInstructionsField('blogHandleInstructions', 'blogs')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder="z.B. lederpflege-tipps-anleitung"
                  instructionsPlaceholder="z.B. 3-5 Keywords, maximal 60 Zeichen"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                />

                <AIInstructionFieldGroup
                  fieldName="SEO-Titel"
                  formatValue={localInstructions.blogSeoTitleFormat}
                  instructionsValue={localInstructions.blogSeoTitleInstructions}
                  onFormatChange={(v) => handleFieldChange('blogSeoTitleFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('blogSeoTitleInstructions', v)}
                  onResetFormat={() => handleResetFormatField('blogSeoTitleFormat', 'blogs')}
                  onResetInstructions={() => handleResetInstructionsField('blogSeoTitleInstructions', 'blogs')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder="z.B. Lederpflege: 5 Tipps | Expertenratgeber"
                  instructionsPlaceholder="z.B. 50-60 Zeichen, Zahlen nutzen, Expertise zeigen"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                />

                <AIInstructionFieldGroup
                  fieldName="Meta-Beschreibung"
                  formatValue={localInstructions.blogMetaDescFormat}
                  instructionsValue={localInstructions.blogMetaDescInstructions}
                  onFormatChange={(v) => handleFieldChange('blogMetaDescFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('blogMetaDescInstructions', v)}
                  onResetFormat={() => handleResetFormatField('blogMetaDescFormat', 'blogs')}
                  onResetInstructions={() => handleResetInstructionsField('blogMetaDescInstructions', 'blogs')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder="z.B. Lederpflege leicht gemacht: 5 bewährte Tipps..."
                  instructionsPlaceholder="z.B. 150-160 Zeichen, Artikel-Nutzen zusammenfassen"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                />
              </>
            )}

            {/* PAGES TAB */}
            {selectedTab === 3 && (
              <>
                <AIInstructionFieldGroup
                  fieldName="Titel"
                  formatValue={localInstructions.pageTitleFormat}
                  instructionsValue={localInstructions.pageTitleInstructions}
                  onFormatChange={(v) => handleFieldChange('pageTitleFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('pageTitleInstructions', v)}
                  onResetFormat={() => handleResetFormatField('pageTitleFormat', 'pages')}
                  onResetInstructions={() => handleResetInstructionsField('pageTitleInstructions', 'pages')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder="z.B. Über uns - Traditionelle Handwerkskunst seit 1970"
                  instructionsPlaceholder="z.B. Maximal 60 Zeichen, klar und beschreibend"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                />

                <AIInstructionFieldGroup
                  fieldName="Inhalt"
                  formatValue={localInstructions.pageDescriptionFormat}
                  instructionsValue={localInstructions.pageDescriptionInstructions}
                  onFormatChange={(v) => handleFieldChange('pageDescriptionFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('pageDescriptionInstructions', v)}
                  onResetFormat={() => handleResetFormatField('pageDescriptionFormat', 'pages')}
                  onResetInstructions={() => handleResetInstructionsField('pageDescriptionInstructions', 'pages')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder="z.B. <h1>Handwerkskunst mit Tradition</h1><p>Seit über 50 Jahren...</p>"
                  instructionsPlaceholder="z.B. 200-400 Wörter, authentisch, H1/H2 Struktur"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                  isHtmlField={true}
                  htmlMode={htmlModes['pageDescriptionFormat'] || 'rendered'}
                  onToggleHtmlMode={() => handleToggleHtmlMode('pageDescriptionFormat')}
                />

                <AIInstructionFieldGroup
                  fieldName="URL-Handle"
                  formatValue={localInstructions.pageHandleFormat}
                  instructionsValue={localInstructions.pageHandleInstructions}
                  onFormatChange={(v) => handleFieldChange('pageHandleFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('pageHandleInstructions', v)}
                  onResetFormat={() => handleResetFormatField('pageHandleFormat', 'pages')}
                  onResetInstructions={() => handleResetInstructionsField('pageHandleInstructions', 'pages')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder="z.B. ueber-uns, kontakt, impressum"
                  instructionsPlaceholder="z.B. 2-4 Keywords, maximal 40 Zeichen, Standard-Handles"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                />
              </>
            )}

            {/* POLICIES TAB */}
            {selectedTab === 4 && (
              <>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Für Richtlinien (Datenschutz, AGB, Impressum, etc.) ist nur der Inhalt editierbar.
                </Text>

                <AIInstructionFieldGroup
                  fieldName="Inhalt"
                  formatValue={localInstructions.policyDescriptionFormat}
                  instructionsValue={localInstructions.policyDescriptionInstructions}
                  onFormatChange={(v) => handleFieldChange('policyDescriptionFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('policyDescriptionInstructions', v)}
                  onResetFormat={() => handleResetFormatField('policyDescriptionFormat', 'policies')}
                  onResetInstructions={() => handleResetInstructionsField('policyDescriptionInstructions', 'policies')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder="z.B. <h2>Widerrufsrecht</h2><p>Sie haben das Recht...</p>"
                  instructionsPlaceholder="z.B. Rechtssicher formulieren, H2/H3, professionell"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
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
