# Integration Anleitung: AI Instructions Tabs in Settings

## Status
- ✅ AIInstructionsTabs Komponente erstellt
- ✅ AIInstructionFieldGroup Komponente erstellt
- ✅ Default-Werte in aiInstructionsDefaults.ts
- ⏳ **TODO:** Integration in app.settings.tsx

## Was noch zu tun ist

Die `AIInstructionsTabs` Komponente muss in `app/routes/app.settings.tsx` integriert werden.

### Schritt 1: Import hinzufügen

Füge am Anfang der Datei hinzu (ca. Zeile 20):

```typescript
import { AIInstructionsTabs } from "../components/AIInstructionsTabs";
import { getDefaultInstructions, type EntityType } from "../constants/aiInstructionsDefaults";
```

### Schritt 2: State Variables erweitern

Die aktuellen State Variables für Instructions (ca. Zeile 312-330) müssen erweitert werden.

**Füge NACH den bestehenden Variablen hinzu:**

```typescript
// PRODUCTS (alte Variablen umbenennen)
const [productTitleFormat, setProductTitleFormat] = useState(loaderData.instructions?.productTitleFormat || "");
const [productTitleInstructions, setProductTitleInstructions] = useState(loaderData.instructions?.productTitleInstructions || "");
const [productDescriptionFormat, setProductDescriptionFormat] = useState(loaderData.instructions?.productDescriptionFormat || "");
const [productDescriptionInstructions, setProductDescriptionInstructions] = useState(loaderData.instructions?.productDescriptionInstructions || "");
const [productHandleFormat, setProductHandleFormat] = useState(loaderData.instructions?.productHandleFormat || "");
const [productHandleInstructions, setProductHandleInstructions] = useState(loaderData.instructions?.productHandleInstructions || "");
const [productSeoTitleFormat, setProductSeoTitleFormat] = useState(loaderData.instructions?.productSeoTitleFormat || "");
const [productSeoTitleInstructions, setProductSeoTitleInstructions] = useState(loaderData.instructions?.productSeoTitleInstructions || "");
const [productMetaDescFormat, setProductMetaDescFormat] = useState(loaderData.instructions?.productMetaDescFormat || "");
const [productMetaDescInstructions, setProductMetaDescInstructions] = useState(loaderData.instructions?.productMetaDescInstructions || "");
const [productAltTextFormat, setProductAltTextFormat] = useState(loaderData.instructions?.productAltTextFormat || "");
const [productAltTextInstructions, setProductAltTextInstructions] = useState(loaderData.instructions?.productAltTextInstructions || "");

// COLLECTIONS
const [collectionTitleFormat, setCollectionTitleFormat] = useState(loaderData.instructions?.collectionTitleFormat || "");
const [collectionTitleInstructions, setCollectionTitleInstructions] = useState(loaderData.instructions?.collectionTitleInstructions || "");
const [collectionDescriptionFormat, setCollectionDescriptionFormat] = useState(loaderData.instructions?.collectionDescriptionFormat || "");
const [collectionDescriptionInstructions, setCollectionDescriptionInstructions] = useState(loaderData.instructions?.collectionDescriptionInstructions || "");
const [collectionHandleFormat, setCollectionHandleFormat] = useState(loaderData.instructions?.collectionHandleFormat || "");
const [collectionHandleInstructions, setCollectionHandleInstructions] = useState(loaderData.instructions?.collectionHandleInstructions || "");
const [collectionSeoTitleFormat, setCollectionSeoTitleFormat] = useState(loaderData.instructions?.collectionSeoTitleFormat || "");
const [collectionSeoTitleInstructions, setCollectionSeoTitleInstructions] = useState(loaderData.instructions?.collectionSeoTitleInstructions || "");
const [collectionMetaDescFormat, setCollectionMetaDescFormat] = useState(loaderData.instructions?.collectionMetaDescFormat || "");
const [collectionMetaDescInstructions, setCollectionMetaDescInstructions] = useState(loaderData.instructions?.collectionMetaDescInstructions || "");

// BLOGS
const [blogTitleFormat, setBlogTitleFormat] = useState(loaderData.instructions?.blogTitleFormat || "");
const [blogTitleInstructions, setBlogTitleInstructions] = useState(loaderData.instructions?.blogTitleInstructions || "");
const [blogDescriptionFormat, setBlogDescriptionFormat] = useState(loaderData.instructions?.blogDescriptionFormat || "");
const [blogDescriptionInstructions, setBlogDescriptionInstructions] = useState(loaderData.instructions?.blogDescriptionInstructions || "");
const [blogHandleFormat, setBlogHandleFormat] = useState(loaderData.instructions?.blogHandleFormat || "");
const [blogHandleInstructions, setBlogHandleInstructions] = useState(loaderData.instructions?.blogHandleInstructions || "");
const [blogSeoTitleFormat, setBlogSeoTitleFormat] = useState(loaderData.instructions?.blogSeoTitleFormat || "");
const [blogSeoTitleInstructions, setBlogSeoTitleInstructions] = useState(loaderData.instructions?.blogSeoTitleInstructions || "");
const [blogMetaDescFormat, setBlogMetaDescFormat] = useState(loaderData.instructions?.blogMetaDescFormat || "");
const [blogMetaDescInstructions, setBlogMetaDescInstructions] = useState(loaderData.instructions?.blogMetaDescInstructions || "");

// PAGES
const [pageTitleFormat, setPageTitleFormat] = useState(loaderData.instructions?.pageTitleFormat || "");
const [pageTitleInstructions, setPageTitleInstructions] = useState(loaderData.instructions?.pageTitleInstructions || "");
const [pageDescriptionFormat, setPageDescriptionFormat] = useState(loaderData.instructions?.pageDescriptionFormat || "");
const [pageDescriptionInstructions, setPageDescriptionInstructions] = useState(loaderData.instructions?.pageDescriptionInstructions || "");
const [pageHandleFormat, setPageHandleFormat] = useState(loaderData.instructions?.pageHandleFormat || "");
const [pageHandleInstructions, setPageHandleInstructions] = useState(loaderData.instructions?.pageHandleInstructions || "");
const [pageSeoTitleFormat, setPageSeoTitleFormat] = useState(loaderData.instructions?.pageSeoTitleFormat || "");
const [pageSeoTitleInstructions, setPageSeoTitleInstructions] = useState(loaderData.instructions?.pageSeoTitleInstructions || "");
const [pageMetaDescFormat, setPageMetaDescFormat] = useState(loaderData.instructions?.pageMetaDescFormat || "");
const [pageMetaDescInstructions, setPageMetaDescInstructions] = useState(loaderData.instructions?.pageMetaDescInstructions || "");

// POLICIES
const [policyDescriptionFormat, setPolicyDescriptionFormat] = useState(loaderData.instructions?.policyDescriptionFormat || "");
const [policyDescriptionInstructions, setPolicyDescriptionInstructions] = useState(loaderData.instructions?.policyDescriptionInstructions || "");
```

**⚠️ WICHTIG:** Lösche die alten State Variables (titleFormat, titleInstructions, etc.) da diese jetzt product-spezifisch sind!

### Schritt 3: Helper Functions hinzufügen

Füge nach den State Variables hinzu:

```typescript
// Helper function to update any field
const handleFieldChange = (field: string, value: string) => {
  const setters: Record<string, (v: string) => void> = {
    productTitleFormat: setProductTitleFormat,
    productTitleInstructions: setProductTitleInstructions,
    productDescriptionFormat: setProductDescriptionFormat,
    productDescriptionInstructions: setProductDescriptionInstructions,
    productHandleFormat: setProductHandleFormat,
    productHandleInstructions: setProductHandleInstructions,
    productSeoTitleFormat: setProductSeoTitleFormat,
    productSeoTitleInstructions: setProductSeoTitleInstructions,
    productMetaDescFormat: setProductMetaDescFormat,
    productMetaDescInstructions: setProductMetaDescInstructions,
    productAltTextFormat: setProductAltTextFormat,
    productAltTextInstructions: setProductAltTextInstructions,

    collectionTitleFormat: setCollectionTitleFormat,
    collectionTitleInstructions: setCollectionTitleInstructions,
    collectionDescriptionFormat: setCollectionDescriptionFormat,
    collectionDescriptionInstructions: setCollectionDescriptionInstructions,
    collectionHandleFormat: setCollectionHandleFormat,
    collectionHandleInstructions: setCollectionHandleInstructions,
    collectionSeoTitleFormat: setCollectionSeoTitleFormat,
    collectionSeoTitleInstructions: setCollectionSeoTitleInstructions,
    collectionMetaDescFormat: setCollectionMetaDescFormat,
    collectionMetaDescInstructions: setCollectionMetaDescInstructions,

    blogTitleFormat: setBlogTitleFormat,
    blogTitleInstructions: setBlogTitleInstructions,
    blogDescriptionFormat: setBlogDescriptionFormat,
    blogDescriptionInstructions: setBlogDescriptionInstructions,
    blogHandleFormat: setBlogHandleFormat,
    blogHandleInstructions: setBlogHandleInstructions,
    blogSeoTitleFormat: setBlogSeoTitleFormat,
    blogSeoTitleInstructions: setBlogSeoTitleInstructions,
    blogMetaDescFormat: setBlogMetaDescFormat,
    blogMetaDescInstructions: setBlogMetaDescInstructions,

    pageTitleFormat: setPageTitleFormat,
    pageTitleInstructions: setPageTitleInstructions,
    pageDescriptionFormat: setPageDescriptionFormat,
    pageDescriptionInstructions: setPageDescriptionInstructions,
    pageHandleFormat: setPageHandleFormat,
    pageHandleInstructions: setPageHandleInstructions,
    pageSeoTitleFormat: setPageSeoTitleFormat,
    pageSeoTitleInstructions: setPageSeoTitleInstructions,
    pageMetaDescFormat: setPageMetaDescFormat,
    pageMetaDescInstructions: setPageMetaDescInstructions,

    policyDescriptionFormat: setPolicyDescriptionFormat,
    policyDescriptionInstructions: setPolicyDescriptionInstructions,
  };

  const setter = setters[field];
  if (setter) {
    setter(value);
  }
};

// Reset single field to default
const handleResetField = (field: string, entityType: EntityType) => {
  const defaults = getDefaultInstructions(entityType);
  const defaultValue = defaults[field as keyof typeof defaults] || "";
  handleFieldChange(field, defaultValue);

  // Also reset the corresponding instructions field if resetting format
  if (field.endsWith('Format')) {
    const instructionsField = field.replace('Format', 'Instructions');
    const instructionsDefault = defaults[instructionsField as keyof typeof defaults] || "";
    handleFieldChange(instructionsField, instructionsDefault);
  }
};

// Reset all fields for an entity
const handleResetAll = (entityType: EntityType) => {
  const defaults = getDefaultInstructions(entityType);

  Object.entries(defaults).forEach(([key, value]) => {
    const fullKey = `${entityType}${key.charAt(0).toUpperCase()}${key.slice(1)}`;
    handleFieldChange(fullKey, value);
  });
};
```

### Schritt 4: UI ersetzen

Suche nach der Stelle wo `{/* AI Instructions */}` steht (ca. Zeile 1305).

**Ersetze den gesamten Block von Zeile 1305 bis zum Ende der AI Instructions Section** mit:

```typescript
              {/* AI Instructions */}
              {selectedSection === "instructions" && (
                <Card>
                  <BlockStack gap="500">
                    <Text as="h2" variant="headingLg">
                      {t.settings.aiInstructionsTitle}
                    </Text>

                    <AIInstructionsTabs
                      // Products
                      productTitleFormat={productTitleFormat}
                      productTitleInstructions={productTitleInstructions}
                      productDescriptionFormat={productDescriptionFormat}
                      productDescriptionInstructions={productDescriptionInstructions}
                      productHandleFormat={productHandleFormat}
                      productHandleInstructions={productHandleInstructions}
                      productSeoTitleFormat={productSeoTitleFormat}
                      productSeoTitleInstructions={productSeoTitleInstructions}
                      productMetaDescFormat={productMetaDescFormat}
                      productMetaDescInstructions={productMetaDescInstructions}
                      productAltTextFormat={productAltTextFormat}
                      productAltTextInstructions={productAltTextInstructions}

                      // Collections
                      collectionTitleFormat={collectionTitleFormat}
                      collectionTitleInstructions={collectionTitleInstructions}
                      collectionDescriptionFormat={collectionDescriptionFormat}
                      collectionDescriptionInstructions={collectionDescriptionInstructions}
                      collectionHandleFormat={collectionHandleFormat}
                      collectionHandleInstructions={collectionHandleInstructions}
                      collectionSeoTitleFormat={collectionSeoTitleFormat}
                      collectionSeoTitleInstructions={collectionSeoTitleInstructions}
                      collectionMetaDescFormat={collectionMetaDescFormat}
                      collectionMetaDescInstructions={collectionMetaDescInstructions}

                      // Blogs
                      blogTitleFormat={blogTitleFormat}
                      blogTitleInstructions={blogTitleInstructions}
                      blogDescriptionFormat={blogDescriptionFormat}
                      blogDescriptionInstructions={blogDescriptionInstructions}
                      blogHandleFormat={blogHandleFormat}
                      blogHandleInstructions={blogHandleInstructions}
                      blogSeoTitleFormat={blogSeoTitleFormat}
                      blogSeoTitleInstructions={blogSeoTitleInstructions}
                      blogMetaDescFormat={blogMetaDescFormat}
                      blogMetaDescInstructions={blogMetaDescInstructions}

                      // Pages
                      pageTitleFormat={pageTitleFormat}
                      pageTitleInstructions={pageTitleInstructions}
                      pageDescriptionFormat={pageDescriptionFormat}
                      pageDescriptionInstructions={pageDescriptionInstructions}
                      pageHandleFormat={pageHandleFormat}
                      pageHandleInstructions={pageHandleInstructions}
                      pageSeoTitleFormat={pageSeoTitleFormat}
                      pageSeoTitleInstructions={pageSeoTitleInstructions}
                      pageMetaDescFormat={pageMetaDescFormat}
                      pageMetaDescInstructions={pageMetaDescInstructions}

                      // Policies
                      policyDescriptionFormat={policyDescriptionFormat}
                      policyDescriptionInstructions={policyDescriptionInstructions}

                      // Handlers
                      onFieldChange={handleFieldChange}
                      onResetField={handleResetField}
                      onResetAll={handleResetAll}
                    />

                    <InlineStack align="end">
                      <Button
                        variant={hasChanges ? "primary" : undefined}
                        onClick={handleSave}
                        disabled={!hasChanges}
                        loading={fetcher.state !== "idle"}
                      >
                        {t.products.saveChanges}
                      </Button>
                    </InlineStack>
                  </BlockStack>
                </Card>
              )}
```

### Schritt 5: Loader anpassen

Im `loader` Function (ca. Zeile 127-141), ersetze die `instructions:` Sektion mit:

```typescript
instructions: {
  // PRODUCTS
  productTitleFormat: instructions.productTitleFormat || "",
  productTitleInstructions: instructions.productTitleInstructions || "",
  productDescriptionFormat: instructions.productDescriptionFormat || "",
  productDescriptionInstructions: instructions.productDescriptionInstructions || "",
  productHandleFormat: instructions.productHandleFormat || "",
  productHandleInstructions: instructions.productHandleInstructions || "",
  productSeoTitleFormat: instructions.productSeoTitleFormat || "",
  productSeoTitleInstructions: instructions.productSeoTitleInstructions || "",
  productMetaDescFormat: instructions.productMetaDescFormat || "",
  productMetaDescInstructions: instructions.productMetaDescInstructions || "",
  productAltTextFormat: instructions.productAltTextFormat || "",
  productAltTextInstructions: instructions.productAltTextInstructions || "",

  // COLLECTIONS
  collectionTitleFormat: instructions.collectionTitleFormat || "",
  collectionTitleInstructions: instructions.collectionTitleInstructions || "",
  collectionDescriptionFormat: instructions.collectionDescriptionFormat || "",
  collectionDescriptionInstructions: instructions.collectionDescriptionInstructions || "",
  collectionHandleFormat: instructions.collectionHandleFormat || "",
  collectionHandleInstructions: instructions.collectionHandleInstructions || "",
  collectionSeoTitleFormat: instructions.collectionSeoTitleFormat || "",
  collectionSeoTitleInstructions: instructions.collectionSeoTitleInstructions || "",
  collectionMetaDescFormat: instructions.collectionMetaDescFormat || "",
  collectionMetaDescInstructions: instructions.collectionMetaDescInstructions || "",

  // BLOGS
  blogTitleFormat: instructions.blogTitleFormat || "",
  blogTitleInstructions: instructions.blogTitleInstructions || "",
  blogDescriptionFormat: instructions.blogDescriptionFormat || "",
  blogDescriptionInstructions: instructions.blogDescriptionInstructions || "",
  blogHandleFormat: instructions.blogHandleFormat || "",
  blogHandleInstructions: instructions.blogHandleInstructions || "",
  blogSeoTitleFormat: instructions.blogSeoTitleFormat || "",
  blogSeoTitleInstructions: instructions.blogSeoTitleInstructions || "",
  blogMetaDescFormat: instructions.blogMetaDescFormat || "",
  blogMetaDescInstructions: instructions.blogMetaDescInstructions || "",

  // PAGES
  pageTitleFormat: instructions.pageTitleFormat || "",
  pageTitleInstructions: instructions.pageTitleInstructions || "",
  pageDescriptionFormat: instructions.pageDescriptionFormat || "",
  pageDescriptionInstructions: instructions.pageDescriptionInstructions || "",
  pageHandleFormat: instructions.pageHandleFormat || "",
  pageHandleInstructions: instructions.pageHandleInstructions || "",
  pageSeoTitleFormat: instructions.pageSeoTitleFormat || "",
  pageSeoTitleInstructions: instructions.pageSeoTitleInstructions || "",
  pageMetaDescFormat: instructions.pageMetaDescFormat || "",
  pageMetaDescInstructions: instructions.pageMetaDescInstructions || "",

  // POLICIES
  policyDescriptionFormat: instructions.policyDescriptionFormat || "",
  policyDescriptionInstructions: instructions.policyDescriptionInstructions || "",
},
```

### Schritt 6: Action Handler anpassen

Im `action` Function, update die `sanitizedData` um alle neuen Felder einzuschließen.

Siehe vollständige Liste in [ENTITY_SPECIFIC_INSTRUCTIONS_IMPLEMENTATION.md](ENTITY_SPECIFIC_INSTRUCTIONS_IMPLEMENTATION.md).

### Schritt 7: Testen

Nach den Änderungen:

1. `npm run dev` lokal starten
2. Zu Settings → AI Instructions gehen
3. Tabs sollten sichtbar sein: Produkte, Collections, Blogs, Seiten, Richtlinien
4. Jeder Tab zeigt nur die relevanten Felder
5. "Zurücksetzen" Button sollte Default-Werte laden
6. "Alle Felder zurücksetzen" sollte alle Felder des aktuellen Tabs resetten

## Hilfe

Falls Probleme auftreten:
- Überprüfe die Browser Console auf Fehler
- Stelle sicher dass alle Imports korrekt sind
- Prüfe ob alle State Variables richtig benannt sind
- Siehe [ENTITY_SPECIFIC_INSTRUCTIONS_IMPLEMENTATION.md](ENTITY_SPECIFIC_INSTRUCTIONS_IMPLEMENTATION.md) für Details

---

**Erstellt:** 2025-01-13
**Status:** ⏳ Wartend auf Integration
