# Taxonomie-Referenzfelder — Plan (damit Farb-Einträge anlegbar werden)

**Status:** **UMGESETZT.** Phase 0 gemessen (§1.1–§1.3), Phase 1 und 2 gebaut (§9). Farb-Einträge — und die neun gleich gebauten Standard-Definitionen — lassen sich anlegen, bearbeiten, übersetzen und löschen. §5 (Rückfallebene) wird als Gesamtausgang nicht gebraucht, ist aber **pro Feld** gebaut: wenn die Werteliste eines einzelnen Felds nicht gelesen werden kann, zeigt das Steuerelement den Grund und einen Deep-Link in den Shopify-Admin, statt eine leere Auswahl anzubieten.
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

### 1.2 Messung — Lauf 2 (2026-08-19, derselbe Shop). **T1 beantwortet, T3 für `color`.**

**T1 ✅ POSITIV.** Der Weg zu den zulässigen Werten ist gemessen und geht über die Kategorie:

```
TaxonomyCategory.attributes            -> TaxonomyCategoryAttributeConnection (nodes)
  -> TaxonomyCategoryAttribute          UNION aus
       TaxonomyAttribute            { id }
       TaxonomyChoiceListAttribute  { id, name, values }   <- hier liegen sie
       TaxonomyMeasurementAttribute { id, name, options }
```

Zehn Top-Level-Kategorien führten 14 Attribute, darunter „Color" und „Pattern" mehrfach — das Attribut hängt also an vielen Kategorien und ist mit einer billigen Stichprobe erreichbar.

**T3 — für `color` gemessen, für `pattern` NICHT.** Das Farbattribut hat **19** Werte: Beige, Black, Blue, Bronze, Brown, Clear, Gold, Gray, Green, Multicolor, Navy, Orange, … Das spricht für zwei Auswahllisten statt einer Suchmaschine — **aber die Bauform entscheidet die breiteste Liste**, und die von `pattern` ist ungemessen. Wäre sie groß, kippt die Entscheidung auf einen Such-Picker. Lauf 2 holte nur eine Liste, weil der Schritt genau einen Treffer verfolgte; seit dem Umbau läuft er einmal pro Handle, also liefert Lauf 3 beide Zahlen. Bis dahin gilt „zwei Auswahllisten" als **wahrscheinlich**, nicht als beschlossen.

**Was daraus für Phase 1 folgt, konkret:**
- `color_taxonomy_reference` ist eine **Mehrfachauswahl mit 1–4 Werten** (`list.min`/`list.max`), `pattern_taxonomy_reference` eine Einfachauswahl. Beide Grenzen gehören in die Formularvalidierung, nicht nur in einen Hinweis.
- Der gespeicherte Wert ist als **Name** anzeigbar (`TaxonomyValue { id name }`), ein Picker zeigt also nie eine rohe GID.
- Die Werteliste kommt live; **kein eigener Cache** (§6 Nicht-Ziel 5 bleibt).

**Die eine verbleibende Schlussfolgerung — und wie sie geschlossen wird.** Das Attribut wird über seinen **Namen** gefunden, weil das Union-Mitglied kein `handle`-Feld hat; der Abgleich ist also `"Color" → "color"`. Das ist die einzige Stelle in der Kette, die nicht gemessen ist. Der nächste Lauf prüft deshalb **Enthaltensein**: jeder Taxonomie-Wert, den ein ECHTER Eintrag dieser Definition hält, muss in der angebotenen Liste vorkommen. Fehlt einer, ist entweder das falsche Attribut getroffen oder die Liste unvollständig — und ein Picker würde einen Wert verweigern, den der Shop bereits benutzt. Der Schritt prüft ab sofort außerdem **beide** Handles (`color` UND `pattern`), nicht nur den ersten Treffer, und rechnet das Enthaltensein **pro Feld**: ein Muster-Wert kann in der Farbliste per Konstruktion nicht vorkommen, ein gemeinsamer Sack GIDs gegen eine Liste hätte also zwangsläufig „nicht abgedeckt" gemeldet.

Drei Dinge, die der Bericht seither auseinanderhält, weil sie sonst als Antwort gelesen werden, die sie nicht sind: eine **abgeschnittene** Werteliste macht ein Enthaltensein *unklar*, nicht *negativ* (der fehlende Wert kann auf der nächsten Seite liegen); ein **fehlgeschlagener** Stichprobenabruf ist keine Aussage über die Daten des Shops; und ein Handle, dessen Wertabfrage scheitert, verschwindet nicht mehr aus dem T1-Verdikt — es heißt dann **T1 TEILWEISE** und nennt, was nicht gemessen wurde.

**Vermutung, ausdrücklich als solche markiert (Phase 0 misst sie):**
- **T1 — ✅ beantwortet, siehe §1.2.** Über `TaxonomyCategory.attributes`.
- **T2 — ✅ beantwortet, siehe §1.1.** Die Validierung nennt das Attribut per Handle.
- **T3 — teilweise beantwortet, siehe §1.2.** 19 Farbwerte ⇒ Auswahlliste für `color`; `pattern` ist ungemessen und kann die Bauform noch kippen.
- **T4:** Ob ein Wert für die Farbe frei wählbar ist oder Shopify Konsistenz zum `color`-Hexwert erzwingt (also ob man „Pink" mit `#000000` kombinieren darf). Betrifft nur, ob die Oberfläche warnen muss.

**Was den Plan kippen würde:** Fällt **T1** negativ aus — keine Möglichkeit, die Werte zu erfahren — dann ist ein Picker nicht baubar, und §5 ist die Antwort.

### 1.3 Messung — Lauf 3 (2026-08-19, derselbe Shop). **Phase 0 abgeschlossen.**

Alles, was §1.2 offen ließ, ist beantwortet — und zwar pro Feld:

| Handle | Getroffenes Attribut | distinkte ids | Werte | Enthaltensein |
|---|---|---|---|---|
| `color` | Color | **1** | **19** | 7/7 ✅ |
| `pattern` | Pattern | **1** | **51** | 1/1 ✅ |

**T3 ✅ endgültig: eine LISTE, kein Such-Picker.** 19 bzw. 51 Werte, keine der beiden Listen ist abgeschnitten. `pattern` ist die breitere und bleibt unter der Schwelle — die Bauform steht damit auf dem gemessenen Maximum, nicht auf dem ersten Treffer. *Bauhinweis:* bei 51 Einträgen ist ein Polaris-`Combobox` mit Tippfilter angenehmer als ein reines `Select`; das ist eine Bedienfrage, keine Architekturfrage, und beide lesen dieselbe Liste.

**Enthaltensein ✅ BESTÄTIGT.** Jeder Taxonomie-Wert, den echte Einträge halten, steht in der angebotenen Liste. Damit ist die letzte Schlussfolgerung der Kette geschlossen: das Attribut über seinen **Namen** zu treffen ist für diese Felder belegt und nicht mehr nur plausibel.

**Die „mehrfach Color"-Sorge ist ausgeräumt.** Die zehn Stichproben-Kategorien führten 14 Attribute mit mehrfachem „Color"/„Pattern", aber **je genau eine id**. Es ist EIN Attribut, das an vielen Kategorien hängt — „die zulässigen Werte" ist also wohldefiniert, und ein Picker hängt nicht davon ab, welche Kategorie zufällig zuerst kam. Das war eine echte offene Frage; sie ist gemessen, nicht weggeargumentiert.

**Der eigentliche Fund von Lauf 3 steht in der Definitionstabelle.** Der Shop trägt **zehn** Shopify-Standard-Definitionen, und **neun** davon haben dieselbe Form: `label` plus **ein** Pflichtfeld `taxonomy_reference: product_taxonomy_value_reference*` mit eigenem Handle — `bag-case-storage-features`, `bag-case-material`, `shape`, `material`, `vase-shape`, `decoration-material`, `plant-support-material`, `desk-organizer-features`, `tool-utensil-material`. Alle neun sind heute aus demselben Grund nicht anlegbar wie die Farbe, und **alle neun** werden von Phase 1+2 mit erledigt: der Editor liest den Handle aus den Validierungen, holt die Werte über dieselbe Kategorie-Tür und schreibt dasselbe Feld. Der Nutzen des Plans ist damit „neun blockierte Typen plus die Farbe", nicht „die Farbe". Bei den neun ist das Feld sogar **einfacher** als bei der Farbe: Einzelwert statt Liste mit 1–4 Grenzen.

**Zwei Randbeobachtungen fürs Bauen:**
- `color_taxonomy_reference` trägt `list.min=1`/`list.max=4`, `pattern_taxonomy_reference` trägt **keine** Grenzen (Einzelwert). Die Formularvalidierung liest sie aus den Validierungen, sie werden nirgends hartkodiert.
- Jeder Eintrag der Stichprobe hält denselben Musterwert (`TaxonomyValue/2874`). Das ist ein Pflichtfeld, das offenbar durchgereicht wird — ein Vorgabewert im Anlege-Formular („Solid"/das, was die anderen Einträge tragen) erspart dem Merchant eine Entscheidung, die er nicht treffen will. Als Vorschlag, nicht als Zwang.

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
- **Neue Komponente** `app/components/metaobjects/TaxonomyValueField.tsx`. **Die Bauform ist entschieden (§1.3): eine Liste, kein Such-Picker** — 19 Farben, 51 Muster, beide vollständig geladen. Ein `Combobox` mit Tippfilter für die Einzelauswahl, Mehrfachauswahl für `list.*` mit den Grenzen aus `list.min`/`list.max`. Kein Suchfeld gegen die Taxonomie-API: die Liste ist klein genug, um ganz da zu sein, und eine Suche über 51 Einträge wäre ein Netzaufruf pro Tastendruck für nichts.
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

## 5. Wenn T1 negativ ausfällt — **eingetreten ist das NICHT** (§1.3)

Der Abschnitt bleibt stehen, weil er die Entscheidung dokumentiert, nicht weil sie noch aussteht: T1 ist positiv, also wird nichts davon gebaut. Was hier stünde, wenn es anders gekommen wäre:

Die Farbliste zeigt im leeren Zustand und neben dem gesperrten „+" einen **Deep-Link in den Shopify-Admin**, wo das Anlegen funktioniert, mit einem Satz dazu, warum es hier nicht geht. Das ist heute schon fast der Zustand — es fehlt nur der Link. Kosten: ein Nachmittag statt einer Woche, und der Merchant kommt an sein Ziel.

Dieser Ausgang wird **implementiert, nicht weggelassen**, falls die Messung ihn verlangt.

---

## 6. Nicht-Ziele

1. **Metaobjekt-DEFINITIONEN anlegen.** Weiterhin Nicht-Ziel. Der Scope `write_metaobject_definitions` ist seit 2026-08-19 zwar vorhanden (für das LÖSCHEN eines Typs, siehe PLAN_METAOBJECTS_EDITOR §9), ein Anlege-Formular für Definitionen gibt es aber nicht und ist keins geplant.
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

1. **T1–T3 — beantwortet** (§1.1–§1.3). **T4 offen:** ob Shopify Konsistenz zwischen dem `color`-Hexwert und dem gewählten Taxonomie-Wert erzwingt (also ob „Pink" mit `#000000` erlaubt ist). Betrifft nur, ob die Oberfläche warnen muss — kein Blocker für Phase 1, weil beide Felder unabhängig geschrieben werden.
2. **Soll die Farbe den Taxonomie-Wert vorschlagen?** Wenn der Merchant `#FFC0CB` setzt, ist „Pink" die naheliegende Basisfarbe. Verlockend und riskant: ein automatisch gesetzter Pflichtwert, den niemand geprüft hat, ist genau die Sorte Vermutung, die dieser Code sonst vermeidet. Erst beantworten, wenn T4 gemessen ist.
3. **Was tun bei einer Definition mit MEHREREN Taxonomie-Feldern? — beantwortet.** `shopify--color-pattern` hat zwei, und Lauf 3 hat beide getrennt gemessen: eigener Handle, eigene Werteliste, eigenes Enthaltensein. Die Zuordnung ist je FELD und funktioniert. Die anderen neun Standard-Definitionen haben je eines und sind damit der einfachere Fall.
4. **Vorbelegung des Musterfelds.** Alle Stichprobeneinträge tragen denselben `pattern_taxonomy_reference` (§1.3). Ein Vorschlagswert im Anlege-Formular wäre bequem — aber ein automatisch gesetzter PFLICHTwert, den niemand geprüft hat, ist dieselbe Sorte Vermutung wie Frage 2. Als vorausgewählter, sichtbarer und änderbarer Vorschlag vertretbar; als stiller Default nicht.

---

## 9. Was gebaut wurde (2026-08-19)

**Phase 1 — der Werteditor.**

- `metaobject-fields.shared.ts` bekommt die Rolle **`taxonomyValue`** für beide Typen, dazu `parseMetaobjectTaxonomyValues` / `serializeMetaobjectTaxonomyValues` (JSON-Array vs. blanker String), `taxonomyAttributeHandle`, `taxonomyValueBounds` und `TAXONOMY_VALUE_GID_PATTERN`. Der `MetaobjectFieldSpec` trägt Handle und Grenzen mit, weil das Feldconfig das Steuerelement daraus baut und die Validierungen sonst nirgends erreichbar sind.
- **Die Anzeigeform IST die Speicherform.** `formatMetaobjectFieldValue` lässt eine Taxonomie-Referenz unverändert; das Steuerelement spricht GIDs und zeigt Namen daneben. Jede verlustbehaftete Hin-und-Rück-Umwandlung in diesem Modul war bisher ein Fehler (der `|`-Trenner in einem Listenwert ist das stehende Beispiel), und hier ist keine nötig.
- `taxonomy-values.server.ts` liest die zulässigen Werte: Runde A findet das Attribut über `TaxonomyCategory.attributes` (billig, ~500 Punkte gegen die 1000-Punkte-Grenze), Runde B holt seine Werte über die id. Drei begrenzte Suchrunden — ohne Suche, mit den Wörtern des Handles, mit dem ersten Wort — statt eines Laufs durch den ganzen Baum. Erfolge werden eine Stunde gemerkt, **Fehlschläge nicht**: eine gedrosselte Minute darf nicht zu einer Stunde „dieses Feld hat keine Werte" werden.
- `api.metaobject-taxonomy.tsx` ist die Route. Sie **gated sich selbst** und liest das Attribut-Handle SERVERSEITIG aus der gecachten Definition — der Client nennt Typ und Feldschlüssel, nie ein Attribut.
- `TaxonomyValuePicker` ist das Steuerelement, `TaxonomyValueField` der Adapter auf `FieldRenderProps`. Einzelwert ⇒ `Select`, Liste ⇒ `ChipCombobox` mit den Grenzen aus den Validierungen; am Maximum werden die übrigen Optionen **mit Begründung gesperrt** statt weggefiltert.

**Phase 2 — Anlegen freigeschaltet.**

- `EDITABLE_METAOBJECT_FIELD_TYPES` enthält beide Taxonomie-Typen. Diese Liste ist damit **absichtlich nicht mehr gleich** `isEditableMetaobjectFieldType`: die eine beantwortet „kann ein Formular das erheben?", die andere „kann eine Tabellenzelle das halten?", und die Taxonomie-Referenz ist genau die Stelle, wo die Antworten auseinandergehen (§3, Nicht-Ziel Bulk-Editor).
- Der Create-Feldtyp `taxonomyValue` rendert **denselben** Picker wie der Editor. Der Wert wird bereits in der Speicherform übergeben und im Payload **unverändert** durchgereicht — `listValue` (kommagetrennt, hier serialisieren) wäre eine zweite Meinung über dieselben Bytes.
- `validateCreatePayload` prüft serverseitig GID-Form und `list.min`/`list.max`.

**Vier Dinge, die still schiefgingen und deshalb geprüft werden.**

1. Ein Wert, der keine `TaxonomyValue`-GID ist, scheitert auf **Schema**-Ebene: ein `errors`-Array mit `data: null`, das `userErrors` nie erreicht — weitergereicht liest sich der ganze Save als Erfolg, während nichts geschrieben wurde. Beide Schreibpfade lehnen vorher ab.
2. Ein **gespeicherter Wert außerhalb der angebotenen Liste** bleibt sichtbar (eigene Option bzw. eigener Chip). Ein leeres Steuerelement wäre die einzige Variante, die beim nächsten Speichern echte Daten löscht.
3. Die Liste wird **einmal pro (Typ, Feld)** geholt, nicht einmal pro Eintrag: 25 Farbeinträge auf einer Seite wären sonst 25 identische Anfragen samt Kategorie-Sweep.
4. Taxonomie-Felder sind **nicht übersetzbar** (`translationKey: ""`). Über die Fremdsprachenkette würden sie zu `""` auflösen, und der nächste Save in einer Fremdsprache würde die shopweite Referenz löschen — dieselbe Regel wie bei Farbe und Datei.

**Nicht gebaut, bewusst:** das Feld im Bulk-Editor (§3), ein eigener Cache der Taxonomie (§6), und T4 (ob Shopify Konsistenz zwischen Hexwert und Taxonomie-Farbe erzwingt) bleibt offen — beide Felder werden unabhängig geschrieben, es blockiert nichts.
