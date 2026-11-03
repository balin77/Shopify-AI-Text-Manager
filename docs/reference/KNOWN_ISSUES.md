# Bekannte und entschiedene Fehler

Stand: 2026-11-03. Punkte, die bewusst nicht gefixt sind. Wer hier etwas fixt, streicht den Eintrag im selben Commit. Wer einen Fehler findet und nicht fixt, trägt ihn hier ein.

Dieses Repo ist öffentlich: Sicherheitsrelevante Details gehören nicht in diese Datei.

## Zu entscheiden

- **Automatische Galerie-Bereinigung beim Öffnen.** Enthält die Galerie einer Variante deren eigenes Hauptbild, zeigt ein unberührtes Produkt ungespeicherte Änderungen und fragt beim Verlassen nach. Speichern schreibt die Bereinigung mit. Laut Code-Kommentar gewollt, die Anzahl betroffener Produkte ist unbekannt. Ort: `VariantImageManager.tsx:1027-1037`, `:1053-1056`, `app.products.tsx:497-500`.

## Entschieden: bleibt so

- Wird ein Metafeld abgelehnt, werden die anderen Felder desselben Speicherlaufs zurückgesetzt.
- Ein noch nicht gespeicherter, neu getippter Eintrag wird mit dem gesendeten Text angelegt.
- Die eigene Speicher-Ablehnung bei KI und Kopieren bleibt.
- Der Lösch-Knopf für Metafelder fragt nicht nach.
- Nach einem Fehler wird kein Entwurf wiederhergestellt.
- Der Speichern-Knopf bleibt beim gleichen Produkt beschäftigt, bis gespeichert ist. Bei anderen Produkten nicht.
- Pro 429 entsteht eine Log-Zeile. Die Länge ist begrenzt, die Anzahl pro Zeit nicht. Ein Client, der ständig anfragt, kann das Log füllen.
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
- Nach einer Listen-Synchronisierung auf der Metaobjekt-Seite (`handleSyncAll`) bleibt der Editor bei gleich langen Werten alt, die Karten sind aktuell.

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
