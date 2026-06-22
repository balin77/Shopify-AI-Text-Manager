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

Authoritative list from [TranslatableResourceType enum](https://shopify.dev/docs/api/admin-graphql/latest/enums/TranslatableResourceType) (30 values, verified 2026-06):

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
| `METAFIELD` | ✅ | ✅ | Katalog / Online Store | covered |
| `METAOBJECT` | ✅ | ✅ | Katalog | covered |
| `SHOP_POLICY` | ✅ | ✅ | Online Store | covered |
| `MENU` | ✅ | ⚠️ | Online Store | Shopify API limitation, hint shown in UI [de.ts:219](../app/i18n/de.ts#L219) |
| `LINK` | ✅ | ⚠️ | Online Store | same limitation as MENU |
| `ONLINE_STORE_THEME` | ✅ | ✅ | Theme-Inhalte | covered |
| `ONLINE_STORE_THEME_JSON_TEMPLATE` | ✅ | ✅ | Theme-Inhalte | covered |
| `ONLINE_STORE_THEME_LOCALE_CONTENT` | ✅ | ✅ | Theme-Inhalte | covered |
| `ONLINE_STORE_THEME_SECTION_GROUP` | ✅ | ✅ | Theme-Inhalte | covered |
| `ONLINE_STORE_THEME_SETTINGS_CATEGORY` | ✅ | ✅ | Theme-Inhalte | covered |
| **`ONLINE_STORE_THEME_APP_EMBED`** | ✅ | ❌ | Theme-Inhalte | **NEW** — app embed config text (previously excluded after empty test result) |
| **`ONLINE_STORE_THEME_SETTINGS_DATA_SECTIONS`** | ✅ | ❌ | Theme-Inhalte | **NEW** — shared section content (previously excluded after empty test result) |
| **`SHOP`** (`checkout.*`, `notifications.*`) | ✅ | ❌ | Theme-Standardinhalte | **NEW** — Checkout & System |
| **`SHOP`** (`shop.name`, `shop.description`) | ✅ | ❌ | Online Store | **NEW** — exposed as "Shop-Metadaten" entry |
| **`EMAIL_TEMPLATE`** | ✅ | ❌ | Theme-Standardinhalte | **NEW** |
| **`PACKING_SLIP_TEMPLATE`** | ✅ | ❌ | Theme-Standardinhalte | **NEW** |
| **`PAYMENT_GATEWAY`** | ✅ | ❌ | Theme-Standardinhalte | **NEW** |
| **`DELIVERY_METHOD_DEFINITION`** | ✅ | ❌ | Theme-Standardinhalte | **NEW** |
| **`FILTER`** | ✅ | ❌ | Theme-Standardinhalte | **NEW** |
| **`SELLING_PLAN`** | ✅ | ❌ | Katalog | **NEW** — subscription plan names/descriptions |
| **`SELLING_PLAN_GROUP`** | ✅ | ❌ | Katalog | **NEW** — subscription group names/descriptions |

Note: **`SMS_TEMPLATE` is NOT a member** of the enum, despite earlier internal docs ([docs/SHOPIFY_TRANSLATABLE_CONTENT_TYPES.md](SHOPIFY_TRANSLATABLE_CONTENT_TYPES.md) lists it erroneously — Shopify SMS notifications don't use translatable templates). It is removed from this plan.

After this plan ships, **only `MENU`/`LINK` remain as partial-coverage items**, and that's a Shopify API limitation we can't fix.

## 7. Current state in ContentPilot (snapshot)

What we already do:

- [app/services/content.service.ts:697](../app/services/content.service.ts#L697) `getThemes()` pulls 5 of 7 theme resource types via the single generic query [app/graphql/content.queries.ts:306](../app/graphql/content.queries.ts#L306) `GET_THEME_TRANSLATABLE_RESOURCES`
- Caching: `ThemeContent` + `ThemeTranslation` Prisma tables (key/value/locale/digest)
- UI: [app/components/ThemeContentViewer.tsx](../app/components/ThemeContentViewer.tsx) inside `UnifiedContentEditor`, per-key AI translate, group-level translate-all
- Write-back: `translationsRegister` via the `app/actions/templates/*` action handlers
- Route: [/app/templates](../app/routes/app.templates.tsx); nav label "Vorlagen" inconsistent with second i18n key "Theme-Texte"

What we don't do: everything marked **NEW** in §6 above.

## 8. Information architecture

### Naming

- Top-level rubric: **"Inhalte"** (DE) / **"Content"** (EN) — broader than "Übersetzungen" because we also do AI text generation
- Future sibling rubric: **"SEO"**
- Rename current `templates` nav entry: **"Vorlagen" → "Theme-Inhalte"** (frees the "Vorlagen" term for the actual alt-text-templates feature, and aligns with the existing second i18n key)
- New section: **"Theme-Standardinhalte"** (matches Translate & Adapt's label)

### Three horizontal nav levels

```
LEVEL 1 — Main Navigation
   [ 📚 Inhalte ]  [ 🔍 SEO (future) ]  …  [ ⚙️ Einstellungen ]

LEVEL 2 — Rubric bar (NEW, depends on Level 1)
   under "Inhalte":
   [ 📦 Katalog ] [ 🌐 Online Store ] [ 🎨 Theme-Inhalte ] [ 🏛️ Theme-Standardinhalte ] [ 🌐 Direkte Übersetzungen ]

LEVEL 3 — Content-type bar (= existing ContentTypeNavigation, depends on Level 2)
   under "Theme-Standardinhalte":
   [🛒 Checkout & System] [✉️ E-Mails] [📦 Lieferschein]
   [🚚 Versandmethoden] [💳 Zahlung] [🔍 Filter]
```

### Full target hierarchy

```
📚 INHALTE
│
├─ 📦 Katalog
│   ├─ 🛍️ Produkte ............. PRODUCT, PRODUCT_OPTION, PRODUCT_OPTION_VALUE,
│   │                              MEDIA_IMAGE
│   ├─ 📂 Kollektionen ......... COLLECTION, COLLECTION_IMAGE
│   ├─ 🔷 Metaobjekte .......... METAOBJECT, METAFIELD
│   └─ 🔁 Abo-Pläne (NEW) ...... SELLING_PLAN, SELLING_PLAN_GROUP
│
├─ 🌐 Online Store
│   ├─ 📄 Seiten ............... PAGE
│   ├─ 📝 Blogs ................ BLOG, ARTICLE, ARTICLE_IMAGE
│   ├─ 🍔 Menüs ................ MENU, LINK (API-limited)
│   ├─ 📋 Richtlinien .......... SHOP_POLICY
│   └─ 🏪 Shop-Metadaten (NEW) . SHOP (shop.name, shop.description only)
│
├─ 🎨 Theme-Inhalte                  ← was "Vorlagen"
│   ├─ 📝 Article ┐
│   ├─ 📂 Collection │
│   ├─ 🏠 Index Page │  all 7 ONLINE_STORE_THEME_* types now:
│   ├─ 🛍️ Product   │   ONLINE_STORE_THEME, _JSON_TEMPLATE,
│   ├─ 📄 Pages      │   _LOCALE_CONTENT, _SECTION_GROUP,
│   ├─ 📋 Coll. Tmpl │   _SETTINGS_CATEGORY,
│   ├─ 🎨 Groups     │   _APP_EMBED (NEW), _SETTINGS_DATA_SECTIONS (NEW)
│   ├─ 📢 Bars      │
│   ├─ 🔒 Password  │
│   └─ ⚙️ Settings  ┘
│
├─ 🏛️ Theme-Standardinhalte (NEW)
│   ├─ 🛒 Checkout & System .... SHOP (filtered to checkout.*, notifications.*)
│   ├─ ✉️ E-Mails .............. EMAIL_TEMPLATE
│   ├─ 📦 Lieferschein ......... PACKING_SLIP_TEMPLATE
│   ├─ 🚚 Versandmethoden ...... DELIVERY_METHOD_DEFINITION
│   ├─ 💳 Zahlungsanbieter ..... PAYMENT_GATEWAY
│   └─ 🔍 Filter ............... FILTER
│
└─ 🌐 Direkte Übersetzungen .... existing /app/direct-translations tool

🔍 SEO (future)
⚙️ EINSTELLUNGEN (unchanged)
```

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

### Phase 0 — Dev-store spike (1 day)

Goal: kill the open questions on resource shapes and write-behavior before writing production code.

**Tasks:**

- On a dev shop with multiple enabled locales (incl. one outside the 33 built-in, e.g. Arabic, and one inside, e.g. German), run an ad-hoc GraphQL query against each new resource type:

```graphql
query probe($type: TranslatableResourceType!) {
  translatableResources(first: 50, resourceType: $type) {
    edges { node {
      resourceId
      translatableContent { key value digest locale }
      translations(locale: "ar") { key value outdated }
    } }
  }
}
```

  Iterate `$type` over the 11 new types:
  `SHOP`, `EMAIL_TEMPLATE`, `PACKING_SLIP_TEMPLATE`, `DELIVERY_METHOD_DEFINITION`, `PAYMENT_GATEWAY`, `FILTER`, `SELLING_PLAN`, `SELLING_PLAN_GROUP`, `ONLINE_STORE_THEME_APP_EMBED`, `ONLINE_STORE_THEME_SETTINGS_DATA_SECTIONS`.

- Attempt a write via `translationsRegister` against a `SHOP` key (e.g. `checkout.shipping.title`) in:
  - **(a)** a built-in language (German) — does it override Shopify's professional translation?
  - **(b)** an unsupported language (Arabic) — does it appear in checkout?
  - **(c)** with `marketId` set vs. unset — what's the precedence?

- Identify the actual key prefixes inside `SHOP` so we can split it into "Checkout & System" (Theme-Standardinhalte) vs. "Shop-Metadaten" (Online Store). Expected prefixes:
  - `checkout.*`, `notifications.*` → Checkout & System
  - `shop.name`, `shop.description`, `shop.meta_title`, `shop.meta_description` → Shop-Metadaten

**Deliverables:** §12 spike findings populated, decision gate passed.

Decision gate: if `SHOP` writes are silently ignored for built-in languages, Phase 1 still goes ahead but the value prop for that resource pivots to "unsupported languages only".

---

### Phase 1 — Backend foundation (1.5 days)

**1.1 Prisma migration** — `prisma/migrations/20260622000000_add_theme_content_domain/migration.sql`

```sql
ALTER TABLE "ThemeContent"
  ADD COLUMN "domain" TEXT NOT NULL DEFAULT 'theme';

ALTER TABLE "ThemeTranslation"
  ADD COLUMN "domain" TEXT NOT NULL DEFAULT 'theme';

CREATE INDEX "ThemeContent_shop_domain_idx" ON "ThemeContent"("shop", "domain");
CREATE INDEX "ThemeTranslation_shop_domain_idx" ON "ThemeTranslation"("shop", "domain");
```

Schema update in [prisma/schema.prisma:671](../prisma/schema.prisma#L671) — add `domain String @default("theme")` to both `ThemeContent` and `ThemeTranslation`. Existing rows back-fill to `"theme"` via the DEFAULT.

Allowed domain values:
- `"theme"` — the 7 `ONLINE_STORE_THEME_*` types
- `"defaults"` — the 6 system types (`SHOP`-checkout, `EMAIL_TEMPLATE`, …)
- `"shop_metadata"` — `SHOP`-name/description subset
- `"selling_plans"` — `SELLING_PLAN` + `SELLING_PLAN_GROUP`

**1.2 Service: extend `getThemes()`** — add the two previously excluded types to the working list in [content.service.ts:702](../app/services/content.service.ts#L702):

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

(If Phase 0 confirms these are empty on Dawn but populated on other themes, keep them — empty types cost nothing.)

**1.3 New service method `getThemeDefaults()`** — same shape as `getThemes()`, persisted with `domain="defaults"`:

```typescript
async getThemeDefaults(first: number = 250) {
  const RESOURCE_TYPES = [
    { type: 'SHOP',                         label: 'Checkout & System',         icon: '🛒',
      groupId: 'checkout_system',
      keyFilter: (k: string) => k.startsWith('checkout.') || k.startsWith('notifications.') },
    { type: 'EMAIL_TEMPLATE',               label: 'E-Mail-Benachrichtigungen', icon: '✉️',
      groupId: 'email_templates' },
    { type: 'PACKING_SLIP_TEMPLATE',        label: 'Lieferschein',              icon: '📦',
      groupId: 'packing_slip' },
    { type: 'DELIVERY_METHOD_DEFINITION',   label: 'Versandmethoden',           icon: '🚚',
      groupId: 'delivery_methods' },
    { type: 'PAYMENT_GATEWAY',              label: 'Zahlungsanbieter',          icon: '💳',
      groupId: 'payment_gateways' },
    { type: 'FILTER',                       label: 'Filter',                    icon: '🔍',
      groupId: 'filters' },
  ];
  // reuse GET_THEME_TRANSLATABLE_RESOURCES exactly as getThemes() does
  // persist rows with domain="defaults"
}
```

**1.4 New service method `getSellingPlans()`** — persisted with `domain="selling_plans"`:

```typescript
async getSellingPlans(first: number = 250) {
  const RESOURCE_TYPES = [
    { type: 'SELLING_PLAN_GROUP', label: 'Abo-Gruppen', icon: '📚', groupId: 'selling_plan_groups' },
    { type: 'SELLING_PLAN',       label: 'Abo-Pläne',    icon: '🔁', groupId: 'selling_plans' },
  ];
  // same pattern as getThemeDefaults()
}
```

Skip silently if the shop has no `SELLING_PLAN_GROUP` (most shops don't run subscriptions). The nav entry hides itself when the loader returns zero rows.

**1.5 New service method `getShopMetadata()`** — pulls only the `SHOP` keys filtered to `shop.*` (name, description, meta-title, meta-description), persisted with `domain="shop_metadata"`:

```typescript
async getShopMetadata(first: number = 50) {
  // single GET_THEME_TRANSLATABLE_RESOURCES with resourceType: 'SHOP'
  // filter to keys starting with 'shop.'
  // store under groupId='shop_metadata'
}
```

**1.6 Sync integration** — extend `sync-scheduler.service.ts` to call `getThemeDefaults()`, `getSellingPlans()`, `getShopMetadata()` alongside `getThemes()` when the corresponding plan allowance is set.

**Note on `SHOP` double-pull:** `getThemeDefaults()` and `getShopMetadata()` both query `resourceType: SHOP`. To avoid two API calls for one resource, factor into a single shared call that splits by `keyFilter` and writes two `ThemeContent` rows with different `domain`s.

---

### Phase 2 — Route + action layer (1 day)

**2.1 New routes** (flat, per §9):

- `app/routes/app.theme-defaults.tsx` — copy of [app.templates.tsx](../app/routes/app.templates.tsx), loads `domain="defaults"`
- `app/routes/app.selling-plans.tsx` — same pattern, loads `domain="selling_plans"`; renders nothing meaningful if no subscription apps installed (handle the empty state cleanly)
- `app/routes/app.shop-metadata.tsx` — same pattern, loads `domain="shop_metadata"`; only 4–6 keys, simpler layout but reuse the same editor

All three: same action switch (`loadTranslations`, `translateField`, `translateAll`, `updateContent`), same `UnifiedContentEditor` + `ThemeContentViewer`.

**2.2 Action sharing** — to avoid four near-duplicate route files drifting, lift the common loader and action logic into `app/actions/theme-content/` (renamed from `templates/`) with a `domain` param:

```typescript
// app/actions/theme-content/shared.ts
export interface ThemeContentActionContext extends TemplatesActionContext {
  domain: 'theme' | 'defaults' | 'selling_plans' | 'shop_metadata';
}
```

Each route passes its `domain` into the shared handlers; everything else stays the same. Tests in `tests/unit/` get parameterised over `domain`.

**2.3 Plan-gating** — wrap each new route in `PlanAccessGate` with the appropriate `contentType`.

---

### Phase 3 — Three-level navigation (1 day)

**3.1 New component** — `app/components/RubricNavigation.tsx`

```typescript
const RUBRICS_BY_SECTION = {
  content: [
    { id: 'catalog',            label: t.rubrics.catalog,            icon: '📦',
      paths: ['/app/products','/app/collections','/app/metaobjects','/app/selling-plans'] },
    { id: 'onlineStore',        label: t.rubrics.onlineStore,        icon: '🌐',
      paths: ['/app/pages','/app/blog','/app/menus','/app/policies','/app/shop-metadata'] },
    { id: 'themeContent',       label: t.rubrics.themeContent,       icon: '🎨',
      paths: ['/app/templates'] },
    { id: 'themeDefaults',      label: t.rubrics.themeDefaults,      icon: '🏛️',
      paths: ['/app/theme-defaults'] },
    { id: 'directTranslations', label: t.rubrics.directTranslations, icon: '🌐',
      paths: ['/app/direct-translations'] },
  ],
  seo: [], // future
};
```

Sticky horizontal bar; same style pattern as `ContentTypeNavigation.tsx`. Active rubric derived from `location.pathname.startsWith(...)`.

**3.2 Extend `useNavigationHeight`** — current hook tracks main + content. Add `rubricNavHeight`. Sticky offset becomes `mainNavHeight + rubricNavHeight` for `ContentTypeNavigation`, and `mainNavHeight + rubricNavHeight + contentNavHeight` for editor sticky elements.

**3.3 `MainNavigation` simplification** — Reduce top bar to high-level sections: Inhalte, SEO (later), Einstellungen. Move all content-type-specific entries out of [MainNavigation.tsx:261](../app/components/MainNavigation.tsx#L261) (the `contentTypes` array → goes to `RubricNavigation`).

**3.4 `ContentTypeNavigation` filter** — only show entries whose path matches the active rubric. Already keyed by path so this is one `.filter()` call.

**3.5 New nav entries**:
- `selling-plans` (Katalog, only shown when shop has subscription resources)
- `shop-metadata` (Online Store)
- `theme-defaults` (Theme-Standardinhalte rubric, all-in-one entry containing the 6 sub-groups)

---

### Phase 4 — i18n + plan gating + cleanup (½ day)

**4.1 i18n rename + additions** — in [de.ts:175](../app/i18n/de.ts#L175), [en.ts:178](../app/i18n/en.ts#L178), [es.ts:177](../app/i18n/es.ts#L177):

```diff
- templates: "Vorlagen",
- templatesDescription: "Verwalten Sie E-Mail- und Benachrichtigungsvorlagen",
+ themeContent: "Theme-Inhalte",
+ themeContentDescription: "Übersetzen Sie Theme-Texte aus dem aktiven Theme-Code",
+ themeDefaults: "Theme-Standardinhalte",
+ themeDefaultsDescription: "Übersetzen Sie Checkout, E-Mails und andere Shopify-Systemtexte",
+ sellingPlans: "Abo-Pläne",
+ sellingPlansDescription: "Übersetzen Sie Abo-Pläne und Abo-Gruppen",
+ shopMetadata: "Shop-Metadaten",
+ shopMetadataDescription: "Übersetzen Sie Shop-Name und Shop-Beschreibung",
```

The current `templatesDescription` is wrong ("E-Mail- und Benachrichtigungsvorlagen") — the page actually shows theme content. The rename fixes the lie.

Add top-level rubric labels:

```typescript
rubrics: {
  content: "Inhalte",
  catalog: "Katalog",
  onlineStore: "Online Store",
  themeContent: "Theme-Inhalte",
  themeDefaults: "Theme-Standardinhalte",
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
+  | "themeDefaults" | "sellingPlans" | "shopMetadata";
```

Per-plan availability:

| Plan | `themeDefaults` | `sellingPlans` | `shopMetadata` |
|---|---|---|---|
| free | ❌ | ❌ | ✅ (4 keys, no quota impact) |
| basic | ❌ | ❌ | ✅ |
| pro | ✅ | ✅ | ✅ |
| max | ✅ | ✅ | ✅ |

Rationale: `themeDefaults` and `sellingPlans` mirror the existing `templates` gate (Pro+). `shopMetadata` is tiny and high-value for any shop, gate it to all tiers.

Roll all theme-related caps into the existing `maxThemeTranslations` to keep the limit story simple. Selling plans likely have <100 keys per shop — no separate cap needed.

---

### Phase 5 — Test plan

**Unit (vitest, follow patterns in [tests/unit/](../tests/unit/)):**
- `content.service.themeDefaults.test.ts` — mock the GraphQL admin and assert `getThemeDefaults()` calls `translatableResources` 6 times with the correct `resourceType`, applies the `SHOP` key filter
- `content.service.sellingPlans.test.ts` — same shape, 2 calls
- `content.service.shopMetadata.test.ts` — same shape, 1 call with `shop.*` filter
- `theme-content-action.test.ts` — parameterised over `domain`; assert `translationsRegister` is called with the correct `translatableContentDigest`
- `plan-gating.test.ts` — assert Free/Basic shops 403 on `/app/theme-defaults` and `/app/selling-plans`, but can access `/app/shop-metadata`

**Integration:**
- Sync a dev store, verify `ThemeContent` rows with the four `domain` values exist; counts match the Phase 0 probe
- Write a translation in each new section → confirm it shows in Shopify Admin → Settings → Languages → "Translate" view

**Manual smoke tests:**
- Enable Arabic (outside the 33), translate all checkout strings → place a test order → verify Arabic checkout
- German (inside the 33) → verify override behaviour matches Phase 0 finding
- A subscription shop: translate a selling plan → verify Storefront cart shows the translated name

---

### Phase 6 — Rollout

- Ship behind a feature flag if Phase 0 shows ambiguity around `SHOP` writes vs. built-in
- Internal dev shop first, 1 week soak
- Soft launch to a beta cohort of 5–10 merchants who asked about checkout/email translations
- General availability after 2 weeks of beta feedback
- Marketing: highlight "complete T&A parity + AI brand voice" — currently competitors either translate everything (badly) or curate but skip checkout

---

### File-touch list (summary)

**New:**
- `app/routes/app.theme-defaults.tsx`
- `app/routes/app.selling-plans.tsx`
- `app/routes/app.shop-metadata.tsx`
- `app/components/RubricNavigation.tsx`
- `prisma/migrations/20260622000000_add_theme_content_domain/migration.sql`

**Modified:**
- `prisma/schema.prisma` (add `domain` to `ThemeContent` + `ThemeTranslation`)
- `app/services/content.service.ts` (extend `getThemes()` working list +2; add `getThemeDefaults()`, `getSellingPlans()`, `getShopMetadata()`)
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
| `SHOP` writes silently ignored for built-in languages | Phase 0 catches this; pivot positioning for `themeDefaults` to "unsupported languages only" |
| Translation API rate limit hit during initial sync (15+ types × keys) | Sequential per-type sync + 500ms back-off between requests; persist progress so retries resume |
| `digest` mismatch on `SHOP` (one shop GID, many keys, per-key digests) | Existing `keyToResourceId` map in templates action already handles per-key digests — same code path works |
| Three-stacked sticky bars eat too much vertical space on mobile | `RubricNavigation` collapses to overflow menu under 768px; same pattern as existing `MobileMenu` |
| Merchant confused by "Theme-Inhalte" vs. "Theme-Standardinhalte" overlap | Tooltip on each rubric explaining the distinction; help-tooltip pattern exists in `HelpTooltip.tsx` |
| Shops without subscriptions see an empty "Abo-Pläne" entry | Loader returns empty → nav entry hidden via `contentCount === 0` filter (already a pattern in `ContentTypeNavigation`) |
| `SHOP` resource queried twice (defaults + shop-metadata) wastes one rate-limit hit | Factor into one shared GraphQL call that splits results by key prefix |
| Two new theme types (`APP_EMBED`, `SETTINGS_DATA_SECTIONS`) might still be empty on some themes | Acceptable — empty groups simply don't render. Re-test in Phase 0. |

---

### Effort estimate (single dev)

| Phase | Time |
|---|---|
| 0 — Spike (now 11 types) | 1.0 d |
| 1 — Backend (3 service methods + theme type expansion) | 1.5 d |
| 2 — Routes + actions (3 routes + folder rename) | 1.0 d |
| 3 — Nav restructure | 1.0 d |
| 4 — i18n + gating | 0.5 d |
| 5 — Tests | 1.0 d |
| **Total** | **~6 d** |

(Previous estimate was ~4 d for checkout-only; the +2 d covers SELLING_PLAN/SELLING_PLAN_GROUP routes, the SHOP split into two domains, the action-folder rename, and the broader test surface.)

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

Two-phase fill: docs-derived expectations first (this section), real numbers second (after running the probe).

### How to run the probe

1. Open the app → Settings → **Translation Probe** (left sidebar)
2. Click **Run probe** (read-only by default, hits all 11 new resource types)
3. Optionally tick **"Also run write test"** to answer the built-in-override question — registers one tagged value (`Continue [__cp-probe-<timestamp>]`) against `checkout.general.continue_button` in the first non-primary locale. Restore via Admin → Settings → Languages → Translate when done.
4. Click **Copy markdown report** and paste the output below (or back into the assistant chat)
5. The probe runs sequentially with 250ms gaps to stay under the Translation API rate limit; one full run takes ~10–15s on a typical dev shop

Backend: [app/routes/api.translation-probe.tsx](../app/routes/api.translation-probe.tsx)
UI: [app/components/SettingsTranslationProbeTab.tsx](../app/components/SettingsTranslationProbeTab.tsx)

### Docs-derived expectations *(high confidence, no probe needed)*

✅ **`translationsRegister` is market-aware** — `TranslationInput` accepts an optional `marketId`. When omitted, the translation applies globally within that locale; when set, only buyers in that market see it. Confirmed from [translationsRegister docs](https://shopify.dev/docs/api/admin-graphql/latest/mutations/translationsregister).

✅ **`translatableContentDigest` is mandatory** on every write — already handled by our existing templates action via `keyToResourceId` map.

✅ **`SHOP` resource ID** is the shop's GID (`gid://shopify/Shop/...`), one row per shop. All checkout/notification/shop-metadata keys hang off this single resource. Implication: one digest per key, not per resource — code path identical to the existing themes flow.

✅ **Built-in 33-language pack is not exposed via any resource type** — confirmed in §2. Apps can only layer overrides on top via `SHOP`. The probe's `translatableContent` for `SHOP` will only show keys the merchant or app can write, not the full built-in pack.

✅ **Theme types are bound to the active theme** — `ONLINE_STORE_THEME_*` resource IDs are `gid://shopify/OnlineStoreTheme/<themeId>`. On theme switch, translations must be re-registered. Already handled by our existing `getThemes()` flow.

### Expected per resource type *(probe will refine)*

| Type | Expected key prefixes | Confidence | Probe will confirm |
|---|---|---|---|
| `SHOP` | `checkout.*`, `notifications.*`, `shop.name`, `shop.description`, `shop.meta_title`, `shop.meta_description`, possibly `policy.*` | 🟡 | Exact prefix split → drives the `keyFilter` for Checkout & System vs. Shop-Metadaten |
| `EMAIL_TEMPLATE` | One resource per template; keys likely `title`, `body_html` | 🟡 | Template count varies (Shopify ships ~25 templates by default) |
| `PACKING_SLIP_TEMPLATE` | Single resource; `body` field | 🟡 | Usually one template per shop |
| `DELIVERY_METHOD_DEFINITION` | One resource per shipping rate; key `name` | 🟡 | Count = #shipping rates on the shop |
| `PAYMENT_GATEWAY` | One resource per enabled gateway; keys `name`, `instructions` | 🟡 | "Manual" payment methods most likely to have content |
| `FILTER` | One resource per storefront filter; key `label` | 🟡 | Only present if shop uses storefront filters |
| `SELLING_PLAN_GROUP` | One resource per subscription group; keys `name`, `description`, `options.*` | 🟡 | Empty on shops without subscriptions — handle empty case in UI |
| `SELLING_PLAN` | One resource per plan; keys `name`, `description` | 🟡 | Same as above |
| `ONLINE_STORE_THEME_APP_EMBED` | Key shape = embed handle paths | 🟡 | May be empty on Dawn — check on a populated theme |
| `ONLINE_STORE_THEME_SETTINGS_DATA_SECTIONS` | Section-content shared across templates | 🟡 | May be empty on Dawn |

🟡 = expected based on documented resource semantics; the probe will yield the actual key list per shop.

### Open questions the probe MUST answer

🔴 **`SHOP` write override behaviour** — when we write to `checkout.general.continue_button` in German (one of the 33 built-in languages), does Shopify show our value, or does the built-in win? The probe's write-test attempts the write; the user then verifies visually in Admin → Settings → Languages → Translate.

🔴 **`SHOP` key split** — does the probe actually show both `checkout.*` AND `shop.*` keys, or are they on separate sub-resources? Drives whether `getThemeDefaults()` and `getShopMetadata()` can share one GraphQL call.

🔴 **APP_EMBED / SETTINGS_DATA_SECTIONS content presence** — these two were excluded from `getThemes()` historically after `testAllThemeResourceTypes()` found them empty on the test shop. Probe will tell us if a richer theme (Dawn 12+, a paid theme) populates them. Decision: if still empty everywhere, skip them in Phase 1.2.

🔴 **Total key counts** — capacity input for the `maxThemeTranslations` cap. If `EMAIL_TEMPLATE` + `SHOP` + the others together cross 10k keys per shop, we need to revisit the limit.

🔴 **Translation API rate-limit headroom** — does sequential 11-type pull with 250ms gaps stay under the limit, or do we need longer pauses? Observation only; the probe will surface any rate-limit errors in the report.

### Probe output  *(paste here after running)*

```
<paste markdown report from Settings → Translation Probe here>
```

### Decision gate

After the probe report is pasted above, decide:

- [ ] Proceed with the full plan as written
- [ ] Pivot `themeDefaults` to "unsupported languages only" if SHOP writes lose to built-in 33
- [ ] Drop `APP_EMBED` / `SETTINGS_DATA_SECTIONS` from Phase 1.2 if always empty
- [ ] Drop `selling-plans` route entirely if even subscription-using shops have empty resources
- [ ] Other adjustments: …
