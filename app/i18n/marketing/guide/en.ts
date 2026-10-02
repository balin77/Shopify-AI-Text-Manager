import type { GuideCopy } from "./types";

export const guideEn: GuideCopy = {
  categories: {
    "getting-started": {
      title: "Getting started",
      intro: "Install the app, connect your AI provider and find your way around.",
    },
    "ai-content": {
      title: "Creating content with AI",
      intro: "Write, improve and create content — following your own rules.",
    },
    translations: {
      title: "Translations",
      intro: "Every language, every market and every text in your shop — and what happens when the original changes.",
    },
    bulk: {
      title: "Bulk editor",
      intro: "Edit the whole catalogue in one grid, export and import it, and fill in missing translations.",
    },
    media: {
      title: "Images and media",
      intro: "The Image Variant Manager, alt texts and image processing.",
    },
    seo: {
      title: "Keywords and SEO",
      intro: "Plan keywords, crawl your own shop and put technical SEO in order.",
    },
    "ai-visibility": {
      title: "Visibility in AI assistants",
      intro: "What ChatGPT, Perplexity and the like can read about your shop — and how to control it.",
    },
    "shop-data": {
      title: "Product data and store texts",
      intro: "Merchandising attributes, prices, stock, collection rules and the texts around checkout.",
    },
  },

  topics: {
    setup: {
      title: "Installation and the first sync",
      summary:
        "How to install the app, what happens on first launch, and why the app works with a local copy of your content.",
      sections: [
        {
          heading: "Installing",
          paragraphs: [
            "ContentPilot AI is installed from the Shopify App Store. Shopify shows you which data the app may read and write — nothing is installed until you approve it there. The app then opens directly inside your Shopify admin.",
          ],
        },
        {
          heading: "The first sync",
          paragraphs: [
            "On first launch the app reads your content from Shopify: products, collections, pages, blogs, articles, menus, metaobjects and their translations. Depending on the catalogue this takes a few seconds to a few minutes; progress runs as a background task.",
            "The app works with this local copy so that lists, filters and overviews are fast. Writes, however, always go to Shopify first — a change counts as saved only once Shopify confirms it.",
          ],
        },
        {
          heading: "Reloading",
          paragraphs: [
            "Products and collections are kept current automatically through Shopify's webhooks. Pages, blogs and articles have no such notifications; if you change them outside the app, reload the single entry with the reload button in the editor. Brand-new content appears after a full sync.",
          ],
        },
      ],
      tips: [
        "How many products, languages and content types you can edit depends on your plan. Current usage is shown under Settings → Plan.",
      ],
    },

    "ai-providers": {
      title: "AI providers and API keys",
      summary: "AI can be included in your plan, or you use your own access. How both work, and how to choose a model and limits.",
      sections: [
        {
          heading: "Your own key",
          paragraphs: [
            "ContentPilot AI writes with the AI provider you connect: Anthropic (Claude), OpenAI, Google Gemini, DeepSeek, Grok or HuggingFace. You enter your own API key — so the cost and the choice of model stay with you.",
          ],
          steps: [
            "Create an account with a provider and generate an API key.",
            "In the app, open Settings → AI API access and enter the key for that provider.",
            "Choose your preferred provider and model, then save.",
          ],
        },
        {
          heading: "AI included in your plan",
          paragraphs: [
            "Instead of your own key, you can choose a plan with AI included. Under Settings → Plan, turn on “With AI included” at the top: the cards then show the price with AI and roughly how much work it covers. You change your plan as usual with the button on the card.",
            "Which AI is used is decided by your plan alone: with an AI plan, the app works with the included AI. Without one, it uses your own key as soon as one is stored. If you have neither, you can try the included AI once for free.",
            "Before the included AI works, you confirm once under Settings → AI API access that your content may be sent to the named AI providers for this. That is also where you see how much of the included volume you have used in the current billing period.",
            "When the volume is used up, the app continues with your own key if you have stored one. Otherwise it continues in the next billing period. Translations are never deleted just because the volume ran out.",
          ],
        },
        {
          heading: "Per-minute limits",
          paragraphs: [
            "Each provider can be limited in tokens and requests per minute. This matters for large runs such as translating a whole catalogue: do not set the values higher than your provider account allows, or the provider will reject requests.",
          ],
        },
        {
          heading: "Sending images to the AI",
          paragraphs: [
            "Whether the AI may look at your product images is one shop-wide setting (Settings → AI instructions → General). It is off by default. Switched on, an alt text describes the actual picture and product texts can pick up visible details. HuggingFace and DeepSeek do not support images.",
          ],
        },
      ],
      tips: ["The key is stored encrypted. If you suspect misuse, replace it at the provider and enter the new one."],
    },

    "app-tour": {
      title: "A tour of the app",
      summary: "The five main areas — Content, Bulk, SEO, Tasks, Settings — and where to find what.",
      sections: [
        {
          heading: "The main navigation",
          paragraphs: ["At the top of the app you will find five areas:"],
          list: [
            "Content — the editor for every content type: catalogue (products, collections, subscription plans), online store (blogs, pages, policies, menus, metaobjects, filters, cookie banner), theme text, system text and direct translations.",
            "Bulk — the bulk editor, a spreadsheet over the whole shop.",
            "SEO — overview, analysis (page speed, crawl, hreflang), rankings (keywords, Search Console), linking (redirects, internal links) and technical (structured data, sitemap, IndexNow, AI search).",
            "Tasks — everything running in the background.",
            "Settings — AI access, AI instructions, glossary, SEO settings, plan.",
          ],
        },
        {
          heading: "Saving",
          paragraphs: [
            "What you type is only written when you save. As soon as you change something, Shopify's save bar appears at the top with Save and Discard. That applies to switches in the settings too: a change is a draft until you save it.",
            "The AI and copy buttons in the editors, on the other hand, save straight away — but only the one field they act on: an accepted AI suggestion, a translation into the language that is open, a copied text. Whatever you typed in other fields and have not saved stays a draft. Buttons that copy or translate the main-language text into every language are locked while that text has unsaved changes — save it first. In the bulk editor everything stays a draft until you save there.",
          ],
        },
        {
          heading: "Single-language shops",
          paragraphs: [
            "If your shop has only one language, the app hides its language bars. Translate buttons stay visible but greyed out, with a note that a second language is needed — so you can see what would be possible.",
          ],
        },
      ],
    },

    "storefront-embeds": {
      title: "Activating the app embeds in your theme",
      summary:
        "Some features need a small building block in your storefront. How to switch on the app embeds — without touching your theme code.",
      sections: [
        {
          heading: "What an app embed is",
          paragraphs: [
            "Shopify lets apps bring features into the storefront through “app embeds” that you switch on and off in the theme editor. ContentPilot AI never changes your theme code; everything that appears on the storefront runs through these switches.",
          ],
          list: [
            "Structured data (JSON-LD) — markup for rich results on Google.",
            "Open Graph / social previews — image, title and description when links are shared.",
            "Variant gallery — shows the matching images for each variant.",
            "Language and country selector — a switcher built on Shopify's own localization.",
            "Direct translations — translates text from other apps.",
            "Images and videos per language — shows the product images and videos you replaced per language or market.",
            "Web Vitals — measures page speed for real visitors.",
          ],
        },
        {
          heading: "Activating",
          paragraphs: [],
          steps: [
            "In the app, open Content → Theme → App embeds (or use the hint in the relevant section).",
            "Click the activate button for the embed you want — the theme editor opens with that embed preselected.",
            "Switch it on, adjust its settings if needed, and save the theme.",
          ],
        },
      ],
      tips: [
        "If your theme already outputs a type of markup, switch the same type off in the app — duplicate markup causes warnings in Search Console. The app checks this for you (see “Structured data”).",
      ],
    },

    tasks: {
      title: "Tasks and background work",
      summary: "Long jobs run as background tasks. How to keep track of them.",
      sections: [
        {
          heading: "What a task is",
          paragraphs: [
            "Translating into every language, large bulk saves, a crawl, AI runs over many entries: anything that takes longer than a moment starts as a task. You can keep working or leave the page in the meantime.",
            "The bell at the top of the app shows how many tasks are running and tells you when one finishes. Under Tasks you find the full list with status, progress and — for failures — the reason.",
          ],
        },
        {
          heading: "The statuses",
          paragraphs: [],
          list: [
            "Pending — the task is waiting in the queue.",
            "Running — it is being worked on.",
            "Completed — everything went through.",
            "Completed with errors — part of it succeeded, the rest is listed individually.",
            "Failed — nothing was written; the reason is in the task.",
          ],
        },
      ],
      tips: [
        "When the bulk editor starts a task, the grid reloads itself as soon as it finishes — no manual refresh needed.",
      ],
    },

    "content-editor": {
      title: "The content editor",
      summary:
        "One editor for products, collections, pages, articles and more: list on the left, fields in the middle, SEO sidebar on the right.",
      sections: [
        {
          heading: "Layout",
          paragraphs: [
            "Every content type opens the same editor. On the left you pick an entry from a searchable list, in the middle you edit its fields, and on the right the sidebar shows the SEO score, keywords, readability and structured data of that entry.",
            "The language bar sits at the top. In the primary language you edit the original, in every other language its translation. Coloured markers show where a translation is missing.",
          ],
        },
        {
          heading: "Fields",
          paragraphs: [
            "Text fields (title, description, SEO title, meta description, handle) carry a row of AI buttons underneath: generate (on an empty field) or improve, format and translate. Every field has a question mark explaining what it is for, and a button to clear it.",
            "The Details area holds the attributes that are not translated: vendor, tags, category, collections, theme template, visibility — and for products also prices, stock and sales channels.",
          ],
        },
        {
          heading: "Save and discard",
          paragraphs: [
            "Changed fields are collected until you save. Only the fields you actually changed are written — so a new title never accidentally overwrites tags or the description.",
          ],
        },
      ],
    },

    "ai-generate": {
      title: "Generating, improving and formatting text",
      summary: "The AI buttons on every text field — and what each one does to your text.",
      sections: [
        {
          heading: "Generate or improve — one button",
          paragraphs: [
            "Under every text field sits an AI button whose label depends on the field. When the field is empty it reads “Generate with AI” and writes a new text. The AI receives the entry's context — title, product type, tags and, if allowed, the image — plus your instructions for this field.",
            "When the field already holds text, the same button reads “Improve with AI” and rewrites the existing text freely: clearer, better structured, closer to your style rules and to the keywords assigned to the entry.",
            "Before it starts, you can give the AI an instruction for this one run, such as “Highlight the wool quality”. It takes precedence over every other rule.",
          ],
        },
        {
          heading: "Format",
          paragraphs: [
            "Leaves the content alone and changes only the form: capitalisation, punctuation, paragraphs and lists. Useful for making many products look consistent.",
          ],
        },
        {
          heading: "Accepting a suggestion",
          paragraphs: [
            "The result first appears as a suggestion above the field. “Accept” puts it into the field and saves exactly that one field straight away — other fields where you still have unsaved changes are left alone. “Decline” leaves everything as it was. “Accept & translate” saves the accepted text and carries it straight into every language.",
          ],
        },
      ],
      tips: [
        "SEO title and meta description have their own length limits. The AI keeps to them, and the counter under the field shows where Google would cut the text off.",
      ],
    },

    "ai-instructions": {
      title: "AI instructions and style rules",
      summary: "How to teach the AI your tone, your formats and your rules for each field.",
      sections: [
        {
          heading: "Where",
          paragraphs: ["Settings → AI instructions has several levels:"],
          list: [
            "Writing style — tone, form of address, sentence length and language preferences for all generated text.",
            "Formatting — how the Format action shapes text.",
            "Translation — tone and rules for AI translations (formal or informal, for example).",
            "Per field and content type — an example output and detailed rules, such as “Product description: three paragraphs, one bullet list of materials”.",
          ],
        },
        {
          heading: "Writing good instructions",
          paragraphs: [
            "The more concrete, the more consistent the result. A short real example from your own shop often works better than a long list of rules. Say what the AI should avoid (superlatives, certain words) and how long you expect the result to be.",
          ],
        },
      ],
      tips: [
        "Changed instructions apply to new generations. Existing texts change only when you generate or improve them again.",
        "If a term must never be translated, or always translated the same way, that belongs in the glossary, not in the instructions.",
      ],
    },

    "create-content": {
      title: "Creating new content",
      summary:
        "Create products, collections, pages, articles and metaobjects right in the app — optionally with AI-written text and translated straight away.",
      sections: [
        {
          heading: "The create dialog",
          paragraphs: [
            "In each content type's list, “New” opens a dialog with the most important fields. Required fields are marked with a red asterisk. Further fields can be expanded when you need them.",
          ],
        },
        {
          heading: "Completing with AI and translating",
          paragraphs: [
            "At the end of the dialog are two switches: “Write the rest with AI” fills every field you left empty (description and SEO texts, for example) based on what you entered. “Translate afterwards” carries the result into every language. If you attached an image and image sharing is on, the AI can take it into account.",
          ],
        },
        {
          heading: "Unpublished",
          paragraphs: [
            "Everything the app creates is created unpublished. You review it in the editor and make it visible when it is ready.",
          ],
        },
      ],
    },

    translating: {
      title: "Translating in the editor",
      summary: "Translating one field, translating everything, choosing languages — and what counts as “saved”.",
      sections: [
        {
          heading: "One field or everything",
          paragraphs: [
            "Choose a foreign language at the top. Every field now has a translate button that carries the text over from the primary language. In the primary language, the globe button translates a field into every language at once; “Translate all” in the action bar translates the whole entry.",
            "Ctrl+click (Mac: Cmd+click) on a language button takes that language out of such runs — for example when you have it translated by hand.",
          ],
        },
        {
          heading: "What gets translated",
          paragraphs: [
            "Titles, descriptions, SEO texts, handles, alt texts, product options and their values, metafields, metaobject fields, menus, theme text and system text. Which additional product metafields are included is set under Settings → Metafields — including fields owned by other apps.",
          ],
        },
        {
          heading: "Saved means confirmed",
          paragraphs: [
            "A translation counts as saved only once Shopify echoes it back. If Shopify does not accept a translation, you see it on the affected field — instead of a success message about something that never arrived.",
            "The same applies to clearing: a translation counts as removed only once Shopify confirms it; otherwise it stays visible, the field stays marked as changed so you can save again, and you are told. For product options and metafields, a language Shopify refused is named in the task, which then shows “completed with errors”.",
          ],
        },
      ],
      tips: ["Translations you type yourself are never overwritten by the AI. The AI fills only what you ask it to."],
    },

    glossary: {
      title: "Glossary",
      summary: "Decide which terms are never translated and which always get the same translation.",
      sections: [
        {
          heading: "What it is for",
          paragraphs: [
            "Brand names, product lines and technical terms have to be right in every language. In the glossary (Settings → AI instructions → Glossary) you enter a term in the primary language and decide per language whether it stays unchanged or gets a fixed translation.",
          ],
        },
        {
          heading: "When it applies",
          paragraphs: [
            "The glossary is added to every AI translation automatically — in the editor, in the bulk editor and in automatic translations. It does not apply when generating new text in the primary language; that is what the AI instructions are for.",
          ],
        },
      ],
      tips: [
        "New glossary entries apply to new translations. Existing translations change only when you translate them again.",
      ],
    },

    markets: {
      title: "Markets and market-specific translations",
      summary: "German for Switzerland worded differently from German for Germany: how the app handles Shopify Markets.",
      sections: [
        {
          heading: "Two layers",
          paragraphs: [
            "Shopify stores one global translation per language. With Shopify Markets there can additionally be a version for a single market that takes precedence there — “Velo” instead of “Fahrrad” for Switzerland, for example.",
            "In the app you choose the market next to the language. Without a market you edit the global translation; with a market, the override for exactly that market.",
          ],
        },
        {
          heading: "Good to know",
          paragraphs: [],
          list: [
            "Only active markets are offered.",
            "The URL handle cannot differ per market — Shopify allows one per language.",
            "When the original text changes, a market override is removed as soon as the global translation is removed or re-translated. A market override is never re-translated automatically — it is your own wording.",
          ],
        },
      ],
    },

    "source-changes": {
      title: "When the original text changes",
      summary:
        "A translation of text that no longer exists is worse than none. You decide whether it is deleted or re-translated.",
      sections: [
        {
          heading: "The problem",
          paragraphs: [
            "Change a product description and the French version keeps describing the old product. Shopify only marks it as “outdated” — on the storefront it stays visible.",
          ],
        },
        {
          heading: "Your two options",
          paragraphs: ["Under Settings → AI instructions → Translations:"],
          list: [
            "Delete translations on change (default: on) — the outdated translation is removed. The shop then shows the original text in that language until you translate again.",
            "Re-translate automatically (Max plan) — the AI translates the new text into every published language, including ones that never had this field. This option replaces the deletion.",
          ],
        },
        {
          heading: "Changes outside the app, too",
          paragraphs: [
            "If you edit text in the Shopify admin, with another app or through an import, the app notices: for products and collections immediately through Shopify's notifications, for pages, articles, blogs and policies through a daily check. The translations are then handled according to your setting.",
            "Automatic translations run as a background task. If you save a translation yourself in the meantime, your version wins.",
          ],
        },
      ],
    },

    "translated-handles": {
      title: "Translated URLs and redirects",
      summary:
        "A translated handle gives each language its own address. The app writes the redirect every change needs.",
      sections: [
        {
          heading: "What a handle is",
          paragraphs: [
            "The handle is the part of the URL after /products/ or /pages/. Translated, Spanish becomes /es/products/caja-de-madera instead of /es/products/wooden-box. That helps ranking in each language.",
          ],
        },
        {
          heading: "Redirects",
          paragraphs: [
            "Change a handle — in the original or in a translation — and the old address leads nowhere. So the app automatically creates a 301 redirect from the old address to the new one, repairs existing redirect chains on the way, and removes a redirect when you go back to the old handle.",
          ],
        },
        {
          heading: "Automatic re-translation",
          paragraphs: [
            "Handles are only re-translated automatically if you explicitly switch that on as well — changing a URL is a decision of its own. Even then a handle is only refreshed where it was already translated, and only where a redirect is possible. Blog handles are never changed automatically, because a redirect cannot cover the articles underneath.",
          ],
        },
      ],
    },

    "theme-content": {
      title: "Translating theme text",
      summary: "Buttons, labels, sections and theme settings — the text that lives inside your theme.",
      sections: [
        {
          heading: "The areas",
          paragraphs: ["Content → Theme lists the text of your published theme, split the way Shopify splits it:"],
          list: [
            "Default content — the theme's language file: “Add to cart”, “Sold out”, form labels.",
            "Section groups and static sections — header, footer and fixed sections.",
            "Templates — the sections on product, collection and other pages.",
            "Theme settings — text stored in the theme's settings.",
            "App embeds — technical content, view only.",
          ],
        },
        {
          heading: "Per theme and per market",
          paragraphs: [
            "Theme translations belong to one particular theme. If you switch themes, the new theme's text has to be translated. As with all other content, you can add market-specific versions.",
          ],
        },
      ],
      tips: [
        "If you change a theme text in the primary language, its translations are deleted or re-translated according to your setting — just like products.",
        "Images in the theme appear as an image preview. You can choose a different image per language and market — see “Different images and videos per language”.",
      ],
    },

    "images-per-language": {
      title: "Different images and videos per language",
      summary:
        "Show customers in a language or market a different image — for example a banner or product photo with translated text on it.",
      sections: [
        {
          heading: "What it is for",
          paragraphs: [
            "Text can be translated, text inside an image cannot. A banner saying “Sale” or a product photo with German labels looks the same in every language. With “Images and videos per language” you choose a different image for a language — and, if you like, only for one market. It replaces the original one to one; every other language keeps seeing the original.",
          ],
        },
        {
          heading: "Theme images",
          paragraphs: [
            "Images in your theme (for example a banner on the home page) are under Content → Theme, among the texts of their section. Instead of a text field you see a preview of the image.",
            "Whether your theme shows the image of the chosen language depends on the theme. After saving, check your store in that language; some themes may keep showing the original image.",
          ],
          steps: [
            "Choose the language at the top — and, if the image should only differ in one market, the market.",
            "Click “Choose image for this language” at the image and pick an image from your files or upload one.",
            "Save. “Use original image” takes the choice back.",
          ],
        },
        {
          heading: "Product images",
          paragraphs: [
            "You set a replacement image right in the product's image gallery — also when the image manager is switched off. In the main language there is nothing special. Switch to a foreign language (and, if you like, to a market) and select an image in the gallery: in the selection's button row the button “Upload replacement image” appears between “Move” and “Delete”. Clicking it opens your files, where you pick an image or upload a new one; only what can replace the original is offered. The chosen image shows in the gallery right away, in place of the original, marked with a small round symbol in its top-left corner. It is only saved when you press “Save” at the top; the info box reports the result. “Discard” takes your choice back. Clicking the symbol shows you the original (the symbol turns grey), another click shows the replacement again. “Remove replacement image” makes the original apply again — that too is only applied with “Save”. Use an image with the same proportions as the original — the store keeps the original's frame, so a different shape gets cropped or leaves gaps.",
            "For your store to show the replacements, turn on the “Images and videos per language” app embed once (the message after saving links straight to it). The images are replaced in the product page gallery and in the image shown when the link is shared and to search engines.",
          ],
          list: [
            "A replacement for a specific market takes precedence over the replacement for “All markets”.",
            "Your choices apply per language and market: you can choose something in one language, switch to another, and apply everything at the end with one click on “Save”.",
            "If you delete an image in the app, all of its replacement images (in every language and market) are deleted with it.",
            "In the image manager, the variant galleries show the replacement image too, and you can set it there as well: select the image in a variant gallery and the same button appears. It is the same replacement as under “All images” — what you choose in one place shows in both. Images that are only in a variant gallery (not under “All images”) and YouTube or Vimeo links in a variant gallery cannot be replaced yet, and 3D models not at all; the button is greyed out there and says why.",
            "If your plan does not (or no longer) include replacement images and videos, for example after a plan change, your store keeps showing the replacements that already exist. You see them in the gallery and can remove them there; new replacements can no longer be set. An uploaded video can take Shopify a few minutes to process; the file is already in your files by then and can be picked from there.",
            "If there are replacement images that no longer belong to anything (for example to a market or language that no longer exists in your store), a warning appears below the gallery where you can remove them. If you convert an image to WebP, the old image's replacement images are carried over to the new file automatically; only if that fails do they appear in this warning and have to be set again. Unsaved replacement images from a foreign language stay when you switch to the main language; a line below the gallery names the languages in which something is still waiting for “Save”.",
          ],
        },
        {
          heading: "Videos",
          paragraphs: [
            "The same way you also replace a product's videos per language and market — for example with a dubbed version. A video uploaded to Shopify is replaced by another uploaded video (from your files or uploaded new), a YouTube or Vimeo video by another YouTube or Vimeo link. An image cannot be replaced by a video or the other way round; 3D models are not replaced.",
            "Shopify processes a newly uploaded video for a few minutes. If a note says so, pick the video from your files a little later.",
            "Videos in the theme settings (for example a video section on the home page) are entered per language as a different link; the AI does not change them.",
          ],
        },
        {
          heading: "What is not replaced",
          paragraphs: [
            "Product cards in collections, the cart, and feeds for Google Shopping, the Shop app and other sales channels keep showing the original. For videos, the description of the video for search engines stays with the original. Collection and blog images are not covered yet.",
          ],
        },
      ],
      tips: [
        "The AI does not translate or change images. That is why the translate buttons offer nothing for theme images — an image stays until you choose another one.",
        "An image that stays the same in a language does not count as a missing translation.",
      ],
    },

    "direct-translations": {
      title: "Direct translations for other apps' text",
      summary:
        "Review widgets, badges, page builders: text that Shopify's translations cannot reach is translated here.",
      sections: [
        {
          heading: "What it is for",
          paragraphs: [
            "Many apps write their text straight into the storefront without offering it to Shopify for translation, so it looks the same in every language. Direct translations capture that text and replace it in the visitor's browser with your translation.",
          ],
        },
        {
          heading: "How it works",
          paragraphs: [],
          steps: [
            "Switch on the “Direct translations” app embed in the theme editor.",
            "Under Content → Direct translations, switch on collection and save.",
            "Visit your storefront — the text found there then appears in the list.",
            "Translate the entries, one by one or with AI, and save.",
          ],
        },
      ],
      tips: [
        "Unlike everywhere else, the primary language is offered as a target here too: another app's text can be in any language.",
      ],
    },

    menus: {
      title: "Editing and translating menus",
      summary: "Rename, reorder, nest and retarget — without losing translations.",
      sections: [
        {
          heading: "A full menu editor",
          paragraphs: [
            "Under Content → Menus you edit your navigation as a tree: add, delete, rename, drag to move and nest up to three levels deep. An item's target is chosen from products, collections, pages, blogs, articles, policies, metaobjects or a free URL.",
          ],
        },
        {
          heading: "Translations are kept",
          paragraphs: [
            "In Shopify, moving a menu item under a different parent loses its translations. The app captures them before saving and restores them afterwards — for every sub-item and for market-specific versions too.",
          ],
        },
        {
          heading: "Careful with simultaneous changes",
          paragraphs: [
            "Shopify always saves a menu as a whole. If somebody changed the menu elsewhere in the meantime, the app refuses to save and tells you what changed — instead of silently overwriting the other change.",
          ],
        },
      ],
    },

    metaobjects: {
      title: "Metaobjects",
      summary: "Create, edit, translate and delete entries — field by field.",
      sections: [
        {
          heading: "Editing entries",
          paragraphs: [
            "Content → Metaobjects shows your metaobject types and their entries. Each entry is a card with all its fields; text fields can be edited, filled by AI and translated, colours and files are picked.",
          ],
        },
        {
          heading: "New entries and taxonomy",
          paragraphs: [
            "New entries are created through the create dialog. Fields that reference Shopify's product taxonomy (colour or pattern, for example) are picked from the list of permitted values.",
          ],
        },
        {
          heading: "Deleting",
          paragraphs: [
            "Before deleting, the app shows how many products use an entry. If an entry is still in use, Shopify refuses the deletion. Whole metaobject types can be deleted as well — Shopify removes every entry of that type with it.",
          ],
        },
      ],
      tips: [
        "Shopify decides which fields are translatable. Colours, files and taxonomy values exist once per shop, not per language.",
      ],
    },

    "bulk-editor": {
      title: "The bulk editor",
      summary:
        "A spreadsheet over the whole shop: filter, change hundreds of cells and save only what you touched.",
      sections: [
        {
          heading: "What is in it",
          paragraphs: [
            "The bulk editor (the Bulk area) shows products, variants, collections, articles, pages, blogs, policies, metaobjects and images as rows. You choose which columns you see — titles, SEO texts, handles, metafields, options, alt texts, prices, merchandising attributes — including several languages side by side.",
          ],
        },
        {
          heading: "Editing",
          paragraphs: [
            "Filter to the rows you care about and type straight into the cells. Rectangular ranges can be pasted like in a spreadsheet. Changed cells are highlighted, and steps can be undone.",
          ],
        },
        {
          heading: "Saving",
          paragraphs: [
            "Only changed cells are saved. If Shopify refuses a value, exactly that cell is marked as failed — every other change still goes through. Very large saves run as a background task.",
            "Select columns (status or taxable, for example) accept only their permitted values. A pasted value such as “Yes” in a status column is refused and named, instead of writing something wrong.",
          ],
        },
      ],
      tips: [
        "Cells that need a picker (product category or collection membership, for example) are read-only in the bulk editor. The tooltip points you to the single editor.",
      ],
    },

    "bulk-csv": {
      title: "CSV export and import",
      summary: "Download the catalogue as a spreadsheet, edit it elsewhere and bring it back.",
      sections: [
        {
          heading: "Export",
          paragraphs: [
            "The export writes the bulk editor's current selection and columns to a CSV file — every page of the filter, not just the visible one. It works with Excel, Numbers or Google Sheets.",
          ],
        },
        {
          heading: "Import",
          paragraphs: [
            "On import the app loads your file, compares it with the current state and shows only the cells that differ. You review the changes in the editor and save them like any other edit — with the same per-cell checks.",
          ],
        },
      ],
      tips: ["The first column holds each row's identifier. Leave it unchanged, or the app can no longer match the row."],
    },

    "bulk-translate": {
      title: "Adding missing translations",
      summary: "Translate everything that is still empty in a language, across the current filter.",
      sections: [
        {
          heading: "How it works",
          paragraphs: [],
          steps: [
            "In the bulk editor, filter to the rows you want translated.",
            "Open “Add missing translations”.",
            "Choose the target languages at the top and select or deselect entries or single fields in the list.",
            "Start — the translation runs as a background task.",
          ],
        },
        {
          heading: "What happens",
          paragraphs: [
            "Only empty translations are filled; an existing translation is never overwritten. The app re-checks what is really missing right before writing. Translated handles are optional and are normalised into a valid URL form.",
          ],
        },
      ],
    },

    "image-manager": {
      title: "The Image Variant Manager",
      summary: "Every variant gets its own images: build galleries per variant, sort them and show them in your shop.",
      sections: [
        {
          heading: "What it is about",
          paragraphs: [
            "Shopify knows only one image per variant. The Image Variant Manager gives every variant its own gallery — a customer who picks “Red” sees only the red images. It replaces the standard image management on the product page inside the app.",
          ],
        },
        {
          heading: "Building galleries",
          paragraphs: [
            "The product gallery sits at the top, with one gallery per variant below. Drag images from the product gallery or your Shopify file library into a variant, sort them by dragging, and copy or move them between variants. Videos, YouTube/Vimeo links and 3D models are supported too.",
          ],
        },
        {
          heading: "Showing them in the shop",
          paragraphs: [
            "For visitors to see the variant galleries, switch on the “Variant gallery” app embed in the theme editor. It adopts your theme gallery's settings. If two galleries appear on top of each other, enter your theme gallery's CSS selector in the embed.",
          ],
        },
      ],
      tips: ["The Image Variant Manager, bulk upload and WebP conversion are included from the Pro plan."],
    },

    "image-bulk-upload": {
      title: "Bulk upload with filename matching",
      summary: "Upload all images of a product at once — the filename decides which variant each one belongs to.",
      sections: [
        {
          heading: "The naming pattern",
          paragraphs: [
            "Name the files ProductName_Variant1_Variant2_Identifier.jpg, for example shirt_red_M_01.jpg. The parts between the first and last underscore are the variant's option values; the last part tells several images of the same variant apart.",
          ],
        },
        {
          heading: "Uploading",
          paragraphs: [],
          steps: [
            "Open the bulk upload in the Image Variant Manager.",
            "Drop all files in at once.",
            "Check the proposed assignment — files that were not recognised are flagged.",
            "Save. The images are uploaded and assigned to the variant galleries.",
          ],
        },
      ],
      tips: ["If a file cannot be uploaded, it is named in a message and is not added — upload it again afterwards.", "The assignment happens at upload. Renaming the files later changes nothing about it."],
    },

    "alt-texts": {
      title: "Alt texts",
      summary: "Image descriptions for Google and screen readers — generated, from a template or by hand, and translated.",
      sections: [
        {
          heading: "Where alt texts live",
          paragraphs: [
            "You edit alt texts on the image in the Image Variant Manager, in the editor for collection and article images, and collectively in the bulk editor, where every row of the Images row type is one image — product images as well as images from your file library.",
            "An alt text you type in the Image Variant Manager is not saved when you leave the field: it stays a draft until you press “Save” at the top, like every other change on the page. “Discard” takes it back. If saving fails for an image, the info box tells you why, your text stays in the field and is sent again with the next “Save”. If you already gave an alt text to an image you have only just added, the same “Save” saves it too, as soon as Shopify has created the image. If you switch language, market or product while alt texts are unsaved, the app asks first; whatever you have already saved finishes saving after the switch too. In the main language the alt texts apply to every market, so switching the market there does not ask. If you delete an image, its unsaved alt text goes with it. A YouTube/Vimeo link or a 3D model added to a variant has no alt text — its box says so instead.",
          ],
        },
        {
          heading: "With AI",
          paragraphs: [
            "The AI writes one alt text per image. The result — and likewise a translation into the language that is open — then sits in the field and is saved for that one image straight away; alt texts you typed for other images stay drafts. For an image that has not been saved itself yet, these buttons are locked until you save it. “Translate to all languages” writes to the other languages straight away — which is why that button is only available while the main-language alt text has no unsaved changes. With image sharing on, it sees exactly that one image — and does not describe one that merely happens to sit next to it.",
          ],
        },
        {
          heading: "With templates",
          paragraphs: [
            "Alt text templates define a text per image position and language, such as “Elegant {Color} ceramic flower pot” for the main image, and apply it to every variant in one pass.",
          ],
        },
        {
          heading: "Translating",
          paragraphs: [
            "Alt texts are translated into every language like any other field, and refreshed by the same rules when the original changes. With a market selected in the editor, the Image Manager shows that market's alt texts (the language's own text where the market has none) and saves changes for that market only. “Translate to all languages” always writes the language's own text, which markets without their own text also use.",
          ],
        },
      ],
    },

    webp: {
      title: "WebP conversion",
      summary: "Convert images to the compact WebP format — faster pages with no visible loss of quality.",
      sections: [
        {
          heading: "Why WebP",
          paragraphs: [
            "At the same visual quality, WebP files are usually much smaller than JPEG or PNG. Smaller images load faster, and the largest image on a page often decides its measured load time.",
          ],
        },
        {
          heading: "How it works",
          paragraphs: [
            "In the Image Variant Manager you select images and start the conversion. It runs in the background; the converted image replaces the original wherever it is used, keeping its variant assignment and alt text.",
          ],
        },
      ],
      tips: ["Uploads and conversions count against a monthly allowance of your plan; usage is shown under Settings → Plan."],
    },

    keywords: {
      title: "Keyword library and assignment",
      summary: "Collect and research keywords and distribute them across products, collections, pages and articles — per language.",
      sections: [
        {
          heading: "The library",
          paragraphs: [
            "Under SEO → Keywords you collect search terms in groups, such as “wooden toys”. You add terms yourself or ask for suggestions. Every language has its own keywords — what people search for in German is a different word in French.",
          ],
        },
        {
          heading: "Distributing",
          paragraphs: [
            "“Distribute to content” assigns a group's keywords to matching content. In AI mode the AI picks one primary and several secondary keywords per entry; in manual mode you decide. Up to five keywords per entry and language are possible.",
          ],
        },
        {
          heading: "Using them",
          paragraphs: [
            "Assigned keywords appear in the editor's sidebar. The SEO score checks whether they appear in the title, description and meta texts, and the AI takes them into account when generating and improving.",
          ],
        },
      ],
    },

    "seo-score": {
      title: "SEO score and readability in the editor",
      summary: "A live score that reacts as you type — and honest hints about how readable your text is.",
      sections: [
        {
          heading: "The score",
          paragraphs: [
            "The sidebar shows a value from 0 to 100 for the current entry. It rates title, description, SEO title, meta description, alt texts and the use of your keywords, and it changes while you type — you do not have to save to see the effect. Every shortfall is listed individually.",
          ],
        },
        {
          heading: "Readability",
          paragraphs: [
            "Below it is a separate readability analysis: sentences that are too long, paragraphs that are too long, missing subheadings. A score is given only for English, German and Spanish, because validated formulas exist only for those — for other languages a number would simply be wrong.",
          ],
        },
        {
          heading: "Overview",
          paragraphs: [
            "SEO → Overview shows the distribution of scores across the whole shop and the most common problems — with a jump straight into the affected entry and the option to fix problems with AI.",
            "When the AI fixes a text in the main language, the app handles its translations exactly as it does when you save in the editor: depending on your setting under Settings → Translations, the old translations are removed or, with automatic translation on, translated again. The app also checks that Shopify really stored the text — otherwise the entry counts as failed.",
          ],
        },
      ],
    },

    crawl: {
      title: "Site crawl and on-page report",
      summary:
        "The app visits your shop the way a search engine does and reports what arrives — not just what is in the database.",
      sections: [
        {
          heading: "Step 1: delivery",
          paragraphs: [
            "The crawl fetches your storefront page by page, in every language. The first report shows what does not arrive: broken pages and links, server errors, redirects, slow responses — and, if you want, broken external links.",
          ],
        },
        {
          heading: "Step 2: on-page and indexing",
          paragraphs: [
            "The second report reads the same crawl: may Google index a page (noindex, canonical)? Does it have an H1, a meta description, enough content, images with alt text? Are there duplicate titles?",
            "The reports filter out false alarms — policy pages that technically cannot carry a meta description, for example, or pages you deliberately excluded. Where a finding belongs to a piece of content, one click opens the matching editor.",
          ],
        },
        {
          heading: "When",
          paragraphs: [
            "You start the crawl with “Scan now”; it also runs automatically every week. A comparison shows what changed since the last run. All findings can be exported as CSV.",
          ],
        },
      ],
    },

    performance: {
      title: "Page speed and quality",
      summary: "Test single pages with Google PageSpeed Insights and see real-user data from your own shop.",
      sections: [
        {
          heading: "Lab measurement",
          paragraphs: [
            "Under SEO → Page speed & quality you test a page with Google PageSpeed Insights: Core Web Vitals such as LCP, CLS and INP, plus accessibility and best practices from the same run. Every value explains what it measures and what typically makes it worse in Shopify shops.",
          ],
        },
        {
          heading: "Real visitors",
          paragraphs: [
            "With the “Web Vitals” app embed, the app measures the values for your actual visitors. This data often differs markedly from the lab measurement, and it is what Google rates. With little traffic it takes a few days until there are enough measurements.",
          ],
        },
      ],
      tips: [
        "The app diagnoses page speed but never changes your theme code. The hints tell you where the cause lies — a particular app or an oversized image, for example.",
      ],
    },

    "search-console": {
      title: "Google Search Console",
      summary: "Real clicks, impressions and positions from Google, right inside the app.",
      sections: [
        {
          heading: "Connecting",
          paragraphs: [],
          steps: [
            "Open SEO → Search Console.",
            "Sign in with the Google account that has access to your shop's property.",
            "Choose the property.",
          ],
        },
        {
          heading: "What you see",
          paragraphs: [
            "Which search terms your pages appear for, how often they are clicked and at which position they rank — with history and export. You see whether your keywords and texts are working, and find terms you almost rank well for already.",
          ],
        },
      ],
      tips: ["The Search Console connection is included in the Pro and Max plans."],
    },

    redirects: {
      title: "Redirects and 404 errors",
      summary: "Manage 301 redirects, resolve redirect chains and fix frequent 404 errors.",
      sections: [
        {
          heading: "Managing redirects",
          paragraphs: [
            "Under SEO → Redirects you view, search, create and delete your shop's redirects. Import and export use two columns, source path and target path; the import also recognises exports from Shopify, Yoast and Rank Math.",
          ],
        },
        {
          heading: "Chains",
          paragraphs: [
            "If A redirects to B and B to C, every visit takes a detour. The app finds such chains and loops in your redirect list and lets you point A straight at C.",
          ],
        },
        {
          heading: "404 errors",
          paragraphs: [
            "Addresses that visitors request and that do not exist are collected and sorted by frequency. For each one you can create a redirect to the right page directly. They are recorded as soon as one of the app's embeds is active in your theme.",
          ],
        },
      ],
    },

    "internal-links": {
      title: "Internal linking",
      summary: "Finds places where you mention products or collections but do not link to them yet.",
      sections: [
        {
          heading: "How it works",
          paragraphs: [
            "The app searches blog articles, pages and product descriptions for mentions of your products and collections that are not a link yet. Each find appears as a suggestion with the text excerpt.",
          ],
        },
        {
          heading: "Applying",
          paragraphs: [
            "Before accepting you see a preview of the text with the new link; once you confirm, it is inserted and saved to Shopify. Rejected suggestions do not come back in later scans. Internal links help visitors along and show search engines which pages belong together.",
          ],
        },
      ],
    },

    "sitemap-indexnow": {
      title: "Sitemap and IndexNow",
      summary: "Control what is in your sitemap, and tell search engines about changes immediately.",
      sections: [
        {
          heading: "Sitemap",
          paragraphs: [
            "Shopify generates sitemap.xml itself. Under SEO → Sitemap you see what is in it and get suggestions for pages better left out — thank-you pages or empty collections, for example. An exclusion sets Shopify's seo.hidden metafield and can be undone at any time.",
          ],
        },
        {
          heading: "IndexNow",
          paragraphs: [
            "IndexNow notifies Bing and other search engines immediately when a page is new, changed or removed, instead of waiting for the crawler's next visit. The app sets up the required key and reports changes automatically — including when you publish or hide pages in the bulk editor.",
          ],
        },
      ],
      tips: ["IndexNow is included in the Pro and Max plans."],
    },

    hreflang: {
      title: "hreflang check",
      summary: "For multilingual shops: checks whether every published language is actually translated.",
      sections: [
        {
          heading: "What it is about",
          paragraphs: [
            "Through hreflang, Shopify tells search engines that a page exists in every published language. If it is not translated in one of them, Google shows the original text under a foreign-language address there — confusing for visitors and weak for ranking.",
          ],
        },
        {
          heading: "The report",
          paragraphs: [
            "Under SEO → hreflang you see per language how much content is fully, partly or not at all translated, and jump straight to the gaps.",
          ],
        },
      ],
      tips: ["In a single-language shop this area is greyed out, because there is nothing to check."],
    },

    "structured-data": {
      title: "Structured data and social previews",
      summary:
        "JSON-LD for rich results on Google and Open Graph tags for shared links — and a check that nothing is duplicated.",
      sections: [
        {
          heading: "What is delivered",
          paragraphs: [
            "The “Structured data” app embed outputs schema.org markup for products, collections, articles, organisation, breadcrumbs, FAQs and videos. “Social previews” adds Open Graph and Twitter tags so a shared link appears with image, title and description.",
          ],
        },
        {
          heading: "Measure first, then switch on",
          paragraphs: [
            "Many themes already output their own markup, and duplicate markup produces errors in Google's test. So under SEO → Structured data the app reads the latest crawl and tells you per type whether to switch it on, whether your theme or another app already delivers it, or whether no measurement exists yet. The switches come last.",
          ],
        },
        {
          heading: "Videos",
          paragraphs: [
            "For product videos the app takes the upload date from Shopify automatically. For YouTube links in variant galleries Shopify knows no date; the check lists those products so you can set one.",
          ],
        },
      ],
    },

    "ai-discovery": {
      title: "agents.md and llms.txt",
      summary: "The files AI assistants read about your shop — generated from your catalogue and kept current.",
      sections: [
        {
          heading: "What the files are",
          paragraphs: [
            "/agents.md and /llms.txt are files AI assistants and AI crawlers read to understand a shop: who you are, what you sell, where your policies are. Shopify serves a default version; the app replaces it with one generated from your catalogue.",
          ],
        },
        {
          heading: "Generating and checking",
          paragraphs: [
            "Under SEO → AI search you generate both files with one click. You write the opening paragraph yourself — with AI help if you like — and the rest is generated from your products, collections and policies. The app then fetches the real address and shows whether your version is really being served.",
            "If you want, the app refreshes the files automatically when they are out of date. “Remove our version” hands the address back to Shopify at any time.",
          ],
        },
        {
          heading: "robots.txt",
          paragraphs: [
            "The same area checks whether your robots.txt locks out AI crawlers — some themes and apps do, without anybody noticing.",
          ],
        },
      ],
    },

    "catalog-readiness": {
      title: "Catalogue readiness and AI visits",
      summary: "What a product is missing before AI channels pick it up — and how many visitors come from AI assistants.",
      sections: [
        {
          heading: "Catalogue readiness",
          paragraphs: [
            "Shopify passes eligible products to AI channels automatically. Whether a product is eligible depends on how complete it is. The app checks five attributes for all active products — brand, category, GTIN/barcode, description and image — and lists what is missing.",
          ],
        },
        {
          heading: "Visits from AI assistants",
          paragraphs: [
            "With the Web Vitals embed switched on, the app counts visits coming from ChatGPT, Perplexity, Gemini, Copilot and other assistants — without cookies and without personal data, per day and landing page.",
            "Two limits come with it: clicks from Google AI Overviews look like ordinary Google visits, and Claude passes on no origin. Neither is counted — better too few than wrong.",
          ],
        },
      ],
    },

    "product-details": {
      title: "Product details, prices and stock",
      summary:
        "Vendor, tags, category, collections, prices, stock and sales channels — right next to the texts.",
      sections: [
        {
          heading: "Merchandising",
          paragraphs: [
            "In the product editor's Details area you edit vendor, product type, tags, Shopify's product category, collection membership, theme template and status. The theme template is picked from the templates that actually exist in your published theme.",
          ],
        },
        {
          heading: "Prices, shipping and stock",
          paragraphs: [
            "For each variant: price, compare-at price, cost per item, SKU, barcode, weight and customs information. The app reads stock live from Shopify and writes it only if the value has not changed since it was loaded — so an order placed in between is never overwritten.",
          ],
        },
        {
          heading: "Translating options",
          paragraphs: [
            "Below every option in the variants section — even when it is collapsed — “Translate” translates the option name and its values into every language, and “Copy to all languages” copies them unchanged. On an open option, the two buttons sit between “Delete” and “Done”. An option with a blue background is still missing a translation in at least one language. If you changed an option, save first: the buttons stay locked until the change is saved, so the old text is never translated.",
          ],
        },
        {
          heading: "Visibility",
          paragraphs: [
            "An active product is not automatically visible: it also has to be published to a sales channel. The app shows in which channels, regions and B2B catalogues a product appears.",
          ],
        },
      ],
    },

    "collection-rules": {
      title: "Collections and their rules",
      summary: "Manual and automated collections, the rule editor and sorting.",
      sections: [
        {
          heading: "Two kinds",
          paragraphs: [
            "Manual collections contain the products you add. Automated collections decide their members through rules such as “tag is sale” or “price below 50”. Members of an automated collection are shown in the app but cannot be changed by hand — Shopify would refuse or immediately undo it.",
          ],
        },
        {
          heading: "The rule editor",
          paragraphs: [
            "In the collection editor you edit an automated collection's conditions: tag, product type, vendor, price, category, metafields and more, with including and excluding conditions. Conditions the app cannot represent without loss stay read-only, so nothing is changed by accident.",
          ],
        },
        {
          heading: "Sort order",
          paragraphs: [
            "The sort order sets the order of products in the shop. “Manual” means the order you set in the Shopify admin; every other value sorts automatically.",
          ],
        },
      ],
    },

    "store-texts": {
      title: "Policies, checkout and system texts",
      summary: "The text outside the catalogue: policies, notifications, shipping methods, filters, subscription plans and more.",
      sections: [
        {
          heading: "What belongs here",
          paragraphs: ["Next to the catalogue, Content contains:"],
          list: [
            "Policies — returns, privacy, terms, shipping.",
            "Notifications — email templates, payment texts and other Shopify system text.",
            "Shipping and delivery — the names of shipping methods as they appear at checkout.",
            "Filters — the labels of the storefront filters.",
            "Subscription plans — names and descriptions of your subscription options.",
            "Shop metadata — the shop's name and description.",
            "Cookie banner — your consent banner's text, as soon as Shopify opens it up to apps.",
          ],
        },
        {
          heading: "Editing and translating",
          paragraphs: [
            "You edit and translate these texts in the usual editor. Some of them are managed by Shopify itself: there the primary language is read-only and maintained in the Shopify admin, while the translations are done in the app.",
          ],
        },
      ],
    },
  },
};
