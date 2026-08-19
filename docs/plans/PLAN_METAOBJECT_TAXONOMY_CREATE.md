# Taxonomie-Referenzfelder — Plan (damit Farb-Einträge anlegbar werden)

**Status:** Entwurf. **Phase 0 läuft** — T2 ist beantwortet (§1.1), T1 und T3 noch nicht; Lauf 2 misst die Kategorie-Tür.
**Ziel:** Das eine Loch schließen, das [PLAN_METAOBJECTS_EDITOR](PLAN_METAOBJECTS_EDITOR.md) offen gelassen hat: **einen Eintrag einer Shopify-Standard-Definition anlegen** — allen voran eine Farbe.
**Auslöser:** Gemessen in PLAN_METAOBJECTS_EDITOR §2.1: `shopify--color-pattern` hat **drei** Pflichtfelder, und zwei davon sind Taxonomie-Referenzen (`color_taxonomy_reference: list.product_taxonomy_value_reference*`, `pattern_taxonomy_reference: product_taxonomy_value_reference*`). Diese App hat dafür keinen Editor, also antwortet `metaobjectCreatability` mit `unsupportedRequiredType` und bietet den Typ ausgegraut an. Bearbeiten, Übersetzen und Löschen funktionieren; **Anlegen** nicht — ausgerechnet für den Typ, der den Editor-Plan ausgelöst hat.

> **Scope-Randbedingung: keine neuen Scopes.** `write_metaobjects` und `read_products` sind vorhanden; die Taxonomie liegt hinter derselben Admin-API wie die bereits ausgelieferte Kategorie-Suche. Es läuft **kein** Re-Consent an.

---

## 0. Ist-Zustand (gegen den Code verifiziert, 2026-08-19)

- **Der Create-Pfad steht vollständig.** `createMetaobject` schreibt mit Echo auf id UND Feldwerten, `metaobjectFieldsPayload` baut die Felder, der Definitions-Picker lädt live. Es fehlt **nur** ein Editor für einen Feldtyp.
- **Die Verweigerung ist bereits sauber.** `metaobjectCreatability` ([create-fields.config.ts](../../app/config/create-fields.config.ts)) gibt einen GRUND zurück, [api.create-options.tsx](../../app/routes/api.create-options.tsx) liefert die Definition ausgegraut MIT Begründung, und seit dem Metaobjekt-Editor sperrt `CreateItemModal` zusätzlich den Absenden-Knopf, wenn die vorbelegte Definition ausgegraut ist. Es gibt also nichts aufzuräumen — nur etwas hinzuzufügen.
- **Die Feld-Rollen sind zentral.** `metaobjectFieldRole` ([metaobject-fields.shared.ts](../../app/services/metaobject-fields.shared.ts)) ist die EINE Stelle, die entscheidet, was ein Feldtyp ist; `EDITABLE_METAOBJECT_FIELD_TYPES` die EINE Liste, gegen die `metaobjectCreatability` prüft. Ein neuer Typ wird an genau diesen beiden Stellen bekannt gemacht.
- **Die Validierungen der Definition liegen schon im Cache.** `syncDefinitions` ([metaobject-sync.service.ts](../../app/services/metaobject-sync.service.ts)) selektiert `validations { name value }` und speichert sie in `MetaobjectDefinition.fieldDefinitions`. Was ein Taxonomie-Feld an Werten zulässt, ist also vermutlich bereits da — **gelesen hat es noch niemand.**

### 0.1 Was NICHT wiederverwendbar ist — Korrektur einer naheliegenden Annahme

Der ausgelieferte [TaxonomyField](../../app/components/unified/TaxonomyField.tsx) + [api.product-taxonomy.tsx](../../app/routes/api.product-taxonomy.tsx) sucht `taxonomy.categories` und liefert **`TaxonomyCategory`**-GIDs (`gid://shopify/TaxonomyCategory/…`). Ein Metaobjekt-Feld vom Typ `product_taxonomy_value_reference` will aber **`TaxonomyValue`**-GIDs — in den Stichproben `gid://shopify/TaxonomyValue/11`, `…/2874`.

Das sind zwei verschiedene Entitäten: eine Kategorie ist ein Knoten des Produktbaums („Apparel > Shirts"), ein Value ist die Ausprägung eines ATTRIBUTS („Pink", „Solid"). **Der bestehende Picker ist also Vorbild, nicht Bauteil.** Wiederverwendbar sind sein Muster und seine Regeln (Suche statt Dropdown, ein leeres Ergebnis ist kein „gibt es nicht", ein Schema-Fehler kommt als top-level `errors` und darf nie als leere Liste gelesen werden), nicht sein Endpunkt.

---

## 1. Was gemessen ist, was vermutet, und was den Plan kippen würde

**Gemessen** (PLAN_METAOBJECTS_EDITOR §2.1–§2.4, echter Shop, API 2026-07):
- Die Feldtypen und ihre Pflichtigkeit auf `shopify--color-pattern`.
- Das Wertformat: `color_taxonomy_reference` ist ein JSON-Array mit **einem** Element, `pattern_taxonomy_reference` ein blanker GID-String.
- Alle fünf Stichproben tragen **denselben** `pattern_taxonomy_reference` (`…/2874`), während sich `color_taxonomy_reference` unterscheidet (`11, 1, 3, 9, 10`).
- Standard-Definitionen sind für diese App schreibbar (V1), und `metaobjectCreate` verlangt die Pflichtfelder — die Ablehnung lautete wörtlich `Base color can't be blank; Base pattern can't be blank`.

### 1.1 Messung — Lauf 1 (2026-08-19, `8c19f3-ce.myshopify.com`, API 2026-07, schreibfrei)

**T2 ✅ beantwortet, und besser als erhofft.** Die Validierung nennt das Attribut über einen **stabilen Handle**, nicht über eine GID:

| Feld | Validierungen |
|---|---|
| `color_taxonomy_reference` | `product_taxonomy_attribute_handle = "color"`, `list.min = "1"`, `list.max = "4"` |
| `pattern_taxonomy_reference` | `product_taxonomy_attribute_handle = "pattern"` |
| die neun anderen Standard-Definitionen | je ein `taxonomy_reference` mit dem Handle des eigenen Themas (`material`, `shape`, `vase-shape`, …) |

Zwei Konsequenzen. Ein Handle überlebt einen Shop-Wechsel, eine GID müsste das nicht — die Zuordnung „welches Attribut gehört zu diesem Feld" ist damit **robust**. Und `list.min`/`list.max` sind keine Dekoration: das Farbfeld nimmt **1 bis 4** Werte, das muss ein Anlegen-Formular durchsetzen.

**Nebenbei ebenfalls beantwortet:** eine gespeicherte GID lässt sich zu einem Namen auflösen — `TaxonomyValue/11 → "Pink"`, `/2874 → "Solid"`, `/1 → "Black"`. Ein Picker kann den aktuellen Wert also als Namen anzeigen statt als rohe GID; diese Hälfte von Phase 1 ist sicher.

**T1 ⏳ weiterhin offen — aber die Tür ist jetzt bekannt.** Drei Messungen grenzen sie ein:

- Der `Taxonomy`-Wurzeltyp bietet **ausschließlich** `categories(search, childrenOf, siblingsOf, descendantsOf, first, after, last, before)`. Es gibt **keinen** Attribut-Einstieg und keine shop-weite Werteliste.
- `TaxonomyValue` trägt **nur** `id` und `name`. Er lässt sich also auch nicht rückwärts zu seinem Attribut laufen.
- Damit bleibt als einzige Tür eine **Kategorie**. Ob eine Kategorie Attribute führt, war in Lauf 1 nicht gemessen — der Schritt hat vorher aufgehört.

**Ein Messfehler, behoben:** der Schritt suchte in den Validierungen nach einer **GID** und meldete deshalb „die Validierungen trugen keine" über eine Validierung, die genau das Richtige trug, nur in besserer Form. Er liest jetzt `product_taxonomy_attribute_handle`, und Lauf 2 introspiziert `TaxonomyCategory` — introspektion zuerst, Versuche daraus gebaut, statt `taxonomy.attributes` und `TaxonomyAttribute` zu raten wie beim ersten Mal.

**Vermutung, ausdrücklich als solche markiert (Phase 0 misst sie):**
- **T1:** Es gibt eine Admin-API, über die sich die zulässigen `TaxonomyValue`s **auflisten oder suchen** lassen. Ohne sie ist dieser Plan nicht baubar, und der ehrliche Ausgang ist §5.
- **T2 — ✅ beantwortet, siehe §1.1.** Die Validierung nennt das Attribut per Handle.
- **T3:** Die Menge ist **klein** (Größenordnung Dutzende Basisfarben, ein Dutzend Muster), nicht zehntausend wie der Kategoriebaum. Die fünf Stichproben stützen das, fünf Stichproben sind aber kein Beweis. **Von T3 hängt die Bauform ab**: klein ⇒ zwei Auswahllisten; groß ⇒ ein Such-Picker nach dem Vorbild von `TaxonomyField`.
- **T4:** Ob ein Wert für die Farbe frei wählbar ist oder Shopify Konsistenz zum `color`-Hexwert erzwingt (also ob man „Pink" mit `#000000` kombinieren darf). Betrifft nur, ob die Oberfläche warnen muss.

**Was den Plan kippen würde:** Fällt **T1** negativ aus — keine Möglichkeit, die Werte zu erfahren — dann ist ein Picker nicht baubar, und §5 ist die Antwort.

---

## 2. Phase 0 — Messung (schreibfrei, in die bestehende Probe)

**Unabhängig auslieferbar:** ja, es ist ein Dev-Diagnosewerkzeug.

Ein weiterer Schritt in [api.metaobject-probe.tsx](../../app/routes/api.metaobject-probe.tsx), `steps=taxonomy`:

1. **`validations` mitliefern.** Die Definitionstabelle der Probe wirft sie heute weg (`flattenFieldDefinitions` nimmt nur `key/name/type/required`). Sie auszugeben kostet nichts und beantwortet **T2** aus Daten, die schon im Cache liegen.
2. **Das Schema fragen, nicht raten.** Introspektion von `Taxonomy` und `TaxonomyValue`: welche Felder/Connections es gibt, ob `values` suchbar ist, ob eine Attribut-Ebene existiert. Nach dem Muster des `referencedBy`-Schritts, inklusive **Abstieg**: eine breite Auswahl, die an einem Resolver scheitert, darf nicht als „gibt es nicht" berichtet werden — genau der Fehler, der im Metaobjekt-Plan zweimal auftrat.
3. **Live auflösen.** Die aus den Stichproben bekannten GIDs (`TaxonomyValue/11`, `/2874`) per `nodes(ids:)` lesen und ihre Namen zeigen. Bestätigt, dass es TaxonomyValues sind, und liefert den Beweis, dass ein Wert zu einem Namen auflösbar ist — ohne den kann ein Picker nichts anzeigen.
4. **Die Menge zählen** (**T3**): die zulässigen Werte des Farbattributs auflisten und ihre Anzahl berichten. Eine volle Seite meldet „n oder mehr", nie eine erfundene Gesamtzahl.

**Regeln** wie in der bestehenden Probe: `missing` (die API hat geantwortet, es gibt das nicht) und `error` (wir haben keine Antwort bekommen) sind **getrennte** Zustände, der ganze Schritt ist schreibfrei, und die Route bleibt dev-gegated.

**Ergebnis** wird als Tabelle in §1 dieses Plans nachgetragen, mit Datum und Shop.

---

## 3. Phase 1 — Der Werteditor

**Unabhängig auslieferbar:** ja. **Setzt Phase 0 voraus** — die Bauform hängt an T1/T3.

- **Neue Rolle** `taxonomyValue` in `metaobjectFieldRole`, für `product_taxonomy_value_reference` **und** `list.product_taxonomy_value_reference`. Die Liste unterscheidet sich nur in der Serialisierung (JSON-Array statt blanker String) — dieselbe Trennung, die `list.single_line_text_field` schon hat, und sie gehört in `parseMetaobjectFieldInput`, nicht in die Komponente.
- **Neue Komponente** `app/components/metaobjects/TaxonomyValueField.tsx`. Bei **kleiner** Menge (T3) ein `Select`/`ChoiceList` aus den zulässigen Werten; bei großer ein Such-Picker nach dem Vorbild von `TaxonomyField`. **Die Form wird nach Phase 0 entschieden, nicht vorher** — ein Suchfeld über zwölf Farben ist so falsch wie ein Dropdown über zehntausend Kategorien.
- **Neue Route** `app/routes/api.metaobject-taxonomy.tsx`: liefert die zulässigen Werte für ein FELD einer Definition. Gated wie jede Resource-Route (`canAccessContentType(plan, "metaobjects")`), weil sie direkt per GET erreichbar ist.
- **Anzeige des BESTEHENDEN Werts.** Ein Eintrag im Editor trägt eine GID; ohne Auflösung stünde dort `gid://shopify/TaxonomyValue/11`. Die Route löst deshalb auch einzelne GIDs zu Namen auf, und eine **nicht** auflösbare GID wird als solche gezeigt — nie als leeres Feld, das beim nächsten Speichern den Wert löscht.

**Ausdrücklich NICHT in Phase 1:** das Feld im **Bulk-Editor**. Dort wäre es eine weitere Spaltenart mit eigener Diff-Semantik; `applyBulkDiff` bleibt vorerst, was er ist.

---

## 4. Phase 2 — Anlegen freischalten

**Setzt Phase 1 voraus.** Klein.

- `EDITABLE_METAOBJECT_FIELD_TYPES` bekommt die beiden Taxonomie-Typen. **Das ist der Schalter**: `metaobjectCreatability` hört damit auf, `unsupportedRequiredType` zu melden, `api.create-options` bietet die Definition normal an, und `CreateItemModal` lässt den Absenden-Knopf zu.
- `metaobjectFieldDefs` erzeugt für sie ein Create-Feld der neuen Art; `metaobjectFieldsPayload` serialisiert Liste vs. Einzelwert.
- **Der Server prüft erneut.** `createContent` ist direkt POST-erreichbar: ein Wert, der keine `TaxonomyValue`-GID ist, wird abgelehnt, bevor er `metaobjectCreate` erreicht — sonst kommt ein Schema-Fehler zurück, den `userErrors` nie sieht und der die ganze Erstellung als Erfolg aussehen lässt (dieselbe Falle, die `TaxonomyField` im Kommentarkopf beschreibt).

**Danach ist das Planziel des Editor-Plans erfüllt:** Farb-Einträge lassen sich anlegen, bearbeiten, übersetzen und löschen.

---

## 5. Wenn T1 negativ ausfällt

Dann ist ein Picker nicht baubar, und die ehrliche Antwort ist **nicht** ein Formular, das immer scheitert:

Die Farbliste zeigt im leeren Zustand und neben dem gesperrten „+" einen **Deep-Link in den Shopify-Admin**, wo das Anlegen funktioniert, mit einem Satz dazu, warum es hier nicht geht. Das ist heute schon fast der Zustand — es fehlt nur der Link. Kosten: ein Nachmittag statt einer Woche, und der Merchant kommt an sein Ziel.

Dieser Ausgang wird **implementiert, nicht weggelassen**, falls die Messung ihn verlangt.

---

## 6. Nicht-Ziele

1. **Metaobjekt-DEFINITIONEN anlegen.** Unverändert `write_metaobject_definitions` und damit Re-Consent — siehe PLAN_METAOBJECTS_EDITOR §9.
2. **Andere Referenzfeldtypen** (`metaobject_reference`, `product_reference`, `variant_reference`, …). Jeder braucht seinen eigenen Picker; dieser Plan löst den einen Typ, der das Anlegen blockiert.
3. **Taxonomie-Werte im Bulk-Editor** (§3).
4. **Die Kategorie eines Produkts ändern.** Das ist `TaxonomyField` und existiert.
5. **Eine eigene Kopie der Taxonomie im Cache.** Sie ist Shopifys Daten, ändert sich ohne unser Zutun und ist als Suche live schneller beantwortet als als Sync — dieselbe Begründung, die `api.product-taxonomy.tsx` im Kopf trägt.

---

## 7. Tests

| Phase | Unit | Integration |
|---|---|---|
| 0 | Trennung `missing` vs. `error`; der Abstieg meldet, welche Auswahl geantwortet hat | — (Probe wird von Hand gefahren) |
| 1 | `metaobjectFieldRole` für beide Typen; `parseMetaobjectFieldInput` serialisiert Liste als JSON-Array und Einzelwert blank; eine nicht auflösbare GID bleibt stehen statt zu leeren | Route-Gate: Free/Basic bekommt 403 |
| 2 | `metaobjectCreatability` sagt für `shopify--color-pattern` ja, sobald die Typen in der Liste stehen | Create mit gültigen Werten legt an; Create mit einer Nicht-Taxonomie-GID wird SERVERSEITIG abgelehnt |

---

## 8. Offene Fragen

1. **T1–T4** (§1). Phase 0 beantwortet sie.
2. **Soll die Farbe den Taxonomie-Wert vorschlagen?** Wenn der Merchant `#FFC0CB` setzt, ist „Pink" die naheliegende Basisfarbe. Verlockend und riskant: ein automatisch gesetzter Pflichtwert, den niemand geprüft hat, ist genau die Sorte Vermutung, die dieser Code sonst vermeidet. Erst beantworten, wenn T4 gemessen ist.
3. **Was tun bei einer Definition mit MEHREREN Taxonomie-Feldern?** `shopify--color-pattern` hat zwei, und die anderen neun Standard-Definitionen je eines. Vermutlich unproblematisch, aber die Zuordnung „welches Attribut gehört zu welchem Feld" ist T2 und muss je Feld stimmen, nicht je Definition.
