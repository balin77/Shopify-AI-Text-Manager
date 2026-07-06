# Implementierungsplan: Theme-Auswahl

**Feature:** Der Merchant soll wählen können, WELCHES installierte Theme (z. B. Dawn vs. Horizon)
für theme-bezogene Inhalte (Templates, Theme-Settings, Locale-Content) bearbeitet/übersetzt wird.
Aktuell nimmt die App implizit immer das MAIN/publizierte Theme.

**Status:** Entwurf / umsetzungsbereit
**Autor:** Architektur
**Betroffene Domains:** ausschließlich Theme-Content-Familie (siehe §1). Produkte, Collections,
Pages, Blogs, Articles, Policies, Metaobjects usw. bleiben unberührt.

---

## 1. Zieldefinition & Scope

### In-Scope
Nur die Theme-Content-Familie, die über die Tabellen `ThemeContent` / `ThemeTranslation` und den
Handler `templates-update.action.ts` läuft. Definiert in
`app/utils/content-type-groups.ts` → `THEME_CONTENT_TYPES`:

```
templates | system | delivery | sellingPlans | onlineStoreExtras
```

Die betroffenen Shopify-resourceTypes (aus `content.service.ts:getThemes()` → `WORKING_RESOURCE_TYPES`
und `theme-content-domain.server.ts`):
`ONLINE_STORE_THEME`, `ONLINE_STORE_THEME_JSON_TEMPLATE`, `ONLINE_STORE_THEME_LOCALE_CONTENT`,
`ONLINE_STORE_THEME_SECTION_GROUP`, `ONLINE_STORE_THEME_SETTINGS_CATEGORY`,
`ONLINE_STORE_THEME_SETTINGS_DATA_SECTIONS`.

### Out-of-Scope (bleibt unverändert)
- Alle Nicht-Theme-ContentTypes. Prüfung erfolgt zentral über `isThemeContentType(contentType)`.
- Das Übersetzungsverhalten selbst (translationsRegister, Digest-Logik, richtext-Autofix).
- Die Feature-Gate `ENABLE_THEME_PRIMARY_EDIT` (bleibt orthogonal — siehe §9).

### Kernproblem (aus Codebasis-Analyse)
Es gibt heute KEINE Theme-Auswahl. Zwei Pfade divergieren latent:

1. **Primary-Schreibpfad** (`templates-update.action.ts:485-505`): Holt via `GET_THEMES` ALLE Themes,
   verwirft aber alle außer `role === "MAIN"` und schreibt hart gegen `mainTheme.node.id`. Andernfalls
   Fehler „No active (MAIN) theme found“.
2. **Foreign-Übersetzungspfad** (`templates-update.action.ts:~240`, `TRANSLATE_CONTENT` /
   `translationsRegister`): keyed nach `resourceId`. Die Theme-Identität steckt IMPLIZIT in der
   resourceId-GID (z. B. `gid://shopify/OnlineStoreThemeSettingsCategory/Brand+information?theme_id=…`).
3. **Read/Sync-Pfad** (`content.service.ts:697 getThemes()`): theme-AGNOSTISCH — liest via
   `translatableResources(resourceType:…)` ohne Theme-Filter. Erfasst also Ressourcen aus dem/den
   Theme(s), die Shopify zurückgibt (i. d. R. das publizierte, aber nicht garantiert).

→ Wenn der Sync eine Ressource aus einem Nicht-MAIN-Theme erfasst, zeigt die App deren Inhalt an,
schreibt Primary-Edits aber gegen MAIN (falsches Theme) und Übersetzungen gegen die im Sync erfasste
GID (evtl. anderes Theme). **Dieser Plan muss beide Pfade auf DASSELBE, explizit gewählte Theme
zwingen.**

---

## 2. Shopify-API-Recherche (verifiziert, mit Unsicherheiten markiert)

Quellen: shopify.dev Admin GraphQL (Stand Juli 2026).

### Fakt A — `translatableResources` kann NICHT nach Theme gefiltert werden
Die Query `translatableResources` akzeptiert nur: `first/last/after/before/reverse` und das
**Pflicht**-Argument `resourceType: TranslatableResourceType`. **Es gibt kein `themeId`- oder
`id`-Filterargument.** (Doku: queries/translatableResources.)
→ Konsequenz: Wir können translatable Resources NICHT serverseitig nach Theme einschränken. Wir
erhalten alle translatable Theme-Ressourcen und müssen client-/serverseitig nach der im `resourceId`
eingebetteten `theme_id` filtern (siehe Fakt C).

### Fakt B — `OnlineStoreTheme` hat KEINE `translatableResources`-Connection
Das Objekt `theme(id:)` / `OnlineStoreTheme` bietet **keine** `translatableResources`-Verbindung.
Es implementiert `HasPublishedTranslations` und hat ein Feld `translations(locale:, marketId:)`
(Typ `[Translation!]!`), das aber nur die BEREITS PUBLIZIERTEN Übersetzungen dieser Theme-Ressource
liefert — kein Ersatz für das translatable-Resources-Listing (keine `key`/`digest`-Enumeration der
übersetzbaren Felder). (Doku: objects/OnlineStoreTheme.)
→ Konsequenz: Es gibt keinen „pro Theme lesen“-Königsweg über das Theme-Objekt. Der Read bleibt bei
`translatableResources(resourceType:…)`; Theme-Scoping passiert über die eingebettete `theme_id`.

### Fakt C — `theme_id` steckt in Theme-resource-GIDs (teilweise verifiziert, teils „zu verifizieren“)
**Verifiziert im eigenen Code/Memory:** Für `ONLINE_STORE_THEME_SETTINGS_CATEGORY` ist die resourceId
z. B.
`gid://shopify/OnlineStoreThemeSettingsCategory/Brand+information?theme_id=<ID>&first_setting_id=brand_headline`
(siehe `templates-update.action.ts:48` Kommentar + Projekt-Memory). Der `theme_id`-Query-Parameter
ist also nachweislich Teil der GID.

**Zu verifizieren (vor Umsetzung Phase 0 empirisch prüfen):** Ob ALLE relevanten resourceTypes das
`theme_id` in der GID tragen — insbesondere `ONLINE_STORE_THEME_JSON_TEMPLATE`,
`ONLINE_STORE_THEME_LOCALE_CONTENT`, `ONLINE_STORE_THEME_SECTION_GROUP`,
`ONLINE_STORE_THEME_SETTINGS_DATA_SECTIONS`, `ONLINE_STORE_THEME` (Legacy). Erwartung:
ja (Shopify unterscheidet dieselbe Datei über mehrere Themes nur über `theme_id`), aber das MUSS
gegen den echten Shop verifiziert werden, bevor auf GID-Extraktion als alleinige Scoping-Quelle
gebaut wird.

**Verifikations-Snippet (Phase 0, gegen echten Dev-Shop):**
```graphql
query { translatableResources(first: 5, resourceType: ONLINE_STORE_THEME_JSON_TEMPLATE) {
  edges { node { resourceId } } } }
```
Für jeden resourceType prüfen, ob `resourceId` einen `theme_id=`-Parameter enthält, und ob die IDs
den `themes`-IDs entsprechen.

### Fakt D — Themes werden über `themes(first:)` enumeriert
`GET_THEMES` (`content.queries.ts:235`) liefert `id, name, role, themeStoreId, createdAt, updatedAt`.
`role` ist einer von `MAIN` (publiziert), `UNPUBLISHED`, `DEMO`, `DEVELOPMENT`, `ARCHIVED` etc.
Diese Query ist die Quelle der Theme-Dropdown-Liste.

### Fakt E — Theme-Schreiben ist bereits theme-scoped
`GET_THEME_FILES` und `themeFilesUpsert` (`content.mutations.ts:148`) nehmen bereits `themeId` als
Argument. Der Umbau des Schreibpfads ist daher „nur“ das Ersetzen der Theme-Auswahl-Quelle
(MAIN-Lookup → gewähltes Theme), nicht eine neue Mutation.

**Unsicherheit / Risiko (dokumentieren):** Ob `themeFilesUpsert` gegen ein UNPUBLISHED/DEVELOPMENT
Theme mit dem Standard-Scope `write_themes` erlaubt ist, gilt als „zu verifizieren“ (Fakt E-Risk).
`translationsRegister` gegen eine Nicht-MAIN-`theme_id`-GID ebenso — in Phase 0 gegen ein zweites,
unpubliziertes Theme testen.

---

## 3. Datenmodell-Migration

### 3.1 Schema-Änderungen (`prisma/schema.prisma`)

**`ThemeContent`** (aktuell `schema.prisma:681-708`): Spalte + Unique-Key erweitern.
```prisma
model ThemeContent {
  // ... bestehende Felder ...
  themeId             String   @default("")  // Shopify Theme-GID; "" = Legacy/vor Migration
  // ...
  @@unique([shop, resourceId, groupId, themeId])   // war: [shop, resourceId, groupId]
  @@index([shop])
  @@index([shop, groupId])
  @@index([shop, domain])
  @@index([shop, themeId])                          // NEU
  @@index([lastSyncedAt])
}
```

**`ThemeTranslation`** (aktuell `schema.prisma:710-731`):
```prisma
model ThemeTranslation {
  // ... bestehende Felder ...
  themeId    String  @default("")
  // ...
  @@unique([shop, resourceId, groupId, key, locale, themeId]) // war ohne themeId
  @@index([shop, resourceId, groupId])
  @@index([shop, groupId, locale])
  @@index([shop, domain])
  @@index([shop, themeId])                                    // NEU
  @@index([locale])
}
```

Begründung `@default("")` statt nullable: erlaubt schmerzfreie Migration bestehender Zeilen und ein
deterministisches Unique-Verhalten. `""` bedeutet „noch nicht theme-zugeordnet“ (Backfill-Kandidat).

### 3.2 Migration + Backfill (Pattern wie `docs/PRISMA_MIGRATION_GUIDE.md`)
Idempotente SQL-Migration unter `prisma/migrations/<datum>_add_theme_id/migration.sql`:

1. `ALTER TABLE "ThemeContent" ADD COLUMN IF NOT EXISTS "themeId" TEXT NOT NULL DEFAULT '';`
2. Dito `ThemeTranslation`.
3. Alte Unique-Constraints droppen, neue anlegen (`IF NOT EXISTS`/`IF EXISTS`-geschützt).
4. Neue Indizes anlegen.

**Backfill-Strategie (Script `scripts/backfill-theme-id.js`, nach der Struktur-Migration):**
Pro `shop`:
- (a) `theme_id` aus der `resourceId`-GID extrahieren (Regex `[?&]theme_id=([^&]+)`), sofern vorhanden.
  Achtung: der Wert im GID-Query-Parameter ist meist die NUMERISCHE ID; auf die volle GID-Form
  `gid://shopify/OnlineStoreTheme/<n>` normalisieren, damit sie mit `themes.id` vergleichbar ist.
- (b) Fallback: Zeilen ohne extrahierbares `theme_id` → dem aktuellen MAIN-Theme zuordnen
  (ein `GET_THEMES`-Aufruf pro Shop, MAIN-GID einsetzen). Das entspricht dem bisherigen impliziten
  Verhalten und ist damit verlustfrei.
- Backfill NUR für Zeilen mit `themeId = ''` (idempotent, mehrfach ausführbar).

**Wichtig:** Die Struktur-Migration muss VOR dem Deploy des neuen Codes laufen (Railway pre-deploy),
der Backfill danach oder als Teil desselben Scripts. Bis der Backfill läuft, behandelt der Lesecode
`themeId = ''` als „gehört zum aktiven Theme“ (Kompatibilitätsschicht, §4.4).

---

## 4. Sync / Read-Scoping (theme-bewusst)

### 4.1 Theme-Ermittlung zur Sync-Zeit
Da `translatableResources` nicht filterbar ist (Fakt A), extrahiert der Sync das `theme_id` aus jeder
zurückgegebenen `resourceId` und schreibt es in `ThemeContent.themeId`. Neue Helper-Funktion
(z. B. `app/utils/theme-id.ts`):
```ts
export function extractThemeIdFromResourceId(resourceId: string): string | null
// parst [?&]theme_id=… , normalisiert auf gid://shopify/OnlineStoreTheme/<n>
```
Aufrufstelle: `content.service.ts:getThemes()` beim Persistieren jeder Zeile (dort, wo Zeilen aktuell
nach `resource.resourceId` gekeyt werden, ~`content.service.ts:936`) sowie im Domain-Sync
`theme-content-domain.server.ts` (System/Delivery/SellingPlans/OnlineStoreExtras).

**Fallback bei fehlendem theme_id (Fakt C-Unsicherheit):** Wenn ein resourceType KEIN `theme_id`
trägt, wird die Zeile dem aktiven MAIN-Theme (bzw. dem aktuell gewählten Theme, §6) zugeordnet. Das
darf erst nach der Phase-0-Verifikation als Fallback bleiben; falls ein relevanter resourceType
generell kein theme_id trägt, ist das Feature für diesen Typ auf „nur aktives Theme“ beschränkt
(im Plan als bekannte Einschränkung dokumentieren).

### 4.2 Sync-Scoping-Filter
Da wir alle Themes gemischt zurückbekommen, aber pro Theme speichern wollen: der Sync schreibt ALLE
erfassten Ressourcen mit ihrem jeweiligen `themeId` in die DB (keine Filterung beim Schreiben — so
werden mehrere Themes koexistierend persistiert). Der READ (Loader) filtert dann nach dem gewählten
`themeId` (§4.3).

Optional/Performance (siehe §9): Ein „nur aktives Theme syncen“-Modus, der Ressourcen mit
`themeId !== selectedThemeId` verwirft, um Sync-Kosten/DB-Größe zu begrenzen. Default: alle
persistieren, damit Theme-Wechsel ohne Re-Sync funktioniert.

### 4.3 Read/Loader-Scoping
Überall wo `ThemeContent`/`ThemeTranslation` gelesen werden (Loader der Theme-Routen +
`theme-content-domain.server.ts`), die Query um `themeId: selectedThemeId` erweitern. Kompatibilität:
`where: { shop, domain, OR: [{ themeId: selectedThemeId }, { themeId: "" }] }` solange Backfill nicht
garantiert abgeschlossen ist (danach kann das `{ themeId: "" }` entfernt werden).

Betroffene Lesepfade (per Grep `ThemeContent`/`ThemeTranslation` im `app/`-Verzeichnis vor Umsetzung
final auflisten):
- Theme-Route-Loader (die Route(n), die `UnifiedContentEditor` mit `contentType ∈ THEME_CONTENT_TYPES`
  rendern).
- `theme-content-domain.server.ts` (Gruppen-/Feld-Auflösung, `keyToResourceType`-Map).

### 4.4 Neue Themes entdecken
`syncAllX` entdeckt neue Ressourcen; per-resource reload refresht nur bekannte IDs (Projekt-Memory:
„Reload never discovers new resources“). Da der Theme-Sync alle Themes gemischt liest, entdeckt ein
voller Sync automatisch Ressourcen neu installierter/neuer Themes und persistiert sie mit deren
`themeId`. Die Theme-DROPDOWN-Liste selbst kommt frisch aus `GET_THEMES` (kein Sync nötig, §6).

---

## 5. Write-Pfad-Fix (`templates-update.action.ts`)

### 5.1 Primary-Pfad (Zeilen 485-520)
Den harten MAIN-Lookup ersetzen:
```ts
// ALT:
const mainTheme = themesData.data?.themes?.edges?.find(e => e.node.role === "MAIN");
if (!mainTheme) return json({ success:false, error:"No active (MAIN) theme found." }, 500);
const themeId = mainTheme.node.id;

// NEU:
const selectedThemeId = await resolveSelectedThemeId(session.shop, admin); // §6
// resolveSelectedThemeId: liest AISettings.selectedThemeId; validiert gegen GET_THEMES;
// fällt auf MAIN zurück, wenn null / Theme nicht mehr existiert.
const themeId = selectedThemeId;
```
`resolveSelectedThemeId` (neuer Helper, z. B. `app/services/theme-selection.server.ts`):
1. `AISettings.selectedThemeId` lesen.
2. `GET_THEMES` holen; prüfen ob die ID noch existiert.
3. Falls null/ungültig → MAIN-Theme-GID; wenn kein MAIN existiert → erste verfügbare/Fehler.
4. Rückgabe der validen Theme-GID.

### 5.2 Foreign-Pfad (translationsRegister, ~Zeile 240)
Der Foreign-Pfad keyt heute über die `resourceId`-GID, die das `theme_id` bereits enthält. Damit
Primary und Foreign DASSELBE Theme adressieren, muss der Foreign-Pfad die `resourceId` des GEWÄHLTEN
Themes verwenden — d. h. die aus der DB (`ThemeContent.resourceId` der Zeile mit
`themeId = selectedThemeId`) gelesene GID, NICHT eine potenziell aus einem anderen Theme stammende.
Da §4.3 den Read bereits auf `selectedThemeId` scopet, trägt `selectedItem` automatisch die richtige
GID. Sicherstellen (Assertion/Log): `extractThemeIdFromResourceId(resourceId) === selectedThemeId`
(bzw. `""`-Fallback) vor `translationsRegister`; bei Divergenz Fehler statt stillem Schreiben in ein
fremdes Theme.

### 5.3 Divergenz-Auflösung (die zentrale Korrektur)
Nach §5.1 + §5.2 zielen beide Pfade auf `selectedThemeId`:
- Primary: `themeFilesUpsert(themeId: selectedThemeId, …)`.
- Foreign: `translationsRegister` gegen die resourceId, deren eingebettetes theme_id `selectedThemeId`
  ist.
Der DB-Mirror (STEP 2b) schreibt mit `themeId: selectedThemeId` in die (jetzt themeId-tragenden)
Unique-Keys.

---

## 6. Theme-Enumeration + Persistenz

### 6.1 Persistenz — pro Shop in `AISettings`
Neues Feld (`schema.prisma:31` AISettings, direkt neben `themeRichtextMode:53`):
```prisma
  // Vom Merchant gewähltes Theme für theme-bezogene Inhalte (Templates/Settings/
  // Locale-Content). null = automatisch das publizierte (MAIN) Theme verwenden.
  selectedThemeId   String?
```
Begründung „pro Shop, nicht pro Session“: Der DB-Datenbestand (ThemeContent) ist shop-scoped; die
Theme-Wahl muss zum gespeicherten Content passen und über Sessions/Geräte stabil sein. Default
`null` ⇒ MAIN (rückwärtskompatibel).

### 6.2 Schreiben der Wahl
Neuer Action-Endpoint bzw. Erweiterung des bestehenden Settings-Save:
`POST /api/select-theme` (oder Feld in bestehender AISettings-Action). Body: `{ themeId }`.
Validiert gegen `GET_THEMES` (nur existierende IDs akzeptieren). Schreibt
`AISettings.selectedThemeId`. Kein automatischer Full-Sync (der wäre teuer) — stattdessen Loader-Reload
(§7).

### 6.3 Theme-Liste ins UI
Die Theme-Route-Loader (die `UnifiedContentEditor` für Theme-ContentTypes rendern) rufen `GET_THEMES`
auf und liefern zusätzlich:
```ts
{ themes: [{ id, name, role }], selectedThemeId: aiSettings.selectedThemeId ?? mainThemeId }
```
`GET_THEMES` ist bereits in `content.service.ts:11` importiert (aber ungenutzt) — Aufruf dort kapseln
(`contentService.listThemes()`), damit Loader es nutzen können. Optional: Rollenlabel für die UI
(„(publiziert)“ für MAIN) aus `role` ableiten.

---

## 7. UI — Theme-Dropdown in der Item-Liste

### 7.1 Exakte Platzierung
Komponente: **`app/components/unified/UnifiedItemList.tsx`**.
Der Header-Block liegt in `<div ref={headerRef}>` (`UnifiedItemList.tsx:576`), enthält eine
`<BlockStack gap="300">` mit:
1. Titelzeile + Action-Buttons (`InlineStack`, Zeilen 578-703)
2. **Search-`TextField`** (Zeilen 706-717)
3. Plan-Limit-Banner (Zeilen 719-739)

→ **Der neue Theme-Abschnitt wird als EIGENER Block DIREKT NACH dem Search-`TextField`
(nach Zeile 717) und VOR dem Plan-Limit-Banner eingefügt**, weiterhin innerhalb der
`<BlockStack gap="300">`. Das ergibt exakt „eigener Abschnitt unter der Searchbar“.

Vorschlag-Markup (Polaris):
```tsx
{/* Theme selector — nur bei theme-relevanten Inhalten */}
{showThemeSelector && themeOptions && themeOptions.length > 1 && (
  <BlockStack gap="100">
    <Select
      label={t.themeSelectorLabel || "Theme"}
      labelHidden={false}
      options={themeOptions}          {/* [{label, value}] aus GET_THEMES */}
      value={selectedThemeId}
      onChange={onThemeChange}
      disabled={isSyncing}
      helpText={t.themeSelectorHelp}  {/* optional */}
    />
  </BlockStack>
)}
```
(`Select` aus `@shopify/polaris` zu den bestehenden Imports in Zeile 16-33 hinzufügen.)

### 7.2 Sichtbarkeitsbedingung („nur bei theme-relevanten Inhalten")
Das maßgebliche Flag ist **`isThemeContentType(config.contentType)`** aus
`app/utils/content-type-groups.ts`. `UnifiedContentEditor.tsx` importiert es bereits (Zeile 8) und
kennt `config.contentType`.

Umsetzung: `UnifiedItemList` erhält neue optionale Props; `UnifiedContentEditor` befüllt sie nur für
Theme-ContentTypes:
```tsx
// UnifiedContentEditor.tsx, im <UnifiedItemList …>-Aufruf (ab Zeile 513):
showThemeSelector={isThemeContentType(config.contentType)}
themeOptions={isThemeContentType(config.contentType) ? themeOptions : undefined}
selectedThemeId={selectedThemeId}
onThemeChange={handleThemeChange}
```
`themeOptions`, `selectedThemeId` kommen aus dem Loader (§6.3). Bei Nicht-Theme-ContentTypes ist
`showThemeSelector=false` → Dropdown wird nie gerendert (Guard zusätzlich im JSX, §7.1).

Zusätzlicher Guard `themeOptions.length > 1`: Wenn nur ein Theme installiert ist, gibt es nichts zu
wählen → Dropdown ausblenden (kein UI-Rauschen). Optional per Config anzeigen mit disabled.

### 7.3 Verhalten beim Theme-Wechsel
`handleThemeChange(themeId)` in `UnifiedContentEditor` (oder im zugehörigen Hook):
1. `POST /api/select-theme` (persistiert `AISettings.selectedThemeId`, §6.2).
2. Nach Erfolg: `revalidator.revalidate()` → Loader lädt Item-Liste + Content für das neue Theme neu
   (der Loader scopet jetzt nach `selectedThemeId`, §4.3).
3. `state.selectedItemId` zurücksetzen/prüfen: die alte Auswahl-ID kann in einem anderen Theme
   fehlen → auf ersten Eintrag / null fallen (analog zur bestehenden Auto-Jump-Logik in
   `UnifiedItemList.tsx:284`).
4. Während des Ladens Dropdown `disabled` (an `isSyncing`/`revalidator.state === "loading"` koppeln,
   vgl. Zeile 526).

**Optionaler Hinweis:** Enthält das gewählte Theme noch keine gesynchten Daten (frisch gewechselt,
noch nie gesynct), Banner/Empty-State „Für dieses Theme wurde noch nicht synchronisiert — jetzt
alle Einträge laden“ mit Verknüpfung auf `onSyncAll` (bestehender Reload-Button, `UnifiedItemList`
Zeile 671).

### 7.4 Mobile
`UnifiedItemListMobile.tsx` analog erweitern (gleiche Props, gleicher `Select` unter der Suche),
damit Desktop/Mobile paritätisch sind.

---

## 8. i18n

Neue Strings in `app/i18n/de.ts`, `app/i18n/en.ts`, `app/i18n/es.ts` (unter dem `content`-Namespace,
konsistent mit den bestehenden `UnifiedItemList`-t-Props in `UnifiedContentEditor.tsx:528-542`):

| Key | de | en | es |
|-----|----|----|----|
| `content.themeSelectorLabel` | „Theme“ | „Theme“ | „Tema“ |
| `content.themeSelectorHelp` | „Wählt das Theme, dessen Inhalte du bearbeitest/übersetzt.“ | „Selects the theme whose content you edit/translate.“ | „Selecciona el tema cuyo contenido editas/traduces.“ |
| `content.themeSelectorPublished` | „(publiziert)“ | „(published)“ | „(publicado)“ |
| `content.themeSwitchNeedsSync` | „Für dieses Theme wurde noch nicht synchronisiert.“ | „This theme hasn't been synced yet.“ | „Este tema aún no se ha sincronizado.“ |

Rolle-Label: MAIN-Theme im Dropdown als `"<name> (publiziert)"` darstellen (Label-Bau im
Loader/Component).

---

## 9. Edge Cases & Risiken

1. **Gewähltes Theme gelöscht/deinstalliert:** `resolveSelectedThemeId` (§5.1) validiert gegen
   `GET_THEMES` und fällt auf MAIN zurück. UI: Dropdown zeigt MAIN als aktiv; verwaiste
   `ThemeContent`-Zeilen des alten Themes bleiben liegen → optionaler Cleanup (Zeilen mit `themeId`,
   das in keinem `GET_THEMES`-Ergebnis mehr vorkommt, beim Full-Sync löschen).
2. **Unpubliziertes / Development-Theme gewählt:** `themeFilesUpsert` und `translationsRegister`
   gegen Nicht-MAIN müssen in Phase 0 verifiziert werden (Fakt E-Risk). Falls Shopify das ablehnt:
   Dropdown auf `role === "MAIN"` beschränken oder Nicht-MAIN read-only markieren.
3. **Sync-Kosten bei mehreren Themes:** `translatableResources` liefert alle Themes gemischt; mehr
   Themes = mehr Zeilen/DB. Mitigierung: optionaler „nur aktives Theme persistieren“-Modus (§4.2) und
   Beibehaltung der 250er-Paginierung.
4. **Interaktion mit `ENABLE_THEME_PRIMARY_EDIT`:** Orthogonal. Die Theme-Auswahl ändert NUR das
   Ziel-Theme; das Primary-Edit-Gate (`templates-update.action.ts:401`) bleibt unverändert. Bei
   `false` bleibt Primary read-only für ALLE Themes (nur Übersetzung), Foreign-Pfad respektiert
   trotzdem `selectedThemeId`.
5. **Bestehende DB-Zeilen ohne `themeId` (`""`):** Kompatibilitäts-`OR`-Filter (§4.3) zeigt sie unter
   jedem Theme, bis der Backfill sie zuordnet. Nach garantiertem Backfill den `OR`-Zweig entfernen.
6. **resourceType ohne eingebettetes `theme_id` (Fakt C-Unsicherheit):** Falls ein Typ generell kein
   theme_id trägt, ist er nicht sauber theme-scopebar → Fallback „aktives Theme“ + dokumentierte
   Einschränkung. Phase 0 klärt das.
7. **Divergenz-Regression-Guard:** Assertion in §5.2 verhindert, dass Foreign-Writes je wieder in ein
   anderes Theme als das gewählte gehen.
8. **Unique-Key-Kollision während Migration:** Der Wechsel des Unique-Keys muss atomar mit dem
   Backfill koordiniert sein (alte Constraint erst nach neuer droppen ist nicht möglich für
   überlappende Keys) — Reihenfolge: Spalte + `""`-Default → alte Unique droppen → neue Unique anlegen
   → Backfill. Da vor Backfill alle `themeId=""`, bleiben die alten (shop,resourceId,groupId)-Tupel
   eindeutig auch mit `themeId` im Key.

---

## 10. Schrittweiser Umsetzungsplan (klein geschnitten)

**Phase 0 — API-Verifikation (kein Code):**
- 0.1 Gegen Dev-Shop die `resourceId`-Formate aller sechs Theme-resourceTypes prüfen (Fakt C).
- 0.2 Testen: `themeFilesUpsert` + `translationsRegister` gegen ein zweites, unpubliziertes Theme
  (Fakt E-Risk). Ergebnis entscheidet, ob Dropdown auf MAIN beschränkt wird.

**Phase 1 — Datenmodell:**
- 1.1 `schema.prisma`: `themeId` + Unique/Index auf `ThemeContent` & `ThemeTranslation` (§3.1).
- 1.2 `AISettings.selectedThemeId` (§6.1).
- 1.3 Idempotente SQL-Migration (§3.2) + `scripts/backfill-theme-id.js`.
- 1.4 Helper `app/utils/theme-id.ts` → `extractThemeIdFromResourceId` (+ Unit-Test).

**Phase 2 — Sync/Read theme-bewusst:**
- 2.1 `content.service.ts:getThemes()`: pro Zeile `themeId` via Helper setzen (§4.1).
- 2.2 `theme-content-domain.server.ts`: dito für System/Delivery/SellingPlans/OnlineStoreExtras.
- 2.3 Alle Lese-Queries auf `ThemeContent`/`ThemeTranslation` um `themeId`-Scoping + `""`-Kompat-`OR`
  erweitern (§4.3).

**Phase 3 — Theme-Selection-Service + Persistenz:**
- 3.1 `app/services/theme-selection.server.ts`: `resolveSelectedThemeId(shop, admin)` +
  `listThemes(admin)` (kapselt `GET_THEMES`).
- 3.2 Action-Endpoint `POST /api/select-theme` (§6.2).

**Phase 4 — Write-Pfad-Fix:**
- 4.1 `templates-update.action.ts:485-505`: MAIN-Lookup → `resolveSelectedThemeId` (§5.1).
- 4.2 Foreign-Pfad-Assertion (§5.2), DB-Mirror mit `themeId` (§5.3).

**Phase 5 — Loader:**
- 5.1 Theme-Route-Loader: `themes`, `selectedThemeId` (+ Label mit Rolle) liefern (§6.3).

**Phase 6 — UI:**
- 6.1 `UnifiedItemList.tsx`: Props `showThemeSelector/themeOptions/selectedThemeId/onThemeChange` +
  `Select`-Block nach der Search (§7.1), `Select` importieren.
- 6.2 `UnifiedContentEditor.tsx`: Props befüllen via `isThemeContentType` (§7.2),
  `handleThemeChange` (§7.3).
- 6.3 `UnifiedItemListMobile.tsx`: Parität (§7.4).
- 6.4 i18n-Strings (§8).

**Phase 7 — Edge-Cases + Cleanup:**
- 7.1 Verwaiste-Theme-Cleanup beim Full-Sync (§9.1).
- 7.2 Empty-State „noch nicht gesynct“ (§7.3).
- 7.3 Nach garantiertem Backfill: `""`-Kompat-`OR` entfernen (Follow-up-Ticket).

---

## 11. Test- / Verifikationsplan

**Manuell (Dev-Shop mit ≥2 Themes, davon ≥1 unpubliziert):**
1. Dropdown erscheint NUR auf Theme-Tabs (Templates/System/Delivery/SellingPlans/OnlineStoreExtras),
   NICHT auf Produkte/Collections/Pages/Blogs/Articles/Policies.
2. Dropdown erscheint unter der Suche, listet alle Themes, MAIN mit „(publiziert)“.
3. Theme wechseln → Item-Liste + Editor laden Inhalte des neuen Themes; Auswahl-ID fällt sauber
   zurück.
4. Primary-Edit (bei `ENABLE_THEME_PRIMARY_EDIT=true`) landet im GEWÄHLTEN Theme
   (`themeFilesUpsert` gegen dessen ID) — im Shopify-Admin-Theme-Editor verifizieren.
5. Übersetzung (Foreign) landet im gewählten Theme (Assertion greift, kein Cross-Theme-Write).
6. Theme deinstallieren während es gewählt ist → App fällt auf MAIN zurück, kein Crash.
7. Nur ein Theme installiert → Dropdown ausgeblendet (bzw. disabled), Verhalten wie bisher.

**Automatisiert:**
- Unit: `extractThemeIdFromResourceId` für alle sechs resourceType-GID-Formen + Kein-theme_id-Fall.
- Unit: `resolveSelectedThemeId` (null → MAIN, ungültig → MAIN, valid → durchgereicht).
- Migration/Backfill: gegen DB-Snapshot; prüfen dass alte Zeilen MAIN bzw. extrahiertes theme_id
  bekommen und keine Unique-Kollision auftritt.

**Regressions-Check:**
- Nicht-Theme-ContentTypes: Diff der Loader-Ausgabe/Editor-Verhalten = 0 (Theme-Props undefined).
- Bestehender Full-Sync (`syncAllX`) läuft weiter; DB enthält jetzt `themeId`-Werte.

---

## Anhang — Referenz-Fundstellen (Codebasis)

| Zweck | Datei:Zeile |
|-------|-------------|
| Harter MAIN-Lookup (Write) | `app/actions/templates/templates-update.action.ts:485-505` |
| Foreign-Übersetzung (translationsRegister) | `app/actions/templates/templates-update.action.ts:~240` |
| Primary-Edit-Gate | `app/actions/templates/templates-update.action.ts:401`; `app/config/constants.ts:206` |
| `GET_THEMES` (Theme-Liste) | `app/graphql/content.queries.ts:235-250` |
| `GET_THEME_FILES` (theme-scoped read) | `app/graphql/content.queries.ts:252-267` |
| `themeFilesUpsert` | `app/graphql/content.mutations.ts:148` |
| Theme-agnostischer Read/Sync | `app/services/content.service.ts:697 getThemes()` |
| `GET_THEMES` importiert, ungenutzt | `app/services/content.service.ts:11` |
| ThemeContent / ThemeTranslation Models | `prisma/schema.prisma:681-731` |
| AISettings Model | `prisma/schema.prisma:31-53` |
| Item-Liste + Searchbar (UI-Einfügepunkt) | `app/components/unified/UnifiedItemList.tsx:576-717` |
| Sichtbarkeits-Flag | `app/utils/content-type-groups.ts:28 isThemeContentType` |
| UnifiedItemList-Aufruf (Props befüllen) | `app/components/UnifiedContentEditor.tsx:513-543` |
| Mobile-Variante | `app/components/unified/UnifiedItemListMobile.tsx` |
