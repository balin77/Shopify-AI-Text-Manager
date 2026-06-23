# Plan — Full Translation Coverage (Translate & Adapt Parity)

Bring ContentPilot to full coverage of every translatable surface Shopify's GraphQL Admin API exposes, matching Shopify's Translate & Adapt app — and beating it where we can with AI-driven brand voice and Direct Translations.

This doc is the consolidated source of truth after Phase 0 + 0.5 spike work. Earlier revisions contained wrong assumptions (chiefly: "checkout strings live in SHOP"); those have been removed. Implementation-ready as of 2026-06-23.

---

## 1. How Shopify's translation API works

### Resource surface

The `TranslatableResourceType` enum in `2025-10` stable exposes **30 resource types**. Add `COOKIE_BANNER` from `unstable` (documented, works against the unstable endpoint, not yet promoted to stable) and the effective coverage surface is **31**.

Authoritative reference: [TranslatableResourceType enum](https://shopify.dev/docs/api/admin-graphql/latest/enums/TranslatableResourceType).

### Where checkout strings actually live

Confirmed by Phase 0 probe — the checkout surface is **not** in `SHOP`. The 2590 `shopify.*` keys inside `ONLINE_STORE_THEME_LOCALE_CONTENT` include the full server-rendered checkout text:

- `shopify.checkout.general.*` — page title, error page, generic chrome
- `shopify.checkout.payment.*` — payment-method labels, subscription consent text
- `shopify.checkout.thank_you.*` — order confirmation page
- `shopify.checkout.shop_policies.*` — policy link labels
- `shopify.checkout.marketing.sms.*` — SMS opt-in disclaimers
- … and several hundred more under the `shopify.checkout.*` umbrella

These are readable and writable via the standard `translatableResource(s)` query + `translationsRegister` mutation — same code path as any other LOCALE_CONTENT key.

What `SHOP` actually contains: `meta_title`, `meta_description` only. It's the shop-landing-page SEO surface, not a checkout overrides surface.

### Built-in 33-language pack

Shopify ships professional translations for 33 languages: Bulgarian, Chinese (Simplified), Chinese (Traditional), Croatian, Czech, Danish, Dutch, English, Finnish, French, German, Greek, Hindi, Hungarian, Indonesian, Italian, Japanese, Korean, Lithuanian, Malay, Norwegian (Bokmål), Polish, Portuguese (Brazil), Portuguese (Portugal), Romanian, Russian, Slovak, Slovenian, Spanish, Swedish, Thai, Turkish, Vietnamese.

These are the *default* values for `shopify.*`, `customer_accounts.*`, and similar built-in keys when a merchant enables one of those languages — no app or merchant action needed.

**Open question (not blocking Phase 1):** when we write to `shopify.checkout.general.page_title` in *German*, does Shopify show our override or the built-in default? Same for the other 32 supported languages. For the remaining unsupported languages (Arabic, Hebrew, Ukrainian, Filipino, Bengali, etc.) our writes definitely apply because there's no built-in to compete with. We test the precedence question with a small write-probe in Phase 1.

### How `translationsRegister` works

- Per-key digest required: `translatableContentDigest` is mandatory and tied to the current source value. Existing templates flow already handles this.
- Market-aware: `TranslationInput.marketId` is optional. Omitted → translation applies globally for that locale. Set → only for buyers in that market.
- Resource ID format: depends on type. Shop GID (`gid://shopify/Shop/...`) for `SHOP`. Theme GID (`gid://shopify/OnlineStoreTheme/...`) for all `ONLINE_STORE_THEME_*` — bound to the active theme, must be re-registered on theme switch.
- Rate-limited separately from the rest of the Admin API ([community thread](https://community.shopify.dev/t/translatable-resource-rate-limit/15107)) — batch and back off.

### T&A's UI vs. the API

Translate & Adapt's left navigation has 5 top-level rubrics that map onto the API as follows:

| T&A rubric | API surface |
|---|---|
| Produkte → Produkte, Kollektionen | `PRODUCT*`, `COLLECTION*` |
| Onlineshop → Blogs, Filter, Pages, Policies, Metaobjects, Shop-Metadaten, Cookie-Banner | `ARTICLE*`, `BLOG`, `FILTER`, `PAGE`, `SHOP_POLICY`, `METAOBJECT`, `SHOP` (meta only), `COOKIE_BANNER` |
| Inhalt → Menü | `MENU`, `LINK` |
| Theme → Theme-Standardinhalte, Vorlagen, Abschnittsgruppen, Statische Abschnitte, App-Einbettungen, Theme-Einstellungen | the 7 `ONLINE_STORE_THEME_*` types |
| Einstellungen → Benachrichtigungen, Versand & Zustellung | `EMAIL_TEMPLATE`, `DELIVERY_METHOD_DEFINITION` |

T&A's "Theme-Standardinhalte" specifically = `ONLINE_STORE_THEME_LOCALE_CONTENT` re-grouped by top-level prefix (accessibility, accounts, blogs, **checkout**, general, gift_cards, localization, newsletter, onboarding, products, recipient, sections, shopify, templates, customer_accounts).

What T&A does NOT expose (we can selectively beat them on these): `PACKING_SLIP_TEMPLATE`, `PAYMENT_GATEWAY`, `SELLING_PLAN*`.

---

## 2. Coverage audit

Authoritative resource list, T&A coverage, ContentPilot status:

| Resource | T&A | ContentPilot | Target rubric | Notes |
|---|---|---|---|---|
| `ARTICLE`, `ARTICLE_IMAGE` | ✅ | ✅ | Online Store | covered |
| `BLOG` | ✅ | ✅ | Online Store | covered |
| `COLLECTION`, `COLLECTION_IMAGE` | ✅ | ✅ | Katalog | covered |
| `MEDIA_IMAGE` | ✅ | ✅ | Katalog | covered via API 2025-10+ |
| `PAGE` | ✅ | ✅ | Online Store | covered |
| `PRODUCT`, `PRODUCT_OPTION`, `PRODUCT_OPTION_VALUE` | ✅ | ✅ | Katalog | covered |
| `METAFIELD`, `METAOBJECT` | ✅ | ✅ | Online Store / Katalog | covered (T&A places `METAOBJECT` under Onlineshop) |
| `SHOP_POLICY` | ✅ | ✅ | Online Store | covered |
| `MENU`, `LINK` | ✅ | ⚠️ | Online Store | Shopify API limitation, hint shown in UI |
| `ONLINE_STORE_THEME` | ✅ | 🟡 | Theme | duplicate of `LOCALE_CONTENT` (99% overlap) — drop from sync in Phase 1 |
| `ONLINE_STORE_THEME_JSON_TEMPLATE` | ✅ | ✅ | Theme | "Vorlagen" — covered + 3 new patterns in Phase 1 |
| `ONLINE_STORE_THEME_LOCALE_CONTENT` | ✅ | 🟡 | Theme | "Theme-Standardinhalte" — data already pulled, needs better grouping by top-level prefix (UX-only Phase 1 work) |
| `ONLINE_STORE_THEME_SECTION_GROUP` | ✅ | ✅ | Theme | "Abschnittsgruppen" — covered |
| `ONLINE_STORE_THEME_SETTINGS_CATEGORY` | ✅ | ✅ | Theme | "Theme-Einstellungen" — covered |
| `ONLINE_STORE_THEME_APP_EMBED` | ✅ | 🟡 | Theme | "App-Einbettungen" — pulled but excluded historically; mostly CSS selectors on Dawn-based shops, display with warning UI |
| `ONLINE_STORE_THEME_SETTINGS_DATA_SECTIONS` | ✅ | 🟡 | Theme | "Statische Abschnitte" — pulled but excluded historically; empty on probe shop, conditional display |
| **`SHOP`** (meta only) | ✅ | ❌ | Online Store | NEW — "Shop-Metadaten" rubric |
| **`EMAIL_TEMPLATE`** | ✅ | ❌ | System | NEW (biggest single value-add — 50 templates × 2 keys = 100 keys on probe shop) |
| **`DELIVERY_METHOD_DEFINITION`** | ✅ | ❌ | System | NEW — shipping method names; 18 keys on live shop |
| **`FILTER`** | ✅ | ❌ | Online Store | NEW — storefront filter labels |
| **`COOKIE_BANNER`** (unstable) | ✅ | ❌ | Online Store | NEW with auto-fallback — 25 keys per shop; only available via `unstable` endpoint until promoted to stable |
| `PACKING_SLIP_TEMPLATE` | ❌ | ❌ | System (cond.) | T&A doesn't expose; we add as conditional, hidden if empty |
| `PAYMENT_GATEWAY` | ❌ | ❌ | System (cond.) | T&A doesn't expose; conditional |
| `SELLING_PLAN`, `SELLING_PLAN_GROUP` | ❌ | ❌ | Katalog (cond.) | T&A doesn't expose; conditional. Only present when shop has subscriptions (Shopify Subscriptions / Recharge / Awtomic / etc.) |

After Phase 1: only `MENU`/`LINK` remain as partial-coverage items, and that's a Shopify API limitation we can't fix.

Note: **`SMS_TEMPLATE` is not a member of the enum**, despite earlier internal docs in `docs/SHOPIFY_TRANSLATABLE_CONTENT_TYPES.md` listing it erroneously — Shopify SMS notifications don't use translatable templates.

---

## 3. Our edge over T&A

- **AI-driven translation with brand voice / tone of voice** — T&A only does generic machine translation
- **Direct Translations** for storefront strings rendered by third-party apps that don't sit in any `translatableResource` — a real T&A blind spot
- **Bulk operations** — translate-all-locales, group-level actions, lazy field pagination
- **Three resource types T&A doesn't expose** — `PACKING_SLIP_TEMPLATE`, `PAYMENT_GATEWAY`, `SELLING_PLAN*` (conditional on shop having them)

---

## 4. Current state in ContentPilot

What we already do:

- [app/services/content.service.ts:697](../app/services/content.service.ts#L697) `getThemes()` pulls **5 of 7** theme resource types via the single generic query [app/graphql/content.queries.ts:306](../app/graphql/content.queries.ts#L306) `GET_THEME_TRANSLATABLE_RESOURCES`
- Caching: `ThemeContent` + `ThemeTranslation` Prisma tables (key / value / locale / digest)
- UI: [app/components/ThemeContentViewer.tsx](../app/components/ThemeContentViewer.tsx) inside `UnifiedContentEditor`, per-key AI translate, group-level translate-all
- Write-back: `translationsRegister` via `app/actions/templates/*` action handlers
- Route: [/app/templates](../app/routes/app.templates.tsx) — nav label "Vorlagen" is inconsistent with the second i18n key "Theme-Texte"; the i18n description "E-Mail- und Benachrichtigungsvorlagen" is outright wrong (the page shows theme content)
- Key-pattern grouping in [content.service.ts:715](../app/services/content.service.ts#L715) `KEY_PATTERNS` recognises `section.article.*`, `section.collection.*`, `section.product.*`, `section.page.*`, `section.index.*`, `section.password.*`, `collections.json.*`, `group.json.*`, `bar.*` — everything else falls into `misc_<prefix>` groups with generic labels

What we don't do: every row marked ❌ in §2, plus the 🟡 items need either grouping improvements or conditional display rules.

---

## 5. Information architecture

### Naming

- Top-level rubric: **"Inhalte"** (DE) / **"Content"** (EN) — broader than "Übersetzungen" because we also do AI text generation
- Future sibling rubric: **"SEO"**
- Five sub-rubrics under "Inhalte", aligned with T&A's structure folded under our parent: **Katalog / Online Store / Theme / System / Direkte Übersetzungen**
- T&A-aligned vocabulary inside Theme: **"Theme-Standardinhalte"** = `LOCALE_CONTENT` grouped, **"Vorlagen"** = `JSON_TEMPLATE`. The historical app-wide "Vorlagen" nav label is reframed (it's now the umbrella Theme rubric, with "Vorlagen" only one sub-section inside).

### Three horizontal nav levels

```
LEVEL 1 — Main Navigation (existing)
   [ 📚 Inhalte ]  [ 🔍 SEO (future) ]  …  [ ⚙️ Einstellungen ]

LEVEL 2 — Rubric bar (NEW, compact)
   under "Inhalte":
   [📦 Katalog] [🌐 Online Store] [🎨 Theme] [⚙️ System] [🌐 Direkte Übersetzungen]

LEVEL 3 — Content-type bar (existing ContentTypeNavigation, compact)
   under "Katalog":
   [🛍️ Produkte] [📂 Kollektionen] [🔁 Abo-Pläne (cond.)]

   under "Online Store":
   [📄 Seiten] [📝 Blog-Beiträge] [📚 Blogs] [🍔 Menüs]
   [📋 Richtlinien] [🔷 Metaobjekte] [🔍 Filter]
   [🏪 Shop-Metadaten] [🍪 Cookie-Banner]

   under "Theme":
   [📄 Theme-Standardinhalte] [📋 Vorlagen] [🧩 Abschnittsgruppen]
   [🔌 App-Einbettungen] [⚙️ Theme-Einstellungen] [🗂️ Statische Abschnitte]

   under "System":
   [✉️ Benachrichtigungen] [🚚 Versand & Zustellung]
   [💳 Zahlung (cond.)] [📦 Lieferschein (cond.)]

   under "Direkte Übersetzungen":
   (single-page rubric — no Level 3 bar shown)
```

`(cond.)` = entry hidden when the resource is empty for this shop.

### Compactness requirement (Phase 3)

Three stacked horizontal nav bars is a lot of vertical real estate. Design constraint for Phase 3:

- **Level 2 (Rubric) and Level 3 (Content-type) bars must be visually smaller than today's `ContentTypeNavigation`**
  - Lower bar height (target: ~36–40 px each vs. current ~56 px)
  - Smaller button padding (`0.4rem 0.75rem` instead of current `0.75rem 1.25rem`)
  - Smaller font (`13px` or `var(--p-font-size-200)`)
  - Tighter inter-button gap
- The currently existing Level 3 bar gets the same shrink treatment for consistency
- On mobile (< 768px), Level 2 + Level 3 collapse into the existing `MobileMenu` overflow drawer

### Full target hierarchy

```
📚 INHALTE
│
├─ 📦 Katalog                  (T&A "Produkte")
│   ├─ 🛍️ Produkte ........... PRODUCT, PRODUCT_OPTION, PRODUCT_OPTION_VALUE, MEDIA_IMAGE
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
│   ├─ 🏪 Shop-Metadaten (NEW) SHOP (meta_title, meta_description)
│   └─ 🍪 Cookie-Banner (NEW)  COOKIE_BANNER (via unstable, with auto-fallback)
│
├─ 🎨 Theme                    (T&A "Theme" — all 7 ONLINE_STORE_THEME_* types)
│   ├─ 📄 Theme-Standardinhalte   LOCALE_CONTENT, grouped by top-level prefix:
│   │                              Accessibility, Accounts, Announcement bar,
│   │                              Blogs, Checkout & system, General, Gift cards,
│   │                              Localization, Newsletter, Onboarding,
│   │                              Products, Recipient, Sections, Templates,
│   │                              Shopify (subgroup for the 2590 shopify.* keys)
│   ├─ 📋 Vorlagen ........... JSON_TEMPLATE, grouped: 404, Article, Blog, Index,
│   │                          Index Sections, List Collections, Page: <name>,
│   │                          Password, Product, Product: <custom-name>
│   ├─ 🧩 Abschnittsgruppen .. SECTION_GROUP
│   ├─ 🗂️ Statische Abschnitte SETTINGS_DATA_SECTIONS (cond. — display only if non-empty)
│   ├─ 🔌 App-Einbettungen ... APP_EMBED (with warning UI: technical content,
│   │                          translating may break embeds)
│   └─ ⚙️ Theme-Einstellungen . SETTINGS_CATEGORY
│
├─ ⚙️ System                   (T&A "Einstellungen")
│   ├─ ✉️ Benachrichtigungen . EMAIL_TEMPLATE (50 templates — the big win)
│   ├─ 🚚 Versand & Zustellung DELIVERY_METHOD_DEFINITION
│   ├─ 💳 Zahlung (cond.) .... PAYMENT_GATEWAY (hidden if empty)
│   └─ 📦 Lieferschein (cond.) PACKING_SLIP_TEMPLATE (hidden if empty)
│
└─ 🌐 Direkte Übersetzungen .. existing /app/direct-translations tool

🔍 SEO (future)
⚙️ EINSTELLUNGEN (unchanged)
```

---

## 6. Routes: keep flat

URLs stay flat — no nested route restructure. ContentPilot runs inside Shopify admin iframe; merchants barely see URLs. Hierarchy lives in nav components; zero migration cost.

New routes:
- `app/routes/app.system.tsx` — `domain="system"`
- `app/routes/app.online-store-extras.tsx` — `domain="online_store_extras"` (Filter + Shop-Metadaten + Cookie-Banner)
- `app/routes/app.selling-plans.tsx` — `domain="selling_plans"`

Existing routes keep their paths; `/app/templates` stays as the Theme rubric umbrella.

---

## 7. Implementation plan

### Phase 0 — Spike ✅ DONE

Probe shipped as Settings → Translation Probe. Three runs over Phase 0 + 0.5 settled every assumption — see §9 below.

### Phase 0.5 — Cookie-Banner spike ✅ DONE

Found: `COOKIE_BANNER` resource exists, 25 keys per shop, accessible via the `unstable` endpoint. Not in `2025-10` stable enum. Solution: ship with `unstable` + auto-fallback to "Coming Soon" if the call ever fails. See §7.5 below.

### Phase 1 — Backend foundation (1.5 d)

**1.1 Prisma migration** — `prisma/migrations/20260622000000_add_theme_content_domain/migration.sql`

```sql
ALTER TABLE "ThemeContent"
  ADD COLUMN "domain" TEXT NOT NULL DEFAULT 'theme';

ALTER TABLE "ThemeTranslation"
  ADD COLUMN "domain" TEXT NOT NULL DEFAULT 'theme';

CREATE INDEX "ThemeContent_shop_domain_idx" ON "ThemeContent"("shop", "domain");
CREATE INDEX "ThemeTranslation_shop_domain_idx" ON "ThemeTranslation"("shop", "domain");
```

Allowed domain values: `"theme"` (existing rows back-fill), `"system"`, `"online_store_extras"`, `"selling_plans"`.

**1.2 Improve LOCALE_CONTENT grouping** ([content.service.ts:702](../app/services/content.service.ts#L702)) — largest UX win, zero new GraphQL.

Drop `ONLINE_STORE_THEME` from the working list (duplicate of LOCALE_CONTENT). Add the two previously-excluded types:

```diff
 const WORKING_RESOURCE_TYPES = [
-  { type: 'ONLINE_STORE_THEME', label: 'Theme Content' },
   { type: 'ONLINE_STORE_THEME_JSON_TEMPLATE', label: 'JSON Templates' },
   { type: 'ONLINE_STORE_THEME_LOCALE_CONTENT', label: 'Locale Content' },
   { type: 'ONLINE_STORE_THEME_SECTION_GROUP', label: 'Section Groups' },
   { type: 'ONLINE_STORE_THEME_SETTINGS_CATEGORY', label: 'Settings Categories' },
+  { type: 'ONLINE_STORE_THEME_APP_EMBED', label: 'App Embeds' },
+  { type: 'ONLINE_STORE_THEME_SETTINGS_DATA_SECTIONS', label: 'Shared Sections' },
 ];
```

Expand `KEY_PATTERNS` in [content.service.ts:715](../app/services/content.service.ts#L715) to give the 15 T&A-style top-level groups proper labels:

```typescript
const LOCALE_CONTENT_PATTERNS = [
  { pattern: /^accessibility\./,    name: 'Accessibility',    groupId: 'accessibility',    icon: '♿' },
  { pattern: /^accounts\./,         name: 'Accounts',         groupId: 'accounts',         icon: '👤' },
  { pattern: /^announcement_bar\./, name: 'Announcement Bar', groupId: 'announcement_bar', icon: '📢' },
  { pattern: /^blogs\./,            name: 'Blogs',            groupId: 'blogs_theme',      icon: '📝' },
  { pattern: /^customer_accounts\./, name: 'Customer Accounts', groupId: 'customer_accounts', icon: '👥' },
  { pattern: /^customer\./,         name: 'Customer',         groupId: 'customer',         icon: '👤' },
  { pattern: /^general\./,          name: 'General',          groupId: 'general',          icon: '🔧' },
  { pattern: /^gift_cards?\./,      name: 'Gift Cards',       groupId: 'gift_cards',       icon: '🎁' },
  { pattern: /^localization\./,     name: 'Localization',     groupId: 'localization',     icon: '🌍' },
  { pattern: /^newsletter\./,       name: 'Newsletter',       groupId: 'newsletter',       icon: '📰' },
  { pattern: /^onboarding\./,       name: 'Onboarding',       groupId: 'onboarding',       icon: '🚀' },
  { pattern: /^products\./,         name: 'Products',         groupId: 'products_theme',   icon: '🛍️' },
  { pattern: /^recipient\./,        name: 'Recipient',        groupId: 'recipient',        icon: '👥' },
  { pattern: /^sections\./,         name: 'Sections',         groupId: 'sections_theme',   icon: '🧩' },
  { pattern: /^templates\./,        name: 'Templates',        groupId: 'templates_theme',  icon: '📋' },
];
```

The `shopify.*` namespace (2590 keys including all the `shopify.checkout.*` strings) deserves a deeper sub-grouping. Plan:

```typescript
const SHOPIFY_NAMESPACE_PATTERNS = [
  { pattern: /^shopify\.checkout\./,        name: 'Checkout & System',  groupId: 'shopify_checkout',  icon: '🛒' },
  { pattern: /^shopify\.customer_accounts\./, name: 'Customer Accounts (Shopify)', groupId: 'shopify_customer_accounts', icon: '👥' },
  { pattern: /^shopify\.email_marketing\./, name: 'Email Marketing',    groupId: 'shopify_email_marketing', icon: '✉️' },
  { pattern: /^shopify\.subscriptions\./,   name: 'Subscriptions',      groupId: 'shopify_subscriptions',   icon: '🔁' },
  { pattern: /^shopify\.sentence\./,        name: 'Sentence connectors', groupId: 'shopify_sentence',       icon: '✏️' },
  { pattern: /^shopify\./,                  name: 'Shopify (other)',    groupId: 'shopify_other',           icon: '🏬' },
];
```

Add the three missing `JSON_TEMPLATE` patterns the user identified (404 / blog / list-collections):

```typescript
{ pattern: /^templates\.404\./,                name: '404',              groupId: 'tpl_404',           icon: '🚫' },
{ pattern: /^section\.blog\./,                 name: 'Blog',             groupId: 'blog_theme',        icon: '📝' },
{ pattern: /^templates\.list-collections\./,   name: 'List Collections', groupId: 'tpl_list_coll',     icon: '📂' },
```

**1.3 App-Embed display heuristic** — when grouping APP_EMBED, classify each group by whether ≥80% of values look like CSS selectors (start with `.`, `#`, contain `>`/`~`, or single-word `tag-name`). If so, tag the group `embedTechnical: true`; UI shows a warning banner.

**1.4 New service method `getSystemContent()`** — persisted with `domain="system"`:

```typescript
async getSystemContent(first: number = 250) {
  const RESOURCE_TYPES = [
    { type: 'EMAIL_TEMPLATE',             label: 'Benachrichtigungen',   icon: '✉️', groupId: 'email_templates' },
    { type: 'DELIVERY_METHOD_DEFINITION', label: 'Versand & Zustellung', icon: '🚚', groupId: 'delivery_methods' },
    { type: 'PAYMENT_GATEWAY',            label: 'Zahlungsanbieter',     icon: '💳', groupId: 'payment_gateways', skipIfEmpty: true },
    { type: 'PACKING_SLIP_TEMPLATE',      label: 'Lieferschein',         icon: '📦', groupId: 'packing_slip',     skipIfEmpty: true },
  ];
}
```

**1.5 New service method `getOnlineStoreExtras()`** — `domain="online_store_extras"`:

```typescript
async getOnlineStoreExtras(first: number = 250) {
  const RESOURCE_TYPES = [
    { type: 'FILTER', label: 'Filter',         icon: '🔍', groupId: 'filters' },
    { type: 'SHOP',   label: 'Shop-Metadaten', icon: '🏪', groupId: 'shop_metadata' },
  ];
}

// Cookie-Banner pulled separately via getCookieBannerIfAvailable() — see §7.5
```

**1.6 New service method `getSellingPlans()`** — `domain="selling_plans"`:

```typescript
async getSellingPlans(first: number = 250) {
  const RESOURCE_TYPES = [
    { type: 'SELLING_PLAN_GROUP', label: 'Abo-Gruppen', icon: '📚', groupId: 'selling_plan_groups' },
    { type: 'SELLING_PLAN',       label: 'Abo-Pläne',   icon: '🔁', groupId: 'selling_plans' },
  ];
}
```

**1.7 Sync integration** — extend `sync-scheduler.service.ts` to call `getThemes()` (now with the two newly-included types), `getSystemContent()`, `getOnlineStoreExtras()`, `getSellingPlans()`, and `getCookieBannerIfAvailable()`. Sequential per-type with 500 ms back-off; live-shop probe confirmed up to 18 keys in `DELIVERY_METHOD_DEFINITION` and 4117 in `LOCALE_CONTENT` — sizing remains comfortable.

### Phase 2 — Routes + actions (1 d)

**2.1 New routes** (flat per §6):

- `app/routes/app.system.tsx` — `domain="system"`
- `app/routes/app.online-store-extras.tsx` — `domain="online_store_extras"`
- `app/routes/app.selling-plans.tsx` — `domain="selling_plans"` (loader returns empty → nav hides entry)

All three: thin copies of [app.templates.tsx](../app/routes/app.templates.tsx), parameterised by domain. Same action switch (`loadTranslations`, `translateField`, `translateAll`, `updateContent`), same `UnifiedContentEditor` + `ThemeContentViewer`.

**2.2 Action sharing** — rename `app/actions/templates/` → `app/actions/theme-content/` with a `domain` param:

```typescript
export interface ThemeContentActionContext extends TemplatesActionContext {
  domain: 'theme' | 'system' | 'online_store_extras' | 'selling_plans';
}
```

**2.3 Plan-gating** — each new route wrapped in `PlanAccessGate` with the appropriate `contentType`.

### Phase 3 — Three-level navigation (1 d)

**3.1 New component** `app/components/RubricNavigation.tsx`:

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

**3.2 Compactness — Phase 3 design constraint**

Both Level 2 (new `RubricNavigation`) and Level 3 (existing `ContentTypeNavigation`) get:
- Bar height: ~36–40 px (down from current ~56 px for content-type bar)
- Button padding: `0.4rem 0.75rem` (down from `0.75rem 1.25rem`)
- Font size: `13px` / `var(--p-font-size-200)`
- Tighter inter-button gap
- Smaller icon size
- Active-state border: 2 px instead of 3 px

Three stacked bars must fit comfortably in the desktop viewport without crowding the editor.

**3.3 Extend `useNavigationHeight`** — track `rubricNavHeight` in addition to existing `mainNavHeight` and `contentNavHeight`. Sticky offsets for editor elements accumulate all three.

**3.4 `MainNavigation` slim-down** — reduce top bar to high-level sections (Inhalte, SEO later, Einstellungen). Move all content-type-specific entries out of [MainNavigation.tsx:261](../app/components/MainNavigation.tsx#L261) into `RubricNavigation`.

**3.5 `ContentTypeNavigation` filter** — only show entries whose path matches the active rubric. One `.filter()` call.

**3.6 Mobile** — Level 2 + Level 3 collapse into the existing `MobileMenu` overflow drawer under 768px.

### Phase 4 — i18n + plan gating (½ d)

**4.1 i18n** — in [de.ts:175](../app/i18n/de.ts#L175), [en.ts:178](../app/i18n/en.ts#L178), [es.ts:177](../app/i18n/es.ts#L177):

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
+ cookieBannerComingSoon: "Cookie-Banner — bald verfügbar",
+ cookieBannerComingSoonDescription: "Diese Funktion wird automatisch freigeschaltet, sobald Shopifys API sie für unsere Version unterstützt.",
```

Rubric labels:

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

**4.2 Plan-gating** — extend `ContentType` union and per-plan `contentTypes`:

```diff
 export type ContentType =
   | "products" | "collections" | "articles" | "blogs"
   | "pages" | "policies" | "templates" | "menus"
-  | "metaobjects" | "directTranslations";
+  | "metaobjects" | "directTranslations"
+  | "system" | "sellingPlans" | "onlineStoreExtras";
```

| Plan | `system` | `sellingPlans` | `onlineStoreExtras` |
|---|---|---|---|
| free | ❌ | ❌ | ✅ (Shop-Metadaten + Cookie-Banner only — both small) |
| basic | ❌ | ❌ | ✅ |
| pro | ✅ | ✅ | ✅ |
| max | ✅ | ✅ | ✅ |

Rationale: `system` and `sellingPlans` mirror the existing `templates` Pro+ gate. `onlineStoreExtras` is small + high-value → all tiers.

### Phase 5 — Tests (1 d)

**Unit (vitest):**
- `content.service.systemContent.test.ts` — mock GraphQL, assert correct types queried, conditional skip for empty PAYMENT_GATEWAY/PACKING_SLIP
- `content.service.onlineStoreExtras.test.ts` — assert FILTER + SHOP queries
- `content.service.sellingPlans.test.ts` — assert 2 type queries, empty-handling
- `content.service.localeContentGrouping.test.ts` — feed a fixture with the 15+`shopify.*` sub-prefixes; assert correct group labels/icons
- `cookie-banner-availability.test.ts` — mock unstable endpoint succeeding then failing; assert cache + fallback behaviour
- `theme-content-action.test.ts` — parameterised over `domain`; correct `translationsRegister` digest
- `plan-gating.test.ts` — Free/Basic 403 on `/app/system` and `/app/selling-plans`, allowed on `/app/online-store-extras`

**Integration:**
- Sync a dev store, verify `ThemeContent` rows for all four `domain` values
- Write a translation in each new section → verify in Shopify Admin → Settings → Languages → Translate
- Force the Cookie-Banner cache to "unavailable" → verify Coming-Soon UI renders

**Manual smoke tests:**
- Translate one EMAIL_TEMPLATE into a non-built-in locale (e.g. Arabic) → trigger a test order → verify Arabic email
- Translate a FILTER label → verify storefront filter
- Translate Shop-Metadaten `meta_title` → verify storefront `<title>` for non-primary locale
- **Override precedence check**: write to `shopify.checkout.general.page_title` in German with a marker like "Kasse [test]"; check the actual checkout page — does our override win over Shopify's built-in?
- If shop has subscriptions: translate a selling plan → verify Storefront cart

### Phase 6 — Rollout

- Feature flag for the `system` rubric and Cookie-Banner section (highest-risk surfaces)
- Internal dev shop first, 1 week soak
- Beta cohort of 5–10 merchants who asked about email/system translations
- General availability after 2 weeks of beta feedback
- Marketing: "Full T&A parity + AI brand voice + content T&A doesn't even cover (Packing Slip, Payment Gateway, Selling Plans)"

### 7.5 Cookie-Banner architecture — ship now, auto-fallback on break

Goal: ship Cookie-Banner editing today using the `unstable` endpoint; if Shopify changes the schema in unstable and our calls start failing, the rubric automatically switches to "Coming Soon" instead of breaking — no deploy required.

**Availability cache** ([app/utils/cookie-banner-availability.server.ts](../app/utils/cookie-banner-availability.server.ts), new):

```typescript
// In-memory + DB-backed availability cache, 15-min TTL.
//
//   getCookieBannerAvailability(session) → "available" | "unavailable"
//
// On cache miss: fire a tiny probe (1 resource, 1 key) against
// /admin/api/unstable/graphql.json. Success → "available" 15 min.
// Any error (invalid enum, network, auth) → "unavailable" 15 min.
//
// The same function is called by:
//   - the route loader → decides whether to render the editor or
//     a "Coming Soon" placeholder
//   - the save action → pre-flight check before attempting writes;
//     if status flipped between loader and save, return a graceful
//     error to the merchant ("temporarily unavailable")
//   - a daily cron that warms the cache and additionally pings the
//     pinned 2025-10 endpoint — when 2025-10 starts accepting
//     COOKIE_BANNER, we know it's stable-promoted and can flip the
//     resource to the normal admin client (no more raw-fetch path)
```

**Probe shape** (kept tiny — one resource, one field):

```graphql
query cookieBannerProbe {
  translatableResources(first: 1, resourceType: COOKIE_BANNER) {
    edges { node { resourceId translatableContent { key } } }
  }
}
```

**UI** ([app/routes/app.online-store-extras.tsx](../app/routes/app.online-store-extras.tsx)):

```typescript
// inside the Cookie-Banner sub-section of online-store-extras
const availability = await getCookieBannerAvailability(session);
if (availability === "available") {
  // render normal editor backed by getCookieBannerKeys()
} else {
  // render <ComingSoonBanner title={t.cookieBannerComingSoon} description={t.cookieBannerComingSoonDescription} />
}
```

**Failure modes covered:**
- Shopify schema change in unstable (field renamed, enum removed) → next call errors → next 15 min Coming-Soon
- Network blip → same fallback
- Auth issue → same fallback
- Recovery is automatic on the next successful probe

**Stable promotion (future-proofing):** when the daily cron detects 2025-10 (or whatever version we've pinned by then) accepts COOKIE_BANNER, we can switch the data path off `unstable` in a single small commit. The availability cache continues to work either way.

---

## 8. File-touch list

**New:**
- `app/routes/app.system.tsx`
- `app/routes/app.online-store-extras.tsx`
- `app/routes/app.selling-plans.tsx`
- `app/components/RubricNavigation.tsx`
- `app/utils/cookie-banner-availability.server.ts`
- `prisma/migrations/20260622000000_add_theme_content_domain/migration.sql`

**Modified:**
- `prisma/schema.prisma` — `domain` column on `ThemeContent` + `ThemeTranslation`
- `app/services/content.service.ts` — drop ONLINE_STORE_THEME, add APP_EMBED + SETTINGS_DATA_SECTIONS, expand KEY_PATTERNS (15 top-level + 6 shopify.* sub-patterns + 3 missing template patterns), add `getSystemContent()` / `getOnlineStoreExtras()` / `getSellingPlans()` / `getCookieBannerIfAvailable()`
- `app/services/sync-scheduler.service.ts` — wire new sync paths
- `app/config/plans.ts` — 3 new content types
- `app/components/MainNavigation.tsx` — slim to sections
- `app/components/ContentTypeNavigation.tsx` — compact styling + filter by rubric
- `app/hooks/useNavigationHeight` — track rubric bar
- `app/i18n/{de,en,es}.ts` — rename templates, add rubrics + 3 new sections + cookieBannerComingSoon
- `app/actions/templates/` → renamed `app/actions/theme-content/` with `domain` param

**No changes needed:**
- `app/components/UnifiedContentEditor.tsx`, `ThemeContentViewer.tsx` — generic
- `app/graphql/content.queries.ts` — `GET_THEME_TRANSLATABLE_RESOURCES` works for any type

---

## 9. Spike findings & decisions (consolidated)

### Verified facts

- ✅ **`translationsRegister` is market-aware** — `TranslationInput.marketId` optional; omitted → global within locale; set → only for that market. Existing `keyToResourceId` per-key digest handling already correct.
- ✅ **`SHOP` exposes only meta_title + meta_description** — original "SHOP-as-checkout" assumption was wrong; corrected throughout.
- ✅ **Checkout strings live in LOCALE_CONTENT under `shopify.checkout.*`** — 2590 `shopify.*` keys total in LOCALE_CONTENT include the full server-rendered checkout surface. Readable, writable, same code path as any other LOCALE_CONTENT key.
- ✅ **T&A's "Theme-Standardinhalte" = `ONLINE_STORE_THEME_LOCALE_CONTENT` grouped** — not a separate API surface; data already in our DB; fix is UX-only.
- ✅ **`EMAIL_TEMPLATE` confirmed as the biggest single value-add** — 50 templates × `title` + `body_html` = 100 keys per shop.
- ✅ **`ONLINE_STORE_THEME` is a 99% duplicate of `LOCALE_CONTENT`** — drop from sync in Phase 1.
- ✅ **`ONLINE_STORE_THEME_APP_EMBED` mostly contains CSS selectors on Dawn** — pull but display with warning.
- ✅ **`COOKIE_BANNER` resource exists** — 25 keys (title, text, button_accept_text, button_decline_text, policy_link_text, + ~20 preference-pane keys). Reachable via `unstable` endpoint; not yet in `2025-10` stable.
- ✅ **Live-shop scale: `SHOP_POLICY` × 6, `DELIVERY_METHOD_DEFINITION` × 16/18 keys, `FILTER` × 3, `LOCALE_CONTENT` × 4117** — Phase 1.7 sync sizing comfortable.

### Open questions (not blocking)

- 🟡 **Override precedence for built-in 33 languages** — does writing `shopify.checkout.general.page_title` in German win over Shopify's built-in DE translation? Manual smoke test in Phase 5. For non-built-in languages we definitely win (no built-in to compete with).
- 🟡 **Subscription shop validation** — `SELLING_PLAN*` shapes confirmed only as empty on test shops. Re-probe on a subscription dev shop before Phase 1.6 ships. Not blocking — empty-case logic already in place.

### Decision record

- ✅ Drop the "SHOP-as-checkout" path — wrong assumption from earlier plan revisions
- ✅ Promote `EMAIL_TEMPLATE` as the primary user-visible value driver
- ✅ Reposition "Theme-Standardinhalte" as a UX-grouping problem on existing data
- ✅ Demote `PACKING_SLIP_TEMPLATE` and `PAYMENT_GATEWAY` to conditional within `system` rubric
- ✅ Drop `ONLINE_STORE_THEME` from sync path — duplicate of LOCALE_CONTENT
- ✅ Ship Cookie-Banner via `unstable` + auto-fallback on schema break — best-of-both-worlds positioning
- ✅ Compact submenus required in Phase 3 — three stacked bars need careful sizing
- ⏸️ Re-probe on subscription shop in Phase 1.6 (not blocking)
- ⏸️ Track `COOKIE_BANNER` enum landing in 2026-01 / 2026-04 / 2026-07 stable releases — promote the data path off `unstable` once available (no UI/UX change needed)

### Coverage parity after Phase 1

| T&A rubric | Status after Phase 1 |
|---|---|
| Produkte, Kollektionen | ✅ existing |
| Blog-Beiträge, Blog-Titel | ✅ existing |
| Seiten, Richtlinien, Metaobjekte | ✅ existing |
| Menü | ⚠️ API-limited (unchanged) |
| **Filter** | 🆕 added |
| **Shop-Metadaten** | 🆕 added |
| **Cookie-Banner** | 🆕 added via `unstable` + auto-fallback |
| **App-Einbettungen** | 🆕 added (with warning UI) |
| **Theme-Standardinhalte** | 🟡 → 🆕 better grouping on existing data |
| **Statische Abschnitte** | 🆕 added (conditional) |
| Abschnittsgruppen, Vorlagen, Theme-Einstellungen | ✅ existing |
| **Benachrichtigungen** | 🆕 added (biggest value-add) |
| **Versand & Zustellung** | 🆕 added |

**Plus content T&A doesn't expose:** `PACKING_SLIP_TEMPLATE`, `PAYMENT_GATEWAY`, `SELLING_PLAN*` — conditional opt-ins.

---

## 10. Effort estimate

| Phase | Time |
|---|---|
| 0 — Spike | ✅ done |
| 0.5 — Cookie-Banner spike | ✅ done |
| 1 — Backend (grouping + 4 service methods + cookie-banner availability) | 1.5 d |
| 2 — Routes + actions (3 routes + folder rename) | 1.0 d |
| 3 — Nav restructure + compactness | 1.0 d |
| 4 — i18n + gating | 0.5 d |
| 5 — Tests | 1.0 d |
| **Total remaining** | **~5 d** |

---

## 11. Sources

- [TranslatableResourceType enum (2025-10)](https://shopify.dev/docs/api/admin-graphql/latest/enums/TranslatableResourceType)
- [TranslatableResourceType enum (unstable)](https://shopify.dev/docs/api/admin-graphql/unstable/enums/TranslatableResourceType)
- [CookieBanner object](https://shopify.dev/docs/api/admin-graphql/latest/objects/CookieBanner)
- [translatableResource query](https://shopify.dev/docs/api/admin-graphql/latest/queries/translatableresource)
- [translationsRegister mutation](https://shopify.dev/docs/api/admin-graphql/latest/mutations/translationsregister)
- [Storefront locale files](https://shopify.dev/themes/architecture/locales/storefront-locale-files)
- [Manage translations of merchant-provided content](https://shopify.dev/docs/apps/build/markets/manage-translated-content)
- [Translatable resource rate limit (community forum)](https://community.shopify.dev/t/translatable-resource-rate-limit/15107)
- [Translate & Adapt — Help Center](https://help.shopify.com/en/manual/international/translate-adapt-app)
- [Shopify Help — Translating your checkout](https://help.shopify.com/en/manual/checkout-settings/checkout-language)
- [Shopify Help — Localization and translation](https://help.shopify.com/en/manual/international/localization-and-translation)
