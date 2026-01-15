# 🔧 Product Actions Refactoring Guide

**Datei:** [app/actions/product.actions.ts](../app/actions/product.actions.ts)
**Status:** Vorbereitet - Bereit zum Refactoring
**Erstellt:** 15. Januar 2026

---

## 📋 Überblick

Dieser Guide beschreibt, wie die monolithische `product.actions.ts` (1.675 Zeilen) in wartbare, kleinere Dateien aufgeteilt werden kann.

**Ziele:**
- ✅ Bessere Wartbarkeit
- ✅ Einfacheres Testing
- ✅ Reduzierte Merge-Konflikte
- ✅ Klarere Verantwortlichkeiten

---

## 🎯 Zielstruktur

```
app/actions/product/
├── index.ts                        # Router (50 Zeilen)
├── shared/                         # ✅ BEREITS ERSTELLT
│   ├── action-context.ts           # Context-Vorbereitung
│   ├── task-helpers.ts             # Task-Management
│   ├── translation-helpers.ts      # Übersetzungs-Utils
│   └── error-handlers.ts           # Error-Handling
├── ai-generation.actions.ts        # generateAIText, formatAIText
├── translation.actions.ts          # translateField, translateSuggestion
├── translation-bulk.actions.ts     # translateAll, translateFieldToAllLocales
├── update.actions.ts               # updateProduct
├── options.actions.ts              # translateOption
└── alt-text.actions.ts             # Alt-Text Actions
```

---

## ✅ Bereits Erstellt

Die folgenden Shared Utilities sind bereits implementiert:

### 1. [shared/task-helpers.ts](../app/actions/product/shared/task-helpers.ts)

**Funktionen:**
- `createProductTask()` - Task erstellen
- `updateTaskProgress()` - Progress aktualisieren
- `completeTask()` - Task als completed markieren
- `failTask()` - Task als failed markieren
- `updateTaskStatus()` - Status ändern
- `calculateProgress()` - Progress berechnen

### 2. [shared/translation-helpers.ts](../app/actions/product/shared/translation-helpers.ts)

**Funktionen:**
- `fetchTranslatableContent()` - Digest Map von Shopify laden
- `saveTranslationToShopify()` - Übersetzung zu Shopify senden
- `syncTranslationsToDB()` - DB Synchronisierung
- `getTranslationKey()` - Field Type zu Shopify Key mappen
- `buildTranslationInput()` - Translation Input bauen
- `validateTranslation()` - Validierung
- `chunkTranslations()` - Batching für API Limits

### 3. [shared/error-handlers.ts](../app/actions/product/shared/error-handlers.ts)

**Funktionen:**
- `handleActionError()` - Unified Error Handler mit Task Update
- `handleValidationError()` - Validierungsfehler
- `handleQuotaError()` - API Quota Errors
- `handlePartialSuccess()` - Partial Success Handling
- `withErrorHandling()` - HOC für Error Wrapping
- `isQuotaError()` - Error Type Detection
- `formatErrorMessage()` - User-friendly Messages

### 4. [shared/action-context.ts](../app/actions/product/shared/action-context.ts)

**Funktionen:**
- `prepareActionContext()` - Gemeinsamen Context vorbereiten
- `createAIService()` - AIService Instanz erstellen
- `createTranslationService()` - TranslationService Instanz erstellen

---

## 📝 Refactoring-Schritte

### Schritt 1: Beispiel-Action erstellen

Erstelle [`ai-generation.actions.ts`](../app/actions/product/ai-generation.actions.ts) (siehe Beispiel unten).

### Schritt 2: Router erstellen

Erstelle `app/actions/product/index.ts`:

```typescript
import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "~/shopify.server";
import { logger } from "~/utils/logger.server";
import { prepareActionContext } from "./shared/action-context";
import { handleGenerateAIText, handleFormatAIText } from "./ai-generation.actions";
import { handleTranslateField, handleTranslateSuggestion } from "./translation.actions";
import { handleTranslateAll, handleTranslateFieldToAllLocales } from "./translation-bulk.actions";
import { handleUpdateProduct } from "./update.actions";
import { handleTranslateOption } from "./options.actions";
import { handleGenerateAltText, handleGenerateAllAltTexts, handleTranslateAltText } from "./alt-text.actions";

export async function handleProductActions({ request }: ActionFunctionArgs) {
  logger.info("Product action requested", {
    context: "ProductActions",
    method: request.method,
    url: request.url,
  });

  try {
    const { admin, session } = await authenticate.admin(request);
    const formData = await request.formData();
    const action = formData.get("action") as string;
    const productId = formData.get("productId") as string;

    logger.info("Action details", {
      context: "ProductActions",
      action,
      productId,
      shop: session.shop,
    });

    // Prepare shared context
    const context = await prepareActionContext(admin, session);

    // Route to appropriate handler
    switch (action) {
      case "generateAIText":
        return handleGenerateAIText(context, formData, productId);

      case "formatAIText":
        return handleFormatAIText(context, formData, productId);

      case "translateField":
        return handleTranslateField(context, formData);

      case "translateFieldToAllLocales":
        return handleTranslateFieldToAllLocales(context, formData);

      case "translateSuggestion":
        return handleTranslateSuggestion(context, formData);

      case "translateAll":
        return handleTranslateAll(context, formData, productId);

      case "updateProduct":
        return handleUpdateProduct(context, formData, productId);

      case "translateOption":
        return handleTranslateOption(context, formData);

      case "generateAltText":
        return handleGenerateAltText(context, formData, productId);

      case "generateAllAltTexts":
        return handleGenerateAllAltTexts(context, formData, productId);

      case "translateAltText":
        return handleTranslateAltText(context, formData);

      default:
        logger.warn("Unknown action requested", {
          context: "ProductActions",
          action,
        });
        return json({ success: false, error: "Unknown action" }, { status: 400 });
    }
  } catch (error: any) {
    logger.error("Product action failed", {
      context: "ProductActions",
      error: error.message,
      stack: error.stack,
    });
    return json({ success: false, error: error.message }, { status: 500 });
  }
}
```

### Schritt 3: Actions migrieren

Für jede Action-Gruppe:

1. Erstelle neue Datei (z.B. `translation.actions.ts`)
2. Importiere Shared Helpers
3. Kopiere Actions aus `product.actions.ts`
4. Refactore mit Shared Helpers
5. Teste die Action
6. Aktualisiere Router

### Schritt 4: Original-Datei löschen

Wenn alle Actions migriert sind:

```bash
# Umbenennen für Backup
mv app/actions/product.actions.ts app/actions/product.actions.OLD.ts

# Router zum Entry Point machen
cp app/actions/product/index.ts app/actions/product.actions.ts
```

---

## 🔄 Migration-Patterns

### Pattern 1: Task Creation

**Vorher:**
```typescript
const task = await db.task.create({
  data: {
    shop,
    type: "aiGeneration",
    status: "pending",
    resourceType: "product",
    resourceId: productId,
    resourceTitle: contextTitle,
    fieldType,
    progress: 0,
    expiresAt: getTaskExpirationDate(),
  },
});
```

**Nachher:**
```typescript
import { createProductTask } from "./shared/task-helpers";

const task = await createProductTask({
  shop: context.shop,
  type: "aiGeneration",
  resourceId: productId,
  fieldType,
});
```

### Pattern 2: Error Handling

**Vorher:**
```typescript
} catch (error: any) {
  await db.task.update({
    where: { id: task.id },
    data: {
      status: "failed",
      completedAt: new Date(),
      error: error.message.substring(0, 1000),
    },
  });
  return json({ success: false, error: error.message }, { status: 500 });
}
```

**Nachher:**
```typescript
import { handleActionError } from "./shared/error-handlers";

} catch (error: any) {
  return handleActionError(error, {
    action: "generateAIText",
    taskId: task.id,
    productId,
  });
}
```

### Pattern 3: Logging

**Vorher:**
```typescript
console.log(`[TranslateAll] Starting translation for locale: ${locale}`);
console.log(`[TranslateAll] Translation response:`, JSON.stringify(data).substring(0, 200));
console.error(`[TranslateAll] ERROR: Failed to translate:`, error);
```

**Nachher:**
```typescript
import { loggers } from "~/utils/logger.server";

loggers.translation('info', 'Starting translation', { locale });
loggers.translation('debug', 'Translation response', { data });
loggers.translation('error', 'Translation failed', { error: error.message });
```

---

## 📊 Migrations-Checkliste

### AI Generation Actions
- [ ] `generateAIText` - Title, Description, Handle, SEO
- [ ] `formatAIText` - Format existing text

### Translation Actions
- [ ] `translateField` - Single field, single locale
- [ ] `translateSuggestion` - Preview translation

### Bulk Translation Actions
- [ ] `translateFieldToAllLocales` - One field, all locales
- [ ] `translateAll` - All fields, all locales (307 Zeilen!)

### Update Actions
- [ ] `updateProduct` - Save to Shopify + DB (315 Zeilen!)

### Option Actions
- [ ] `translateOption` - Product options (Size, Color)

### Alt-Text Actions
- [ ] `generateAltText` - Single image
- [ ] `generateAllAltTexts` - All images
- [ ] `translateAltText` - Translate alt-text

---

## 🧪 Testing

Nach jeder Migration:

```bash
# TypeScript Check
npm run typecheck

# Start Dev Server
npm run dev

# Teste die Action im Browser
# 1. Öffne Product-Seite
# 2. Trigger die migrierte Action
# 3. Checke Railway Logs für Fehler
```

---

## 🎯 Vorteile nach Refactoring

### Wartbarkeit
- ✅ Einzelne Dateien < 300 Zeilen
- ✅ Klare Verantwortlichkeiten
- ✅ Einfacher zu navigieren

### Testing
- ✅ Isolierte Unit Tests möglich
- ✅ Mock-freundlich durch DI
- ✅ Einfacher zu debuggen

### Team-Arbeit
- ✅ Weniger Merge-Konflikte
- ✅ Paralleles Arbeiten möglich
- ✅ Code Reviews einfacher

### Performance
- ✅ Kleinere Bundle Sizes
- ✅ Code-Splitting möglich
- ✅ Lazy Loading

---

## 📝 Nächste Schritte

1. **Beispiel validieren** - Erstelle `ai-generation.actions.ts` (siehe unten)
2. **Router testen** - Stelle sicher, dass Routing funktioniert
3. **Action für Action migrieren** - Schritt für Schritt
4. **Tests hinzufügen** - Unit Tests für jede Action
5. **Original löschen** - Wenn alles funktioniert

---

## ⚠️ Wichtige Hinweise

- **Nicht alles auf einmal!** Migriere schrittweise
- **Teste nach jeder Migration** Stelle sicher, dass alles funktioniert
- **Behalte Backup** Original-Datei erst am Ende löschen
- **Console.log ersetzen** Nutze die Gelegenheit für Winston-Migration

---

**Letzte Aktualisierung:** 15. Januar 2026
