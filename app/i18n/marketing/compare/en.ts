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
    brandVoice: "Pro plan and up",
    themeCheckout: "Pro plan and up",
    thirdPartyApps: "Max plan",
    imageManager: "Pro plan and up",
    aiProvider: "Six providers",
    followChanges: "Max plan",
    imagesPerLanguage: "Not yet",
    currency: "Shopify Markets does this",
  },
  aboutHeading: "How {name} works",
  strengthsHeading: "Where {name} is strong",
  ourEdgeHeading: "What ContentPilot adds",
  verdictHeading: "Which one fits you?",
  pricingHeading: "Pricing",
  ourPricing:
    "ContentPilot has a free plan for up to 50 products and paid plans from €9.90 a month. Every plan includes unlimited languages. You bring your own AI key, so AI usage is billed by your AI provider at cost.",
  checkedAt: "September 2026",
  disclaimer:
    "Based on the providers' own App Store listings and help pages, as of {date}. Apps change quickly — check the current listing before you decide. “Not stated” means we could not find a clear answer, not that the feature is missing.",
  correction: "Spotted something out of date? Tell us and we will correct it.",
  detailLink: "Full comparison",
  otherComparisons: "Other comparisons",
  allComparisons: "All comparisons",
  competitors: {
    "translate-and-adapt": {
      kind: "Shopify's own free translation app",
      summary:
        "Translate & Adapt is free and built by Shopify. ContentPilot adds AI translation in any number of languages, a glossary, SEO tools and content writing — and, on its larger plans, your own AI instructions and texts from other apps. Here is how they compare.",
      about:
        "Translate & Adapt is made by Shopify and costs nothing. It translates up to two languages automatically; every further language is translated by hand. Its big strength is adapting content per market, for example different spellings for the UK and the US.",
      strengths: [
        "Completely free, made by Shopify itself.",
        "Adapts wording per market, such as British and American English.",
        "Covers theme, checkout and notification emails.",
        "A good fit if you only need one or two extra languages and translate little.",
      ],
      ourEdge: [
        "AI translation in any number of languages; from the Pro plan it follows your own tone and rules.",
        "A glossary, so brand names and fixed terms are never mistranslated.",
        "Translates texts from other apps, such as review widgets (Max plan).",
        "Updates translations automatically when you change the original text (Max plan).",
        "Writes and improves product texts, SEO titles and alt texts.",
        "A full SEO toolkit and a spreadsheet editor for the whole catalogue.",
      ],
      verdict:
        "Stay with Translate & Adapt if you sell in one or two extra languages and rarely change your texts. Choose ContentPilot when you want more languages, consistent wording, or one app for texts, SEO and translations. Both write into Shopify's own translation storage, so you can switch at any time and keep what you have.",
      pricing: "Free. Automatic translation for two languages; further languages by hand.",
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
      pricing:
        "A small free plan, then plans priced by number of languages and translated words.",
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
        "Your own instructions for the AI, so translations follow your tone (Pro plan and up).",
        "Unlimited languages on every plan.",
        "Writes and improves product texts, SEO titles and alt texts.",
        "A full SEO toolkit and AI-search visibility.",
        "A spreadsheet editor for the whole catalogue, plus variant image galleries (Pro plan and up).",
      ],
      verdict:
        "Choose Transcy if you need a currency converter beyond Shopify Markets or text translated inside images. Choose ContentPilot if you want translations in your own voice and one app for texts, SEO and translations.",
      pricing: "A free plan, then plans priced by languages and features.",
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
        "A spreadsheet editor for the whole catalogue, plus variant image galleries (Pro plan and up).",
      ],
      verdict:
        "Choose LangShop if you want human translators on call or a currency converter beyond Shopify Markets. Choose ContentPilot if you want unlimited languages and one app for texts, SEO and translations.",
      pricing: "A free plan for a small catalogue, then plans priced by languages and features.",
      notes: {
        aiProvider: "Choice of engines",
        followChanges: "New products, higher plans",
      },
    },
  },
};
