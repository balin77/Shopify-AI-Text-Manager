import { useState } from "react";
import { BlockStack, Text, Button, InlineStack, Tabs } from "@shopify/polaris";
import { AIInstructionFieldGroup } from "./AIInstructionFieldGroup";
import {
  getDefaultInstructions,
  getDefaultForField,
  type EntityType
} from "../constants/aiInstructionsDefaults";

interface AIInstructionsTabsProps {
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

  // Setters
  onFieldChange: (field: string, value: string) => void;
  onResetField: (field: string, entityType: EntityType) => void;
  onResetAll: (entityType: EntityType) => void;
}

export function AIInstructionsTabs(props: AIInstructionsTabsProps) {
  const [selectedTab, setSelectedTab] = useState(0);

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

  const handleResetAll = () => {
    props.onResetAll(currentEntityType);
  };

  return (
    <BlockStack gap="500">
      <Text as="p" variant="bodyMd" tone="subdued">
        Geben Sie für jedes Feld ein Formatbeispiel und spezifische Anweisungen an, an denen sich die KI orientieren soll.
      </Text>

      <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab}>
        <div style={{ marginTop: "1rem" }}>
          {/* Reset All Button */}
          <InlineStack align="end">
            <Button onClick={handleResetAll} tone="critical">
              Alle Felder zurücksetzen
            </Button>
          </InlineStack>

          <BlockStack gap="400" inlineAlign="stretch">
            {/* PRODUCTS TAB */}
            {selectedTab === 0 && (
              <>
                <AIInstructionFieldGroup
                  fieldName="Titel"
                  formatValue={props.productTitleFormat}
                  instructionsValue={props.productTitleInstructions}
                  onFormatChange={(v) => props.onFieldChange('productTitleFormat', v)}
                  onInstructionsChange={(v) => props.onFieldChange('productTitleInstructions', v)}
                  onReset={() => props.onResetField('productTitleFormat', 'products')}
                  formatPlaceholder="z.B. Premium Leder Geldbörse - Elegant & Langlebig"
                  instructionsPlaceholder="z.B. Maximal 60 Zeichen, Material und Hauptmerkmal nennen"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                />

                <AIInstructionFieldGroup
                  fieldName="Beschreibung"
                  formatValue={props.productDescriptionFormat}
                  instructionsValue={props.productDescriptionInstructions}
                  onFormatChange={(v) => props.onFieldChange('productDescriptionFormat', v)}
                  onInstructionsChange={(v) => props.onFieldChange('productDescriptionInstructions', v)}
                  onReset={() => props.onResetField('productDescriptionFormat', 'products')}
                  formatPlaceholder="z.B. <h2>Handwerkskunst in Perfektion</h2><p>Premium Leder...</p>"
                  instructionsPlaceholder="z.B. 150-250 Wörter, H2/H3 nutzen, Storytelling verwenden"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                  isHtmlField={true}
                />

                <AIInstructionFieldGroup
                  fieldName="URL-Handle"
                  formatValue={props.productHandleFormat}
                  instructionsValue={props.productHandleInstructions}
                  onFormatChange={(v) => props.onFieldChange('productHandleFormat', v)}
                  onInstructionsChange={(v) => props.onFieldChange('productHandleInstructions', v)}
                  onReset={() => props.onResetField('productHandleFormat', 'products')}
                  formatPlaceholder="z.B. premium-leder-geldboerse"
                  instructionsPlaceholder="z.B. Nur Kleinbuchstaben, Bindestriche, keine Umlaute, max 50 Zeichen"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                />

                <AIInstructionFieldGroup
                  fieldName="SEO-Titel"
                  formatValue={props.productSeoTitleFormat}
                  instructionsValue={props.productSeoTitleInstructions}
                  onFormatChange={(v) => props.onFieldChange('productSeoTitleFormat', v)}
                  onInstructionsChange={(v) => props.onFieldChange('productSeoTitleInstructions', v)}
                  onReset={() => props.onResetField('productSeoTitleFormat', 'products')}
                  formatPlaceholder="z.B. Premium Leder Geldbörse kaufen | Handgefertigt"
                  instructionsPlaceholder="z.B. 50-60 Zeichen, Hauptkeyword am Anfang, Call-to-Action"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                />

                <AIInstructionFieldGroup
                  fieldName="Meta-Beschreibung"
                  formatValue={props.productMetaDescFormat}
                  instructionsValue={props.productMetaDescInstructions}
                  onFormatChange={(v) => props.onFieldChange('productMetaDescFormat', v)}
                  onInstructionsChange={(v) => props.onFieldChange('productMetaDescInstructions', v)}
                  onReset={() => props.onResetField('productMetaDescFormat', 'products')}
                  formatPlaceholder="z.B. Handgefertigte Premium Leder Geldbörse. Zeitlos, langlebig..."
                  instructionsPlaceholder="z.B. 150-160 Zeichen, 2-3 Keywords, Handlungsaufforderung"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                />

                <AIInstructionFieldGroup
                  fieldName="Alt-Text (Bilder)"
                  formatValue={props.productAltTextFormat}
                  instructionsValue={props.productAltTextInstructions}
                  onFormatChange={(v) => props.onFieldChange('productAltTextFormat', v)}
                  onInstructionsChange={(v) => props.onFieldChange('productAltTextInstructions', v)}
                  onReset={() => props.onResetField('productAltTextFormat', 'products')}
                  formatPlaceholder="z.B. Premium Leder Geldbörse aus dunkelbraunem Vollrindleder"
                  instructionsPlaceholder="z.B. 60-125 Zeichen, beschreibe was zu sehen ist, sachlich"
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
                  formatValue={props.collectionTitleFormat}
                  instructionsValue={props.collectionTitleInstructions}
                  onFormatChange={(v) => props.onFieldChange('collectionTitleFormat', v)}
                  onInstructionsChange={(v) => props.onFieldChange('collectionTitleInstructions', v)}
                  onReset={() => props.onResetField('collectionTitleFormat', 'collections')}
                  formatPlaceholder="z.B. Leder Accessoires - Handgefertigt & Zeitlos"
                  instructionsPlaceholder="z.B. Maximal 50 Zeichen, Kategorie + USP"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                />

                <AIInstructionFieldGroup
                  fieldName="Beschreibung"
                  formatValue={props.collectionDescriptionFormat}
                  instructionsValue={props.collectionDescriptionInstructions}
                  onFormatChange={(v) => props.onFieldChange('collectionDescriptionFormat', v)}
                  onInstructionsChange={(v) => props.onFieldChange('collectionDescriptionInstructions', v)}
                  onReset={() => props.onResetField('collectionDescriptionFormat', 'collections')}
                  formatPlaceholder="z.B. <h2>Handgefertigte Leder Accessoires</h2><p>Entdecken Sie...</p>"
                  instructionsPlaceholder="z.B. 100-200 Wörter, Übersicht der Kategorie"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                  isHtmlField={true}
                />

                <AIInstructionFieldGroup
                  fieldName="URL-Handle"
                  formatValue={props.collectionHandleFormat}
                  instructionsValue={props.collectionHandleInstructions}
                  onFormatChange={(v) => props.onFieldChange('collectionHandleFormat', v)}
                  onInstructionsChange={(v) => props.onFieldChange('collectionHandleInstructions', v)}
                  onReset={() => props.onResetField('collectionHandleFormat', 'collections')}
                  formatPlaceholder="z.B. leder-accessoires"
                  instructionsPlaceholder="z.B. Nur Kleinbuchstaben, keine Umlaute, max 40 Zeichen"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                />

                <AIInstructionFieldGroup
                  fieldName="SEO-Titel"
                  formatValue={props.collectionSeoTitleFormat}
                  instructionsValue={props.collectionSeoTitleInstructions}
                  onFormatChange={(v) => props.onFieldChange('collectionSeoTitleFormat', v)}
                  onInstructionsChange={(v) => props.onFieldChange('collectionSeoTitleInstructions', v)}
                  onReset={() => props.onResetField('collectionSeoTitleFormat', 'collections')}
                  formatPlaceholder="z.B. Leder Accessoires kaufen | Handgefertigt"
                  instructionsPlaceholder="z.B. 50-60 Zeichen, Category-Keyword am Anfang"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                />

                <AIInstructionFieldGroup
                  fieldName="Meta-Beschreibung"
                  formatValue={props.collectionMetaDescFormat}
                  instructionsValue={props.collectionMetaDescInstructions}
                  onFormatChange={(v) => props.onFieldChange('collectionMetaDescFormat', v)}
                  onInstructionsChange={(v) => props.onFieldChange('collectionMetaDescInstructions', v)}
                  onReset={() => props.onResetField('collectionMetaDescFormat', 'collections')}
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
                  formatValue={props.blogTitleFormat}
                  instructionsValue={props.blogTitleInstructions}
                  onFormatChange={(v) => props.onFieldChange('blogTitleFormat', v)}
                  onInstructionsChange={(v) => props.onFieldChange('blogTitleInstructions', v)}
                  onReset={() => props.onResetField('blogTitleFormat', 'blogs')}
                  formatPlaceholder="z.B. 5 Tipps für die richtige Pflege Ihrer Lederprodukte"
                  instructionsPlaceholder="z.B. Maximal 60 Zeichen, Zahlen verwenden, Nutzen kommunizieren"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                />

                <AIInstructionFieldGroup
                  fieldName="Inhalt"
                  formatValue={props.blogDescriptionFormat}
                  instructionsValue={props.blogDescriptionInstructions}
                  onFormatChange={(v) => props.onFieldChange('blogDescriptionFormat', v)}
                  onInstructionsChange={(v) => props.onFieldChange('blogDescriptionInstructions', v)}
                  onReset={() => props.onResetField('blogDescriptionFormat', 'blogs')}
                  formatPlaceholder="z.B. <h2>1. Regelmäßiges Reinigen</h2><p>Entfernen Sie...</p>"
                  instructionsPlaceholder="z.B. 300-800 Wörter, H2/H3 Struktur, informativ"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                  isHtmlField={true}
                />

                <AIInstructionFieldGroup
                  fieldName="URL-Handle"
                  formatValue={props.blogHandleFormat}
                  instructionsValue={props.blogHandleInstructions}
                  onFormatChange={(v) => props.onFieldChange('blogHandleFormat', v)}
                  onInstructionsChange={(v) => props.onFieldChange('blogHandleInstructions', v)}
                  onReset={() => props.onResetField('blogHandleFormat', 'blogs')}
                  formatPlaceholder="z.B. lederpflege-tipps-anleitung"
                  instructionsPlaceholder="z.B. 3-5 Keywords, maximal 60 Zeichen"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                />

                <AIInstructionFieldGroup
                  fieldName="SEO-Titel"
                  formatValue={props.blogSeoTitleFormat}
                  instructionsValue={props.blogSeoTitleInstructions}
                  onFormatChange={(v) => props.onFieldChange('blogSeoTitleFormat', v)}
                  onInstructionsChange={(v) => props.onFieldChange('blogSeoTitleInstructions', v)}
                  onReset={() => props.onResetField('blogSeoTitleFormat', 'blogs')}
                  formatPlaceholder="z.B. Lederpflege: 5 Tipps | Expertenratgeber"
                  instructionsPlaceholder="z.B. 50-60 Zeichen, Zahlen nutzen, Expertise zeigen"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                />

                <AIInstructionFieldGroup
                  fieldName="Meta-Beschreibung"
                  formatValue={props.blogMetaDescFormat}
                  instructionsValue={props.blogMetaDescInstructions}
                  onFormatChange={(v) => props.onFieldChange('blogMetaDescFormat', v)}
                  onInstructionsChange={(v) => props.onFieldChange('blogMetaDescInstructions', v)}
                  onReset={() => props.onResetField('blogMetaDescFormat', 'blogs')}
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
                  formatValue={props.pageTitleFormat}
                  instructionsValue={props.pageTitleInstructions}
                  onFormatChange={(v) => props.onFieldChange('pageTitleFormat', v)}
                  onInstructionsChange={(v) => props.onFieldChange('pageTitleInstructions', v)}
                  onReset={() => props.onResetField('pageTitleFormat', 'pages')}
                  formatPlaceholder="z.B. Über uns - Traditionelle Handwerkskunst seit 1970"
                  instructionsPlaceholder="z.B. Maximal 60 Zeichen, klar und beschreibend"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                />

                <AIInstructionFieldGroup
                  fieldName="Inhalt"
                  formatValue={props.pageDescriptionFormat}
                  instructionsValue={props.pageDescriptionInstructions}
                  onFormatChange={(v) => props.onFieldChange('pageDescriptionFormat', v)}
                  onInstructionsChange={(v) => props.onFieldChange('pageDescriptionInstructions', v)}
                  onReset={() => props.onResetField('pageDescriptionFormat', 'pages')}
                  formatPlaceholder="z.B. <h1>Handwerkskunst mit Tradition</h1><p>Seit über 50 Jahren...</p>"
                  instructionsPlaceholder="z.B. 200-400 Wörter, authentisch, H1/H2 Struktur"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                  isHtmlField={true}
                />

                <AIInstructionFieldGroup
                  fieldName="URL-Handle"
                  formatValue={props.pageHandleFormat}
                  instructionsValue={props.pageHandleInstructions}
                  onFormatChange={(v) => props.onFieldChange('pageHandleFormat', v)}
                  onInstructionsChange={(v) => props.onFieldChange('pageHandleInstructions', v)}
                  onReset={() => props.onResetField('pageHandleFormat', 'pages')}
                  formatPlaceholder="z.B. ueber-uns, kontakt, impressum"
                  instructionsPlaceholder="z.B. 2-4 Keywords, maximal 40 Zeichen, Standard-Handles"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                />

                <AIInstructionFieldGroup
                  fieldName="SEO-Titel"
                  formatValue={props.pageSeoTitleFormat}
                  instructionsValue={props.pageSeoTitleInstructions}
                  onFormatChange={(v) => props.onFieldChange('pageSeoTitleFormat', v)}
                  onInstructionsChange={(v) => props.onFieldChange('pageSeoTitleInstructions', v)}
                  onReset={() => props.onResetField('pageSeoTitleFormat', 'pages')}
                  formatPlaceholder="z.B. Über uns - Traditionelle Lederverarbeitung"
                  instructionsPlaceholder="z.B. 50-60 Zeichen, Seitentyp am Anfang"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                />

                <AIInstructionFieldGroup
                  fieldName="Meta-Beschreibung"
                  formatValue={props.pageMetaDescFormat}
                  instructionsValue={props.pageMetaDescInstructions}
                  onFormatChange={(v) => props.onFieldChange('pageMetaDescFormat', v)}
                  onInstructionsChange={(v) => props.onFieldChange('pageMetaDescInstructions', v)}
                  onReset={() => props.onResetField('pageMetaDescFormat', 'pages')}
                  formatPlaceholder="z.B. Lernen Sie uns kennen: Seit 1970 fertigen wir..."
                  instructionsPlaceholder="z.B. 150-160 Zeichen, Seiteninhalt beschreiben"
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
                  formatValue={props.policyDescriptionFormat}
                  instructionsValue={props.policyDescriptionInstructions}
                  onFormatChange={(v) => props.onFieldChange('policyDescriptionFormat', v)}
                  onInstructionsChange={(v) => props.onFieldChange('policyDescriptionInstructions', v)}
                  onReset={() => props.onResetField('policyDescriptionFormat', 'policies')}
                  formatPlaceholder="z.B. <h2>Widerrufsrecht</h2><p>Sie haben das Recht...</p>"
                  instructionsPlaceholder="z.B. Rechtssicher formulieren, H2/H3, professionell"
                  formatLabel="Formatbeispiel"
                  instructionsLabel="Anweisungen"
                  isHtmlField={true}
                />
              </>
            )}
          </BlockStack>
        </div>
      </Tabs>
    </BlockStack>
  );
}
