# Shopify Translatable Content Types

Complete list of all translatable resource types available in Shopify's GraphQL Admin API.

## Overview

Shopify supports **31+ translatable resource types** through the `TranslatableResourceType` enum. Each resource type requires a **separate GraphQL query** - bulk querying multiple types simultaneously is not supported.

---

## 📝 Content & Pages

| Resource Type | Description | Translatable Fields |
|--------------|-------------|-------------------|
| **ARTICLE** | Blog posts/articles | title, body, handle, meta_title, meta_description |
| **ARTICLE_IMAGE** | Blog article images | alt text |
| **BLOG** | Blog collections/categories | title, metadata |
| **PAGE** | Store pages | title, body_html, handle |
| **EMAIL_TEMPLATE** | Email templates | title, body content |
| **PACKING_SLIP_TEMPLATE** | Packing slip templates | Custom content fields |

---

## 🛍️ Products & Collections

| Resource Type | Description | Translatable Fields |
|--------------|-------------|-------------------|
| **PRODUCT** | Store products | title, body_html, handle, meta_title, meta_description |
| **PRODUCT_OPTION** | Product options (e.g., "Size", "Color") | name |
| **PRODUCT_OPTION_VALUE** | Option values (e.g., "Small", "Red") | value |
| **PRODUCT_VARIANT** | Product variants (nested resource) | title, option values |
| **COLLECTION** | Product collections | title, body_html, handle, meta_title, meta_description |
| **COLLECTION_IMAGE** | Collection images | alt text |
| **MEDIA_IMAGE** | General media images | alt text |

---

## 🎨 Theme & Design

| Resource Type | Description | Translatable Fields |
|--------------|-------------|-------------------|
| **ONLINE_STORE_THEME** | Theme content | Dynamic keys based on theme |
| **ONLINE_STORE_THEME_APP_EMBED** | Theme app embeds | Configuration text |
| **ONLINE_STORE_THEME_JSON_TEMPLATE** | Theme JSON templates | Template content |
| **ONLINE_STORE_THEME_LOCALE_CONTENT** | Theme locale files | Translation keys |
| **ONLINE_STORE_THEME_SECTION_GROUP** | Theme section groups | Section titles/labels |
| **ONLINE_STORE_THEME_SETTINGS_CATEGORY** | Theme setting categories | Category names |
| **ONLINE_STORE_THEME_SETTINGS_DATA_SECTIONS** | Shared theme sections | Section content |

---

## 🗂️ Navigation & Menus

| Resource Type | Description | Translatable Fields |
|--------------|-------------|-------------------|
| **MENU** | Navigation menus | title |
| **LINK** | Navigation links | title |

---

## 📦 Metadata & Custom Fields

| Resource Type | Description | Translatable Fields |
|--------------|-------------|-------------------|
| **METAFIELD** | Custom fields | value |
| **METAOBJECT** | Custom objects | All fields (type-dependent) |

---

## 💳 Checkout & Payments

| Resource Type | Description | Translatable Fields |
|--------------|-------------|-------------------|
| **PAYMENT_GATEWAY** | Payment methods | name, instructions |
| **DELIVERY_METHOD_DEFINITION** | Shipping methods | name (e.g., "Standard Shipping") |

---

## 🔍 Filters & Search

| Resource Type | Description | Translatable Fields |
|--------------|-------------|-------------------|
| **FILTER** | Product filters | label text |

---

## 📜 Shop Policies & Settings

| Resource Type | Description | Translatable Fields |
|--------------|-------------|-------------------|
| **SHOP_POLICY** | Shop policies | body (Privacy Policy, Refund Policy, Terms of Service, Shipping Policy) |
| **SHOP** | Shop metadata | name, description, meta_title, meta_description |

---

## 🔄 Subscriptions & Plans

| Resource Type | Description | Translatable Fields |
|--------------|-------------|-------------------|
| **SELLING_PLAN_GROUP** | Subscription/selling plans | name, description, options |

---

## 📱 Communication Templates

| Resource Type | Description | Translatable Fields |
|--------------|-------------|-------------------|
| **SMS_TEMPLATE** | SMS notification templates | body content |

---

## 🔑 Important Notes

### ❌ Bulk Queries NOT Supported

You **cannot** query multiple resource types in a single request:

```graphql
# ❌ NOT POSSIBLE
query {
  translatableResources(resourceType: [PRODUCT, ARTICLE, PAGE]) {
    edges { node { resourceId } }
  }
}
```

### ✅ Separate Queries Required

Each resource type requires its own query:

```graphql
# ✅ CORRECT - Separate query for each type
query getProducts {
  translatableResources(resourceType: PRODUCT, first: 250) {
    edges {
      node {
        resourceId
        translatableContent {
          key
          value
          digest
          locale
        }
        translations(locale: "de") {
          key
          value
          locale
        }
      }
    }
  }
}

query getArticles {
  translatableResources(resourceType: ARTICLE, first: 250) {
    edges {
      node {
        resourceId
        translatableContent {
          key
          value
          digest
          locale
        }
      }
    }
  }
}

# ... repeat for each resource type (31+ queries total)
```

---

## 📊 Query Performance Considerations

### API Rate Limits
- Shopify has API rate limits (typically 2 requests/second for REST, calculated cost for GraphQL)
- Querying all 31+ resource types sequentially can be slow
- GraphQL cost is calculated based on query complexity

### Recommended Approaches

**Option 1: Selective Loading**
- Only query resource types you actively use
- Most shops primarily need: PRODUCT, ARTICLE, PAGE, COLLECTION, METAOBJECT

**Option 2: Lazy Loading**
- Load resource types on-demand when user clicks/expands
- Better UX and faster initial load

**Option 3: Background Sync**
- Sync all resource types in background job
- Store in local database
- Display from cache

**Option 4: Pagination**
- Use `first: 250` with cursor pagination
- Process large datasets in batches
- Monitor GraphQL query cost

---

## 🗄️ Database Schema Recommendations

For caching translatable content, consider separate tables:

```prisma
model ProductTranslation {
  id        String   @id @default(cuid())
  productId String
  key       String
  value     String
  locale    String
  digest    String?
  shop      String
  @@unique([productId, key, locale])
}

model ContentTranslation {
  id           String   @id @default(cuid())
  resourceId   String
  resourceType String   // ARTICLE, PAGE, COLLECTION, etc.
  key          String
  value        String
  locale       String
  digest       String?
  shop         String
  @@unique([resourceId, resourceType, key, locale])
}

model MetaobjectTranslation {
  id           String   @id @default(cuid())
  metaobjectId String
  key          String
  value        String
  locale       String
  digest       String?
  shop         String
  @@unique([metaobjectId, key, locale])
}
```

---

## 📚 References

- [Shopify GraphQL Admin API - TranslatableResource](https://shopify.dev/docs/api/admin-graphql/latest/objects/TranslatableResource)
- [Shopify GraphQL Admin API - TranslatableResourceType](https://shopify.dev/docs/api/admin-graphql/latest/enums/TranslatableResourceType)
- [Shopify GraphQL Admin API - translatableResources Query](https://shopify.dev/docs/api/admin-graphql/latest/queries/translatableResources)
- [Shopify Translations API Guide](https://shopify.dev/docs/apps/build/internationalization/manage-translations)

---

## 🎯 Priority Resource Types for Most Shops

Based on typical usage, focus on these high-priority types:

### High Priority (Core Content)
1. **PRODUCT** - Essential for e-commerce
2. **COLLECTION** - Product organization
3. **PAGE** - Static content pages
4. **ARTICLE** - Blog content
5. **METAOBJECT** - Custom structured data

### Medium Priority (Navigation & Settings)
6. **MENU** - Site navigation
7. **LINK** - Navigation links
8. **SHOP_POLICY** - Legal pages
9. **METAFIELD** - Custom product/collection fields

### Low Priority (Advanced/Edge Cases)
10. **ONLINE_STORE_THEME_*** - Theme customization
11. **EMAIL_TEMPLATE** - Notification customization
12. **PAYMENT_GATEWAY** - Custom payment methods
13. **FILTER** - Advanced filtering
14. **SMS_TEMPLATE** - SMS notifications

---

**Last Updated:** January 2026
**Shopify API Version:** 2025-01 (and later)
