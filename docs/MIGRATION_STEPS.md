# 🔄 Product Actions Migration - Schritt-für-Schritt Anleitung

**Ziel:** Migriere [app/actions/product.actions.ts](../app/actions/product.actions.ts) (1.675 Zeilen) zu modularer Struktur

**Status:** ✅ Vorbereitet - Bereit zur schrittweisen Migration

---

## ✅ Bereits erledigt

1. **Shared Utilities erstellt:**
   - ✅ [shared/task-helpers.ts](../app/actions/product/shared/task-helpers.ts)
   - ✅ [shared/translation-helpers.ts](../app/actions/product/shared/translation-helpers.ts)
   - ✅ [shared/error-handlers.ts](../app/actions/product/shared/error-handlers.ts)
   - ✅ [shared/action-context.ts](../app/actions/product/shared/action-context.ts)

2. **Beispiel-Implementierung:**
   - ✅ [ai-generation.actions.EXAMPLE.ts](../app/actions/product/ai-generation.actions.EXAMPLE.ts)

3. **Router erstellt:**
   - ✅ [index.ts](../app/actions/product/index.ts)

4. **Backup erstellt:**
   - ✅ [product.actions.BACKUP.ts](../app/actions/product.actions.BACKUP.ts)

---

## 📋 Migration Checkliste

### Phase 1: AI Generation Actions ✅ (Beispiel vorhanden)

- [x] `handleGenerateAIText` - Generiert neue Inhalte
- [x] `handleFormatAIText` - Formatiert bestehende Inhalte

**Datei:** `app/actions/product/ai-generation.actions.ts`
**Vorlage:** `.EXAMPLE` Datei vorhanden

### Phase 2: Translation Actions (TODO)

- [ ] `handleTranslateField` - Übersetzt einzelnes Feld
- [ ] `handleTranslateSuggestion` - Übersetzt AI-Vorschlag (Preview)

**Datei:** `app/actions/product/translation.actions.ts`
**Aufwand:** ~1-2 Stunden

### Phase 3: Bulk Translation Actions (TODO)

- [ ] `handleTranslateFieldToAllLocales` - Ein Feld → alle Sprachen (208 Zeilen)
- [ ] `handleTranslateAll` - Alle Felder → alle Sprachen (307 Zeilen!)

**Datei:** `app/actions/product/translation-bulk.actions.ts`
**Aufwand:** ~3-4 Stunden (größte Actions)

### Phase 4: Update Action (TODO)

- [ ] `handleUpdateProduct` - Speichert Produkt in Shopify + DB (315 Zeilen!)

**Datei:** `app/actions/product/update.actions.ts`
**Aufwand:** ~2-3 Stunden (sehr komplex)

### Phase 5: Options Action (TODO)

- [ ] `handleTranslateOption` - Übersetzt Product Options (Size, Color)

**Datei:** `app/actions/product/options.actions.ts`
**Aufwand:** ~30 Minuten

### Phase 6: Alt-Text Actions (TODO)

- [ ] `handleGenerateAltText` - Generiert Alt-Text für ein Bild
- [ ] `handleGenerateAllAltTexts` - Generiert Alt-Text für alle Bilder
- [ ] `handleTranslateAltText` - Übersetzt Alt-Text

**Datei:** `app/actions/product/alt-text.actions.ts`
**Aufwand:** ~1-2 Stunden

---

## 🚀 Wie man migriert (Schritt-für-Schritt)

### Option A: Aktiviere Router sofort (Empfohlen für Testing)

**Schritt 1:** Router aktivieren

```bash
# Router zum aktiven Entry Point machen
mv app/actions/product.actions.ts app/actions/product.actions.OLD.ts
mv app/actions/product/index.ts app/actions/product.actions.ts
```

**Schritt 2:** EXAMPLE-Datei aktivieren

```bash
# Entferne .EXAMPLE Extension
mv app/actions/product/ai-generation.actions.EXAMPLE.ts app/actions/product/ai-generation.actions.ts
```

**Schritt 3:** Router-Imports aktualisieren

```typescript
// In app/actions/product.actions.ts (ehemals index.ts)
import {
  handleGenerateAIText,
  handleFormatAIText,
} from "./product/ai-generation.actions"; // ✅ Kein .EXAMPLE mehr
```

**Schritt 4:** Teste AI Generation Actions

```bash
npm run dev
# Teste in der UI: "Generate with AI" und "Format with AI"
```

**Ergebnis:**
- ✅ AI Generation funktioniert (migriert)
- ⚠️ Andere Actions geben "Action not yet migrated" (501 Error)

---

### Option B: Migration ohne Router-Aktivierung

Wenn Sie zuerst alle Actions migrieren möchten:

**Schritt 1-6:** Migriere alle Actions (siehe unten)

**Schritt 7:** Aktiviere Router wenn alle fertig

```bash
mv app/actions/product.actions.ts app/actions/product.actions.OLD.ts
mv app/actions/product/index.ts app/actions/product.actions.ts
```

---

## 📝 Migration-Template für jede Action

### 1. Erstelle neue Action-Datei

```bash
touch app/actions/product/translation.actions.ts
```

### 2. Kopiere Template

```typescript
/**
 * Translation Actions
 *
 * Handles single-field translations
 */

import { json } from "@remix-run/node";
import { logger, loggers } from "~/utils/logger.server";
import type { ActionContext } from "./shared/action-context";
import { createTranslationService } from "./shared/action-context";
import {
  createProductTask,
  completeTask,
} from "./shared/task-helpers";
import { handleActionError } from "./shared/error-handlers";

export async function handleTranslateField(
  context: ActionContext,
  formData: FormData
): Promise<Response> {
  // 1. Extract params
  const fieldType = formData.get("fieldType") as string;
  const sourceText = formData.get("sourceText") as string;
  const targetLocale = formData.get("targetLocale") as string;
  const productId = formData.get("productId") as string;

  loggers.translation("info", "Starting translation", {
    fieldType,
    targetLocale,
    productId,
  });

  // 2. Create task
  const task = await createProductTask({
    shop: context.shop,
    type: "translation",
    resourceId: productId,
    fieldType,
    targetLocale,
  });

  try {
    // 3. Initialize service
    const translationService = createTranslationService(context);

    // 4. Perform translation
    // ... (Kopiere Logik aus original Datei)

    // 5. Complete task
    await completeTask(task.id, { translatedValue, fieldType, targetLocale });

    return json({ success: true, translatedValue, fieldType, targetLocale });
  } catch (error: any) {
    return handleActionError(error, {
      action: "translateField",
      taskId: task.id,
      productId,
    });
  }
}
```

### 3. Kopiere Logik aus original Datei

```bash
# Finde die Funktion in BACKUP
grep -n "async function handleTranslateField" app/actions/product.actions.BACKUP.ts

# Kopiere die Zeilen und paste in neue Datei
# Ersetze:
# - console.log → logger/loggers calls
# - db.task.create → createProductTask
# - db.task.update → updateTaskProgress/completeTask
# - catch block → handleActionError
```

### 4. Update Router

```typescript
// In app/actions/product.actions.ts (Router)
import { handleTranslateField } from "./product/translation.actions";

// In switch statement:
case "translateField":
  return handleTranslateField(context, formData);
```

### 5. Teste die Action

```bash
npm run dev
# Teste in UI
```

---

## 🧪 Testing nach jeder Migration

### Manual Testing

```bash
# 1. Start dev server
npm run dev

# 2. Öffne Products Page
# 3. Trigger die migrierte Action
# 4. Checke:
```

**Erfolgs-Kriterien:**
- ✅ Action funktioniert wie vorher
- ✅ Keine console.log mehr (nur logger)
- ✅ Task wird korrekt erstellt und aktualisiert
- ✅ Fehler werden ordentlich behandelt

### Check Railway Logs

```bash
railway logs | grep "ProductActions"
railway logs | grep "Translation"
```

**Erwartete Logs:**
```
[info] Product action requested { action: 'translateField', productId: '...' }
[info] Starting translation { fieldType: 'title', targetLocale: 'de' }
[info] Translation completed { fieldType: 'title' }
```

---

## ⚠️ Wichtige Hinweise

### 1. Console.log Migration

**Ersetze alle console.log:**

```typescript
// VORHER
console.log('[TranslateAll] Starting translation for locale:', locale);

// NACHHER
loggers.translation('info', 'Starting translation', { locale });
```

### 2. Task Management

**Ersetze manuelle Task-Updates:**

```typescript
// VORHER
await db.task.update({
  where: { id: task.id },
  data: { status: "completed", progress: 100, result: JSON.stringify(result) },
});

// NACHHER
await completeTask(task.id, result);
```

### 3. Error Handling

**Nutze unified error handler:**

```typescript
// VORHER
} catch (error: any) {
  await db.task.update({ /* ... */ });
  return json({ success: false, error: error.message }, { status: 500 });
}

// NACHHER
} catch (error: any) {
  return handleActionError(error, {
    action: "translateField",
    taskId: task.id,
    productId,
  });
}
```

---

## 📊 Progress Tracking

| Phase | Actions | Status | Aufwand | Geschätzte Zeit |
|-------|---------|--------|---------|----------------|
| **Phase 1** | AI Generation (2) | ✅ Beispiel vorhanden | 0h | Aktivieren: 10 min |
| **Phase 2** | Translation (2) | ⏳ TODO | 1-2h | - |
| **Phase 3** | Bulk Translation (2) | ⏳ TODO | 3-4h | - |
| **Phase 4** | Update (1) | ⏳ TODO | 2-3h | - |
| **Phase 5** | Options (1) | ⏳ TODO | 0.5h | - |
| **Phase 6** | Alt-Text (3) | ⏳ TODO | 1-2h | - |
| **Total** | **11 Actions** | **9% fertig** | **8-12h** | - |

---

## 🎯 Empfohlene Reihenfolge

1. **Start:** AI Generation (bereits fertig, nur aktivieren)
2. **Einfach:** Options (klein, schnell)
3. **Mittel:** Translation (2 Actions)
4. **Mittel:** Alt-Text (3 Actions)
5. **Komplex:** Bulk Translation (groß!)
6. **Sehr Komplex:** Update (groß + kritisch!)

**Rationale:** Einfache zuerst → Momentum aufbauen → Komplexe am Ende wenn Routine da ist

---

## 💡 Schnellstart

Wenn Sie **sofort** mit den migrierten AI Actions testen wollen:

```bash
# 1. Aktiviere EXAMPLE-Datei
mv app/actions/product/ai-generation.actions.EXAMPLE.ts app/actions/product/ai-generation.actions.ts

# 2. Backup alte Datei
mv app/actions/product.actions.ts app/actions/product.actions.OLD.ts

# 3. Router wird zum Entry Point
mv app/actions/product/index.ts app/actions/product.actions.ts

# 4. Update Router Import
# Ändere in product.actions.ts:
# from "./product/ai-generation.actions.EXAMPLE"
# to "./product/ai-generation.actions"

# 5. Test
npm run dev
```

**Ergebnis:**
- ✅ AI Generation funktioniert
- ⚠️ Andere Actions geben "not yet migrated" Error

**Dann:** Migriere die anderen Actions Schritt für Schritt

---

**Letzte Aktualisierung:** 15. Januar 2026
