/**
 * Copy for the PUBLIC website (`/`, `/features`, `/roadmap`, `/install`).
 *
 * Deliberately its own bundle rather than more keys in `app/i18n/en.ts`: that
 * file is ~5000 lines of admin UI strings shipped into the embedded app, and
 * marketing copy changes on a different rhythm and is read by a different
 * person. `en` is the shape; `de` and `es` are typed against it, so a key added
 * here fails typecheck until every language has it.
 */

/** One pillar of the landing page's scroll story. */
type Pillar = { title: string; body: string };

export const en = {
  site: {
    name: "ContentPilot AI",
    tagline: "AI content, SEO and translations for Shopify — in one place.",
    description:
      "Write, optimise and translate every text in your Shopify store: products, collections, pages, blogs, menus, metaobjects and theme content. Built for shops that sell in more than one language.",
  },

  nav: {
    features: "Features",
    pricing: "Pricing",
    roadmap: "Roadmap",
    faq: "FAQ",
    guide: "Guide",
    compare: "Compare",
    install: "Install on Shopify",
    installShort: "Install",
    menu: "Menu",
    language: "Language",
  },

  hero: {
    storeBadge: "Live in the Shopify App Store",
    eyebrow: "Shopify app",
    title: "Every text in your shop. Written, found and translated.",
    subtitle:
      "ContentPilot AI generates product texts, fixes your SEO and keeps every translation in sync with the text it was made from — across all your languages and markets.",
    ctaPrimary: "See what it does",
    note: "Works with your existing theme. It never edits your theme code.",
  },

  pillars: {
    more: "See every feature",
    compare: "Compare with other translation apps",
    title: "Three things it does well",
    items: [
      {
        title: "Writes",
        body: "Titles, descriptions, meta texts and alt texts — for products, collections, pages, blogs, articles, metaobjects and theme content. You choose the AI provider and the tone; the app supplies the context from your own catalogue.",
      },
      {
        title: "Translates",
        body: "Every published language and every market. A translation is only recorded as saved when Shopify confirms it back, and when a source text changes the translation is refreshed instead of quietly describing text that no longer exists.",
      },
      {
        title: "Gets found",
        body: "A crawl of your own storefront, an on-page report, structured data, redirect chains, sitemap control, IndexNow — plus the newer half nobody has covered yet: what AI assistants read when they answer a question about your shop.",
      },
      // Exactly three: the scroll story has three video slots, and a fourth
      // pillar here must fail typecheck instead of silently sharing a video.
    ] as [Pillar, Pillar, Pillar],
  },

  features: {
    guideLink: "How it works in the guide",
    compareLink: "How does it compare with Translate & Adapt, Weglot and others?",
    title: "Features",
    intro:
      "The app is a set of tools that share one thing: they all work on the text your shop is made of. Here is what is in it.",
    groups: [
      {
        id: "ai" as const,
        title: "AI writing",
        body: "Generate or improve any field, one at a time or for a whole shop. The prompt carries your own instructions, your glossary and — if you allow it — the product image itself.",
        points: [
          "Six providers to choose from: Anthropic, OpenAI, Gemini, DeepSeek, Grok, HuggingFace",
          "Your own instructions per field, plus a shop-wide glossary",
          "Optional image understanding, so an alt text describes the actual picture",
          "Suggestions land in the field for you to accept — nothing is written behind your back",
        ],
      },
      {
        id: "translations" as const,
        title: "Translations and markets",
        body: "The part most apps get wrong. Shopify stores a translation per language and, on top of that, per market — German for Switzerland worded differently from German for Germany. Both layers are handled.",
        points: [
          "All published languages, plus market-specific overrides",
          "A save counts only when Shopify echoes it back — no silent no-ops",
          "Change a source text and the translation is re-made, not left stale",
          "Fill only what is missing across the whole catalogue in one run",
          "Translated URL handles, with the 301 redirect written for you",
          "Different images and videos per language and market: product gallery, sharing image and theme images",
        ],
      },
      {
        id: "bulk" as const,
        title: "Bulk editor",
        body: "A spreadsheet over your entire shop — products, variants, collections, articles, pages, blogs, policies, metaobjects and images — with only the cells you touched being written.",
        points: [
          "Filter, sort and edit hundreds of rows at once",
          "CSV export and import",
          "Per-cell failures, so one refused field never loses the rest of your work",
          "An 'add the missing translations' pass over the current filter",
        ],
      },
      {
        id: "seo" as const,
        title: "SEO",
        body: "A crawl of your own storefront rather than a guess from the database, and a report that filters out its own false positives.",
        points: [
          "On-page report: titles, meta descriptions, headings, thin content, duplicates",
          "Broken internal and external links",
          "Redirect chains, derived from your own redirect list",
          "Indexability: what is excluded from search, and whether anybody meant it",
          "Sitemap control and IndexNow submission",
          "hreflang audit for multilingual shops",
        ],
      },
      {
        id: "aeo" as const,
        title: "Answer engine optimisation",
        body: "Search is no longer only search. This part is about what an AI assistant reads when a customer asks it about your products.",
        points: [
          "agents.md and llms.txt, generated from your catalogue and kept current",
          "Structured data (JSON-LD) for products, articles, FAQs, videos and more",
          "Open Graph and Twitter cards, measured against what your storefront really serves",
          "Catalogue readiness: what is missing before the AI channels pick a product up",
          "Visits that came from an AI assistant, counted without cookies",
        ],
      },
      {
        id: "media" as const,
        title: "Images and media",
        body: "Alt texts are content too, and they are the text nobody writes.",
        points: [
          "AI alt texts for product media, collection and article images",
          "Alt texts translated into every language like any other field",
          "Bulk upload with filename-based assignment to variants",
          "WebP conversion, gallery ordering, videos and 3D models",
        ],
      },
      {
        id: "structure" as const,
        title: "Navigation, metaobjects, theme text",
        body: "The content that is not a product and that most tools stop at.",
        points: [
          "Full menu editor: rename, reorder, re-nest, retarget — with translations kept",
          "Metaobject entries and their fields, translated",
          "Theme text and theme settings, per theme and per market",
          "Shop policies, pages, blogs and articles",
        ],
      },
    ],
  },

  pricing: {
    title: "Plans and pricing",
    intro:
      "Four plans that differ in how much of your shop they cover — not in how many languages you may use. Every plan translates into all of your languages.",
    trial: "Every paid plan starts with a {days}-day free trial. Billed by Shopify, cancel any time.",
    modeLabel: "How the AI is paid for",
    modeOwnKey: "With your own AI key",
    modeIncluded: "AI included",
    modeOwnKeyHint:
      "You connect your own key from OpenAI, Anthropic, Gemini, DeepSeek, Grok or HuggingFace and pay the provider directly for what you use.",
    modeIncludedHint:
      "No key and no second bill: a monthly AI volume is part of the price. You can still connect your own key at any time.",
    free: "Free",
    perMonth: "/ month",
    recommended: "Most popular",
    choose: "Install and choose this plan",
    chooseFree: "Install for free",
    limitsLine: "{products} products · {collections} collections",
    everythingIn: "Everything in {plan}, plus:",
    included: "Included:",
    tasterLine: "About {taster} AI actions once to try it, no key needed",
    moreInTable: "+ {n} more in the table below",
    plans: {
      free: {
        tagline: "To try it on a small catalogue.",
      },
      basic: {
        tagline: "For small shops.",
      },
      pro: {
        tagline: "For growing shops.",
      },
      max: {
        tagline: "For large catalogues.",
      },
    },
    includedVolume: {
      free: "Includes about {taster} AI actions once, to try it",
      basic: "AI included: about 300–500 products per month, each translated into one language",
      pro: "AI included: about 600–1,000 products per month, each translated into one language",
      max: "AI included: about 1,500–2,500 products per month, each translated into one language",
    },
    tableTitle: "Compare the plans",
    tableIntro: "Everything each plan contains, row by row. Numbers are per shop.",
    planColumn: "Feature",
    priceRow: "Price",
    groups: {
      content: "Content you can edit and translate",
      workflow: "Translation and AI",
      images: "Images",
      seo: "SEO and AI visibility",
    },
    rows: {
      products: { label: "Products", help: "Products the app loads and works on." },
      collections: { label: "Collections" },
      pages: { label: "Pages" },
      articles: { label: "Blogs and articles", help: "Number of articles." },
      policies: { label: "Shop policies", help: "Refund, privacy, shipping and terms." },
      menus: { label: "Navigation menus", help: "Edit and translate your menus." },
      metaobjects: { label: "Metaobjects" },
      themeTranslations: { label: "Theme texts", help: "Texts and settings of your theme, translated." },
      checkoutTexts: { label: "Shipping and checkout texts" },
      notifications: { label: "Notifications and packing slips", help: "The emails and documents Shopify sends." },
      directTranslations: { label: "Direct translations", help: "Translate any text that appears on your storefront." },
      languages: { label: "Languages" },
      ownKey: { label: "Use your own AI key", help: "Six providers to choose from." },
      aiInstructions: { label: "Your own AI instructions", help: "Tone and rules per field, used in every prompt." },
      bulkEditor: { label: "Bulk editor and CSV export", help: "A spreadsheet over your whole shop." },
      csvImport: { label: "CSV import" },
      translateMissing: { label: "Add all missing translations in one run" },
      autoTranslate: { label: "Automatic translation", help: "When a text changes — in the app or in the Shopify admin — its translations are renewed." },
      productImages: { label: "Product images" },
      imageSuite: { label: "Image manager", help: "Variant galleries, bulk upload, bulk alt texts, SKU names." },
      mediaPerLanguage: { label: "Images and videos per language", help: "Replace product images, product videos and theme images per language and market." },
      imageOperations: { label: "Image uploads and WebP conversions" },
      seoAudit: { label: "SEO audit, structured data, redirects, hreflang" },
      pageSpeed: { label: "PageSpeed checks" },
      keywords: { label: "Tracked keywords" },
      aiDiscovery: { label: "AI discovery (agents.md, llms.txt)", help: "What AI assistants read about your shop." },
      crawl: { label: "Storefront crawl and on-page report" },
      searchConsole: { label: "Google Search Console" },
      internalLinks: { label: "Internal link suggestions" },
      sitemap: { label: "Sitemap control" },
      indexNow: { label: "IndexNow submissions" },
      scoreHistory: { label: "SEO score history" },
      scheduled: { label: "Automatic nightly audit and weekly crawl" },
      seoBulk: { label: "Items per SEO bulk fix" },
    },
    formats: {
      imageOperations: "{n} / month",
      pageSpeed: "{n} / day",
      searchConsole: "{n} days of data",
      indexNow: "{n} / month",
      scoreHistory: "{n} days",
    },
    values: {
      yes: "Included",
      no: "Not included",
      unlimited: "Unlimited",
      featuredOnly: "Featured image",
      allImages: "All images",
    },
    tableNote:
      "The limits apply to what the app works on. Your shop itself can be larger — content beyond the limit simply stays as it is.",
    compareLink: "How do these prices compare with other apps?",
    faqTitle: "Questions about billing",
    faq: [
      {
        q: "How is the app billed?",
        a: "Through your normal Shopify invoice, in euros. There is no separate account and no credit card to enter on this site.",
      },
      {
        q: "Is there a free trial?",
        a: "Yes. Every paid plan starts with a {days}-day trial, and the Free plan has no time limit at all. If you cancel during the trial, you pay nothing.",
      },
      {
        q: "Can I change plans later?",
        a: "Yes, at any time, in the app's settings. Shopify adjusts the charge for you. Moving down never deletes your content in Shopify.",
      },
      {
        q: "Own AI key or AI included — which should I choose?",
        a: "With your own key you pay the AI provider directly for what you use, and you choose the model. With AI included there is nothing to set up and one bill for everything. Both use the same features.",
      },
      {
        q: "Does it cost more for more languages?",
        a: "No. Every plan includes all of your languages. The plans differ in the number of products and in the content types they cover.",
      },
    ],
  },


  guide: {
    title: "Guide",
    intro:
      "How every part of the app works, one topic at a time. Each topic explains what the feature does and how to use it; a short video for each is being recorded.",
    topicCount: "{count} topics",
    videoBadge: "Video",
    videoPendingBadge: "Video coming",
    videoPending: "Video coming soon",
    videoPendingBody: "The walkthrough for this topic is being recorded. Until then, the text below covers everything.",
    tips: "Good to know",
    inThisCategory: "In this category",
    allTopics: "All topics",
    previous: "Previous",
    next: "Next",
    helpTitle: "Still stuck?",
    helpBody: "Write to us — we answer every question, and the good ones end up in this guide.",
    helpAction: "Contact support",
  },

  /** Labels of the click-to-load video player the guide (and the home page) use. */
  video: {
    pending: "Video coming soon",
    heroTitle: "ContentPilot at a glance",
    loadExternal: "Load and play",
    externalNote:
      "Playing loads the video from an external provider, which may set cookies.",
  },

  install: {
    title: "Install on Shopify",
    intro:
      "Enter your store's Shopify address. You will land in Shopify's own permission screen, where you decide what the app may read and write — nothing is installed before you approve it there.",
    label: "Your Shopify store",
    placeholder: "my-shop.myshopify.com",
    help: "The .myshopify.com address, the store handle on its own, or the admin URL you have open — all three work.",
    submit: "Continue to Shopify",
    errors: {
      empty: "Please enter your store address.",
      invalid: "That does not look like a Shopify store address. Use my-shop.myshopify.com, or just the store name.",
      customDomain:
        "That is your storefront domain. The app is installed from the store's own .myshopify.com address — you will find it in your Shopify admin under Settings, or in the URL as admin.shopify.com/store/<name>.",
    },
  },

  roadmap: {
    title: "Roadmap",
    intro:
      "What comes next, what is being weighed, and what gets built only when somebody asks for it. The order inside a section is the priority; there are no dates, because a public date that slips reads as a broken promise.",
    note: "This page is rendered from the same file the development plan lives in — when a status changes there, it changes here.",
    sections: {
      inProgress: "In progress",
      planned: "Next",
      considering: "Being considered",
      onRequest: "On request only",
      shipped: "Recently shipped",
    },
    shippedOn: "Shipped",
    areas: {
      ai: "AI writing",
      translations: "Translations",
      bulk: "Bulk editor",
      seo: "SEO",
      aeo: "AI discovery",
      media: "Images and media",
      ads: "Advertising",
      structure: "Structure",
      platform: "Platform",
      website: "This website",
    },
  },

  faq: {
    title: "Questions",
    items: [
      {
        q: "Does it change my theme?",
        a: "No. The app never edits your theme code — no injected markup, no rewritten sections, no performance surgery on files you wrote. The only theme files it touches are ones it created itself (its AI-discovery files and its own storefront blocks), and it can hand every one of them back.",
      },
      {
        q: "Which AI provider does it use?",
        a: "Whichever you connect: Anthropic, OpenAI, Gemini, DeepSeek, Grok or HuggingFace. With your own key, the cost and the choice of model stay yours. If you would rather not set up a key, every paid plan is also available with the AI included.",
      },
      {
        q: "Do I need more than one language to use it?",
        a: "No. The writing, SEO and image tools work on a single-language shop, and the translation UI simply does not appear. The app is at its strongest on a multilingual shop, which is what most of it was built for.",
      },
      {
        q: "What happens to my translations when I edit the original text?",
        a: "That is the question the app exists to answer. A translation of text that no longer exists is worse than none, so a changed source text either has its translations re-made or removed — and which of the two happens is your setting, not a hidden default.",
      },
      {
        q: "Is my shop data sent to the AI provider?",
        a: "Only the text of the field being written, plus the context needed to write it, and only when you ask for a generation. Whether the AI may look at your product images is a single shop-wide setting that is off unless you turn it on.",
      },
      {
        q: "Does it work outside the Shopify admin?",
        a: "This website does. The app itself lives inside your Shopify admin, which is where your content is.",
      },
    ],
  },

  cta: {
    title: "See it on your own shop",
    body: "The app installs into your Shopify admin and reads your catalogue. Nothing is written until you press save.",
    button: "Install on Shopify",
  },

  footer: {
    tagline: "AI content, SEO and translations for Shopify.",
    product: "Product",
    legal: "Legal",
    privacy: "Privacy",
    terms: "Terms",
    support: "Support",
    contact: "Contact",
    rights: "All rights reserved.",
  },

  languageHint: {
    text: "This page is also available in {language}.",
    action: "Switch",
    dismiss: "Dismiss",
  },

  error: {
    title: "Something went wrong",
    body: "This page could not be shown. Try again in a moment.",
  },

  notFound: {
    title: "Page not found",
    body: "That address does not exist on this site.",
    action: "Back to the start",
  },
};

export type MarketingTranslation = typeof en;
