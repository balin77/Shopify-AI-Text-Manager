# Andere Bilder je Sprache — Plan

**Status:** **Phase 0, 1a und 1b ausgeliefert (2026-10-02)** (Umfang per Owner-Entscheid 2026-09-30). Phase 2 ist nur VORBEREITET (Datenfelder, Veraltet-Erkennung), nicht gebaut. Roadmap-Einträge `localized-images` und `image-translation` in [roadmap.server.ts](../../app/config/roadmap.server.ts). Theme-Bilder: Schreibweg **gemessen** (Probe Phase 0, Live-Shop 2026-10-02, API 2026-07) — Bildeinstellungen sind übersetzbar, Register/Lesen/Entfernen klappt global und pro Markt. Ob der Shop ein anderes Bild tatsächlich ausliefert, ist weiter nur Changelog-Aussage.

## Owner-Entscheide (2026-09-30)

| Frage | Entscheid |
|---|---|
| Nur Sprache oder auch Markt? | **Auch pro Markt.** Ein Markt-Eintrag schlägt den Eintrag „alle Märkte“ derselben Sprache. |
| Welche Ressourcen? | **Nur Produkte und Theme.** Kollektionen/Artikel später. |
| Wo im Storefront? | Produktseite (Galerie, Thumbnails, Lightbox-Links) + `og:image` + JSON-LD. Keine Kollektionskacheln, kein Warenkorb. |
| 1:1 oder mehr? | **Nur 1:1-Ersatz.** Kein Ausblenden, keine zusätzlichen Bilder. |
| Umfang jetzt | Phase 0, 1a, 1b umsetzen; Phase 2 nur vorbereiten. |
| Wo im Editor (2026-10-01, zweite Fassung) | **Keine eigene Karte und kein Panel.** In der Hauptsprache gibt es nichts Besonderes. In einer Fremdsprache wählt der Händler ein Bild (oder Video) in der Produktgalerie an und sieht EINEN zusätzlichen Button: „Ersatzbild hochladen“ (Video: „Ersatzvideo hochladen“, YouTube/Vimeo: „Ersatzlink eingeben“), nach Wahl auch „… entfernen“. Die Wahl ist ein **Entwurf**: Sie wird erst mit dem Speichern-Dialog des Editors (der eine Speicherleiste) geschrieben; Bestätigung bzw. Fehler stehen in der InfoBox. Die Kachel zeigt anstelle des Originals das Ersatzbild, mit dem runden Symbol (violett = Ersatz wird gezeigt, grau = Original wird gezeigt); ein Klick auf das Symbol schaltet zwischen Ersatz und Original um (nur Ansicht). Sprache und Markt sind die des Editors. Gilt in beiden Galerien (Image Manager und einfache Galerie), nur nach Tarif. Wird das Original in der App gelöscht, werden alle seine Ersatzeinträge (jede Sprache, jeder Markt) mit entfernt. |

**Frage:** Kann ein Händler pro Sprache (und ggf. pro Markt) andere Bilder zeigen, wie es die Konkurrenz anbietet? Und später: kann die KI den Text in einem Bild übersetzen und ein neues Bild erzeugen?

**Antwort:** Ja, in zwei Hälften mit unterschiedlicher Plattform-Unterstützung.

---

## 1. Was Shopify nativ kann

| Bildtyp | Pro Sprache nativ? | Quelle / Status |
|---|---|---|
| Theme-Bilder (`image_picker` in Sektionen, JSON-Templates) | **Ja**, pro Sprache **und** pro Markt, über `translationsRegister`; Wert `shopify://shop_images/<datei>` | Shopify-Changelog „Online store media localizable to different languages/markets“; **gemessen 2026-10-02** (Probe): als übersetzbar gemeldet (u. a. `general.logo`, Slideshow-Bilder in JSON-Templates), Register mit Echo, Rücklesen und Entfernen global und mit `marketId` bestätigt. Die Auslieferung eines ANDEREN Bildes im Shop ist nicht gemessen (die Probe schreibt das eigene Bild). |
| Produktmedien / Galerie | **Nein** | `MediaImage` trägt nur den Schlüssel `alt` (gemessen, siehe CLAUDE.md „Image rows“); Translate & Adapt kann es ebenfalls nicht |
| Kollektions-/Artikelbild | **Nein**, nur `alt` | gemessen 2026-08 (CLAUDE.md) |
| `file_reference`-Metafelder | Laut Drittquellen **nein** (nur Text-Metafelder) | widersprüchliche Quellen — **messen** |

Die Konkurrenz (EZ Product Image Translate, LangShop, Transcy) tauscht Produktbilder im Storefront per Script aus.

## 2. Ist-Zustand im Code

- **Theme-Sync** ([background-sync.service.ts](../../app/services/background-sync.service.ts)) liest alle übersetzbaren Theme-Schlüssel ohne Filter nach Werttyp. Bildwerte, falls Shopify sie liefert, landen als normale Textfelder im Theme-Editor.
- **Mögliches Risiko heute:** [templates-translate-all.action.ts](../../app/actions/templates/templates-translate-all.action.ts) schickt jeden nicht-leeren Wert an die KI. `survivesValuePrompt` lässt eine `shopify://…`-URL durch. Liefert Shopify Bildwerte als übersetzbare Schlüssel, würde „Alles übersetzen“ Bildreferenzen von der KI umschreiben lassen. **In Phase 0 prüfen, ggf. sofort absichern.**
- **Resolver-Vorlage:** [app.seo.structured-data.tsx](../../app/routes/app.seo.structured-data.tsx) löst `shopify://shop_images/<datei>` (Logo) zu einer Datei auf.
- **Dateiauswahl:** `FilePickerModal` (Bibliothek + Staged Upload), wiederverwendet von `MetaobjectFileField`.
- **Storefront-Galerie:** [variant-gallery-embed.liquid](../../extensions/storefront/blocks/variant-gallery-embed.liquid) + `assets/variant-gallery-embed.js` blendet die native Galerie aus und rendert eine eigene, auch beim Variantenwechsel. Die Galerie verzweigt heute nicht nach Sprache.
- **`og:image` und JSON-LD** kommen aus unseren Blöcken (`social-meta.liquid`, `structured-data.liquid`).
- **Bildgenerierung:** keine im Code. Nur die Alt-Text-Vision (`generateImageAltText`, `vision-policy.shared.ts`). Roadmap: `image-generation`, `ad-suite` — eine gemeinsame Plumbing, eigener Key des Händlers, Anbieter austauschbar.
- **Scopes:** `read_files`/`write_files`, Metaobjekt-Definitionen und Metafelder sind vorhanden. **Keine neue Berechtigung, keine erneute Zustimmung nötig.**

## 3. Phasen

### Phase 0 — Messen (Probe unter Settings → Probes → Translation)

1. Kommen `image_picker`-Werte aus Sektionen und JSON-Templates als übersetzbare Schlüssel? In welchem Wertformat, mit welchem Schlüssel-Muster?
2. Wird `translationsRegister` mit einem anderen `shopify://shop_images/…` angenommen, per Echo bestätigt und im Storefront ausgeliefert? Auch mit `marketId`?
3. Ist ein `file_reference`-Metafeld übersetzbar (mit gefülltem Wert messen — Leerwert-Falle)?
4. Falls (1) ja: KI-Sperre für Bildwerte in allen Theme-Übersetzungspfaden (translate-all, translate-field, stale repair via `survivesValuePrompt`) sofort einbauen.

### Phase 1a — Theme-Bilder pro Sprache (nativ)

- Bildwerte im Theme-Editor erkennen und als Vorschaubild mit „Bild für diese Sprache wählen / zurücksetzen“ darstellen statt als Textbox.
- Schreiben über den bestehenden Theme-Speicherpfad, Echo-Regel, DB-Spiegel in `ThemeTranslation`.
- Nie an die KI.
- Markt-Ebene wie bei Theme-Texten.

### Umgesetztes Design (Stand dieser Umsetzung)

**Gemeinsam:** Ein Bildwert ist ein Wert, den die KI NIE sieht — `isThemeImageReference` ([theme-image-reference.shared.ts](../../app/utils/theme-image-reference.shared.ts)) ist das eine Prädikat, das jeder KI-Pfad fragt.

**Phase 0:** Probe (`kind=themeImage` von `api.translation-probe.tsx`, Logik in `services/localized-media/theme-image-probe.server.ts`; Settings → Probes → Translation). Liest die gecachten Theme-Zeilen, zählt Bildwerte je Ressourcentyp, prüft an EINER Stichprobe live, ob Shopify den Schlüssel mit Digest als übersetzbar meldet, und schreibt optional (Bestätigung) den unveränderten Primärwert als Übersetzung in einer Sprache, die dort nichts hält — Echo, frische Lesung, Entfernung mit Echo; dasselbe mit `marketId`. Keine sichtbare Änderung im Shop, weil das Bild dasselbe bleibt, und keine überschriebene Übersetzung, weil nur ein leerer Platz verwendet wird.

**Phase 1a (Theme):** `templates-field-factory` erkennt Bildwerte und gibt ihnen den Feldtyp `themeImage` ohne KI- und Übersetzungsknöpfe. Das Feld zeigt Vorschau und Dateiname, in einer Fremdsprache „Bild für diese Sprache/diesen Markt wählen“ (Bibliothek oder Upload über den bestehenden Datei-Dialog) und „Zurücksetzen“. Gespeichert wird über den bestehenden Theme-Speicherpfad (`translationsRegister` mit Echo, Markt über `marketId`, Spiegel in `ThemeTranslation`) — der Wert ist einfach `shopify://shop_images/<datei>`. Vollständigkeitsprüfung zählt Bildwerte nicht als „fehlende Übersetzung“.

**Phase 1b (Produkte):** Speicherort ist das Produkt-Metafeld `custom.localized_media` (json) — die EINE Quelle, kein DB-Spiegel, weil der Plan-Cache-Cleanup Produkte aus der DB löschen darf und die Ersatzbilder dann lokal verschwunden, im Shop aber aktiv wären. Eintrag: `o` Original-Dateiname (Schlüssel für Storefront), `m` Original-MediaImage-GID, `l` Sprache (klein), `k` numerische Markt-ID oder `""`, `u` Ersatz-CDN-URL, `f` Ersatz-File-GID, `a` Herkunft (`manual`/`ai`), `s` Quell-Stempel (Original-URL beim Setzen), `t` Zeitpunkt. Schreiben = Lesen-Ändern-Schreiben mit `metafieldsSet`, bestätigt nur durch das Echo; leere Liste = `metafieldsDelete`. Dateiname und URL werden vor dem Schreiben validiert, weil beide im Storefront in CSS-Selektor und JSON landen. Storefront: App-Embed `localized-media` (Prehide-CSS vor dem ersten Paint, Tausch per `assets/localized-media.js`, MutationObserver für nachgeladene Galerien) und `snippets/cp-localized-image.liquid` für `og:image` und das JSON-LD-Bildarray.

**Phase-2-Vorbereitung:** Herkunft `a` und Quell-Stempel `s` sind ab dem ersten Eintrag gesetzt; der Editor zeigt „Original wurde geändert“, wenn die aktuelle URL des Originals vom Stempel abweicht, und „Original nicht mehr vorhanden“ für Einträge, deren Medium fehlt. Die Schreibfunktion nimmt `origin` als Parameter — die KI-Bildübersetzung ruft später dieselbe Funktion mit `origin: "ai"`.

**Bekannte Grenzen:** vollständig gelistet in §4 „Nicht abgedeckte Fälle“.

### Phase 1b — Produktbilder pro Sprache (über unsere Galerie)

- **Datenmodell:** App-eigener Metaobjekt-Typ „lokalisiertes Bild“ mit Sprache, optionalem Markt, Originalmedium, Ersatzbild (`file_reference`), **Herkunft** (manuell/KI) und **Quell-Stempel** (Originaldatei + Stand). Referenziert vom Produkt über ein Metafeld. Liquid bekommt das Ersatzbild als echtes Bildobjekt, sodass `image_url` mit den bestehenden Breiten funktioniert.
- **Storefront:** Die JSON-Datenbasis der Galerie wird nach `request.locale` (und ggf. Markt) umgeschrieben. Logik in `assets/`, nicht in `blocks/` — das Liquid-Budget von 100 KiB ist knapp.
- **Server-seitig:** `og:image` und JSON-LD-Produktbild nutzen das Sprachbild. Reines Liquid, ohne Flackern, gut für SEO — ein Vorteil gegenüber reinem JS-Tausch.
- **Image Manager:** ~~pro Bild ein Sprach-Umschalter, Übersicht „Sprache X: n Ersatzbilder“~~ — ersetzt durch den Owner-Entscheid vom 2026-10-01, in zweiter Fassung vom selben Tag auf die schlanke Form gekürzt (siehe Tabelle oben): kein Umschalter, keine Karte, kein Panel. Fremdsprache aktiv + Bild angewählt ⇒ ein Button „Ersatzbild hochladen“ neben den Alt-Text-Bedienelementen (Datei-Dialog bzw. Link-Dialog für YouTube/Vimeo); die Wahl wird ein Entwurf (Schlüssel: Medium, Sprache, Markt), den die eine Speicherleiste des Editors schreibt (`LocalizedMediaSaveBridge` meldet sich über `CommerceSaveContext` an, das jetzt mehrere Anmelder kennt); Bestätigung/Fehler in der InfoBox, bei Teilfehlern mit Namen der betroffenen Medien, deren Entwürfe bleiben. Die Kachel zeigt das Ersatzbild an der Stelle des Originals (Entwürfe wie Gespeichertes), das Eck-Symbol schaltet pro Medium zwischen Ersatz und Original um (Symbol-Farbe zeigt, was zu sehen ist); Reorder/Drag/Löschen/Alt-Text wirken weiter auf das Original. Verwaiste Einträge: kompakte Warnung nur wenn welche existieren, Entfernen ebenfalls als Entwurf. Beim Löschen eines Originals räumt `api.delete-product-images` die Einträge dieses Mediums mit auf (`removeEntriesForDeletedMedia`, Echo-bestätigt, scheitert nie das Löschen). Umsetzung: `LocalizedMediaContext` + `useLocalizedMedia` + `LocalizedMediaReplaceButton` unter `app/components/localized-images/`; die Server-Aktionen (`localizedMediaLoad`/`Set`/`Remove`) blieben unverändert.
- **Grenzen offen benennen:** Kanal-Feeds (Google, Shop-App, KI-Kanäle) zeigen weiter das Originalbild. Wirkt nur mit aktivem App-Embed.

### Phase 2 — KI-Bildübersetzung (`image-translation`, mit der Bildgenerierung)

1. Vision-Vorprüfung: Ist überhaupt Text im Bild? Nur dann anbieten.
2. Bild-Edit mit Zielsprache und Glossar.
3. Vorschau, **Freigabe durch den Händler**. Nie unbeaufsichtigt: Preise, Größen, Logos und Rechtstexte im Bild sind genau das, was ein Modell falsch macht.
4. Staged Upload, als Ersatzbild der Sprache eintragen (`origin: ai`).
5. Wird das Original ersetzt, gilt das übersetzte Bild über den Quell-Stempel als veraltet.

## 4. Nicht abgedeckte Fälle (bewusst, Stand 2026-10-01)

Videos: die Punkte 21–26 am Ende gelten zusätzlich nur für Videos.

Damit niemand annimmt, was nicht gebaut ist. Jeder Punkt sagt, was der Händler sieht.

**Wo das Ersatzbild NICHT erscheint**
1. **Produktkacheln** auf Kollektions-, Such- und Startseite, im Warenkorb, in Mini-Carts, Quick-View-Dialogen und „Ähnliche Produkte“-Blöcken: zeigen das Original. Das Embed tauscht nur auf der Produktseite, weil nur dort die Ersatzliste des Produkts im Seitenkopf steht.
2. **Kanal-Feeds** (Google Shopping, Shop-App, Facebook/Instagram, KI-Kanäle) und die **Bestellbestätigung/E-Mails**: lesen die nativen Produktmedien, nie unser Metafeld.
3. **Ohne aktiviertes App-Embed „Images per language“**: im Shop kein Tausch. `og:image` und JSON-LD werden trotzdem ersetzt, sofern deren eigene Embeds aktiv sind — Galerie und Teilen-Bild können sich dann unterscheiden.
4. **Bilder, die ein Theme als CSS-Hintergrund** (`background-image`) oder in einem `<canvas>` zeichnet, und **Zoom-/Lightbox-Skripte**, die die Bild-URL aus einem eigenen JavaScript-Objekt statt aus dem DOM lesen: werden nicht erkannt.
5. **Bilder fremder Hosts** (Bild-CDNs anderer Apps, Page-Builder mit eigenem CDN): bewusst nicht angefasst — nur Shopify-Bild-URLs werden getauscht.

**Was der Händler nicht tun kann**
6. **Nur 1:1-Ersatz.** Kein Ausblenden eines Bildes in einer Sprache, keine zusätzlichen Bilder, keine andere Reihenfolge.
7. **Nur Produkte und Theme.** Kollektionsbild, Artikel-/Blogbild, Seitenbilder, Varianten-Galeriebilder als eigene Einheit (sie werden nur getauscht, wenn sie dieselbe Datei wie ein ersetztes Produktbild sind; im Bild-Manager zeigen und setzen die Variantengalerien genau diesen Ersatz des Produktmediums, siehe 11d), Metaobjekt-Dateifelder und Bilder in Rich-Text-Beschreibungen sind nicht abgedeckt.
8. **Kein Ersatzbild, das selbst ein Bild desselben Produkts ist** (keine Ketten/Zyklen).
9. **Videos nur Art für Art, 3D-Modelle gar nicht** (§7). Ein Bild ersetzt ein Bild, ein in Shopify hochgeladenes Video ein hochgeladenes Video, ein YouTube-/Vimeo-Video ein YouTube-/Vimeo-Video (YouTube ↔ Vimeo geht). Ein Bild durch ein Video oder ein hochgeladenes Video durch YouTube zu ersetzen geht NICHT: der Tausch schreibt Adressen in das Element, das das Theme gezeichnet hat (`<img>`, `<video>`, `<iframe>`), und kann aus dem einen nicht das andere machen. 3D-Modelle werden nicht ersetzt (`<model-viewer>`, eigene Hülle je Theme).
10. **Keine Massenpflege**: keine Spalte im Bulk-Editor, kein CSV-Import/-Export der Ersatzbilder, kein „für alle Sprachen dasselbe Bild“.
11. **Höchstens 200 Ersatzbild-Einträge pro Produkt** (alle Sprachen × Märkte zusammen), weil alle Einträge im Seitenkopf mitgeliefert werden.
11a. **WebP-Umwandlung schlüsselt Ersatzbilder um (gelöst, 2026-10-01).** Der Umwandlungs-Worker (`webp-processor.service.js`) legt ein neues MediaImage an und löscht das alte. Nach Auflösung der neuen CDN-URL liest `localized-media-rekey.js` einmal `custom.localized_media` und schreibt nur die Bild-Einträge mit `m` = alte GID um (`m` neue GID, `o` neuer Dateiname, `s` neue Bild-URL); alles andere bleibt unverändert, fremde Werte bleiben unberührt, ohne Einträge gibt es keinen Schreibzugriff. Dateiname mit der JS-Kopie von `isSafeFilename` geprüft (Paritätstest), Schreiben per `metafieldsSet`, bestätigt durch das Echo. Scheitert ein Schritt, bleibt die Umwandlung gültig und die Einträge bleiben Waisen („Ersatzbilder ohne Originalbild“). Offene Restlücke: der Worker serialisiert nur seine eigenen Läufe je Produkt; schreibt der Editor (`localizedMediaSet`/`Remove`, `removeEntriesForDeletedMedia`) zwischen Lesen und Schreiben des Workers, geht dessen Änderung verloren (`compareDigest` ist für 2026-07 nicht bestätigt, das Schema war nicht erreichbar, daher nicht verwendet). Jeder Lauf hat ein eigenes 20-s-Limit ab Start; ein hängender Lauf wird aufgegeben, nicht abgebrochen.
11b. **Löschen und Speichern gleichzeitig (Restlücke).** Wer in einem Tab ein Original löscht, während in einem anderen Ersatz-Entwürfe gespeichert werden, kann einen Eintrag für das gelöschte Medium erzeugen; er erscheint als verwaister Eintrag.
11d. **Variantengalerien im Bild-Manager (2026-10-02):** zeigen das Ersatzbild eines PRODUKTMEDIUMS auf ihrer Kachel (gespeichert oder Entwurf, mit demselben runden Symbol) und bieten für eine einzelne ausgewählte Kachel denselben Ersatz-Button wie „Alle Bilder“ — er schreibt denselben Eintrag (gleiche Medium-GID), beide Galerien sind also gekoppelt, auch der Umschaltzustand des Symbols. NICHT ersetzbar sind Medien, die nur in der Variantengalerie liegen (Bibliotheksdatei, die kein Produktmedium ist) und YouTube-/Vimeo-Links einer Variantengalerie (`custom.variant_external_videos`): der Button ist dort ausgegraut mit eigenem Grund („nur für Bilder, die auch unter Alle Bilder sind“), nie die irreführende „wird noch verarbeitet“-Meldung. 3D-Modelle (in beiden Galerien) bekommen den ausgegrauten Button mit eigenem Grund („3D-Modelle können nicht ersetzt werden“); eine noch nicht gespeicherte Hochladung zeigt gar nichts (wie in „Alle Bilder“). Die Zugehörigkeit entscheidet die vom SERVER gemeldete Medienliste des Produkts (Medien-Map, Produktbilder, eigene noch verarbeitete Medien, Lesung der Live-Medien), nie die clientseitige Meta-Map (eine Bibliotheksauswahl eines anderen Produkts füllt sie vor) und nicht die URL; die GID einer Variantenkachel kommt zuerst aus den eigenen Galerie-Schlüsseln der Variante.
11c. **Entwürfe in der Hauptsprache:** Entwürfe aus einer Fremdsprache bleiben beim Wechsel in die Hauptsprache erhalten; eine unaufdringliche Zeile unter der Galerie nennt die Sprachen mit ungespeicherten Ersatzbildern.

**Was nicht erkannt wird**
12. **Ersatzbild in Shopify „Dateien“ gelöscht**: bleibt im Metafeld, im Shop erscheint ein fehlendes Bild. Nicht erkannt, nicht gemeldet.
13. **Original ersetzt** (neue Datei unter gleichem Medium): wird als „Original wurde geändert“ angezeigt, das Ersatzbild bleibt aber aktiv, bis der Händler handelt.
14. **Original gelöscht**: Ersatzbilder ohne Original werden in der Karte gesondert gelistet und können gelöscht werden; im Shop sind sie wirkungslos.
15. **Sprache aus dem Shop entfernt**: ihre Einträge bleiben im Metafeld (wirkungslos), die Karte zeigt sie nicht mehr in der Sprachauswahl.
16. **Zwei gleichzeitige Bearbeitungen desselben Produkts**: die spätere gewinnt.
17. **Theme-Bilder: Schreibweg gemessen, Auslieferung nicht** (Probe 2026-10-02: übersetzbar, Register/Lesen/Entfernen global und pro Markt JA). Ob der Shop ein anderes Theme-Bild in der Sprache tatsächlich anzeigt, ist nicht gemessen — die Probe schreibt nur das eigene Bild in einen leeren Platz. Am schnellsten prüft es ein echter Versuch im Theme-Editor der App mit Blick auf den Shop.
18. **Theme-Bild in der Marktansicht**: wird dort das geerbte Sprachbild für alle Märkte gezeigt, nimmt „Originalbild verwenden“ nichts weg — es entfernt nur eine eigene Marktwahl.

**Technische Rest-Effekte**
19. Das Original wird vom Browser geladen, bevor es ersetzt wird (Bandbreite, nicht sichtbar dank Vorab-Ausblendung; nach spätestens 3 s wird die Ausblendung in jedem Fall aufgehoben).
20. Ein Upload, den Shopify nicht innerhalb von ~9 s verarbeitet, wird nicht doppelt hochgeladen; der Händler wählt die Datei kurz danach aus der Bibliothek.

**Nur Videos**
21. **Strukturierte Daten**: das `VideoObject` im JSON-LD beschreibt weiter das Original-Video (Inhalt, Vorschaubild, Datum). Nur der Spieler und sein Vorschaubild auf der Seite werden getauscht.
22. **Vimeo-Ersatz (oder Ersatzvideo) ohne Vorschaubild**: Vimeo liefert ohne API-Aufruf kein Vorschaubild; vor dem Abspielen bleibt das Vorschaubild des Originals stehen — auch wenn es Text in der Originalsprache zeigt. Die Karte sagt das beim Eintrag.
23. **Schlüssel eines hochgeladenen Videos NICHT gemessen**: das Video wird im Shop am Hash-Verzeichnis seiner Adressen erkannt (`/videos/c/vp/<hash>/`), abgelesen an der Admin-API, nicht an einem echten Storefront gemessen. Ein Video ohne erkennbaren Schlüssel wird in der Karte gelistet, aber nicht zum Ersetzen angeboten — eine falsche Annahme kostet eine Verweigerung, nie einen falschen Tausch.
24. **Spieler, die ihre Adresse nicht im DOM tragen** (Themes, die Videos per JavaScript-Objekt oder eigenem Player-Skript laden, Vimeo-/YouTube-Widgets anderer Apps): werden nicht erkannt.
25. **Videos in Varianten-Galerien als eigene Einträge** (`custom.variant_external_videos`): nicht abgedeckt; nur Produktmedien.
26. **Hochgeladenes Ersatzvideo**: Shopify verarbeitet Videos länger als die Anlage wartet; der Händler wählt es kurz danach aus der Bibliothek. Theme-Videoeinstellungen (Video-Datei oder YouTube-/Vimeo-Link) bekommen keine Auswahl wie die Bilder, nur ein Textfeld ohne KI — die Schreibweise der Video-Referenz im Theme ist nicht gemessen (die Probe listet sie).
27. **Märkte im Editor**: Der Markt folgt jetzt der Marktauswahl des Editors, und die blendet Märkte aus, deren Sprachen die aktuelle Sprache nicht enthalten — für so einen Markt lässt sich hier kein eigener Ersatz festlegen (nur „Alle Märkte“); bestehende Einträge dafür bleiben im Shop aktiv.

**Behoben (2026-10-01):** Die Karte „Bilder je Sprache“ hing am Bild-Manager und verschwand, wenn dieser in den Einstellungen ausgeschaltet war, während der Shop die Ersatzbilder weiter zeigte. Sie hängt jetzt nur am Tarif und erscheint unter der Bildergalerie des Produkts — mit oder ohne Bild-Manager. Der Storefront-Tausch war nie vom Varianten-Galerie-Embed abhängig: er arbeitet auch auf der nativen Theme-Galerie. Hochladen geht dort über denselben Datei-Dialog wie im Bild-Manager, im Modus „nur Bilder“.

## 7. Videos je Sprache (Owner-Entscheid 2026-10-01, umgesetzt)

Gleiches Modell wie die Bilder: ein Eintrag im Metafeld `custom.localized_media`, 1:1, pro Sprache und optional pro Markt, Markt schlägt „alle Märkte“.

- **Arten:** ein Eintrag trägt `x`: fehlt = Bild, `"v"` = in Shopify hochgeladenes Video, `"e"` = YouTube/Vimeo. Ersetzt wird nur innerhalb derselben Art (Begründung §4.9); der Server prüft das (`kindMismatch`).
- **Erkennung im Shop:** hochgeladenes Video am Hash-Verzeichnis seiner Quell-Adressen (`o`), YouTube/Vimeo als `youtube.<id>`/`vimeo.<id>` aus der Einbettungsadresse; das Vorschaubild des Originals (`p`) wird wie ein Bild getauscht, wenn der Ersatz eines hat (`u`).
- **Tausch:** `<video>` bekommt die Quellen des Ersatzes (`w`), ein `<iframe>` die Einbettungsadresse des Ersatzes (`r`) mit der Abfrage des Themes (autoplay, controls …). Spieler, die das Theme erst beim Klick aus einem `<template>` einsetzt, werden schon im Template umgeschrieben — das Original lädt nie.
- **Auswahl über den Button an der Auswahl (zweite Fassung, vorher Panel):** hochgeladenes Video über denselben Datei-Dialog wie im Bild-Manager (nur Videos), YouTube/Vimeo über ein Link-Feld; Upload eines Videos legt die Datei in Shopify „Dateien“ an.
- **Theme:** Videoeinstellungen (Datei oder YouTube-/Vimeo-Link) werden von der KI ausgenommen und zählen nicht als fehlende Übersetzung; pro Sprache trägt der Händler im Textfeld einen anderen Link bzw. eine andere Referenz ein.
- **Nicht abgedeckt:** §4.21–26.
- **Review-Befunde (2026-10-01), behoben:** Dawn schleift ein YouTube-Video mit `playlist=<Original-ID>` — der Tausch richtet jetzt jeden Parameter, der die Original-ID nennt, auf den Ersatz (sonst lief nach dem Ersatz das Originalvideo). Das Metafeld ist für den Shop UNVERTRAUENSWÜRDIG (jede App mit Metafeld-Zugriff kann es schreiben): das Asset prüft eine Einbettungsadresse erneut gegen die zwei Player-Formen, bevor sie in ein `iframe` kommt, und jede andere Adresse auf `https:`. Der datenschutzfreundliche Host `youtube-nocookie.com` bleibt erhalten. Die Probe misst nur noch Bildeinstellungen (YouTube-Links aus den Social-Media-Einstellungen hätten sonst ein „JA“ zu Bildern vorgetäuscht) und listet Videowerte getrennt. Ein Video wird über das `vp/`-Verzeichnis erkannt (bevorzugt vor `o/v/`), und sein „Original geändert“-Stempel ist der Schlüssel, nicht eine Quell-Adresse, deren Reihenfolge Shopify nicht zusagt.
- **Verhaltensänderung, bewusst:** Ein Metafeld- oder Theme-Wert, der nur ein YouTube-/Vimeo-Link ist, wird von der automatischen Nachübersetzung nicht mehr übersetzt (abgelehnt statt umgeschrieben); bei geändertem Original entscheidet die gespeicherte Löschantwort des Händlers.

## 5. Offene Punkte

1. Plan-Zuordnung: vorerst an denselben Plan-Schalter wie der Bild-Manager gebunden (`variantImageManager`, ab Pro) — der Tarif, nicht die Ein/Aus-Einstellung des Bild-Managers. Mengenbegrenzung: nur die technische (200 Einträge pro Produkt).
2. Kandidaten aus §4, falls gewünscht: Kollektionskacheln/Warenkorb (§4.1), Kollektions-/Artikelbilder (§4.7), Erkennung gelöschter Ersatzdateien (§4.12).

## 6. Quellen

- Shopify Changelog: Online store media localizable to different languages/markets — https://shopify.dev/changelog/online-store-media-localizable-to-different-languages-markets
- Übersetzbare Section-Setting-Typen (inkl. `image_picker`) — https://joeybabcock.me/blog/shopify/shopify-translate-adapt-which-input-types-are-translatable/
- Translate & Adapt übersetzt keine Produktbilder — https://newcraft.dev/posts/shopify-translate-adapt-doesnt-translate-images-heres-what-does/
- Weglot: Grenzen von Translate & Adapt — https://www.weglot.com/blog/shopify-translate-adapt-limitations
- EZ Product Image Translate — https://apps.shopify.com/ez-product-image-translate
