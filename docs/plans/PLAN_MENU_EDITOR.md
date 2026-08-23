# Menü-Editor — Plan (ändern und übersetzen auf einem Bildschirm)

**Status:** Phase 0 GEMESSEN und ABGESCHLOSSEN (2026-08-23, `patis-universe-test-shop`, API 2026-07). Kein Blocker: der Editor ist baubar, und die **eine** Reparatur, die er braucht, ist benannt und bewiesen — Umhängen löscht die Übersetzungen des Punkts, seines ganzen Astes und auf JEDER Ebene (global wie markt-spezifisch), also registriert der Editor sie danach neu (§2.5, §2.6). Die ausgelieferte Umbenennen-Funktion ist davon **nicht** betroffen, weil sie nichts umhängt. Vom Editor selbst ist bisher nur das Umbenennen gebaut (§0).
**Ziel:** `/app/menus` wird eine vollständige Alternative zum Shopify-Menü-Editor — Reihenfolge, Verschachtelung, Anlegen, Löschen, Ziel ändern, das Menü selbst umbenennen — **und** die Übersetzung steht dabei in derselben Zeile. Der Zweck ist nicht Funktionsgleichheit mit Shopify, sondern das Wegfallen des Hin-und-Her: heute benennt man im Shopify-Admin um und übersetzt danach hier.

> **Keine neuen Scopes.** `write_online_store_navigation` und `read_translations`/`write_translations` sind vorhanden. Es läuft **kein** Re-Consent an. Das ist die eine Randbedingung, die diesen Plan billig macht — jede Phase unten kostet Arbeit, keine kostet Händler.

---

## 0. Ist-Zustand (2026-08-23, gegen den Code verifiziert)

Gebaut und auf `develop`:

- **Übersetzen** jedes Menüpunkts auf jeder Ebene ([menu-translations.server.ts](../../app/services/menu-translations.server.ts)). Die Übersetzung liegt auf `gid://shopify/Link/<dieselbe Zahl wie die MenuItem-ID>` — gemessen, siehe CLAUDE.md.
- **Umbenennen** der Primärtitel ([menu-write.server.ts](../../app/services/menu-write.server.ts)): frischer Lesevorgang, nur Titel ersetzt, Fingerprint-Absage bei Drift, Echo- und ID-Prüfung, Purge nach Händlereinstellung.
- **Die Sonde** ([api.menu-write-probe.tsx](../../app/routes/api.menu-write-probe.tsx)), die das alles an einem Wegwerf-Menü misst.

Was der heutige Schreibweg **nicht** kann und auch nicht können soll: er ist als „ersetze Titel im fremden Baum" gebaut. Alles, was er nicht versteht, reicht er unverändert durch — und genau diese Eigenschaft muss für den Editor fallen, denn dort **ist** das Umbauen des Baums die Absicht.

---

## 1. Die eine Tatsache, aus der alles folgt

`menuUpdate(id, title, handle, items)` nimmt die **komplette** Item-Liste. Ein Punkt, der nicht mitgeschickt wird, ist gelöscht (gemessen 2026-08-23).

Für den Editor ist das eine gute Nachricht: **Umsortieren, Verschachteln, Anlegen, Löschen und Ziel-Ändern sind alle derselbe Aufruf.** Es gibt nichts zusätzlich zu erfinden — nur einen anderen Baum zu schicken. Der ganze Rest dieses Plans dreht sich um zwei Fragen, die daraus entstehen:

1. **Woher kommt der Baum, den wir schicken?** Heute: aus einem frischen Lesevorgang. Künftig: aus dem Editor. Damit verliert der frische Lesevorgang seine Rolle als „Quelle für alles, was wir nicht anfassen" — Positionen sind jetzt genau das, was der Händler anfasst.
2. **Was ist dann noch eine Drift?** Heute: jede Abweichung ⇒ Absage. Künftig: eine Absage bei jeder fremden Änderung wäre unbrauchbar, weil der Editor länger offen steht. Es braucht eine **Zusammenführung** statt einer Verweigerung.

---

## 2. Phase 0 — was gemessen werden muss, bevor irgendetwas gebaut wird

Die Sonde beantwortet heute fünf Fragen (§0). Der Editor hängt an **vier weiteren**, und die erste davon kann den ganzen Plan kippen.

### 2.1 Behält ein Punkt seine ID, wenn er VERSCHOBEN wird? — **JA** (gemessen 2026-08-23)

Beim Umbenennen ist die ID-Stabilität gemessen. Beim **Verschieben** ist sie es nicht — und sie ist dort wichtiger: Die Übersetzung hängt an `Link/<Zahl>`. Vergibt Shopify beim Umhängen eine neue ID, verliert **jeder Umzug** die Übersetzungen des Punkts, und `refreshMenuCache`s Orphan-Cleanup löscht die Zeilen beim nächsten Laden endgültig.

**Ergebnis:** Der Punkt (Tiefe 2 → 1) behielt seine ID, sein Kind behielt seine, und die unbeteiligten Geschwister behielten ihre, obwohl sich jede Position änderte. **Ein Baum-Editor darf frei ziehen** — die ID-Seite der Frage ist beantwortet.

**Aber die Übersetzung war danach weg**, auf derselben Link-GID. Das ist §2.5 und der einzige offene Blocker.

### 2.2 Legt ein Item OHNE `id` wirklich einen neuen Punkt an? — **JA** (gemessen)

`MenuItemUpdateInput.id` ist optional (gemessen). Das ist mit hoher Wahrscheinlichkeit der Anlege-Weg, aber „wahrscheinlich" ist in diesem Repo kein Befund.

**Ergebnis:** Ja. Der neue Punkt kam an **exakt der Position** zurück, an der er geschickt wurde, keine bestehende ID änderte sich, und seine Link-Ressource löst **sofort** auf — die zweite Speicherphase (§4.1) hat also etwas zum Schreiben. Die Zuordnung temporäre ID → echte ID über die Position ist damit belegt, nicht angenommen.

### 2.3 Wie tief geht Shopify wirklich? — **DREI** (gemessen)

Dokumentiert sind drei Ebenen. Der Schreibweg liest vier und verweigert fünf. Ob Shopify eine vierte Ebene **annimmt**, ist ungemessen — und der Editor muss beim Ziehen irgendwo abriegeln.

**Ergebnis:** Drei Ebenen werden angenommen und vom frischen Lesevorgang bestätigt; vier und fünf werden abgelehnt, wörtlich mit `items: Menu has more than 3 levels of nesting`. Die Drag-Projektion klemmt also bei **3**. Der Schreibweg verweigert erst ab 5 — großzügiger als die Plattform, was in Ordnung ist: `tooDeep` ist damit eine Schiene, die nirgends feuert, und sie bleibt, weil die Folge (eine ungelesene Ebene wird gelöscht) unreparierbar wäre.

### 2.4 Was passiert mit den Übersetzungen eines gelöschten Punkts? — **weg** (gemessen)

**Ergebnis:** Die Übersetzung geht mit dem Punkt; seine Link-Ressource löst danach überhaupt nicht mehr auf. Ein versehentliches Löschen ist durch Wiederanlegen **nicht** reparierbar (der neue Punkt bekommt eine neue ID, §2.2) — das gehört in den Warntext der Löschbestätigung (§7).

### 2.5 WELCHER Schreibvorgang tötet eine Übersetzung? — **nur das Umhängen** (gemessen)

Vier Punkte, einer pro Hypothese, nach jeder Stufe alle gelesen:

| Stufe | KONTROLLE | UMGEHÄNGT | UMBENANNT | UMSORTIERT |
|---|---|---|---|---|
| registriert | da | da | da | da |
| nach No-op-Write | da | da | da | da |
| nach dem Umhängen | da | **weg** | da | da |
| nach dem Umbenennen | da | weg | da (outdated) | da |
| nach dem Write danach | da | weg | da (outdated) | da |
| nach dem Umsortieren | da | weg | da (outdated) | da |

**Ergebnis: (a).** Nur ein Wechsel des ELTERNTEILS löscht. Die drei Verneinungen sind dabei so viel wert wie der Befund selbst:

- **(c) widerlegt** — ein unberührter Punkt übersteht fünf Whole-Tree-Writes. Ein `menuUpdate` an sich ist harmlos.
- **(d) widerlegt** — eine outdated Übersetzung übersteht zwei weitere Writes. Shopify sammelt sie nicht ein.
- **(b) widerlegt** — Umsortieren beim selben Elternteil behält sie.

**Damit ist die ausgelieferte Umbenennen-Funktion entlastet**: sie hängt nichts um, also hält ihr Versprechen „Purge aus ⇒ Übersetzungen bleiben". Das war die Frage, wegen der dieser Abschnitt existierte.

**Und für Phase 1 ist es eine Aufgabe, kein Blocker** — mit einem gemessenen Preis:

- **Ein mitgezogenes Kind verliert seine Übersetzung ebenfalls** (Spalte `CARRIED`, im selben Lauf). Betroffen ist also nicht der gezogene Punkt, sondern **er und sein ganzer Ast**. Ein Umzug von drei Ebenen mit fünf Punkten und vier Sprachen sind zwanzig Registrierungen.
- **Der Wert lässt sich unmittelbar danach zurückschreiben** (`Re-register right after the move: yes`). Die Reparatur ist damit bewiesen, nicht gehofft: Digest nach dem Schreibvorgang frisch lesen, `translationsRegister`, Echo prüfen.

Daraus folgt die Form von Schritt 8 in §4: Die betroffene Menge ist **jeder umgehängte Punkt VEREINIGT mit allen seinen Nachkommen**, nicht nur der gezogene. Sie wird VOR dem Schreibvorgang aus dem Live-Sweep gesichert (nicht aus `ContentTranslation` — ein Shop, der in Shopifys Editor übersetzt hat, hat Werte, die diese App nie geschrieben hat) und danach zurückgeschrieben.

### 2.6 Trägt ein Menüpunkt eine MARKT-spezifische Übersetzung? — **JA, und der Umzug nimmt sie mit** (gemessen)

| Frage | Antwort |
|---|---|
| Lässt sich eine markt-spezifische Übersetzung auf einem Menüpunkt speichern? | **ja** (Markt „European Union", Locale `de`) |
| Zeigt die GLOBALE Lesung sie? | **nein** — es sind wirklich zwei Ebenen |
| Übersteht sie das Umhängen? | **nein**, genau wie die globale |
| Lässt sie sich danach zurückschreiben? | **ja** |

Damit ist die unbequeme Variante eingetreten: **die Reparatur des Editors muss jeden Markt abdecken, nicht nur die globale Ebene.** Und weil diese App die Marktebene auf Menüs heute überhaupt nicht liest, ist das nicht nur mehr Schreiben, sondern zuerst mehr **Lesen**.

Die Kosten bleiben trotzdem beherrschbar, weil `translationsRegister` eine LISTE nimmt: pro betroffenem Punkt genügt **ein** Lesevorgang (frischer Digest) und **ein** Register-Aufruf, der alle (Sprache, Markt)-Paare auf einmal trägt. Ein Ast aus fünf Punkten kostet also fünf plus fünf Aufrufe, nicht fünf mal Sprachen mal Märkte.

**Zwei Folgen, die nicht im Editor liegen und trotzdem hierher gehören:**

1. Der heutige Purge nach einer Umbenennung räumt **nur die globale Ebene** ab (`marketId: ""`). Hat ein Händler in Shopifys Editor eine markt-spezifische Menü-Übersetzung gesetzt, bleibt sie nach einer Umbenennung stehen und der Storefront serviert in diesem Markt weiter den alten Wortlaut. Das ist die konservative Richtung (nichts wird gelöscht, was wir nicht lesen), aber es ist eine Lücke und keine Absicht — vermerkt, nicht versteckt.
2. Der Dateikopf von `app.menus.tsx` sagt, markt-spezifisches Verhalten sei ungemessen. **Die Speicherung ist es jetzt nicht mehr** — sie funktioniert und ist von der globalen getrennt. Ungemessen bleibt allein, ob die Storefront eine Menü-Übersetzung überhaupt ausliefert; das gilt für die globale Ebene genauso.

---

## 3. Architektur: drei Bäume, kein Operationslog

Der naheliegende Entwurf ist, die Arbeit des Händlers als Operationsliste aufzuzeichnen (`move(id, parent, index)`, `rename(id, title)`, …). Das braucht es **nicht**, und es kostet eine zweite Wahrheit neben dem Zustand.

Es reichen drei Bäume:

| Baum | Woher | Wofür |
|---|---|---|
| **BASIS** | der Ladevorgang | Vergleichsgrundlage, unveränderlich |
| **MEINER** | der Editor-State | was geschrieben werden soll |
| **IHRER** | der frische Lesevorgang beim Speichern | was Shopify jetzt hat |

Daraus ist alles ableitbar, was der Editor braucht:

- **Die Änderungsliste** (BASIS → MEINER), nach ID verglichen: umbenannt, verschoben, gelöscht, neu, umgezielt. Das ist die Zusammenfassung über dem Speichern-Knopf und zugleich die Löschbestätigung.
- **Die Drift** (BASIS → IHRER). Ist sie leer, wird geschrieben wie heute.
- **Die Zusammenführung**, wenn beide nicht leer sind: MEINE Änderungen auf IHREN Baum anwenden. Ein echter Konflikt ist nur, wo dieselbe ID auf beiden Seiten berührt ist — und der wird **benannt**, nicht aufgelöst („Dieser Punkt wurde in Shopify umbenannt, während du ihn hier verschoben hast").

Das ist bewusst dieselbe Grundhaltung wie im heutigen Schreibweg, nur eine Stufe reicher: Was wir nicht verstehen, fassen wir nicht an; was wir nicht zusammenführen können, entscheidet der Händler.

**Was NICHT zusammengeführt wird:** ein Baum, in dem eine ID auftaucht, die BASIS nicht kannte und die auch nicht neu ist (kann nicht vorkommen — dann stimmt eine Annahme nicht, und die Absage ist die richtige Antwort).

---

## 4. Der Schreibweg, umgebaut

`saveMenuItemTitles` wird zu `saveMenuTree`. Was **bleibt**, ist jede Schiene, die heute schon da ist; was sich ändert, ist die Herkunft des Baums.

```
1. Frisch lesen (unverändert, inkl. resourceId/url/tags/type)
2. Drift bestimmen (BASIS vs. IHRER) statt nur Fingerprint-Vergleich
   -> keine Drift: weiter
   -> Drift ohne Konflikt: zusammenführen, weiter, und im Ergebnis SAGEN, dass zusammengeführt wurde
   -> Konflikt: verweigern, mit der Liste der betroffenen Punkte
3. Den zu schreibenden Baum bauen:
   - bekannter Punkt: Felder aus IHREM Baum, Titel/Position/Elternteil aus MEINEM
   - umgezielter Punkt: type/url/resourceId aus MEINEM (das ist die Absicht)
   - neuer Punkt: ohne id, alles aus MEINEM
   - fehlender Punkt: absichtlich weggelassen = gelöscht
4. Vorprüfungen wie heute: Tiefe, leerer Titel, fehlender type — nur jetzt auch
   fuer neue Punkte, und ZUSAETZLICH: ein Ziel, das der type verlangt
5. menuUpdate, Echo pro Punkt, ID-Prüfung pro Position
6. Neue IDs nach Position auf die temporären abbilden und zurückgeben
7. Purge für Punkte mit geändertem Primärtitel (unverändert)
8. **Übersetzungen der umgehängten Punkte UND IHRER NACHKOMMEN neu
   registrieren, auf JEDER Ebene** (§2.5, §2.6): Shopify löscht sie beim
   Elternwechsel, obwohl die ID bleibt; ein mitgezogenes Kind trifft es
   genauso, und die markt-spezifische Ebene ebenfalls. Vorher gesichert —
   global aus dem Live-Sweep, markt-spezifisch aus einem eigenen Lesevorgang
   NUR für die betroffene Menge — hinterher mit frischem Digest
   zurückgeschrieben und echo-geprüft. Ein Register-Aufruf pro Punkt trägt alle
   (Sprache, Markt)-Paare, also kostet ein Ast aus fünf Punkten zehn Aufrufe
   und nicht fünf mal Sprachen mal Märkte. Was nicht bestätigt zurückkommt, ist
   ein Fehler PRO PUNKT — der Umbau selbst steht bereits und wird nicht
   zurückgerollt.
9. Löschungen: lokale Übersetzungszeilen der entfernten Punkte weg
```

Schritt 6 ist der einzige wirklich neue Mechanismus, und er ist der Grund für Schritt 5s Positionsvergleich: Wir haben den Baum selbst geschickt, kennen also die Position jedes neuen Punkts und lesen seine ID an genau dieser Stelle aus der Antwort.

### 4.1 Zweiphasiges Speichern (weil eine Übersetzung eine ID braucht)

Ein neu angelegter Punkt hat vor dem Schreiben keine MenuItem-ID und damit keine Link-GID. Seine Übersetzung kann also nicht im selben Zug geschrieben werden wie sein Titel. Der Speichervorgang wird:

1. `menuUpdate` (Struktur + Primärtitel) → liefert die neuen IDs
2. Digest-Sweep (liest die **neuen** Titel, wie heute)
3. `translationsRegister` pro geänderter Übersetzung — jetzt auch für die frisch entstandenen Punkte

Die Reihenfolge ist dieselbe wie heute und aus demselben Grund: Erst umbenennen, dann übersetzen, damit der Purge nicht die Übersetzung frisst, die im selben Speichervorgang getippt wurde.

**Fehlerbild:** „Punkt angelegt, Übersetzung fehlgeschlagen" ist ein Teilerfolg und muss auch so gemeldet werden — pro Punkt, wie heute pro Zelle. Was **nicht** passieren darf: die Struktur zurückrollen, weil eine Übersetzung scheiterte. `menuUpdate` ist atomar, ein Rollback wäre ein zweiter Schreibvorgang mit eigenem Risiko.

---

## 5. Das UI: ein flacher Baum mit dnd-kit

`@dnd-kit/core` + `/sortable` sind bereits Abhängigkeiten und im Image-Manager sowie im `VariantOptionsEditor` in Gebrauch — also derselbe Stack, dieselben Sensoren, kein zweites Muster.

dnd-kit hat keinen Baum. Das etablierte Vorgehen (und das der offiziellen `SortableTree`-Vorlage):

1. **Flach machen.** Der Baum wird zu einer linearen Liste `{id, parentId, depth, index}`. Gerendert wird die Liste; die Verschachtelung ist nur ein `padding-left` pro Tiefe.
2. **`SortableContext`** über die flache Liste mit `verticalListSortingStrategy`.
3. **Beim Drag-Start** werden die Nachkommen des gezogenen Punkts aus der Liste entfernt (der Ast klappt ein). Das ist nicht Kosmetik: es macht es unmöglich, einen Punkt in seinen eigenen Nachkommen fallen zu lassen — der Fall existiert dann gar nicht.
4. **Beim Drag-Move** wird die Ziel-Tiefe aus dem **horizontalen** Versatz projiziert (`delta.x / einrückungsbreite`), geklemmt zwischen der Tiefe des Nachfolgers und `Tiefe des Vorgängers + 1` — und zusätzlich gegen die in §2.3 gemessene Höchsttiefe.
5. **Beim Drop** wird die flache Liste wieder zum Baum.
6. `measuring: { droppable: { strategy: MeasuringStrategy.Always } }`, weil sich die Listenhöhe beim Einklappen ändert und dnd-kit sonst mit veralteten Rechtecken rechnet.

**Tastatur:** `KeyboardSensor` mit eigenem `coordinateGetter` — die Vorlage liefert einen, der links/rechts als Ein- und Ausrücken interpretiert. Ein Baum, der nur mit der Maus bedienbar ist, fällt bei „Built for Shopify" durch.

**Was der Drag NICHT darf:** über die gemessene Höchsttiefe hinaus einrücken (die Projektion klemmt, statt den Server ablehnen zu lassen), und einen Punkt aus einem Menü in ein anderes ziehen (zwei `menuUpdate`s, zwei Fehlerbilder, und ein Punkt, der in beiden oder keinem landet — bewusst nicht angeboten).

---

## 6. Was hier NICHT das Problem ist: die Sprachleiste

Ein früherer Entwurf schlug zwei Spalten pro Zeile vor (Primärtitel links, Übersetzung rechts). **Verworfen, auf Ansage des Eigentümers:** das Umschalten zwischen Sprachen INNERHALB dieser App ist gewollt und gut so. Das Hin-und-Her, das dieser Plan beseitigt, ist das zwischen dieser App und der Shopify-Oberfläche — also genau die Operationen in §5, §7, §8 und §9, für die man heute den Shopify-Admin öffnen muss.

Die Sprachleiste bleibt also, wie sie ist: sie schaltet die Seite auf eine Sprache, die Struktur ist auf jeder Sprache dieselbe. Zwei Folgen für den Editor:

- **Umbauen ist sprachunabhängig.** Ziehen, Anlegen und Löschen dürfen auf JEDER Sprache möglich sein — die Reihenfolge eines Menüs ist keine Eigenschaft der Sprache. Was nur auf der Hauptsprache geht, bleibt das Umbenennen des Primärtitels; auf einer Fremdsprache ist dasselbe Feld die Übersetzung.
- **Die Sperre aus dem Review bleibt nötig.** Solange Primärtitel und Übersetzung nicht in derselben Zeile stehen, kann ein Händler umbenennen, die Sprache wechseln und übersetzen, ohne gespeichert zu haben — mit dem alten Text als Quelle und einem Purge, der das Ergebnis gleich wieder löscht. Die Sperre greift bereits sprachübergreifend (Review-Befund 1).

---

## 7. Löschen

Löschen ist hier die gefährlichste Operation, weil es ein Weglassen ist: kein eigener Aufruf, keine eigene Bestätigung von Shopify.

- Der Punkt verschwindet aus der Liste **mit seinem Ast** — und die Bestätigung nennt beides („3 Punkte, davon 2 Unterpunkte") plus die Zahl der betroffenen Übersetzungen.
- Bestätigt wird **beim Speichern**, nicht beim Klick: bis dahin ist es ein Zustand im Editor und mit Verwerfen zurückzuholen. Ein Modal pro Klick macht das Umbauen unbenutzbar.
- Nach §2.1/§2.4: Wenn eine neu angelegte ID nicht die alte ist, ist Löschen **nicht** durch Wiederanlegen reparierbar. Das gehört in den Warntext, sobald es gemessen ist — und nur dann.

---

## 8. Ziel eines Punkts ändern

13 gemessene Typen (`FRONTPAGE, COLLECTION, COLLECTIONS, PRODUCT, CATALOG, PAGE, BLOG, ARTICLE, SEARCH, SHOP_POLICY, HTTP, METAOBJECT, CUSTOMER_ACCOUNT_PAGE`). Drei Klassen:

| Klasse | Eingabe | Bestand |
|---|---|---|
| freie URL (`HTTP`) | Textfeld | trivial |
| zielloser Typ (`FRONTPAGE`, `SEARCH`, `CATALOG`, `COLLECTIONS`, `CUSTOMER_ACCOUNT_PAGE`) | nur Typwahl | trivial |
| ressourcengebunden (`PRODUCT`, `COLLECTION`, `PAGE`, `BLOG`, `ARTICLE`, `SHOP_POLICY`, `METAOBJECT`) | Ressourcen-Picker | die eigentliche Arbeit |

Für die dritte Klasse existieren im Repo bereits Auswahlmuster (`ChipCombobox`, der Collection-Picker, `TaxonomyValuePicker`), aber kein generischer „wähle eine Ressource dieses Typs"-Picker. Der ist der Aufwandsschwerpunkt dieser Phase — und der Grund, warum sie **zuletzt** kommt: Umsortieren und Umbenennen liefern den Großteil des Nutzens, Umzielen ist der seltenste Vorgang.

Bis dahin gilt für einen Typ ohne Picker dieselbe Regel wie bei den Metaobjekt-Feldern: **benennen, nicht verschweigen** — die Zeile zeigt Typ und Ziel als Text und sagt, dass es im Shopify-Admin geändert wird.

---

## 9. Das Menü selbst

- **Titel:** editierbar. `menuUpdate` verlangt ihn ohnehin bei jedem Aufruf, der Schreibweg reicht ihn heute nur unverändert durch.
- **Handle:** **nicht** ohne Warnung. Ein Theme referenziert ein Menü über den Handle (`main-menu`, `footer`); ihn zu ändern hängt das Menü lautlos aus der Storefront aus, und diese App bearbeitet den Theme-Code des Händlers nicht (CLAUDE.md). Vorschlag: anzeigen, editierbar hinter einer Bestätigung, die die Folge benennt — und, weil wir Theme-Dateien LESEN dürfen, mit einer Suche nach dem Handle im veröffentlichten Theme. Findet sie ihn, nennt die Warnung die Datei. Findet sie nichts, sagt sie „nicht gefunden", niemals „wird nicht verwendet" (der `translatableContent`-Trap in einer anderen Kleiderordnung).
- **Neues Menü anlegen / Menü löschen:** `menuCreate`/`menuDelete` sind gemessen (die Sonde benutzt beide). Klein, aber eigene Phase — ein gelöschtes Menü nimmt jede Übersetzung seiner Punkte mit.

---

## 10. Phasen

| Phase | Inhalt | Warum in dieser Reihenfolge |
|---|---|---|
| **0** | Sonde um §2.1–§2.4 erweitern, einmal laufen lassen | §2.1 kann den Rest umwerfen |
| **1** | Drei-Bäume-Diff + `saveMenuTree` mit **Reihenfolge und Verschachtelung**; Editor-UI mit dnd-kit; Änderungsliste über dem Speichern | größter Nutzen, keine neuen Eingabemasken |
| **2** | Anlegen und Löschen, inkl. zweiphasigem Speichern (§4.1) | braucht die ID-Zuordnung aus Phase 1 |
| **3** | Ziel ändern (Ressourcen-Picker) | größter Aufwand, geringste Häufigkeit |
| **4** | Menütitel, Handle mit Theme-Prüfung, Menü anlegen/löschen | unabhängig, jederzeit einschiebbar |

Nach Phase 2 muss ein Händler den Shopify-Admin für ein Menü nicht mehr öffnen, außer um ein Ziel umzuhängen. Das ist die Schwelle, auf die es ankommt.

---

## 11. Was den Plan kippen würde

1. ~~IDs wandern beim Verschieben~~ — **gemessen, sie bleiben** (§2.1).
2. ~~Shopify nimmt keine vierte Ebene~~ — **gemessen, genau drei** (§2.3). Die Drag-Projektion klemmt bei 3.
3. ~~`url` bei ziellosen Typen wird abgelehnt~~ — **gemessen, wird angenommen** (Review-Befund 3 erledigt).
4. ~~Das Umhängen löscht die Übersetzung unwiederbringlich~~ — **gemessen: sie lässt sich sofort zurückschreiben** (§2.5), und das gilt auch für die markt-spezifische Ebene (§2.6). Kein Kipppunkt, sondern Schritt 8 des Schreibwegs — der dafür aber die Marktebene LESEN muss, was diese App auf Menüs bisher nirgends tut.
5. **Zwei Menüs, ein Punkt.** Sollte je der Wunsch aufkommen, Punkte zwischen Menüs zu ziehen: zwei Mutationen ohne gemeinsame Transaktion. Bewusst außerhalb.
