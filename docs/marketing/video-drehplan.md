# Drehplan — ContentPilot AI Anleitungsvideos

> Drehplan für die Anleitungsvideos der Website (`/guide`). Die bearbeitbare Arbeitsfassung liegt als Claude-Dokument unter https://claude.ai/code/artifact/77b1c060-2abc-4947-a918-3270f275ec8c — diese Datei ist ein Stand daraus (2026-09-30) und kann ebenso direkt hier bearbeitet werden. Ist ein Video fertig, wird es in `app/config/marketing-guide.ts` (`GUIDE_VIDEOS`) beim passenden Thema eingetragen.

Sep 30, 2026 · @Raphael

## Vorbereitung

Zu jedem der 40 Anleitungsthemen gibt es ein Video von 1–4 Minuten. Alle werden im selben Testshop mit denselben Beispieldaten gedreht, damit die Beispiele aufeinander aufbauen. Pro Video: links steht der gesprochene Text, rechts, was im Bild zu sehen ist.

**Testshop einrichten (einmalig)**

- Sprachen: Deutsch (Hauptsprache), Englisch, Französisch. Das Umstellen der Shopsprache wird nicht gezeigt.
- Märkte: Deutschland (Hauptmarkt) und Schweiz, mit einer eigenen Unterordner-Adresse für die Schweiz.
- Beispielprodukt **Keramikvase Aurora**: Varianten Farbe Weiss/Salbeigrün × Grösse S/M, je 3 Bilder pro Farbe, Titel und eine kurze, etwas holprige Beschreibung (damit die KI-Buttons sichtbar etwas verbessern).
- Zweites Produkt **Leinen-Tischläufer** ganz ohne Beschreibung und ohne Übersetzungen (für „Generieren“ und „fehlende Übersetzungen“).
- Kollektionen: „Vasen“ (manuell) und „Sale“ (automatisch, Regel: Tag ist sale).
- Eine Seite „Über uns“, ein Blog „Journal“ mit einem Artikel „Pflegetipps für Keramik“, der die Vase erwähnt, aber nicht verlinkt.
- Ein Hauptmenü mit drei Ebenen (Shop › Vasen › Keramikvasen).
- KI-Anbieter verbunden, Plan Max (damit automatische Übersetzung gezeigt werden kann).
- Bilddateien für den Bulk-Upload vorbereitet: aurora\_weiss\_01.jpg, aurora\_weiss\_02.jpg, aurora\_salbei\_01.jpg, aurora\_salbei\_02.jpg.

**Aufnahme**

- 1920 × 1080, Browser-Zoom 110 %, Lesezeichenleiste und Benachrichtigungen aus, keine echten Kunden- oder Zahlungsdaten im Bild.
- Mauszeiger hervorheben, Klicks sichtbar machen; bei Tastatureingaben (Strg+Klick) die Taste einblenden.
- Wartezeiten der KI im Schnitt kürzen, mit einem kurzen Hinweis „gekürzt“.
- Jedes Video beginnt mit einem Satz, was man danach kann, und endet mit „Alle Details stehen in der Anleitung unter …“.
- Hinweis zu Plänen nur dort einsprechen, wo die Funktion nicht in jedem Plan enthalten ist.

## Erste Schritte

### 1 · Installation und erste Synchronisation (ca. 2 Min.)

| Gesprochen | Bild |
| --- | --- |
| In zwei Minuten ist ContentPilot AI in Ihrem Shop installiert und kennt Ihren ganzen Katalog. | Titelkarte, dann Startseite der Website mit dem Knopf „Bei Shopify installieren“. |
| Sie installieren die App über den Shopify App Store. Shopify zeigt Ihnen zuerst, was die App lesen und schreiben darf. | Klick auf Installieren, Shopify-Berechtigungsseite, Maus fährt langsam über die Liste. |
| Erst wenn Sie zustimmen, wird installiert. Danach öffnet sich die App direkt in Ihrem Shopify-Admin. | Klick auf „Installieren“, die App lädt im Admin. |
| Beim ersten Start liest die App Ihre Produkte, Kollektionen, Seiten, Blogs, Menüs und alle Übersetzungen ein. | Glocke oben zeigt eine laufende Aufgabe, Fortschritt zählt hoch (Schnitt). |
| Das dauert je nach Katalog Sekunden bis wenige Minuten. Sie können währenddessen schon weiterklicken. | Inhalte › Produkte öffnen, die Liste füllt sich mit der Keramikvase Aurora und dem Tischläufer. |
| Produkte und Kollektionen hält die App ab jetzt selbst aktuell. Ändern Sie eine Seite oder einen Blogartikel direkt im Shopify-Admin, laden Sie ihn hier mit diesem Knopf neu. | Seite „Über uns“ öffnen, Neu-laden-Knopf einkreisen und anklicken. |
| Wie viel Sie bearbeiten können, hängt von Ihrem Plan ab – die Nutzung sehen Sie unter Einstellungen, Plan. | Einstellungen › Plan, Nutzungsbalken kurz zeigen. |

### 2 · KI-Anbieter und API-Schlüssel (ca. 2 Min.)

| Gesprochen | Bild |
| --- | --- |
| Die App schreibt mit Ihrem eigenen KI-Zugang. So verbinden Sie ihn. | Titelkarte. |
| Sie wählen einen Anbieter – zum Beispiel Anthropic, OpenAI oder Google Gemini – und erzeugen dort einen API-Schlüssel. | Browser-Tab mit der Schlüsselseite eines Anbieters, Schlüssel wird erzeugt (Schlüssel verpixelt). |
| In der App öffnen Sie Einstellungen, KI-API-Zugang, und fügen den Schlüssel beim passenden Anbieter ein. | Einstellungen › KI-API-Zugang, Schlüssel einfügen, verpixelt. |
| Dann wählen Sie den bevorzugten Anbieter und das Modell. | Dropdowns Anbieter und Modell öffnen, Auswahl treffen. |
| Die Limits pro Minute schützen Sie vor Ablehnungen bei grossen Läufen. Stellen Sie sie nicht höher ein, als Ihr Anbieter erlaubt. | Felder „Tokens pro Minute“ und „Anfragen pro Minute“ hervorheben. |
| Nichts ist gespeichert, bevor Sie oben auf Speichern klicken. | Speicherleiste erscheint, Klick auf Speichern, Bestätigung. |
| Ob die KI Ihre Produktbilder ansehen darf, stellen Sie einmal für den ganzen Shop ein – standardmässig ist das aus. | Einstellungen › KI-Anweisungen › Allgemein, Schalter „Bilder an die KI senden“ einschalten, Speichern. |

### 3 · Aufbau der App (ca. 2 Min.)

| Gesprochen | Bild |
| --- | --- |
| Ein kurzer Rundgang: Fünf Bereiche, und Sie wissen, wo alles liegt. | Hauptnavigation oben, die fünf Reiter werden nacheinander hervorgehoben. |
| Unter Inhalte bearbeiten Sie jeden Text Ihres Shops – vom Produkt über Seiten und Menüs bis zu den Texten Ihres Themes. | Inhalte-Menü aufklappen, Rubriken Katalog, Online Store, Theme, System langsam zeigen. |
| Bulk ist eine Tabelle über den ganzen Shop. | Bulk-Editor kurz öffnen, einmal horizontal scrollen. |
| Unter SEO finden Sie Analyse, Keywords, Weiterleitungen und alles rund um KI-Sichtbarkeit. | SEO-Übersicht, Abschnitts-Chips kurz hervorheben. |
| Aufgaben zeigt, was gerade im Hintergrund läuft, und Einstellungen alles Weitere. | Aufgaben, dann Einstellungen je 2 Sekunden. |
| Wichtig: Nichts wird geschrieben, bevor Sie speichern. Sobald Sie etwas ändern, erscheint oben die Speicherleiste. | Im Produkt Aurora ein Wort im Titel ändern, Speicherleiste erscheint; „Verwerfen“ klicken, Titel ist wieder wie vorher. |

### 4 · App-Einbettungen im Theme aktivieren (ca. 2 Min.)

| Gesprochen | Bild |
| --- | --- |
| Einige Funktionen brauchen einen kleinen Baustein in Ihrem Shop. Ihr Theme-Code wird dabei nie verändert – Sie schalten Bausteine nur ein und aus. | Titelkarte, dann Inhalte › Theme › App-Einbettungen. |
| Die Liste zeigt jeden Baustein mit einer kurzen Erklärung: strukturierte Daten, Social-Vorschauen, Varianten-Galerie, Sprachauswahl, Direktübersetzungen und Ladezeit-Messung. | Langsam über die Liste scrollen. |
| Beispiel Varianten-Galerie: Ein Klick auf Aktivieren öffnet den Theme-Editor mit dem richtigen Schalter. | Klick auf „Varianten-Galerie aktivieren“, Theme-Editor öffnet sich mit markierter Einbettung. |
| Einschalten, Theme speichern, fertig. | Schalter an, Speichern im Theme-Editor. |
| Zur Kontrolle öffnen Sie eine Produktseite und wechseln die Variante – die Bilder wechseln mit. | Storefront, Produkt Aurora, von Weiss auf Salbeigrün wechseln, Galerie wechselt. |
| Tipp: Liefert Ihr Theme strukturierte Daten schon selbst, lassen Sie diesen Baustein aus. Die App sagt Ihnen im Bereich Strukturierte Daten, ob das so ist. | Einblendung „Siehe Video Strukturierte Daten“. |

### 5 · Aufgaben und Hintergrundprozesse (ca. 1 Min.)

| Gesprochen | Bild |
| --- | --- |
| Grosse Arbeiten laufen im Hintergrund, und Sie können einfach weiterarbeiten. | Im Produkt Aurora „Alles übersetzen“ klicken; die Glocke zeigt eine laufende Aufgabe. |
| Die Glocke zeigt, wie viele Aufgaben laufen, und meldet sich, wenn eine fertig ist. | Glocke aufklappen, laufende Aufgabe mit Fortschritt. |
| Unter Aufgaben sehen Sie die ganze Liste – mit Status und, falls etwas nicht geklappt hat, dem Grund. | Aufgaben-Seite, Status-Spalte hervorheben: Wartend, Läuft, Abgeschlossen, Mit Fehlern abgeschlossen. |
| „Mit Fehlern abgeschlossen“ heisst: Der grösste Teil ist gelungen, und die Ausnahmen stehen einzeln da. | Eine solche Aufgabe aufklappen, Fehlerzeilen zeigen (vorab eine provozieren oder Aufnahme aus Archiv). |

## Inhalte mit KI

### 6 · Der Inhalts-Editor (ca. 2 Min.)

| Gesprochen | Bild |
| --- | --- |
| Produkte, Kollektionen, Seiten und Artikel bearbeiten Sie alle im selben Editor. | Inhalte › Produkte, Aurora anklicken. |
| Links wählen Sie den Eintrag, in der Mitte stehen seine Felder, rechts sehen Sie SEO-Score, Keywords und Lesbarkeit. | Die drei Spalten nacheinander einrahmen. |
| Oben wählen Sie die Sprache. In Deutsch bearbeiten Sie das Original, in Englisch und Französisch die Übersetzung. Farbige Markierungen zeigen, wo noch etwas fehlt. | Sprachleiste, auf EN klicken, ein leeres Feld ist farbig markiert. |
| Jedes Feld hat ein Fragezeichen mit einer Erklärung und einen Knopf zum Leeren. | Fragezeichen beim SEO-Titel anklicken, Erklärung erscheint. |
| Unten im Bereich Details stehen Hersteller, Tags, Kategorie, Kollektionen – und bei Produkten auch Preise, Lager und Vertriebskanäle. | Nach unten zu Details scrollen. |
| Gespeichert wird nur, was Sie geändert haben. Ein neuer Titel überschreibt also nie Ihre Tags. | Titel ändern, Speicherleiste, Speichern, Tags bleiben sichtbar unverändert. |

### 7 · Die KI-Knöpfe: Generieren, Verbessern, Formatieren (ca. 4 Min., Beispiel-Ablauf)

Beispiel: erst der Tischläufer ohne Beschreibung (Generieren), dann die Aurora mit holpriger Beschreibung (Verbessern, Formatieren). Vorher-Nachher jeweils kurz stehen lassen.

| Gesprochen | Bild |
| --- | --- |
| Unter jedem Textfeld sitzen die KI-Knöpfe. Ich zeige Ihnen an zwei Produkten, was jeder genau macht. | Nahaufnahme der Knopfleiste unter dem Beschreibungsfeld. |
| Erstes Beispiel: Der Leinen-Tischläufer hat noch keine Beschreibung. Deshalb heisst der Knopf hier „Mit KI generieren“. | Tischläufer öffnen, leeres Beschreibungsfeld, Knopf „Mit KI generieren“ einkreisen. |
| Vor dem Generieren kann ich der KI eine eigene Anweisung mitgeben. Die hat Vorrang vor allen anderen Regeln. Ich schreibe: „Betone, dass das Leinen vorgewaschen ist.“ | Klick, Feld „Anweisung an die KI (optional)“ erscheint, Text wird eingetippt, Klick auf „Generieren“. |
| Die KI nutzt Titel, Produkttyp, Tags – und, weil ich es erlaubt habe, das Produktbild. | Während des Wartens (gekürzt) Produktbild und Titel kurz einkreisen. |
| Das Ergebnis kommt als Vorschlag, nicht direkt ins Feld. Ich kann es übernehmen, ablehnen – oder mit „Übernehmen und Übersetzen“ gleich in alle Sprachen bringen. | Vorschlagsbox mit den drei Knöpfen Übernehmen, Übernehmen & Übersetzen, Ablehnen. |
| Ich übernehme. Der Text steht jetzt im Feld, gespeichert ist aber noch nichts. | Klick auf Übernehmen, Text im Feld, Speicherleiste oben. |
| Zweites Beispiel: Die Keramikvase hat schon eine Beschreibung, aber sie ist holprig. Jetzt heisst derselbe Knopf „Mit KI verbessern“. | Aurora öffnen, holprige Beschreibung zeigen (vorher im Bild lassen), Knopf zeigt „Mit KI verbessern“. |
| Verbessern formuliert den Text frei neu – klarer, näher an Ihrem Stil und mit Ihrem Ziel-Keyword. | Klick, Vorschlag erscheint; Split-Screen oder Einblendung Vorher ↔ Nachher. |
| Der dritte Knopf, Formatieren, ist vorsichtiger: Er ändert nicht den Inhalt, sondern nur die Form – Absatzstruktur, Satzzeichen, Gross- und Kleinschreibung. | Zurück zum Original, Klick auf „Formatieren“, Vorschlag erscheint. |
| Sehen Sie: Die Sätze sind dieselben, nur sauber gegliedert. Das eignet sich, wenn viele Produkte einheitlich aussehen sollen. | Vorher ↔ Nachher nebeneinander, gleiche Wörter markieren. |
| Hat ein Feld ein Zeichenlimit, wie SEO-Titel und Meta-Beschreibung, halten sich alle Knöpfe daran. Der Zähler unter dem Feld zeigt es. | Meta-Beschreibung: Generieren, Zeichenzähler unter dem Vorschlag einkreisen. |
| Zum Schluss speichern – erst jetzt landet der Text in Shopify. | Speichern klicken, Erfolgsmeldung. |

### 8 · KI-Anweisungen und Stilvorgaben (ca. 3 Min., Beispiel-Ablauf)

Beispiel: Vorher generierte Beschreibung ist zu werblich; nach einer Stilregel und einem Feld-Beispiel wird sie sachlich.

| Gesprochen | Bild |
| --- | --- |
| Damit die KI wie Ihr Shop klingt, geben Sie ihr einmal Regeln mit. | Generierte Beschreibung der Aurora mit vielen Ausrufezeichen und Superlativen. |
| Unter Einstellungen, KI-Anweisungen, gibt es den Schreibstil für alle Texte. Ich schreibe: „Sachlich, per Sie, keine Superlative, keine Ausrufezeichen.“ | Einstellungen › KI-Anweisungen, Feld Schreibstil, Text eintippen. |
| Dazu kommen Regeln pro Feld. Für die Produktbeschreibung lege ich ein Beispiel ab: drei kurze Absätze und eine Liste der Materialien. | Reiter Produkte › Beschreibung, Feld „Beispiel“ und „Anweisungen“ ausfüllen. |
| Ein echtes Beispiel aus Ihrem Shop wirkt oft stärker als viele Regeln. | Einblendung des Tipps. |
| Speichern, zurück zum Produkt, noch einmal generieren. | Speichern, zurück zu Aurora, „Mit KI verbessern“. |
| Jetzt ist der Text sachlich und hat genau die Struktur aus dem Beispiel. | Vorher ↔ Nachher nebeneinander. |
| Wichtig: Bestehende Texte ändern sich erst, wenn Sie sie neu generieren. Und Begriffe, die nie übersetzt werden sollen, gehören ins Glossar – dazu gibt es ein eigenes Video. | Einblendung „Video: Glossar“. |

### 9 · Neue Inhalte anlegen (ca. 2 Min., Beispiel-Ablauf)

Beispiel: neues Produkt „Keramikschale Luna“ mit Titel und Bild; Rest macht die KI.

| Gesprochen | Bild |
| --- | --- |
| Neue Produkte, Seiten oder Artikel legen Sie direkt hier an – wenn Sie wollen, schreibt die KI den Rest. | Produktliste, Klick auf „Neu“. |
| Pflichtfelder sind mit einem roten Stern markiert. Ich trage nur den Titel ein und hänge ein Foto an. | Titel „Keramikschale Luna“ tippen, Bild ablegen, roten Stern einkreisen. |
| Ganz unten entscheiden Sie: „Den Rest mit KI schreiben“ füllt alle leeren Felder, „Anschliessend übersetzen“ bringt alles in jede Sprache. | Beide Schalter einschalten. |
| Erstellen. Die Texte entstehen im Hintergrund. | Klick Erstellen, Aufgabe in der Glocke. |
| Das neue Produkt ist noch unveröffentlicht. Ich prüfe Beschreibung und SEO-Texte und schalte es sichtbar, wenn alles passt. | Produkt öffnen, Beschreibung und SEO-Felder gefüllt, Sprachleiste EN zeigt Übersetzung, Status auf aktiv setzen, Speichern. |
| Und falls Sie beim Ausfüllen doch abbrechen: Ein Klick auf Abbrechen fragt zuerst nach, damit nichts versehentlich verloren geht. | Neuer Dialog, etwas eintippen, Abbrechen, roter Verwerfen-Knopf erscheint. |

## Übersetzungen

### 10 · Übersetzen im Editor (ca. 3 Min., Beispiel-Ablauf)

| Gesprochen | Bild |
| --- | --- |
| So übersetzen Sie ein Feld, einen ganzen Eintrag oder alles in einem Zug. | Aurora geöffnet, Sprachleiste DE / EN / FR. |
| Ich wechsle auf Englisch. Die Beschreibung fehlt hier noch – das Feld ist markiert. Ein Klick auf Übersetzen holt den Text aus dem Deutschen. | EN klicken, markiertes Feld, Knopf „Aus Hauptsprache übersetzen“, Ergebnis erscheint. |
| Zurück in Deutsch: Der Weltkugel-Knopf an einem Feld übersetzt dieses eine Feld in alle Sprachen gleichzeitig. | DE, Weltkugel am SEO-Titel, kurze Einblendung EN und FR gefüllt. |
| „Alles übersetzen“ in der Aktionsleiste übersetzt den ganzen Eintrag. | Aktionsleiste, Klick, Aufgabe startet. |
| Soll eine Sprache nicht mitlaufen – etwa weil Sie Französisch selbst übersetzen lassen – nehmen Sie sie mit Strg-Klick heraus. | Strg-Taste eingeblendet, Klick auf FR, Knopf wird rot. |
| Mitgezählt wird eine Übersetzung erst, wenn Shopify sie bestätigt hat. Klappt etwas nicht, sehen Sie es am Feld – nicht erst im Shop. | Speichern, Erfolgsmeldung. |
| Was Sie selbst tippen, überschreibt die KI nie. | Englischen Titel von Hand anpassen, Speichern. |
| Zusätzliche Produkt-Metafelder – auch von anderen Apps – schalten Sie unter Einstellungen, Metafields, für die Übersetzung frei. | Einstellungen › Metafields, „Jetzt scannen“, ein Feld aktivieren, Speichern. |

### 11 · Glossar (ca. 2 Min., Beispiel-Ablauf)

Beispiel: „Aurora“ bleibt immer Aurora, „Salbeigrün“ wird immer „sage green“ / „vert sauge“.

| Gesprochen | Bild |
| --- | --- |
| Ohne Glossar wird aus „Aurora“ im Französischen schnell „Aurore“. Das legen wir jetzt fest. | FR-Titel der Vase mit „Vase en céramique Aurore“. |
| Einstellungen, KI-Anweisungen, Glossar. Neuer Begriff: „Aurora“ – in allen Sprachen unverändert. | Glossar-Reiter, „Begriff hinzufügen“, Aurora, Option „nicht übersetzen“. |
| Zweiter Begriff: „Salbeigrün“ bekommt feste Übersetzungen – Englisch „sage green“, Französisch „vert sauge“. | Zweiter Eintrag mit festen Übersetzungen je Sprache, Speichern. |
| Das Glossar gilt für jede KI-Übersetzung – im Editor, im Bulk-Editor und bei automatischen Übersetzungen. Beim Generieren deutscher Texte gilt es nicht. | Einblendung der drei Orte. |
| Bestehende Übersetzungen ändern sich erst, wenn Sie neu übersetzen. Also: zurück zur Vase, Französisch, neu übersetzen. | Aurora, FR, Titel neu übersetzen: „Vase en céramique Aurora“, Variante „vert sauge“. |

### 12 · Märkte und marktspezifische Übersetzungen (ca. 2 Min., Beispiel-Ablauf)

Beispiel: Französisch global „Livraison offerte dès 50 €“, für den Markt Schweiz „Livraison offerte dès 50 CHF“.

| Gesprochen | Bild |
| --- | --- |
| Eine Sprache, zwei Märkte, zwei Formulierungen: Französisch für Frankreich und für die Schweiz. | Storefront FR (Frankreich) und FR (Schweiz) nebeneinander, gleicher Satz. |
| Im Editor wähle ich Französisch und daneben den Markt Schweiz. | Aurora, FR, Marktauswahl Schweiz. |
| Ich ändere den Satz nur für die Schweiz – die globale französische Übersetzung bleibt wie sie ist. | Satz auf „50 CHF“ ändern, Speichern; Markt zurück auf global: dort steht weiterhin „50 €“. |
| Im Shop sieht die Schweiz jetzt ihre Fassung. | Storefront Schweiz neu laden. |
| Zwei Dinge sollten Sie wissen: Die URL kann nicht pro Markt abweichen. Und ändert sich der deutsche Originaltext, wird eine Marktfassung entfernt – aber nie automatisch neu geschrieben, denn sie ist Ihre eigene Formulierung. | Einblendung der zwei Punkte. |

### 13 · Wenn sich der Originaltext ändert (ca. 3 Min., Beispiel-Ablauf)

Beispiel: Die deutsche Beschreibung der Aurora bekommt einen neuen Satz „Spülmaschinenfest.“ Einmal mit Löschen, einmal mit automatischer Übersetzung.

| Gesprochen | Bild |
| --- | --- |
| Was passiert mit den Übersetzungen, wenn Sie das deutsche Original ändern? Sie entscheiden es selbst. | Aurora DE und FR nebeneinander, beide Beschreibungen passen zusammen. |
| Die Einstellung finden Sie unter KI-Anweisungen, Übersetzungen. Standard ist: veraltete Übersetzungen löschen. | Einstellungen › KI-Anweisungen › Übersetzungen, Schalter „Löschen bei Änderung“ an. |
| Ich ergänze im Deutschen „Spülmaschinenfest“ und speichere. | DE-Beschreibung ändern, Speichern. |
| Die französische Beschreibung ist jetzt leer – der Shop zeigt dort den deutschen Text, bis ich neu übersetze. So beschreibt nie eine Übersetzung etwas, das es nicht mehr gibt. | FR: Feld leer und markiert. |
| Im Max-Plan geht es bequemer: „Automatisch neu übersetzen“. Das ersetzt das Löschen. | Schalter einschalten, Speichern. |
| Ich ändere noch einmal einen Satz. Nach dem Speichern läuft die Übersetzung im Hintergrund – in jede Sprache, auch in die, die diesen Text noch nie hatte. | DE ändern, Speichern, Aufgabe in der Glocke, danach FR und EN mit neuem Satz. |
| Das klappt auch, wenn Sie den Text im Shopify-Admin oder mit einer anderen App ändern: Produkte und Kollektionen sofort, Seiten und Artikel mit der nächtlichen Prüfung. | Shopify-Admin, Titel ändern; zurück in der App kurz später die neue Übersetzung (Schnitt). |
| Wenn Sie wollen, begrenzen Sie die automatischen Übersetzungen pro Tag – das Feld direkt darunter. | Tageslimit-Feld zeigen. |

### 14 · Übersetzte URLs und Weiterleitungen (ca. 2 Min., Beispiel-Ablauf)

Beispiel: englischer Handle der Aurora von „keramikvase-aurora“ auf „ceramic-vase-aurora“.

| Gesprochen | Bild |
| --- | --- |
| Jede Sprache kann ihre eigene Adresse haben. So ändern Sie sie, ohne alte Links kaputtzumachen. | Storefront EN, Adresszeile zeigt /en/products/keramikvase-aurora. |
| Im Editor, Englisch, Feld Handle: Ich schreibe „ceramic-vase-aurora“ und speichere. | EN, Handle-Feld ändern, Speichern. |
| Die App legt dabei automatisch eine Weiterleitung von der alten auf die neue Adresse an. | Hinweis nach dem Speichern, dann SEO › Weiterleitungen: neuer Eintrag sichtbar. |
| Wer den alten Link aufruft, landet trotzdem auf der Vase. | Alte URL in die Adresszeile tippen, Weiterleitung auf die neue. |
| Gehen Sie später zum alten Handle zurück, entfernt die App die Weiterleitung wieder – sonst wäre die Seite nicht erreichbar. | Einblendung des Satzes. |
| Automatisch übersetzt werden Handles nur, wenn Sie das ausdrücklich einschalten – eine URL zu ändern ist eine eigene Entscheidung. | Einstellungen › Übersetzungen, Unterschalter für Handles. |

### 15 · Theme-Texte übersetzen (ca. 2 Min.)

| Gesprochen | Bild |
| --- | --- |
| „In den Warenkorb“, „Ausverkauft“, die Fusszeile: Diese Texte stecken in Ihrem Theme. | Storefront FR mit deutschem Button „In den Warenkorb“. |
| Unter Inhalte, Theme, finden Sie sie aufgeteilt wie in Shopify: Standardinhalte, Abschnittsgruppen, statische Abschnitte, Vorlagen und Theme-Einstellungen. | Menü Theme aufklappen. |
| Standardinhalte, Suche „Warenkorb“, Französisch: Übersetzen, speichern. | Suche, Eintrag, FR, Übersetzen, Speichern. |
| Im Shop steht jetzt „Ajouter au panier“. | Storefront FR neu laden. |
| Theme-Übersetzungen gehören zu einem Theme. Wechseln Sie das Theme, übersetzen Sie die Texte des neuen. | Einblendung. |

### 16 · Direktübersetzungen für Texte anderer Apps (ca. 3 Min., Beispiel-Ablauf)

Beispiel: Das Bewertungs-Widget einer Fremd-App zeigt in allen Sprachen „Kundenbewertungen“.

| Gesprochen | Bild |
| --- | --- |
| Manche Apps schreiben Texte direkt in Ihren Shop – die bleiben in jeder Sprache deutsch. | Storefront FR, Bewertungs-Widget mit „Kundenbewertungen“. |
| Schritt eins: die App-Einbettung „Direktübersetzungen“ im Theme einschalten. | Theme-Editor, Einbettung an, Speichern. |
| Schritt zwei: In der App unter Direktübersetzungen das Einsammeln einschalten und speichern. | Inhalte › Direktübersetzungen, Schalter an, Speicherleiste, Speichern. |
| Schritt drei: Ihren Shop besuchen. Die App merkt sich die gefundenen Texte. | Storefront durchklicken: Startseite, Produkt Aurora. |
| Zurück in der App stehen die Texte in der Liste. Ich übersetze „Kundenbewertungen“ – von Hand oder mit KI – und speichere. | Liste, Eintrag, FR „Avis clients“, Speichern. |
| Im Shop steht jetzt die französische Fassung. | Storefront FR neu laden. |

### 17 · Menüs bearbeiten und übersetzen (ca. 3 Min., Beispiel-Ablauf)

Beispiel: „Keramikvasen“ von „Vasen“ unter „Wohnen“ verschieben – die Übersetzungen bleiben.

| Gesprochen | Bild |
| --- | --- |
| Ihre Navigation bearbeiten Sie hier als Baum – und die Übersetzungen gehen dabei nicht verloren. | Inhalte › Menüs, Hauptmenü mit drei Ebenen. |
| Umbenennen: Ich klicke auf „Keramikvasen“ und schreibe „Vasen aus Keramik“. | Eintrag umbenennen. |
| Verschieben: Ich ziehe den Eintrag unter „Wohnen“. Bis zu drei Ebenen sind möglich. | Drag-and-drop mit sichtbarer Einrückung. |
| Neuer Eintrag: „Sale“, Ziel ist die Kollektion Sale. Ziele wählen Sie aus Produkten, Kollektionen, Seiten, Blogs – oder als freie URL. | „Hinzufügen“, Zielauswahl, Kollektion Sale wählen. |
| Speichern. In Shopify selbst würde der verschobene Eintrag seine Übersetzungen verlieren – die App sichert und stellt sie wieder her. | Speichern, dann EN: „Ceramic vases“ steht weiterhin am neuen Ort. |
| Und wenn jemand das Menü in der Zwischenzeit anderswo geändert hat, speichert die App nicht blind darüber, sondern sagt Ihnen, was sich geändert hat. | Einblendung der Meldung (vorab provoziert). |

### 18 · Metaobjekte (ca. 2 Min.)

| Gesprochen | Bild |
| --- | --- |
| Metaobjekte bearbeiten Sie Feld für Feld – hier am Beispiel der Farbeinträge. | Inhalte › Metaobjekte, Typ „Farbe“, Karten der Einträge. |
| Textfelder bearbeiten, mit KI füllen und übersetzen Sie wie überall. Farben wählen Sie mit dem Farbfeld. | Label „Salbeigrün“, EN übersetzen; Farbfeld öffnen. |
| Neuer Eintrag: Felder, die auf Shopifys Taxonomie verweisen, wählen Sie aus einer Liste der erlaubten Werte. | „Neu“, Taxonomie-Auswahl aufklappen, Wert wählen, Erstellen. |
| Vor dem Löschen zeigt die App, wie viele Produkte einen Eintrag verwenden. Wird er noch gebraucht, lässt Shopify das Löschen nicht zu. | Löschen-Dialog mit Anzahl der Produkte. |

## Bulk-Editor

### 19 · Der Bulk-Editor (ca. 3 Min., Beispiel-Ablauf)

Beispiel: Bei allen Vasen den SEO-Titel auf das Muster „… – handgemacht“ bringen und bei zwei Varianten den Preis ändern.

| Gesprochen | Bild |
| --- | --- |
| Hunderte Produkte auf einmal ändern – wie in einer Tabellenkalkulation. | Bereich Bulk, Tabelle mit Produkten. |
| Oben wählen Sie, was Zeilen sind: Produkte, Varianten, Kollektionen, Seiten, Artikel, Bilder und mehr. | Zeilenart-Auswahl aufklappen. |
| Mit den Spalten legen Sie fest, was Sie sehen – auch mehrere Sprachen nebeneinander. | Spaltenauswahl: SEO-Titel DE und EN hinzufügen. |
| Ich filtere auf die Kollektion Vasen. | Filter setzen, Liste schrumpft. |
| Jetzt tippe ich direkt in die Zellen. Geänderte Zellen sind markiert, und ich kann jeden Schritt rückgängig machen. | SEO-Titel in drei Zeilen ändern, Markierung, einmal Rückgängig. |
| Mehrere Zellen auf einmal? Aus einer Tabelle kopieren und einfügen. | Aus einer Excel-Liste drei Werte kopieren, in die Spalte einfügen. |
| Zeilenart Varianten: Hier ändere ich zwei Preise. | Umschalten auf Varianten, Preis-Zellen ändern. |
| Gespeichert werden nur die geänderten Zellen. | Speichern, Zähler „X Zellen gespeichert“. |
| Lehnt Shopify einen Wert ab, wird genau diese Zelle rot – alles andere ist trotzdem gespeichert. Auch ein falscher Wert in einer Auswahlspalte, etwa „Ja“ beim Status, wird abgelehnt und erklärt. | „Ja“ in die Status-Spalte einfügen, Speichern, rote Zelle mit Erklärung. |
| Graue Zellen sind hier nicht bearbeitbar – der Hinweis sagt Ihnen, warum und wo es geht. | Maus über eine graue Preiszelle eines Produkts mit mehreren Varianten, Tooltip. |

### 20 · CSV-Export und -Import (ca. 2 Min., Beispiel-Ablauf)

Beispiel: Produkte exportieren, in Excel drei Beschreibungen ändern, wieder importieren.

| Gesprochen | Bild |
| --- | --- |
| Lieber in Excel arbeiten? Exportieren, bearbeiten, wieder einspielen. | Bulk-Editor, Knopf Export. |
| Der Export enthält alle Zeilen Ihrer Filterung. | Download, Datei in Excel öffnen. |
| Die erste Spalte ist die Kennung jeder Zeile – die lassen Sie unverändert. | Erste Spalte markieren, Warnhinweis einblenden. |
| Ich ändere drei Beschreibungen und speichere als CSV. | In Excel tippen, Speichern als CSV. |
| Import: Die App zeigt nur die Zellen, die sich wirklich unterscheiden. | Import, Datei wählen, Vorschau mit drei geänderten Zellen. |
| Prüfen, speichern – mit denselben Prüfungen wie jede andere Bearbeitung. | Speichern, Erfolg. |

### 21 · Fehlende Übersetzungen ergänzen (ca. 2 Min., Beispiel-Ablauf)

Beispiel: Alle Produkte ohne französische Übersetzung in einem Lauf füllen.

| Gesprochen | Bild |
| --- | --- |
| Alles, was in einer Sprache noch leer ist, auf einmal übersetzen. | Bulk-Editor, FR-Spalten mit vielen leeren Zellen. |
| Filtern, dann „Fehlende Übersetzungen ergänzen“. | Klick auf den Knopf, eigene Seite öffnet sich. |
| Oben die Zielsprache – ich wähle nur Französisch. Darunter können Sie einzelne Einträge oder Felder abwählen. | Sprachleiste, EN abwählen; beim Tischläufer das Feld Handle abwählen. |
| Starten. Das läuft im Hintergrund. | Start, Aufgabe in der Glocke. |
| Gefüllt werden nur leere Felder – eine bestehende Übersetzung wird nie überschrieben. | Nach dem Lauf: Tabelle neu, FR-Spalten gefüllt, eine vorher von Hand geschriebene Zelle unverändert. |

## Bilder & Medien

### 22 · Der Image Variant Manager (ca. 4 Min., Beispiel-Ablauf)

Beispiel: Die Aurora bekommt je eine Galerie für Weiss und Salbeigrün, plus ein YouTube-Video.

| Gesprochen | Bild |
| --- | --- |
| Shopify kennt pro Variante nur ein Bild. Mit dem Image Variant Manager bekommt jede Variante ihre eigene Galerie. | Storefront vorher: Farbe wechseln, alle sechs Bilder bleiben sichtbar. |
| Im Produkt Aurora finden Sie oben die Produktgalerie und darunter eine Galerie pro Variante. | Editor, Bildbereich, Galerien der Varianten einrahmen. |
| Ich ziehe die weissen Bilder in die Galerie „Weiss“ – per Ziehen und Ablegen. | Drei Bilder nacheinander in die Variante ziehen. |
| Die Reihenfolge ändere ich ebenfalls durch Ziehen. Das erste Bild ist das Hauptbild der Variante. | Zwei Bilder tauschen. |
| Gilt die Farbe für beide Grössen, kopiere ich die Galerie von „Weiss S“ nach „Weiss M“. | Galerie-Platzhalter klicken, Kopieren, Ziel wählen. |
| Bilder aus der Shopify-Dateibibliothek, Videos und YouTube-Links gehen genauso. | „Dateien durchsuchen“, ein Bild wählen; YouTube-Link einfügen, Vorschau erscheint. |
| Speichern. | Speicherleiste, Speichern. |
| Damit Besucher das sehen, muss die App-Einbettung „Varianten-Galerie“ im Theme eingeschaltet sein – einmalig. | Kurzer Verweis auf Video 4. |
| Im Shop wechselt die Galerie jetzt mit der Farbe. | Storefront: Weiss ↔ Salbeigrün, Galerie wechselt. |
| Diese Funktion ist ab dem Pro-Plan enthalten. | Einblendung. |

### 23 · Bulk-Upload mit Dateinamen-Zuordnung (ca. 2 Min., Beispiel-Ablauf)

Beispiel: vier Dateien aurora\_weiss\_01.jpg, aurora\_weiss\_02.jpg, aurora\_salbei\_01.jpg, aurora\_salbei\_02.jpg.

| Gesprochen | Bild |
| --- | --- |
| Viele Bilder, viele Varianten? Benennen Sie die Dateien richtig, den Rest erledigt die App. | Ordner mit den vier Dateien. |
| Das Muster: Produktname, Unterstrich, Variante, Unterstrich, laufende Nummer. „aurora\_weiss\_01“ gehört also zur Variante Weiss. | Dateiname gross eingeblendet, Teile farbig markiert. |
| Im Image Variant Manager den Bulk-Upload öffnen und alle Dateien auf einmal hineinziehen. | Bulk-Upload öffnen, vier Dateien ablegen. |
| Die App zeigt die Zuordnung. Was sie nicht erkennt, ist markiert – zum Beispiel ein Tippfehler im Variantennamen. | Vorschau; eine fünfte Datei „aurora\_weis\_03.jpg“ ist markiert. |
| Prüfen, speichern – die Bilder landen in den richtigen Varianten. | Speichern, Galerien gefüllt. |
| Die Zuordnung passiert beim Hochladen. Spätere Umbenennungen ändern daran nichts. | Einblendung. |

### 24 · Alt-Texte (ca. 3 Min., Beispiel-Ablauf)

| Gesprochen | Bild |
| --- | --- |
| Alt-Texte beschreiben Bilder für Google und Screenreader – und kaum jemand schreibt sie. | Bild der Aurora, leeres Alt-Text-Feld. |
| Am Bild: „Mit KI generieren“. Weil die Bildfreigabe an ist, sieht die KI genau dieses Bild. | Klick, Ergebnis: „Weisse Keramikvase mit gerillter Oberfläche auf Holztisch“. |
| Für viele Bilder gibt es Vorlagen: pro Bildposition und Sprache ein Muster, zum Beispiel „Keramikvase Aurora in {Farbe}, Vorderansicht“. | Alt-Text-Vorlagen öffnen, Position 1 ausfüllen. |
| „Auf alle Bilder anwenden“ setzt die Farbe jeder Variante ein. | Anwenden, Alt-Texte der Salbeigrün-Bilder zeigen „… in Salbeigrün …“. |
| Übersetzt werden Alt-Texte wie jedes Feld – hier mit „Alle Alt-Texte übersetzen“. | Knopf klicken, EN prüfen. |
| Viele Bilder auf einmal? Im Bulk-Editor ist jede Zeile der Art „Bilder“ ein Bild – auch aus Ihrer Dateibibliothek. | Bulk-Editor, Zeilenart Bilder, Alt-Spalte bearbeiten. |

### 25 · WebP-Konvertierung (ca. 1 Min.)

| Gesprochen | Bild |
| --- | --- |
| Kleinere Bilder, schnellere Seiten: WebP-Konvertierung. | Bildkachel mit Dateigrösse JPG. |
| Bilder auswählen, „Nach WebP konvertieren“. | Drei Bilder markieren, Knopf. |
| Das läuft im Hintergrund. Das neue Bild ersetzt das alte überall – Varianten-Zuordnung und Alt-Text bleiben erhalten. | Aufgabe, danach Kachel mit WebP und kleinerer Grösse, Alt-Text unverändert. |
| Uploads und Umwandlungen zählen gegen ein monatliches Kontingent Ihres Plans. | Einstellungen › Plan, Kontingentbalken. |

## Keywords & SEO

### 26 · Der Weg eines Keywords: von der Idee bis in den Text (ca. 5 Min., Beispiel-Ablauf)

Beispiel: Gruppe „Vasen 2026“ mit den Keywords „keramikvase handgemacht“, „vase weiss“, „blumenvase gross“. Am Ende landet „keramikvase handgemacht“ als Primary-Keyword bei der Aurora und steht im SEO-Titel.

| Gesprochen | Bild |
| --- | --- |
| Ich zeige Ihnen den ganzen Weg eines Keywords: sammeln, verteilen, prüfen – und am Ende steht es im Text. | SEO › Keywords, Reiter Bibliothek. |
| Keywords sammeln Sie in Gruppen. Ich lege „Vasen 2026“ an. | Links „Neue Gruppe“, Name eintippen, Gruppe anlegen. |
| Mit Importieren füge ich mehrere auf einmal ein – eine Zeile pro Keyword, optional mit Komma und Priorität von 1 bis 3. | Importieren, drei Zeilen einfügen, „keramikvase handgemacht,1“. |
| Keine Ideen? Die Recherche schlägt verwandte Begriffe vor, die Sie mit einem Klick übernehmen. | Recherche aufklappen, einen Vorschlag hinzufügen. |
| Jede Sprache hat eigene Keywords – für Englisch wähle ich oben Englisch und lege eigene an. | Sprachwahl EN kurz zeigen, zurück zu Primär. |
| Jetzt verteilen: „Auf Inhalte verteilen“. Die KI schlägt für jedes Keyword passende Produkte, Kollektionen oder Seiten vor. | Knopf, Fortschritt (gekürzt). |
| Die Vorschläge erscheinen oben. Ich prüfe jeden: „keramikvase handgemacht“ auf die Aurora – übernehmen. „blumenvase gross“ auf den Tischläufer – passt nicht, verwerfen. | Vorschlagsliste, Übernehmen und Verwerfen klicken, Zähler „Zu prüfen“ sinkt. |
| Wichtig: Erst dieser Knopf schreibt die Zuordnungen. | Knopf zum Anwenden der übernommenen Vorschläge einkreisen, klicken. |
| Im Reiter Zuordnungen sehen Sie pro Inhalt seine Keywords. Eines davon ist das Primary – der Hauptbegriff der Seite. Bis zu fünf pro Sprache. | Reiter Zuordnungen, Aurora aufklappen, „Als Primary“. |
| Die Tabelle zeigt, wo das Keyword schon vorkommt – Titel, SEO-Titel, Meta, Text – und ob es zu selten oder zu oft verwendet wird. | Spalten Vorkommen und Dichte hervorheben: im SEO-Titel fehlt es. |
| „Im Editor öffnen“ springt direkt zur Aurora. Rechts in der Seitenleiste steht das Keyword mit derselben Prüfung. | Klick, Editor, Seitenleiste Keywords. |
| Jetzt am SEO-Titel „Mit KI verbessern“ – die KI baut das Primary-Keyword ein. | Vorschlag: „Keramikvase handgemacht: Aurora in Weiss & Salbeigrün“, Übernehmen. |
| Der SEO-Score rechts steigt sofort, schon vor dem Speichern. Speichern – fertig. | Score-Anzeige springt, z. B. von 62 auf 81; Speichern. |
| Mit Search Console verbunden sehen Sie später hier auch die echte Google-Position. | Spalte „Google-Pos.“ einkreisen, Verweis auf Video 30. |

### 27 · SEO-Score und Lesbarkeit (ca. 2 Min.)

| Gesprochen | Bild |
| --- | --- |
| Rechts im Editor sehen Sie, wie gut ein Eintrag für Suchmaschinen aufgestellt ist – live, während Sie tippen. | Aurora, Seitenleiste Score. |
| Jeder Punkt, der fehlt, steht einzeln da: Meta-Beschreibung zu kurz, Alt-Texte fehlen, Keyword nicht im Titel. | Liste aufklappen. |
| Ich verlängere die Meta-Beschreibung – der Score reagiert sofort. | Tippen, Score steigt. |
| Darunter die Lesbarkeit: zu lange Sätze, zu lange Absätze, fehlende Zwischenüberschriften. Eine Punktzahl gibt es für Deutsch, Englisch und Spanisch. | Lesbarkeits-Abschnitt. |
| Unter SEO, Übersicht, sehen Sie alle Einträge im Vergleich und können Probleme direkt mit KI beheben. | SEO › Übersicht, „Mit KI beheben“ bei einem Problem. |

### 28 · Website-Crawl und On-Page-Bericht (ca. 3 Min.)

| Gesprochen | Bild |
| --- | --- |
| Die App besucht Ihren Shop wie Google und sagt Ihnen, was dort wirklich ankommt. | SEO › Website-Crawl. |
| „Jetzt scannen“ – der Crawl läuft im Hintergrund, zusätzlich jede Woche automatisch. | Klick, Fortschritt (gekürzt). |
| Schritt 1, Auslieferung: kaputte Seiten und Links, Serverfehler, Weiterleitungen. | Schritt-1-Kachel, Ergebnis-Kacheln, ein defekter Link. |
| Schritt 2, On-Page: fehlende Meta-Beschreibungen, doppelte Titel, Seiten ohne H1, Bilder ohne Alt-Text, Seiten, die Google nicht indexieren darf. | Schritt-2-Kachel, Kategorien aufklappen. |
| Bei jedem Befund öffnet ein Klick den passenden Editor. | „Im Editor öffnen“ bei einer fehlenden Meta-Beschreibung. |
| Der Vergleich zeigt, was sich seit dem letzten Lauf geändert hat, und alles lässt sich als CSV exportieren. | Vergleichsblock, Export-Knopf. |

### 29 · Ladezeit und Qualität (ca. 2 Min.)

| Gesprochen | Bild |
| --- | --- |
| Wie schnell ist Ihr Shop? Hier testen Sie jede Seite mit Google PageSpeed. | SEO › Ladezeit & Qualität, URL der Aurora eingeben, Test starten. |
| Jeder Wert hat eine Erklärung: was er misst und was ihn in Shopify-Shops meist verschlechtert. | Fragezeichen bei LCP öffnen. |
| Mit der App-Einbettung „Web Vitals“ messen Sie zusätzlich bei echten Besuchern – das ist, was Google bewertet. | Bereich „Echte Nutzerdaten“. |
| Die App diagnostiziert, sie verändert Ihren Theme-Code nicht. Die Hinweise sagen Ihnen, wo die Ursache liegt. | Hinweisliste, z. B. grosses Hero-Bild. |

### 30 · Google Search Console (ca. 2 Min.)

| Gesprochen | Bild |
| --- | --- |
| Echte Klicks und Positionen von Google – direkt in der App. | SEO › Search Console. |
| Verbinden, mit dem Google-Konto anmelden, das Zugriff auf Ihren Shop hat, Property wählen. | Verbinden, Google-Anmeldung (Konto verpixelt), Property wählen. |
| Sie sehen Suchbegriffe, Klicks, Impressionen und Positionen – mit Verlauf und Export. | Tabelle, Sortierung nach Impressionen. |
| Tipp: Begriffe auf Position 5 bis 15 sind die schnellsten Gewinne. Übernehmen Sie sie in Ihre Keyword-Bibliothek. | Filter auf Position, Begriff markieren. |
| Enthalten in Pro und Max. | Einblendung. |

### 31 · Weiterleitungen und 404-Fehler (ca. 2 Min., Beispiel-Ablauf)

| Gesprochen | Bild |
| --- | --- |
| Tote Links kosten Besucher. Hier räumen Sie auf. | SEO › Weiterleitungen. |
| Die Liste zeigt alle Weiterleitungen Ihres Shops. Neue legen Sie mit Quelle und Ziel an, viele auf einmal per CSV – auch aus Shopify, Yoast oder Rank Math. | Neue Weiterleitung anlegen; Import-Knopf zeigen. |
| Ketten: Zeigt A auf B und B auf C, schlägt die App vor, A direkt auf C zu leiten. | Kettenbefund, „Auflösen“. |
| Häufige 404-Fehler: Adressen, die Besucher aufrufen und die es nicht gibt, sortiert nach Häufigkeit. Ein Klick legt die Weiterleitung an. | 404-Liste, „/products/vase-aurora-alt“ auf die Aurora weiterleiten. |

### 32 · Interne Verlinkung (ca. 2 Min., Beispiel-Ablauf)

Beispiel: Der Artikel „Pflegetipps für Keramik“ erwähnt die Aurora ohne Link.

| Gesprochen | Bild |
| --- | --- |
| Sie erwähnen Ihre Produkte in Blogartikeln – aber verlinken Sie sie auch? | Artikel im Shop, „Aurora“ als normaler Text. |
| SEO, Interne Verlinkung, „Vorschläge generieren“. | Knopf, Liste erscheint. |
| Ein Vorschlag: im Artikel „Pflegetipps“ das Wort „Aurora“ auf das Produkt verlinken. | Vorschlagszeile mit Von, Text, Nach. |
| Vorschau prüfen, annehmen – der Link wird eingefügt und gespeichert. Abgelehnte Vorschläge kommen nicht wieder. | Vorschau vorher/nachher, Annehmen; Artikel im Shop mit Link. |

### 33 · Sitemap und IndexNow (ca. 2 Min.)

| Gesprochen | Bild |
| --- | --- |
| Welche Seiten sollen Suchmaschinen überhaupt sehen?&#32; | SEO › Sitemap. |
| Die App zeigt den Inhalt Ihrer Sitemap und schlägt vor, was besser raus soll – etwa leere Kollektionen. Ausschliessen und jederzeit zurücknehmen. | Vorschlag, Ausschliessen, Rückgängig zeigen. |
| IndexNow meldet neue und geänderte Seiten sofort an Bing und andere Suchmaschinen – ohne auf den nächsten Besuch zu warten. | SEO › IndexNow, Status „aktiv“, Liste gemeldeter Adressen. |
| Einmal eingerichtet, läuft das automatisch mit. Enthalten in Pro und Max. | Einblendung. |

### 34 · hreflang-Prüfung (ca. 1 Min.)

| Gesprochen | Bild |
| --- | --- |
| Verkaufen Sie in mehreren Sprachen, prüft dieser Bericht, ob jede Sprache wirklich übersetzt ist. | SEO › hreflang. |
| Pro Sprache: vollständig, teilweise, gar nicht übersetzt. Ein Klick führt zu den Lücken. | Balken pro Sprache, Klick auf „teilweise“ in FR, Liste. |
| Am schnellsten schliessen Sie die Lücken mit „Fehlende Übersetzungen ergänzen“ im Bulk-Editor. | Verweis auf Video 21. |

## KI-Sichtbarkeit und Shop-Daten

### 35 · Strukturierte Daten und Social-Vorschauen (ca. 3 Min., Beispiel-Ablauf)

| Gesprochen | Bild |
| --- | --- |
| Strukturierte Daten sorgen dafür, dass Google Preis und Verfügbarkeit direkt im Suchergebnis zeigt. Die Reihenfolge ist wichtig: erst messen, dann einschalten. | Google-Suchergebnis mit Preis-Snippet (Beispielbild). |
| SEO, Strukturierte Daten. Die App liest den letzten Crawl und sagt pro Typ, ob Ihr Theme ihn schon liefert. | Tabelle der Typen mit Empfehlungen. |
| Hier: „Produkt“ liefert das Theme schon – also nicht einschalten, sonst gibt es Doppelungen. „FAQ“ fehlt – einschalten empfohlen. | Zeile Produkt „nicht einschalten“, Zeile FAQ „einschalten“ hervorheben. |
| Ganz unten schalten Sie die empfohlenen Typen ein. | Schalter FAQ an, Speichern. |
| Social-Vorschauen sorgen dafür, dass ein geteilter Link mit Bild, Titel und Beschreibung erscheint. | Link der Aurora in WhatsApp oder Slack einfügen, Vorschau erscheint. |
| Produktvideos bekommen ihr Upload-Datum automatisch. Für YouTube-Links in Galerien listet die App die Produkte, bei denen Sie ein Datum eintragen sollten. | Hinweisliste mit Produkt. |

### 36 · agents.md und llms.txt (ca. 2 Min., Beispiel-Ablauf)

| Gesprochen | Bild |
| --- | --- |
| Fragt jemand ChatGPT nach Ihrem Shop, liest der Assistent Dateien wie agents.md und llms.txt. Die machen wir jetzt richtig. | SEO › KI-Suche. |
| Den Einleitungsabsatz schreiben Sie selbst – wer hinter dem Shop steht, wohin Sie liefern. „Mit KI verbessern“ hilft beim Formulieren. | Textfeld, zwei Sätze tippen, verbessern, übernehmen. |
| „Erzeugen“ – der Rest entsteht aus Ihren Produkten, Kollektionen und Richtlinien. | Knopf, Vorschau der Datei. |
| Danach prüft die App die echte Adresse und zeigt, ob wirklich Ihre Fassung ausgeliefert wird. | Status „unsere Fassung, live“; Browser mit /agents.md. |
| Auf Wunsch hält die App die Dateien automatisch aktuell. Und derselbe Bereich prüft, ob Ihre robots.txt KI-Crawler aussperrt. | Schalter Auto-Aktualisierung, Speichern; robots-Befund. |

### 37 · Katalog-Bereitschaft und KI-Besuche (ca. 2 Min.)

| Gesprochen | Bild |
| --- | --- |
| Shopify gibt vollständige Produkte an KI-Kanäle weiter. Hier sehen Sie, was fehlt. | Katalog-Bereitschaft, fünf Felder: Marke, Kategorie, GTIN, Beschreibung, Bild. |
| Beispiel: Beim Tischläufer fehlt die Kategorie. Klick, Kategorie wählen, speichern. | Zeile Tischläufer, Editor, Kategorie-Auswahl, Speichern. |
| Die zweite Hälfte: Besuche, die aus ChatGPT, Perplexity oder Gemini kommen – ohne Cookies gezählt. | Diagramm der KI-Besuche. |
| Google AI Overviews und Claude geben keine Herkunft weiter und werden deshalb nicht gezählt. Es braucht die App-Einbettung „Web Vitals“. | Hinweis im Bereich einkreisen. |

### 38 · Produktdetails, Preise und Lager (ca. 3 Min., Beispiel-Ablauf)

| Gesprochen | Bild |
| --- | --- |
| Neben den Texten pflegen Sie hier auch Hersteller, Tags, Kategorie und Kollektionen. | Aurora, Bereich Details. |
| Tags tippen, Kollektion hinzufügen – automatische Kollektionen sind gesperrt, weil ihre Regeln die Mitglieder bestimmen. | Tag „sale“ hinzufügen; Kollektionsauswahl, „Sale“ ist gesperrt mit Hinweis. |
| Die Theme-Vorlage wählen Sie aus den Vorlagen, die es in Ihrem Theme wirklich gibt. | Dropdown Theme-Vorlage. |
| Pro Variante: Preis, Vergleichspreis, Einkaufspreis, SKU, Gewicht. | Variante Weiss M, Preisfelder ändern. |
| Der Lagerbestand wird live aus Shopify gelesen. Ist in der Zwischenzeit eine Bestellung eingegangen, überschreibt die App den neuen Wert nicht. | Lagerfeld pro Standort ändern, Speichern. |
| Und: Aktiv heisst nicht sichtbar. Hier sehen Sie, in welchen Kanälen das Produkt wirklich erscheint. | Vertriebskanäle-Panel, Online Store an, POS aus. |

### 39 · Kollektionen und ihre Regeln (ca. 2 Min., Beispiel-Ablauf)

| Gesprochen | Bild |
| --- | --- |
| Automatische Kollektionen füllen sich über Regeln. Die bearbeiten Sie direkt hier. | Inhalte › Kollektionen, „Sale“. |
| Die Kollektion Sale enthält alles mit dem Tag „sale“. Ich ergänze: und Preis unter 80. | Regel-Editor, Bedingung hinzufügen. |
| Speichern – Shopify aktualisiert die Mitglieder. Die Aurora mit Tag sale und Preis 65 ist jetzt dabei. | Speichern, Mitgliederliste. |
| Bedingungen, die die App nicht verlustfrei darstellen kann, bleiben schreibgeschützt. | Gesperrte Bedingung mit Hinweis (falls vorhanden). |
| Die Sortierung legt die Reihenfolge im Shop fest. | Sortierung auf „Preis aufsteigend“. |

### 40 · Richtlinien, Checkout- und Systemtexte (ca. 2 Min.)

| Gesprochen | Bild |
| --- | --- |
| Nicht nur Produkte wollen übersetzt werden: Richtlinien, E-Mails, Versandarten, Filter. | Inhalte-Menü, die Einträge nacheinander. |
| Beispiel Versand: Der Name „Standardversand“ erscheint im Checkout. Französisch wählen, übersetzen, speichern. | Versand & Zustellung, FR, Übersetzen, Speichern. |
| Beispiel Benachrichtigungen: die Bestellbestätigung. Einige dieser Texte verwaltet Shopify selbst – dann ist das Original hier gesperrt, die Übersetzung machen Sie trotzdem hier. | Benachrichtigungen, Bestellbestätigung, gesperrtes Original, FR übersetzen. |
| Filter, Abo-Pläne und Shop-Metadaten funktionieren genauso. | Kurz durchklicken. |
