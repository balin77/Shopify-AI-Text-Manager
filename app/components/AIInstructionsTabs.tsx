import { useState, useRef } from "react";
import { BlockStack, Text, Button, InlineStack } from "@shopify/polaris";
import { AIInstructionFieldGroup } from "./AIInstructionFieldGroup";
import {
  getDefaultInstructions,
  getDefaultForField,
  type EntityType
} from "../constants/aiInstructionsDefaults";
import type { FetcherWithComponents } from "@remix-run/react";

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
}

export function AIInstructionsTabs({ instructions, fetcher }: AIInstructionsTabsProps) {
  const [selectedTab, setSelectedTab] = useState(0);
  const [localInstructions, setLocalInstructions] = useState<Instructions>(instructions);
  const [htmlModes, setHtmlModes] = useState<Record<string, "html" | "rendered">>({});
  const editorRefs = useRef<Record<string, HTMLDivElement | null>>({});

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
    setLocalInstructions({ ...localInstructions, [field]: value });
  };

  const handleResetField = (field: string, entityType: EntityType) => {
    const defaultValue = getDefaultForField(entityType, field as any);
    setLocalInstructions({ ...localInstructions, [field]: defaultValue });
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

  const handleFormatHtml = (fieldName: string, command: string) => {
    const editor = editorRefs.current[fieldName];
    if (!editor) return;

    editor.focus();

    switch (command) {
      case "bold":
        document.execCommand("bold", false);
        break;
      case "italic":
        document.execCommand("italic", false);
        break;
      case "underline":
        document.execCommand("underline", false);
        break;
      case "h1":
        document.execCommand("formatBlock", false, "<h1>");
        break;
      case "h2":
        document.execCommand("formatBlock", false, "<h2>");
        break;
      case "h3":
        document.execCommand("formatBlock", false, "<h3>");
        break;
      case "ul":
        document.execCommand("insertUnorderedList", false);
        break;
      case "ol":
        document.execCommand("insertOrderedList", false);
        break;
      case "p":
        document.execCommand("formatBlock", false, "<p>");
        break;
      case "br":
        document.execCommand("insertHTML", false, "<br>");
        break;
    }

    // Update the field value after formatting
    handleFieldChange(fieldName, editor.innerHTML);
  };

  // Check if there are unsaved changes
  const hasChanges = JSON.stringify(localInstructions) !== JSON.stringify(instructions);

  return (
    <BlockStack gap="500">
      {/* Action Buttons on same level as tabs */}
      <InlineStack align="space-between" blockAlign="center">
        <Button onClick={handleResetAll} tone="critical">
          Alle Felder zurücksetzen
        </Button>
        <Button
          variant={hasChanges ? "primary" : undefined}
          onClick={handleSave}
          disabled={!hasChanges}
          loading={fetcher.state !== "idle"}
        >
          Änderungen speichern
        </Button>
      </InlineStack>

      {/* Custom Tab Navigation */}
      <div style={{
        background: "white",
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
      <div style={{ marginTop: "1rem" }}>
        {/* Description text below tabs */}
        <div style={{ marginBottom: "1rem" }}>
          <Text as="p" variant="bodyMd" tone="subdued">
            Geben Sie für jedes Feld ein Formatbeispiel und spezifische Anweisungen an, an denen sich die KI orientieren soll.
          </Text>
        </div>

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
                  onReset={() => handleResetField('productAltTextFormat', 'products')}
                  formatPlaceholder="z.B. Premium Leder Geldbörse aus dunkelbraunem Vollrindleder"
                  instructionsPlaceholder="z.B. 60-125 Zeichen, beschreibe was zu sehen ist, sachlich"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                />

                <AIInstructionFieldGroup
                  fieldName="Titel"
                  formatValue={localInstructions.productTitleFormat}
                  instructionsValue={localInstructions.productTitleInstructions}
                  onFormatChange={(v) => handleFieldChange('productTitleFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('productTitleInstructions', v)}
                  onReset={() => handleResetField('productTitleFormat', 'products')}
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
                  onReset={() => handleResetField('productDescriptionFormat', 'products')}
                  formatPlaceholder="z.B. <h2>Handwerkskunst in Perfektion</h2><p>Premium Leder...</p>"
                  instructionsPlaceholder="z.B. 150-250 Wörter, H2/H3 nutzen, Storytelling verwenden"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                  isHtmlField={true}
                  htmlMode={htmlModes['productDescriptionFormat'] || 'rendered'}
                  onToggleHtmlMode={() => handleToggleHtmlMode('productDescriptionFormat')}
                  onFormatHtml={(cmd) => handleFormatHtml('productDescriptionFormat', cmd)}
                  editorRef={(el) => { editorRefs.current['productDescriptionFormat'] = el; return { current: el }; }}
                />

                <AIInstructionFieldGroup
                  fieldName="URL-Handle"
                  formatValue={localInstructions.productHandleFormat}
                  instructionsValue={localInstructions.productHandleInstructions}
                  onFormatChange={(v) => handleFieldChange('productHandleFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('productHandleInstructions', v)}
                  onReset={() => handleResetField('productHandleFormat', 'products')}
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
                  onReset={() => handleResetField('productSeoTitleFormat', 'products')}
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
                  onReset={() => handleResetField('productMetaDescFormat', 'products')}
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
                  onReset={() => handleResetField('collectionTitleFormat', 'collections')}
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
                  onReset={() => handleResetField('collectionDescriptionFormat', 'collections')}
                  formatPlaceholder="z.B. <h2>Handgefertigte Leder Accessoires</h2><p>Entdecken Sie...</p>"
                  instructionsPlaceholder="z.B. 100-200 Wörter, Übersicht der Kategorie"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                  isHtmlField={true}
                  htmlMode={htmlModes['collectionDescriptionFormat'] || 'rendered'}
                  onToggleHtmlMode={() => handleToggleHtmlMode('collectionDescriptionFormat')}
                  onFormatHtml={(cmd) => handleFormatHtml('collectionDescriptionFormat', cmd)}
                  editorRef={(el) => { editorRefs.current['collectionDescriptionFormat'] = el; return { current: el }; }}
                />

                <AIInstructionFieldGroup
                  fieldName="URL-Handle"
                  formatValue={localInstructions.collectionHandleFormat}
                  instructionsValue={localInstructions.collectionHandleInstructions}
                  onFormatChange={(v) => handleFieldChange('collectionHandleFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('collectionHandleInstructions', v)}
                  onReset={() => handleResetField('collectionHandleFormat', 'collections')}
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
                  onReset={() => handleResetField('collectionSeoTitleFormat', 'collections')}
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
                  onReset={() => handleResetField('collectionMetaDescFormat', 'collections')}
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
                  onReset={() => handleResetField('blogTitleFormat', 'blogs')}
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
                  onReset={() => handleResetField('blogDescriptionFormat', 'blogs')}
                  formatPlaceholder="z.B. <h2>1. Regelmäßiges Reinigen</h2><p>Entfernen Sie...</p>"
                  instructionsPlaceholder="z.B. 300-800 Wörter, H2/H3 Struktur, informativ"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                  isHtmlField={true}
                  htmlMode={htmlModes['blogDescriptionFormat'] || 'rendered'}
                  onToggleHtmlMode={() => handleToggleHtmlMode('blogDescriptionFormat')}
                  onFormatHtml={(cmd) => handleFormatHtml('blogDescriptionFormat', cmd)}
                  editorRef={(el) => { editorRefs.current['blogDescriptionFormat'] = el; return { current: el }; }}
                />

                <AIInstructionFieldGroup
                  fieldName="URL-Handle"
                  formatValue={localInstructions.blogHandleFormat}
                  instructionsValue={localInstructions.blogHandleInstructions}
                  onFormatChange={(v) => handleFieldChange('blogHandleFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('blogHandleInstructions', v)}
                  onReset={() => handleResetField('blogHandleFormat', 'blogs')}
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
                  onReset={() => handleResetField('blogSeoTitleFormat', 'blogs')}
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
                  onReset={() => handleResetField('blogMetaDescFormat', 'blogs')}
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
                  onReset={() => handleResetField('pageTitleFormat', 'pages')}
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
                  onReset={() => handleResetField('pageDescriptionFormat', 'pages')}
                  formatPlaceholder="z.B. <h1>Handwerkskunst mit Tradition</h1><p>Seit über 50 Jahren...</p>"
                  instructionsPlaceholder="z.B. 200-400 Wörter, authentisch, H1/H2 Struktur"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                  isHtmlField={true}
                  htmlMode={htmlModes['pageDescriptionFormat'] || 'rendered'}
                  onToggleHtmlMode={() => handleToggleHtmlMode('pageDescriptionFormat')}
                  onFormatHtml={(cmd) => handleFormatHtml('pageDescriptionFormat', cmd)}
                  editorRef={(el) => { editorRefs.current['pageDescriptionFormat'] = el; return { current: el }; }}
                />

                <AIInstructionFieldGroup
                  fieldName="URL-Handle"
                  formatValue={localInstructions.pageHandleFormat}
                  instructionsValue={localInstructions.pageHandleInstructions}
                  onFormatChange={(v) => handleFieldChange('pageHandleFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('pageHandleInstructions', v)}
                  onReset={() => handleResetField('pageHandleFormat', 'pages')}
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
                  onReset={() => handleResetField('policyDescriptionFormat', 'policies')}
                  formatPlaceholder="z.B. <h2>Widerrufsrecht</h2><p>Sie haben das Recht...</p>"
                  instructionsPlaceholder="z.B. Rechtssicher formulieren, H2/H3, professionell"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                  isHtmlField={true}
                  htmlMode={htmlModes['policyDescriptionFormat'] || 'rendered'}
                  onToggleHtmlMode={() => handleToggleHtmlMode('policyDescriptionFormat')}
                  onFormatHtml={(cmd) => handleFormatHtml('policyDescriptionFormat', cmd)}
                  editorRef={(el) => { editorRefs.current['policyDescriptionFormat'] = el; return { current: el }; }}
                />
              </>
            )}
        </BlockStack>
      </div>
    </BlockStack>
  );
}
