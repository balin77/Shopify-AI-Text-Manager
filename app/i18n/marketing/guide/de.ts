import type { GuideCopy } from "./types";

export const guideDe: GuideCopy = {
  categories: {
    "getting-started": {
      title: "Erste Schritte",
      intro: "Installieren, den KI-Anbieter verbinden und sich in der App zurechtfinden.",
    },
    "ai-content": {
      title: "Inhalte mit KI erstellen",
      intro: "Texte schreiben, verbessern und neue Inhalte anlegen — mit Ihren eigenen Vorgaben.",
    },
    translations: {
      title: "Übersetzungen",
      intro: "Jede Sprache, jeder Markt und jeder Text Ihres Shops — und was passiert, wenn sich das Original ändert.",
    },
    bulk: {
      title: "Bulk-Editor",
      intro: "Den ganzen Katalog in einer Tabelle bearbeiten, exportieren, importieren und fehlende Übersetzungen ergänzen.",
    },
    media: {
      title: "Bilder & Medien",
      intro: "Der Image Variant Manager, Alt-Texte und die Bildverarbeitung.",
    },
    seo: {
      title: "Keywords & SEO",
      intro: "Keywords planen, den eigenen Shop crawlen und technische SEO-Themen in Ordnung bringen.",
    },
    "ai-visibility": {
      title: "Sichtbarkeit in KI-Assistenten",
      intro: "Was ChatGPT, Perplexity & Co. über Ihren Shop lesen können — und wie Sie das steuern.",
    },
    "shop-data": {
      title: "Produktdaten & Shop-Texte",
      intro: "Merchandising-Angaben, Preise, Lager, Kollektionsregeln und die Texte rund um den Checkout.",
    },
  },

  topics: {
    setup: {
      title: "Installation und erste Synchronisation",
      summary:
        "Wie Sie die App installieren, was beim ersten Start passiert und warum die App mit einer lokalen Kopie Ihrer Inhalte arbeitet.",
      sections: [
        {
          heading: "Installieren",
          paragraphs: [
            "ContentPilot AI wird über den Shopify App Store installiert. Shopify zeigt Ihnen dabei, welche Daten die App lesen und schreiben darf — installiert wird erst, wenn Sie dort zustimmen. Danach öffnet sich die App direkt in Ihrem Shopify-Admin.",
          ],
        },
        {
          heading: "Die erste Synchronisation",
          paragraphs: [
            "Beim ersten Start liest die App Ihre Inhalte aus Shopify ein: Produkte, Kollektionen, Seiten, Blogs, Artikel, Menüs, Metaobjekte und die dazugehörigen Übersetzungen. Je nach Katalog dauert das einige Sekunden bis wenige Minuten; der Fortschritt läuft als Aufgabe im Hintergrund.",
            "Die App arbeitet mit dieser lokalen Kopie, damit Listen, Filter und die Übersichten schnell sind. Geschrieben wird aber immer zuerst in Shopify — erst wenn Shopify eine Änderung bestätigt, gilt sie als gespeichert.",
          ],
        },
        {
          heading: "Neu laden",
          paragraphs: [
            "Produkte und Kollektionen hält die App über Shopifys Webhooks automatisch aktuell. Seiten, Blogs und Artikel haben keine solchen Benachrichtigungen; ändern Sie diese ausserhalb der App, laden Sie den einzelnen Eintrag über den Neu-laden-Knopf im Editor. Ganz neu angelegte Inhalte erscheinen nach einer vollständigen Synchronisation.",
          ],
        },
      ],
      tips: [
        "Wie viele Produkte, Sprachen und Inhaltstypen Sie bearbeiten können, hängt von Ihrem Plan ab. Die aktuelle Nutzung sehen Sie unter Einstellungen → Plan.",
      ],
    },

    "ai-providers": {
      title: "KI-Anbieter und API-Schlüssel",
      summary:
        "Die KI kann im Plan enthalten sein, oder Sie nutzen Ihren eigenen Zugang. So funktioniert beides, und so wählen Sie Modell und Limits.",
      sections: [
        {
          heading: "Ihr eigener Schlüssel",
          paragraphs: [
            "ContentPilot AI schreibt mit dem KI-Anbieter, den Sie verbinden: Anthropic (Claude), OpenAI, Google Gemini, DeepSeek, Grok oder HuggingFace. Sie hinterlegen dafür Ihren eigenen API-Schlüssel — die Kosten und die Wahl des Modells bleiben damit bei Ihnen.",
          ],
          steps: [
            "Bei einem Anbieter ein Konto anlegen und einen API-Schlüssel erzeugen.",
            "In der App Einstellungen → KI-API-Zugang öffnen und den Schlüssel beim passenden Anbieter eintragen.",
            "Den bevorzugten Anbieter und das Modell wählen, dann speichern.",
          ],
        },
        {
          heading: "KI im Plan enthalten",
          paragraphs: [
            "Statt eines eigenen Schlüssels können Sie einen Plan mit enthaltener KI wählen. Unter Einstellungen → Plan schalten Sie oben „Mit enthaltener KI“ ein: Die Karten zeigen dann den Preis mit KI und wie viel Arbeit darin ungefähr enthalten ist. Den Plan wechseln Sie wie gewohnt mit dem Knopf auf der jeweiligen Karte.",
            "Welche KI verwendet wird, entscheidet allein Ihr Plan: Mit einem KI-Plan arbeitet die App mit der enthaltenen KI. Ohne KI-Plan nutzt sie Ihren eigenen Schlüssel, sobald einer hinterlegt ist. Ist weder das eine noch das andere vorhanden, können Sie die enthaltene KI einmalig kostenlos ausprobieren.",
            "Bevor die enthaltene KI arbeitet, bestätigen Sie einmal unter Einstellungen → KI-API-Zugang, dass Ihre Inhalte dafür an die genannten KI-Anbieter gesendet werden dürfen. Dort sehen Sie auch, wie viel des enthaltenen Volumens im aktuellen Abrechnungszeitraum schon verbraucht ist.",
            "Ist das Volumen aufgebraucht, arbeitet die App mit Ihrem eigenen Schlüssel weiter, falls Sie einen hinterlegt haben. Sonst geht es im nächsten Abrechnungszeitraum weiter. Übersetzungen werden dabei nie gelöscht, nur weil das Volumen aufgebraucht ist.",
          ],
        },
        {
          heading: "Limits pro Minute",
          paragraphs: [
            "Für jeden Anbieter lassen sich Tokens und Anfragen pro Minute begrenzen. Das ist vor allem bei grossen Läufen wichtig, etwa beim Übersetzen eines ganzen Katalogs: Setzen Sie die Werte nicht höher, als Ihr Anbieter-Konto erlaubt, sonst lehnt der Anbieter Anfragen ab.",
          ],
        },
        {
          heading: "Bilder an die KI senden",
          paragraphs: [
            "Ob die KI Ihre Produktbilder ansehen darf, ist eine einzige Einstellung für den ganzen Shop (Einstellungen → KI-Anweisungen → Allgemein). Standardmässig ist sie aus. Eingeschaltet beschreibt ein Alt-Text das tatsächliche Bild, und Produkttexte können sichtbare Details aufgreifen. HuggingFace und DeepSeek unterstützen keine Bilder.",
          ],
        },
      ],
      tips: [
        "Der Schlüssel wird verschlüsselt gespeichert. Ersetzen Sie ihn bei Verdacht auf Missbrauch beim Anbieter und tragen Sie den neuen ein.",
      ],
    },

    "app-tour": {
      title: "Aufbau der App",
      summary: "Die fünf Hauptbereiche — Inhalte, Bulk, SEO, Aufgaben, Einstellungen — und wo Sie was finden.",
      sections: [
        {
          heading: "Die Hauptnavigation",
          paragraphs: ["Oben in der App finden Sie fünf Bereiche:"],
          list: [
            "Inhalte — der Editor für jeden Inhaltstyp: Katalog (Produkte, Kollektionen, Abo-Pläne), Online Store (Blogs, Seiten, Richtlinien, Menüs, Metaobjekte, Filter, Cookie-Banner), Theme-Texte, Systemtexte und Direktübersetzungen.",
            "Bulk — der Bulk-Editor, eine Tabelle über den ganzen Shop.",
            "SEO — Übersicht, Analyse (Ladezeit, Crawl, hreflang), Rankings (Keywords, Search Console), Verlinkung (Weiterleitungen, interne Links) und Technik (strukturierte Daten, Sitemap, IndexNow, KI-Suche).",
            "Aufgaben — alles, was im Hintergrund läuft.",
            "Einstellungen — KI-Zugang, KI-Anweisungen, Glossar, SEO-Einstellungen, Plan.",
          ],
        },
        {
          heading: "Speichern",
          paragraphs: [
            "Nichts wird geschrieben, bevor Sie speichern. Sobald Sie etwas ändern, erscheint oben Shopifys Speicherleiste mit „Speichern“ und „Verwerfen“. Das gilt auch für Schalter in den Einstellungen: Eine Änderung ist ein Entwurf, bis Sie sie speichern.",
          ],
        },
        {
          heading: "Einsprachige Shops",
          paragraphs: [
            "Hat Ihr Shop nur eine Sprache, blendet die App die Sprachleisten aus. Übersetzungsknöpfe bleiben sichtbar, aber ausgegraut, mit dem Hinweis, dass eine zweite Sprache nötig ist — so sehen Sie, was möglich wäre.",
          ],
        },
      ],
    },

    "storefront-embeds": {
      title: "App-Einbettungen im Theme aktivieren",
      summary:
        "Einige Funktionen brauchen einen kleinen Baustein in Ihrer Storefront. So schalten Sie die App-Einbettungen ein — ohne Ihren Theme-Code anzufassen.",
      sections: [
        {
          heading: "Was eine App-Einbettung ist",
          paragraphs: [
            "Shopify erlaubt Apps, über „App-Einbettungen“ Funktionen in die Storefront zu bringen, die Sie im Theme-Editor ein- und ausschalten. ContentPilot AI verändert Ihren Theme-Code nie; alles, was auf der Storefront erscheint, läuft über diese Schalter.",
          ],
          list: [
            "Strukturierte Daten (JSON-LD) — Markup für Rich Results bei Google.",
            "Open Graph / Social-Vorschauen — Bild, Titel und Beschreibung beim Teilen von Links.",
            "Varianten-Galerie — zeigt pro Variante die passenden Bilder.",
            "Sprach- und Länderauswahl — ein Umschalter auf Basis von Shopifys eigener Lokalisierung.",
            "Direktübersetzungen — übersetzt Texte anderer Apps.",
            "Web Vitals — misst die Ladezeit bei echten Besuchern.",
          ],
        },
        {
          heading: "Aktivieren",
          paragraphs: [],
          steps: [
            "In der App Inhalte → Theme → App-Einbettungen öffnen (oder den Hinweis im jeweiligen Bereich nutzen).",
            "Beim gewünschten Baustein auf den Aktivieren-Knopf klicken — der Theme-Editor öffnet sich mit der Einbettung vorausgewählt.",
            "Den Schalter einschalten, gegebenenfalls Einstellungen anpassen und das Theme speichern.",
          ],
        },
      ],
      tips: [
        "Liefert Ihr Theme ein Markup schon selbst aus, schalten Sie denselben Typ in der App ab — doppeltes Markup führt zu Warnungen in der Search Console. Die App prüft das für Sie (siehe „Strukturierte Daten“).",
      ],
    },

    tasks: {
      title: "Aufgaben und Hintergrundprozesse",
      summary: "Lange Arbeiten laufen als Aufgaben im Hintergrund. So behalten Sie den Überblick.",
      sections: [
        {
          heading: "Was eine Aufgabe ist",
          paragraphs: [
            "Übersetzen in alle Sprachen, grosse Bulk-Speichervorgänge, ein Crawl, KI-Läufe über viele Einträge: Alles, was länger als einen Moment dauert, startet als Aufgabe. Sie können währenddessen weiterarbeiten oder die Seite verlassen.",
            "Die Glocke oben in der App zeigt, wie viele Aufgaben laufen, und meldet, wenn eine fertig ist. Unter „Aufgaben“ finden Sie die vollständige Liste mit Status, Fortschritt und — bei Fehlern — dem Grund.",
          ],
        },
        {
          heading: "Die Status",
          paragraphs: [],
          list: [
            "Wartend — die Aufgabe steht in der Warteschlange.",
            "Läuft — sie wird gerade bearbeitet.",
            "Abgeschlossen — alles hat geklappt.",
            "Mit Fehlern abgeschlossen — ein Teil ist gelungen, der Rest ist einzeln aufgeführt.",
            "Fehlgeschlagen — nichts wurde geschrieben; der Grund steht in der Aufgabe.",
          ],
        },
      ],
      tips: [
        "Startet eine Aufgabe im Bulk-Editor, lädt die Tabelle sich selbst neu, sobald sie fertig ist — Sie müssen nicht manuell aktualisieren.",
      ],
    },

    "content-editor": {
      title: "Der Inhalts-Editor",
      summary:
        "Ein Editor für Produkte, Kollektionen, Seiten, Artikel und mehr: Liste links, Felder in der Mitte, SEO-Seitenleiste rechts.",
      sections: [
        {
          heading: "Aufbau",
          paragraphs: [
            "Jeder Inhaltstyp öffnet denselben Editor. Links wählen Sie den Eintrag aus einer durchsuchbaren Liste, in der Mitte bearbeiten Sie seine Felder, rechts zeigt die Seitenleiste SEO-Score, Keywords, Lesbarkeit und die strukturierten Daten dieses Eintrags.",
            "Oben steht die Sprachleiste. In der Hauptsprache bearbeiten Sie das Original, in jeder anderen Sprache die Übersetzung. Farbige Markierungen zeigen, wo eine Übersetzung fehlt.",
          ],
        },
        {
          heading: "Felder",
          paragraphs: [
            "Textfelder (Titel, Beschreibung, SEO-Titel, Meta-Beschreibung, Handle) haben unter sich eine Leiste mit KI-Knöpfen: generieren (bei leerem Feld) bzw. verbessern, formatieren und übersetzen. Jedes Feld hat ein Fragezeichen, das erklärt, wofür es gut ist, und einen Knopf zum Leeren.",
            "Im Bereich „Details“ stehen die Angaben, die nicht übersetzt werden: Hersteller, Tags, Kategorie, Kollektionen, Theme-Vorlage, Sichtbarkeit — bei Produkten zusätzlich Preise, Lager und Vertriebskanäle.",
          ],
        },
        {
          heading: "Speichern und Verwerfen",
          paragraphs: [
            "Geänderte Felder werden gesammelt, bis Sie speichern. Gespeichert werden nur die Felder, die Sie tatsächlich geändert haben — ein neuer Titel überschreibt also nicht versehentlich Tags oder die Beschreibung.",
          ],
        },
      ],
    },

    "ai-generate": {
      title: "Texte generieren, verbessern und formatieren",
      summary: "Die KI-Knöpfe an jedem Textfeld — und was sie jeweils mit Ihrem Text machen.",
      sections: [
        {
          heading: "Generieren oder verbessern — ein Knopf",
          paragraphs: [
            "Unter jedem Textfeld sitzt ein KI-Knopf, dessen Beschriftung sich nach dem Feld richtet. Ist das Feld leer, heisst er „Mit KI generieren“ und schreibt einen neuen Text. Die KI bekommt dafür den Kontext des Eintrags — Titel, Produkttyp, Tags und, wenn erlaubt, das Bild — sowie Ihre Anweisungen für dieses Feld.",
            "Steht schon Text im Feld, heisst derselbe Knopf „Mit KI verbessern“ und formuliert den vorhandenen Text frei neu: klarer, besser strukturiert, näher an Ihren Stilvorgaben und an den zugewiesenen Keywords.",
            "Vor dem Start können Sie der KI eine eigene Anweisung für genau diesen Durchgang mitgeben, etwa „Die Wollqualität hervorheben“. Sie hat Vorrang vor allen anderen Regeln.",
          ],
        },
        {
          heading: "Formatieren",
          paragraphs: [
            "Ändert nicht den Inhalt, sondern nur die Form: Gross- und Kleinschreibung, Satzzeichen, Absätze und Listen. Nützlich, um viele Produkte einheitlich aussehen zu lassen.",
          ],
        },
        {
          heading: "Vorschlag annehmen",
          paragraphs: [
            "Das Ergebnis landet als Vorschlag im Feld. Sie können ihn übernehmen, verwerfen oder weiter bearbeiten — nichts wird hinter Ihrem Rücken gespeichert. Mit „Übernehmen & übersetzen“ wird der akzeptierte Text gleich in alle Sprachen übertragen.",
          ],
        },
      ],
      tips: [
        "SEO-Titel und Meta-Beschreibung haben eigene Längenvorgaben. Die KI hält sich daran, und der Zeichenzähler unter dem Feld zeigt, wie Google den Text abschneiden würde.",
      ],
    },

    "ai-instructions": {
      title: "KI-Anweisungen und Stilvorgaben",
      summary: "So bringen Sie der KI Ihren Ton, Ihre Formate und Ihre Regeln pro Feld bei.",
      sections: [
        {
          heading: "Wo",
          paragraphs: ["Unter Einstellungen → KI-Anweisungen gibt es mehrere Ebenen:"],
          list: [
            "Schreibstil — Tonfall, Anrede, Satzlänge, Sprachvorlieben für alle generierten Texte.",
            "Formatierung — wie die Aktion „Formatieren“ Texte gestaltet.",
            "Übersetzung — Tonalität und Regeln für KI-Übersetzungen (z. B. formell oder informell).",
            "Pro Feld und Inhaltstyp — eine Beispiel-Ausgabe und detaillierte Regeln, etwa „Produktbeschreibung: drei Absätze, eine Aufzählung mit Materialangaben“.",
          ],
        },
        {
          heading: "Gute Anweisungen schreiben",
          paragraphs: [
            "Je konkreter, desto einheitlicher das Ergebnis. Ein kurzes, echtes Beispiel aus Ihrem Shop wirkt oft stärker als eine lange Liste von Regeln. Nennen Sie, was die KI vermeiden soll (etwa Superlative oder bestimmte Wörter), und in welcher Länge Sie das Ergebnis erwarten.",
          ],
        },
      ],
      tips: [
        "Änderungen an den Anweisungen gelten für neue Generierungen. Bestehende Texte ändern sich erst, wenn Sie sie erneut generieren oder verbessern.",
        "Wenn Sie festlegen wollen, dass ein Begriff nie oder immer gleich übersetzt wird, gehört das ins Glossar, nicht in die Anweisungen.",
      ],
    },

    "create-content": {
      title: "Neue Inhalte anlegen",
      summary:
        "Produkte, Kollektionen, Seiten, Artikel und Metaobjekte direkt in der App erstellen — auf Wunsch mit KI-Texten und gleich übersetzt.",
      sections: [
        {
          heading: "Der Erstellen-Dialog",
          paragraphs: [
            "In der Liste jedes Inhaltstyps öffnet „Neu“ einen Dialog mit den wichtigsten Feldern. Pflichtfelder sind mit einem roten Stern markiert. Weitere Felder klappen Sie bei Bedarf auf.",
          ],
        },
        {
          heading: "Mit KI ergänzen und übersetzen",
          paragraphs: [
            "Am Ende des Dialogs stehen zwei Schalter: „Den Rest mit KI schreiben“ füllt alle leer gelassenen Felder (zum Beispiel Beschreibung und SEO-Texte) auf Basis dessen, was Sie eingetragen haben. „Anschliessend übersetzen“ überträgt das Ergebnis in alle Sprachen. Haben Sie ein Bild angehängt und die Bildfreigabe eingeschaltet, kann die KI es für die Texte berücksichtigen.",
          ],
        },
        {
          heading: "Unveröffentlicht",
          paragraphs: [
            "Was die App anlegt, wird unveröffentlicht erstellt. Sie prüfen den Inhalt im Editor und schalten ihn sichtbar, wenn er fertig ist.",
          ],
        },
      ],
    },

    translating: {
      title: "Übersetzen im Editor",
      summary: "Ein Feld übersetzen, alles übersetzen, Sprachen auswählen — und was als „gespeichert“ gilt.",
      sections: [
        {
          heading: "Ein Feld oder alles",
          paragraphs: [
            "Wählen Sie oben eine Fremdsprache. Jedes Feld hat nun einen Übersetzen-Knopf, der den Text aus der Hauptsprache überträgt. In der Hauptsprache übersetzt der Weltkugel-Knopf ein Feld direkt in alle Sprachen; „Alles übersetzen“ in der Aktionsleiste übersetzt den ganzen Eintrag.",
            "Mit Strg+Klick (Mac: Cmd+Klick) auf einen Sprach-Knopf nehmen Sie eine Sprache aus solchen Läufen heraus, etwa wenn Sie sie selbst übersetzen lassen.",
          ],
        },
        {
          heading: "Was übersetzt wird",
          paragraphs: [
            "Titel, Beschreibungen, SEO-Texte, Handles, Alt-Texte, Produktoptionen und ihre Werte, Metafelder, Metaobjekt-Felder, Menüs, Theme-Texte und Systemtexte. Welche zusätzlichen Produkt-Metafelder einbezogen werden, legen Sie unter Einstellungen → Metafields fest — dort lassen sich auch Felder anderer Apps aktivieren.",
          ],
        },
        {
          heading: "Gespeichert heisst bestätigt",
          paragraphs: [
            "Eine Übersetzung gilt erst als gespeichert, wenn Shopify sie zurückmeldet. Nimmt Shopify eine Übersetzung nicht an, sehen Sie das am betroffenen Feld — statt einer Erfolgsmeldung über etwas, das nie angekommen ist.",
          ],
        },
      ],
      tips: [
        "Übersetzungen, die Sie selbst tippen, werden nie von der KI überschrieben. Die KI füllt nur, worum Sie sie bitten.",
      ],
    },

    glossary: {
      title: "Glossar",
      summary: "Legen Sie fest, welche Begriffe nie übersetzt werden und welche immer dieselbe Übersetzung bekommen.",
      sections: [
        {
          heading: "Wofür",
          paragraphs: [
            "Markennamen, Produktlinien und Fachbegriffe sollen in jeder Sprache stimmen. Im Glossar (Einstellungen → KI-Anweisungen → Glossar) tragen Sie einen Begriff in der Hauptsprache ein und bestimmen pro Sprache, ob er unverändert bleibt oder eine feste Übersetzung erhält.",
          ],
        },
        {
          heading: "Wann es greift",
          paragraphs: [
            "Das Glossar wird jeder KI-Übersetzung automatisch mitgegeben — im Editor, im Bulk-Editor und bei automatischen Übersetzungen. Beim Generieren neuer Texte in der Hauptsprache wirkt es nicht; dafür sind die KI-Anweisungen da.",
          ],
        },
      ],
      tips: [
        "Neue Glossar-Einträge gelten für neue Übersetzungen. Bereits übersetzte Texte ändern sich erst, wenn Sie sie erneut übersetzen.",
      ],
    },

    markets: {
      title: "Märkte und marktspezifische Übersetzungen",
      summary: "Deutsch für die Schweiz anders als für Deutschland: wie die App mit Shopify Markets umgeht.",
      sections: [
        {
          heading: "Zwei Ebenen",
          paragraphs: [
            "Shopify speichert pro Sprache eine globale Übersetzung. Mit Shopify Markets kann es zusätzlich für einen einzelnen Markt eine eigene Fassung geben, die dort Vorrang hat — etwa „Velo“ statt „Fahrrad“ für die Schweiz.",
            "In der App wählen Sie neben der Sprache auch den Markt. Ohne Markt bearbeiten Sie die globale Übersetzung; mit Markt die Abweichung für genau diesen Markt.",
          ],
        },
        {
          heading: "Was Sie wissen sollten",
          paragraphs: [],
          list: [
            "Nur aktive Märkte werden angeboten.",
            "Der URL-Handle kann nicht pro Markt abweichen — Shopify erlaubt pro Sprache nur einen.",
            "Ändert sich der Originaltext, wird auch eine Marktfassung entfernt, sobald die globale Übersetzung entfernt oder neu übersetzt wird. Neu übersetzt wird eine Marktfassung nie automatisch — sie ist Ihre eigene Formulierung.",
          ],
        },
      ],
    },

    "source-changes": {
      title: "Wenn sich der Originaltext ändert",
      summary:
        "Eine Übersetzung eines Textes, den es nicht mehr gibt, ist schlimmer als keine. Sie entscheiden, ob sie gelöscht oder neu übersetzt wird.",
      sections: [
        {
          heading: "Das Problem",
          paragraphs: [
            "Ändern Sie eine Produktbeschreibung, beschreibt die französische Fassung weiterhin das alte Produkt. Shopify markiert sie nur als „veraltet“ — im Shop bleibt sie sichtbar.",
          ],
        },
        {
          heading: "Ihre zwei Optionen",
          paragraphs: ["Unter Einstellungen → KI-Anweisungen → Übersetzungen:"],
          list: [
            "Übersetzungen löschen bei Änderung (Standard: an) — die veraltete Übersetzung wird entfernt. Der Shop zeigt in dieser Sprache dann den Originaltext, bis Sie neu übersetzen.",
            "Automatisch neu übersetzen (Max-Plan) — die KI übersetzt den neuen Text in alle veröffentlichten Sprachen, auch in solche, die dieses Feld bisher gar nicht hatten. Diese Option ersetzt das Löschen.",
          ],
        },
        {
          heading: "Auch bei Änderungen ausserhalb der App",
          paragraphs: [
            "Bearbeiten Sie Texte im Shopify-Admin, mit einer anderen App oder per Import, erkennt die App das: bei Produkten und Kollektionen sofort über Shopifys Benachrichtigungen, bei Seiten, Artikeln, Blogs und Richtlinien über eine tägliche Prüfung. Die Übersetzungen werden dann nach Ihrer Einstellung behandelt.",
            "Automatische Übersetzungen laufen als Aufgabe im Hintergrund. Speichern Sie in der Zwischenzeit selbst eine Übersetzung, hat Ihre Fassung Vorrang.",
          ],
        },
      ],
    },

    "translated-handles": {
      title: "Übersetzte URLs und Weiterleitungen",
      summary:
        "Ein übersetzter Handle gibt jeder Sprache eine eigene Adresse. Die App legt bei jeder Änderung die nötige Weiterleitung an.",
      sections: [
        {
          heading: "Was ein Handle ist",
          paragraphs: [
            "Der Handle ist der Teil der URL nach /products/ oder /pages/. Übersetzt heisst er zum Beispiel auf Spanisch /es/products/caja-de-madera statt /es/products/holzbox. Das hilft beim Ranking in der jeweiligen Sprache.",
          ],
        },
        {
          heading: "Weiterleitungen",
          paragraphs: [
            "Ändern Sie einen Handle — im Original oder in einer Übersetzung —, führt die alte Adresse ins Leere. Die App legt deshalb automatisch eine 301-Weiterleitung von der alten auf die neue Adresse an, repariert dabei bestehende Weiterleitungsketten und entfernt eine Weiterleitung, wenn Sie zum alten Handle zurückkehren.",
          ],
        },
        {
          heading: "Automatisch neu übersetzen",
          paragraphs: [
            "Handles werden nur dann automatisch neu übersetzt, wenn Sie das zusätzlich ausdrücklich einschalten — eine URL zu ändern ist eine eigene Entscheidung. Auch dann wird ein Handle nur aufgefrischt, wo er schon übersetzt war, und nur, wo eine Weiterleitung möglich ist. Blog-Handles werden nie automatisch geändert, weil Weiterleitungen die Artikel darunter nicht abdecken können.",
          ],
        },
      ],
    },

    "theme-content": {
      title: "Theme-Texte übersetzen",
      summary: "Buttons, Beschriftungen, Abschnitte und Theme-Einstellungen — die Texte, die in Ihrem Theme stecken.",
      sections: [
        {
          heading: "Die Bereiche",
          paragraphs: ["Unter Inhalte → Theme finden Sie die Texte Ihres veröffentlichten Themes, aufgeteilt wie in Shopify:"],
          list: [
            "Standardinhalte — die Sprachdatei des Themes: „In den Warenkorb“, „Ausverkauft“, Formular-Beschriftungen.",
            "Abschnittsgruppen und statische Abschnitte — Kopfzeile, Fusszeile und feste Abschnitte.",
            "Vorlagen — die Abschnitte auf Produkt-, Kollektions- und anderen Seiten.",
            "Theme-Einstellungen — Texte, die in den Einstellungen des Themes stecken.",
            "App-Einbettungen — technische Inhalte, nur zur Ansicht.",
          ],
        },
        {
          heading: "Pro Theme und pro Markt",
          paragraphs: [
            "Theme-Übersetzungen gehören zu einem bestimmten Theme. Wechseln Sie das Theme, müssen die Texte des neuen Themes übersetzt werden. Wie bei allen anderen Inhalten können Sie zusätzlich marktspezifische Fassungen anlegen.",
          ],
        },
      ],
      tips: [
        "Ändern Sie einen Theme-Text in der Hauptsprache, werden seine Übersetzungen nach Ihrer Einstellung gelöscht oder neu übersetzt — genau wie bei Produkten.",
      ],
    },

    "direct-translations": {
      title: "Direktübersetzungen für Texte anderer Apps",
      summary:
        "Bewertungs-Widgets, Badges, Page-Builder: Texte, die Shopifys Übersetzungen nicht erreichen, übersetzen Sie hier.",
      sections: [
        {
          heading: "Wofür",
          paragraphs: [
            "Viele Apps schreiben ihre Texte direkt in die Storefront, ohne sie Shopify zur Übersetzung anzubieten. Sie erscheinen deshalb in jeder Sprache gleich. Direktübersetzungen fangen diese Texte ein und ersetzen sie im Browser des Besuchers durch Ihre Übersetzung.",
          ],
        },
        {
          heading: "So geht's",
          paragraphs: [],
          steps: [
            "Die App-Einbettung „Direktübersetzungen“ im Theme-Editor einschalten.",
            "Unter Inhalte → Direktübersetzungen das Einsammeln einschalten und speichern.",
            "Die Storefront besuchen — die gefundenen Texte erscheinen danach in der Liste.",
            "Texte übersetzen, einzeln oder per KI, und speichern.",
          ],
        },
      ],
      tips: [
        "Anders als sonst werden hier auch Texte in der Hauptsprache angeboten: Ein Text einer anderen App kann in einer beliebigen Sprache vorliegen.",
      ],
    },

    menus: {
      title: "Menüs bearbeiten und übersetzen",
      summary: "Umbenennen, umsortieren, verschachteln und neu verlinken — ohne dass Übersetzungen verloren gehen.",
      sections: [
        {
          heading: "Ein vollständiger Menü-Editor",
          paragraphs: [
            "Unter Inhalte → Menüs bearbeiten Sie Ihre Navigation als Baum: Einträge hinzufügen, löschen, umbenennen, per Ziehen verschieben und bis zu drei Ebenen tief verschachteln. Das Ziel eines Eintrags wählen Sie aus Produkten, Kollektionen, Seiten, Blogs, Artikeln, Richtlinien, Metaobjekten oder als freie URL.",
          ],
        },
        {
          heading: "Übersetzungen bleiben erhalten",
          paragraphs: [
            "Verschieben Sie in Shopify einen Menüpunkt unter einen anderen Elterneintrag, gehen seine Übersetzungen verloren. Die App sichert sie vor dem Speichern und stellt sie danach wieder her — auch für alle Unterpunkte und für marktspezifische Fassungen.",
          ],
        },
        {
          heading: "Vorsicht bei gleichzeitigen Änderungen",
          paragraphs: [
            "Shopify speichert ein Menü immer als Ganzes. Hat jemand das Menü in der Zwischenzeit anderswo geändert, verweigert die App das Speichern und sagt Ihnen, was sich geändert hat — statt die fremde Änderung stillschweigend zu überschreiben.",
          ],
        },
      ],
    },

    metaobjects: {
      title: "Metaobjekte",
      summary: "Einträge anlegen, bearbeiten, übersetzen und löschen — Feld für Feld.",
      sections: [
        {
          heading: "Einträge bearbeiten",
          paragraphs: [
            "Unter Inhalte → Metaobjekte sehen Sie Ihre Metaobjekt-Typen und deren Einträge. Jeder Eintrag erscheint als Karte mit all seinen Feldern; Textfelder lassen sich bearbeiten, mit KI füllen und übersetzen, Farben und Dateien auswählen.",
          ],
        },
        {
          heading: "Neue Einträge und Taxonomie",
          paragraphs: [
            "Neue Einträge legen Sie über den Erstellen-Dialog an. Felder, die auf Shopifys Produkt-Taxonomie verweisen (etwa Farbe oder Muster), wählen Sie aus der Liste der erlaubten Werte.",
          ],
        },
        {
          heading: "Löschen",
          paragraphs: [
            "Vor dem Löschen zeigt die App, wie viele Produkte einen Eintrag verwenden. Wird ein Eintrag noch verwendet, lehnt Shopify das Löschen ab. Ganze Metaobjekt-Typen lassen sich ebenfalls löschen — Shopify entfernt dabei alle Einträge des Typs mit.",
          ],
        },
      ],
      tips: [
        "Welche Felder übersetzbar sind, bestimmt Shopify. Farben, Dateien und Taxonomie-Werte gibt es nur einmal pro Shop, nicht pro Sprache.",
      ],
    },

    "bulk-editor": {
      title: "Der Bulk-Editor",
      summary:
        "Eine Tabelle über den ganzen Shop: filtern, hunderte Zellen ändern und nur das speichern, was Sie angefasst haben.",
      sections: [
        {
          heading: "Was drin ist",
          paragraphs: [
            "Der Bulk-Editor (Bereich „Bulk“) zeigt Produkte, Varianten, Kollektionen, Artikel, Seiten, Blogs, Richtlinien, Metaobjekte und Bilder als Zeilen. Welche Spalten Sie sehen — Titel, SEO-Texte, Handles, Metafelder, Optionen, Alt-Texte, Preise, Merchandising-Angaben —, wählen Sie selbst, auch in mehreren Sprachen nebeneinander.",
          ],
        },
        {
          heading: "Bearbeiten",
          paragraphs: [
            "Filtern Sie auf die Zeilen, die Sie interessieren, und tippen Sie direkt in die Zellen. Rechteckige Bereiche können Sie wie in einer Tabellenkalkulation einfügen. Geänderte Zellen sind markiert, und Sie können Schritte rückgängig machen.",
          ],
        },
        {
          heading: "Speichern",
          paragraphs: [
            "Gespeichert werden nur die geänderten Zellen. Lehnt Shopify einen Wert ab, wird genau diese Zelle als fehlgeschlagen markiert — alle anderen Änderungen gehen trotzdem durch. Sehr grosse Speichervorgänge laufen als Aufgabe im Hintergrund.",
            "Auswahlfelder (etwa Status oder Steuerpflicht) akzeptieren nur ihre erlaubten Werte. Ein eingefügter Wert wie „Ja“ in einer Statusspalte wird abgelehnt und benannt, statt etwas Falsches zu schreiben.",
          ],
        },
      ],
      tips: [
        "Zellen, die ein Auswahlwerkzeug brauchen (etwa die Produktkategorie oder Kollektionsmitgliedschaften), sind im Bulk-Editor nur lesbar. Der Tooltip führt Sie zum Einzel-Editor.",
      ],
    },

    "bulk-csv": {
      title: "CSV-Export und -Import",
      summary: "Den Katalog als Tabelle herunterladen, extern bearbeiten und wieder einspielen.",
      sections: [
        {
          heading: "Export",
          paragraphs: [
            "Der Export schreibt die aktuelle Auswahl und Spalten des Bulk-Editors in eine CSV-Datei — alle Seiten der Filterung, nicht nur die sichtbare. Sie eignet sich für Excel, Numbers oder Google Sheets.",
          ],
        },
        {
          heading: "Import",
          paragraphs: [
            "Beim Import lädt die App Ihre Datei, vergleicht sie mit dem aktuellen Stand und zeigt nur die Zellen, die sich unterscheiden. Sie prüfen die Änderungen im Editor und speichern sie wie jede andere Bearbeitung — mit denselben Prüfungen pro Zelle.",
          ],
        },
      ],
      tips: [
        "Die erste Spalte enthält die Kennung jeder Zeile. Lassen Sie sie unverändert, sonst kann die App eine Zeile nicht mehr zuordnen.",
      ],
    },

    "bulk-translate": {
      title: "Fehlende Übersetzungen ergänzen",
      summary: "Über die aktuelle Filterung hinweg alles übersetzen, was in einer Sprache noch leer ist.",
      sections: [
        {
          heading: "So geht's",
          paragraphs: [],
          steps: [
            "Im Bulk-Editor die Zeilen filtern, die Sie übersetzen möchten.",
            "„Fehlende Übersetzungen ergänzen“ öffnen.",
            "Oben die Zielsprachen wählen und in der Liste Einträge oder einzelne Felder ab- oder anwählen.",
            "Starten — die Übersetzung läuft als Aufgabe im Hintergrund.",
          ],
        },
        {
          heading: "Was dabei passiert",
          paragraphs: [
            "Es werden ausschliesslich leere Übersetzungen gefüllt; eine bestehende Übersetzung wird nie überschrieben. Die App prüft vor dem Schreiben erneut, was wirklich fehlt. Übersetzte Handles sind optional und werden in eine gültige URL-Form gebracht.",
          ],
        },
      ],
    },

    "image-manager": {
      title: "Der Image Variant Manager",
      summary:
        "Jeder Variante ihre eigenen Bilder: Galerien pro Variante zusammenstellen, sortieren und im Shop anzeigen.",
      sections: [
        {
          heading: "Worum es geht",
          paragraphs: [
            "Shopify kennt pro Variante nur ein Bild. Der Image Variant Manager gibt jeder Variante eine eigene Galerie — wählt eine Kundin „Rot“, sieht sie nur die roten Bilder. Er ersetzt auf der Produktseite in der App die Standard-Bildverwaltung.",
          ],
        },
        {
          heading: "Galerien zusammenstellen",
          paragraphs: [
            "Oben liegt die Produktgalerie, darunter eine Galerie pro Variante. Bilder ziehen Sie aus der Produktgalerie oder Ihrer Shopify-Dateibibliothek in eine Variante, sortieren sie per Ziehen und kopieren oder verschieben sie zwischen Varianten. Auch Videos, YouTube-/Vimeo-Links und 3D-Modelle sind möglich.",
          ],
        },
        {
          heading: "Im Shop anzeigen",
          paragraphs: [
            "Damit Besucher die Varianten-Galerien sehen, schalten Sie die App-Einbettung „Varianten-Galerie“ im Theme-Editor ein. Sie übernimmt die Einstellungen Ihrer Theme-Galerie. Erscheinen zwei Galerien übereinander, tragen Sie in der Einbettung den CSS-Selektor der Galerie Ihres Themes ein.",
          ],
        },
      ],
      tips: ["Der Image Variant Manager, Bulk-Upload und WebP-Konvertierung sind ab dem Pro-Plan enthalten."],
    },

    "image-bulk-upload": {
      title: "Bulk-Upload mit Dateinamen-Zuordnung",
      summary: "Alle Bilder eines Produkts auf einmal hochladen — der Dateiname entscheidet, zu welcher Variante jedes gehört.",
      sections: [
        {
          heading: "Das Namensschema",
          paragraphs: [
            "Benennen Sie die Dateien nach dem Muster Produktname_Variante1_Variante2_Kennung.jpg, zum Beispiel shirt_rot_M_01.jpg. Die Teile zwischen dem ersten und dem letzten Unterstrich sind die Optionswerte der Variante; der letzte Teil unterscheidet mehrere Bilder derselben Variante.",
          ],
        },
        {
          heading: "Hochladen",
          paragraphs: [],
          steps: [
            "Im Image Variant Manager den Bulk-Upload öffnen.",
            "Alle Dateien auf einmal hineinziehen.",
            "Die vorgeschlagene Zuordnung prüfen — nicht erkannte Dateien werden markiert.",
            "Speichern. Die Bilder werden hochgeladen und den Varianten-Galerien zugeordnet.",
          ],
        },
      ],
      tips: [
        "Die Zuordnung passiert beim Hochladen. Spätere Umbenennungen der Dateien ändern an der Zuordnung nichts.",
      ],
    },

    "alt-texts": {
      title: "Alt-Texte",
      summary: "Bildbeschreibungen für Google und Screenreader — generiert, per Vorlage oder von Hand, und übersetzt.",
      sections: [
        {
          heading: "Wo Alt-Texte stehen",
          paragraphs: [
            "Alt-Texte bearbeiten Sie am Bild im Image Variant Manager, im Editor bei Kollektions- und Artikelbildern, und gesammelt im Bulk-Editor, wo jede Zeile der Zeilenart „Bilder“ ein Bild ist — Produktbilder ebenso wie Bilder aus Ihrer Dateibibliothek.",
          ],
        },
        {
          heading: "Mit KI",
          paragraphs: [
            "Die KI schreibt einen Alt-Text pro Bild. Ist die Bildfreigabe eingeschaltet, sieht sie dabei genau dieses eine Bild — und beschreibt nicht eines, das nur zufällig daneben liegt.",
          ],
        },
        {
          heading: "Mit Vorlagen",
          paragraphs: [
            "Alt-Text-Vorlagen legen pro Bildposition und Sprache einen Text fest, etwa „Eleganter {Farbe} Keramik-Blumentopf“ für das Hauptbild, und wenden ihn in einem Durchgang auf alle Varianten an.",
          ],
        },
        {
          heading: "Übersetzen",
          paragraphs: [
            "Alt-Texte werden wie jedes andere Feld in alle Sprachen übersetzt und nach denselben Regeln aufgefrischt, wenn sich das Original ändert.",
          ],
        },
      ],
    },

    webp: {
      title: "WebP-Konvertierung",
      summary: "Bilder in das platzsparende WebP-Format umwandeln — schnellere Seiten ohne sichtbaren Qualitätsverlust.",
      sections: [
        {
          heading: "Warum WebP",
          paragraphs: [
            "WebP-Dateien sind bei gleicher Bildqualität meist deutlich kleiner als JPEG oder PNG. Kleinere Bilder laden schneller, und das grösste Bild einer Seite entscheidet oft über ihre gemessene Ladezeit.",
          ],
        },
        {
          heading: "So geht's",
          paragraphs: [
            "Im Image Variant Manager wählen Sie Bilder aus und starten die Umwandlung. Sie läuft im Hintergrund; das umgewandelte Bild ersetzt das Original an allen Stellen, an denen es verwendet wird, inklusive Varianten-Zuordnung und Alt-Text.",
          ],
        },
      ],
      tips: [
        "Uploads und Umwandlungen zählen gegen ein monatliches Kontingent Ihres Plans; die Nutzung sehen Sie unter Einstellungen → Plan.",
      ],
    },

    keywords: {
      title: "Keyword-Bibliothek und Zuordnung",
      summary:
        "Keywords sammeln, recherchieren und auf Produkte, Kollektionen, Seiten und Artikel verteilen — pro Sprache.",
      sections: [
        {
          heading: "Die Bibliothek",
          paragraphs: [
            "Unter SEO → Keywords sammeln Sie Suchbegriffe in Gruppen, etwa „Holzspielzeug“. Neue Begriffe tragen Sie ein oder lassen sich Vorschläge machen. Jede Sprache hat ihre eigenen Keywords — was auf Deutsch gesucht wird, ist auf Französisch ein anderes Wort.",
          ],
        },
        {
          heading: "Verteilen",
          paragraphs: [
            "„Auf Inhalte verteilen“ ordnet die Keywords einer Gruppe passenden Inhalten zu. Im KI-Modus wählt die KI pro Inhalt ein primäres und mehrere sekundäre Keywords; im manuellen Modus entscheiden Sie selbst. Pro Inhalt und Sprache sind bis zu fünf Keywords möglich.",
          ],
        },
        {
          heading: "Nutzen",
          paragraphs: [
            "Die zugewiesenen Keywords erscheinen in der Seitenleiste des Editors. Der SEO-Score prüft, ob sie in Titel, Beschreibung und Meta-Texten vorkommen, und die KI berücksichtigt sie beim Generieren und Verbessern.",
          ],
        },
      ],
    },

    "seo-score": {
      title: "SEO-Score und Lesbarkeit im Editor",
      summary: "Ein Live-Score, der beim Tippen reagiert — und ehrliche Hinweise zur Lesbarkeit Ihres Textes.",
      sections: [
        {
          heading: "Der Score",
          paragraphs: [
            "Die Seitenleiste zeigt für den aktuellen Eintrag einen Wert von 0 bis 100. Er bewertet Titel, Beschreibung, SEO-Titel, Meta-Beschreibung, Alt-Texte und die Verwendung Ihrer Keywords, und er ändert sich während Sie tippen — Sie müssen nicht speichern, um die Wirkung zu sehen. Jede Abweichung ist einzeln aufgeführt.",
          ],
        },
        {
          heading: "Lesbarkeit",
          paragraphs: [
            "Darunter steht eine eigene Lesbarkeits-Analyse: zu lange Sätze, zu lange Absätze, fehlende Zwischenüberschriften. Eine Punktzahl gibt es nur für Deutsch, Englisch und Spanisch, weil es nur dafür geprüfte Formeln gibt — für andere Sprachen wäre eine Zahl schlicht falsch.",
          ],
        },
        {
          heading: "Übersicht",
          paragraphs: [
            "Unter SEO → Übersicht sehen Sie die Verteilung der Scores im ganzen Shop und die häufigsten Probleme — mit Sprung direkt in den betroffenen Eintrag und der Möglichkeit, Probleme per KI zu beheben.",
          ],
        },
      ],
    },

    crawl: {
      title: "Website-Crawl und On-Page-Bericht",
      summary:
        "Die App besucht Ihren Shop wie eine Suchmaschine und berichtet, was ankommt — nicht nur, was in der Datenbank steht.",
      sections: [
        {
          heading: "Schritt 1: Auslieferung",
          paragraphs: [
            "Der Crawl ruft Ihre Storefront Seite für Seite ab, in allen Sprachen. Der erste Bericht zeigt, was nicht ankommt: kaputte Seiten und Links, Serverfehler, Weiterleitungen, langsame Antworten — auf Wunsch auch defekte externe Links.",
          ],
        },
        {
          heading: "Schritt 2: On-Page und Indexierung",
          paragraphs: [
            "Der zweite Bericht liest denselben Crawl: Darf Google eine Seite indexieren (noindex, Canonical)? Hat sie eine H1, eine Meta-Beschreibung, genug Inhalt, Bilder mit Alt-Text? Gibt es doppelte Titel?",
            "Die Berichte filtern Fehlalarme heraus — etwa Richtlinien-Seiten, die sich technisch gar nicht mit einer Meta-Beschreibung versehen lassen, oder bewusst ausgeschlossene Seiten. Wo ein Befund zu einem Inhalt gehört, öffnet ein Klick den passenden Editor.",
          ],
        },
        {
          heading: "Wann",
          paragraphs: [
            "Den Crawl starten Sie mit „Jetzt scannen“; zusätzlich läuft er wöchentlich automatisch. Ein Vergleich zeigt, was sich seit dem letzten Lauf verändert hat. Alle Befunde lassen sich als CSV exportieren.",
          ],
        },
      ],
    },

    performance: {
      title: "Ladezeit und Qualität",
      summary: "Einzelne Seiten mit Google PageSpeed Insights testen und echte Nutzerdaten aus Ihrem Shop sehen.",
      sections: [
        {
          heading: "Labormessung",
          paragraphs: [
            "Unter SEO → Ladezeit & Qualität testen Sie eine Seite mit Google PageSpeed Insights: Core Web Vitals wie LCP, CLS und INP, dazu Barrierefreiheit und Best Practices aus demselben Testlauf. Jeder Wert hat eine Erklärung, was er misst und was ihn in Shopify-Shops typischerweise verschlechtert.",
          ],
        },
        {
          heading: "Echte Besucher",
          paragraphs: [
            "Mit der App-Einbettung „Web Vitals“ misst die App die Werte bei Ihren tatsächlichen Besuchern. Diese Daten weichen oft deutlich von der Labormessung ab und sind das, was Google bewertet. Bei wenig Traffic dauert es ein paar Tage, bis genug Messungen vorliegen.",
          ],
        },
      ],
      tips: [
        "Die App diagnostiziert die Ladezeit, verändert aber nie Ihren Theme-Code. Die Hinweise sagen Ihnen, wo die Ursache liegt — etwa bei einer bestimmten App oder einem zu grossen Bild.",
      ],
    },

    "search-console": {
      title: "Google Search Console",
      summary: "Echte Klicks, Impressionen und Positionen von Google, direkt in der App.",
      sections: [
        {
          heading: "Verbinden",
          paragraphs: [],
          steps: [
            "SEO → Search Console öffnen.",
            "Mit dem Google-Konto anmelden, das Zugriff auf die Property Ihres Shops hat.",
            "Die Property auswählen.",
          ],
        },
        {
          heading: "Was Sie sehen",
          paragraphs: [
            "Für welche Suchbegriffe Ihre Seiten erscheinen, wie oft sie angeklickt werden und auf welcher Position sie stehen — mit Verlauf und Export. So sehen Sie, ob Ihre Keywords und Texte wirken, und finden Begriffe, für die Sie schon fast gut ranken.",
          ],
        },
      ],
      tips: ["Die Search-Console-Anbindung ist in den Plänen Pro und Max enthalten."],
    },

    redirects: {
      title: "Weiterleitungen und 404-Fehler",
      summary: "301-Weiterleitungen verwalten, Weiterleitungsketten auflösen und häufige 404-Fehler beheben.",
      sections: [
        {
          heading: "Weiterleitungen verwalten",
          paragraphs: [
            "Unter SEO → Weiterleitungen sehen, suchen, anlegen und löschen Sie die Weiterleitungen Ihres Shops. Import und Export nutzen zwei Spalten, Quellpfad und Zielpfad; beim Import werden auch Exporte aus Shopify, Yoast und Rank Math erkannt.",
          ],
        },
        {
          heading: "Ketten",
          paragraphs: [
            "Leitet A auf B und B auf C weiter, macht jeder Besuch einen Umweg. Die App findet solche Ketten und Schleifen in Ihrer Weiterleitungsliste und lässt Sie A direkt auf C zeigen.",
          ],
        },
        {
          heading: "404-Fehler",
          paragraphs: [
            "Adressen, die Besucher aufrufen und die nicht existieren, werden gesammelt und nach Häufigkeit sortiert. Für jede können Sie direkt eine Weiterleitung auf die passende Seite anlegen. Erfasst werden sie, sobald eine App-Einbettung der App im Theme aktiv ist.",
          ],
        },
      ],
    },

    "internal-links": {
      title: "Interne Verlinkung",
      summary: "Findet Stellen, an denen Sie Produkte oder Kollektionen erwähnen, aber noch nicht verlinken.",
      sections: [
        {
          heading: "Wie es funktioniert",
          paragraphs: [
            "Die App durchsucht Blog-Artikel, Seiten und Produktbeschreibungen nach Erwähnungen Ihrer Produkte und Kollektionen, die noch kein Link sind. Jeder Fund erscheint als Vorschlag mit dem Textausschnitt.",
          ],
        },
        {
          heading: "Übernehmen",
          paragraphs: [
            "Vor dem Annehmen sehen Sie eine Vorschau des Textes mit dem neuen Link; nach Ihrer Bestätigung wird er eingefügt und in Shopify gespeichert. Abgelehnte Vorschläge tauchen bei späteren Scans nicht wieder auf. Interne Links helfen Besuchern weiter und zeigen Suchmaschinen, welche Seiten zusammengehören.",
          ],
        },
      ],
    },

    "sitemap-indexnow": {
      title: "Sitemap und IndexNow",
      summary: "Steuern, was in Ihrer Sitemap steht, und Suchmaschinen sofort über Änderungen informieren.",
      sections: [
        {
          heading: "Sitemap",
          paragraphs: [
            "Shopify erzeugt die sitemap.xml selbst. Unter SEO → Sitemap sehen Sie, was darin steht, und bekommen Vorschläge, welche Seiten besser ausgeschlossen werden — etwa Dankeseiten oder leere Kollektionen. Ein Ausschluss setzt Shopifys Metafeld seo.hidden und lässt sich jederzeit zurücknehmen.",
          ],
        },
        {
          heading: "IndexNow",
          paragraphs: [
            "IndexNow benachrichtigt Bing und weitere Suchmaschinen sofort, wenn eine Seite neu, geändert oder entfernt ist, statt auf den nächsten Besuch des Crawlers zu warten. Die App richtet den nötigen Schlüssel ein und meldet Änderungen automatisch — auch wenn Sie Seiten im Bulk-Editor veröffentlichen oder verbergen.",
          ],
        },
      ],
      tips: ["IndexNow ist in den Plänen Pro und Max enthalten."],
    },

    hreflang: {
      title: "hreflang-Prüfung",
      summary: "Prüft für mehrsprachige Shops, ob jede veröffentlichte Sprache wirklich übersetzt ist.",
      sections: [
        {
          heading: "Worum es geht",
          paragraphs: [
            "Shopify teilt Suchmaschinen über hreflang mit, dass es eine Seite in jeder veröffentlichten Sprache gibt. Ist sie in einer Sprache nicht übersetzt, zeigt Google dort den Originaltext unter einer fremdsprachigen Adresse — für Besucher verwirrend und für das Ranking schwach.",
          ],
        },
        {
          heading: "Der Bericht",
          paragraphs: [
            "Unter SEO → hreflang sehen Sie pro Sprache, wie viele Inhalte vollständig, teilweise oder gar nicht übersetzt sind, und springen direkt zu den Lücken.",
          ],
        },
      ],
      tips: ["In einem Shop mit nur einer Sprache ist dieser Bereich ausgegraut, weil es nichts zu prüfen gibt."],
    },

    "structured-data": {
      title: "Strukturierte Daten und Social-Vorschauen",
      summary:
        "JSON-LD für Rich Results bei Google und Open-Graph-Tags für geteilte Links — und eine Prüfung, dass nichts doppelt ist.",
      sections: [
        {
          heading: "Was ausgeliefert wird",
          paragraphs: [
            "Die App-Einbettung „Strukturierte Daten“ liefert schema.org-Markup für Produkte, Kollektionen, Artikel, Organisation, Breadcrumbs, FAQs und Videos aus. „Social-Vorschauen“ ergänzt Open-Graph- und Twitter-Tags, damit ein geteilter Link mit Bild, Titel und Beschreibung erscheint.",
          ],
        },
        {
          heading: "Erst messen, dann einschalten",
          paragraphs: [
            "Viele Themes liefern bereits eigenes Markup. Doppeltes Markup erzeugt Fehler in Googles Test. Unter SEO → Strukturierte Daten liest die App deshalb den letzten Crawl und sagt Ihnen pro Typ, ob Sie ihn einschalten sollten, ob er schon von Ihrem Theme oder einer anderen App kommt oder ob noch keine Messung vorliegt. Die Schalter kommen erst am Ende.",
          ],
        },
        {
          heading: "Videos",
          paragraphs: [
            "Für Produktvideos übernimmt die App das Upload-Datum automatisch aus Shopify. Für YouTube-Links in Varianten-Galerien kennt Shopify kein Datum; die Prüfung listet diese Produkte auf, damit Sie ein Datum hinterlegen können.",
          ],
        },
      ],
    },

    "ai-discovery": {
      title: "agents.md und llms.txt",
      summary: "Die Dateien, die KI-Assistenten über Ihren Shop lesen — erzeugt aus Ihrem Katalog und aktuell gehalten.",
      sections: [
        {
          heading: "Was die Dateien sind",
          paragraphs: [
            "/agents.md und /llms.txt sind Dateien, die KI-Assistenten und KI-Crawler lesen, um einen Shop zu verstehen: wer Sie sind, was Sie verkaufen, wo Ihre Richtlinien stehen. Shopify liefert eine Standardfassung aus; die App ersetzt sie durch eine, die aus Ihrem Katalog erzeugt ist.",
          ],
        },
        {
          heading: "Erzeugen und prüfen",
          paragraphs: [
            "Unter SEO → KI-Suche erzeugen Sie beide Dateien mit einem Klick. Den einleitenden Absatz schreiben Sie selbst — auf Wunsch mit KI-Unterstützung —, der Rest wird aus Ihren Produkten, Kollektionen und Richtlinien erzeugt. Danach ruft die App die echte Adresse ab und zeigt, ob wirklich Ihre Fassung ausgeliefert wird.",
            "Auf Wunsch aktualisiert die App die Dateien automatisch, wenn sie veraltet sind. „Unsere Fassung entfernen“ gibt die Adresse jederzeit an Shopify zurück.",
          ],
        },
        {
          heading: "robots.txt",
          paragraphs: [
            "Derselbe Bereich prüft, ob Ihre robots.txt KI-Crawler aussperrt — manche Themes und Apps tun das, ohne dass es jemand bemerkt.",
          ],
        },
      ],
    },

    "catalog-readiness": {
      title: "Katalog-Bereitschaft und KI-Besuche",
      summary: "Was einem Produkt fehlt, bevor KI-Kanäle es aufgreifen — und wie viele Besucher aus KI-Assistenten kommen.",
      sections: [
        {
          heading: "Katalog-Bereitschaft",
          paragraphs: [
            "Shopify gibt geeignete Produkte automatisch an KI-Kanäle weiter. Ob ein Produkt geeignet ist, hängt an seiner Vollständigkeit. Die App prüft für alle aktiven Produkte fünf Angaben — Marke, Kategorie, GTIN/Barcode, Beschreibung und Bild — und listet, was fehlt.",
          ],
        },
        {
          heading: "Besuche aus KI-Assistenten",
          paragraphs: [
            "Mit eingeschalteter Web-Vitals-Einbettung zählt die App Besuche, die aus ChatGPT, Perplexity, Gemini, Copilot und anderen Assistenten kommen — ohne Cookies und ohne personenbezogene Daten, pro Tag und Landingpage.",
            "Zwei Grenzen gehören dazu: Klicks aus Google AI Overviews sehen aus wie normale Google-Besuche, und Claude gibt keine Herkunft weiter. Beide werden nicht gezählt — lieber zu wenig als falsch.",
          ],
        },
      ],
    },

    "product-details": {
      title: "Produktdetails, Preise und Lager",
      summary:
        "Hersteller, Tags, Kategorie, Kollektionen, Preise, Lagerbestand und Vertriebskanäle — direkt neben den Texten.",
      sections: [
        {
          heading: "Merchandising",
          paragraphs: [
            "Im Bereich „Details“ des Produkt-Editors bearbeiten Sie Hersteller, Produkttyp, Tags, Shopifys Produktkategorie, Kollektionsmitgliedschaften, Theme-Vorlage und Status. Die Theme-Vorlage wählen Sie aus den Vorlagen, die es in Ihrem veröffentlichten Theme tatsächlich gibt.",
          ],
        },
        {
          heading: "Preise, Versand und Lager",
          paragraphs: [
            "Für jede Variante: Verkaufspreis, Vergleichspreis, Einkaufspreis, SKU, Barcode, Gewicht und Zollangaben. Den Lagerbestand liest die App live aus Shopify und schreibt ihn nur, wenn sich der Wert seit dem Laden nicht verändert hat — eine zwischenzeitliche Bestellung wird also nie überschrieben.",
          ],
        },
        {
          heading: "Sichtbarkeit",
          paragraphs: [
            "Ein aktives Produkt ist nicht automatisch sichtbar: Es muss auch in einem Vertriebskanal veröffentlicht sein. Die App zeigt, in welchen Kanälen, Regionen und B2B-Katalogen ein Produkt erscheint.",
          ],
        },
      ],
    },

    "collection-rules": {
      title: "Kollektionen und ihre Regeln",
      summary: "Manuelle und automatische Kollektionen, der Regel-Editor und die Sortierung.",
      sections: [
        {
          heading: "Zwei Arten",
          paragraphs: [
            "Manuelle Kollektionen enthalten die Produkte, die Sie hinzufügen. Automatische Kollektionen bestimmen ihre Mitglieder über Regeln, etwa „Tag ist Sale“ oder „Preis unter 50“. Mitglieder automatischer Kollektionen werden in der App angezeigt, lassen sich aber nicht von Hand ändern — Shopify würde das ablehnen oder sofort rückgängig machen.",
          ],
        },
        {
          heading: "Der Regel-Editor",
          paragraphs: [
            "Im Kollektions-Editor bearbeiten Sie die Bedingungen einer automatischen Kollektion: Tag, Produkttyp, Hersteller, Preis, Kategorie, Metafelder und mehr, mit ein- und ausschliessenden Bedingungen. Bedingungen, die die App nicht verlustfrei darstellen kann, bleiben schreibgeschützt, damit nichts versehentlich verändert wird.",
          ],
        },
        {
          heading: "Sortierung",
          paragraphs: [
            "Die Sortierung bestimmt die Reihenfolge der Produkte im Shop. „Manuell“ heisst: die Reihenfolge, die Sie im Shopify-Admin festlegen; alle anderen Werte sortieren automatisch.",
          ],
        },
      ],
    },

    "store-texts": {
      title: "Richtlinien, Checkout- und Systemtexte",
      summary: "Die Texte ausserhalb des Katalogs: Richtlinien, Benachrichtigungen, Versandarten, Filter, Abo-Pläne und mehr.",
      sections: [
        {
          heading: "Was dazugehört",
          paragraphs: ["Unter „Inhalte“ finden Sie neben dem Katalog:"],
          list: [
            "Richtlinien — Rückgabe, Datenschutz, AGB, Versand.",
            "Benachrichtigungen — E-Mail-Vorlagen, Zahlungstexte und andere Systemtexte von Shopify.",
            "Versand & Zustellung — die Namen der Versandarten, wie sie im Checkout erscheinen.",
            "Filter — die Beschriftungen der Storefront-Filter.",
            "Abo-Pläne — Namen und Beschreibungen Ihrer Abo-Optionen.",
            "Shop-Metadaten — Name und Beschreibung des Shops.",
            "Cookie-Banner — die Texte Ihres Zustimmungsbanners, sobald Shopify das für Apps freigibt.",
          ],
        },
        {
          heading: "Bearbeiten und übersetzen",
          paragraphs: [
            "Diese Texte bearbeiten und übersetzen Sie im gewohnten Editor. Einige davon verwaltet Shopify selbst: Dort ist die Hauptsprache schreibgeschützt und wird im Shopify-Admin gepflegt, die Übersetzungen erledigen Sie in der App.",
          ],
        },
      ],
    },
  },
};
