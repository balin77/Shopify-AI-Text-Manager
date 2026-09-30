import type { CompareCopy } from "./types";

export const compareEn: CompareCopy = {
  title: "ContentPilot compared with other Shopify translation apps",
  intro:
    "How ContentPilot AI stacks up against Translate & Adapt, Weglot, Transcy, LangShop, T Lab, Langify and GTranslate — what each app does well, where they differ, and which one fits which shop.",
  vsTitle: "ContentPilot vs {name}",
  vsMetaTitle: "ContentPilot vs {name}: Shopify translation apps compared",
  tableHeading: "Feature by feature",
  featureColumn: "Feature",
  support: {
    yes: "Yes",
    partial: "Partly",
    no: "No",
    unstated: "Not stated",
    higherPlan: "Higher plan",
  },
  groups: {
    translation: "Translation",
    content: "Content",
    seo: "SEO and AI search",
    media: "Images",
    international: "Selling abroad",
  },
  rows: {
    autoTranslate: {
      label: "Automatic translation",
      help: "Texts are translated by machine or AI instead of by hand.",
    },
    nativeStorage: {
      label: "Translations saved in Shopify",
      help: "The translations live in your shop, not on the app provider's servers. They stay if you uninstall.",
    },
    brandVoice: {
      label: "Your own instructions for the AI",
      help: "Tone, wording and rules you set are followed in every translation.",
    },
    aiProvider: {
      label: "Choice of AI provider",
      help: "You decide which AI does the work.",
    },
    glossary: {
      label: "Glossary",
      help: "Brand names and fixed terms are always translated the same way — or not at all.",
    },
    themeCheckout: {
      label: "Theme, checkout and emails",
      help: "Buttons, checkout texts and notification emails, not just products.",
    },
    thirdPartyApps: {
      label: "Texts from other apps",
      help: "Review widgets, popups and other app texts shown in your store.",
    },
    followChanges: {
      label: "Translations follow text changes",
      help: "When the original text changes, the translations are updated too.",
    },
    aiWriting: {
      label: "Write and improve texts with AI",
      help: "Product descriptions, SEO titles and meta descriptions in your main language.",
    },
    bulkEditor: {
      label: "Spreadsheet editor for the whole catalogue",
      help: "Edit titles, SEO fields, prices and more for many items at once, in one table.",
    },
    seoToolkit: {
      label: "SEO toolkit",
      help: "Keywords, SEO score, site crawl, redirects and Google Search Console.",
    },
    aiVisibility: {
      label: "Visibility in AI search",
      help: "Structured data and files that help ChatGPT, Perplexity and others understand your shop.",
    },
    altText: {
      label: "Image alt texts written by AI",
      help: "The AI writes a description for each image.",
    },
    imageManager: {
      label: "Variant image galleries",
      help: "Several images per variant, bulk upload and WebP conversion.",
    },
    imagesPerLanguage: {
      label: "Different images per language",
      help: "Show a different image, for example one with text on it, in each language.",
    },
    currency: {
      label: "Currency conversion by the app",
      help: "Shopify Markets already converts prices itself; some apps add their own converter.",
    },
  },
  ourStrengths: [
    "Translations saved in your Shopify store — they stay if you uninstall.",
    "AI translation in any number of languages, following your own tone, rules and glossary.",
    "You choose the AI provider and pay it directly, at cost — or pick a plan with AI included.",
    "Translates texts from other apps and updates translations when the original changes.",
    "Writes and improves product texts, SEO titles and alt texts.",
    "A full SEO toolkit, AI-search visibility and a spreadsheet editor for the whole catalogue.",
    "Variant image galleries with bulk upload and WebP conversion.",
  ],
  ourNotes: {
    autoTranslate: "With your own AI key or AI included",
    aiProvider: "Six providers",
    imagesPerLanguage: "Not yet",
    currency: "Shopify Markets does this",
  },
  aboutHeading: "How {name} works",
  strengthsHeading: "Where {name} is strong",
  ourEdgeHeading: "What ContentPilot adds",
  verdictHeading: "Which one fits you?",
  checkedAt: "September 2026",
  disclaimer:
    "Based on the providers' own App Store listings and help pages, as of {date}. Apps change quickly — check the current listing before you decide. “Not stated” means we could not find a clear answer, not that the feature is missing.",
  correction: "Spotted something out of date? Tell us and we will correct it.",
  detailLink: "Full comparison",
  otherComparisons: "Other comparisons",
  allComparisons: "All comparisons",
  tableNote:
    "“Higher plan” means the app offers the feature, only not on the plan shown. An app with fewer plans shows its highest plan at the upper levels.",
  glance: {
    heading: "Compare plan by plan",
    intro: "Pick a plan level. Each column then shows that app's plan at this level: its price, its limits and which features it includes.",
    planColumn: "Plan",
    levelPicker: "Plan level",
    topPlan: "highest plan",
    planGroup: "Plan",
    freeLevel: "Free",
    level: "Level {n}",
    priceLabel: "Price",
    languagesLabel: "Languages",
    productsLabel: "Products",
    aiLabel: "Translations",
    enginesLabel: "AI providers",
    engines: {
      ownKey: "{list} — with your own key",
      plusOwnKey: "Own key: {list}",
      shopify: "Shopify's machine translation",
      vendor: "The provider's own AI, not selectable",
      unstated: "Machine translation, engine not stated",
      manual: "None — manual translation only",
    },
    trialRow: "Free trial",
    includedAi: {
      price: "or {price} with AI included",
      taster: "Or about {n} AI actions once to try it, no key needed",
      volume: {
        basic: "With AI included: enough for about 300–500 products, each translated into one language, per month",
        pro: "With AI included: enough for about 600–1,000 products, each translated into one language, per month",
        max: "With AI included: enough for about 1,500–2,500 products, each translated into one language, per month",
      },
      engines: "With AI included: {list}",
    },
    addApp: "Add an app to the comparison",
    removeApp: "Hide {name} from the comparison",
    strengthsGroup: "Strengths",
    strengthsRow: "Where the app is strong",
    strengthsHelp: "Based on the provider's own listing, summarised by us.",
    values: {
      unlimited: "Unlimited",
      someAutomatic: "2 automatic, more by hand",
      automaticOf: "{auto} by AI, up to {total} in total",
      manualOnly: "Manual translation only",
      wordsOnce: "{n} words once, more as word packs",
      oncePerLanguage: "Once per language, counted in products rather than words",
      oncePerLanguageOrOwnKey: "Once per language; unlimited with your own API key",
      noProductLimit: "No limit",
      ownKey: "With your own AI key: unlimited — you pay your AI provider directly",
      included: "Included",
      unlimitedWords: "Unlimited words",
      words: "{n} words",
      tokensMonth: "{n} AI tokens / month",
      tokensMonthOwnKey: "{n} AI tokens / month, or your own AI key",
      wordsPlusTokens: "Unlimited words (Google) + {n} AI tokens / month",
      wordsPlusTokensOwnKey: "Unlimited words (Google) + {n} AI tokens / month, or your own AI key",
      unstated: "Not stated",
      trialDays: "{n} days",
      noTrial: "Not needed — free",
      notOffered: "No plan at this level",
      onRequest: "On request",
      oneLanguage: "1",
      languages: "{n}",
    },
  },
  pricing: {
    perMonth: "/ month",
    perYear: "/ year",
    free: "Free",
    onRequest: "Price on request",
    note: "Monthly prices in the provider's own currency, before tax. Several providers are cheaper when billed yearly. With ContentPilot you either use your own AI key — then your AI provider bills the usage separately — or a plan with AI included.",
  },
  competitors: {
    "translate-and-adapt": {
      kind: "Shopify's own free translation app",
      summary:
        "Translate & Adapt is free and built by Shopify. ContentPilot adds AI translation in any number of languages with your own instructions, a glossary, texts from other apps, SEO tools and content writing. Here is how they compare.",
      about:
        "Translate & Adapt is made by Shopify and costs nothing. It translates up to two languages automatically; every further language is translated by hand. Its big strength is adapting content per market, for example different spellings for the UK and the US.",
      strengths: [
        "Completely free, made by Shopify itself.",
        "Adapts wording per market, such as British and American English.",
        "Covers theme, checkout and notification emails.",
        "A good fit if you need one or two extra languages and standard machine translation is enough.",
      ],
      ourEdge: [
        "AI translation in any number of languages, following your own tone and rules.",
        "A glossary, so brand names and fixed terms are never mistranslated.",
        "Translates texts from other apps, such as review widgets ",
        "Updates translations automatically when you change the original text ",
        "Writes and improves product texts, SEO titles and alt texts.",
        "A full SEO toolkit and a spreadsheet editor for the whole catalogue.",
      ],
      verdict:
        "Stay with Translate & Adapt if you sell in one or two extra languages and standard machine translation is good enough. Choose ContentPilot when you want translations in your own voice with a glossary, texts from other apps translated, or one app for texts, SEO and translations. Both write into Shopify's own translation storage, so you can switch at any time and keep what you have.",
      notes: {
        autoTranslate: "Two languages",
        followChanges: "Weekly auto-sync, off by default",
        imagesPerLanguage: "Theme images only",
      },
    },
    weglot: {
      kind: "Translation service for many website platforms",
      summary:
        "Weglot translates websites on many platforms and charges by translated words. ContentPilot works inside Shopify, saves translations in your shop and adds SEO and content tools. Here is how they compare.",
      about:
        "Weglot is a translation service for many website platforms, Shopify among them. It detects your store's text and serves translated pages from its own system. The translations are stored on Weglot's servers, not in Shopify. Plans are priced by the number of languages and translated words.",
      strengths: [
        "Mature product with a visual editor that shows translations in place.",
        "Glossary and AI that learns your brand voice.",
        "Translates texts from other apps and swaps images per language.",
        "Optional professional human translation.",
      ],
      ourEdge: [
        "Translations are saved in your Shopify store and stay if you uninstall.",
        "Unlimited languages on every plan and no word limits — plans are sized by number of products.",
        "You choose the AI provider and pay it directly, at cost.",
        "Writes and improves product texts, SEO titles and alt texts.",
        "A full SEO toolkit, AI-search visibility and a spreadsheet editor for the whole catalogue.",
      ],
      verdict:
        "Choose Weglot if you run websites on several platforms and want one translation service for all of them, or if you need professional translators. Choose ContentPilot if your shop runs on Shopify, you want the translations to belong to your store, and you want no word limits.",
      notes: {
        brandVoice: "Formal or informal only",
        nativeStorage: "Stored with Weglot",
      },
    },
    transcy: {
      kind: "Translation and currency app for Shopify",
      summary:
        "Transcy combines translation, currency conversion and image translation. ContentPilot combines AI translation with SEO and content tools. Here is how they compare.",
      about:
        "Transcy is a Shopify app that combines translation with a currency converter, visitor location detection and image translation. It works with several translation engines and offers a language and currency switcher for the storefront.",
      strengths: [
        "Translation, currency conversion and location detection in one app.",
        "Translates the text inside images.",
        "Glossary and a choice of translation engines.",
        "Translates texts from other apps.",
      ],
      ourEdge: [
        "Your own instructions for the AI, so translations follow your tone",
        "Unlimited languages on every plan.",
        "Writes and improves product texts, SEO titles and alt texts.",
        "A full SEO toolkit and AI-search visibility.",
        "A spreadsheet editor for the whole catalogue, plus variant image galleries",
      ],
      verdict:
        "Choose Transcy if you need a currency converter beyond Shopify Markets or text translated inside images. Choose ContentPilot if you want translations in your own voice and one app for texts, SEO and translations.",
      notes: {
        aiProvider: "Several AI engines",
      },
    },
    langshop: {
      kind: "Translation app for Shopify",
      summary:
        "LangShop translates Shopify stores with several AI engines and offers currency conversion. ContentPilot adds SEO tools, content writing and unlimited languages on every plan. Here is how they compare.",
      about:
        "LangShop is a Shopify translation app that works with several AI engines or human translators. It covers the store, checkout and other apps' texts, and adds a currency converter and a language switcher.",
      strengths: [
        "Very wide language support, including right-to-left languages.",
        "Several AI engines and optional human translation.",
        "Glossary and custom translation rules.",
        "Currency conversion and a language switcher.",
      ],
      ourEdge: [
        "Unlimited languages on every plan.",
        "You choose the AI provider and pay it directly, at cost.",
        "Writes and improves product texts, SEO titles and alt texts.",
        "A full SEO toolkit and AI-search visibility.",
        "A spreadsheet editor for the whole catalogue, plus variant image galleries",
      ],
      verdict:
        "Choose LangShop if you want human translators on call or a currency converter beyond Shopify Markets. Choose ContentPilot if you want unlimited languages and one app for texts, SEO and translations.",
      notes: {
        aiProvider: "Several AI engines",
        bulkEditor: "Translations only",
        followChanges: "New products and collections",
      },
    },
    "t-lab": {
      kind: "AI translation app for Shopify",
      summary:
        "T Lab translates Shopify stores with AI, tiered by languages and number of products. ContentPilot adds AI translation in any number of languages, your own instructions for the AI, SEO tools and content writing. Here is how they compare.",
      about:
        "T Lab is a translation app for Shopify that writes into Shopify's own translation storage. It translates by hand or with an AI based on OpenAI; how many languages the AI translates, and for how many products, depends on the plan. Those allowances are one-time per language and do not renew monthly. What Shopify cannot translate itself — images, other apps' texts, hard-coded texts — the app replaces with a script in the store.",
      strengths: [
        "A free plan with AI translation for one language and up to 500 products.",
        "A glossary and image translation even on the free plan.",
        "Translates texts from other apps such as Judge.me or PageFly.",
        "Autopilot on Premium translates new and changed content automatically; own key for OpenAI, Anthropic, DeepL, DeepSeek or Google.",
      ],
      ourEdge: [
        "AI translation in any number of languages, without a one-time allowance per language.",
        "Your own instructions and a glossary, so the AI translates in your tone.",
        "Writes and improves product texts, SEO titles and alt texts.",
        "A full SEO toolkit and visibility in AI search.",
        "A spreadsheet editor for the whole catalogue and variant image galleries.",
      ],
      verdict:
        "Choose T Lab if you want a few languages translated by AI at a low price and need images, other apps' texts or currencies handled. Choose ContentPilot if you want any number of languages in your own voice, without a one-time allowance per language, and one app for texts, SEO and translations.",
      notes: {
        nativeStorage: "Images and custom replacements via the app",
        brandVoice: "Store context; tone only with your own key",
        themeCheckout: "Emails: not stated",
        followChanges: "Automatic with Autopilot (Premium)",
        currency: "Not in checkout",
        aiProvider: "Through your own API key",
      },
    },
    langify: {
      kind: "Translation app for Shopify",
      summary:
        "Langify translates Shopify stores by hand or by machine, with a word allowance per plan. ContentPilot adds AI translation with your own instructions, any number of languages, SEO tools and content writing. Here is how they compare.",
      about:
        "Langify is a long-standing translation app for Shopify that writes into Shopify's own translation storage. On the free plan you translate up to five languages by hand. The paid plans machine-translate with DeepL and Google; their word allowance is credited once at sign-up, with more words sold as word packs. AI translation is in a closed beta from Growth.",
      strengths: [
        "Unlimited manual translations on every plan, including the free one.",
        "Checkout and notification translation even on the free plan.",
        "Image translation and import/export of translations from the Basic plan.",
        "Full control: the app never translates on its own, only when you tell it to.",
      ],
      ourEdge: [
        "AI translation without a word allowance — you pay your AI provider directly or pick a plan with AI included.",
        "Translations follow changes to the original text automatically.",
        "Your own instructions and a glossary for the AI.",
        "Writes and improves product texts, SEO titles and alt texts.",
        "SEO tools, AI-search visibility and a spreadsheet editor for the whole catalogue.",
      ],
      verdict:
        "Choose Langify if you mostly translate by hand and want to trigger every translation yourself. Choose ContentPilot if you want the AI to do most of the translating, without a word allowance, in your own voice and also when the original text changes.",
      notes: {
        nativeStorage: "Custom replacements via the app",
        brandVoice: "Formal/informal with DeepL only",
        aiProvider: "DeepL or the AI beta",
        followChanges: "By hand via “Translate outdated”",
        seoToolkit: "Translates SEO title and description",
        imagesPerLanguage: "Product, collection, article and theme images",
      },
    },
    gtranslate: {
      kind: "Translation service for many website platforms",
      summary:
        "GTranslate translates websites on many platforms through its own network, with no word limit. ContentPilot works inside Shopify, saves translations in your store and adds SEO and content tools. Here is how they compare.",
      about:
        "GTranslate translates websites on many platforms, Shopify among them. The free plan is a language switcher that translates the page in the visitor's browser — not indexed by search engines and not editable. The paid plans serve the translated pages from GTranslate's own “Translation Delivery Network”, so the translations live with GTranslate.",
      strengths: [
        "All languages and unlimited words, even on low-priced plans.",
        "Its proxy also translates most texts from other apps (paid plans).",
        "Translated pages are indexed, translated URLs from Business, country domains.",
        "Works on many platforms, not only Shopify; 15-day trial.",
      ],
      ourEdge: [
        "Translations are saved in your Shopify store and stay if you uninstall.",
        "AI translation in your own voice, with a glossary and a choice of AI provider.",
        "Writes and improves product texts, SEO titles and alt texts.",
        "SEO tools, AI-search visibility and a spreadsheet editor for the whole catalogue.",
      ],
      verdict:
        "Choose GTranslate if you translate websites on several platforms with one service and want no word limit. Choose ContentPilot if your shop runs on Shopify, you want the translations to belong to your store, and you want texts, SEO and translations in one app.",
      notes: {
        nativeStorage: "Stored with GTranslate",
        glossary: "Excluding terms only",
        themeCheckout: "Checkout, emails: not stated",
        followChanges: "Once the cache expires",
        seoToolkit: "Indexing and translated URLs",
        aiVisibility: "Translated pages readable by AI crawlers",
      },
    },
  },
};
