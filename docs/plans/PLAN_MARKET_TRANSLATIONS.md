# Implementierungsplan: Markt-spezifische Übersetzungen

> Feature analog zu Shopifys **"Translate & Adapt"**: dieselbe Sprache pro Markt
> unterschiedlich übersetzen (z. B. Englisch für UK vs. Englisch für USA).
> Shopify unterstützt das nativ über das optionale Feld `marketId` in
> `TranslationInput` und `marketIds` in `translationsRemove`.

Status: **PLAN / noch nicht umgesetzt**
Sprache des Plans: Deutsch · Ziel-Leser: Entwickler, der es direkt umsetzt.

---

## 1. Zieldefinition & Scope

### Kern-Idee
Übersetzungen bekommen eine zusätzliche Dimension **Markt**. Eine Übersetzung
ohne `marketId` gilt **global** für die Locale (heutiges Verhalten). Eine
Übersetzung **mit** `marketId` gilt nur für Käufer in diesem Markt und
**überschreibt** die globale Übersetzung derselben Locale. Fehlt für einen Markt
eine markt-spezifische Übersetzung, gilt automatisch die globale (Shopify-eigenes
Fallback-Verhalten — wir bilden es 1:1 im `resolve()` nach).

### In Scope (Phase 1)
Content-Typen, die bereits über `handleUnifiedContentActions` /
`shopify-content.service.ts` `updateContent()` laufen und deren Übersetzungen in
`ContentTranslation` liegen:

- **Products**
- **Collections**
- **Pages**
- **Articles** (Blogs)
- **Policies**

Diese teilen sich denselben Save-/Remove-/Load-Pfad und dieselbe DB-Tabelle
(`ContentTranslation`) — daher der geringste Integrationsaufwand und das
sauberste Pilot-Set.

### Phase 2 (später, eigener Plan)
- **Theme** (`ThemeTranslation`, eigener Upsert-/Domain-Pfad,
  `templates-*.action.ts`, `theme-content-api.server.ts`)
- **Metaobjects** (`MetaobjectTranslation`, `api.metaobjects.$.tsx`,
  `content-update.action.ts`)
- **Product Image Alt-Text** (`ProductImageAltTranslation`)
- **DirectTranslation** (flat-domain Sub-Ressourcen)

Begründung der Zweiteilung: Theme/Metaobjects haben abweichende Digest-/Upsert-
Mechaniken und eigene DB-Tabellen mit anderen Unique-Keys. Die Markt-Dimension
ist dort identisch modelliert (siehe Migrationsabschnitt), aber die Save-Pfade
sind separat und sollen nicht im selben Schritt angefasst werden.

### Nicht in Scope
- Anlegen/Verwalten von Märkten (das macht der Merchant im Shopify-Admin).
- Markt-spezifische Preise/Währungen/Domains — reine Storefront-Themen.

---

## 2. Shopify-API-Recherche (verifiziert)

Alle Angaben gegen die aktuelle Admin-GraphQL-Doku geprüft (Juli 2026).

### 2.1 `TranslationInput` — Feld `marketId` (VERIFIZIERT)
Vollständige Feldliste des Input-Objekts
(`admin-graphql/latest/input-objects/translationinput`):

| Feld | Typ | Bedeutung |
|------|-----|-----------|
| `key` | `String!` | Referenz auf den zu übersetzenden Wert der Ressource |
| `locale` | `String!` | ISO-Code der Ziel-Locale (nur `shopLocales`-Locales gültig) |
| `value` | `String!` | Übersetzter Wert |
| `translatableContentDigest` | `String!` | Hash-Digest des Quell-Inhalts |
| `marketId` | `ID` (**optional**) | *"The ID of the market that the translation is specific to. Not specifying this field means that the translation will be available in all markets."* |

→ Kein Feld-Renaming nötig, `marketId` wird einfach zusätzlich mitgesendet.
Format: `gid://shopify/Market/<id>`.

Beispiel `translationsRegister` mit Markt-Scope (aus Doku):
```graphql
mutation {
  translationsRegister(
    resourceId: "gid://shopify/Product/123"
    translations: [{
      locale: "fr"
      key: "title"
      value: "Titre pour le marché FR"
      translatableContentDigest: "..."
      marketId: "gid://shopify/Market/128989799"
    }]
  ) {
    userErrors { field message }
    translations { locale key value }
  }
}
```
**Wichtig:** Die Response von `translationsRegister` liefert **nur** `locale`,
`key`, `value` — **kein** `marketId` zurück (verifiziert in
`app/graphql/content.mutations.ts:10-14`). D. h. die Response allein kann eine
markt-spezifische nicht von einer globalen Übersetzung unterscheiden. Wir müssen
den beim Aufruf verwendeten `marketId` clientseitig/serverseitig selbst
mitführen. *(Zu prüfen bei Umsetzung: ob `translationsRegisterPayload.translations`
inzwischen `market { id }` liefert — falls ja, in den Query-String aufnehmen und
zur Verifikation nutzen.)*

### 2.2 `translationsRemove` — Argument `marketIds` (VERIFIZIERT)
Argumente der Mutation (`admin-graphql/latest/mutations/translationsRemove`):

| Argument | Typ | Pflicht |
|----------|-----|---------|
| `resourceId` | `ID!` | ja |
| `translationKeys` | `[String!]!` | ja |
| `locales` | `[String!]!` | ja |
| `marketIds` | `[ID!]` | **nein (optional)** |

→ Aktuelle Mutation in `content.mutations.ts:19-32` sendet nur
`resourceId, translationKeys, locales`. Erweiterung: optionales `$marketIds`.
Wird `marketIds` weggelassen, entfernt Shopify die **globale** Übersetzung; wird
es gesetzt, nur die markt-spezifische.

### 2.3 Enumeration der Märkte + Web-Presence-Locales (VERIFIZIERT)
- Query `markets(first: Int!)` liefert paginierte `Market`-Objekte.
- `Market` hat `id`, `name`, `handle`, `enabled`, `primary` (o. ä. Status-Felder)
  und eine `webPresence`-Relation (`MarketWebPresence`).
- `MarketWebPresence` liefert:
  - `defaultLocale` → `ShopLocale` (Locale, die auf der Domain-Root gilt)
  - `alternateLocales` → `[ShopLocale]` (zusätzliche Sprach-Subfolder)
  - `rootUrls` → `[MarketWebPresenceRootUrl]`

→ Für ContentPilot relevant: die **Menge der Locales, die ein Markt anbietet**
(= `defaultLocale` + `alternateLocales`). Nur für diese Locale/Markt-Kombination
ergibt eine markt-spezifische Übersetzung Sinn.

Vorschlag für die neue Query (in `app/graphql/content.queries.ts`,
Name `GET_MARKETS`):
```graphql
query getMarkets($first: Int!) {
  markets(first: $first) {
    edges {
      node {
        id
        name
        handle
        enabled
        primary
        webPresence {
          defaultLocale { locale }
          alternateLocales { locale }
        }
      }
    }
  }
}
```
> **Zu verifizieren bei Umsetzung** gegen das im Projekt gepinnte
> API-Version-Target (`shopify.app.toml`): exakte Feldnamen `enabled`/`primary`
> am `Market`-Objekt und ob `webPresence` (Singular) oder `webPresences`
> (neuere API-Versionen haben teils `webPresences` als Connection). Query im
> GraphiQL-Explorer der Ziel-Version gegenprüfen, bevor sie fest verdrahtet wird.
> Falls `webPresences` (Plural, Connection): entsprechend `edges { node { ... } }`.

Quellen:
- https://shopify.dev/docs/api/admin-graphql/latest/input-objects/translationinput
- https://shopify.dev/docs/api/admin-graphql/latest/mutations/translationsRemove
- https://shopify.dev/docs/api/admin-graphql/latest/mutations/translationsregister
- https://shopify.dev/docs/api/admin-graphql/latest/queries/markets
- https://shopify.dev/docs/api/admin-graphql/latest/objects/MarketWebPresence
- https://shopify.dev/docs/apps/build/markets/manage-translated-content

---

## 3. Datenmodell-Migration

### 3.1 Prinzip
Neue **nullable** Spalte `marketId String?` auf jeder Übersetzungstabelle.
`NULL` = globale Übersetzung (= heutiges Verhalten). Bestandsdaten bleiben
unverändert und sind damit automatisch alle „global".

Der Unique-Key muss um `marketId` erweitert werden. **Problem:** In
SQL/Prisma behandeln viele Engines `NULL` in Unique-Constraints als „nicht
gleich" (mehrere NULL-Zeilen erlaubt), was hier **falsch** wäre — wir brauchen
genau eine globale Zeile pro (shop, resourceId, key, locale). Lösung: **Sentinel-
Wert statt NULL** im Unique-Key.

Empfehlung: Spalte `marketId String @default("")` (nicht nullable), leerer String
`""` = global. Damit funktioniert der zusammengesetzte Unique-Key mit jeder
DB-Engine deterministisch, und `@default("")` migriert alle Bestandszeilen
automatisch auf „global". (Die Alternative — nullable + partieller Unique-Index —
ist Prisma-seitig nicht portabel abbildbar.)

### 3.2 Schema-Änderungen (`prisma/schema.prisma`)

**`ContentTranslation`** (`:641`, Phase 1):
```prisma
  marketId String @default("")   // "" = global (alle Märkte); sonst gid://shopify/Market/<id>
  ...
  @@unique([shop, resourceId, key, locale, marketId])   // war: [shop, resourceId, key, locale]
  @@index([shop, resourceId, locale, marketId])
```

**Schwester-Tabellen (Phase 2, gleiches Muster — im Migrations-Schritt
mit-migrieren, damit das Modell konsistent ist, auch wenn der Save-Pfad erst
später folgt):**
- `ThemeTranslation` (`:710`): `@@unique([shop, resourceId, groupId, key, locale, marketId])`
- `MetaobjectTranslation` (`:771`): `@@unique([shop, metaobjectId, key, locale, marketId])`
- `ProductImageAltTranslation` (`:420`): `@@unique([imageId, locale, marketId])`
- `DirectTranslation` (`:184`): `@@unique([itemId, locale, marketId])`

### 3.3 Migrations-Strategie
1. `prisma migrate dev --name add_market_id_to_translations` erzeugt die
   Migration. Alle Spalten mit `DEFAULT ''` → Bestandszeilen werden implizit
   auf `""` (global) gesetzt. Kein Daten-Backfill-Skript nötig.
2. Der Drop/Recreate des Unique-Index passiert automatisch. Bei großen Tabellen
   in Produktion: Migration in einem Wartungsfenster, da der Unique-Index neu
   aufgebaut wird.
3. **GDPR-Guard beachten:** `app/services/gdpr.service.ts` `redactShopData()`
   löscht per `shop`. Neue Spalte ändert daran nichts (Löschung bleibt
   shop-scoped). Der Schema-Drift-Guard-Test (erwähnt im Kommentar bei
   `ContentTranslation:648`) muss weiterhin grün sein — kein neues Modell,
   also keine Anpassung nötig.

---

## 4. Backend / Service-Änderungen

### 4.1 Markets laden
- Neue Query `GET_MARKETS` in `app/graphql/content.queries.ts` (siehe 2.3).
- Neue Methode `loadMarkets()` in
  `src/services/shopify-content.service.ts` (direkt neben `loadShopLocales()`
  ~`:565`). Rückgabe:
  ```ts
  interface MarketInfo {
    id: string;          // gid://shopify/Market/<id>
    name: string;
    handle: string;
    primary: boolean;
    localeCodes: string[]; // defaultLocale + alternateLocales
  }
  // return { markets: MarketInfo[] }
  ```
- In den **Loadern** der In-Scope-Routen (`app.products.tsx`,
  `app.collections.tsx`, `app.pages.tsx`, `app.blogs.tsx`/articles,
  `app.policies.tsx`) `loadMarkets()` parallel zu `loadShopLocales()` aufrufen
  und `markets` mit an die Editor-Komponente durchreichen (analog `shopLocales`).
- **Caching/Robustheit:** Wenn der Shop **keine** zusätzlichen Märkte hat (nur
  der Primärmarkt) oder das `markets`-Scope fehlt → `markets = []`. Die UI blendet
  dann das Dropdown aus (nur „Alle Märkte" wäre wählbar → kein Mehrwert).
- **Scope:** `read_markets` (bzw. das aktuell benötigte Markets-Scope) in
  `shopify.app.toml` ergänzen und prüfen, ob eine erneute App-Autorisierung
  nötig wird. *(Zu verifizieren: exakter Scope-Name der Ziel-API-Version.)*

### 4.2 `marketId` durch die Save-Pfade durchreichen

Zentrale Stelle: `shopify-content.service.ts`.

- **`saveTranslations()` (`:76`)** und **`updateContent()` (`:596`)**:
  Signatur um optionales `marketId?: string` erweitern (leer/undefined = global).
  - Beim Bau der `translationsInput`-Objekte (`:81-85`, `:614`) `marketId` nur
    dann setzen, wenn nicht-leer:
    ```ts
    const input: TranslationInput = { key, value, locale, translatableContentDigest: digest };
    if (marketId) input.marketId = marketId;
    ```
  - **Digest bleibt marktunabhängig:** Der Digest gehört zum *Quell-Inhalt* der
    Locale, nicht zum Markt. `loadTranslatableContent()` (`:60`) muss **nicht**
    pro Markt neu laden. (Siehe Edge Cases.)
- **DB-Save:** Beim `upsert`/`create` in `ContentTranslation` die `marketId`
  (`""` wenn global) in `where`/`create` aufnehmen. Der neue Unique-Key
  `[shop, resourceId, key, locale, marketId]` wird zum `upsert`-Selektor.
- **Remove-Pfad:** In `updateContent()` (der Zweig, der bei geleerten
  Feldern/geänderten Primärfeldern `translationsRemove` aufruft) und in
  `REMOVE_TRANSLATIONS` (`content.mutations.ts:19`) `$marketIds: [ID!]`
  hinzufügen und an die Mutation reichen. Regel:
  - markt-spezifisch geleert → `marketIds: [selectedMarketId]`
  - global geleert → `marketIds` weglassen (entfernt global).
- **Alle weiteren Call-Sites** (aus den Codebasis-Fakten) analog erweitern,
  aber Phase-1-Scope beachten:
  - Phase 1: `content-update.action.ts`,
    `app/routes/api-ai-handlers/text-translation.handler.ts` (AI-Translate-Pfad),
    `app/actions/product/update.actions.ts`, `unified-content.actions.ts`.
  - Phase 2: `app/actions/templates/*.action.ts`,
    `app/services/theme-content-api.server.ts`.
  - Überall dort, wo `{ key, value, locale, translatableContentDigest }` gebaut
    wird, `marketId` optional durchschleifen. **Default-Verhalten ohne
    Parameter = global** → bestehende Aufrufe bleiben unverändert korrekt.

### 4.3 Load-Pfad (Übersetzungen lesen)
Beim Laden der Übersetzungen aus der DB (Loader der In-Scope-Routen) nun **beide
Ebenen** liefern:
- die globalen Zeilen (`marketId = ""`) wie bisher, plus
- die markt-spezifischen Zeilen (`marketId != ""`).

Datenform an den Client: pro Übersetzung zusätzlich `marketId` mitgeben. Zwei
Optionen:
- **(A, empfohlen)** Die an den Client gelieferten `item.translations` bleiben
  wie bisher (nur globale), und markt-spezifische kommen als **separate Struktur**
  `marketTranslations: Record<marketId, Record<translationKey, Record<locale, value>>>`.
  Grund: Die bestehende `resolve()`-Kette (`useUiDataLoader.ts`) und
  `getTranslatedValue()` bleiben für den Global-Fall unverändert; die
  Markt-Ebene wird als zusätzliche, vorgelagerte Priorität eingezogen.
- (B) `item.translations` um `marketId` erweitern — invasiver, berührt
  `getTranslatedValue()` und viele Typen. Nicht empfohlen für Phase 1.

### 4.4 `resolve()`-Fallback-Logik (Nachbau des Shopify-Verhaltens)
Neue Priorität für **Foreign Locale** in
`useUiDataLoader.ts` `resolve()` (`:299-346`), wenn ein Markt ≠ „global" gewählt
ist. Die Reihenfolge, wenn `selectedMarketId` gesetzt ist:

1. `deletedTranslationKeysRef` (markt-bewusst, siehe 5) → leer
2. `localTranslationsRef` **[markt-spezifisch]** (Overlay für gewählten Markt)
3. markt-spezifische DB-/Item-Übersetzung (`marketTranslations[marketId]...`)
4. **Fallback auf globale Ebene** (heutige Kette: `localOverride` global →
   `itemTranslation` global) ← das ist das native Shopify-Fallback
5. Feld-Fallbacks (handle→primary, seoTitle→title)
6. leer

Ist „Alle Märkte / Global" gewählt (`selectedMarketId === ""`), bleibt `resolve()`
**exakt wie heute** (kein Regressionsrisiko).

> Das UI kann bei Fallback-Anzeige (Wert kommt aus der globalen Ebene, weil keine
> markt-spezifische existiert) optional einen Hinweis-Badge „vom globalen Wert
> geerbt" zeigen (analog `isFallback`). Neuer `ValueSource`-Wert:
> `"marketOverride"` bzw. `"globalFallback"`.

---

## 5. State / Hook-Änderungen

### 5.1 Neuer Zustand: gewählter Markt
- In `useUnifiedContentEditor.ts` neuer State
  `selectedMarketId: string` (Default `""` = global) + Setter
  `handleMarketChange(marketId: string)`.
- Wechsel des Markts verhält sich wie ein „Locale-Wechsel light": es ist **kein**
  neuer Server-Load nötig (Daten sind schon geladen), aber `resolveAll()` muss
  neu laufen, damit `editableValues` und die Baseline für den neuen Markt-Kontext
  gesetzt werden. Konkret: bei `handleMarketChange` dieselbe Re-Resolve-Logik
  triggern wie bei `handleLanguageChange` (siehe useUiDataLoader-Anbindung im
  Data-Loading-Effect). `isLoadingData` kurz true setzen, um Change-Detection
  sauber zurückzusetzen.
- **Ungespeicherte Änderungen:** Markt-Wechsel bei `hasChanges === true` → gleiche
  Guard wie beim Locale-Wechsel (Shopify SaveBar / Discard-Confirm), sonst gehen
  Eingaben verloren.

### 5.2 Ref-Overlays um Markt-Dimension erweitern
Die Overlays in `useUiDataLoader.ts` müssen markt-bewusst werden. Minimal-
invasiver Ansatz: **marketId in den Overlay-Key kodieren**, statt eine weitere
Verschachtelungsebene für alle Refs einzuführen.

- `localTranslationsRef`: aktuell `Record<translationKey, Record<locale, value>>`.
  → Locale-Schlüssel um Markt erweitern über einen Composite-Key
  `localeKey = marketId ? \`${locale}@@${marketId}\` : locale`.
  Alle Lese-/Schreibstellen (`resolve()` `:307`, `onTranslateFieldComplete`
  `:455`, `onTranslateAllComplete` `:516`, `onTranslateAllForLocaleComplete`
  `:588`, `onSaveComplete` `:680/:690`, `onTranslateFieldToAllLocalesComplete`
  `:742`) über eine kleine Helper-Funktion `buildLocaleKey(locale, marketId)`
  leiten. **Vorteil:** Signaturen/Strukturen der Refs bleiben stabil, nur der
  Schlüssel ändert sich; der Global-Fall (`marketId=""`) erzeugt exakt den
  heutigen Key `locale`.
- `deletedTranslationKeysRef` (Set<string>): Einträge ebenfalls als
  `\`${translationKey}@@${marketId}\`` kodieren, damit ein markt-spezifisches
  Clear nicht die globale Übersetzung ausblendet. `resolve()` prüft `has()` mit
  dem markt-bewussten Key.
- `resolve()`/`resolveAll()` bekommen `selectedMarketId` als zusätzliches
  Argument (oder lesen es aus einem Ref, der bei `handleMarketChange` gesetzt
  wird — Ref bevorzugt, um die `useCallback`-Deps klein zu halten).
- `savedPrimaryValuesRef` bleibt **markt-unabhängig**: Primär-Locale-Inhalt ist
  per Definition global (Shopify erlaubt keine markt-spezifische Primär-Locale).
  Das Dropdown ist in der Primär-Locale daher deaktiviert/„global" fixiert
  (siehe UI).

### 5.3 Durchreichen an Save/Translate
- `handleSave`, `handleTranslateAllForLocale`, `handleClearField`,
  `translateField`, `translateFieldToAllLocales` in
  `useUnifiedContentEditor.ts` / `useFieldHandlers` bekommen `selectedMarketId`
  in die Payload an die Action (`unified-content.actions.ts`).
- Die Action reicht `marketId` an `updateContent()`/`saveTranslations()` weiter
  (4.2).
- **Translate-All (Primär → alle Locales):** In Phase 1 übersetzt „Translate All"
  weiterhin **global**. Markt-spezifisches Bulk-Translate ist Phase 2 (Edge
  Cases). Grund: Vermeidet einen Kombinatorik-Sprung (Locales × Märkte) im ersten
  Wurf.

---

## 6. UI — exakte Platzierung des Markt-Dropdowns

### Anforderung (wörtlich umgesetzt)
> Rechts von den Locale-Buttons, **rechtsbündig** (am rechten Rand der Zeile, mit
> Abstand zu den Locale-Buttons — NICHT direkt bündig anschließend). Ein
> **Dropdown**. Default-Option **„Alle Märkte / Global"**. Desktop + Mobile.

### 6.1 Komponente & Verwendung
Neue Komponente `app/components/unified/MarketSelector.tsx`:
```tsx
import { Select } from "@shopify/polaris";
// Props: markets: MarketInfo[], selectedMarketId: string,
//        currentLanguage: string, primaryLocale: string,
//        onMarketChange: (id: string) => void, label global-Option
// Render: <Select> mit Optionen:
//   [{ label: t.allMarketsGlobal, value: "" }, ...markets
//       .filter(m => m.localeCodes.includes(currentLanguage)) // nur Märkte, die diese Locale anbieten
//       .map(m => ({ label: m.name, value: m.id }))]
// Deaktiviert (disabled), wenn currentLanguage === primaryLocale ODER markets leer.
```
- **Filter auf `currentLanguage`:** Nur Märkte anzeigen, deren
  `localeCodes` die aktuell gewählte Locale enthält. Für eine Locale, die kein
  Markt separat anbietet, gibt es nur „Alle Märkte / Global".
- Bei Locale-Wechsel muss `selectedMarketId` auf `""` zurückgesetzt werden, falls
  der bisher gewählte Markt die neue Locale nicht anbietet (Guard in
  `handleLanguageChange`).

### 6.2 Desktop — `UnifiedLanguageBar.tsx`
Die Locale-Buttons rendern in `UnifiedLanguageBar` (`:118-148`) in einem Flex-
Container. Aktuell sitzt rechts über `marginLeft:"auto"` bereits ein
`HelpTooltip` (`:144-146`). Das Dropdown wird **in denselben Flex-Container, in
den rechtsbündigen Block** eingefügt:

- Datei: `app/components/unified/UnifiedLanguageBar.tsx`
- Stelle: Der `<div style={{ marginLeft: "auto" }}>`-Block bei **Zeile 144–146**.
  Diesen zu einer rechtsbündigen `InlineStack`/Flex-Gruppe erweitern, die
  `MarketSelector` **links vom** `HelpTooltip` enthält:
  ```tsx
  <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "0.5rem" }}>
    <MarketSelector
      markets={markets}
      selectedMarketId={selectedMarketId}
      currentLanguage={currentLanguage}
      primaryLocale={primaryLocale}
      onMarketChange={onMarketChange}
      t={{ allMarketsGlobal: t.allMarketsGlobal }}
    />
    <HelpTooltip helpKey="marketSelector" position="below" />
    <HelpTooltip helpKey="ctrlClickLanguage" position="below" />
  </div>
  ```
  `marginLeft:"auto"` schiebt die Gruppe an den rechten Rand → rechtsbündig, mit
  natürlichem Abstand (`flexWrap` + `flex:1` des Containers) zu den Locale-Buttons.
- Neue Props an `UnifiedLanguageBarProps` (`:24-78`): `markets: MarketInfo[]`,
  `selectedMarketId: string`, `onMarketChange: (id: string) => void`, plus
  i18n-String `allMarketsGlobal` im `t`-Objekt.
- Durchreichen von der Aufrufstelle in
  `UnifiedContentEditor.tsx` **`:617-639`** (`<UnifiedLanguageBar ...>`):
  `markets`, `selectedMarketId={state.selectedMarketId}`,
  `onMarketChange={handlers.handleMarketChange}` ergänzen.

> Hinweis: `LocaleNavigationButtons.tsx` ist eine ältere/parallele Variante der
> Sprachleiste (nutzt `justify-content: space-between`, Reload rechts). Sie wird
> vom aktiven Editor **nicht** über `UnifiedContentEditor` gerendert (dort ist es
> `UnifiedLanguageBar`). Für Konsistenz optional dasselbe Dropdown auch dort
> einbauen (rechtsbündiger Block bei `:112-119`, links neben dem Reload-Button),
> aber **nicht Phase-1-kritisch**. Vor Einbau prüfen, ob die Komponente noch
> irgendwo aktiv gemountet wird (`grep LocaleNavigationButtons`).

### 6.3 Mobile — `MobileToolbar.tsx`
Locale-Buttons scrollen horizontal (`:114-157`), rechts sitzt eine Aktionsgruppe
(Reload + Popover + Help, `:159-214`).

- Datei: `app/components/unified/MobileToolbar.tsx`
- Platznot auf Mobile → **kein voller `Select` in der Zeile**. Zwei Optionen:
  - **(A, empfohlen)** Das `MarketSelector`-`Select` als eigene, schmale Zeile
    **unter** der Toolbar-Flexzeile rendern (innerhalb der `<Card>` `:112`,
    nach dem schließenden `</div>` der Flexzeile bei `:215`), volle Breite,
    nur sichtbar wenn `markets.length > 0 && currentLanguage !== primaryLocale`.
  - (B) Als zusätzlicher Eintrag im „More actions"-Popover (`ActionList` `:176`)
    — weniger sichtbar/entdeckbar, nur wenn (A) zu viel vertikalen Platz kostet.
- Neue Props an `MobileToolbarProps` (`:23-65`): `markets`, `selectedMarketId`,
  `onMarketChange`, `allMarketsGlobal`-String im `t`.
- Durchreichen an der Aufrufstelle `UnifiedContentEditor.tsx` **`:578-610`**
  (`<MobileToolbar ...>`).

### 6.4 Verhalten
- Default-Auswahl: **„Alle Märkte / Global"** (`value=""`).
- In der **Primär-Locale** ist das Dropdown deaktiviert (grau) und steht auf
  „Global" — markt-spezifische Primär-Inhalte gibt es nicht.
- Bei Markt-Wechsel: Felder re-resolven (5.1), Change-Detection zurücksetzen.
- Wenn `markets.length === 0` → Dropdown gar nicht rendern.

---

## 7. i18n (neue Strings)

In `app/i18n/de.ts`, `en.ts`, `es.ts` — im `content`-Namespace (dort, wo
`translateAll`/`primaryLanguageSuffix` liegen, en.ts z. B. `:41`, `:49`, `:234`):

| Key | de | en | es |
|-----|----|----|----|
| `content.market.allMarketsGlobal` | „Alle Märkte (global)" | "All markets (global)" | "Todos los mercados (global)" |
| `content.market.selectorLabel` | „Markt" | "Market" | "Mercado" |
| `content.market.inheritedFromGlobal` | „Vom globalen Wert geerbt" | "Inherited from global value" | "Heredado del valor global" |
| `content.market.primaryDisabledHint` | „Marktauswahl nur für Übersetzungen" | "Market selection only for translations" | "Selección de mercado solo para traducciones" |

Plus HelpTooltip-Text `help.marketSelector` (in der jeweiligen Help-Struktur,
analog `ctrlClickLanguage`).

---

## 8. Edge Cases & Risiken

1. **Digest pro Markt:** Der `translatableContentDigest` bezieht sich auf den
   Quell-Inhalt der Locale, **nicht** auf den Markt. `loadTranslatableContent()`
   muss nicht pro Markt neu geladen werden. Risiko: keins, solange derselbe
   Digest für global + markt-spezifisch verwendet wird. *(Bei „no digest"-Feldern
   wie `product_type` gilt weiterhin die Memory-Regel „DB-Save auch ohne Digest";
   das gilt markt-übergreifend.)*
2. **Response ohne `marketId`:** `translationsRegister` gibt `marketId` nicht
   zurück (2.1). → Server darf die DB-`marketId` **nicht** aus der Response
   ableiten, sondern muss den beim Aufruf gesendeten Markt mitschreiben.
3. **Translate-All-Interaktion:** In Phase 1 nur global. Klar dokumentieren im UI-
   Tooltip, dass „Translate All" die globale Ebene füllt. Markt-spezifisches
   Bulk-Translate = Phase 2.
4. **Fallback wenn keine markt-spezifische Übersetzung existiert:** `resolve()`
   fällt auf global zurück (4.4) — deckt sich mit Shopify-Storefront-Verhalten.
   Der Merchant sieht in einem Markt-Kontext den globalen Wert, bis er ihn
   markt-spezifisch überschreibt.
5. **Markt ohne eigene Web-Presence-Locale:** Solche Märkte tauchen im Dropdown
   für die betreffende Locale **nicht** auf (Filter über `localeCodes`, 6.1).
   Damit kann der Merchant keine sinnlose markt-spezifische Übersetzung anlegen,
   die die Storefront nie ausspielt.
6. **Primär-Locale + Markt:** gesperrt (6.4 / 5.2). Kein markt-spezifischer
   Primär-Inhalt.
7. **Clear/Remove-Semantik:** Global geleert → globale Übersetzung weg, aber
   markt-spezifische bleiben (Shopify entfernt bei `translationsRemove` ohne
   `marketIds` nur die globale). Das kann verwirren („global gelöscht, Markt zeigt
   noch alten Wert"). → Im UI beim globalen Clear optional warnen bzw. dokumentieren.
8. **DB-Unique mit Sentinel `""`:** Sicherstellen, dass **nirgends** `marketId`
   auf `null` gesetzt wird (Spalte ist `@default("")`, nicht nullable). Alle
   Upserts explizit `marketId: selectedMarketId || ""`.
9. **Stale Overlays beim Markt-Wechsel:** `localTranslationsRef`-Composite-Keys
   (5.2) verhindern Cross-Markt-Leaks. Beim `onItemSwitch`/`onRefresh` werden
   Overlays ohnehin komplett geleert.
10. **Scope/Autorisierung:** Fehlt das Markets-Scope, wirft `loadMarkets()` bzw.
    liefert leer → `markets=[]` → Feature unsichtbar, kein Crash. Try/catch um
    `loadMarkets()` im Loader.

---

## 9. Schrittweiser Umsetzungsplan (klein geschnitten)

**Phase 0 — Recherche-Verifikation (½ Tag)**
1. `markets`/`webPresence`(s)-Query gegen die im `shopify.app.toml` gepinnte
   API-Version im GraphiQL-Explorer verifizieren (Feldnamen `enabled`/`primary`,
   Singular vs. Plural). Markets-Scope-Name bestätigen.

**Phase 1 — Datenmodell (½ Tag)**
2. `prisma/schema.prisma`: `marketId String @default("")` + erweiterte
   `@@unique`/`@@index` auf **allen** fünf Translation-Tabellen (3.2).
3. `prisma migrate dev --name add_market_id_to_translations`. Migration prüfen
   (Bestandszeilen → `""`). GDPR-Guard-Test laufen lassen.

**Phase 2 — Backend Markets-Enumeration (½ Tag)**
4. `GET_MARKETS` in `content.queries.ts`; `loadMarkets()` in
   `shopify-content.service.ts` (~`:565`). `read_markets`-Scope in
   `shopify.app.toml`. Try/catch → `[]` bei fehlendem Scope.
5. In den fünf In-Scope-Loadern `loadMarkets()` aufrufen und `markets` an die
   Editor-Props durchreichen (Typ `MarketInfo[]` in `content-editor.types.ts`).

**Phase 3 — Backend Save/Remove/Load (1–1,5 Tage)**
6. `content.mutations.ts`: `REMOVE_TRANSLATIONS` um `$marketIds: [ID!]` erweitern
   (`translationsRemove(... marketIds: $marketIds)`).
7. `shopify-content.service.ts`: `saveTranslations()` (`:76`) & `updateContent()`
   (`:596`) um `marketId?: string` erweitern; `marketId` bedingt in
   `TranslationInput` (`:81`, `:614`) und in DB-Upserts (neuer Unique-Key)
   einsetzen; Remove-Zweig `marketIds` reichen (4.2).
8. Load-Pfad: markt-spezifische Zeilen zusätzlich laden und als
   `marketTranslations` an den Client geben (4.3, Variante A).
9. Call-Sites `content-update.action.ts`, `text-translation.handler.ts`,
   `product/update.actions.ts`, `unified-content.actions.ts`: `marketId`
   optional durchschleifen (Default global).

**Phase 4 — Hooks/State (1–1,5 Tage)**
10. `useUnifiedContentEditor.ts`: `selectedMarketId`-State + `handleMarketChange`
    (5.1); Guard bei Locale-Wechsel (Markt zurücksetzen, wenn Locale nicht
    angeboten); ungespeicherte-Änderungen-Guard.
11. `useUiDataLoader.ts`: Helper `buildLocaleKey(locale, marketId)`; `resolve()`/
    `resolveAll()` markt-bewusst (4.4, 5.2); Composite-Keys in `localTranslationsRef`
    & `deletedTranslationKeysRef`; `marketTranslations` als neue Lesequelle.
12. `useFieldHandlers`/Save-/Translate-/Clear-Handler: `selectedMarketId` in die
    Action-Payloads (5.3).

**Phase 5 — UI (1 Tag)**
13. `MarketSelector.tsx` neu (6.1).
14. `UnifiedLanguageBar.tsx` Zeile 144 → rechtsbündige Gruppe mit Dropdown (6.2);
    Props + Durchreichen in `UnifiedContentEditor.tsx:617`.
15. `MobileToolbar.tsx` zusätzliche schmale Zeile (6.3); Props + Durchreichen in
    `UnifiedContentEditor.tsx:578`.

**Phase 6 — i18n (½ Tag)**
16. Strings in `de.ts`/`en.ts`/`es.ts` (Abschnitt 7) + HelpTooltip-Text.

**Phase 7 — Test & Politur (1 Tag)**
17. Testplan Abschnitt 10 abarbeiten; Tooltips/Warnungen für global-Clear.

---

## 10. Test- / Verifikationsplan

### Manuell (Dev-Store mit ≥ 2 Märkten, gemeinsame Locale, z. B. `en` für UK + US)
1. **Markets-Load:** Editor öffnen → Dropdown erscheint neben Locale-Buttons,
   rechtsbündig, Desktop + Mobile. Ohne zweiten Markt: kein Dropdown.
2. **Primär-Locale:** Dropdown deaktiviert, steht auf „Global".
3. **Global-Übersetzung:** Locale `en`, Markt „Global" → speichern → in Shopify-
   Admin (Translate & Adapt) als markt-übergreifend sichtbar.
4. **Markt-spezifisch:** Markt „UK" wählen → Feld zeigt geerbten globalen Wert
   (Fallback-Badge) → überschreiben → speichern → in Shopify nur für UK sichtbar,
   US zeigt weiter global.
5. **Fallback:** Markt „US" (ohne eigene Übersetzung) → zeigt globalen Wert.
6. **Clear markt-spezifisch:** UK-Wert leeren + speichern → `translationsRemove`
   mit `marketIds:[UK]` → UK fällt zurück auf global, global unangetastet.
7. **Clear global:** global leeren → markt-spezifische UK-Übersetzung bleibt
   bestehen (Semantik dokumentiert).
8. **Markt-Wechsel mit ungespeicherten Änderungen:** Discard-Guard greift.
9. **Locale-Wechsel:** gewählter Markt resettet auf „Global", wenn neue Locale
   der Markt nicht anbietet.
10. **Regression:** Kompletter Durchlauf mit nur „Global" gewählt → Verhalten
    identisch zu heute (Save/Translate/Clear/Reload) für alle fünf Content-Typen.

### Automatisiert / Guards
- Prisma-Schema-Drift-Guard-Test grün (GDPR).
- Unit-Test für `buildLocaleKey()` (global → `locale`, markt → `locale@@gid`).
- Unit-/Integrationstest `resolve()` mit `selectedMarketId`: markt-spezifisch >
  global > fallback > empty.
- Service-Test: `saveTranslations({marketId})` setzt `TranslationInput.marketId`
  nur bei nicht-leerem Wert; `translationsRemove` erhält `marketIds` korrekt.

### Verifikations-Kommandos
- `npx prisma migrate status`, `npx tsc --noEmit`, Projekt-Testsuite.
- End-to-End über die `verify`/`run`-Skills (App starten, Flow im echten Editor
  durchklicken).

---

## 11. Betroffene Dateien (Übersicht)

| Datei | Änderung |
|-------|----------|
| `prisma/schema.prisma` | `marketId`-Spalte + Unique/Index auf 5 Translation-Tabellen |
| `app/graphql/content.queries.ts` | neue `GET_MARKETS`-Query |
| `app/graphql/content.mutations.ts` | `REMOVE_TRANSLATIONS` um `marketIds` |
| `src/services/shopify-content.service.ts` | `loadMarkets()`, `saveTranslations()`/`updateContent()` +marketId |
| `app/actions/unified-content.actions.ts` | marketId in Payload/Weitergabe |
| `app/actions/content/content-update.action.ts` | marketId durchreichen |
| `app/routes/api-ai-handlers/text-translation.handler.ts` | marketId (AI-Translate) |
| `app/actions/product/update.actions.ts` | marketId durchreichen |
| `app/hooks/useUnifiedContentEditor.ts` | `selectedMarketId`-State, `handleMarketChange`, Guards |
| `app/hooks/useUiDataLoader.ts` | markt-bewusstes `resolve()`, Composite-Keys, `marketTranslations` |
| `app/components/unified/MarketSelector.tsx` | **neu** — Dropdown |
| `app/components/unified/UnifiedLanguageBar.tsx` | Dropdown rechtsbündig (Zeile 144), Props |
| `app/components/unified/MobileToolbar.tsx` | Dropdown-Zeile, Props |
| `app/components/UnifiedContentEditor.tsx` | Props durchreichen (`:578`, `:617`) |
| `app/i18n/{de,en,es}.ts` | neue Strings |
| `app/types/content-editor.types.ts` | `MarketInfo`-Typ, Prop-Erweiterungen |
| `shopify.app.toml` | `read_markets`-Scope |
| Loader `app.{products,collections,pages,blogs,policies}.tsx` | `loadMarkets()` |
