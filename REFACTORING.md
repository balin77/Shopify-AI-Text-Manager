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

## Gesamtergebnis

| Datei | Vorher | Nachher | Reduktion |
|---|---|---|---|
| `useUnifiedContentEditor.ts` | 3864 | 3617 | -247 |
| `api.ai.tsx` | 2825 | 2593 | -232 |
| `app.templates.tsx` | 2546 | 2459 | -87 |
| `contentEditor.utils.ts` | 1157 | 1060 | -97 |
| **Summe** | **10392** | **9729** | **-663** |

Neu erstellt: 7 Dateien mit zusammen ~630 Zeilen fokussierter, einzelverantwortlicher Logik.

---

## Offene Refactoring-Aufgaben (Next Steps)

Die folgenden Aufgaben wurden identifiziert, aber noch nicht umgesetzt. Sie erfordern mehr Zeit und sorgfältige Planung, da sie große Code-Blöcke betreffen.

### Priorität 1 — Hoch (größter Effekt)

#### `useUnifiedContentEditor.ts` weiter aufteilen (~2000 Zeilen Potential)
- **`useFieldHandlers.ts`** — 16+ Handler-Funktionen (handleSave, handleDiscard, handleGenerateAI, handleTranslateField, etc.) → ca. 800 Zeilen
- **`useAltTextHandlers.ts`** — 10 zusammenhängende Alt-Text-Handler → ca. 280 Zeilen
- **`useAITranslationHandlers.ts`** — submitAIAction + Response-Effekte → ca. 200 Zeilen

#### `api.ai.tsx` Handler-Extraktion (~2300 Zeilen Potential)
- **`api-ai-handlers/text-translation.handler.ts`** — translateField, translateFieldToAllLocales (inkl. ~1000-Zeilen-Mega-Handler), translateAll, translateAllForLocale
- **`api-ai-handlers/alt-text.handler.ts`** — generateAltText, generateAllAltTexts, translateAltText, translateAltTextToAllLocales, translateAllAltTextsToAllLocales, translateAllAltTextsForLocale
- **`api-ai-handlers/text-generation.handler.ts`** — generateAIText, formatAIText, formatField

#### `unified-content.actions.ts` Handler-Extraktion (~2500 Zeilen Potential)
Gleiche Struktur wie api.ai.tsx — viele der Handler sind inhaltlich identisch (alt-text, sub-resources). Idealerweise sollten beide Dateien auf dieselben Handler-Module zurückgreifen.

### Priorität 2 — Mittel

#### `app.templates.tsx` Action-Handler auslagern
Die `action()` Funktion ist noch ~1400 Zeilen lang und enthält 8 verschiedene Action-Types. Vorschlag:
```
app/actions/templates/
├── templates-load.action.ts
├── templates-generate.action.ts
├── templates-translate-field.action.ts
├── templates-translate-all.action.ts
└── templates-update.action.ts
```

#### `app/components/UnifiedContentEditor.tsx` aufteilen
- `UnifiedFieldRenderer.tsx` extrahieren (Zeilen 900-1189, ~290 Zeilen)
- `UnifiedEditorToolbar.tsx` extrahieren (Desktop-Toolbar)
- AI-Action-Konstanten in `constants/ai-actions.ts` zentralisieren (aktuell in 2 Dateien dupliziert)

#### `app/routes/app.settings.tsx` aufteilen
- `SettingsPlanTab.tsx` extrahieren (~400 Zeilen Plan-Billing-Logik)
- Server-Loader in separates `settings-loader.server.ts`

### Priorität 3 — Nice-to-have

#### Shared Service-Context
`AIService` + `TranslationService` Initialisierung in `unified-content.actions.ts` ist noch 15 Zeilen lang und könnte in die `shared.ts` wandern (analog zu `createAIService`).

#### `app/utils/contentEditor.utils.ts` weiter aufteilen
- `useNavigationGuard` → `app/hooks/useNavigationGuard.ts`
- `useChangeTracking` → `app/hooks/useChangeTracking.ts`  
- `useItemDataLoader` → `app/hooks/useItemDataLoader.ts`
- Field-Validation-Funktionen (16 Exports) → `app/utils/field-validation.utils.ts`

---

## Regeln für neue Dateien

Aus den identifizierten Mustern empfehlen sich folgende Konventionen:

- **Hooks** → `app/hooks/use*.ts` (max. 300 Zeilen, eine Verantwortlichkeit)
- **Server Action Handler** → `app/actions/<feature>/<feature>-<type>.action.ts`
- **API Route Handler** → `app/routes/api-<route>-handlers/<type>.handler.ts`
- **Utilities** → `app/utils/<feature>/<feature>.utils.ts` (nur pure functions, kein React)
- **Shared Types** → `app/types/<feature>.types.ts`
- **CSS** → `app/styles/<ComponentName>.css` (kein CSS in JS)
