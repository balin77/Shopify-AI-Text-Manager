# Refactoring-Dokumentation

Branch: `claude/identify-refactoring-needs-LmVDe`  
Datum: April 2026

---

## Ausgangslage

Mehrere Dateien im Projekt waren stark überladen — teils durch fehlende Trennung von Verantwortlichkeiten, teils durch Copy-Paste-Duplikate zwischen Dateien.

### Größte Dateien vor dem Refactoring

| Datei | Zeilen | Problem |
|---|---|---|
| `app/hooks/useUnifiedContentEditor.ts` | 3864 | 12 verschiedene Verantwortlichkeiten in einem einzigen Hook |
| `app/routes/api.ai.tsx` | 2825 | 11 Action-Cases + alle Helpers inline, AIService 11x dupliziert |
| `app/actions/unified-content.actions.ts` | 2820 | Identische Hilfsfunktionen wie api.ai.tsx, kein Sharing |
| `app/routes/app.templates.tsx` | 2546 | Utility-Funktionen, Action-Logik und Komponente alles in einer Datei |
| `app/utils/contentEditor.utils.ts` | 1157 | CSS-String als JS-Variable, gemischte Hooks/Utils |
| `app/components/UnifiedContentEditor.tsx` | 1241 | Zu groß, keine Trennung Logik/Darstellung |

---

## Durchgeführte Änderungen

### Phase 1 — Shared Utilities (Low Risk)

#### `app/utils/character-limits.ts` (neu)
- **Was:** `getCharacterLimitRequirement()` war eine 40-Zeilen-Funktion die **identisch** in `api.ai.tsx` (Zeile 27) und `unified-content.actions.ts` (Zeile 33) existierte
- **Lösung:** Einmalig extrahiert, beide Dateien importieren jetzt von hier
- **Gewinn:** 1 Duplikat eliminiert, single source of truth für alle Zeichenlimits

#### `app/styles/content-editor-global.css` (neu)
- **Was:** 90 Zeilen CSS waren als JavaScript-String `contentEditorStyles` in `contentEditor.utils.ts` gespeichert und per `<style>{contentEditorStyles}</style>` in JSX injiziert
- **Lösung:** In echte CSS-Datei verschoben, als normaler `import` eingebunden
- **Gewinn:** CSS ist jetzt korrekt versioniert, tooling-kompatibel (Linting, Syntax-Highlighting), kein JS-Overhead

---

### Phase 2 — Hook-Refactoring

#### `app/utils/editor-error-messages.ts` (neu)
- **Was:** `translateErrorMessage()` war eine reine Funktion (kein Hook-State) direkt im Hook-Body
- **Lösung:** In separate Utils-Datei extrahiert
- **Gewinn:** Funktion ist jetzt testbar und wiederverwendbar

#### `app/hooks/useEditorImageManagement.ts` (neu)
Extrahiert aus `useUnifiedContentEditor.ts`:
- `onDemandImages` / `isLoadingImages` State
- `imageFetcher` (useFetcher für Shopify API)
- `loadedImagesForProductRef` + `prevSelectedItemIdRef`
- `useEffect` für on-demand Image-Loading (nur wenn DB keine Images hat)
- `useEffect` für Fetcher-Response-Handling
- `selectedItem` useMemo (merged DB-Images oder on-demand Images)

```typescript
// Vorher — alles in useUnifiedContentEditor.ts:
const [onDemandImages, setOnDemandImages] = useState<ContentImage[]>([]);
const [isLoadingImages, setIsLoadingImages] = useState(false);
const imageFetcher = useFetcher<...>();
// ... 2 useEffects à ~30 Zeilen
// ... selectedItem useMemo ~30 Zeilen

// Nachher:
const { selectedItem, onDemandImages, isLoadingImages, prevSelectedItemIdRef } =
  useEditorImageManagement({ config, selectedItemId, baseSelectedItem });
```

#### `app/hooks/useEditorChangeDetection.ts` (neu)
Extrahiert aus `useUnifiedContentEditor.ts`:
- Standard-Change-Tracking (via `useChangeTracking`)
- Template-spezifische Change-Detection (Vergleich mit `originalTemplateValuesRef`)
- Metaobject-spezifische Change-Detection (Vergleich mit `originalLoadedValuesRef`)
- Alt-Text Change-Detection
- Kombination aller Varianten zu `hasChanges`

```typescript
// Vorher — 90 Zeilen Logik direkt im Hook:
const standardHasFieldChanges = useChangeTracking(...);
const templateHasFieldChanges = useMemo(() => { ... });
const metaobjectsHasFieldChanges = useMemo(() => { ... });
const hasFieldChanges = config.contentType === 'templates' ? ... : ...;
const hasAltTextChanges = useMemo(() => { ... });
const hasChanges = hasFieldChanges || hasAltTextChanges;

// Nachher:
const { hasChanges, hasFieldChanges, hasAltTextChanges } = useEditorChangeDetection({ ... });
```

**Ergebnis:** `useUnifiedContentEditor.ts` von **3864 → 3617 Zeilen** (-247)

---

### Phase 3 — API Route Shared Helpers

#### `app/routes/api-ai-handlers/shared.ts` (neu)

Extrahiert aus `api.ai.tsx`:

**Typen & Konstanten:**
- `CONTENT_CONFIGS` — Map contentType → ContentEditorConfig
- `VALID_CONTENT_TYPES` — Set aller erlaubten Content-Types
- `TranslatableContentItem` Interface
- `ShopifyGraphQLResponse` Interface
- `AIActionContext` Interface (für zukünftige Handler-Extraktion)

**Helper-Funktionen:**
- `errorMessage(err)` — sicheres Error-Message-Extrahieren
- `errorStack(err)` — sicheres Error-Stack-Extrahieren
- `isPrismaError(err, code)` — Prisma-Error-Erkennung

**Factory:**
- `createAIService(settings, shop, taskId)` — eliminiert den 11-fach duplizierten AIService-Initialisierungsblock:

```typescript
// Vorher — 11x in api.ai.tsx (je ~11 Zeilen):
const aiService = new AIService(
  toValidProvider(settings?.preferredProvider),
  {
    huggingfaceApiKey: decryptApiKey(settings?.huggingfaceApiKey) || undefined,
    geminiApiKey: decryptApiKey(settings?.geminiApiKey) || undefined,
    claudeApiKey: decryptApiKey(settings?.claudeApiKey) || undefined,
    openaiApiKey: decryptApiKey(settings?.openaiApiKey) || undefined,
    grokApiKey: decryptApiKey(settings?.grokApiKey) || undefined,
    deepseekApiKey: decryptApiKey(settings?.deepseekApiKey) || undefined,
    selectedModel: settings?.selectedModel || undefined,
  },
  session.shop,
  task.id
);

// Nachher — 11x:
const aiService = createAIService(settings, session.shop, task.id);
```

**Ergebnis:** `api.ai.tsx` von **2825 → 2593 Zeilen** (-232, davon ~120 durch AIService-Dedup)

---

### Phase 4 — Template Utilities

#### `app/utils/templates/templates.utils.ts` (neu)
Extrahiert aus `app/routes/app.templates.tsx`:
- `keyToFilename(key)` — mappt Shopify Translation-Keys auf Theme-Dateipfade
- `replaceValuesInJson(obj, replacements)` — rekursiver JSON-Wert-Replacer

Beide Funktionen sind reine Utilities ohne Framework-Abhängigkeiten und damit jetzt unabhängig testbar.

**Ergebnis:** `app.templates.tsx` von **2546 → 2459 Zeilen** (-87)

---

## Gesamtergebnis (Phasen 1–4 + Priorität 1–3)

| Datei | Vorher | Nachher | Reduktion |
|---|---|---|---|
| `useUnifiedContentEditor.ts` | 3864 | 2166 | -1698 |
| `api.ai.tsx` | 2825 | 110 | -2715 |
| `unified-content.actions.ts` | 2778 | 705 | -2073 |
| `app.templates.tsx` | 2546 | 1094 | -1452 |
| `app/components/UnifiedContentEditor.tsx` | 1241 | 916 | -325 |
| `app/routes/app.settings.tsx` | 1252 | 984 | -268 |
| `contentEditor.utils.ts` | 1157 | 155 | -1002 |
| **Summe** | **15663** | **6130** | **-9533** |

Neu erstellt: 34+ Dateien mit zusammen ~9000 Zeilen fokussierter, einzelverantwortlicher Logik.

---

### Phase 5 — Priorität 1 (abgeschlossen)

#### `useUnifiedContentEditor.ts` weiter aufgeteilt
- **`app/hooks/useFieldHandlers.ts`** (1299 Zeilen) — 22 Handler-Funktionen (handleSave, handleDiscard, handleGenerateAI, handleTranslateField, etc.)
- **`app/hooks/useAltTextHandlers.ts`** (~430 Zeilen) — 10 Alt-Text-Handler

#### `api.ai.tsx` Handler-Extraktion (2593 → 110 Zeilen)
- **`api-ai-handlers/text-translation.handler.ts`** — handleTranslateField, handleTranslateFieldToAllLocales
- **`api-ai-handlers/alt-text.handler.ts`** — handleGenerateAltText, handleGenerateAllAltTexts, handleTranslateAltText, handleTranslateAltTextToAllLocales, handleTranslateAllAltTextsToAllLocales, handleTranslateAllAltTextsForLocale
- **`api-ai-handlers/text-generation.handler.ts`** — handleFormatField, handleGenerateAIText, handleFormatAIText

#### `unified-content.actions.ts` Handler-Extraktion (2778 → 705 Zeilen)
- **`app/actions/content/alt-text.action.ts`** — ContentActionHandlerContext + Alt-Text-Handler
- **`app/actions/content/translation.action.ts`** — handleTranslateField, handleTranslateAll, handleTranslateAllForLocale, handleTranslateFieldToAllLocales
- **`app/actions/content/content-update.action.ts`** — handleUpdateContent
- **`app/actions/content/sub-resources.action.ts`** — handleLoadSubResourceTranslations, handleSaveSubResourceTranslations, handleTranslateSubResources, handleTranslateSubResourceToAllLocales, handleSavePrimarySubResources

---

### Phase 6 — Priorität 2 (abgeschlossen)

#### `app.templates.tsx` Action-Handler ausgelagert (2459 → 1094 Zeilen)
```
app/actions/templates/
├── shared.ts                          (TemplatesActionContext, TranslatableField)
├── templates-load.action.ts           (loadTranslations)
├── templates-generate.action.ts       (generateAIText)
├── templates-translate-field.action.ts (translateField, translateFieldToAllLocales)
├── templates-translate-all.action.ts   (translateAll, translateAllForLocale)
└── templates-update.action.ts          (updateContent — 618 Zeilen)
```

#### `app/components/UnifiedContentEditor.tsx` aufgeteilt (1241 → 916 Zeilen)
- **`UnifiedFieldRenderer.tsx`** extrahiert (316 Zeilen) — vollständige Feld-Render-Logik
- AI-Action-Konstanten in **`constants/ai-actions.ts`** zentralisiert (ALL_LOCALES_AI_ACTIONS, PER_LOCALE_AI_ACTIONS, IMAGE_ALL_LOCALES_AI_ACTIONS, IMAGE_PER_LOCALE_AI_ACTIONS)

#### `app/routes/app.settings.tsx` aufgeteilt (1252 → 984 Zeilen)
- **`SettingsPlanTab.tsx`** extrahiert (320 Zeilen) — Plan-State, handleSelectPlan, Plan-Karten-JSX

---

## Abgeschlossene Refactoring-Aufgaben

### Priorität 3 — abgeschlossen

#### Shared Service-Context ✅
`createAIService(taskId)` + `createTranslationService(taskId)` Factories in `unified-content.actions.ts` ersetzen 12 duplizierte Instantiierungen von `new AIService(provider, serviceConfig, session.shop, task.id)`.

#### `app/utils/contentEditor.utils.ts` aufgeteilt ✅ (1157 → 155 Zeilen)
- `useNavigationGuard` → `app/hooks/useNavigationGuard.ts`
- `useChangeTracking` → `app/hooks/useChangeTracking.ts`
- `useItemDataLoader` → `app/hooks/useItemDataLoader.ts`
- Field-Validation-Funktionen (10 Exports) → `app/utils/field-validation.utils.ts`

`contentEditor.utils.ts` enthält jetzt nur noch: `getTranslatedValue`, `contentEditorStyles`, `ContentEditorState`/`NavigationState` Interfaces + Re-Exports für Backwards-Compat.

---

## Offene Refactoring-Aufgaben

Keine. Alle Prioritäten abgeschlossen.

---

## Regeln für neue Dateien

Aus den identifizierten Mustern empfehlen sich folgende Konventionen:

- **Hooks** → `app/hooks/use*.ts` (max. 300 Zeilen, eine Verantwortlichkeit)
- **Server Action Handler** → `app/actions/<feature>/<feature>-<type>.action.ts`
- **API Route Handler** → `app/routes/api-<route>-handlers/<type>.handler.ts`
- **Utilities** → `app/utils/<feature>/<feature>.utils.ts` (nur pure functions, kein React)
- **Shared Types** → `app/types/<feature>.types.ts`
- **CSS** → `app/styles/<ComponentName>.css` (kein CSS in JS)
