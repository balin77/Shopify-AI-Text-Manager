/**
 * Copy for the PUBLIC website (`/`, `/features`, `/videos`).
 *
 * Deliberately its own bundle rather than more keys in `app/i18n/en.ts`: that
 * file is ~5000 lines of admin UI strings shipped into the embedded app, and
 * marketing copy changes on a different rhythm and is read by a different
 * person. `en` is the shape; `de` and `es` are typed against it, so a key added
 * here fails typecheck until every language has it.
 */

export const en = {
  site: {
    name: "ContentPilot AI",
    tagline: "AI content, SEO and translations for Shopify — in one place.",
    description:
      "Write, optimise and translate every text in your Shopify store: products, collections, pages, blogs, menus, metaobjects and theme content. Built for shops that sell in more than one language.",
  },

  nav: {
    features: "Features",
    videos: "Videos",
    faq: "FAQ",
    install: "Install on Shopify",
    menu: "Menu",
    language: "Language",
  },

  hero: {
    eyebrow: "Shopify app",
    title: "Every text in your shop. Written, found and translated.",
    subtitle:
      "ContentPilot AI generates product texts, fixes your SEO and keeps every translation in sync with the text it was made from — across all your languages and markets.",
    ctaPrimary: "See what it does",
    ctaSecondary: "Watch the videos",
    note: "Works with your existing theme. It never edits your theme code.",
  },

  pillars: {
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
    ],
  },

  features: {
    title: "Features",
    intro:
      "The app is a set of tools that share one thing: they all work on the text your shop is made of. Here is what is in it.",
    groups: [
      {
        id: "ai",
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
        id: "translations",
        title: "Translations and markets",
        body: "The part most apps get wrong. Shopify stores a translation per language and, on top of that, per market — German for Switzerland worded differently from German for Germany. Both layers are handled.",
        points: [
          "All published languages, plus market-specific overrides",
          "A save counts only when Shopify echoes it back — no silent no-ops",
          "Change a source text and the translation is re-made, not left stale",
          "Fill only what is missing across the whole catalogue in one run",
          "Translated URL handles, with the 301 redirect written for you",
        ],
      },
      {
        id: "bulk",
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
        id: "seo",
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
        id: "aeo",
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
        id: "media",
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
        id: "structure",
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

  videos: {
    title: "Videos",
    intro:
      "Short walkthroughs of the parts that are hard to describe in a sentence. More are being recorded.",
    comingSoon: "Recording in progress",
    comingSoonBody: "This walkthrough is not published yet.",
    play: "Play",
    loadExternal: "Load and play",
    externalNote:
      "Playing loads the video from an external provider, which may set cookies.",
    items: {
      overview: {
        title: "A tour of the app",
        body: "What the sections are, where your content lives, and what happens on a save.",
      },
      "bulk-editor": {
        title: "Editing a whole catalogue at once",
        body: "Filtering to the rows you care about, changing hundreds of cells, and importing a CSV back.",
      },
      translations: {
        title: "Translating a shop",
        body: "Filling the missing languages, market-specific wording, and what happens when a source text changes.",
      },
      seo: {
        title: "Crawling your own storefront",
        body: "Running the scan, reading the on-page report, and fixing what it finds without leaving the app.",
      },
      aeo: {
        title: "Being readable by AI assistants",
        body: "agents.md, llms.txt and structured data — what they are and why they now matter.",
      },
    },
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

  faq: {
    title: "Questions",
    items: [
      {
        q: "Does it change my theme?",
        a: "No. The app never edits your theme code — no injected markup, no rewritten sections, no performance surgery on files you wrote. The only theme files it touches are ones it created itself (its AI-discovery files and its own storefront blocks), and it can hand every one of them back.",
      },
      {
        q: "Which AI provider does it use?",
        a: "Whichever you connect: Anthropic, OpenAI, Gemini, DeepSeek, Grok or HuggingFace. You bring your own key, so the cost and the choice of model stay yours.",
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
