# Plan: „Direktübersetzungen" — eigener Content-Tab

Status: umgesetzt. Branch: `claude/dynamic-storefront-translation`.

Dieser Plan löst die bisherige Admin-Settings-Variante der dynamischen
Storefront-Übersetzung ab und überführt sie in einen vollwertigen Content-Typ
„Direktübersetzungen" — konsistent zu Produkten/Kollektionen/Vorlagen.

---

## 0. Was ist das, und wie matcht es? (wichtig vorab)

Direktübersetzungen übersetzen **gerenderten Storefront-Text, der nicht in
übersetzbaren Shopify-Feldern liegt** (z. B. Texte von Drittanbieter-Apps:
Bewertungs-Widgets, Badges, Page-Builder). Ein Theme-App-Embed ersetzt diesen
Text **client-seitig** anhand eines vom Händler gepflegten Wörterbuchs.

**Matching:** Die Storefront baut eine Lookup-Tabelle
`normalisierter Quelltext → Übersetzung`, läuft über alle Textknoten,
normalisiert jeden (`"  Write   a review " → "Write a review"`) und schlägt
**exakt** nach. Kein Fuzzy-/Teil-Matching. Server und Storefront normalisieren
identisch.

**Folge fürs Bearbeiten:** Ändert der Händler den Quelltext eines Items,
schreiben wir `sourceText` + Hash des Items um; die Übersetzungen bleiben am
Item hängen (FK auf die Item-ID, nicht auf den Text). Die Storefront sucht
danach nach dem **neuen** Quelltext — Bearbeiten dient also dazu, den Quelltext
**an den real gerenderten Text anzugleichen**. Tippt man etwas, das so nicht
auf der Seite steht, matcht es nie (kein Fehler, einfach kein Treffer). Deshalb
sind **gesammelte/geklickte Strings** (Collector + visueller Editor) so
wertvoll: sie sind 1:1 der gerenderte Text und matchen garantiert.

**Grenzen (ehrlich, im UI kommuniziert):**
- Client-seitig → **nicht von Suchmaschinen indexiert** (für SEO-relevante
  Inhalte die Shopify-Feldübersetzung nutzen).
- Cross-Origin-**iframes** (z. B. Loox) sind nicht erreichbar.

---

## 1. Datenmodell (Umbau auf Item + Übersetzungen)

Ein Item muss auch **ohne** Übersetzung existieren können (frisch per „+"
angelegt), darum saubere Trennung. Das Feature ist noch nicht in Produktion →
keine Datenmigration nötig; bestehende `Dynamic*`-Modelle werden zu `Direct*`
umbenannt/umgebaut.

```prisma
model DirectTranslationItem {
  id         String   @id @default(cuid())
  shop       String
  sourceHash String   // Hash(normalisierter Quelltext) — Identität des Items
  sourceText String   @db.Text
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
  translations DirectTranslation[]
  @@unique([shop, sourceHash])
  @@index([shop])
}

model DirectTranslation {
  id         String   @id @default(cuid())
  itemId     String
  item       DirectTranslationItem @relation(fields: [itemId], references: [id], onDelete: Cascade)
  locale     String
  targetText String   @db.Text
  source     String   @default("user") // "user" | "ai"
  updatedAt  DateTime @updatedAt
  @@unique([itemId, locale])
}

model DirectTranslationCandidate {
  id          String   @id @default(cuid())
  shop        String
  sourceHash  String
  sourceText  String   @db.Text
  count       Int      @default(1)
  status      String   @default("new") // "new" | "rejected"
  firstSeenAt DateTime @default(now())
  lastSeenAt  DateTime @default(now())
  @@unique([shop, sourceHash])
  @@index([shop, status])
}

model DirectTranslationSettings {
  shop      String  @id
  collect   Boolean @default(false) // opt-in Storefront-Collector
  version   Int     @default(1)     // Cache-Buster fürs Storefront-Wörterbuch
  updatedAt DateTime @updatedAt
}
```

- **`enabled` entfällt** — das Theme-App-Embed ist der An/Aus-Schalter.
- **Scope entfällt** — Direktübersetzungen gelten **global** (auf allen Seiten).
- GDPR-Redaction löscht alle vier Modelle.

---

## 2. Backend

- Service (`direct-translation.server.ts`):
  - `normalizeSource`, `sourceHash` (unverändert).
  - Item-CRUD: `listItems`, `getItem`, `createItem(sourceText)`,
    `updateItemSource(itemId, newSource)` (Text + Rehash; Übersetzungen bleiben),
    `deleteItem`.
  - Übersetzungs-CRUD pro Sprache: `setTranslation(itemId, locale, text, source)`,
    `deleteTranslation`.
  - `getDictionary(shop, locale)`: joint Items+Übersetzungen →
    `{ normalisierterQuelltext → target }`, plus `version`/`collect`.
  - Versions-Bump bei jeder dictionary-relevanten Änderung.
  - KI: `aiAutoTranslateItems(...)` — Chunking 50/Prompt, nur **veröffentlichte
    Zielsprachen**, Task-Tracking (bestehendes Muster). „in alle Sprachen" =
    alle veröffentlichten Zielsprachen.
  - Kandidaten: `recordCandidates` (heuristisch gefiltert, gedeckelt; **skippt**
    Strings, die bereits als Item existieren; resurrekt. abgelehnte NICHT zu
    `new`, nur `count`/`lastSeen`), `listCandidates(status?)`,
    `setCandidateStatus(id, "rejected")`, `addCandidatesAsItems(ids)`.
- App-Proxy:
  - `GET /apps/contentpilot/dynamic-translations?locale=xx` → Wörterbuch
    (bleibt; `enabled`-Gate raus).
  - `POST /apps/contentpilot/collect-strings` → Kandidaten (bleibt, opt-in
    gated).
  - **Neu** `POST /apps/contentpilot/direct-add` (signiert) → für den visuellen
    Theme-Editor (Abschnitt 6): legt aus geklicktem Text direkt ein Item (+ ggf.
    Zielsprache) an.

---

## 3. Storefront (Theme-App-Embed)

- `enabled`-Gate im JS **entfernen** → Wörterbuch wird angewandt, sobald das
  Embed aktiv ist.
- Scope-Logik entfernen (immer global).
- Collector bleibt als **Quelle der Kandidaten** (opt-in `collect`), Heuristik +
  Caps unverändert; Review-UI wandert in den Editor-Modal (Abschnitt 5).
- Matching/Replacement (TreeWalker + MutationObserver + localStorage-Cache,
  Stale-while-revalidate) unverändert; setzt nur `node.nodeValue` (kein XSS).

---

## 4. Admin: Content-Typ „Direktübersetzungen"

- Eintrag in `ContentTypeNavigation` + `MainNavigation` **direkt nach „Vorlagen"**,
  Route `/app/direct-translations`.
- Loader lädt Items als `UnifiedItemList`-Items (Titel = Quelltext, Subtitle =
  z. B. „n/ m Sprachen übersetzt"); Editor über `UnifiedContentEditor`.
- **Editor-Layout:**
  - **Oben:** Quelltext, nur per „Bearbeiten"-Button editierbar. Beim Speichern
    eines geänderten Quelltexts: `updateItemSource` (Rehash, Übersetzungen
    bleiben).
  - **4 Buttons:**
    - „Übersetzen in alle Sprachen" / „Übersetzen in diese Sprache" → KI.
    - „Übertragen in alle Sprachen" / „Übertragen in diese Sprache" → Quelltext
      1:1 kopieren (für Markennamen o. Ä.; analog `handleCopyField*`).
  - **Darunter:** Übersetzung der **aktuell gewählten Sprache** (globaler
    Sprachschalter der App), editierbar.
  - **Speichern** über die native App-Bridge-Save-Bar.
- Schreibt **nicht** nach Shopify — persistiert in unsere DB; Storefront holt es
  per Proxy.

---

## 5. „Gefundene Texte" — Benachrichtigung + Modal

**Quelle:** der passive Storefront-Collector (opt-in `collect`) füllt
`DirectTranslationCandidate`. Ein aktiver Server-Scan ist bewusst NICHT geplant
(sähe client-gerenderte App-Widgets nicht).

**Benachrichtigung:**
- Solange es Kandidaten mit Status `new` gibt, zeigt der „Gefundene Texte"-Button
  (im Editor neben „alle übersetzen / alle löschen", zusätzlich im Listen-Header
  erreichbar, auch ohne ausgewähltes Item) ein **Zähler-Badge** („3").
- Optional ein dezenter Banner im Tab: „X neue Texte auf deiner Storefront
  gefunden."

**Modal (Pillen-Checkboxen wie im bisherigen Settings-Muster):**
- **Oben — Neue Texte** (`status: new`): an-/abwählbar.
  - „Hinzufügen" → ausgewählte werden zu Items (optional gleich „mit KI
    übersetzen"); diese Kandidaten werden gelöscht (sind jetzt Items).
  - „Ablehnen" → ausgewählte bekommen `status: rejected` (werden **nicht**
    gelöscht) → lösen keine Benachrichtigung mehr aus.
- **Unten — Abgelehnte Texte** (`status: rejected`, eingeklappt/sekundär): bleiben
  sichtbar, damit man sie später doch aufnehmen kann. „Hinzufügen" funktioniert
  hier genauso.
- Kleiner **„Sammeln"-Toggle** (opt-in `collect`) im Modal, da der
  Admin-Settings-Tab entfällt.

**Dedupe-Regeln (Collector):**
- String existiert bereits als Item → nicht als Kandidat aufnehmen.
- String ist `rejected` → nur `count`/`lastSeen` aktualisieren, **nicht** wieder
  auf `new` heben (keine erneute Warnung).

---

## 6. Visueller Theme-Editor-Modus (zurück im Plan)

Hochpräzises, manuelles Erfassen direkt in der Storefront-Vorschau — die
zuverlässigste Quelle, weil der erfasste String exakt der gerenderte Text ist.

- **Nur im Theme-Editor aktiv** über `Shopify.designMode === true` (für echte
  Kunden niemals sichtbar). Optional zusätzlich per `?cp-translate=1` auf der
  Live-Seite.
- Floating-Panel (an/aus) → „Auswahlmodus" → Klick auf beliebigen Text → der
  gerenderte Quelltext wird erfasst → Mini-Modal mit **Quelle (vorausgefüllt)**
  + **Zielfeld** (für die aktuell vorschau-aktive Sprache) + optional „✨ KI" →
  „Zur Übersetzung hinzufügen" → signierter `POST /apps/contentpilot/direct-add`
  → Item (+ ggf. Übersetzung) in der DB → sofortige Ersetzung in der Vorschau.
- Workflow-Empfehlung: in der **Primärsprache** vorschauen, Quelltext klicken,
  Zielsprache im Modal wählen. (Alternative: in der Zielsprache vorschauen und
  noch-nicht-übersetzten Text klicken.)
- Ergänzt den passiven Collector; ersetzt ihn nicht.

---

## 7. `UnifiedItemList`: „+"-Button

- Neue optionale Props `onAddItem?` + `showAddButton?` (default **aus** → überall
  einsetzbar, vorerst nur in „Direktübersetzungen" sichtbar; später für
  Products etc.).
- Render **vor** dem Suchfeld.
- Klick → neues **transientes** Item im Editor, Quellfeld direkt im Edit-Modus;
  persistiert erst beim Speichern (App Bridge).

---

## 8. Aufräumen

- Admin-Settings-Tab „App-Übersetzungen" + `enabled`-Checkbox + die inline
  „Discovered strings"-Liste entfernen.
- Passiver Collector + `collect-strings`-Route bleiben (Quelle für Abschnitt 5).
- i18n-Schlüssel migrieren/umbenennen (de/en/es).

---

## 9. Reihenfolge der Umsetzung

1. Datenmodell-Umbau (1) + Service/Proxy (2) + Storefront `enabled`/Scope raus (3).
2. Content-Typ + Route + Navigation + `UnifiedItemList`-„+" (4/7).
3. Editor-Layout mit 4 Buttons + App-Bridge-Save (4).
4. „Gefundene Texte"-Benachrichtigung + Modal inkl. `rejected`-Logik (5).
5. Visueller Theme-Editor-Modus (6).
6. Alten Admin-Tab entfernen + i18n (8).

Jede Stufe: tsc sauber, Unit-Tests grün, Build erfolgreich; Review vor Merge auf
`develop`.

---

## 10. Verifikation (Dev-Shop, nach `shopify app deploy`)

- App-Proxy + Theme-Embed + neuer `direct-add`-Endpoint registriert.
- Item anlegen (manuell, „+", Modal, visuell) → Storefront ersetzt Text in der
  Zielsprache.
- „Übersetzen/Übertragen" (alle/diese) funktionieren; nur veröffentlichte
  Zielsprachen.
- Collector findet Strings → Badge + Modal; Ablehnen unterdrückt erneute
  Warnung, Eintrag bleibt unten im Modal addierbar.
- Quelltext bearbeiten → Matching folgt dem neuen Text, Übersetzungen bleiben.
- iframe-App (Loox) bleibt unverändert (dokumentierte Grenze).
