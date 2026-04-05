# Technical Debt & Future Improvements

**Last Updated:** 2026-02-15
**Source:** Code Reviews #1–#4 (Claude Code)

---

## Zusammenfassung

Dieses Dokument erfasst alle technischen Schulden und geplanten Verbesserungen, die aus vier Code-Reviews identifiziert wurden. Kritische und hohe Issues wurden bereits behoben. Die verbleibenden Punkte sind bewusst aufgeschoben und hier dokumentiert.

---

## Erledigte Issues (Reviews #1–#4)

| Issue | Commit | Status |
|-------|--------|--------|
| Multi-Shop Data Leak (page/policy deleteMany) | `5e37a8c` | Behoben |
| API-Outage löscht alle lokalen Daten | `5e37a8c` | Behoben |
| Ungeschützte JSON.parse Aufrufe | `73b4b57`, `e670b05` | Behoben |
| Unsafe `any`/`as string` Casts | `632c53f` | Behoben |
| GraphQL Error-Checks (11 Stellen) | `7bd51dc` | Behoben |
| ShopPolicy body_html Mismatch | `7bd51dc` | Behoben |
| Race Condition Translation-Save-Lock | `7bd51dc` | Behoben |
| Duplicate Type-Files (contentEditor.types.ts) | `5299f53`, `3a067e5` | Behoben |
| Unbounded Translation-Cache | `6c3b765` | Behoben |
| N+1 Theme-Translation Queries | `2fd37ec` | Behoben |
| Batch-Sync Error Handling (Collections/Articles/Menus) | `e670b05` | Behoben |
| safeJsonParse akzeptiert null/undefined | `741e652` | Behoben |
| State/Ref Duplizierung (useLatestRef) | `4a88200` | Behoben |
| i18n für Sync-Fehlermeldungen | `a8b8393`, `d13d5ad` | Behoben |
| ARTICLE body → body_html Korrektur | `7754ce1` | Behoben |
| ActionContext non-null Assertions | `2ab47f6` | Behoben |
| Loader Factory (createContentLoader) | `d4d6b91` | Behoben |
| Debug console.logs entfernt | `97d0d9d` | Behoben |
| GID-Format Validierung | `4c0a5f0` | Behoben |
| Failed Locales als Warnings | `d9b1724` | Behoben |
| Batch DB Deletes | `9244c38` | Behoben |

---

## Offene Items

### 1. Defense-in-Depth: `shop`-Spalte auf ContentTranslation ✅ ERLEDIGT

**Priorität:** Mittel  
**Status:** Behoben (2026-04-05)

`shop String` wurde zu `ContentTranslation` hinzugefügt. Unique Constraint auf `[shop, resourceId, key, locale]` erweitert. Migration `20260405000000_add_shop_to_content_translation` erstellt (safe backfill aus Product/Collection/Article/Page/ShopPolicy-Tabellen). Alle ~40 contentTranslation-Queries in 14 Dateien um `shop`-Filter erweitert.

---

### 2. Refactoring: useUnifiedContentEditor.ts

**Priorität:** Mittel
**Aufwand:** ~1–2 Tage (Rest: ~0.5 Tage)
**Risiko aktuell:** Wartbarkeit (keine funktionalen Bugs)

#### Problem

Die Datei hat 3.400+ Zeilen und verwaltet 25+ Verantwortlichkeiten:
- Editor State Management
- AI Actions (Generate, Translate, Alt-Text)
- Translation Workflows (Accept & Translate, Translate All)
- Change Detection & Auto-Save
- Image Alt-Text Management
- Locale Navigation
- Fallback Field Handling

#### Empfohlene Aufteilung

| Neuer Hook | Verantwortung | Geschätzte Zeilen | Status |
|------------|---------------|-------------------|--------|
| `useEditorState` | State, Refs, Initialisierung | ~400 | Ausstehend |
| `useEditorTranslations` | Translate, Accept & Translate, Translate All | ~800 | Ausstehend |
| `useEditorAI` | AI Generate, AI Instructions | ~400 | Ausstehend |
| `useEditorAltText` | Alt-Text Generate, Translate, Save | ~500 | **Datei erstellt** ✅ |
| `useEditorAutoSave` | Change Detection, Debounced Save | ~300 | **Datei erstellt** ✅ |
| `useEditorLocale` | Locale Navigation, Dirty Check | ~200 | Ausstehend |
| `useUnifiedContentEditor` | Orchestrator (kombiniert die Hooks) | ~300 | Ausstehend |

#### Aktueller Stand (2026-04-05)

`useEditorAutoSave.ts` und `useEditorAltText.ts` wurden extrahiert und stehen als eigenständige Hooks bereit. Die Integration in `useUnifiedContentEditor.ts` steht noch aus.

**Blockierendes Problem für Integration:** Die Sub-Hooks benötigen Refs wie `savedLocaleRef`, `editableValuesRef`, `isSavePendingRef` (aktuell Zeile ~1163–1195) sowie Callbacks wie `buildFieldsForSave`, `safeSubmit`, `submitAIAction` (Zeile ~850–1006). Diese sind im Main-Hook nach der `hasAltTextChanges`-Berechnung definiert (Zeile 572), die ihrerseits schon `imageAltTexts`-State aus dem Sub-Hook braucht.

**Lösung für Integration:**
1. Refs (`savedLocaleRef`, `isSavePendingRef`, `isSaveFromTranslateRef`, `editableValuesRef`) in den STATE MANAGEMENT Block (vor Zeile 160) verschieben
2. Forwarding-Refs (`buildFieldsForSaveRef`, `safeSubmitRef`, `submitAIActionRef`) als `useRef(() => {})` früh erstellen
3. `useEditorAltText` direkt nach STATE MANAGEMENT aufrufen, Forwarding-Refs übergeben
4. Nach Definition von `buildFieldsForSave` / `safeSubmit` / `submitAIAction` diese den Forwarding-Refs zuweisen
5. Die duplizierten Abschnitte (ALT-TEXT HANDLERS, Zeile 3075–3651) aus dem Main-Hook entfernen

#### Voraussetzungen

- Alle aktuellen Bugs müssen vorher behoben sein (erledigt)
- `useLatestRef` Pattern ist bereits extrahiert (erledigt)
- State/Ref Duplizierung ist reduziert (erledigt)
- `useEditorAutoSave.ts` und `useEditorAltText.ts` existieren (erledigt)

---

### 3. Product-Sync: Error-Heuristik verbessern ✅ ERLEDIGT

**Priorität:** Niedrig  
**Status:** Behoben in `app/services/product-sync.service.ts`

Prozentualer Schwellenwert (≥ 50% Fehler) ersetzt absoluten Grenzwert (`>= 2`):
```typescript
const failureRate = translationResult.errorCount / publishedLocales.length;
if (publishedLocales.length >= 2 && failureRate >= 0.5) { ... }
```

---

### 4. Theme-Sync: Health-Check fehlt ✅ ERLEDIGT

**Priorität:** Niedrig  
**Status:** Behoben in `app/services/background-sync.service.ts`

`syncAllThemes()` prüft jetzt vor dem Cleanup: wenn Shopify 0 Theme-Ressourcen liefert, aber lokal Daten existieren → Abbruch (gleiche Pattern wie Pages/Policies).

---

### 5. DB-Only Translations: User-Feedback ✅ ERLEDIGT

**Priorität:** Niedrig  
**Status:** Behoben in `src/services/shopify-content.service.ts`

`updateContent()` gibt `{ success: true, warning: "..." }` zurück wenn Felder keinen Digest hatten und nur lokal gespeichert wurden. Das bestehende Warning-Banner im UI zeigt diese Meldung automatisch an.

---

## Changelog

| Datum | Änderung |
|-------|----------|
| 2026-02-15 | Initiales Dokument aus Code Reviews #1–#4 erstellt |
| 2026-04-05 | Items 1, 3, 4, 5 abgeschlossen; Item 2 teilweise (Sub-Hooks erstellt) |
