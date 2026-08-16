// GraphQL mutations for content management

export const TRANSLATE_CONTENT = `#graphql
  mutation translateContent($resourceId: ID!, $translations: [TranslationInput!]!) {
    translationsRegister(resourceId: $resourceId, translations: $translations) {
      userErrors {
        field
        message
      }
      translations {
        locale
        key
        value
      }
    }
  }
`;

/**
 * TRANSLATE_CONTENT with the FULL echo selection required for verified saves
 * (Plan §14 no. 7): `market` is an OBJECT on the Translation type — a flat
 * `marketId` does not exist in the response, so market-aware callers must
 * select `market { id }`. Kept as a separate document (instead of widening
 * TRANSLATE_CONTENT) so the many existing callers keep their exact response
 * shape. Used by registerAndVerify (bulk-editor translations.server.ts) — the
 * echo (`translations`) is the ONLY proof a key was actually stored;
 * `userErrors: []` alone is not (CLAUDE.md invariant).
 */
export const TRANSLATE_CONTENT_VERIFIED = `#graphql
  mutation translateContentVerified($resourceId: ID!, $translations: [TranslationInput!]!) {
    translationsRegister(resourceId: $resourceId, translations: $translations) {
      userErrors {
        field
        message
      }
      translations {
        key
        locale
        value
        market {
          id
        }
      }
    }
  }
`;

// $marketIds is optional: omit (or pass null) to remove the GLOBAL translation
// (all markets); pass [gid://shopify/Market/<id>] to remove only that market's
// override while the global translation survives. Existing callers that don't
// supply the variable get the legacy global-removal behaviour.
export const REMOVE_TRANSLATIONS = `#graphql
  mutation removeTranslations($resourceId: ID!, $translationKeys: [String!]!, $locales: [String!]!, $marketIds: [ID!]) {
    translationsRemove(resourceId: $resourceId, translationKeys: $translationKeys, locales: $locales, marketIds: $marketIds) {
      userErrors {
        field
        message
      }
      translations {
        key
        locale
      }
    }
  }
`;

export const UPDATE_BLOG = `#graphql
  mutation updateBlog($id: ID!, $blog: BlogUpdateInput!) {
    blogUpdate(id: $id, blog: $blog) {
      blog {
        id
        title
        handle
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const UPDATE_PAGE = `#graphql
  mutation updatePage($id: ID!, $page: PageUpdateInput!) {
    pageUpdate(id: $id, page: $page) {
      page {
        id
        title
        handle
        body
        seoTitle: metafield(namespace: "global", key: "title_tag") { value }
        seoDescription: metafield(namespace: "global", key: "description_tag") { value }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const UPDATE_COLLECTION = `#graphql
  mutation updateCollection($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection {
        id
        title
        handle
        descriptionHtml
        seo {
          title
          description
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const UPDATE_ARTICLE = `#graphql
  mutation updateArticle($id: ID!, $article: ArticleUpdateInput!) {
    articleUpdate(id: $id, article: $article) {
      article {
        id
        title
        handle
        body
        summary
        seoTitle: metafield(namespace: "global", key: "title_tag") { value }
        seoDescription: metafield(namespace: "global", key: "description_tag") { value }
        image {
          altText
          url
        }
        seoTitle: metafield(namespace: "global", key: "title_tag") { value }
        seoDescription: metafield(namespace: "global", key: "description_tag") { value }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const UPDATE_SHOP_POLICY = `#graphql
  mutation updateShopPolicy($shopPolicy: ShopPolicyInput!) {
    shopPolicyUpdate(shopPolicy: $shopPolicy) {
      shopPolicy {
        id
        type
        title
        body
        url
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * THEME FILES UPSERT — Update theme files for primary locale content
 *
 * This mutation creates or updates theme files directly on the Shopify theme.
 * It is the ONLY way to update primary locale theme content via API, since
 * `translationsRegister` rejects the shop's primary locale.
 *
 * REQUIREMENTS:
 *   - `write_themes` scope (add to shopify.app.toml)
 *   - Shopify "Protected Scope Exemption" approval
 *   - ENABLE_THEME_PRIMARY_EDIT = true (in app/config/constants.ts)
 *
 * NOTE: This mutation is INTENTIONALLY prepared but NOT yet active.
 *       Do NOT remove it — it will be activated once the exemption is granted.
 *       See ENABLE_THEME_PRIMARY_EDIT in app/config/constants.ts for details.
 */
/**
 * Delete theme files. Needed to undo a file the app CREATED — an upsert can't
 * express "put it back to not existing", and leaving a broken generated
 * template behind is worse than never having written it.
 */
export const DELETE_THEME_FILES = `#graphql
  mutation deleteThemeFiles($themeId: ID!, $files: [String!]!) {
    themeFilesDelete(themeId: $themeId, files: $files) {
      deletedThemeFiles {
        filename
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const UPSERT_THEME_FILES = `#graphql
  mutation upsertThemeFiles($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
    themeFilesUpsert(themeId: $themeId, files: $files) {
      upsertedThemeFiles {
        filename
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * PRODUCT OPTION UPDATE — Update product option name and/or values in primary locale
 *
 * This mutation updates the name and/or values of a product option.
 * Uses OptionUpdateInput for the option (id + optional name) and
 * optionValuesToUpdate for changing existing option value names.
 *
 * REQUIREMENTS:
 *   - `write_products` scope (already present)
 */
export const PRODUCT_OPTION_UPDATE = `#graphql
  mutation productOptionUpdate($productId: ID!, $option: OptionUpdateInput!, $optionValuesToUpdate: [OptionValueUpdateInput!]) {
    productOptionUpdate(
      productId: $productId
      option: $option
      optionValuesToUpdate: $optionValuesToUpdate
    ) {
      product {
        id
        options {
          id
          name
          position
          values
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * METAFIELDS SET — Create or update metafield values in primary locale
 *
 * This mutation sets metafield values directly (not translations).
 * Can handle up to 25 metafields per request, max 10MB payload.
 *
 * REQUIREMENTS:
 *   - `write_products` scope (for product metafields, already present)
 */
export const METAFIELDS_SET = `#graphql
  mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        namespace
        key
        value
        type
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * METAFIELDS DELETE — remove metafield values by identifier.
 *
 * Setting a metafield to `value: ""` via metafieldsSet does NOT clear it on
 * Shopify. To actually remove a metafield (e.g. clearing a page/blog SEO
 * title_tag / description_tag on the primary locale), it must be deleted by
 * its { ownerId, namespace, key } identifier. Deleting a non-existent
 * metafield is a no-op.
 */
export const METAFIELDS_DELETE = `#graphql
  mutation metafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields {
        ownerId
        namespace
        key
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * METAFIELD DEFINITION UPDATE (translatable) — make a definition translatable by
 * setting its STOREFRONT ACCESS to PUBLIC_READ.
 *
 * A product metafield is translatable iff it is publicly accessible
 * (`access.storefront == PUBLIC_READ`); there is no `capabilities.translatable`
 * for metafields. Setting this exposes the metafield's values on the public
 * Storefront API — a deliberate, merchant-initiated side effect.
 *
 * Only works for definitions OWNED by this shop. Shopify rejects updates to
 * definitions owned by a different app with a userError — which is exactly how
 * we detect/skip third-party-owned definitions.
 *
 * REQUIREMENTS:
 *   - The metafield definition must be shop-owned (not owned by another app).
 */
export const METAFIELD_DEFINITION_UPDATE_TRANSLATABLE = `#graphql
  mutation metafieldDefinitionUpdateTranslatable($definition: MetafieldDefinitionUpdateInput!) {
    metafieldDefinitionUpdate(definition: $definition) {
      updatedDefinition {
        id
        access {
          storefront
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

/**
 * METAFIELD DEFINITION CREATE (translatable) — create a shop-owned definition
 * for an existing definition-less metafield and make it translatable.
 *
 * Some metafields (esp. raw values written by apps/imports) have no definition,
 * so they can't be made translatable by updating one. Creating a definition for
 * the existing namespace/key/type (with PUBLIC_READ storefront access) adopts
 * the existing values and makes them translatable. Only works in shop-owned
 * namespaces; reserved/app namespaces are rejected with a userError.
 */
export const METAFIELD_DEFINITION_CREATE_TRANSLATABLE = `#graphql
  mutation metafieldDefinitionCreateTranslatable($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition {
        id
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

/**
 * METAOBJECT UPDATE — Update metaobject field values in primary locale
 *
 * This mutation updates metaobject field values directly (not translations).
 * For translations, use TRANSLATE_CONTENT mutation instead.
 *
 * REQUIREMENTS:
 *   - `write_metaobjects` scope (should be added to shopify.app.toml)
 */
export const METAOBJECT_UPDATE = `#graphql
  mutation metaobjectUpdate($id: ID!, $metaobject: MetaobjectUpdateInput!) {
    metaobjectUpdate(id: $id, metaobject: $metaobject) {
      metaobject {
        id
        handle
        displayName
        type
        fields {
          key
          value
          type
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// SEO tab Phase 3: native URL redirect CRUD (Online Store navigation).
// Requires the `write_online_store_navigation` access scope. Always read
// `userErrors` — Shopify reports loops/duplicates/invalid paths there.
export const URL_REDIRECT_CREATE = `#graphql
  mutation urlRedirectCreate($urlRedirect: UrlRedirectInput!) {
    urlRedirectCreate(urlRedirect: $urlRedirect) {
      urlRedirect {
        id
        path
        target
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const URL_REDIRECT_UPDATE = `#graphql
  mutation urlRedirectUpdate($id: ID!, $urlRedirect: UrlRedirectInput!) {
    urlRedirectUpdate(id: $id, urlRedirect: $urlRedirect) {
      urlRedirect {
        id
        path
        target
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const URL_REDIRECT_DELETE = `#graphql
  mutation urlRedirectDelete($id: ID!) {
    urlRedirectDelete(id: $id) {
      deletedUrlRedirectId
      userErrors {
        field
        message
      }
    }
  }
`;

// ────────────────────────────────────────────────────────────────────────────
// CREATE mutations — PLAN_CONTENT_CREATION §1.5
//
// Every one of these selects back the CORE FIELDS it set, not just an id. The
// echo rule this repo applies to translations applies here too and for the same
// reason: `userErrors: []` only means Shopify did not object, never that it
// stored anything (see the invariants in CLAUDE.md).
//
// Page / Article / Blog notably do NOT carry `seo` on their create inputs —
// their meta title/description live in the `global.title_tag` /
// `description_tag` metafields and need the separate METAFIELDS_SET step.
// Selecting them back here is what makes that step verifiable.
// ────────────────────────────────────────────────────────────────────────────

/**
 * `productSet` rather than `productCreate` (§1.1): it covers the default
 * variant's price/sku/barcode in the SAME call — a product without a price is
 * not sellable (§2.2) — and it accepts `identifier: { handle }`, which makes a
 * retry idempotent instead of duplicating (§1.7).
 */
export const CREATE_PRODUCT_SET = `#graphql
  mutation createProductSet($input: ProductSetInput!, $synchronous: Boolean!) {
    productSet(input: $input, synchronous: $synchronous) {
      product {
        id
        title
        handle
        status
        vendor
        productType
        tags
        descriptionHtml
        seo { title description }
        variants(first: 1) {
          nodes { id price compareAtPrice sku barcode }
        }
      }
      userErrors { field message code }
    }
  }
`;

export const CREATE_COLLECTION = `#graphql
  mutation createCollection($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection {
        id
        title
        handle
        descriptionHtml
        sortOrder
        seo { title description }
      }
      userErrors { field message }
    }
  }
`;

export const CREATE_PAGE = `#graphql
  mutation createPage($page: PageCreateInput!) {
    pageCreate(page: $page) {
      page {
        id
        title
        handle
        body
        isPublished
      }
      userErrors { field message code }
    }
  }
`;

export const CREATE_ARTICLE = `#graphql
  mutation createArticle($article: ArticleCreateInput!) {
    articleCreate(article: $article) {
      article {
        id
        title
        handle
        body
        summary
        tags
        isPublished
        author { name }
        blog { id title }
        image { url altText }
      }
      userErrors { field message code }
    }
  }
`;

export const CREATE_BLOG = `#graphql
  mutation createBlog($blog: BlogCreateInput!) {
    blogCreate(blog: $blog) {
      blog {
        id
        title
        handle
        commentPolicy
      }
      userErrors { field message code }
    }
  }
`;

export const CREATE_METAOBJECT = `#graphql
  mutation createMetaobject($metaobject: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $metaobject) {
      metaobject {
        id
        type
        handle
        displayName
        fields { key value type }
      }
      userErrors { field message code }
    }
  }
`;

/** Blogs a merchant can file an article under (§1.7: none ⇒ offer the blog form). */
export const LIST_BLOGS_FOR_CREATE = `#graphql
  query listBlogsForCreate($first: Int!) {
    blogs(first: $first) {
      nodes { id title handle }
    }
  }
`;
