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
    pricing: "Preise",
    roadmap: "Roadmap",
    faq: "Fragen",
    guide: "Anleitung",
    compare: "Vergleich",
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
    compare: "Mit anderen Übersetzungs-Apps vergleichen",
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
    guideLink: "So geht es — zur Anleitung",
    compareLink: "Wie schneidet die App gegenüber Translate & Adapt, Weglot und anderen ab?",
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
          "Andere Bilder und Videos je Sprache und Markt: Produktgalerie, Teilen-Bild und Theme-Bilder",
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

  pricing: {
    title: "Pläne und Preise",
    intro:
      "Vier Pläne, die sich darin unterscheiden, wie viel Ihres Shops sie abdecken — nicht darin, wie viele Sprachen Sie nutzen dürfen. Jeder Plan übersetzt in alle Ihre Sprachen.",
    trial: "Jeder bezahlte Plan beginnt mit {days} Tagen kostenloser Testphase. Abgerechnet über Shopify, jederzeit kündbar.",
    modeLabel: "Wie die KI bezahlt wird",
    modeOwnKey: "Mit eigenem KI-Schlüssel",
    modeIncluded: "KI inklusive",
    modeOwnKeyHint:
      "Sie verbinden Ihren eigenen Schlüssel von OpenAI, Anthropic, Gemini, DeepSeek, Grok oder HuggingFace und bezahlen den Anbieter direkt für das, was Sie nutzen.",
    modeIncludedHint:
      "Kein Schlüssel und keine zweite Rechnung: Ein monatliches KI-Volumen ist im Preis enthalten. Einen eigenen Schlüssel können Sie trotzdem jederzeit verbinden.",
    free: "Kostenlos",
    perMonth: "/ Monat",
    recommended: "Am beliebtesten",
    choose: "Installieren und diesen Plan wählen",
    chooseFree: "Kostenlos installieren",
    limitsLine: "{products} Produkte · {collections} Kollektionen",
    everythingIn: "Alles aus {plan}, dazu:",
    included: "Enthalten:",
    tasterLine: "Einmalig etwa {taster} KI-Aktionen zum Testen, ohne Schlüssel",
    moreInTable: "+ {n} weitere in der Tabelle unten",
    plans: {
      free: {
        tagline: "Zum Ausprobieren an einem kleinen Katalog.",
      },
      basic: {
        tagline: "Für kleine Shops.",
      },
      pro: {
        tagline: "Für wachsende Shops.",
      },
      max: {
        tagline: "Für große Kataloge.",
      },
    },
    includedVolume: {
      free: "Enthält einmalig etwa {taster} KI-Aktionen zum Testen",
      basic: "KI inklusive: etwa 300–500 Produkte pro Monat, je in eine Sprache übersetzt",
      pro: "KI inklusive: etwa 600–1.000 Produkte pro Monat, je in eine Sprache übersetzt",
      max: "KI inklusive: etwa 1.500–2.500 Produkte pro Monat, je in eine Sprache übersetzt",
    },
    tableTitle: "Die Pläne im Vergleich",
    tableIntro: "Was jeder Plan enthält, Zeile für Zeile. Alle Zahlen gelten pro Shop.",
    planColumn: "Funktion",
    priceRow: "Preis",
    groups: {
      content: "Inhalte, die Sie bearbeiten und übersetzen",
      workflow: "Übersetzung und KI",
      images: "Bilder",
      seo: "SEO und KI-Sichtbarkeit",
    },
    rows: {
      products: { label: "Produkte", help: "Produkte, die die App lädt und bearbeitet." },
      collections: { label: "Kollektionen" },
      pages: { label: "Seiten" },
      articles: { label: "Blogs und Artikel", help: "Anzahl der Artikel." },
      policies: { label: "Shop-Richtlinien", help: "Rückgabe, Datenschutz, Versand und AGB." },
      menus: { label: "Navigationsmenüs", help: "Menüs bearbeiten und übersetzen." },
      metaobjects: { label: "Metaobjekte" },
      themeTranslations: { label: "Theme-Texte", help: "Texte und Einstellungen Ihres Themes, übersetzt." },
      checkoutTexts: { label: "Versand- und Checkout-Texte" },
      notifications: { label: "Benachrichtigungen und Lieferscheine", help: "Die E-Mails und Dokumente, die Shopify verschickt." },
      directTranslations: { label: "Direkte Übersetzungen", help: "Jeden Text übersetzen, der in Ihrem Shop erscheint." },
      languages: { label: "Sprachen" },
      ownKey: { label: "Eigener KI-Schlüssel", help: "Sechs Anbieter zur Auswahl." },
      aiInstructions: { label: "Eigene KI-Anweisungen", help: "Ton und Regeln pro Feld, in jedem Prompt verwendet." },
      bulkEditor: { label: "Bulk-Editor und CSV-Export", help: "Eine Tabelle über Ihren ganzen Shop." },
      csvImport: { label: "CSV-Import" },
      translateMissing: { label: "Alle fehlenden Übersetzungen in einem Lauf" },
      autoTranslate: { label: "Automatische Übersetzung", help: "Ändert sich ein Text — in der App oder im Shopify-Admin —, werden seine Übersetzungen erneuert." },
      productImages: { label: "Produktbilder" },
      imageSuite: { label: "Bildmanager", help: "Varianten-Galerien, Bulk-Upload, Alt-Texte in Serie, SKU-Namen." },
      mediaPerLanguage: { label: "Bilder und Videos je Sprache", help: "Produktbilder, Produktvideos und Theme-Bilder pro Sprache und Markt ersetzen." },
      imageOperations: { label: "Bild-Uploads und WebP-Konvertierungen" },
      seoAudit: { label: "SEO-Audit, strukturierte Daten, Weiterleitungen, hreflang" },
      pageSpeed: { label: "PageSpeed-Messungen" },
      keywords: { label: "Verfolgte Keywords" },
      aiDiscovery: { label: "KI-Discovery (agents.md, llms.txt)", help: "Was KI-Assistenten über Ihren Shop lesen." },
      crawl: { label: "Shop-Crawl und On-Page-Bericht" },
      searchConsole: { label: "Google Search Console" },
      internalLinks: { label: "Vorschläge für interne Links" },
      sitemap: { label: "Sitemap-Steuerung" },
      indexNow: { label: "IndexNow-Übermittlungen" },
      scoreHistory: { label: "Verlauf des SEO-Scores" },
      scheduled: { label: "Automatisches nächtliches Audit und wöchentlicher Crawl" },
      seoBulk: { label: "Einträge pro SEO-Sammelkorrektur" },
    },
    formats: {
      imageOperations: "{n} / Monat",
      pageSpeed: "{n} / Tag",
      searchConsole: "{n} Tage Daten",
      indexNow: "{n} / Monat",
      scoreHistory: "{n} Tage",
    },
    values: {
      yes: "Enthalten",
      no: "Nicht enthalten",
      unlimited: "Unbegrenzt",
      featuredOnly: "Hauptbild",
      allImages: "Alle Bilder",
    },
    tableNote:
      "Die Limits gelten für das, was die App bearbeitet. Ihr Shop selbst darf größer sein — Inhalte über dem Limit bleiben einfach, wie sie sind.",
    compareLink: "Wie schneiden diese Preise gegenüber anderen Apps ab?",
    faqTitle: "Fragen zur Abrechnung",
    faq: [
      {
        q: "Wie wird die App abgerechnet?",
        a: "Über Ihre normale Shopify-Rechnung, in Euro. Es gibt kein separates Konto und keine Kreditkarte, die Sie auf dieser Seite eingeben müssten.",
      },
      {
        q: "Gibt es eine kostenlose Testphase?",
        a: "Ja. Jeder bezahlte Plan beginnt mit {days} Tagen Testphase, und der kostenlose Plan ist gar nicht befristet. Wenn Sie in der Testphase kündigen, zahlen Sie nichts.",
      },
      {
        q: "Kann ich den Plan später wechseln?",
        a: "Ja, jederzeit in den Einstellungen der App. Shopify passt die Abrechnung für Sie an. Ein Wechsel nach unten löscht keine Inhalte in Ihrem Shopify-Shop.",
      },
      {
        q: "Eigener KI-Schlüssel oder KI inklusive — was soll ich wählen?",
        a: "Mit eigenem Schlüssel bezahlen Sie den KI-Anbieter direkt für das, was Sie nutzen, und wählen das Modell selbst. Mit KI inklusive gibt es nichts einzurichten und eine Rechnung für alles. Beide Varianten haben dieselben Funktionen.",
      },
      {
        q: "Kosten mehr Sprachen mehr?",
        a: "Nein. Jeder Plan enthält alle Ihre Sprachen. Die Pläne unterscheiden sich in der Zahl der Produkte und in den Inhaltstypen, die sie abdecken.",
      },
    ],
  },


  guide: {
    title: "Anleitung",
    intro:
      "Wie jeder Teil der App funktioniert, Thema für Thema. Jedes Thema erklärt, was die Funktion tut und wie Sie sie nutzen; zu jedem wird gerade ein kurzes Video aufgenommen.",
    topicCount: "{count} Themen",
    videoBadge: "Video",
    videoPendingBadge: "Video folgt",
    videoPending: "Video folgt in Kürze",
    videoPendingBody: "Das Video zu diesem Thema wird gerade aufgenommen. Bis dahin erklärt der Text unten alles Nötige.",
    tips: "Gut zu wissen",
    inThisCategory: "In dieser Kategorie",
    allTopics: "Alle Themen",
    previous: "Zurück",
    next: "Weiter",
    helpTitle: "Noch Fragen?",
    helpBody: "Schreiben Sie uns — wir beantworten jede Frage, und die guten landen in dieser Anleitung.",
    helpAction: "Support kontaktieren",
  },

  /** Labels of the click-to-load video player the guide (and the home page) use. */
  video: {
    pending: "Video folgt",
    heroTitle: "ContentPilot im Überblick",
    loadExternal: "Laden und abspielen",
    externalNote:
      "Beim Abspielen wird das Video von einem externen Anbieter geladen, der Cookies setzen kann.",
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

  roadmap: {
    title: "Roadmap",
    intro:
      "Was als Nächstes kommt, was abgewogen wird und was nur entsteht, wenn jemand danach fragt. Die Reihenfolge innerhalb eines Abschnitts ist die Priorität; Termine gibt es keine, weil ein öffentlicher Termin, der rutscht, wie ein gebrochenes Versprechen wirkt.",
    note: "Diese Seite wird aus derselben Datei erzeugt, in der der Entwicklungsplan steht — ändert sich dort ein Status, ändert er sich hier.",
    sections: {
      inProgress: "In Arbeit",
      planned: "Als Nächstes",
      considering: "In Überlegung",
      onRequest: "Nur auf Anfrage",
      shipped: "Kürzlich ausgeliefert",
    },
    shippedOn: "Ausgeliefert",
    areas: {
      ai: "KI-Texte",
      translations: "Übersetzungen",
      bulk: "Bulk-Editor",
      seo: "SEO",
      aeo: "KI-Discovery",
      media: "Bilder und Medien",
      ads: "Werbung",
      structure: "Struktur",
      platform: "Plattform",
      website: "Diese Website",
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
        a: "Den, den Sie verbinden: Anthropic, OpenAI, Gemini, DeepSeek, Grok oder HuggingFace. Mit Ihrem eigenen Schlüssel bleiben die Kosten und die Wahl des Modells bei Ihnen. Wer keinen Schlüssel einrichten möchte, bekommt jeden bezahlten Plan auch mit inklusive KI.",
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
