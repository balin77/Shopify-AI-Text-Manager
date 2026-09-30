import type { CompareCopy } from "./types";

export const compareEn: CompareCopy = {
  title: "ContentPilot compared with other Shopify translation apps",
  intro:
    "How ContentPilot AI stacks up against Translate & Adapt, Weglot, Transcy and LangShop — what each app does well, where they differ, and which one fits which shop.",
  vsTitle: "ContentPilot vs {name}",
  vsMetaTitle: "ContentPilot vs {name}: Shopify translation apps compared",
  tableHeading: "Feature by feature",
  featureColumn: "Feature",
  support: {
    yes: "Yes",
    partial: "Partly",
    no: "No",
    unstated: "Not stated",
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
  ourNotes: {
    autoTranslate: "With your own AI key",
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
    "The table shows whether an app offers a feature at all. At every provider, ours included, some features only come with a paid plan — the price comparison below shows what each plan includes.",
  pricing: {
    heading: "Price comparison",
    intro: "Every plan of every app, side by side. What each plan includes is what the provider itself lists.",
    perMonth: "/ month",
    free: "Free",
    note: "Monthly prices in the provider's own currency, before tax. Several providers are cheaper when billed yearly. With ContentPilot you use your own AI key, so AI usage is billed separately by your AI provider.",
    summaries: {
      contentpilot: "Priced by catalogue size. Unlimited languages on every plan.",
      "translate-and-adapt": "Free. Automatic translation for two languages, further languages by hand.",
      weglot: "Priced by languages and translated words. 14-day free trial; some costs may be billed by Weglot outside your Shopify bill.",
      transcy: "Priced by languages, currencies and AI tokens. 7-day free trial on paid plans.",
      langshop: "Priced by languages and number of products. 14-day free trial on paid plans.",
    },
    plans: {
      contentpilot: {
        free: "50 products, 5 collections, all languages",
        basic: "100 products, 50 collections, 20 pages, policies, product images, options and metafields",
        pro: "500 products, blogs, theme and checkout texts, menus, metaobjects, own AI instructions, variant image galleries",
        max: "2,500 products, texts from other apps, automatic re-translation when texts change, weekly site checks",
      },
      "translate-and-adapt": {
        free: "Automatic translation into two languages; every other language translated by hand",
      },
      weglot: {
        free: "1 language, 2,000 words",
        starter: "1 language, 10,000 words",
        business: "3 languages, 50,000 words",
        pro: "5 languages, 250,000 words",
      },
      transcy: {
        free: "1 language, 1 currency, unlimited words, texts from other apps",
        localPlus: "1 editable language, 1 currency, AI engines, 150 AI tokens a month, multilingual SEO",
        regional: "3 languages (2 editable), 300 AI tokens a month, 3 currencies, 20 glossary entries, automatic translation, 10 images per language",
        continental: "15 languages (10 editable), 500 AI tokens a month, 15 currencies, 200 glossary entries, location detection, own DeepL/OpenAI/Gemini key",
      },
      langshop: {
        free: "1 language, 50 products, no word limit, multilingual SEO, basic switcher",
        basic: "1 language, 250 products, 5 glossary rules, bulk editing of translations, no LangShop branding",
        standard: "3 languages, 2,000 products, 100 glossary rules, auto-sync of translations, DeepL Pro/OpenAI/Google Cloud, texts from other apps",
        advanced: "5 languages, 5,000 products, 250 glossary rules, exclusion rules, Shopify Flow",
      },
    },
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
        "A good fit if you only need one or two extra languages and translate little.",
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
        "Stay with Translate & Adapt if you sell in one or two extra languages and rarely change your texts. Choose ContentPilot when you want more languages, consistent wording, or one app for texts, SEO and translations. Both write into Shopify's own translation storage, so you can switch at any time and keep what you have.",
      notes: {
        autoTranslate: "Two languages",
        imagesPerLanguage: "Theme images only",
      },
    },
    weglot: {
      kind: "Translation service for many website platforms",
      summary:
        "Weglot translates websites on many platforms and charges by translated words. ContentPilot works inside Shopify, saves translations in your shop and adds SEO and content tools. Here is how they compare.",
      about:
        "Weglot is a translation service for many website platforms, Shopify among them. It detects your store's text and serves translated pages through its own system. Plans are priced by the number of languages and translated words.",
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
        aiProvider: "Choice of engines",
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
        aiProvider: "Choice of engines",
        bulkEditor: "Translations only",
      },
    },
  },
};
