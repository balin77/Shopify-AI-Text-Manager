/**
 * Default AI Instructions
 *
 * These defaults are based on SEO best practices and can be reset by users.
 * Each entity type (Products, Collections, Blogs, Pages, Policies) has its own set of instructions.
 */

export interface EntityInstructions {
  titleFormat: string;
  titleInstructions: string;
  descriptionFormat: string;
  descriptionInstructions: string;
  handleFormat: string;
  handleInstructions: string;
  seoTitleFormat: string;
  seoTitleInstructions: string;
  metaDescFormat: string;
  metaDescInstructions: string;
  altTextFormat?: string;  // Only for products
  altTextInstructions?: string;  // Only for products
}

// PRODUCTS - Optimized for e-commerce SEO
export const DEFAULT_PRODUCT_INSTRUCTIONS: EntityInstructions = {
  titleFormat: 'Premium Leder Geldbörse - Elegant & Langlebig',
  titleInstructions: 'Du bist ein E-Commerce-Experte. Erstelle einen prägnanten, verkaufsstarken Produkttitel von maximal 60 Zeichen. Nenne Material, Hauptmerkmal und einen Vorteil. Der Titel sollte SEO-freundlich sein und Aufmerksamkeit erregen. Gib nur den fertigen Titel zurück, ohne Erklärungen.',

  descriptionFormat: '<h2>Entdecken Sie Handwerkskunst in Perfektion</h2>\n<p>Diese <strong>handgefertigte Leder Geldbörse</strong> vereint zeitloses Design mit außergewöhnlicher Qualität. Jedes Stück wird von erfahrenen Handwerkern aus bestem Vollrindleder gefertigt.</p>\n<h3>Ihre Vorteile</h3>\n<ul>\n<li>Premium Vollrindleder für maximale Langlebigkeit</li>\n<li>Zeitloses Design passend zu jedem Stil</li>\n<li>Praktische Fächeraufteilung für optimale Organisation</li>\n<li>Handgefertigt mit Liebe zum Detail</li>\n</ul>\n<p>Ein treuer Begleiter für viele Jahre - nachhaltig und stilvoll.</p>',
  descriptionInstructions: 'Du bist ein E-Commerce-Experte. Erstelle eine detaillierte, ansprechende Produktbeschreibung von 150-250 Wörtern. Strukturiere den Text mit H2/H3 Überschriften. Beginne mit einem emotionalen Hook. Stelle dann das Produkt vor. Nutze Aufzählungen (<ul>, <li>) für Vorteile und Features. Verwende Storytelling. Hebe USPs hervor. Ende mit einem Call-to-Action oder Nutzenversprechen. Nutze HTML-Formatierung (<p>, <strong>, <h2>, <h3>, <ul>, <li>). Gib nur die HTML-Beschreibung zurück, ohne Erklärungen.',

  handleFormat: 'premium-leder-geldboerse-handgefertigt',
  handleInstructions: 'Du bist ein SEO-Experte. Erstelle einen SEO-freundlichen URL-Slug (handle) mit 3-5 relevanten Keywords. Nutze nur Kleinbuchstaben (a-z), Ziffern (0-9) und Bindestriche (-) als Trennzeichen. Keine Umlaute - wandle sie um (ä→ae, ö→oe, ü→ue, ß→ss). Keine Leerzeichen, Unterstriche oder Sonderzeichen. Gib nur den fertigen Slug zurück.',

  seoTitleFormat: 'Premium Leder Geldbörse kaufen | Handgefertigt',
  seoTitleInstructions: 'Du bist ein SEO-Experte. Erstelle einen optimierten SEO-Titel von 50-60 Zeichen. Platziere das Hauptkeyword am Anfang. Nutze Pipe (|) als Trenner. Baue ein Call-to-Action-Wort ein (kaufen, bestellen, entdecken). Füge Markennamen am Ende hinzu, wenn vorhanden. Gib nur den fertigen SEO-Titel zurück, ohne Erklärungen.',

  metaDescFormat: 'Handgefertigte Premium Leder Geldbörse aus Vollrindleder. Zeitlos, langlebig und stilvoll. Nachhaltige Handwerkskunst für höchste Ansprüche. Jetzt entdecken!',
  metaDescInstructions: 'Du bist ein SEO-Experte. Erstelle eine überzeugende Meta-Description von 150-160 Zeichen. Binde 2-3 relevante Keywords natürlich ein. Kommuniziere das Nutzenversprechen klar. Ende mit einer Handlungsaufforderung. Nutze aktive Sprache ohne Füllwörter. Gib nur die fertige Meta-Description zurück, ohne Erklärungen.',

  altTextFormat: 'Premium Leder Geldbörse aus dunkelbraunem Vollrindleder auf Holztisch',
  altTextInstructions: 'Du bist ein SEO-Experte. Erstelle einen beschreibenden Alt-Text von 60-125 Zeichen. Beschreibe sachlich was auf dem Bild zu sehen ist (nicht was es bewirkt). Nenne Farbe, Material und Kontext. Baue das Hauptkeyword ein. Vermeide Marketing-Sprache. Formuliere präzise für Barrierefreiheit. Gib nur den fertigen Alt-Text zurück, ohne Erklärungen.',
};

// COLLECTIONS - Optimized for category/collection pages
export const DEFAULT_COLLECTION_INSTRUCTIONS: EntityInstructions = {
  titleFormat: 'Leder Accessoires - Handgefertigt & Zeitlos',
  titleInstructions: 'Du bist ein E-Commerce-Experte. Erstelle einen prägnanten Collection-Titel von maximal 60 Zeichen. Beschreibe die Produktkategorie klar und ansprechend. Gib nur den fertigen Titel zurück, ohne Erklärungen.',

  descriptionFormat: '<h2>Handgefertigte Leder Accessoires für jeden Anlass</h2>\n<p>Entdecken Sie unsere exklusive Kollektion an <strong>handgefertigten Leder Accessoires</strong>. Jedes Produkt wird mit traditionellen Techniken und höchster Sorgfalt gefertigt.</p>\n<p>Von eleganten Geldbörsen über praktische Kartenetuis bis hin zu stilvollen Gürteln - hier finden Sie zeitlose Begleiter für den Alltag.</p>\n<h3>Das Besondere an unserer Kollektion</h3>\n<ul>\n<li>100% Vollrindleder aus nachhaltiger Produktion</li>\n<li>Traditionelle Handwerkskunst seit über 50 Jahren</li>\n<li>Zeitlose Designs die nie aus der Mode kommen</li>\n<li>Faire Produktion in Europa</li>\n</ul>',
  descriptionInstructions: 'Du bist ein E-Commerce-Experte. Erstelle eine überzeugende Collection-Beschreibung von 100-200 Wörtern. Gib eine Übersicht über die Produktkategorie. Beschreibe den gemeinsamen Nenner aller Produkte. Verwende H2/H3 Überschriften für Struktur. Nutze Aufzählungen (<ul>, <li>) für Features. Kommuniziere die Collection-USPs. Binde SEO-Keywords natürlich ein. Nutze HTML-Formatierung. Gib nur die HTML-Beschreibung zurück, ohne Erklärungen.',

  handleFormat: 'leder-accessoires-handgefertigt',
  handleInstructions: 'Du bist ein SEO-Experte. Erstelle einen SEO-freundlichen URL-Slug (handle) mit 3-5 relevanten Keywords. Nutze nur Kleinbuchstaben (a-z), Ziffern (0-9) und Bindestriche (-). Keine Umlaute - wandle sie um (ä→ae, ö→oe, ü→ue, ß→ss). Gib nur den fertigen Slug zurück.',

  seoTitleFormat: 'Leder Accessoires handgefertigt kaufen | Nachhaltig',
  seoTitleInstructions: 'Du bist ein SEO-Experte. Erstelle einen optimierten SEO-Titel von 50-60 Zeichen. Platziere das Category-Keyword am Anfang. Füge ein Differenzierungsmerkmal hinzu (handgefertigt, bio, premium). Nutze eine Call-to-Action wenn möglich. Verwende Pipe (|) als Trenner. Gib nur den fertigen SEO-Titel zurück, ohne Erklärungen.',

  metaDescFormat: 'Hochwertige Leder Accessoires aus traditioneller Handwerkskunst. Geldbörsen, Gürtel & mehr aus nachhaltigem Vollrindleder. Fair & nachhaltig. Jetzt entdecken!',
  metaDescInstructions: 'Du bist ein SEO-Experte. Erstelle eine überzeugende Meta-Description von 150-160 Zeichen. Beschreibe die Produktkategorie. Nenne 2-3 Produktbeispiele. Kommuniziere USPs. Baue Keywords natürlich ein. Ende mit einer Handlungsaufforderung. Gib nur die fertige Meta-Description zurück, ohne Erklärungen.',
};

// BLOGS/ARTICLES - Optimized for content marketing
export const DEFAULT_BLOG_INSTRUCTIONS: EntityInstructions = {
  titleFormat: '5 Tipps für die richtige Pflege Ihrer Lederprodukte',
  titleInstructions: 'Du bist ein Content-Marketing-Experte. Erstelle einen ansprechenden Blog-Titel von maximal 60 Zeichen. Kommuniziere klar den Nutzen für den Leser. Nutze Zahlen wenn möglich. Gib nur den fertigen Titel zurück, ohne Erklärungen.',

  descriptionFormat: '<p>Lederprodukte sind langlebige Begleiter - wenn man sie richtig pflegt. In diesem Artikel zeigen wir Ihnen die <strong>5 wichtigsten Pflegetipps</strong>, mit denen Ihre Lederwaren jahrzehntelang wie neu aussehen.</p>\n<h2>1. Regelmäßiges Reinigen</h2>\n<p>Entfernen Sie Staub und Schmutz wöchentlich mit einem weichen, leicht feuchten Tuch...</p>\n<h2>2. Die richtige Lederpflege</h2>\n<p>Verwenden Sie alle 3-6 Monate eine hochwertige Lederpflege oder Lederfett...</p>',
  descriptionInstructions: 'Du bist ein Content-Marketing-Experte. Erstelle einen informativen, gut strukturierten Blog-Artikel von 300-800 Wörtern. Strukturiere mit H2/H3 Überschriften. Beginne mit einem Hook der das Problem oder den Nutzen adressiert. Verwende kurze Absätze (2-4 Sätze). Nutze Listen und Aufzählungen für bessere Lesbarkeit. Schreibe informativ aber zugänglich. Nutze HTML-Formatierung (<p>, <h2>, <h3>, <strong>, <ul>, <li>). Gib nur den HTML-Artikel zurück, ohne Erklärungen.',

  handleFormat: 'lederpflege-tipps-anleitung',
  handleInstructions: 'Du bist ein SEO-Experte. Erstelle einen SEO-freundlichen URL-Slug (handle) mit 3-5 relevanten Keywords. Nutze nur Kleinbuchstaben (a-z), Ziffern (0-9) und Bindestriche (-). Keine Umlaute - wandle sie um (ä→ae, ö→oe, ü→ue, ß→ss). Gib nur den fertigen Slug zurück.',

  seoTitleFormat: 'Lederpflege: 5 Tipps für langlebige Schönheit',
  seoTitleInstructions: 'Du bist ein SEO-Experte. Erstelle einen optimierten SEO-Titel von 50-60 Zeichen. Platziere das Hauptkeyword am Anfang. Nutze Zahlen wenn möglich. Füge Wörter wie "Anleitung", "Tipps", "Ratgeber" hinzu für höhere Klickrate. Kommuniziere Expertise. Gib nur den fertigen SEO-Titel zurück, ohne Erklärungen.',

  metaDescFormat: 'Lederpflege leicht gemacht: 5 bewährte Tipps für die richtige Pflege Ihrer Lederprodukte. Von Reinigung bis Imprägnierung - so bleibt Leder jahrzehntelang schön.',
  metaDescInstructions: 'Du bist ein SEO-Experte. Erstelle eine ansprechende Meta-Description von 150-160 Zeichen. Fasse den Artikel-Nutzen zusammen. Verwende das Hauptkeyword. Wecke Neugier. Sprich den Leser direkt an. Vermeide Clickbait. Gib nur die fertige Meta-Description zurück, ohne Erklärungen.',
};

// PAGES - Optimized for informational pages
export const DEFAULT_PAGE_INSTRUCTIONS: EntityInstructions = {
  titleFormat: 'Über uns - Traditionelle Handwerkskunst seit 1970',
  titleInstructions: 'Du bist ein Content-Experte. Erstelle einen klaren, beschreibenden Seiten-Titel von maximal 60 Zeichen. Kommuniziere den Zweck der Seite. Gib nur den fertigen Titel zurück, ohne Erklärungen.',

  descriptionFormat: '<h1>Handwerkskunst mit Tradition</h1>\n<p>Seit über 50 Jahren steht unser Familienunternehmen für höchste Qualität in der Lederverarbeitung. Was 1970 als kleine Werkstatt begann, ist heute ein Synonym für nachhaltige, handgefertigte Lederprodukte.</p>\n<h2>Unsere Geschichte</h2>\n<p>Alles begann mit der Leidenschaft unseres Gründers für traditionelles Lederhandwerk...</p>\n<h2>Unsere Werte</h2>\n<ul>\n<li><strong>Qualität:</strong> Nur beste Materialien und Verarbeitung</li>\n<li><strong>Nachhaltigkeit:</strong> Faire und umweltschonende Produktion</li>\n<li><strong>Tradition:</strong> Bewährte Handwerkstechniken</li>\n</ul>',
  descriptionInstructions: 'Du bist ein Content-Experte. Erstelle einen informativen Seiteninhalt von 200-400 Wörtern (je nach Seitentyp). Verwende H1/H2 Überschriften für Struktur. Schreibe authentisch und persönlich bei "Über uns"-Seiten. Klar und informativ bei Service-Seiten. Rechtssicher bei rechtlichen Seiten. Nutze HTML-Formatierung (<h1>, <h2>, <p>, <strong>, <ul>, <li>). Gib nur den HTML-Inhalt zurück, ohne Erklärungen.',

  handleFormat: 'ueber-uns-tradition-handwerk',
  handleInstructions: 'Du bist ein SEO-Experte. Erstelle einen SEO-freundlichen URL-Slug (handle) mit 3-5 relevanten Keywords. Nutze nur Kleinbuchstaben (a-z), Ziffern (0-9) und Bindestriche (-). Keine Umlaute - wandle sie um (ä→ae, ö→oe, ü→ue, ß→ss). Gib nur den fertigen Slug zurück.',

  seoTitleFormat: 'Über uns - Traditionelle Lederverarbeitung seit 1970',
  seoTitleInstructions: 'Du bist ein SEO-Experte. Erstelle einen optimierten SEO-Titel von 50-60 Zeichen. Beginne mit dem Seitentyp (Über uns, Kontakt, etc.). Füge USP oder Alleinstellungsmerkmal hinzu. Integriere Markenname wenn Platz vorhanden. Vermeide Keyword-Stuffing. Gib nur den fertigen SEO-Titel zurück, ohne Erklärungen.',

  metaDescFormat: 'Lernen Sie uns kennen: Seit 1970 fertigen wir hochwertige Lederprodukte in traditioneller Handwerkskunst. Erfahren Sie mehr über unsere Geschichte & Werte.',
  metaDescInstructions: 'Du bist ein SEO-Experte. Erstelle eine informative Meta-Description von 150-160 Zeichen. Beschreibe den Seiteninhalt. Kommuniziere den Nutzen für den Besucher. Schreibe persönlich bei "Über uns"-Seiten, sachlich bei rechtlichen Seiten. Nutze natürliche Sprache. Gib nur die fertige Meta-Description zurück, ohne Erklärungen.',
};

// POLICIES - Optimized for legal/policy pages
export const DEFAULT_POLICY_INSTRUCTIONS: EntityInstructions = {
  titleFormat: '', // Not used - titles are auto-generated by Shopify
  titleInstructions: '',

  descriptionFormat: '<h2>Widerrufsrecht</h2>\n<p>Sie haben das Recht, binnen vierzehn Tagen ohne Angabe von Gründen diesen Vertrag zu widerrufen.</p>\n<h3>Widerrufsfrist</h3>\n<p>Die Widerrufsfrist beträgt vierzehn Tage ab dem Tag, an dem Sie oder ein von Ihnen benannter Dritter...</p>\n<h3>Folgen des Widerrufs</h3>\n<p>Wenn Sie diesen Vertrag widerrufen, haben wir Ihnen alle Zahlungen, die wir von Ihnen erhalten haben...</p>',
  descriptionInstructions: 'Du bist ein Rechts- und Content-Experte. Erstelle einen rechtssicheren und klar formulierten Policy-Text. Verwende H2/H3 Überschriften für Abschnitte. Schreibe in kurzen, verständlichen Sätzen. Nutze Aufzählungen für bessere Übersichtlichkeit. Vermeide Marketing-Sprache. Bleibe professionell und sachlich. Achte auf Rechtskonformität (hinweis: Text sollte von einem Anwalt geprüft werden). Nutze HTML-Formatierung (<h2>, <h3>, <p>, <ul>, <li>). Gib nur den HTML-Text zurück, ohne Erklärungen.',

  handleFormat: '', // Not used for policies
  handleInstructions: '',

  seoTitleFormat: '', // Not used for policies (SEO not primary goal)
  seoTitleInstructions: '',

  metaDescFormat: '', // Not used for policies (SEO not primary goal)
  metaDescInstructions: '',
};

// Entity type type definition
export type EntityType = 'products' | 'collections' | 'blogs' | 'pages' | 'policies';

// Get default instructions for an entity type
export function getDefaultInstructions(entityType: EntityType): EntityInstructions {
  switch (entityType) {
    case 'products':
      return DEFAULT_PRODUCT_INSTRUCTIONS;
    case 'collections':
      return DEFAULT_COLLECTION_INSTRUCTIONS;
    case 'blogs':
      return DEFAULT_BLOG_INSTRUCTIONS;
    case 'pages':
      return DEFAULT_PAGE_INSTRUCTIONS;
    case 'policies':
      return DEFAULT_POLICY_INSTRUCTIONS;
    default:
      return DEFAULT_PRODUCT_INSTRUCTIONS;
  }
}

// Get field-specific default (for reset individual fields)
export function getDefaultForField(entityType: EntityType, fieldName: keyof EntityInstructions): string {
  const defaults = getDefaultInstructions(entityType);
  return defaults[fieldName] || '';
}

// Check which fields are available for an entity type
export function getAvailableFields(entityType: EntityType): (keyof EntityInstructions)[] {
  switch (entityType) {
    case 'products':
      return ['titleFormat', 'titleInstructions', 'descriptionFormat', 'descriptionInstructions',
              'handleFormat', 'handleInstructions', 'seoTitleFormat', 'seoTitleInstructions',
              'metaDescFormat', 'metaDescInstructions', 'altTextFormat', 'altTextInstructions'];
    case 'collections':
      return ['titleFormat', 'titleInstructions', 'descriptionFormat', 'descriptionInstructions',
              'handleFormat', 'handleInstructions', 'seoTitleFormat', 'seoTitleInstructions',
              'metaDescFormat', 'metaDescInstructions'];
    case 'blogs':
      return ['titleFormat', 'titleInstructions', 'descriptionFormat', 'descriptionInstructions',
              'handleFormat', 'handleInstructions', 'seoTitleFormat', 'seoTitleInstructions',
              'metaDescFormat', 'metaDescInstructions'];
    case 'pages':
      return ['titleFormat', 'titleInstructions', 'descriptionFormat', 'descriptionInstructions',
              'handleFormat', 'handleInstructions', 'seoTitleFormat', 'seoTitleInstructions',
              'metaDescFormat', 'metaDescInstructions'];
    case 'policies':
      return ['descriptionFormat', 'descriptionInstructions']; // Only body/description is editable
    default:
      return [];
  }
}
