# Entity-Specific AI Instructions - Implementation Guide

## Completed
✅ Created default instructions with SEO best practices ([app/constants/aiInstructionsDefaults.ts](app/constants/aiInstructionsDefaults.ts))
✅ Updated database schema with entity-specific fields ([prisma/schema.prisma](prisma/schema.prisma))
✅ Created SQL migration file ([prisma/migrations/add_entity_specific_ai_instructions.sql](prisma/migrations/add_entity_specific_ai_instructions.sql))
✅ Updated validation schema ([app/utils/validation.ts](app/utils/validation.ts))
✅ Created reusable field component ([app/components/AIInstructionFieldGroup.tsx](app/components/AIInstructionFieldGroup.tsx))

## Still Todo

### 1. Run Database Migration

**🚀 Für Railway (siehe [QUICK_START_MIGRATION.md](QUICK_START_MIGRATION.md)):**
```bash
# Setze Custom Start Command in Railway auf:
npm run start:railway
```

**💻 Lokal oder manuell:**
```bash
# Option 1: Mit dem neuen Script (empfohlen)
npm run prisma:migrate:new

# Option 2: Direkt mit Prisma
npx prisma db push

# Option 3: SQL-Datei direkt ausführen
psql "$DATABASE_URL" -f prisma/migrations/add_entity_specific_ai_instructions.sql
```

**Siehe auch:**
- [RAILWAY_DEPLOYMENT.md](RAILWAY_DEPLOYMENT.md) - Detaillierte Railway Anleitung
- [QUICK_START_MIGRATION.md](QUICK_START_MIGRATION.md) - Quick Start Guide

### 2. Update app/routes/app.settings.tsx

Da die Datei über 1500 Zeilen hat, hier die wichtigsten Änderungen:

#### A) Loader anpassen (Zeilen 127-141):
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

#### B) Action handler anpassen (Zeilen 160-174):
Ersetze die sanitizedData Sektion mit allen entity-spezifischen Feldern analog zu den neuen Feldnamen.

#### C) State Variables hinzufügen (nach Zeile 324):
Füge State für alle neuen Felder hinzu (productTitleFormat, productTitleInstructions, etc.)

#### D) Tab-Navigation für Instructions erweitern (nach Zeile 1305):
```typescript
{selectedSection === "instructions" && (
  <Card>
    <BlockStack gap="500">
      <Text as="h2" variant="headingLg">
        {t.settings.aiInstructionsTitle}
      </Text>
      <Text as="p" variant="bodyMd" tone="subdued">
        Geben Sie für jedes Feld ein Formatbeispiel und spezifische Anweisungen an, an denen sich die KI orientieren soll.
      </Text>

      {/* Entity Tabs */}
      <div style={{ borderBottom: "1px solid #e1e3e5" }}>
        <InlineStack gap="200">
          <button onClick={() => setEntityTab("products")} style={{
            padding: "0.75rem 1rem",
            background: entityTab === "products" ? "white" : "transparent",
            border: "none",
            borderBottom: entityTab === "products" ? "2px solid #008060" : "2px solid transparent",
            cursor: "pointer",
          }}>
            <Text as="span" fontWeight={entityTab === "products" ? "semibold" : "regular"}>
              Produkte
            </Text>
          </button>
          <button onClick={() => setEntityTab("collections")} style={{
            padding: "0.75rem 1rem",
            background: entityTab === "collections" ? "white" : "transparent",
            border: "none",
            borderBottom: entityTab === "collections" ? "2px solid #008060" : "2px solid transparent",
            cursor: "pointer",
          }}>
            <Text as="span" fontWeight={entityTab === "collections" ? "semibold" : "regular"}>
              Collections
            </Text>
          </button>
          <button onClick={() => setEntityTab("blogs")} style={{
            padding: "0.75rem 1rem",
            background: entityTab === "blogs" ? "white" : "transparent",
            border: "none",
            borderBottom: entityTab === "blogs" ? "2px solid #008060" : "2px solid transparent",
            cursor: "pointer",
          }}>
            <Text as="span" fontWeight={entityTab === "blogs" ? "semibold" : "regular"}>
              Blogs
            </Text>
          </button>
          <button onClick={() => setEntityTab("pages")} style={{
            padding: "0.75rem 1rem",
            background: entityTab === "pages" ? "white" : "transparent",
            border: "none",
            borderBottom: entityTab === "pages" ? "2px solid #008060" : "2px solid transparent",
            cursor: "pointer",
          }}>
            <Text as="span" fontWeight={entityTab === "pages" ? "semibold" : "regular"}>
              Seiten
            </Text>
          </button>
          <button onClick={() => setEntityTab("policies")} style={{
            padding: "0.75rem 1rem",
            background: entityTab === "policies" ? "white" : "transparent",
            border: "none",
            borderBottom: entityTab === "policies" ? "2px solid #008060" : "2px solid transparent",
            cursor: "pointer",
          }}>
            <Text as="span" fontWeight={entityTab === "policies" ? "semibold" : "regular"}>
              Richtlinien
            </Text>
          </button>
        </InlineStack>
      </div>

      {/* Reset All Button for current tab */}
      <InlineStack align="end">
        <Button onClick={() => handleResetAll(entityTab)} tone="critical">
          Alle Felder zurücksetzen
        </Button>
      </InlineStack>

      {/* Fields for each entity type */}
      {/* Render fields based on entityTab */}
    </BlockStack>
  </Card>
)}
```

### 3. Update app/actions/product.actions.ts

In der handleGenerateAIText Funktion (Zeilen 161-295), ersetze:
```typescript
// Alt:
if (aiInstructions?.titleFormat) {
  prompt += `\n\nFormatbeispiel:\n${aiInstructions.titleFormat}`;
}
// Neu:
if (aiInstructions?.productTitleFormat) {
  prompt += `\n\nFormatbeispiel:\n${aiInstructions.productTitleFormat}`;
}
```

Ersetze alle Feldnamen mit dem `product` Präfix:
- `titleFormat` → `productTitleFormat`
- `titleInstructions` → `productTitleInstructions`
- `descriptionFormat` → `productDescriptionFormat`
- etc.

### 4. Update Content Actions

Ähnliche Anpassungen für:
- Collections: Verwende `collection*` Felder (z.B. `collectionTitleFormat`)
- Blogs: Verwende `blog*` Felder
- Pages: Verwende `page*` Felder
- Policies: Verwende `policy*` Felder

## Helper Functions

Verwende die Helper-Funktionen aus `aiInstructionsDefaults.ts`:

```typescript
import { getDefaultInstructions, getDefaultForField, getAvailableFields } from '../constants/aiInstructionsDefaults';

// Reset single field
const handleResetField = (entityType: EntityType, field: string) => {
  const defaultValue = getDefaultForField(entityType, field as keyof EntityInstructions);
  // Set the state variable to defaultValue
};

// Reset all fields for an entity
const handleResetAll = (entityType: EntityType) => {
  const defaults = getDefaultInstructions(entityType);
  // Set all state variables for that entity to default values
};

// Get available fields for rendering
const availableFields = getAvailableFields('products');
// Returns: ['titleFormat', 'titleInstructions', 'descriptionFormat', ...]
```

## Testing Checklist

- [ ] Run migration successfully
- [ ] Settings page loads without errors
- [ ] Can switch between entity tabs
- [ ] Can edit instructions for each entity type
- [ ] Reset single field button works
- [ ] Reset all fields button works
- [ ] Saving instructions persists to database
- [ ] Product AI generation uses product-specific instructions
- [ ] Collection AI generation uses collection-specific instructions
- [ ] Blog AI generation uses blog-specific instructions
- [ ] Page AI generation uses page-specific instructions
- [ ] Policy AI generation uses policy-specific instructions

## File Changes Summary

| File | Status | Changes |
|------|--------|---------|
| `app/constants/aiInstructionsDefaults.ts` | ✅ Created | Default values + helper functions |
| `prisma/schema.prisma` | ✅ Updated | Entity-specific DB fields + Grok/DeepSeek |
| `prisma/migrations/add_entity_specific_ai_instructions.sql` | ✅ Created | Idempotent migration script |
| `scripts/run-migration.js` | ✅ Created | Node.js migration runner (cross-platform) |
| `scripts/railway-migration.sh` | ✅ Created | Bash migration script for Railway |
| `scripts/railway-migration.bat` | ✅ Created | Batch migration script (Windows) |
| `package.json` | ✅ Updated | Added `start:railway` and `prisma:migrate:new` |
| `app/utils/validation.ts` | ✅ Updated | Validation for new fields |
| `app/components/AIInstructionFieldGroup.tsx` | ✅ Created | Reusable field component |
| `app/actions/product.actions.ts` | ✅ Updated | Uses product* fields |
| `RAILWAY_DEPLOYMENT.md` | ✅ Created | Railway deployment guide |
| `QUICK_START_MIGRATION.md` | ✅ Created | Quick start guide |
| `app/routes/app.settings.tsx` | ⏳ Todo | Tabs, states, handlers |
| `app/routes/app.collections.tsx` | ⏳ Todo | Use collection* fields |
| `app/routes/app.blog.tsx` | ⏳ Todo | Use blog* fields |
| `app/routes/app.pages.tsx` | ⏳ Todo | Use page* fields |
| `app/routes/app.policies.tsx` | ⏳ Todo | Use policy* fields |
