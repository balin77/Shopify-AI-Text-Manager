# Implementierungsplan: Theme-Auswahl B-lite (theme-bewusste Enumeration)

**Status:** Entwurf / umsetzungsbereit
**Baut auf:** [PLAN_THEME_SELECTION.md](./PLAN_THEME_SELECTION.md) (Datenmodell + Read/Write/UI bereits umgesetzt & gemerged, PR #2)
**Voraussetzung erfüllt:** Phase 0 empirisch abgeschlossen (siehe §0). Kein MAIN-only-Restrict.

---

## 0. Empirischer Befund (Phase 0 — ERLEDIGT)

Verifiziert am 2026-07-06 gegen `patis-universe-test-shop` (7 Themes: Dawn=MAIN, Publisher/… UNPUBLISHED)
über den erweiterten `/api/translation-probe` (Settings → Translation Coverage Probe):

1. **`translatableResources(resourceType:…)` enumeriert NUR das publizierte (MAIN) Theme.** Jede
   zurückgegebene `resourceId` trägt `theme_id=<MAIN>`. → Das ist die Ursache des 404: der Sync stempelt
   alle Zeilen mit MAIN; wählt der Merchant ein anderes Theme, filtert der Read-Scope
   (`themeId IN [selected, ""]`) sie weg.
2. **`translatableResource(resourceId:…)` und `translatableResourcesByIds` respektieren ein
   umgeschriebenes `theme_id`** und liefern die Inhalte eines UNPUBLISHED Themes (Read pro Theme ✅).
3. **`translationsRegister` mit umgeschriebener `theme_id`-GID schreibt isoliert ins Ziel-Theme**
   (Wert auf Ziel vorhanden, auf MAIN nicht; reversibel getestet) — Write pro Theme ✅, **kein
   Zusatz-Scope nötig**.
4. `themeFilesUpsert`/`themeFilesDelete` funktionieren auf dem Dev-Store ebenfalls pro Theme-GID
   (kein `write_themes`-Block) — für B-lite aber **nicht erforderlich** (nur relevant, falls Primär-
   Edit via Theme-Files auf Nicht-MAIN gebraucht wird; auf Produktiv-Shops evtl. Exemption-pflichtig).

**Konsequenz:** Multi-Theme (inkl. unpublished) ist machbar. Der einzige fehlende Baustein ist eine
**theme-bewusste Enumeration** im Sync. Alles andere (Read-Scoping, Write via GID, Primär-Write via
explizites `themeId`) ist bereits vorhanden.

Referenz: Memory `theme-selection-phase0-empirical`.

---

## 1. Ist-Zustand (aus Codebasis-Analyse, mit Zeilen)

**Bereits theme-aware (unverändert lassen):**
- Read-Scoping: `themeScope()` in `app/services/theme-content-api.server.ts:27-29`; Domain-Loader/Action
  `app/utils/theme-content-domain.server.ts:62-82, 180-193`; `templates-load.action.ts:9-19`;
  `api.theme-content.$domain.$.tsx:43-44,68-69`; AI-Translate `text-translation.handler.ts:363-372`.
- Selection: `theme-selection.server.ts` (`resolveSelectedThemeId` 115-134, `setSelectedThemeId` 144-170);
  Dropdown `ThemeContentDomainPage.tsx:1012-1091`; `api.select-theme.tsx`.
- Write (theme-adressiert via GID): `templates-update.action.ts` foreign-Pfad (TRANSLATE_CONTENT 263,
  §5.2-Divergenz-Guard 238-252), Primär-Pfad (`themeFilesUpsert` 707 mit explizitem `themeId` 549-552).
- DB-Writes stempeln `themeId` durchgängig via `extractThemeIdFromResourceId(resourceId)`.

**Die Lücke (das einzige echte To-do):**
- `app/services/background-sync.service.ts` → `runFullThemeSync` (ab 1258): Enumeration
  `translatableResources(resourceType, first, after)` (inline Query 1327-1350) **ohne Theme-Filter** →
  nur MAIN. `themeId` wird aus dem GID rekonstruiert (1645). Kein Pfad enumeriert ein Nicht-MAIN-Theme.
- `GET_THEME_FILES` (`content.queries.ts:252-267`) wird nur für gezielte Named-File-Reads im Primär-
  Write genutzt (`templates-update.action.ts:580`); **keine** Theme-Datei-Enumeration existiert.

---

## 2. Kernidee B-lite

Für ein **Ziel-Theme `T`** (das gewählte Theme, i. d. R. ≠ MAIN) die Resource-Menge **konstruieren
bzw. aus Theme-Dateien ableiten**, statt sie von `translatableResources` zu erwarten — dann Inhalte +
Digests per `translatableResourcesByIds` holen und mit `themeId = T` in die bestehenden Tabellen
schreiben. Downstream (Read/Write/UI) ist bereits theme-aware und greift ohne weitere Änderung.

### 2.1 Enumerations-Strategien nach resourceId-Form

Die sechs Theme-resourceTypes haben drei GID-Formen (aus der Probe verifiziert):

| resourceType | resourceId-Form | Strategie |
|---|---|---|
| `ONLINE_STORE_THEME_LOCALE_CONTENT` | `gid://…/OnlineStoreThemeLocaleContent/<themeNum>` | **A: Deterministisch** — direkt aus `T` bauen |
| `ONLINE_STORE_THEME_SETTINGS_DATA_SECTIONS` | `gid://…/OnlineStoreThemeSettingsDataSections/<themeNum>` | **A: Deterministisch** |
| (legacy `ONLINE_STORE_THEME`, im Sync bewusst weggelassen) | `gid://…/OnlineStoreTheme/<themeNum>` | A (falls je gebraucht) |
| `ONLINE_STORE_THEME_JSON_TEMPLATE` | `gid://…/OnlineStoreThemeJsonTemplate/<name>?theme_id=<themeNum>` | **B: Aus Theme-Dateien** (`templates/*.json`) |
| `ONLINE_STORE_THEME_SECTION_GROUP` | `gid://…/OnlineStoreThemeSectionGroup/<name>?theme_id=<themeNum>` | **B: Aus Theme-Dateien** (`sections/*.json`) |
| `ONLINE_STORE_THEME_SETTINGS_CATEGORY` | `gid://…/OnlineStoreThemeSettingsCategory/<Name>?theme_id=<themeNum>&first_setting_id=…` | **C: Rewrite MAIN→T** (MVP), voll aus `settings_schema.json` |
| `ONLINE_STORE_THEME_APP_EMBED` | `gid://…/OnlineStoreThemeAppEmbed/<name>?theme_id=<themeNum>&app_embed_…` | **C: Rewrite MAIN→T** (MVP), voll aus `settings_data.json` |

**Strategie A (deterministisch):** `resourceId = gid://shopify/<Type>/<numericThemeId>`. Direkt bauen,
kein Lookup. Deckt LOCALE_CONTENT (die 4171-Key-Masse) + SETTINGS_DATA_SECTIONS vollständig ab.

**Strategie B (aus Theme-Dateien):** `theme(id: T){ files(filenames: ["templates/*.json"]) }` bzw.
`["sections/*.json"]` (Glob wird von der Files-API unterstützt) → Basenamen extrahieren
(`templates/article.json` → `article`) → `gid://shopify/OnlineStoreThemeJsonTemplate/<name>?theme_id=<num>`
konstruieren. Über-Konstruktion ist unkritisch: `translatableResourcesByIds` liefert für ungültige/
leere Kombinationen einfach keinen/leeren `translatableContent` → wird übersprungen.

**Strategie C (Rewrite MAIN→T, MVP):** die von der MAIN-Enumeration bekannten SETTINGS_CATEGORY-/
APP_EMBED-`resourceId`s nehmen und ihr `theme_id` auf `T` umschreiben. Korrekt für Themes mit gleicher
Settings-/Embed-Struktur; theme-unique Kategorien/Embeds werden im MVP verpasst → **dokumentierte
Einschränkung**. Vollausbau: `config/settings_schema.json` (Kategorien) + `config/settings_data.json`
(App-Embed-Blocks) des Ziel-Themes parsen.

### 2.2 Inhalte + Übersetzungen holen

Für die konstruierten `resourceId`s (in Batches, `translatableResourcesByIds(resourceIds:[…], first:N)`):
- **Primärinhalt + Digest:** `translatableContent { key value digest locale }` — theme-spezifisch.
- **Fremdsprachen:** wie heute pro Nicht-Primär-Locale `translatableResource(resourceId){ translations(locale){ key value outdated } }`
  (analog `getThemeTranslations`, background-sync 1571-1584), nur mit den konstruierten IDs.

DB-Upsert exakt wie der bestehende Sync (`themeContent.upsert` 1671, `themeTranslation` 1731/1750),
aber mit `themeId = T` und der konstruierten `resourceId` (die `T`s `theme_id` trägt). Groupierung
(`groupId`/`groupName`/`groupIcon`) via der bestehenden Key→Group-Logik.

---

## 3. Umsetzung

### 3.1 Neuer Enumerations-Pfad im Sync
Datei: `app/services/background-sync.service.ts`.

- Neue private Methode `runThemeScopedSync(themeGid: string, onProgress?)`, die die Strategien A/B/C
  ausführt und Zeilen mit `themeId = themeGid` upsertet. Wiederverwendung der bestehenden Upsert-/
  Group-/Translation-Helfer (nicht duplizieren — die Schleifenkörper 1384-1800 refaktorisieren, sodass
  „Resource-Liste beschaffen" austauschbar ist gegen „konstruierte Liste").
- `runFullThemeSync` (MAIN, bestehend) bleibt der schnelle Enumerations-Pfad und deckt MAIN ab.
- Neuer GraphQL-Helper: `GET_THEME_FILE_LIST` = `theme(id: $themeId){ files(filenames: $globs){ nodes { filename } } }`
  (nur `filename`, kein `body`) in `content.queries.ts`.
- Batch-Query `GET_TRANSLATABLE_BY_IDS` = `translatableResourcesByIds(resourceIds: $ids, first: $n){ edges { node { resourceId translatableContent { key value digest locale } } } }`.

### 3.2 Trigger — wann wird ein Nicht-MAIN-Theme gesynct?
Kein teurer Voll-Sync aller Themes. Stattdessen **on-demand für das gewählte Theme**:

- **Empty-State-„Jetzt synchronisieren"** (existiert bereits, `ThemeContentDomainPage` §7.2 des Ur-Plans):
  aktuell ruft er den Voll-Sync (= MAIN). Umbiegen auf `runThemeScopedSync(selectedThemeId)` wenn
  `selectedThemeId !== mainThemeId`.
- **Beim Theme-Wechsel** (`handleThemeChange`/`api.select-theme`): nach dem Persistieren prüfen, ob für
  `selectedThemeId` bereits Zeilen existieren; falls nicht, `runThemeScopedSync` anstoßen (Task/Queue,
  nicht blockierend), UI zeigt „wird synchronisiert".
- **Periodischer Sync:** MAIN wie bisher; zusätzlich das aktuell gewählte Nicht-MAIN-Theme (falls
  vorhanden) im selben Zyklus auffrischen. Nicht ALLE Themes (Kostengrenze, vgl. Ur-Plan §9.3).

### 3.3 Read-/Write-Pfade
**Keine Änderung nötig** — bereits theme-aware (§1). Zwei Prüfpunkte:
- Der foreign-Write-Divergenz-Guard (`templates-update.action.ts:238-252`) vergleicht
  `extractThemeIdFromResourceId(resId) === selectedThemeId`. Da B-lite die DB-`resourceId` mit `T`s
  `theme_id` stempelt, passt das automatisch. Verifizieren, dass er bei B-lite-Zeilen nicht fälschlich
  triggert.
- `theme-content-api.server.ts` `updateContent` (297) hat **keinen** Divergenz-Guard (älterer Pfad).
  Da er nur von `api.theme-content.$domain.$.tsx` genutzt wird und `resourceId = firstGroup.resourceId`
  (theme-korrekt gescopet) nimmt, ok — optional denselben Guard nachrüsten.

### 3.4 Sofort-Mitigation gegen 404 (unabhängig, zuerst shippen)
Heute erzeugt ein gewähltes-aber-ungesynctes Theme 404s pro Gruppe statt eines sauberen Leerzustands.
- `loadThemeGroupResponse` (theme-content-api.server.ts:91-93) und der Domain-Loader: wenn für das
  gewählte Theme **keine** Zeilen existieren (nur `""`/andere), statt 404 einen `needsThemeSync:true`-
  Zustand liefern → UI zeigt Empty-State + „Jetzt synchronisieren" (statt kaputter Liste).
- Alternativ/ergänzend: Merchant kann im Dropdown auf MAIN zurück (funktioniert sofort).

---

## 4. Migrationen / Datenmodell
**Keine.** `ThemeContent.themeId`, `ThemeTranslation.themeId`, `AISettings.selectedThemeId` + Unique-Keys/
Indizes existieren bereits (PR #2). Backfill-Script `scripts/backfill-theme-id.js` bleibt gültig.

---

## 5. Schrittweiser Plan (klein geschnitten)

**Phase A — Sofort-Mitigation (1 PR, klein):**
- A.1 Empty-State statt 404 bei ungesynctem gewähltem Theme (§3.4).
- A.2 (Doku/Support) Merchants: unpublished Theme → „noch nicht synchronisiert".

**Phase B — Enumerations-Kern:**
- B.1 GraphQL-Helper `GET_THEME_FILE_LIST` + `GET_TRANSLATABLE_BY_IDS` (§3.1).
- B.2 `runThemeScopedSync(themeGid)`: Strategie A (deterministisch) für LOCALE_CONTENT +
  SETTINGS_DATA_SECTIONS. (Deckt die Key-Masse ab — schnellster Nutzwert.)
- B.3 Strategie B (Theme-Dateien) für JSON_TEMPLATE + SECTION_GROUP.
- B.4 Strategie C (Rewrite MAIN→T) für SETTINGS_CATEGORY + APP_EMBED (+ TODO: Vollausbau via
  settings_schema/settings_data).
- B.5 Refactor `runFullThemeSync`, sodass Resource-Beschaffung austauschbar ist (kein Copy-Paste).

**Phase C — Trigger:**
- C.1 Empty-State-„Sync"-Button auf `runThemeScopedSync(selectedThemeId)` umbiegen (§3.2).
- C.2 Auto-Sync beim Theme-Wechsel, falls Ziel-Theme leer.
- C.3 Periodischer Sync: MAIN + aktuell gewähltes Theme.

**Phase D — Verifikation & Aufräumen:**
- D.1 Foreign-Write-Guard gegen B-lite-Zeilen prüfen (§3.3).
- D.2 Probe-Diagnostik (`api.translation-probe` Theme-Abschnitte + Theme-Write-Test) entfernen oder
  hinter Dev-Flag verstecken (mutierender Test nicht dauerhaft in Prod-Settings).
- D.3 Nach garantiertem Backfill: `""`-Kompat-`OR` aus den Read-Scopes entfernen (Ur-Plan §7.3).

---

## 6. Test- / Verifikationsplan

**Manuell (Dev-Shop mit ≥2 Themes, ≥1 unpublished):**
1. Unpublished Theme wählen, das noch keine Zeilen hat → Empty-State + „Sync", **kein 404**.
2. „Sync" → `runThemeScopedSync` läuft → Templates/System-Tabs zeigen die Inhalte DES gewählten Themes.
3. Fremdsprache übersetzen → landet isoliert im gewählten Theme (im Shopify-Admin-Language-Editor bzw.
   via Probe verifizieren, dass MAIN unberührt bleibt).
4. Auf MAIN zurückwechseln → MAIN-Inhalte, unverändert.
5. Zwei strukturell verschiedene Themes (z. B. Dawn vs. Horizon): JSON_TEMPLATE/SECTION_GROUP-Listen
   unterscheiden sich korrekt (Strategie B); SETTINGS_CATEGORY/APP_EMBED-Lücken dokumentiert (Strategie C).

**Automatisiert:**
- Unit: resourceId-Konstruktion pro Strategie (A/B/C) + Basename-Extraktion aus `templates/*.json`.
- Unit: `runThemeScopedSync` mit gemocktem `translatableResourcesByIds`/`theme.files` (Zeilen mit
  korrektem `themeId` gestempelt; leere IDs übersprungen).
- Regression: `runFullThemeSync` (MAIN) unverändert grün.

---

## 7. Risiken / offene Punkte
- **Strategie-C-Lücke** (SETTINGS_CATEGORY/APP_EMBED theme-unique): MVP verpasst sie → als bekannte
  Einschränkung dokumentieren, Vollausbau als Follow-up.
- **`translatableResourcesByIds`-Batch-Limits/Rate-Limit:** Batchgröße konservativ (z. B. 50) + die
  bestehende 250-ms-Pausen-/Coalescing-Logik wiederverwenden (Translation-Rate-Limit ist streng).
- **Kosten bei vielen Themes:** nur MAIN + gewähltes Theme syncen, nicht alle (§3.2).
- **`write_themes`/Primär-Edit auf Nicht-MAIN:** orthogonal zu B-lite (B-lite schreibt Übersetzungen via
  `translationsRegister`, kein `write_themes`). Primär-Edit bleibt am `ENABLE_THEME_PRIMARY_EDIT`-Gate.
- **Digest-Aktualität:** Digests sind theme-spezifisch und werden beim Scoped-Sync frisch geholt — keine
  Cross-Theme-Digest-Verwechslung.
