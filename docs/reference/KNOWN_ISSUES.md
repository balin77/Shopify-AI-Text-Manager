# Bekannte und entschiedene Fehler

Stand: 2026-11-03. Punkte, die bewusst nicht gefixt sind. Wer hier etwas fixt, streicht den Eintrag im selben Commit. Wer einen Fehler findet und nicht fixt, trägt ihn hier ein.

Dieses Repo ist öffentlich: Sicherheitsrelevante Details gehören nicht in diese Datei.

## Zu entscheiden

- **Bestehende Doppelungen im Shop.** Hat die Galerie-Liste einer Variante deren Hauptbild noch mit gespeichert (ältere Speicherungen), sehen Kunden das Bild im Shop doppelt, bis die Galerie dieser Variante bearbeitet wird. Beim Öffnen wird nichts mehr bereinigt. Ob sich eine einmalige Bereinigung lohnt, hängt von einer noch offenen Zahl betroffener Produkte ab.
- **Galerie `[Hauptbild]` wird zu `[]`.** Beim Bearbeiten einer solchen Variante (Galerie ändern, Bild einfügen, Hauptbild entfernen) wird die Liste leer, weil das Hauptbild nur noch im Hauptfeld liegt. Der Shop zeigt dann wie bei jeder Variante ohne weitere Bilder den Rückfall (alle Produktbilder). Unbearbeitete Varianten bleiben unberührt.

## Entschieden: bleibt so

- Wird ein Metafeld abgelehnt, werden die anderen Felder desselben Speicherlaufs zurückgesetzt.
- Ein noch nicht gespeicherter, neu getippter Eintrag wird mit dem gesendeten Text angelegt.
- Die eigene Speicher-Ablehnung bei KI und Kopieren bleibt.
- Der Lösch-Knopf für Metafelder fragt nicht nach.
- Nach einem Fehler wird kein Entwurf wiederhergestellt.
- Der Speichern-Knopf bleibt beim gleichen Produkt beschäftigt, bis gespeichert ist. Bei anderen Produkten nicht.
- Pro 429 entsteht eine Log-Zeile. Die Länge ist begrenzt, die Anzahl pro Zeit nicht. Ein Client, der ständig anfragt, kann das Log füllen. Ein Client mit Wiederholung sendet pro Anfrage höchstens dreimal.
- `loader-factory.server.ts:165-180` löscht Sessions bei 401. Hier ist nichts zu tun.

## Bekannt: Speichern und Sperren

- Eine Ablehnung stoppt nur die Karte, nicht Haupt-, Galerie- oder Alt-Speicherungen. Danach kann trotzdem eine grüne Meldung erscheinen.
- Ein erneutes Senden löscht Übersetzungen nochmals, wenn der Wert innerhalb von 10 Minuten neu getippt wird und vom gespeicherten abweicht.
- Die Sperre kann bei vielen Speicherungen länger halten, weil der gemeinsame 20-Sekunden-Timer neu startet.
- Nach einem sehr langsamen Reload (über 20 Sekunden) kann eine Übersetzung noch den alten Text verwenden.
- Eine ausgefüllte, noch nicht gespeicherte Zeile kann selten still verloren gehen: Ausgang unbekannt, Option kurz weg, Schreibvorgang nicht angekommen. Vorschlag: nachträglicher Hinweis.
- Eine leere Zeile bei einer gelöschten Option kann die Leiste kurz wieder einblenden (nur kosmetisch).
- Beim Produktwechsel kommt die Rückfrage selten doppelt.
- Bulk-Editor und andere `METAFIELDS_SET`-Aufrufe laufen ausserhalb der Sperre. Nach 5 Minuten Wartezeit läuft eine Speicherung neben der haltenden.
- Zwei Wechselpfade sind ungeschützt: `useUnifiedContentEditor.ts` bei den Zeilen 588-596 und 674-679.
- Antwortet ein Speichern nach einem Teil-Schreibvorgang mit 4xx oder 5xx, wird nichts neu gelesen. Die Anzeige kann bis zum nächsten Laden alt bleiben.
- Eine gehaltene Seitennavigation oder Neuladung (Seiten-`.data`) ist heute nicht erreichbar: Seiten-`.data`-Abrufe sind praktisch unbegrenzt, nur das Dokument-Laden ist begrenzt. Sollte ein Limiter sie je erfassen, bleibt die Navigation «lädt», bis die nächste sie abbricht (Seite und Eingaben bleiben), und Fetcher warten dann im Zustand «loading».
- Die Wiederholung umhüllt `window.fetch` einmal beim Start, nach App Bridge. Ersetzt App Bridge `window.fetch` später, wird sie still abgeschaltet. Nicht im echten Admin geprüft.
- Der Metaobjekt-Speichern-Pfad antwortet auf eine leere Übermittlung (nichts geändert) mit Erfolg; im Hauptsprachen-Pfad filtert der Server außerdem auf `changedFields`. Ein vom Browser nicht erkannter Unterschied (Änderung in Shopify, die der Editor noch nicht geladen hat) bleibt daher möglich, bis die Daten geladen sind.

## Bekannt: Galerien und Hauptbild

- Auf einem echten Shop passen die `file`-Einträge des Reihenfolge-Pfads in der Einbettung möglicherweise nicht zu den GIDs. Dann würde die gespeicherte Reihenfolge ignoriert (`variant-gallery-embed.liquid:137`), und der Abgleich gegen Doppelte vergleicht Ids, die sich unterscheiden können (`:115-116`, `:186-188`). Braucht eine echte Darstellung zur Prüfung.
- Rückt ein Bild nach, das nicht zu den Medien des Produkts gehört, würde Shopify den ganzen Speichervorgang ablehnen. Solche Bilder werden deshalb übersprungen, nicht an das Produkt gehängt. Fehlt die Abfrage (mehr als 250 Varianten oder Medien, oder sie schlägt fehl), gelten die Regeln nur für das, was der Editor schickt.
- Ein Bild, das noch nicht hochgeladen ist, rückt in der Anzeige nicht als Hauptbild nach. Der Server nimmt nur Bilder, die schon eine GID haben.
- Wird ein Hauptbild durch Löschen des Mediums ersetzt, wählt der Server aus der gespeicherten Galerie, nicht aus noch ungespeicherten Änderungen.
- Zieht man bei einer Variante mit Hauptbild ein anderes Bild auf den ersten Platz, ändert das das Hauptbild nicht. Es bleibt vorn.
- Die Verdrahtung im Image Manager (Senden beim Speichern, Anzeige, Löschen) ist ohne Darstellungs-Test. Getestet sind die Regeln und der Server.
- «Alt-Text aus SKU» findet Bilder über die Galerie-Liste (`alt-text.action.ts:860-877`, `BulkAltTextPanel.tsx:838`). Hauptbilder stehen dort nicht, sie bekommen so keinen SKU-Alt-Text.

## Bekannt: 429 und Wiederholung

- Gehaltene Schreibvorgänge desselben Limiters werden nacheinander erneut gesendet, ältester zuerst; ein Schreibvorgang wartet höchstens eine Minute auf ältere und gibt seinen Platz beim erneuten Senden frei, nicht nach der Antwort. Lesezugriffe sind nicht geordnet. Auch ein Pfad, den der Wrapper schon abgelehnt sah, wartet auf ältere gehaltene Schreibvorgänge, wenn sein Fenster wieder offen ist. Grenze: Nur der erste Versand eines Pfads, der noch nie abgelehnt wurde, kann einen gehaltenen Schreibvorgang überholen.
- Eine Hauptsprache-Speicherung, die nach einem Produktwechsel abgelehnt wird, zeigt das Produkt danach mit dem Stand von Shopify und nennt es in der Meldung. Der Text wird nicht als Entwurf zurückgebracht (Entscheidung: kein Entwurf nach Fehler).
- Ein externer Wechsel eines gespeicherten Werts zurück auf einen Wert, der als «unser oder älter» gilt (der Wert vor der ersten Speicherung und jeder Wert, der während der Lebenszeit des Zwischenspeichers gespeichert wurde), oder auf leer wird als veraltete Antwort gelesen und nicht übernommen, bis der Zwischenspeicher endet (Haupt- und Fremdsprache gleich): eine Minute nach der ersten Bestätigung durch den Server, spätestens zehn Minuten nach der Speicherung. Ein auf eine noch nie angesehene Sprache gelegtes Zwischenspeicher-Overlay prüft erst beim ersten Ansehen und kann bis zu einem Produktwechsel nie nachgeben.
- Eine Hauptsprache-Speicherung, die beim Produktwechsel noch unterwegs ist, wird nur für ihre eigene Antwort als «verlassen» vermerkt. Wird sie durch ein neues Senden desselben Fetchers abgebrochen oder landet sie noch in der Warteschlange, gibt es keine Antwort, die den Zwischenspeicher zurücknimmt. Nicht geprüft.
- Kommt man zu einem Produkt zurück, bevor die Ablehnung seiner Speicherung eintrifft, bleibt der getippte Text bis zum nächsten Lesen sichtbar (der Zwischenspeicher ist dann zurückgenommen, die Felder werden aber nicht neu aufgelöst).
- Beim Speichern der Hauptsprache setzt `update.actions.ts` den angezeigten Ersatzwert als `seoTitle` mit (vorbestehend, nicht behoben).
- Ein ungeladener Übersetzungs- oder Alt-Text-Abruf (`ThemeContentDomainPage.tsx:656-657`, `VariantImageManager.tsx:864-865`) kann wie «keine Übersetzungen» aussehen. Nur die Meldung «App ausgelastet» weist darauf hin.
- Möglicher Phantom-Änderungsstand, wenn Antwort und Neuladen im selben Render ankommen. Nicht untersucht.
- Ein fehlgeschlagenes Speichern der Hauptsprache lässt die Löschmarken der Übersetzungen stehen, die vor dem Senden gesetzt wurden. Die Anzeige versteckt sie bis zum Neuladen.
- Ein Wert, den zwei Speicherungen ohne dazwischenliegenden Lesedurchgang überschreiben, kommt nicht in die «unser oder älter»-Menge; ein hinterherhinkendes Lesen mit dem ersten Wert kann dann als fremder Wert gelten.
- Bearbeitungen während der Speicherung werden nur über die Feld-Handler erfasst (Tippen, Leeren, «Alle leeren», übernommener Vorschlag). Ein KI-Ergebnis, das auf anderem Weg in ein Feld geschrieben wird, gilt nach der Antwort als gespeichert. Ein «Alle leeren», das hinter einer laufenden Speicherung in der Warteschlange steht, bleibt nach der Antwort als Änderung stehen (sichere Richtung: erneutes Senden).
- Die synthetische 429-Antwort nennt den Aktionsnamen der abgelehnten Anfrage (`actionType`), wenn der Körper ihn trägt. Router-Fetcher senden FormData oder URLSearchParams, der Fall «Körper ohne Namen» (ein `Request`-Objekt als Eingabe) kommt heute nicht vor; käme er vor, könnte die Antwort für die einer abgebrochenen Speicherung gehalten werden.
- Die Prüfung «Antwort gehört zu einem anderen Produkt» im frühen Antwort-Effekt ist doppelt abgesichert (Produkt-Vergleich und Vermerk der verlassenen Speicherung); nur der zweite Teil ist durch einen Test belegt, ein Fall, in dem allein der erste greift, ist nicht konstruierbar gefunden worden.
- Schlägt `fetcher.submit` mit einem Nicht-Abbruch-Fehler fehl, gibt die Speicherung ihre Zwischenspeicher-Einträge zurück (gleiche Regel wie bei einer Ablehnung); das ist nur über die gemeinsame Funktion getestet, nicht über den Fehlerpfad selbst.
- Der Zwischenspeicher nach einer Ablehnung zeigt den Text der abgelehnten Speicherung weiter als Entwurf an (Entscheidung: kein Entwurf nach Fehler gilt für den gespeicherten Stand, der Text im Feld bleibt stehen).

## Bekannt: veraltete Anzeigen

- Produktbilder ohne Datenbankeintrag (`useEditorImageManagement.ts`) werden beim Neuladen nicht neu gelesen. Ein fehlgeschlagenes Laden holt Reload nicht nach, die Galerie bleibt ohne Meldung leer, bis man das Produkt verlässt und zurückkommt. Ein gelöschtes Bild kann bis zum Produktwechsel wieder auftauchen, und nach einer Änderung in Shopify bleibt der alte Alt-Text stehen.
- Nach A, C mit Datenbank-Bildern, zurück zu A erscheinen kurz die alten Bilder von A. Scheitert das neue Laden, verschwinden sie.
- Ein fehlgeschlagenes Laden kann einen Alt-Text bis zum nächsten Neuladen zurücksetzen (sehr selten, nichts geht verloren). Ort: `useEditorImageManagement.ts:114`.
- Das Speicher-Diagramm zeigt nach einem Downgrade alte Werte, bis der Tab neu geöffnet wird (`SettingsUsageLimitsTab.tsx:152-154`).
- Keyword-Liste (`ItemSidebar.tsx:280-296`):
  - Bei sehr schnellem Hin- und Herwechseln während des Hinzufügens fehlt ein neues Keyword kurz in der Liste, gespeichert ist es aber.
  - Selten bleibt die Meldung «konnte nicht geladen werden» neben einer korrekten Liste stehen.
  - Reload liest die Liste nicht neu. Änderungen aus einem anderen Tab oder einem Hintergrund-Task erscheinen erst nach einem Wechsel.
- Ein Taxonomie-Name kann bis zum Neuladen englisch bleiben (`TaxonomyField.tsx:439-443`, kosmetisch).

## Bekannt: Server und Betrieb

- Eine Bulk-Übersetzung kann beim Neustart abbrechen, der Task zeigt dann bis zu 10 Minuten «läuft». Der Fix würde etwa einen halben Tag dauern.
- Ob ein Abbruch durch den Railway-Proxy weitergereicht wird, ist nicht geprüft.
- Nach einem Datenbankausfall von über 10 Minuten kann eine laufende Konvertierung fälschlich geschlossen werden.
- Die 90-Tage-Annahme beim Keep-alive sollte Mitte Januar 2027 geprüft werden.
- Die pfadspezifischen Rate-Limits decken noch nicht alle Routen-Varianten ab (eigenes Ticket, Anmeldung bleibt nötig).
- Eine abgelaufene Session zeigt sich bei Hintergrund-Lesezugriffen nur als allgemeiner Fehler.
- Die Shutdown-Timer sind fest im Code. Die Zeiten 240 Sekunden und 5 Minuten sind nicht gemessen.
- Der Ort von `WEBP_CLAIMABLE_STATUS` ist offen.
- Es gibt eine LiquidComplexity-Warnung.
- Theme-Speichern braucht etwa 4 Sekunden CPU.

## Bekannt: Tests

- Alt-Text-Tests können unter Last in das 10-Sekunden-Timeout laufen.
- Ohne Tests: die Verdrahtung in `ItemSidebar`, `SettingsUsageLimitsTab`, der Namens-Cache in `TaxonomyField`, `VariantImageManager`.
- Der Test «nothing is set after unmount» in `background-reads.test.tsx` prüft nur den Abbruch, nicht das, was sein Titel sagt.
