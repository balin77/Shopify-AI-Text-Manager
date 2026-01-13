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
  titleFormat: 'Premium Leder Geldbörse - Elegant & Langlebig | Handgefertigt',
  titleInstructions: 'Maximal 60 Zeichen. Nenne Material, Hauptmerkmal und einen Vorteil.',

  descriptionFormat: '<h2>Entdecken Sie Handwerkskunst in Perfektion</h2>\n<p>Diese <strong>handgefertigte Leder Geldbörse</strong> vereint zeitloses Design mit außergewöhnlicher Qualität. Jedes Stück wird von erfahrenen Handwerkern aus bestem Vollrindleder gefertigt.</p>\n<h3>Ihre Vorteile</h3>\n<ul>\n<li>Premium Vollrindleder für maximale Langlebigkeit</li>\n<li>Zeitloses Design passend zu jedem Stil</li>\n<li>Praktische Fächeraufteilung für optimale Organisation</li>\n<li>Handgefertigt mit Liebe zum Detail</li>\n</ul>\n<p>Ein treuer Begleiter für viele Jahre - nachhaltig und stilvoll.</p>',
  descriptionInstructions: '150-250 Wörter. Strukturiere den Text mit H2/H3 Überschriften. Beginne mit einem emotionalen Hook. Stelle dann das Produkt vor. Nutze Aufzählungen für Vorteile/Features. Verwende Storytelling. Hebe USPs hervor. Endet mit einem Call-to-Action oder Nutzenversprechen. HTML-formatiert.',

  handleFormat: 'premium-leder-geldboerse-handgefertigt',
  handleInstructions: 'Nur Kleinbuchstaben und Bindestriche. Keine Umlaute (ä→a, ö→o, ü→u, ß→ss). 3-5 relevante Keywords.',

  seoTitleFormat: 'Premium Leder Geldbörse kaufen | Handgefertigt & Nachhaltig',
  seoTitleInstructions: '50-60 Zeichen (Google-optimal). Hauptkeyword am Anfang. Pipe (|) als Trenner. Call-to-Action-Wort einbauen (kaufen, bestellen, entdecken). Markennamen am Ende wenn vorhanden.',

  metaDescFormat: 'Handgefertigte Premium Leder Geldbörse aus Vollrindleder. Zeitlos, langlebig und stilvoll. Nachhaltige Handwerkskunst für höchste Ansprüche. Jetzt entdecken!',
  metaDescInstructions: '150-160 Zeichen (Google-optimal). 2-3 relevante Keywords natürlich einbinden. Nutzenversprechen klar kommunizieren. Mit Handlungsaufforderung enden. Keine Füllwörter. Aktive Sprache.',

  altTextFormat: 'Premium Leder Geldbörse aus dunkelbraunem Vollrindleder auf Holztisch',
  altTextInstructions: '60-125 Zeichen. Beschreibe was auf dem Bild zu sehen ist (nicht was es bewirkt). Nenne Farbe, Material, Kontext. Hauptkeyword einbauen. Keine Marketing-Sprache. Sachlich und präzise für Barrierefreiheit.',
};

// COLLECTIONS - Optimized for category/collection pages
export const DEFAULT_COLLECTION_INSTRUCTIONS: EntityInstructions = {
  titleFormat: 'Leder Accessoires - Handgefertigt & Zeitlos',
  titleInstructions: 'Maximal 60 Zeichen. Beschreibe die Produktkategorie prägnant.',

  descriptionFormat: '<h2>Handgefertigte Leder Accessoires für jeden Anlass</h2>\n<p>Entdecken Sie unsere exklusive Kollektion an <strong>handgefertigten Leder Accessoires</strong>. Jedes Produkt wird mit traditionellen Techniken und höchster Sorgfalt gefertigt.</p>\n<p>Von eleganten Geldbörsen über praktische Kartenetuis bis hin zu stilvollen Gürteln - hier finden Sie zeitlose Begleiter für den Alltag.</p>\n<h3>Das Besondere an unserer Kollektion</h3>\n<ul>\n<li>100% Vollrindleder aus nachhaltiger Produktion</li>\n<li>Traditionelle Handwerkskunst seit über 50 Jahren</li>\n<li>Zeitlose Designs die nie aus der Mode kommen</li>\n<li>Faire Produktion in Europa</li>\n</ul>',
  descriptionInstructions: '100-200 Wörter. Übersicht über die Produktkategorie. Beschreibe den gemeinsamen Nenner aller Produkte. Verwende H2/H3 für Struktur. Nutze Aufzählungen. Kommuniziere die Collection-USPs. SEO-Keywords natürlich einbinden. HTML-formatiert.',

  handleFormat: 'leder-accessoires-handgefertigt',
  handleInstructions: 'Nur Kleinbuchstaben und Bindestriche. Keine Umlaute (ä→a, ö→o, ü→u, ß→ss). 2-4 Keywords.',

  seoTitleFormat: 'Leder Accessoires handgefertigt kaufen | Nachhaltig & Zeitlos',
  seoTitleInstructions: '50-60 Zeichen. Category-Keyword am Anfang. Füge Differenzierungsmerkmal hinzu (handgefertigt, bio, premium). Call-to-Action wenn möglich. Pipe (|) als Trenner.',

  metaDescFormat: 'Hochwertige Leder Accessoires aus traditioneller Handwerkskunst. Geldbörsen, Gürtel & mehr aus nachhaltigem Vollrindleder. Fair produziert in Europa. Entdecken Sie zeitlose Qualität!',
  metaDescInstructions: '150-160 Zeichen. Beschreibe die Produktkategorie. Nenne 2-3 Produktbeispiele. USPs kommunizieren. Keywords natürlich einbauen. Handlungsaufforderung am Ende.',
};

// BLOGS/ARTICLES - Optimized for content marketing
export const DEFAULT_BLOG_INSTRUCTIONS: EntityInstructions = {
  titleFormat: '5 Tipps für die richtige Pflege Ihrer Lederprodukte',
  titleInstructions: 'Maximal 60 Zeichen. Kommuniziere klar den Nutzen.',

  descriptionFormat: '<p>Lederprodukte sind langlebige Begleiter - wenn man sie richtig pflegt. In diesem Artikel zeigen wir Ihnen die <strong>5 wichtigsten Pflegetipps</strong>, mit denen Ihre Lederwaren jahrzehntelang wie neu aussehen.</p>\n<h2>1. Regelmäßiges Reinigen</h2>\n<p>Entfernen Sie Staub und Schmutz wöchentlich mit einem weichen, leicht feuchten Tuch...</p>\n<h2>2. Die richtige Lederpflege</h2>\n<p>Verwenden Sie alle 3-6 Monate eine hochwertige Lederpflege oder Lederfett...</p>',
  descriptionInstructions: '300-800 Wörter. Strukturiere mit H2/H3 Überschriften. Beginne mit einem Hook der das Problem/den Nutzen adressiert. Verwende kurze Absätze (2-4 Sätze). Nutze Listen und Aufzählungen. Baue interne Links ein. Schreibe informativ aber zugänglich. HTML-formatiert.',

  handleFormat: 'lederpflege-tipps-anleitung',
  handleInstructions: 'Nur Kleinbuchstaben und Bindestriche. Keine Umlaute (ä→a, ö→o, ü→u, ß→ss). 3-5 Keywords.',

  seoTitleFormat: 'Lederpflege: 5 Tipps für lang anhaltende Schönheit | Expertenratgeber',
  seoTitleInstructions: '50-60 Zeichen. Hauptkeyword am Anfang. Nutze Zahlen. Füge "Anleitung", "Tipps", "Ratgeber" hinzu für höhere Klickrate. Kommuniziere Expertise.',

  metaDescFormat: 'Lederpflege leicht gemacht: Entdecken Sie 5 bewährte Tipps für die richtige Pflege Ihrer Lederprodukte. Von der Reinigung bis zur Imprägnierung - so bleibt Leder jahrzehntelang schön.',
  metaDescInstructions: '150-160 Zeichen. Fasse den Artikel-Nutzen zusammen. Verwende das Hauptkeyword. Wecke Neugier. Sprich den Leser direkt an. Keine Clickbait.',
};

// PAGES - Optimized for informational pages
export const DEFAULT_PAGE_INSTRUCTIONS: EntityInstructions = {
  titleFormat: 'Über uns - Traditionelle Handwerkskunst seit 1970',
  titleInstructions: 'Maximal 60 Zeichen. Klar und beschreibend.',

  descriptionFormat: '<h1>Handwerkskunst mit Tradition</h1>\n<p>Seit über 50 Jahren steht unser Familienunternehmen für höchste Qualität in der Lederverarbeitung. Was 1970 als kleine Werkstatt begann, ist heute ein Synonym für nachhaltige, handgefertigte Lederprodukte.</p>\n<h2>Unsere Geschichte</h2>\n<p>Alles begann mit der Leidenschaft unseres Gründers für traditionelles Lederhandwerk...</p>\n<h2>Unsere Werte</h2>\n<ul>\n<li><strong>Qualität:</strong> Nur beste Materialien und Verarbeitung</li>\n<li><strong>Nachhaltigkeit:</strong> Faire und umweltschonende Produktion</li>\n<li><strong>Tradition:</strong> Bewährte Handwerkstechniken</li>\n</ul>',
  descriptionInstructions: '200-400 Wörter je nach Seitentyp. Verwende H1/H2 für Struktur. Authentisch und persönlich bei "Über uns". Klar und informativ bei Service-Seiten. Rechtssicher bei rechtlichen Seiten. HTML-formatiert.',

  handleFormat: 'ueber-uns-tradition-handwerk',
  handleInstructions: 'Nur Kleinbuchstaben und Bindestriche. Keine Umlaute (ä→a, ö→o, ü→u, ß→ss). 2-4 Keywords.',

  seoTitleFormat: 'Über uns - Traditionelle Lederverarbeitung seit 1970',
  seoTitleInstructions: '50-60 Zeichen. Seitentyp am Anfang (Über uns, Kontakt, etc.). USP oder Alleinstellungsmerkmal. Markenname wenn Platz. Keine Keywords-Stuffing.',

  metaDescFormat: 'Lernen Sie uns kennen: Seit 1970 fertigen wir hochwertige Lederprodukte in traditioneller Handwerkskunst. Erfahren Sie mehr über unsere Geschichte, Werte und das Team hinter den Produkten.',
  metaDescInstructions: '150-160 Zeichen. Beschreibe den Seiteninhalt. Kommuniziere den Nutzen für den Besucher. Persönlich bei "Über uns", sachlich bei rechtlichen Seiten. Natürliche Sprache.',
};

// POLICIES - Optimized for legal/policy pages
export const DEFAULT_POLICY_INSTRUCTIONS: EntityInstructions = {
  titleFormat: '', // Not used - titles are auto-generated by Shopify
  titleInstructions: '',

  descriptionFormat: '<h2>Widerrufsrecht</h2>\n<p>Sie haben das Recht, binnen vierzehn Tagen ohne Angabe von Gründen diesen Vertrag zu widerrufen.</p>\n<h3>Widerrufsfrist</h3>\n<p>Die Widerrufsfrist beträgt vierzehn Tage ab dem Tag, an dem Sie oder ein von Ihnen benannter Dritter...</p>\n<h3>Folgen des Widerrufs</h3>\n<p>Wenn Sie diesen Vertrag widerrufen, haben wir Ihnen alle Zahlungen, die wir von Ihnen erhalten haben...</p>',
  descriptionInstructions: 'Rechtssicher und klar formulieren. Verwende H2/H3 für Abschnitte. Kurze, verständliche Sätze. Aufzählungen für Übersichtlichkeit. Keine Marketing-Sprache. Professionell und sachlich. Rechtskonform (ggf. von Anwalt prüfen lassen). HTML-formatiert.',

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
