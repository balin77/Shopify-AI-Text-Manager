# Technical Debt & Future Improvements

**Last Updated:** 2026-04-05
**Source:** Code Reviews #1–#5 (Claude Code)

---

## Zusammenfassung

Dieses Dokument erfasst alle technischen Schulden und geplanten Verbesserungen aus fünf Code-Reviews. Kritische Security-Issues, alle hohen und mittleren Prioritäten wurden vollständig behoben. Von den mittleren Refactoring-Items steht noch die vollständige Integration des `useUnifiedContentEditor`-Refactorings aus (Sub-Hooks wurden extrahiert und werden gerade eingebunden).

---

## Erledigte Issues

### Reviews #1–#4 (Architektur & Datenintegrität)

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

### Review #5 (Security, Performance & Refactoring)

| Issue | Commit | Status |
|-------|--------|--------|
| XSS: `dangerouslySetInnerHTML` ohne Sanitization (5 Dateien) | — | Behoben |
| TypeScript: `any`-Typen durch Interfaces ersetzt (15+ Stellen) | — | Behoben |
| Neue Typdatei `src/types/shopify-graphql.types.ts` erstellt | — | Behoben |
| `Promise.all` → `Promise.allSettled` in ai-queue.service.ts | — | Behoben |
| TODOs/Hardcoded Plan-Werte in UnifiedContentEditor.tsx | — | Behoben |
| Memory Leak: Unbegrenzte Shop-Queue in ai-queue.service.ts | — | Behoben |
| Adaptive Queue-Polling (100ms fix → 100ms/1s adaptiv) | — | Behoben |
| Regex-Berechnungen ohne useMemo (AISuggestionBanner, AISuggestionBox) | — | Behoben |
| Cursor-Wiederherstellung nach Sanitization (AIEditableHTMLField) | — | Behoben |
| Defense-in-Depth: `shop`-Spalte auf ContentTranslation | `7c388c9`, `9c50dba` | Behoben |
| Product-Sync: Error-Heuristik (absolut → prozentual) | `7c388c9` | Behoben |
| Theme-Sync: Health-Check gegen API-Ausfall | `7c388c9` | Behoben |
| DB-Only Translations: Warning an UI zurückgeben | `7c388c9` | Behoben |
| useEditorAutoSave extrahiert und in useUnifiedContentEditor integriert | `7c388c9`, aktuell | Behoben |
| useEditorAltText extrahiert und in useUnifiedContentEditor integriert | `9c50dba`, aktuell | Behoben |

---

## Offene Items

### 1. Refactoring: useUnifiedContentEditor.ts — Integration der Sub-Hooks

**Priorität:** Mittel
**Aufwand:** ~0.5 Tage
**Risiko aktuell:** Wartbarkeit (keine funktionalen Bugs)

#### Stand der extrahierten Hooks

| Hook | Datei | Zeilen | Status |
|------|-------|--------|--------|
| `useEditorAutoSave` | `app/hooks/useEditorAutoSave.ts` | 296 | ✅ Extrahiert und integriert |
| `useEditorAltText` | `app/hooks/useEditorAltText.ts` | 747 | ✅ Extrahiert und integriert |
| `useEditorState` | — | ~400 | Ausstehend |
| `useEditorTranslations` | — | ~800 | Ausstehend |
| `useEditorAI` | — | ~400 | Ausstehend |
| `useEditorLocale` | — | ~200 | Ausstehend |

#### Integrationsstrategie (Ref-Forwarding-Pattern)

Da `useEditorAltText` `buildFieldsForSave`/`safeSubmit` benötigt, diese aber erst nach dem Hook-Aufruf definiert werden können, werden Forwarding-Refs als Platzhalter eingesetzt:

```typescript
const buildFieldsForSaveRef = useRef<(v: Record<string,string>, l: string) => Record<string,string>>(() => ({}));
const safeSubmitRef = useRef<(data: Record<string,any>, opts?: any) => void>(() => {});
const submitAIActionRef = useRef<(...args: any[]) => void>(async () => {});
```

Nach Definition der echten Funktionen werden die Refs befüllt:
```typescript
buildFieldsForSaveRef.current = buildFieldsForSave;
safeSubmitRef.current = safeSubmit;
submitAIActionRef.current = submitAIAction;
```

#### Noch ausstehende Hooks

Für die verbleibenden Hooks (`useEditorState`, `useEditorTranslations`, `useEditorAI`, `useEditorLocale`) ist eine ähnliche Extraktion geplant. Voraussetzung: Die Integration von `useEditorAutoSave` und `useEditorAltText` muss stabil laufen.

---

### 2. Logging Konsolidierung

**Priorität:** Niedrig
**Aufwand:** ~2–4 Stunden

467 `console.*`-Aufrufe sollten durch einen zentralen Logger ersetzt werden (strukturierte Logs, Log-Level-Kontrolle).

---

### 3. Input Validation mit Zod

**Priorität:** Niedrig
**Aufwand:** ~1 Tag

Alle API-Routen sollten Zod-Schemas für Input-Validierung erhalten.

---

### 4. Variant 3D Save ↔ Refresh Race Condition

**Priorität:** Niedrig (Single-Merchant unwahrscheinlich, relevant bei Multi-User-Shops)
**Aufwand:** ~4–6 Stunden
**Files:** [app/routes/api.update-variant-galleries.tsx](../app/routes/api.update-variant-galleries.tsx), [app/routes/api.refresh-3d-previews.tsx](../app/routes/api.refresh-3d-previews.tsx)

Beide Endpoints schreiben die parallelen `variant_3d_models` + `variant_3d_previews` Metafields mit Read-Modify-Write ohne Versionsschutz. Wenn beide innerhalb hunderter Millisekunden den gleichen Variant berühren, gewinnt der spätere Write basierend auf einem veralteten Read — der frühere Write geht verloren.

**Wann kann es auftreten:**

| Zeit | Event |
|------|-------|
| `t=0s` | Merchant lädt 3D-Modell A hoch + klickt Save. Save returnt nach ~2s mit "processing"-Carry-Over (Modell auf Shopify, Source-URL noch nicht fertig). |
| `t=10s` | Background-Polling Tick liest `variant_3d_models = [savedA, savedB]`, plant `[savedA, savedB, newA_cdn]`. |
| `t=10.5s` | **Bevor** Tick committed: Merchant löst zweiten Save aus (z.B. neues Bild in anderer Variante). Save liest noch `[savedA, savedB]`, plant `[savedA, savedB, newImg]`. |
| `t=10.7s` | Tick schreibt `[savedA, savedB, newA_cdn]` → `newImg` fehlt. |
| `t=10.8s` | Save schreibt `[savedA, savedB, newImg]` → `newA_cdn` weg. |

→ Last-Write-Wins, ein Write geht verloren.

**Warum unwahrscheinlich in Praxis:**

- Solo-Merchant macht selten zwei Saves innerhalb von 10–60s
- Race-Window ist nur hunderte Millisekunden (HTTP-Roundtrip-Dauer beider Endpoints)
- Beide müssen das gleiche Variant-Metafield anfassen

**Fix-Pattern (wenn nötig):**

Optimistic Concurrency via `MetafieldsSetInput`'s `updatedAt` Vergleich oder Custom Version-Token im Metafield-Wert. Beide Endpoints:

1. Read Metafield **mit** `updatedAt`-Snapshot
2. Read-Modify-Write
3. Im `metafieldsSet`-Call: wenn aktueller `updatedAt` !== Snapshot → 409 Conflict, Retry mit fresh Read

Alternativ: ein gemeinsames Write-Lock im DB-Layer (z.B. Redis advisory lock per `variantId`).

---

## Changelog

| Datum | Änderung |
|-------|----------|
| 2026-02-15 | Initiales Dokument aus Code Reviews #1–#4 erstellt |
| 2026-04-05 | Items 1, 3, 4, 5 (Review #5) abgeschlossen; Sub-Hooks extrahiert; Integrationsplan dokumentiert |
| 2026-04-05 | CODE_IMPROVEMENTS.md zusammengeführt; Review #5 Items in Erledigte-Tabelle aufgenommen |
| 2026-06-16 | Variant 3D Save↔Refresh Race Condition (B6/B7 aus Multi-Agent-Review) als Ausstehendes Item #4 dokumentiert |
| 2026-04-06 | `useEditorAutoSave` und `useEditorAltText` in `useUnifiedContentEditor` integriert (Ref-Forwarding-Pattern) |
