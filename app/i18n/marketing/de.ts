import type { MarketingTranslation } from "./en";

export const de: MarketingTranslation = {
  site: {
    name: "ContentPilot AI",
    tagline: "KI-Texte, SEO und Übersetzungen für Shopify — an einem Ort.",
    description:
      "Schreiben, optimieren und übersetzen Sie jeden Text Ihres Shopify-Shops: Produkte, Kollektionen, Seiten, Blogs, Menüs, Metaobjekte und Theme-Inhalte. Gebaut für Shops, die in mehr als einer Sprache verkaufen.",
  },

  nav: {
    features: "Funktionen",
    videos: "Videos",
    faq: "Fragen",
    install: "Bei Shopify installieren",
    installShort: "Installieren",
    menu: "Menü",
    language: "Sprache",
  },

  hero: {
    storeBadge: "Live im Shopify App Store",
    eyebrow: "Shopify-App",
    title: "Jeder Text Ihres Shops. Geschrieben, gefunden und übersetzt.",
    subtitle:
      "ContentPilot AI schreibt Produkttexte, bringt Ihr SEO in Ordnung und hält jede Übersetzung mit dem Text zusammen, aus dem sie entstanden ist — über alle Sprachen und Märkte hinweg.",
    ctaPrimary: "Ansehen, was die App kann",
    note: "Funktioniert mit Ihrem bestehenden Theme. Ihr Theme-Code wird nie verändert.",
  },

  pillars: {
    more: "Alle Funktionen ansehen",
    title: "Drei Dinge, die die App gut kann",
    items: [
      {
        title: "Schreiben",
        body: "Titel, Beschreibungen, Meta-Texte und Alt-Texte — für Produkte, Kollektionen, Seiten, Blogs, Artikel, Metaobjekte und Theme-Inhalte. Sie wählen den KI-Anbieter und den Ton, die App liefert den Kontext aus Ihrem eigenen Katalog.",
      },
      {
        title: "Übersetzen",
        body: "Jede veröffentlichte Sprache und jeder Markt. Eine Übersetzung gilt erst als gespeichert, wenn Shopify sie zurückmeldet — und wenn sich ein Ausgangstext ändert, wird die Übersetzung erneuert statt still einen Text zu beschreiben, den es nicht mehr gibt.",
      },
      {
        title: "Gefunden werden",
        body: "Ein Crawl Ihrer eigenen Storefront, ein On-Page-Bericht, strukturierte Daten, Weiterleitungsketten, Sitemap-Kontrolle, IndexNow — dazu die neuere Hälfte, die noch kaum jemand abdeckt: was KI-Assistenten lesen, wenn jemand sie nach Ihrem Shop fragt.",
      },
    ],
  },

  features: {
    title: "Funktionen",
    intro:
      "Die App ist eine Sammlung von Werkzeugen mit einer Gemeinsamkeit: Sie arbeiten alle an dem Text, aus dem Ihr Shop besteht. Das ist drin.",
    groups: [
      {
        id: "ai",
        title: "KI-Texte",
        body: "Jedes Feld erzeugen oder verbessern, einzeln oder für einen ganzen Shop. Der Prompt trägt Ihre eigenen Anweisungen, Ihr Glossar und — wenn Sie es erlauben — das Produktbild selbst.",
        points: [
          "Sechs Anbieter zur Auswahl: Anthropic, OpenAI, Gemini, DeepSeek, Grok, HuggingFace",
          "Eigene Anweisungen pro Feld, dazu ein shopweites Glossar",
          "Optionales Bildverständnis, damit ein Alt-Text das tatsächliche Bild beschreibt",
          "Vorschläge landen im Feld und warten auf Ihr Ja — nichts wird hinter Ihrem Rücken geschrieben",
        ],
      },
      {
        id: "translations",
        title: "Übersetzungen und Märkte",
        body: "Der Teil, den die meisten Apps falsch machen. Shopify speichert eine Übersetzung pro Sprache und darüber hinaus pro Markt — Deutsch für die Schweiz anders formuliert als Deutsch für Deutschland. Beide Ebenen werden behandelt.",
        points: [
          "Alle veröffentlichten Sprachen, dazu marktspezifische Formulierungen",
          "Gespeichert ist erst, was Shopify zurückmeldet — keine stillen Fehlschläge",
          "Ändern Sie einen Ausgangstext, wird die Übersetzung neu gemacht statt zu veralten",
          "Fehlende Übersetzungen im ganzen Katalog in einem Durchgang füllen",
          "Übersetzte URL-Handles, samt der 301-Weiterleitung, die dazugehört",
        ],
      },
      {
        id: "bulk",
        title: "Bulk-Editor",
        body: "Eine Tabelle über den ganzen Shop — Produkte, Varianten, Kollektionen, Artikel, Seiten, Blogs, Richtlinien, Metaobjekte und Bilder — bei der nur die Zellen geschrieben werden, die Sie angefasst haben.",
        points: [
          "Hunderte Zeilen filtern, sortieren und gleichzeitig bearbeiten",
          "CSV-Export und -Import",
          "Fehler gelten pro Zelle, ein abgelehntes Feld kostet nie den Rest Ihrer Arbeit",
          "Ein Durchgang, der die fehlenden Übersetzungen der aktuellen Auswahl ergänzt",
        ],
      },
      {
        id: "seo",
        title: "SEO",
        body: "Ein Crawl Ihrer eigenen Storefront statt einer Vermutung aus der Datenbank — und ein Bericht, der seine eigenen Fehlalarme herausfiltert.",
        points: [
          "On-Page-Bericht: Titel, Meta-Beschreibungen, Überschriften, dünne Inhalte, Duplikate",
          "Defekte interne und externe Links",
          "Weiterleitungsketten, hergeleitet aus Ihrer eigenen Weiterleitungsliste",
          "Indexierbarkeit: was von der Suche ausgeschlossen ist — und ob das jemand so wollte",
          "Sitemap-Kontrolle und IndexNow-Meldungen",
          "hreflang-Prüfung für mehrsprachige Shops",
        ],
      },
      {
        id: "aeo",
        title: "Antwortmaschinen-Optimierung",
        body: "Suche ist nicht mehr nur Suche. Hier geht es darum, was ein KI-Assistent liest, wenn eine Kundin ihn nach Ihren Produkten fragt.",
        points: [
          "agents.md und llms.txt, aus Ihrem Katalog erzeugt und aktuell gehalten",
          "Strukturierte Daten (JSON-LD) für Produkte, Artikel, FAQs, Videos und mehr",
          "Open Graph und Twitter Cards, gemessen an dem, was Ihre Storefront wirklich ausliefert",
          "Katalog-Bereitschaft: was fehlt, bevor die KI-Kanäle ein Produkt aufnehmen",
          "Besuche, die von einem KI-Assistenten kamen — gezählt ohne Cookies",
        ],
      },
      {
        id: "media",
        title: "Bilder und Medien",
        body: "Alt-Texte sind auch Inhalt, und sie sind der Text, den niemand schreibt.",
        points: [
          "KI-Alt-Texte für Produktmedien, Kollektions- und Artikelbilder",
          "Alt-Texte in jede Sprache übersetzt wie jedes andere Feld",
          "Massen-Upload mit Zuordnung zu Varianten über den Dateinamen",
          "WebP-Umwandlung, Galerie-Reihenfolge, Videos und 3D-Modelle",
        ],
      },
      {
        id: "structure",
        title: "Navigation, Metaobjekte, Theme-Texte",
        body: "Die Inhalte, die kein Produkt sind — und bei denen die meisten Werkzeuge aufhören.",
        points: [
          "Vollständiger Menü-Editor: umbenennen, umsortieren, verschachteln, umhängen — mit erhaltenen Übersetzungen",
          "Metaobjekt-Einträge und ihre Felder, übersetzt",
          "Theme-Texte und Theme-Einstellungen, pro Theme und pro Markt",
          "Shop-Richtlinien, Seiten, Blogs und Artikel",
        ],
      },
    ],
  },

  media: {
    placeholder: "Bild folgt",
    alt: {
      hero: "Der Bulk-Editor: ein paar hundert Produkte in einer Tabelle, mehrere Sprachen nebeneinander",
      "pillar-writes": "Der Content-Editor mit einem KI-Vorschlag im Beschreibungsfeld",
      "pillar-translates": "Die Sprachleiste eines Produkts mit allen veröffentlichten Sprachen und einer Markt-Variante",
      "pillar-found": "Der On-Page-Bericht nach einem Crawl der Storefront, Befunde nach Kategorie gruppiert",
      "feature-ai": "Ein Feld mit einem generierten Text und dem Übernehmen-Button daneben",
      "feature-translations": "Die Seite 'Fehlende Übersetzungen ergänzen' mit den Checkboxen pro Sprache",
      "feature-bulk": "Das Raster des Bulk-Editors mit einem gesetzten Filter und ein paar hervorgehobenen Zellen",
      "feature-seo": "Der Crawl-Bericht: defekte Links, Weiterleitungsketten und Indexierbarkeit in einer Ansicht",
      "feature-aeo": "Der KI-Discovery-Bereich mit agents.md, llms.txt und dem Status der strukturierten Daten",
      "feature-media": "Die Bildverwaltung mit Alt-Texten in mehreren Sprachen",
      "feature-structure": "Der Menü-Editor mit einem verschachtelten Navigationsbaum",
    },
  },

  videos: {
    title: "Videos",
    intro:
      "Kurze Rundgänge durch die Teile, die sich in einem Satz schlecht erklären lassen. Weitere entstehen gerade.",
    comingSoon: "Aufnahme läuft",
    comingSoonBody: "Dieser Rundgang ist noch nicht veröffentlicht.",
    play: "Abspielen",
    loadExternal: "Laden und abspielen",
    externalNote:
      "Beim Abspielen wird das Video von einem externen Anbieter geladen, der Cookies setzen kann.",
    items: {
      overview: {
        title: "Ein Rundgang durch die App",
        body: "Welche Bereiche es gibt, wo Ihre Inhalte liegen und was beim Speichern passiert.",
      },
      "bulk-editor": {
        title: "Einen ganzen Katalog auf einmal bearbeiten",
        body: "Auf die richtigen Zeilen filtern, Hunderte Zellen ändern und eine CSV wieder einlesen.",
      },
      translations: {
        title: "Einen Shop übersetzen",
        body: "Fehlende Sprachen füllen, marktspezifische Formulierungen — und was passiert, wenn sich ein Ausgangstext ändert.",
      },
      seo: {
        title: "Die eigene Storefront crawlen",
        body: "Den Scan starten, den On-Page-Bericht lesen und das Gefundene beheben, ohne die App zu verlassen.",
      },
      aeo: {
        title: "Für KI-Assistenten lesbar sein",
        body: "agents.md, llms.txt und strukturierte Daten — was das ist und warum es inzwischen zählt.",
      },
    },
  },

  install: {
    title: "Bei Shopify installieren",
    intro:
      "Geben Sie die Shopify-Adresse Ihres Shops ein. Sie landen in Shopifys eigener Berechtigungsseite, wo Sie entscheiden, was die App lesen und schreiben darf — installiert wird nichts, bevor Sie dort zustimmen.",
    label: "Ihr Shopify-Shop",
    placeholder: "mein-shop.myshopify.com",
    help: "Die .myshopify.com-Adresse, nur der Shop-Name oder die Admin-URL, die Sie gerade offen haben — alle drei funktionieren.",
    submit: "Weiter zu Shopify",
    errors: {
      empty: "Bitte geben Sie Ihre Shop-Adresse ein.",
      invalid: "Das sieht nicht nach einer Shopify-Shop-Adresse aus. Nehmen Sie mein-shop.myshopify.com oder einfach den Shop-Namen.",
      customDomain:
        "Das ist Ihre Storefront-Domain. Installiert wird über die .myshopify.com-Adresse des Shops — Sie finden sie im Shopify-Admin unter Einstellungen oder in der URL als admin.shopify.com/store/<name>.",
    },
  },

  faq: {
    title: "Fragen",
    items: [
      {
        q: "Verändert die App mein Theme?",
        a: "Nein. Ihr Theme-Code wird nie bearbeitet — kein eingefügtes Markup, keine umgeschriebenen Sections, keine Eingriffe in Dateien, die Sie geschrieben haben. Die einzigen Theme-Dateien, die die App anfasst, hat sie selbst angelegt (ihre KI-Discovery-Dateien und ihre eigenen Storefront-Blöcke) — und jede davon gibt sie auf Wunsch wieder zurück.",
      },
      {
        q: "Welchen KI-Anbieter nutzt die App?",
        a: "Den, den Sie verbinden: Anthropic, OpenAI, Gemini, DeepSeek, Grok oder HuggingFace. Sie bringen Ihren eigenen Schlüssel mit, also bleiben die Kosten und die Wahl des Modells bei Ihnen.",
      },
      {
        q: "Brauche ich mehr als eine Sprache?",
        a: "Nein. Texte, SEO und Bilder funktionieren auch in einem einsprachigen Shop, und die Übersetzungs-Oberfläche erscheint dort schlicht nicht. Am stärksten ist die App in einem mehrsprachigen Shop — dafür wurde das meiste davon gebaut.",
      },
      {
        q: "Was passiert mit meinen Übersetzungen, wenn ich den Originaltext ändere?",
        a: "Das ist die Frage, für die es diese App gibt. Eine Übersetzung eines Textes, den es nicht mehr gibt, ist schlimmer als gar keine — ein geänderter Ausgangstext führt also dazu, dass die Übersetzungen entweder neu gemacht oder entfernt werden. Was von beidem passiert, ist Ihre Einstellung und keine versteckte Voreinstellung.",
      },
      {
        q: "Werden meine Shop-Daten an den KI-Anbieter geschickt?",
        a: "Nur der Text des Feldes, das geschrieben wird, plus der Kontext, der dafür nötig ist — und nur, wenn Sie eine Generierung anstoßen. Ob die KI Ihre Produktbilder ansehen darf, ist eine einzige shopweite Einstellung, die aus ist, solange Sie sie nicht einschalten.",
      },
      {
        q: "Funktioniert das auch außerhalb des Shopify-Admins?",
        a: "Diese Webseite schon. Die App selbst lebt in Ihrem Shopify-Admin — dort, wo Ihre Inhalte sind.",
      },
    ],
  },

  cta: {
    title: "Im eigenen Shop ansehen",
    body: "Die App installiert sich in Ihren Shopify-Admin und liest Ihren Katalog. Geschrieben wird nichts, bis Sie speichern.",
    button: "Bei Shopify installieren",
  },

  footer: {
    tagline: "KI-Texte, SEO und Übersetzungen für Shopify.",
    product: "Produkt",
    legal: "Rechtliches",
    privacy: "Datenschutz",
    terms: "AGB",
    support: "Support",
    contact: "Kontakt",
    rights: "Alle Rechte vorbehalten.",
  },

  languageHint: {
    text: "Diese Seite gibt es auch auf {language}.",
    action: "Wechseln",
    dismiss: "Schließen",
  },

  error: {
    title: "Da ist etwas schiefgelaufen",
    body: "Diese Seite konnte nicht angezeigt werden. Versuchen Sie es gleich noch einmal.",
  },

  notFound: {
    title: "Seite nicht gefunden",
    body: "Diese Adresse gibt es auf dieser Seite nicht.",
    action: "Zurück zum Anfang",
  },
};
