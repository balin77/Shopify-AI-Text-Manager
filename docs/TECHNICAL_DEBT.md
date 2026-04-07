# Technical Debt & Future Improvements

**Last Updated:** 2026-04-05
**Source:** Code Reviews #1–#4 (Claude Code)

---

## Zusammenfassung

Dieses Dokument erfasst alle technischen Schulden und geplanten Verbesserungen, die aus vier Code-Reviews identifiziert wurden. Alle kritischen und hohen Issues wurden bereits behoben. Von den mittleren/niedrigen Items steht noch die vollständige Integration des `useUnifiedContentEditor`-Refactorings aus.

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
| Defense-in-Depth: `shop`-Spalte auf ContentTranslation | `7c388c9`, `9c50dba` | Behoben |
| Product-Sync: Error-Heuristik (absolut → prozentual) | `7c388c9` | Behoben |
| Theme-Sync: Health-Check gegen API-Ausfall | `7c388c9` | Behoben |
| DB-Only Translations: Warning an UI zurückgeben | `7c388c9` | Behoben |
| useEditorAutoSave aus useUnifiedContentEditor extrahiert | `7c388c9` | Datei erstellt |
| useEditorAltText aus useUnifiedContentEditor extrahiert | `9c50dba` | Datei erstellt |

---

## Offene Items

### 1. Refactoring: useUnifiedContentEditor.ts — Integration der Sub-Hooks

**Priorität:** Mittel
**Aufwand:** ~0.5 Tage
**Risiko aktuell:** Wartbarkeit (keine funktionalen Bugs)

#### Kontext

`useUnifiedContentEditor.ts` hat 3.864 Zeilen und verwaltet 25+ Verantwortlichkeiten. Die Sub-Hooks wurden bereits extrahiert und stehen als eigenständige Dateien bereit. Ausstehend ist die Verdrahtung in den Main-Hook.

#### Stand der extrahierten Hooks

| Hook | Datei | Zeilen | Status |
|------|-------|--------|--------|
| `useEditorAutoSave` | `app/hooks/useEditorAutoSave.ts` | 296 | Datei erstellt, **nicht integriert** |
| `useEditorAltText` | `app/hooks/useEditorAltText.ts` | 747 | Datei erstellt, **nicht integriert** |
| `useEditorState` | — | ~400 | Ausstehend |
| `useEditorTranslations` | — | ~800 | Ausstehend |
| `useEditorAI` | — | ~400 | Ausstehend |
| `useEditorLocale` | — | ~200 | Ausstehend |

#### Blockierendes Problem für Integration von `useEditorAltText`

Der Alt-Text-State (`imageAltTexts`, `originalAltTexts`) wird bereits bei `hasAltTextChanges` (Zeile ~572) benötigt. `useEditorAltText` seinerseits braucht `buildFieldsForSave`, `safeSubmit` und `submitAIAction`, die erst bei Zeile ~850–1006 definiert sind. Direktes Aufrufen des Sub-Hooks nach Zeile 1006 erzeugt einen JavaScript-Scoping-Fehler für Zeile 572.

#### Lösung: Ref-Forwarding-Pattern

1. Diese Refs früh in den STATE MANAGEMENT Block (vor Zeile 160) verschieben:
   - `savedLocaleRef`, `isSavePendingRef`, `isSaveFromTranslateRef`, `editableValuesRef`
2. Forwarding-Refs als Platzhalter direkt nach STATE MANAGEMENT anlegen:
   ```typescript
   const buildFieldsForSaveRef = useRef<(v: Record<string,string>, l: string) => Record<string,string>>(() => ({}));
   const safeSubmitRef = useRef<(data: Record<string,any>, opts?: any) => void>(() => {});
   const submitAIActionRef = useRef<(...args: any[]) => void>(async () => {});
   ```
3. `useEditorAltText` direkt nach STATE MANAGEMENT aufrufen und die Forwarding-Refs übergeben (statt der Funktionen direkt)
4. Nach Definition der echten Funktionen (`buildFieldsForSave`, `safeSubmit`, `submitAIAction`) Refs befüllen:
   ```typescript
   buildFieldsForSaveRef.current = buildFieldsForSave;
   safeSubmitRef.current = safeSubmit;
   submitAIActionRef.current = submitAIAction;
   ```
5. Duplikate aus dem Main-Hook entfernen:
   - STATE MANAGEMENT: Alt-Text-State-Deklarationen (Zeile ~161–174)
   - ALT-TEXT HANDLERS Section (Zeile ~3075–3611)
   - SEND IMAGE TO AI HANDLERS Section (Zeile ~3612–3651)

Für `useEditorAutoSave` analog: Hooks-Interface erwartet bereits `saveQueueRef` etc. als Props — die Refs früh definieren und übergeben, danach den AUTO-SAVE FUNCTION Block (Zeile ~835–1122) entfernen.

---

## Changelog

| Datum | Änderung |
|-------|----------|
| 2026-02-15 | Initiales Dokument aus Code Reviews #1–#4 erstellt |
| 2026-04-05 | Items 1, 3, 4, 5 vollständig abgeschlossen; Item 2 Sub-Hooks (`useEditorAutoSave`, `useEditorAltText`) erstellt; Integrationsplan dokumentiert |
