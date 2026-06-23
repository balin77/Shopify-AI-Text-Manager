# Plan — Full Translation Coverage (Translate & Adapt Parity)

Bring ContentPilot to complete coverage of all `TranslatableResourceType` values that Shopify's GraphQL Admin API exposes — i.e. everything Translate & Adapt can translate, plus our existing AI/brand-voice advantages.

The original scope of this plan was checkout-only ("PLAN_CHECKOUT_TRANSLATION"). After auditing the full T&A surface, the gap is broader than checkout — `SELLING_PLAN`, `EMAIL_TEMPLATE`, theme `APP_EMBED` etc. are all missing. This rename reflects the actual operation.

---

## 1. Where Shopify stores translations (background for checkout)

**Checkout strings are not in the theme.** Shopify docs are explicit:

> "Shopify provides checkout and system message translations through the Shopify Language Editor. However, this data is stored by Shopify outside of storefront locale files."

- Theme `locales/*.json` files (`en.default.json`, `de.json`, …) contain **no** checkout strings.
- There is no `checkout.json` in the theme. Legacy `checkout.liquid` (Plus only) is gone with Checkout Extensibility.
- The 33 built-in checkout languages live server-side at Shopify and are **not** directly readable/writable by apps.

## 2. Storage layers

| Layer | What lives there | App access |
|---|---|---|
| **Built-in checkout translations** (33 langs) | Shipping/payment/order-summary strings, cookie banner, privacy policy, data-sales-opt-out, Shopify default-theme strings | Read-only via UI; **not** writable by apps — lives server-side at Shopify, not in any API resource |
| **Merchant overrides (Checkout & System)** | Admin → Settings → Checkout → Checkout language → Edit checkout content | Writable as `translatableResource` type **`SHOP`** via Translations API (`translatableResource` query + `translationsRegister` mutation, with `translatableContentDigest`) |
| **Theme `t:` keys** (Storefront only) | The active theme's `locales/*.json` keys (e.g. `general.cart.title`) | `ONLINE_STORE_THEME_LOCALE_CONTENT` — fully readable/writable; resource ID is the theme's GID |
| **Checkout UI Extensions** | Strings in `extensions/<name>/locales/*.json` inside the app repo | Owned by the app that ships the extension |
| **Email templates** (order confirmation etc.) | `EMAIL_TEMPLATE` resource type | Translations API |

`TranslatableResourceType` enum has **no `CHECKOUT`** value — confirmed from the GraphQL schema. Checkout customization for apps therefore goes through `SHOP`.

### Translate & Adapt UI vs. API mapping

The "Theme-Standardinhalte" rubric in T&A is a UI grouping that **mixes two API resources**:

- **"Theme-Texte"** (Storefront `t:` keys) → `ONLINE_STORE_THEME_LOCALE_CONTENT`
- **"Checkout & System"** → `SHOP` (keys like `checkout.*`, `notifications.*`)

The grey "bereits übersetzt"-banner that T&A shows for supported languages is informational only — the underlying translation lives in Shopify's backend, not in any API resource an app can read or modify. An app can **only** lay overrides on top via `SHOP`.

### Notes on `ONLINE_STORE_THEME_LOCALE_CONTENT`

- Resource ID is the theme GID (`gid://shopify/OnlineStoreTheme/...`)
- Translatable fields are **dynamic keys** that depend on the theme — Dawn ≠ a custom theme
- Bound to a specific theme; on theme publish/switch, translations must be re-registered against the new theme ID
- Subject to a separate Translation API rate-limit — batch when registering many keys

## 3. The 33 pre-translated checkout languages

Bulgarian, Chinese (Simplified), Chinese (Traditional), Croatian, Czech, Danish, Dutch, English, Finnish, French, German, Greek, Hindi, Hungarian, Indonesian, Italian, Japanese, Korean, Lithuanian, Malay, Norwegian (Bokmål), Polish, Portuguese (Brazil), Portuguese (Portugal), Romanian, Russian, Slovak, Slovenian, Spanish, Swedish, Thai, Turkish, Vietnamese.

Shopify auto-applies these the moment the language is enabled on the shop/market — no app needed for the base case.

### Languages NOT covered out-of-the-box (opportunity surface)

Arabic, Hebrew, Ukrainian, Estonian, Latvian, Catalan, Serbian, Tagalog/Filipino, all African languages, Persian/Farsi, Urdu, Bengali, …

For these languages the merchant gets either English fallback or the language-editor defaults — a translation app can fill the gap by writing `SHOP` translations.

## 4. How competitors offer "checkout translation"

- **Weglot, Langify, ConveyThis, LangShop, CartLingo** all rely on the same underlying mechanism: `SHOP` translations via the Translations API to override the merchant-editable checkout strings, plus telling Shopify which language the visitor selected so the matching built-in pack loads.
- Weglot specifically: "indicates to Shopify the language chosen by the visitor to make Shopify display the same language" + edits `Checkout & System` strings in the admin language editor for any missing pieces.
- None of them can replace Shopify's *built-in* 33-language pack — they layer on top with overrides.
- For checkout UI **extensions** they own (e.g. translator widgets in checkout), they ship their own `locales/` JSON.

## 5. Where we have an edge over T&A

- **AI-driven translation with brand voice / tone of voice** — T&A only does generic machine translation
- **Direct Translations** for storefront strings rendered by third-party apps that don't sit in any `translatableResource` — a real T&A blind spot
- **Bulk operations** (translate-all-locales, group-level actions, lazy field pagination)

## 6. Coverage audit — every translatable resource type

Authoritative list from [TranslatableResourceType enum](https://shopify.dev/docs/api/admin-graphql/latest/enums/TranslatableResourceType) (30 values, verified 2026-06).

**Key insight from Phase 0 probe + T&A nav inspection (2026-06-22):** T&A's *"Theme-Standardinhalte"* is **not** a separate resource — it is `ONLINE_STORE_THEME_LOCALE_CONTENT` re-grouped by the locale file's top-level prefix (`accessibility.*`, `accounts.*`, `announcement_bar.*`, `blogs.*`, **`checkout.*`**, `general.*`, `gift_cards.*`, `localization.*`, `newsletter.*`, `onboarding.*`, `products.*`, `recipient.*`, `sections.*`, `templates.*`). The "Checkout and system" group inside it contains **theme-side** checkout-adjacent strings (e.g. "Return to cart"), **not** the server-rendered Shopify checkout page (which lives in the un-overridable 33-language built-in pack — see §1–3).

Probe also confirmed: `SHOP` exposes only `meta_title`/`meta_description` on this shop. The original plan's assumption that `SHOP` contained `checkout.*`/`notifications.*` keys was wrong.

| Resource-Type | T&A | ContentPilot today | Target rubric | Notes |
|---|---|---|---|---|
| `ARTICLE` | ✅ | ✅ | Online Store | covered |
| `ARTICLE_IMAGE` | ✅ | ✅ | Online Store | covered (featured image alt) |
| `BLOG` | ✅ | ✅ | Online Store | covered |
| `COLLECTION` | ✅ | ✅ | Katalog | covered |
| `COLLECTION_IMAGE` | ✅ | ✅ | Katalog | covered (featured image alt) |
| `MEDIA_IMAGE` | ✅ | ✅ | Katalog | covered via API 2025-10+ [app/actions/product/update.actions.ts:163](../app/actions/product/update.actions.ts#L163) |
| `PAGE` | ✅ | ✅ | Online Store | covered |
| `PRODUCT` | ✅ | ✅ | Katalog | covered |
| `PRODUCT_OPTION` | ✅ | ✅ | Katalog | covered |
| `PRODUCT_OPTION_VALUE` | ✅ | ✅ | Katalog | covered |
| `METAFIELD` | ✅ | ✅ | Online Store / Katalog | covered |
| `METAOBJECT` | ✅ | ✅ | Online Store | covered (T&A places this under Onlineshop) |
| `SHOP_POLICY` | ✅ | ✅ | Online Store | covered |
| `MENU` | ✅ | ⚠️ | Online Store | Shopify API limitation, hint shown in UI [de.ts:219](../app/i18n/de.ts#L219) |
| `LINK` | ✅ | ⚠️ | Online Store | same limitation as MENU |
| `ONLINE_STORE_THEME` | ✅ | ✅ | Theme | covered |
| `ONLINE_STORE_THEME_JSON_TEMPLATE` | ✅ | ✅ | Theme | covered — this is T&A's "Vorlagen" |
| `ONLINE_STORE_THEME_LOCALE_CONTENT` | ✅ | 🟡 | Theme | **data already pulled** — needs better grouping by top-level prefix; this is T&A's "Theme-Standardinhalte" |
| `ONLINE_STORE_THEME_SECTION_GROUP` | ✅ | ✅ | Theme | covered — T&A's "Abschnittsgruppen" |
| `ONLINE_STORE_THEME_SETTINGS_CATEGORY` | ✅ | ✅ | Theme | covered — T&A's "Theme-Einstellungen" |
| `ONLINE_STORE_THEME_APP_EMBED` | ✅ | 🟡 | Theme | data pulled (6 keys on probe), but mostly CSS selectors — display conditionally |
| `ONLINE_STORE_THEME_SETTINGS_DATA_SECTIONS` | ✅ | 🟡 | Theme | empty on probe shop, T&A still exposes — display conditionally |
| `SHOP` (`shop.meta_title`, `shop.meta_description`) | ✅ | ❌ | Online Store | **NEW** — Shop-Metadaten; probe-confirmed shape |
| **`EMAIL_TEMPLATE`** | ✅ | ❌ | System | **NEW (BIG)** — 50 templates × `title`+`body_html` = 100 keys on probe shop |
| **`DELIVERY_METHOD_DEFINITION`** | ✅ | ❌ | System | **NEW** — shipping method names; key=`name` |
| **`FILTER`** | ✅ | ❌ | Online Store | **NEW** — storefront filter labels; key=`label` |
| `PACKING_SLIP_TEMPLATE` | ❌ | ❌ | (skip) | T&A doesn't expose; B2B-niche; defer |
| `PAYMENT_GATEWAY` | ❌ | ❌ | System (conditional) | T&A doesn't expose; show only if shop has manual gateways |
| `SELLING_PLAN` / `SELLING_PLAN_GROUP` | ❌ | ❌ | Katalog (conditional) | T&A doesn't expose; show only if shop has subscriptions |
| Cookie Banner | ✅ | ❌ | Online Store | **UNKNOWN source** — has 33 built-in translations like checkout; resource-type not yet identified, see §0.5 spike |

Note: **`SMS_TEMPLATE` is NOT a member** of the enum, despite earlier internal docs ([docs/SHOPIFY_TRANSLATABLE_CONTENT_TYPES.md](SHOPIFY_TRANSLATABLE_CONTENT_TYPES.md) lists it erroneously — Shopify SMS notifications don't use translatable templates). Removed from this plan.

Coverage gap after this plan: only `MENU`/`LINK` (Shopify API limitation) and possibly Cookie-Banner (pending §0.5 spike). T&A doesn't cover `PACKING_SLIP_TEMPLATE`, `PAYMENT_GATEWAY`, `SELLING_PLAN*` either — these are optional T&A-plus features we can selectively beat them on.

## 7. Current state in ContentPilot (snapshot)

What we already do:

- [app/services/content.service.ts:697](../app/services/content.service.ts#L697) `getThemes()` pulls 5 of 7 theme resource types via the single generic query [app/graphql/content.queries.ts:306](../app/graphql/content.queries.ts#L306) `GET_THEME_TRANSLATABLE_RESOURCES`
- Caching: `ThemeContent` + `ThemeTranslation` Prisma tables (key/value/locale/digest)
- UI: [app/components/ThemeContentViewer.tsx](../app/components/ThemeContentViewer.tsx) inside `UnifiedContentEditor`, per-key AI translate, group-level translate-all
- Write-back: `translationsRegister` via the `app/actions/templates/*` action handlers
- Route: [/app/templates](../app/routes/app.templates.tsx); nav label "Vorlagen" inconsistent with second i18n key "Theme-Texte"
- Key-pattern grouping in [content.service.ts:715](../app/services/content.service.ts#L715) `KEY_PATTERNS` recognises `section.article.*`, `section.collection.*`, `section.product.*`, `section.page.*`, `section.index.*`, `section.password.*`, `collections.json.*`, `group.json.*`, `bar.*` — unmatched content falls into `misc_<prefix>` groups with generic labels (this is where T&A's "Theme-Standardinhalte" content currently hides on our side)

Real gap (vs. what was assumed in earlier plan revisions):
- 🟡 **`LOCALE_CONTENT` grouping** is weak — the data is in our DB but presentation doesn't match T&A. Fix is UX-only, no new GraphQL.
- 🟡 **`APP_EMBED` + `SETTINGS_DATA_SECTIONS`** — we excluded them historically. Pulling them is cheap; conditional display.
- ❌ **`EMAIL_TEMPLATE`** — 50 templates, biggest single-resource value-add.
- ❌ **`SHOP`-as-SEO** (`meta_title`/`meta_description` only) — tiny but high-value.
- ❌ **`DELIVERY_METHOD_DEFINITION`** — small.
- ❌ **`FILTER`** — small.
- ❓ **Cookie-Banner** — source unknown, mini-spike in §0.5 below.

## 8. Information architecture

### Naming

- Top-level rubric: **"Inhalte"** (DE) / **"Content"** (EN) — broader than "Übersetzungen" because we also do AI text generation
- Future sibling rubric: **"SEO"**
- Five sub-rubrics under "Inhalte", aligned with T&A's actual five top-level groups (Produkte, Onlineshop, Inhalt-Menü, Theme, Einstellungen) but folded under our "Inhalte" parent for the SEO sibling: **Katalog / Online Store / Theme / System / Direkte Übersetzungen**
- T&A-aligned vocabulary inside Theme: **"Theme-Standardinhalte"** = `LOCALE_CONTENT` grouped, **"Vorlagen"** = `JSON_TEMPLATE` (NOT our generic top-nav label anymore — frees that term)
- Top-nav `templates` route stays but is reframed: it IS the Theme rubric umbrella, gets a better label/sub-nav rather than being a single flat "Vorlagen" entry

### Three horizontal nav levels

```
LEVEL 1 — Main Navigation
   [ 📚 Inhalte ]  [ 🔍 SEO (future) ]  …  [ ⚙️ Einstellungen ]

LEVEL 2 — Rubric bar (NEW, depends on Level 1)
   under "Inhalte":
   [ 📦 Katalog ] [ 🌐 Online Store ] [ 🎨 Theme ] [ ⚙️ System ] [ 🌐 Direkte Übersetzungen ]

LEVEL 3 — Content-type bar (= existing ContentTypeNavigation, depends on Level 2)
   under "Theme":
   [📄 Theme-Standardinhalte] [📋 Vorlagen] [🧩 Abschnittsgruppen]
   [🔌 App-Einbettungen] [⚙️ Theme-Einstellungen] [🗂️ Statische Abschnitte]

   under "System":
   [✉️ Benachrichtigungen] [🚚 Versand & Zustellung]
   [💳 Zahlung (cond.)] [📦 Lieferschein (cond.)] [🔁 Abo-Pläne (cond.)]
```

"(cond.)" = entry hidden when the resource is empty for the shop (no manual gateways / no subscriptions / etc.).

### Full target hierarchy

Mirrors T&A's five top-level rubrics, folded under our "Inhalte" parent:

```
📚 INHALTE
│
├─ 📦 Katalog                  (T&A "Produkte")
│   ├─ 🛍️ Produkte ........... PRODUCT, PRODUCT_OPTION, PRODUCT_OPTION_VALUE,
│   │                            MEDIA_IMAGE
│   ├─ 📂 Kollektionen ....... COLLECTION, COLLECTION_IMAGE
│   └─ 🔁 Abo-Pläne (cond.) .. SELLING_PLAN, SELLING_PLAN_GROUP
│                              (hidden if no subscriptions)
│
├─ 🌐 Online Store             (T&A "Onlineshop" + "Inhalt-Menü")
│   ├─ 📄 Seiten ............. PAGE
│   ├─ 📝 Blog-Beiträge ...... ARTICLE, ARTICLE_IMAGE
│   ├─ 📚 Blogs .............. BLOG
│   ├─ 🍔 Menüs .............. MENU, LINK (API-limited)
│   ├─ 📋 Richtlinien ........ SHOP_POLICY
│   ├─ 🔷 Metaobjekte ........ METAOBJECT, METAFIELD
│   ├─ 🔍 Filter (NEW) ....... FILTER
│   ├─ 🏪 Shop-Metadaten (NEW) SHOP (meta_title, meta_description only)
│   └─ 🍪 Cookie-Banner (NEW?) (source TBD — see §0.5 spike)
│
├─ 🎨 Theme                    (T&A "Theme" — all 7 ONLINE_STORE_THEME_* types)
│   ├─ 📄 Theme-Standardinhalte ONLINE_STORE_THEME_LOCALE_CONTENT
│   │                            grouped by top-level prefix:
│   │                            Accessibility, Accounts, Announcement bar,
│   │                            Blogs, Checkout & system, General, Gift cards,
│   │                            Localization, Newsletter, Onboarding,
│   │                            Products, Recipient, Sections, Templates
│   ├─ 📋 Vorlagen ........... ONLINE_STORE_THEME_JSON_TEMPLATE
│   │                            grouped: 404, Article, Blog, Index, Index Sections,
│   │                            List Collections, Page: <name>, Password, Product,
│   │                            Product: <custom-name>
│   ├─ 🧩 Abschnittsgruppen .. ONLINE_STORE_THEME_SECTION_GROUP
│   ├─ 🗂️ Statische Abschnitte ONLINE_STORE_THEME_SETTINGS_DATA_SECTIONS
│   │                            (display only if non-empty)
│   ├─ 🔌 App-Einbettungen ... ONLINE_STORE_THEME_APP_EMBED
│   │                            (display only if any keys look user-facing,
│   │                             not just CSS selectors — see §0.5)
│   └─ ⚙️ Theme-Einstellungen . ONLINE_STORE_THEME_SETTINGS_CATEGORY
│
├─ ⚙️ System                   (T&A "Einstellungen")
│   ├─ ✉️ Benachrichtigungen . EMAIL_TEMPLATE (50 templates, the big win)
│   ├─ 🚚 Versand & Zustellung DELIVERY_METHOD_DEFINITION
│   ├─ 💳 Zahlung (cond.) .... PAYMENT_GATEWAY (hidden if empty)
│   └─ 📦 Lieferschein (cond.) PACKING_SLIP_TEMPLATE (hidden if empty)
│
└─ 🌐 Direkte Übersetzungen .. existing /app/direct-translations tool

🔍 SEO (future)
⚙️ EINSTELLUNGEN (unchanged)
```

Key differences vs. earlier revisions of this plan:
- **"Theme-Standardinhalte" is now correctly placed under Theme** as a sub-entry (T&A vocabulary), not a separate top-rubric. It's pure UX-grouping work on data we already have.
- **"Vorlagen" returns to its T&A meaning** (JSON_TEMPLATE), no longer used as the umbrella term.
- **"System" replaces the old "Theme-Standardinhalte" top-rubric** since the latter was based on the wrong assumption that SHOP-checkout was a thing.
- **Filter and Shop-Metadaten move under Online Store** (matches T&A).
- **Cookie-Banner added as an open item** pending §0.5 spike.

## 9. Routes decision: keep flat

URLs stay flat — no nested route restructure. Reasons:

- ContentPilot runs inside Shopify admin iframe — merchants almost never see URLs
- Hierarchy lives in the nav components, doesn't need URL encoding
- Zero migration cost; existing bookmarks, internal links, loader auth all keep working
- New sections get flat paths: `/app/theme-defaults`, `/app/selling-plans`, `/app/shop-metadata`
- Future SEO bereich → `/app/seo` (or split `/app/seo-meta`, `/app/seo-schema`)

Reconsider only if we ever deep-link merchants via email/notifications and want speaking URLs.

## 10. Implementation plan

Re-use is ~80%. Phased so each phase is independently shippable and reviewable.

### Phase 0 — Dev-store spike ✅ DONE

Probe shipped as Settings → Translation Probe ([api.translation-probe.tsx](../app/routes/api.translation-probe.tsx), [SettingsTranslationProbeTab.tsx](../app/components/SettingsTranslationProbeTab.tsx)). Real results captured in §12. Key takeaways:

- `SHOP` exposes **only** `meta_title`/`meta_description` — the original "SHOP-as-checkout" assumption was wrong
- T&A's "Theme-Standardinhalte" is `LOCALE_CONTENT` grouped by top-level prefix — **data is already in our DB**
- `EMAIL_TEMPLATE` is the big win: 50 templates × 2 keys
- `FILTER`, `DELIVERY_METHOD_DEFINITION` confirmed small but writable
- `APP_EMBED` returns CSS-selector-only content on this shop; T&A still shows it
- `PACKING_SLIP_TEMPLATE`, `PAYMENT_GATEWAY`, `SELLING_PLAN*` empty on this shop — T&A also skips them in its nav

---

### Phase 0.5 — Cookie-Banner mini-spike (½ day)

Cookie-Banner has 33 built-in translations (per user's T&A inspection) and appears in T&A's Onlineshop rubric. Its `TranslatableResourceType` source is unknown. Likely candidates:

1. `SHOP` with keys like `cookie_banner.*`, only present after merchant first overrides
2. A non-enumerated resource type (Shopify has some)
3. Part of `SHOP_POLICY`

**Tasks:**
- In a dev shop: Admin → Settings → Customer privacy → enable cookie banner → translate one string via Language Editor
- Re-run Translation Probe
- Compare new SHOP/SHOP_POLICY results to baseline; identify where the new key landed
- If found in SHOP → add a "cookie banner" key-filter alongside `meta_*` filter in `getShopMetadata()`
- If found elsewhere → add new resource-type query

**Deliverable:** §12 Cookie-Banner entry filled, decision on which resource type / rubric to use.

---

### Phase 1 — Better grouping of existing data + small new fetches (1.5 days)

The big shift from the earlier plan: **most of the "missing" data is already in our DB**. Phase 1 splits into a UX-fix half (free wins) and a small backend half (4 new resource types).

**1.1 Prisma migration** — `prisma/migrations/20260622000000_add_theme_content_domain/migration.sql`

```sql
ALTER TABLE "ThemeContent"
  ADD COLUMN "domain" TEXT NOT NULL DEFAULT 'theme';

ALTER TABLE "ThemeTranslation"
  ADD COLUMN "domain" TEXT NOT NULL DEFAULT 'theme';

CREATE INDEX "ThemeContent_shop_domain_idx" ON "ThemeContent"("shop", "domain");
CREATE INDEX "ThemeTranslation_shop_domain_idx" ON "ThemeTranslation"("shop", "domain");
```

Schema update in [prisma/schema.prisma:671](../prisma/schema.prisma#L671). Allowed domain values:
- `"theme"` — all 7 `ONLINE_STORE_THEME_*` types (existing rows back-fill via DEFAULT)
- `"system"` — `EMAIL_TEMPLATE`, `DELIVERY_METHOD_DEFINITION` (+ conditional: `PACKING_SLIP_TEMPLATE`, `PAYMENT_GATEWAY`)
- `"online_store_extras"` — `FILTER`, `SHOP` (meta only), Cookie-Banner (if SHOP-based)
- `"selling_plans"` — `SELLING_PLAN` + `SELLING_PLAN_GROUP` (conditional)

**1.2 Improve `getThemes()` grouping** ([content.service.ts:702](../app/services/content.service.ts#L702)) — biggest single UX win, zero new GraphQL:

```diff
 const WORKING_RESOURCE_TYPES = [
   { type: 'ONLINE_STORE_THEME', label: 'Theme Content' },
   { type: 'ONLINE_STORE_THEME_JSON_TEMPLATE', label: 'JSON Templates' },
   { type: 'ONLINE_STORE_THEME_LOCALE_CONTENT', label: 'Locale Content' },
   { type: 'ONLINE_STORE_THEME_SECTION_GROUP', label: 'Section Groups' },
   { type: 'ONLINE_STORE_THEME_SETTINGS_CATEGORY', label: 'Settings Categories' },
+  { type: 'ONLINE_STORE_THEME_APP_EMBED', label: 'App Embeds' },
+  { type: 'ONLINE_STORE_THEME_SETTINGS_DATA_SECTIONS', label: 'Shared Sections' },
 ];
```

Then expand `KEY_PATTERNS` in [content.service.ts:715](../app/services/content.service.ts#L715) so the misc-prefix groups under `LOCALE_CONTENT` get T&A-style labels:

```typescript
// Add named patterns for the LOCALE_CONTENT top-level groups T&A exposes
const LOCALE_CONTENT_PATTERNS = [
  { pattern: /^accessibility\./,    name: 'Accessibility',    groupId: 'accessibility',   icon: '♿' },
  { pattern: /^accounts\./,         name: 'Accounts',         groupId: 'accounts',        icon: '👤' },
  { pattern: /^announcement_bar\./, name: 'Announcement Bar', groupId: 'announcement_bar', icon: '📢' },
  { pattern: /^blogs\./,            name: 'Blogs',            groupId: 'blogs_theme',     icon: '📝' },
  { pattern: /^checkout\./,         name: 'Checkout & System', groupId: 'checkout_theme', icon: '🛒' },
  { pattern: /^general\./,          name: 'General',          groupId: 'general',         icon: '🔧' },
  { pattern: /^gift_cards?\./,      name: 'Gift Cards',       groupId: 'gift_cards',      icon: '🎁' },
  { pattern: /^localization\./,     name: 'Localization',     groupId: 'localization',    icon: '🌍' },
  { pattern: /^newsletter\./,       name: 'Newsletter',       groupId: 'newsletter',      icon: '📰' },
  { pattern: /^onboarding\./,       name: 'Onboarding',       groupId: 'onboarding',      icon: '🚀' },
  { pattern: /^products\./,         name: 'Products',         groupId: 'products_theme',  icon: '🛍️' },
  { pattern: /^recipient\./,        name: 'Recipient',        groupId: 'recipient',       icon: '👥' },
  { pattern: /^sections\./,         name: 'Sections',         groupId: 'sections_theme',  icon: '🧩' },
  { pattern: /^templates\./,        name: 'Templates',        groupId: 'templates_theme', icon: '📋' },
];
```

Also add the three missing `JSON_TEMPLATE` patterns the user identified (404 / blog / list-collections):

```typescript
{ pattern: /^templates\.404\./,                name: '404',              groupId: 'tpl_404',           icon: '🚫' },
{ pattern: /^section\.blog\./,                 name: 'Blog',             groupId: 'blog_theme',        icon: '📝' },
{ pattern: /^templates\.list-collections\./,   name: 'List Collections', groupId: 'tpl_list_coll',     icon: '📂' },
```

**1.3 App-Embed display rule** — when fetching `ONLINE_STORE_THEME_APP_EMBED`, check whether values look like CSS selectors (start with `.`, `#`, or contain only one-word selector-like content) and tag the group accordingly. UI shows a banner "This section contains technical configuration — translating may break embeds. Edit with care." when ≥80% of keys match the heuristic.

**1.4 New service method `getOnlineStoreExtras()`** — persisted with `domain="online_store_extras"`:

```typescript
async getOnlineStoreExtras(first: number = 250) {
  const RESOURCE_TYPES = [
    { type: 'FILTER',                  label: 'Filter',         icon: '🔍', groupId: 'filters' },
    { type: 'SHOP',                    label: 'Shop-Metadaten', icon: '🏪', groupId: 'shop_metadata',
      keyFilter: (k: string) => k.startsWith('meta_') || k.startsWith('shop.') },
    // Cookie-Banner: added in Phase 0.5 once we know which type+filter
  ];
  // reuse GET_THEME_TRANSLATABLE_RESOURCES, persist with domain="online_store_extras"
}
```

**1.5 New service method `getSystemContent()`** — persisted with `domain="system"`:

```typescript
async getSystemContent(first: number = 250) {
  const RESOURCE_TYPES = [
    { type: 'EMAIL_TEMPLATE',             label: 'Benachrichtigungen', icon: '✉️', groupId: 'email_templates' },
    { type: 'DELIVERY_METHOD_DEFINITION', label: 'Versand & Zustellung', icon: '🚚', groupId: 'delivery_methods' },
    // Optional / conditional types pulled if present:
    { type: 'PAYMENT_GATEWAY',            label: 'Zahlungsanbieter',     icon: '💳', groupId: 'payment_gateways', skipIfEmpty: true },
    { type: 'PACKING_SLIP_TEMPLATE',      label: 'Lieferschein',          icon: '📦', groupId: 'packing_slip',     skipIfEmpty: true },
  ];
}
```

**1.6 New service method `getSellingPlans()`** — persisted with `domain="selling_plans"`:

```typescript
async getSellingPlans(first: number = 250) {
  const RESOURCE_TYPES = [
    { type: 'SELLING_PLAN_GROUP', label: 'Abo-Gruppen', icon: '📚', groupId: 'selling_plan_groups' },
    { type: 'SELLING_PLAN',       label: 'Abo-Pläne',    icon: '🔁', groupId: 'selling_plans' },
  ];
}
```

Skip silently if the shop has no `SELLING_PLAN_GROUP`. Nav entry hides itself when loader returns zero rows.

**1.7 Sync integration** — extend `sync-scheduler.service.ts` to call `getOnlineStoreExtras()`, `getSystemContent()`, `getSellingPlans()` alongside `getThemes()` when the plan allows.

---

### Phase 2 — Route + action layer (1 day)

**2.1 New routes** (flat, per §9):

- `app/routes/app.system.tsx` — covers `domain="system"` (Benachrichtigungen, Versand etc.)
- `app/routes/app.online-store-extras.tsx` — covers `domain="online_store_extras"` (Filter, Shop-Metadaten, Cookie-Banner)
- `app/routes/app.selling-plans.tsx` — covers `domain="selling_plans"`

All three: same action switch (`loadTranslations`, `translateField`, `translateAll`, `updateContent`), same `UnifiedContentEditor` + `ThemeContentViewer`. Each is a thin copy of [app.templates.tsx](../app/routes/app.templates.tsx) parameterised by domain.

**2.2 Action sharing** — lift the common loader and action logic into `app/actions/theme-content/` (renamed from `templates/`) with a `domain` param:

```typescript
// app/actions/theme-content/shared.ts
export interface ThemeContentActionContext extends TemplatesActionContext {
  domain: 'theme' | 'system' | 'online_store_extras' | 'selling_plans';
}
```

Tests in `tests/unit/` get parameterised over `domain`.

**2.3 Plan-gating** — wrap each new route in `PlanAccessGate` with the appropriate `contentType`.

---

### Phase 3 — Three-level navigation (1 day)

**3.1 New component** — `app/components/RubricNavigation.tsx`

```typescript
const RUBRICS_BY_SECTION = {
  content: [
    { id: 'catalog',            label: t.rubrics.catalog,            icon: '📦',
      paths: ['/app/products','/app/collections','/app/selling-plans'] },
    { id: 'onlineStore',        label: t.rubrics.onlineStore,        icon: '🌐',
      paths: ['/app/pages','/app/blog','/app/menus','/app/policies','/app/metaobjects','/app/online-store-extras'] },
    { id: 'theme',              label: t.rubrics.theme,              icon: '🎨',
      paths: ['/app/templates'] },
    { id: 'system',             label: t.rubrics.system,             icon: '⚙️',
      paths: ['/app/system'] },
    { id: 'directTranslations', label: t.rubrics.directTranslations, icon: '🌐',
      paths: ['/app/direct-translations'] },
  ],
  seo: [], // future
};
```

Sticky horizontal bar; same style pattern as `ContentTypeNavigation.tsx`. Active rubric derived from `location.pathname.startsWith(...)`.

**3.2 Extend `useNavigationHeight`** — add `rubricNavHeight`. Sticky offsets accumulate: `main + rubric` for content-type-nav, `main + rubric + content` for editor sticky elements.

**3.3 `MainNavigation` simplification** — Reduce top bar to high-level sections: Inhalte, SEO (later), Einstellungen. Move all content-type-specific entries out of [MainNavigation.tsx:261](../app/components/MainNavigation.tsx#L261) into `RubricNavigation`.

**3.4 `ContentTypeNavigation` filter** — only show entries whose path matches the active rubric. One `.filter()` call.

**3.5 New nav entries**:
- `selling-plans` (Katalog, conditional)
- `online-store-extras` (Online Store)
- `system` (System)

---

### Phase 4 — i18n + plan gating + cleanup (½ day)

**4.1 i18n rename + additions** — in [de.ts:175](../app/i18n/de.ts#L175), [en.ts:178](../app/i18n/en.ts#L178), [es.ts:177](../app/i18n/es.ts#L177):

```diff
- templates: "Vorlagen",
- templatesDescription: "Verwalten Sie E-Mail- und Benachrichtigungsvorlagen",
+ theme: "Theme",
+ themeDescription: "Übersetzen Sie Theme-Standardinhalte, Vorlagen, Abschnittsgruppen und mehr",
+ system: "System",
+ systemDescription: "Übersetzen Sie Benachrichtigungen, Versandmethoden und andere Shopify-Systemtexte",
+ sellingPlans: "Abo-Pläne",
+ sellingPlansDescription: "Übersetzen Sie Abo-Pläne und Abo-Gruppen",
+ onlineStoreExtras: "Filter & Shop-Metadaten",
+ onlineStoreExtrasDescription: "Übersetzen Sie Filter-Labels, Shop-SEO-Felder und Cookie-Banner",
```

The current `templatesDescription` is wrong ("E-Mail- und Benachrichtigungsvorlagen" — the page actually shows theme content). Rename fixes the lie.

Add top-level rubric labels:

```typescript
rubrics: {
  content: "Inhalte",
  catalog: "Katalog",
  onlineStore: "Online Store",
  theme: "Theme",
  system: "System",
  directTranslations: "Direkte Übersetzungen",
  seo: "SEO",
}
```

**4.2 `plans.ts` update** — extend `ContentType` union and per-plan `contentTypes` arrays:

```diff
 export type ContentType =
   | "products" | "collections" | "articles" | "blogs"
   | "pages" | "policies" | "templates" | "menus"
-  | "metaobjects" | "directTranslations";
+  | "metaobjects" | "directTranslations"
+  | "system" | "sellingPlans" | "onlineStoreExtras";
```

Per-plan availability:

| Plan | `system` | `sellingPlans` | `onlineStoreExtras` |
|---|---|---|---|
| free | ❌ | ❌ | ✅ (Shop-Metadaten only) |
| basic | ❌ | ❌ | ✅ |
| pro | ✅ | ✅ | ✅ |
| max | ✅ | ✅ | ✅ |

Rationale: `system` mirrors the existing `templates` Pro+ gate. `sellingPlans` same. `onlineStoreExtras` (Shop-Metadaten + Filter labels) is small and high-value → available to all.

Roll caps into existing `maxThemeTranslations` to keep limit story simple.

---

### Phase 5 — Test plan

**Unit (vitest):**
- `content.service.systemContent.test.ts` — mock GraphQL, assert correct types queried, conditional skipping for empty PAYMENT_GATEWAY/PACKING_SLIP
- `content.service.onlineStoreExtras.test.ts` — assert FILTER + SHOP queries, SHOP key-filter
- `content.service.sellingPlans.test.ts` — assert 2 type queries, empty-handling
- `content.service.localeContentGrouping.test.ts` — feed a fixture with the 14 T&A top-level prefixes; assert correct group labels/icons
- `theme-content-action.test.ts` — parameterised over `domain`; correct `translationsRegister` digest
- `plan-gating.test.ts` — Free/Basic shops 403 on `/app/system` and `/app/selling-plans`; can access `/app/online-store-extras`

**Integration:**
- Sync a dev store, verify `ThemeContent` rows for all four `domain` values
- Write translations in each new section → verify in Shopify Admin → Settings → Languages → Translate view

**Manual smoke tests:**
- Translate one EMAIL_TEMPLATE (e.g. order confirmation) into Arabic → trigger a test order → verify Arabic email
- Translate a FILTER label → verify storefront filter shows translation
- Translate Shop-Metadaten meta_title → check storefront `<title>` for non-primary locale
- On a subscription shop: translate a selling plan → verify Storefront cart

---

### Phase 6 — Rollout

- Feature flag for `system` rubric (the biggest behavioural change for merchants)
- Internal dev shop first, 1 week soak
- Beta cohort of 5–10 merchants who asked about email/system translations
- General availability after 2 weeks of beta feedback
- Marketing: "Full T&A parity, plus AI brand voice and content not even T&A covers" (PACKING_SLIP, PAYMENT_GATEWAY, SELLING_PLAN)

---

### File-touch list (summary)

**New:**
- `app/routes/app.system.tsx`
- `app/routes/app.online-store-extras.tsx`
- `app/routes/app.selling-plans.tsx`
- `app/components/RubricNavigation.tsx`
- `prisma/migrations/20260622000000_add_theme_content_domain/migration.sql`

**Modified:**
- `prisma/schema.prisma` (add `domain` to `ThemeContent` + `ThemeTranslation`)
- `app/services/content.service.ts` (expand `getThemes()` types +2; expand `KEY_PATTERNS` with 14 T&A top-level groups + 3 missing template patterns; add `getSystemContent()`, `getOnlineStoreExtras()`, `getSellingPlans()`)
- `app/services/sync-scheduler.service.ts` (wire new sync paths)
- `app/config/plans.ts` (+ 3 content types)
- `app/components/MainNavigation.tsx` (slim to sections)
- `app/components/ContentTypeNavigation.tsx` (filter by rubric)
- `app/hooks/useNavigationHeight` (third bar)
- `app/i18n/{de,en,es}.ts` (rename templates, add rubrics + 3 new sections)
- `app/actions/templates/` → renamed `app/actions/theme-content/` with `domain` param

**No changes needed:**
- `app/components/UnifiedContentEditor.tsx`, `ThemeContentViewer.tsx` — generic
- `app/graphql/content.queries.ts` — `GET_THEME_TRANSLATABLE_RESOURCES` works for any type

---

### Risks + mitigations

| Risk | Mitigation |
|---|---|
| Cookie-Banner source not findable in Phase 0.5 | Ship without it in v1; flag as known gap. T&A has it because they have privileged access. |
| `APP_EMBED` content always CSS-selector-only → merchants might break embeds by translating | Heuristic-based "technical content" warning banner; consider opt-in display |
| Translation API rate-limit during initial sync (10+ types) | Sequential per-type sync + 500ms back-off; persist progress so retries resume |
| `digest` mismatch on `SHOP` (one shop GID, many keys, per-key digests) | Existing `keyToResourceId` map already handles per-key digests |
| Three-stacked sticky bars eat vertical space on mobile | `RubricNavigation` collapses to overflow menu under 768px; pattern exists in `MobileMenu` |
| Merchant confused by `templates` (theme) vs. T&A's `Vorlagen` (JSON templates) | T&A-aligned vocabulary in Phase 4.1 fixes this; tooltip on each section |
| Shops without subscriptions see empty "Abo-Pläne" entry | Loader returns empty → nav hides via `contentCount === 0` (existing pattern) |
| EMAIL_TEMPLATE body_html contains Liquid syntax — AI translation may break it | Liquid-aware prompt; pre/post-translation Liquid token preservation; smoke test before GA |

---

### Effort estimate (single dev)

| Phase | Time |
|---|---|
| 0 — Spike | ✅ done |
| 0.5 — Cookie-Banner spike | 0.5 d |
| 1 — Better grouping + 4 new resource types | 1.5 d |
| 2 — Routes + actions (3 routes + folder rename) | 1.0 d |
| 3 — Nav restructure | 1.0 d |
| 4 — i18n + gating | 0.5 d |
| 5 — Tests | 1.0 d |
| **Total remaining** | **~5.5 d** |

Down from ~6 d in the previous revision because:
- Theme grouping work doesn't need new GraphQL (already in DB) — UX-only change
- `SHOP` simplified to meta_title/description-only (no checkout split)
- `PACKING_SLIP_TEMPLATE` + `PAYMENT_GATEWAY` demoted from primary scope to conditional within `system` rubric

---

## 11. Sources

- [Shopify Help — Translating your checkout](https://help.shopify.com/en/manual/checkout-settings/checkout-language)
- [Shopify Help — Localization and translation](https://help.shopify.com/en/manual/international/localization-and-translation)
- [Storefront locale files (themes)](https://shopify.dev/themes/architecture/locales/storefront-locale-files)
- [Manage translations of merchant-provided content](https://shopify.dev/docs/apps/build/markets/manage-translated-content)
- [TranslatableResourceType enum](https://shopify.dev/docs/api/admin-graphql/latest/enums/TranslatableResourceType)
- [translatableResource query](https://shopify.dev/docs/api/admin-graphql/latest/queries/translatableresource)
- [translationsRegister mutation](https://shopify.dev/docs/api/admin-graphql/latest/mutations/translationsregister)
- [About checkout UI extension localization](https://shopify.dev/docs/apps/build/checkout/localized-checkout-ui-extensions)
- [Translate & Adapt — Help Center](https://help.shopify.com/en/manual/international/translate-adapt-app)
- [Translatable resource rate limit (community forum)](https://community.shopify.dev/t/translatable-resource-rate-limit/15107)

## 12. Spike findings

### How to (re)run the probe

1. Open the app → Settings → **Translation Probe** (left sidebar)
2. Click **Run probe** (read-only)
3. **Copy markdown report** and paste back to the assistant or into this doc

Backend: [app/routes/api.translation-probe.tsx](../app/routes/api.translation-probe.tsx)
UI: [app/components/SettingsTranslationProbeTab.tsx](../app/components/SettingsTranslationProbeTab.tsx)

### Docs-derived facts (validated, no probe needed)

✅ **`translationsRegister` is market-aware** — `TranslationInput` accepts an optional `marketId`. When omitted, the translation applies globally within that locale; when set, only buyers in that market see it. ([translationsRegister docs](https://shopify.dev/docs/api/admin-graphql/latest/mutations/translationsregister))

✅ **`translatableContentDigest` is mandatory** on every write — already handled by our existing templates action via `keyToResourceId` map.

✅ **`SHOP` resource ID** is the shop's GID, one row per shop. Per-key digests handle the multi-key case identically to existing themes flow.

✅ **Built-in 33-language pack is not exposed via any resource type** — apps can only layer overrides on top.

✅ **Theme types are bound to the active theme** — on theme switch, translations must be re-registered against the new theme GID.

### Probe results (Patis-Universe test shop, 2026-06-22, 3 runs)

```
Shop: patis-universe-test-shop.myshopify.com
Primary locale: en   Enabled: de, en, es, fr
API version: 2025-10
```

| Resource | Status | Resources | Total keys | Notes |
|---|---|---:|---:|---|
| `SHOP_POLICY` | ✅ | 1 | 1 | `body` field — already covered by our policies route |
| `ONLINE_STORE_THEME_LOCALE_CONTENT` | ✅ | 1 | **4081** | Already pulled by `getThemes()`. Top prefixes: `shopify.*` (2590), `customer_accounts.*` (1109), `customer.*` (91), `products.*` (88), `sections.*` (73), `general.*` (38), `templates.*` (28), `accessibility.*` (14), `blogs.*` (14), `recipient.*` (13), `gift_cards.*` (11), `localization.*` (7), `newsletter.*` (3), `onboarding.*` (2). **The `shopify.*` namespace contains `shopify.checkout.*` keys** — sample: `shopify.checkout.general.page_title = "Checkout"`. |
| `ONLINE_STORE_THEME` | ✅ | 1 | 4095 | Near-duplicate of LOCALE_CONTENT (+14 `section.*` keys = JSON-template customizations). **Dedupe target in Phase 1.** |
| `SHOP` | ✅ | 1 | **2** | Only `meta_title`, `meta_description` — **no `checkout.*` or `notifications.*`**. The original "SHOP-as-checkout" plan-revision assumption was wrong. |
| `EMAIL_TEMPLATE` | ✅ | 50 | **100** | One resource per template × `title` + `body_html`. The biggest single value-add. |
| `PACKING_SLIP_TEMPLATE` | ✅ | 1 | 1 | Single `body` field. T&A doesn't expose; niche but functional. |
| `DELIVERY_METHOD_DEFINITION` | ✅ | 2 | 2 | Key=`name`, values "Standard". |
| `PAYMENT_GATEWAY` | ✅ | 0 | 0 | None on this shop. Conditional display only. |
| `FILTER` | ✅ | 2 | 2 | Key=`label`, values "Availability", "Price". |
| `SELLING_PLAN` / `SELLING_PLAN_GROUP` | ✅ | 0 | 0 | No subscriptions on this shop. Conditional display. |
| `ONLINE_STORE_THEME_APP_EMBED` | ✅ | 4 | 6 | Keys are CSS selectors (`.header__icons`, `media-gallery`) — not user-facing on this shop. Display with "technical configuration" warning. |
| `ONLINE_STORE_THEME_SETTINGS_DATA_SECTIONS` | ✅ | 1 | 0 | Empty on this shop; T&A still exposes the rubric. |

**Write test:** Aborted — the assumed `checkout.general.continue_button` key doesn't exist in `SHOP` (which only has `meta_title`/`meta_description`). Confirms that **the `SHOP`-as-checkout-overrides path was wrong**.

### Cookie-banner hunt (Phase 0.5) — RESOLVED, source found

Four iterations of the in-app probe:

- **Run 1** (broad value+key match): only false-positive hits on `tracking`/`consent` in unrelated keys
- **Run 2** (after merchant override of a banner string in Language Editor): identical to baseline — confirms the override does NOT surface a new key in any of our 13 probed types
- **Run 3** (key-only matching, narrowed hints): 2 unique hits only — `shopify.checkout.shop_policies.cookie_preferences` ("Plätzchen" / "Cookies") and `customer_accounts.privacy_banner.cookie_preferences_link` ("Cookie-Einstellungen" / "Cookie preferences") in `LOCALE_CONTENT`; both are *link labels*, not banner content
- **Run 4** (probing the `COOKIE_BANNER` resource type via the `unstable` API endpoint): ✅ **resource found, 25 translatable keys**

The `COOKIE_BANNER` resource type is **documented in `unstable` but not yet in `2025-10` stable** — calling it on `2025-10` returns:
> `Variable $resourceType of type TranslatableResourceType! was provided invalid value`

Routing the same query to `https://{shop}/admin/api/unstable/graphql.json` via raw fetch with the session access token succeeds.

Real Cookie-Banner key shape (Patis-Universe live shop, German primary):

```
policy_link_text       = "Datenschutzerklärung"
title                  = "Cookie-Zustimmung"
text                   = "Wir und unsere Partner, einschließlich Shopify, verwenden Cookies …"
button_prefs_open_text = "Einstellungen verwalten"
button_accept_text     = "Akzeptieren"
button_decline_text    = (declined; one of the 25 total keys)
+ ~20 more preference-pane keys (preference category names, descriptions, save/cancel buttons)
```

**Implications:**
- Cookie-Banner content IS in the Translations API, with a clean dedicated resource type
- We can read and (with `unstable`) write it today
- For production use we should wait until `COOKIE_BANNER` is promoted to stable (likely 2026-01 or 2026-04 release) before relying on it
- Until then: ship with the resource type listed but disabled by default, or pin a parallel client to `unstable` strictly for this one resource

### Bonus findings from production shop probe (Patis-Universe live, German primary)

The second probe run on the live shop revealed numbers our test shop hid:

| Type | Test shop | Live shop | Notes |
|---|---:|---:|---|
| `SHOP_POLICY` | 1 | **6** | All real merchant policies, in German |
| `DELIVERY_METHOD_DEFINITION` | 2 | **18** | 16 shipping rates; names currently mixed German/Spanish ("Estándar", "Exprés") — merchant data, but worth noting that our `name` translations will need locale-aware fallback |
| `FILTER` | 2 | **3** | "Verfügbarkeit", "Preis", "Farbe" |
| `LOCALE_CONTENT` | 4081 | 4117 | Theme has slightly more keys (newsletter +5, sections +21, products +6) |
| `ONLINE_STORE_THEME_APP_EMBED` | 6 | 6 | Same — still all CSS selectors |

So live `SHOP_POLICY` is 6× our test-shop estimate, and `DELIVERY_METHOD_DEFINITION` is 9× larger. Worth re-sizing the rate-limit + sync-batching strategy in Phase 1.7 accordingly.

### Decision-affecting findings

🔑 **T&A's "Theme-Standardinhalte" = `ONLINE_STORE_THEME_LOCALE_CONTENT` grouped by top-level prefix** — not a separate API surface. We already pull this data; the misc-prefix grouping in `content.service.ts` produces unhelpful labels. Fix is UX-only via expanded `KEY_PATTERNS` in Phase 1.2.

🔑 **Shopify ships `shopify.*` strings inside LOCALE_CONTENT** — 2590 keys including `shopify.checkout.*`, `shopify.customer_accounts.*`, `shopify.sentence.*`. These are pre-translated in the 33 built-in languages; merchant overrides land here and are reachable via our existing `getThemes()` flow. Theme-side checkout-adjacent strings are therefore translatable — the earlier "checkout strings unreachable" conclusion was over-broad.

🔑 **The server-rendered checkout page itself remains untouchable** for app overrides (no `checkout.*` keys in `SHOP`, no way to push past the 33 built-in for the actual checkout form). The reachable `shopify.checkout.*` keys are theme-rendered (return-to-cart links, thank-you-page elements, etc.), not the checkout form itself.

🔑 **`ONLINE_STORE_THEME` ≈ `ONLINE_STORE_THEME_LOCALE_CONTENT`** — 4095 vs. 4081 keys, identical prefix distribution. The 14-key delta in `ONLINE_STORE_THEME` is the `section.*` JSON-template customizations. Phase 1 should drop `ONLINE_STORE_THEME` from the pull list (we already have it via LOCALE_CONTENT + separate JSON_TEMPLATE pulls).

🔑 **`APP_EMBED` keys are CSS selectors on this Dawn-based shop** — pulling is cheap, but UI must warn against translating. T&A shows it regardless.

🔑 **`SETTINGS_DATA_SECTIONS` is empty on this shop** — keep pulling, display only when non-empty.

🔑 **Subscriptions and payment gateways need a different dev shop to validate**. Plan handles them as conditional rubrics — empty case already designed for.

### Decision gate ✅ passed

Effective decisions:
- ✅ Proceed with revised plan
- ✅ Drop "SHOP-as-checkout" path — `SHOP` is for shop-metadata only
- ✅ Promote `EMAIL_TEMPLATE` as primary value driver
- ✅ Reposition "Theme-Standardinhalte" as a UX-grouping problem on existing data
- ✅ Demote `PACKING_SLIP_TEMPLATE` and `PAYMENT_GATEWAY` to conditional within `system` rubric
- ✅ **Cookie-Banner: resource found via `unstable` API** — 25 translatable keys per shop; will be added to Phase 1 once `COOKIE_BANNER` lands in a stable API version (track via periodic re-probe). For v1: list rubric, mark "coming soon" until enum stabilises.
- ✅ **Dedupe `ONLINE_STORE_THEME` in Phase 1.2** — `LOCALE_CONTENT` + `JSON_TEMPLATE` is the canonical source
- ⏸️ Re-probe on a subscription shop to confirm `SELLING_PLAN*` shapes before Phase 1.6 ships (not blocking)
- ⏸️ Track `COOKIE_BANNER` enum landing in 2026-01 / 2026-04 / 2026-07 stable releases — promote from probe-only to first-class section once stable

### Coverage parity summary after Phase 1

After Phase 1 ships, ContentPilot covers (or exposes a "coming soon" placeholder for) every translatable rubric T&A exposes:

| T&A rubric | Resource type | Our status after Phase 1 |
|---|---|---|
| Produkte, Kollektionen | PRODUCT*, COLLECTION* | ✅ already covered |
| Blog-Beiträge, Blog-Titel | ARTICLE, BLOG | ✅ already covered |
| Seiten, Richtlinien | PAGE, SHOP_POLICY | ✅ already covered |
| Metaobjekte | METAOBJECT | ✅ already covered |
| Menü | MENU, LINK | ⚠️ API-limited (unchanged) |
| Filter | FILTER | 🆕 added in Phase 1 |
| Shop-Metadaten | SHOP (meta_*) | 🆕 added in Phase 1 |
| Cookie-Banner | `COOKIE_BANNER` (unstable) | ⏳ tracked, ship when stable |
| App-Einbettungen | ONLINE_STORE_THEME_APP_EMBED | 🆕 added in Phase 1 (with warning UI) |
| Theme-Standardinhalte | ONLINE_STORE_THEME_LOCALE_CONTENT | 🟡 data already pulled, 🆕 better grouping in Phase 1.2 |
| Abschnittsgruppen | ONLINE_STORE_THEME_SECTION_GROUP | ✅ already covered |
| Statische Abschnitte | ONLINE_STORE_THEME_SETTINGS_DATA_SECTIONS | 🆕 added in Phase 1 (conditional) |
| Vorlagen | ONLINE_STORE_THEME_JSON_TEMPLATE | ✅ already covered + 3 new patterns |
| Theme-Einstellungen | ONLINE_STORE_THEME_SETTINGS_CATEGORY | ✅ already covered |
| Benachrichtigungen | EMAIL_TEMPLATE | 🆕 added in Phase 1 (biggest single value-add) |
| Versand & Zustellung | DELIVERY_METHOD_DEFINITION | 🆕 added in Phase 1 |

**Plus content T&A doesn't expose:** `PACKING_SLIP_TEMPLATE`, `PAYMENT_GATEWAY`, `SELLING_PLAN*` — conditional opt-ins in System / Katalog rubrics for shops that have them.
