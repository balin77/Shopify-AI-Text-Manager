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
  titleFormat: 'Premium Leather Wallet - Elegant & Durable',
  titleInstructions: 'You are an e-commerce expert. Create a concise, compelling product title with a maximum of 60 characters. Mention material, main feature, and a benefit. The title should be SEO-friendly and attention-grabbing. Return only the finished title without explanations.',

  descriptionFormat: '<h2>Discover Craftsmanship at Its Finest</h2>\n<p>This <strong>handcrafted leather wallet</strong> combines timeless design with exceptional quality. Each piece is crafted by experienced artisans from premium full-grain leather.</p>\n<h3>Your Benefits</h3>\n<ul>\n<li>Premium full-grain leather for maximum durability</li>\n<li>Timeless design that matches any style</li>\n<li>Practical compartment layout for optimal organization</li>\n<li>Handcrafted with attention to detail</li>\n</ul>\n<p>A faithful companion for many years - sustainable and stylish.</p>',
  descriptionInstructions: 'You are an e-commerce expert. Create a detailed, engaging product description of 150-250 words. Structure the text with H2/H3 headings. Start with an emotional hook. Then introduce the product. Use bullet lists (<ul>, <li>) for benefits and features. Use storytelling. Highlight USPs. End with a call-to-action or value proposition. Use HTML formatting (<p>, <strong>, <h2>, <h3>, <ul>, <li>). Return only the HTML description without explanations.',

  handleFormat: 'premium-leather-wallet-handcrafted',
  handleInstructions: 'You are an SEO expert. Create an SEO-friendly URL slug (handle) with 3-5 relevant keywords. Use only lowercase letters (a-z), digits (0-9), and hyphens (-) as separators. No umlauts - convert them (ä→ae, ö→oe, ü→ue, ß→ss). No spaces, underscores, or special characters. Return only the finished slug.',

  seoTitleFormat: 'Premium Leather Wallet | Handcrafted & Durable',
  seoTitleInstructions: 'You are an SEO expert. Create an optimized SEO title of 50-60 characters. Place the main keyword at the beginning. Use pipe (|) as a separator. Include a call-to-action word (buy, shop, discover). Add brand name at the end if available. Return only the finished SEO title without explanations.',

  metaDescFormat: 'Handcrafted premium leather wallet made from full-grain leather. Timeless, durable, and stylish. Sustainable craftsmanship for the highest standards. Discover now!',
  metaDescInstructions: 'You are an SEO expert. Create a compelling meta description of 150-160 characters. Integrate 2-3 relevant keywords naturally. Clearly communicate the value proposition. End with a call-to-action. Use active language without filler words. Return only the finished meta description without explanations.',

  altTextFormat: 'Premium leather wallet in dark brown full-grain leather on wooden table',
  altTextInstructions: 'You are an SEO expert. Create a descriptive alt text of 60-125 characters. Objectively describe what is visible in the image (not what it does). Mention color, material, and context. Include the main keyword. Avoid marketing language. Be precise for accessibility. Return only the finished alt text without explanations.',
};

// COLLECTIONS - Optimized for category/collection pages
export const DEFAULT_COLLECTION_INSTRUCTIONS: EntityInstructions = {
  titleFormat: 'Leather Accessories - Handcrafted & Timeless',
  titleInstructions: 'You are an e-commerce expert. Create a concise collection title with a maximum of 60 characters. Describe the product category clearly and appealingly. Return only the finished title without explanations.',

  descriptionFormat: '<h2>Handcrafted Leather Accessories for Every Occasion</h2>\n<p>Discover our exclusive collection of <strong>handcrafted leather accessories</strong>. Each product is crafted using traditional techniques with the utmost care.</p>\n<p>From elegant wallets to practical card holders and stylish belts - here you will find timeless companions for everyday life.</p>\n<h3>What Makes Our Collection Special</h3>\n<ul>\n<li>100% full-grain leather from sustainable production</li>\n<li>Traditional craftsmanship for over 50 years</li>\n<li>Timeless designs that never go out of style</li>\n<li>Fair production in Europe</li>\n</ul>',
  descriptionInstructions: 'You are an e-commerce expert. Create a compelling collection description of 100-200 words. Provide an overview of the product category. Describe the common denominator of all products. Use H2/H3 headings for structure. Use bullet lists (<ul>, <li>) for features. Communicate the collection USPs. Integrate SEO keywords naturally. Use HTML formatting. Return only the HTML description without explanations.',

  handleFormat: 'leather-accessories-handcrafted',
  handleInstructions: 'You are an SEO expert. Create an SEO-friendly URL slug (handle) with 3-5 relevant keywords. Use only lowercase letters (a-z), digits (0-9), and hyphens (-). No umlauts - convert them (ä→ae, ö→oe, ü→ue, ß→ss). Return only the finished slug.',

  seoTitleFormat: 'Handcrafted Leather Accessories | Sustainable & Premium',
  seoTitleInstructions: 'You are an SEO expert. Create an optimized SEO title of 50-60 characters. Place the category keyword at the beginning. Add a differentiating feature (handcrafted, organic, premium). Use a call-to-action if possible. Use pipe (|) as separator. Return only the finished SEO title without explanations.',

  metaDescFormat: 'High-quality leather accessories from traditional craftsmanship. Wallets, belts & more made from sustainable full-grain leather. Fair & sustainable. Discover now!',
  metaDescInstructions: 'You are an SEO expert. Create a compelling meta description of 150-160 characters. Describe the product category. Mention 2-3 product examples. Communicate USPs. Integrate keywords naturally. End with a call-to-action. Return only the finished meta description without explanations.',
};

// BLOGS/ARTICLES - Optimized for content marketing
export const DEFAULT_BLOG_INSTRUCTIONS: EntityInstructions = {
  titleFormat: '5 Tips for Proper Leather Product Care',
  titleInstructions: 'You are a content marketing expert. Create an engaging blog title with a maximum of 60 characters. Clearly communicate the benefit to the reader. Use numbers when possible. Return only the finished title without explanations.',

  descriptionFormat: '<p>Leather products are long-lasting companions - when properly cared for. In this article, we show you the <strong>5 most important care tips</strong> to keep your leather goods looking like new for decades.</p>\n<h2>1. Regular Cleaning</h2>\n<p>Remove dust and dirt weekly with a soft, slightly damp cloth...</p>\n<h2>2. Proper Leather Care</h2>\n<p>Use a high-quality leather conditioner or leather balm every 3-6 months...</p>',
  descriptionInstructions: 'You are a content marketing expert. Create an informative, well-structured blog article of 300-800 words. Structure with H2/H3 headings. Start with a hook that addresses the problem or benefit. Use short paragraphs (2-4 sentences). Use lists and bullet points for better readability. Write informatively but accessibly. Use HTML formatting (<p>, <h2>, <h3>, <strong>, <ul>, <li>). Return only the HTML article without explanations.',

  handleFormat: 'leather-care-tips-guide',
  handleInstructions: 'You are an SEO expert. Create an SEO-friendly URL slug (handle) with 3-5 relevant keywords. Use only lowercase letters (a-z), digits (0-9), and hyphens (-). No umlauts - convert them (ä→ae, ö→oe, ü→ue, ß→ss). Return only the finished slug.',

  seoTitleFormat: 'Leather Care: 5 Tips for Lasting Beauty',
  seoTitleInstructions: 'You are an SEO expert. Create an optimized SEO title of 50-60 characters. Place the main keyword at the beginning. Use numbers when possible. Add words like "Guide", "Tips", "Tutorial" for higher click-through rate. Communicate expertise. Return only the finished SEO title without explanations.',

  metaDescFormat: 'Leather care made easy: 5 proven tips for proper care of your leather products. From cleaning to waterproofing - keep leather beautiful for decades.',
  metaDescInstructions: 'You are an SEO expert. Create an appealing meta description of 150-160 characters. Summarize the article benefit. Use the main keyword. Spark curiosity. Address the reader directly. Avoid clickbait. Return only the finished meta description without explanations.',
};

// PAGES - Optimized for informational pages
export const DEFAULT_PAGE_INSTRUCTIONS: EntityInstructions = {
  titleFormat: 'About Us - Traditional Craftsmanship Since 1970',
  titleInstructions: 'You are a content expert. Create a clear, descriptive page title with a maximum of 60 characters. Communicate the purpose of the page. Return only the finished title without explanations.',

  descriptionFormat: '<h1>Craftsmanship with Tradition</h1>\n<p>For over 50 years, our family business has stood for the highest quality in leather processing. What began in 1970 as a small workshop is today synonymous with sustainable, handcrafted leather products.</p>\n<h2>Our Story</h2>\n<p>It all began with our founder\'s passion for traditional leathercraft...</p>\n<h2>Our Values</h2>\n<ul>\n<li><strong>Quality:</strong> Only the finest materials and craftsmanship</li>\n<li><strong>Sustainability:</strong> Fair and environmentally friendly production</li>\n<li><strong>Tradition:</strong> Time-tested craft techniques</li>\n</ul>',
  descriptionInstructions: 'You are a content expert. Create informative page content of 200-400 words (depending on page type). Use H1/H2 headings for structure. Write authentically and personally for "About Us" pages. Clear and informative for service pages. Legally sound for legal pages. Use HTML formatting (<h1>, <h2>, <p>, <strong>, <ul>, <li>). Return only the HTML content without explanations.',

  handleFormat: 'about-us-tradition-craftsmanship',
  handleInstructions: 'You are an SEO expert. Create an SEO-friendly URL slug (handle) with 3-5 relevant keywords. Use only lowercase letters (a-z), digits (0-9), and hyphens (-). No umlauts - convert them (ä→ae, ö→oe, ü→ue, ß→ss). Return only the finished slug.',

  seoTitleFormat: 'About Us - Traditional Leather Processing Since 1970',
  seoTitleInstructions: 'You are an SEO expert. Create an optimized SEO title of 50-60 characters. Start with the page type (About Us, Contact, etc.). Add USP or unique selling point. Include brand name if space allows. Avoid keyword stuffing. Return only the finished SEO title without explanations.',

  metaDescFormat: 'Get to know us: Since 1970, we have been crafting high-quality leather products using traditional craftsmanship. Learn more about our story & values.',
  metaDescInstructions: 'You are an SEO expert. Create an informative meta description of 150-160 characters. Describe the page content. Communicate the benefit to the visitor. Write personally for "About Us" pages, objectively for legal pages. Use natural language. Return only the finished meta description without explanations.',
};

// POLICIES - Optimized for legal/policy pages
export const DEFAULT_POLICY_INSTRUCTIONS: EntityInstructions = {
  titleFormat: '', // Not used - titles are auto-generated by Shopify
  titleInstructions: '',

  descriptionFormat: '<h2>Right of Withdrawal</h2>\n<p>You have the right to withdraw from this contract within fourteen days without giving any reason.</p>\n<h3>Withdrawal Period</h3>\n<p>The withdrawal period is fourteen days from the day on which you or a third party named by you...</p>\n<h3>Consequences of Withdrawal</h3>\n<p>If you withdraw from this contract, we will refund all payments we have received from you...</p>',
  descriptionInstructions: 'You are a legal and content expert. Create a legally sound and clearly worded policy text. Use H2/H3 headings for sections. Write in short, understandable sentences. Use bullet points for better clarity. Avoid marketing language. Remain professional and objective. Ensure legal compliance (note: text should be reviewed by a lawyer). Use HTML formatting (<h2>, <h3>, <p>, <ul>, <li>). Return only the HTML text without explanations.',

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
