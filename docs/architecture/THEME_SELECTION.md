# Theme-Selection-Contract

**Was das ist:** der aktive Architektur-Vertrag für die merchant-wählbare Theme-Zielführung
(„Welches installierte Theme wird beim Bearbeiten/Übersetzen von Theme-Inhalten adressiert?"). Gilt
ausschließlich für die Theme-Content-Familie ([`THEME_CONTENT_TYPES`](../../app/utils/content-type-groups.ts):
`templates | system | delivery | sellingPlans | onlineStoreExtras`) plus die eng verwandte
Rubrik `customer_privacy` (Cookie-Banner). Produkte, Collections, Pages, Blogs, Articles,
Policies, Metaobjects sind explizit nicht betroffen.

**Warum das existiert:** Es gibt zwei Shopify-Schreibpfade (`themeFilesUpsert` für Primary,
`translationsRegister` für Foreign) plus einen DB-Mirror. Ohne einheitliche Theme-Klammer driften
diese drei latent auseinander — Primary landet in MAIN, Foreign in dem Theme, dessen `theme_id` in
der zufällig gecachten GID steckt, DB in irgendwas dazwischen. Dieser Vertrag zwingt alle drei auf
DIESELBE, explizit gewählte Theme-GID.

**Historie:** ursprünglich in `docs/plans/PLAN_THEME_SELECTION.md` (Phasen 0–7) formuliert, 2026-07
vollständig ausgeliefert und dieser Plan entfernt. Was hier steht ist der destillierte Kern; die
Historie der Umsetzung ist in Git.

---

## Die Invarianten

### 1. Selection-Persistenz — pro Shop in `AISettings`

Ein Feld: `AISettings.selectedThemeId String?` ([schema.prisma:61](../../prisma/schema.prisma#L61)).
`null` bedeutet „automatisch MAIN". Die Wahl ist shop-scoped, nicht session-scoped, weil der
DB-Datenbestand (`ThemeContent`/`ThemeTranslation`) shop-scoped ist und die Wahl zu ihm passen muss.

### 2. `resolveSelectedThemeId` ist die einzige Auflösungsquelle

Jeder Write- oder Read-Pfad, der Theme-Content adressiert, ruft [`resolveSelectedThemeId(shop, admin)`](../../app/services/theme-selection.server.ts).
Kontrakt der Funktion:

1. Liest `AISettings.selectedThemeId`.
2. Validiert gegen die Live-Theme-Liste (`getCachedThemes`, 60 s TTL + In-Flight-Dedup — ohne Cache
   trippt jede Item-Liste die Shopify-Rate-Limits).
3. Ungültige/gelöschte ID → `pickMainThemeId` (MAIN, sonst erstes Theme, sonst `null`).

Nie direkt `AISettings.selectedThemeId` lesen; immer über den Resolver, damit Cache, Fallback und
Validierung an einer Stelle bleiben.

### 3. `themeId`-Herkunft — aus der resourceId-GID, mit `""`-Fallback

Zentraler Helper: [`extractThemeIdFromResourceId`](../../app/utils/theme-id.ts). Zwei GID-Formen:

- **Query-Parameter-Form** (`?theme_id=<n>`): JSON-Templates, Section-Groups, Settings-Categories,
  App-Embeds.
- **Object-Id-Form** (trailing numeric): `OnlineStoreThemeLocaleContent`,
  `OnlineStoreThemeSettingsDataSections`, legacy `OnlineStoreTheme`.

Beide werden auf `gid://shopify/OnlineStoreTheme/<n>` normalisiert. Jeder Write-Pfad, der eine
`ThemeContent`/`ThemeTranslation`-Zeile schreibt, setzt `themeId: extractThemeIdFromResourceId(resId) ?? ""`.

**Der `""`-Fallback ist kein Legacy-Artefakt, sondern normaler Zustand für Flat-Domains** deren GID
strukturell kein `theme_id` einbettet (z. B. Cookie-Banner in
[app.cookie-banner.tsx](../../app/routes/app.cookie-banner.tsx)). Er bleibt permanent. Siehe §5.

### 4. Unique-Keys tragen `themeId`

- `ThemeContent` — `@@unique([shop, resourceId, groupId, themeId])`
  ([schema.prisma:751](../../prisma/schema.prisma#L751)).
- `ThemeTranslation` — `@@unique([shop, resourceId, groupId, key, locale, themeId, marketId])`
  (accessor `shop_resourceId_groupId_key_locale_themeId_marketId`,
  [schema.prisma:786](../../prisma/schema.prisma#L786)). Das ist die einzige Translation-Tabelle,
  die `themeId` UND `marketId` in den Key faltet.

### 5. Read-Scoping: `OR({themeId: selected}, {themeId: ""})` — der `""`-Zweig bleibt permanent

Jede Lese-Query auf `ThemeContent`/`ThemeTranslation` scopet über den zentralen Helper
[`themeScope(selectedThemeId)`](../../app/services/theme-content-api.server.ts):

```ts
selectedThemeId ? { OR: [{ themeId: selectedThemeId }, { themeId: "" }] } : {}
```

Der `""`-Zweig war ursprünglich als Legacy-Kompatibilität geplant und sollte nach Backfill fallen —
in der Praxis ist er strukturell nötig, weil Flat-Domains (Cookie-Banner, Teile von
system/delivery/sellingPlans) `themeId = ""` als **normalen Zustand** speichern (§3). Ein Entfernen
würde diese Rubriken für jeden Merchant mit gewähltem Theme aus der UI verschwinden lassen. Nicht
tun.

Betroffene Read-Sites (alle rufen `themeScope` bzw. inlined identisch):
[`templates-load.action.ts`](../../app/actions/templates/templates-load.action.ts),
[`text-translation.handler.ts`](../../app/routes/api-ai-handlers/text-translation.handler.ts),
[`theme-content-domain.server.ts`](../../app/utils/theme-content-domain.server.ts),
[`theme-content-api.server.ts`](../../app/services/theme-content-api.server.ts).

### 6. Write-Kopplung — Primary, Foreign, DB-Mirror zielen auf DASSELBE Theme

In [`templates-update.action.ts`](../../app/actions/templates/templates-update.action.ts):

- **Primary-Pfad** (`themeFilesUpsert`): `themeId = await resolveSelectedThemeId(...)`. Kein harter
  MAIN-Lookup mehr.
- **Foreign-Pfad** (`translationsRegister`): keyt über die `resourceId`-GID. Da §5 den Read auf
  `selectedThemeId` scopet, trägt `selectedItem.resourceId` die richtige theme_id.
- **DB-Mirror**: schreibt `themeId: extractThemeIdFromResourceId(resId) ?? ""` (§3), und die
  Unique-Keys aus §4 zwingen die Zuordnung.

**Divergenz-Guard** ([templates-update.action.ts:236-255](../../app/actions/templates/templates-update.action.ts#L236)):
vor jedem `translationsRegister`-Call wird geprüft, dass
`extractThemeIdFromResourceId(resId) === selectedThemeId` (oder `null`, für theme-agnostische
Ressourcen). Divergenz → Skip mit hartem `shopifyErrors`-Eintrag, kein stiller Cross-Theme-Write.

### 7. Zwei Sync-Modi — FULL (nur MAIN) und SCOPED (spezifisches Theme)

`translatableResources(resourceType:…)` kann NICHT nach Theme gefiltert werden UND enumeriert de
facto nur das MAIN-Theme (empirisch verifiziert 2026-07 gegen `patis-universe-test-shop`, 7 Themes).
`OnlineStoreTheme.translatableResources` existiert nicht. Daraus die zwei Modi in
[`background-sync.service.ts`](../../app/services/background-sync.service.ts):

- **`syncAllThemes()` / `runFullThemeSync()` ohne `targetThemeId`** — FULL: enumeriert per
  `translatableResources` → deckt nur das MAIN-Theme ab. Führt Orphan-Cleanup (§8) aus.
- **`syncTheme(themeGid)` / `runFullThemeSync(_, themeGid)`** — SCOPED: baut die Ressourcen-Liste
  eines SPEZIFISCHEN Themes (inkl. UNPUBLISHED/DEVELOPMENT) selbst auf via
  `enumerateThemeResourcesFor`, holt Inhalte per `translatableResourcesByIds`, stempelt Zeilen mit
  `themeId = themeGid`. **Kein Orphan-Cleanup** (arbeitet nur auf einem Theme; MAIN darf nicht
  angefasst werden). Coalescing pro `(shop, theme)`.

`enumerateThemeResourcesFor` verwendet drei Strategien je nach resourceId-Form:

- **Strategie A — deterministisch:** LOCALE_CONTENT & SETTINGS_DATA_SECTIONS. Theme-Numerik IST die
  Object-Id → GID direkt konstruierbar.
- **Strategie B — Theme-Dateien:** JSON_TEMPLATE & SECTION_GROUP. `theme.files`-Query listet die
  Dateien, deren Basenames die GIDs ergeben.
- **Strategie C — MAIN→T-Rewrite:** SETTINGS_CATEGORY & APP_EMBED. MAIN-Ressourcen holen, `theme_id`
  in der GID umschreiben, per `translatableResourcesByIds` prüfen ob im Ziel-Theme vorhanden.
  Target-unique Kategorien/Embeds werden NICHT erfasst (bewusster Trade-off — Label-Resolver wäre
  fragil bei marginalem Nutzen).

Auto-Trigger für SCOPED sync:

- **Theme-Wechsel** ([`api.select-theme.tsx:58`](../../app/routes/api.select-theme.tsx#L58)): fires
  `syncTheme(selected)` sofort nach `setSelectedThemeId`.
- **Manueller Sync-Button** über [`api.sync-content.tsx:116`](../../app/routes/api.sync-content.tsx#L116).
- **Periodisch** über [`sync-scheduler.service.ts:207`](../../app/services/sync-scheduler.service.ts#L207)
  — synct MAIN via FULL plus das gewählte Theme via SCOPED.

### 8. Orphan-Cleanup beim Full-Sync — mit zwei Guards

In `runFullThemeSync` ([background-sync.service.ts:2141-2179](../../app/services/background-sync.service.ts#L2141))
werden `ThemeContent`/`ThemeTranslation`-Zeilen gelöscht, deren `themeId` in keinem
`GET_THEMES`-Ergebnis mehr vorkommt. Zwei Guards, die unbedingt bleiben müssen:

- **`THEME_CAP = 250`**: wenn die Enumeration den Cap trifft, ist die Liste möglicherweise
  abgeschnitten → Cleanup skippen (`notIn` würde valide Zeilen löschen).
- **Leere Liste = API-Blip**: `GET_THEMES` liefert `[]` → Cleanup skippen. Kein Massen-Delete auf
  Verdacht.
- **`themeId = ""` immer behalten**: das ist der Flat-Domain-Zustand (§3, §5).

Der Cleanup läuft nur im FULL-Modus (nicht im theme-scoped `syncTheme(themeGid)`), weil er
theme-übergreifend arbeitet.

---

## Shopify-API-Fakten, die das Design geprägt haben

Diese sind einmal recherchiert und schwer neu abzuleiten — hier festgehalten, damit spätere Änderungen
nicht die falsche Prämisse annehmen:

- **`translatableResources` akzeptiert kein `themeId`/`id`-Filterargument.** Nur
  `first/last/after/before/reverse/resourceType`. → Sync liest gemischt, filtert lokal (§7).
- **`OnlineStoreTheme` hat keine `translatableResources`-Connection.** Sein `translations(locale:, marketId:)`-Feld liefert nur bereits publizierte Übersetzungen ohne `key`/`digest`-Enumeration → kein Ersatz für den Sync.
- **`themeFilesUpsert` und `translationsRegister` akzeptieren Nicht-MAIN-Themes** (`UNPUBLISHED`,
  `DEVELOPMENT`), Phase-0-empirisch verifiziert. Dropdown darf alle Themes anbieten.
- **Shopify lowercased Regional-Codes in Filenamen** (`pt-BR` → `pt-br`). Deshalb löst
  `resolveFilename` den Default-Locale-File über `locales/*.default.json`-Glob auf und schreibt den
  von Shopify zurückgegebenen `fileNode.filename` zurück, statt einen Namen zu konstruieren.
- **`translatableResources` liefert i. d. R. das publizierte Theme**, aber nicht garantiert. Deshalb
  ist der `themeId` PRO ZEILE aus der GID abgeleitet (§3), nicht aus dem Sync-Kontext gefolgert.

---

## Verwandte Docs

- [`THEME_RICHTEXT_HANDLING.md`](THEME_RICHTEXT_HANDLING.md) — Autofix-vs.-Raw für richtext-Felder;
  betrifft den Primary-Pfad in `templates-update.action.ts` orthogonal zur Theme-Wahl.
- [`../../CLAUDE.md`](../../CLAUDE.md) — Deploy-kritische Theme-Gotchas (One-Theme-App-Extension-Limit,
  App-Embed-CSS-Restriktion, Section-Group-Filename-Routing).

## Diagnostik-Endpoint

- **`/api/translation-probe`** ([`api.translation-probe.tsx`](../../app/routes/api.translation-probe.tsx))
  ist ein diagnostischer Read (+ optionaler Write-Test) über die Theme-/Translation-Coverage. Der
  Settings-Tab ist hinter `process.env.APP_ENV === "development"` versteckt
  ([`app.settings.tsx:430`](../../app/routes/app.settings.tsx#L430)); die Action-Route selbst prüft
  nur `authenticate.admin`. Bewusst so belassen — der Merchant kann damit nur den eigenen Shop
  proben (kein Cross-Shop-Zugriff, keine Secrets erreichbar), und der Write-Test schreibt einen
  eindeutig getaggten, reversiblen Wert. Kein Grund für einen zusätzlichen APP_ENV-Guard auf der
  Route.
