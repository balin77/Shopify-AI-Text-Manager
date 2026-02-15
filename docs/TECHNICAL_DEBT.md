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

### 1. Defense-in-Depth: `shop`-Spalte auf ContentTranslation

**Priorität:** Mittel
**Aufwand:** ~2–4 Stunden (Schema-Migration + Code-Anpassungen)
**Risiko aktuell:** Gering (Shopify GIDs sind plattformweit einzigartig)

#### Problem

Das `ContentTranslation`-Model hat keine `shop`-Spalte. Die Multi-Tenant-Isolation erfolgt ausschliesslich über `resourceId` (Shopify GID). Laut Shopify-Community sind GIDs "unique across the platform" ([Quelle](https://community.shopify.com/c/Shopify-APIs-and-SDKs/Uniqueness-of-ID-data-across-multiple-shopify-stores/m-p/1302048)), es gibt aber **keine offizielle Garantie** für alle Ressourcentypen (Pages, ShopPolicies).

> "if you didn't build the system just assume they aren't because 'should be' isn't engineering"
> — Shopify Community

#### Aktueller Stand

- `ContentTranslation` hat: `resourceId`, `resourceType`, `key`, `value`, `locale`, `digest`
- Kein `shop`-Feld vorhanden
- Alle Queries die `stalePageIds`/`stalePolicyIds` verwenden sind indirekt shop-scoped (IDs kommen aus vorherigen shop-gefilterten Queries)
- Kommentare im Code dokumentieren diese Design-Entscheidung

#### Empfohlene Umsetzung

1. Prisma-Schema erweitern:
   ```prisma
   model ContentTranslation {
     // ... bestehende Felder
     shop String  // NEU

     @@unique([resourceId, key, locale])
     @@index([shop, resourceType])  // NEU
   }
   ```
2. Migration ausführen mit Default-Wert aus Parent-Ressource
3. Alle `contentTranslation`-Queries um `shop`-Filter erweitern
4. Unique Constraint anpassen: `@@unique([shop, resourceId, key, locale])`

#### Quellen

- [Global IDs in Shopify APIs — Offizielle Doku](https://shopify.dev/docs/api/usage/gids)
- [Uniqueness of ID data across multiple stores](https://community.shopify.com/c/Shopify-APIs-and-SDKs/Uniqueness-of-ID-data-across-multiple-shopify-stores/m-p/1302048)
- [Are product IDs universally unique?](https://community.shopify.com/c/technical-q-a/are-product-ids-universally-unique/m-p/1201549)

---

### 2. Refactoring: useUnifiedContentEditor.ts

**Priorität:** Mittel
**Aufwand:** ~1–2 Tage
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

| Neuer Hook | Verantwortung | Geschätzte Zeilen |
|------------|---------------|-------------------|
| `useEditorState` | State, Refs, Initialisierung | ~400 |
| `useEditorTranslations` | Translate, Accept & Translate, Translate All | ~800 |
| `useEditorAI` | AI Generate, AI Instructions | ~400 |
| `useEditorAltText` | Alt-Text Generate, Translate, Save | ~500 |
| `useEditorAutoSave` | Change Detection, Debounced Save | ~300 |
| `useEditorLocale` | Locale Navigation, Dirty Check | ~200 |
| `useUnifiedContentEditor` | Orchestrator (kombiniert die Hooks) | ~300 |

#### Voraussetzungen

- Alle aktuellen Bugs müssen vorher behoben sein (erledigt)
- `useLatestRef` Pattern ist bereits extrahiert (erledigt)
- State/Ref Duplizierung ist reduziert (erledigt)

---

### 3. Product-Sync: Error-Heuristik verbessern

**Priorität:** Niedrig
**Aufwand:** ~30 Minuten
**Risiko aktuell:** Gering

#### Problem

`product-sync.service.ts` Zeile ~174 verwendet eine hardcodierte Heuristik:

```typescript
if (publishedLocales.length >= 2 && translationResult.errorCount >= 2) {
  throw new Error(...);
}
```

Dieses Abbruch-Kriterium basiert auf absoluten Zahlen statt auf Prozenten. Bei 10 Locales und 2 Fehlern (20%) wird abgebrochen, bei 3 Locales und 2 Fehlern (67%) ebenfalls — obwohl die Situationen sehr unterschiedlich sind.

#### Empfohlene Lösung

Prozentualen Schwellenwert verwenden (z.B. 50% der Locales fehlgeschlagen = Abbruch):

```typescript
const failureRate = translationResult.errorCount / publishedLocales.length;
if (publishedLocales.length >= 2 && failureRate >= 0.5) {
  throw new Error(...);
}
```

---

### 4. Theme-Sync: Health-Check fehlt

**Priorität:** Niedrig
**Aufwand:** ~15 Minuten

#### Problem

Pages und Policies haben Health-Checks die verhindern, dass bei einem API-Ausfall alle lokalen Daten gelöscht werden. `syncAllThemes()` hat diesen Schutz noch **nicht**.

#### Empfohlene Lösung

Gleiche Pattern wie bei Pages/Policies implementieren:
- Prüfen ob Shopify-API Fehler zurückgibt → abbrechen
- Prüfen ob 0 Themes zurückkommen aber lokal welche existieren → abbrechen

---

### 5. DB-Only Translations: User-Feedback

**Priorität:** Niedrig
**Aufwand:** ~30 Minuten

#### Problem

Wenn `shopify-content.service.ts` keine Shopify-Digest für ein Feld hat, wird die Übersetzung nur lokal in der DB gespeichert, aber **nicht** an Shopify gesendet. Der User sieht die Übersetzung im UI (aus der DB), aber beim nächsten Sync geht sie verloren.

#### Empfohlene Lösung

`updateContent()` sollte im Response markieren, welche Felder nur lokal gespeichert wurden, damit das UI eine Warnung anzeigen kann.

---

## Changelog

| Datum | Änderung |
|-------|----------|
| 2026-02-15 | Initiales Dokument aus Code Reviews #1–#4 erstellt |
