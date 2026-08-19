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

// `templateSuffix` is echoed (PLAN §Phase 3) so the caller mirrors what
// Shopify STORED. The prose stays outside the document: a `#` comment inside
// it travels to Shopify (see the GraphQL-comment gotcha in CLAUDE.md).
export const UPDATE_BLOG = `#graphql
  mutation updateBlog($id: ID!, $blog: BlogUpdateInput!) {
    blogUpdate(id: $id, blog: $blog) {
      blog {
        id
        title
        handle
        templateSuffix
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// `isPublished` / `templateSuffix` are PLAN §Phase 3 merchandising
// attributes, echoed for the DB mirror.
export const UPDATE_PAGE = `#graphql
  mutation updatePage($id: ID!, $page: PageUpdateInput!) {
    pageUpdate(id: $id, page: $page) {
      page {
        id
        title
        handle
        body
        isPublished
        templateSuffix
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

// `sortOrder` / `templateSuffix` are PLAN §Phase 3 merchandising
// attributes, echoed for the DB mirror.
export const UPDATE_COLLECTION = `#graphql
  mutation updateCollection($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection {
        id
        title
        handle
        descriptionHtml
        sortOrder
        templateSuffix
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

// `author` / `tags` / `isPublished` / `templateSuffix` are PLAN §Phase 3
// merchandising attributes, echoed for the DB mirror.
export const UPDATE_ARTICLE = `#graphql
  mutation updateArticle($id: ID!, $article: ArticleUpdateInput!) {
    articleUpdate(id: $id, article: $article) {
      article {
        id
        title
        handle
        body
        summary
        author { name }
        tags
        isPublished
        templateSuffix
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
// Adding and deleting VALUES changes the variant matrix, which is why the
// three list arguments travel together with a strategy:
//
//   optionValuesToAdd    — MANAGE creates the new combinations as variants,
//                          which is what the Shopify admin does and what a
//                          merchant means by "we now also sell it in red".
//   optionValuesToDelete — deletes the variants that used the value, with
//                          their stock, prices, SKUs and image assignments.
//                          Irreversible, and the UI counts them before asking.
//   optionValuesToUpdate — a rename, no matrix change at all.
//
// `variantStrategy` is required whenever the first two are present; the app
// sends MANAGE, and never LEAVE_AS_IS, because a value with no variant behind
// it is a value nobody can order.
//
// Every one of these documents selects `optionValues { id name }` and not just
// the `values` string list: an ADDED value's GID is what a later rename and
// every translation write address, and without it the client would have to
// guess which value it had just created.
export const PRODUCT_OPTION_UPDATE = `#graphql
  mutation productOptionUpdate($productId: ID!, $option: OptionUpdateInput!, $optionValuesToUpdate: [OptionValueUpdateInput!], $optionValuesToAdd: [OptionValueCreateInput!], $optionValuesToDelete: [ID!], $variantStrategy: ProductOptionUpdateVariantStrategy) {
    productOptionUpdate(
      productId: $productId
      option: $option
      optionValuesToUpdate: $optionValuesToUpdate
      optionValuesToAdd: $optionValuesToAdd
      optionValuesToDelete: $optionValuesToDelete
      variantStrategy: $variantStrategy
    ) {
      product {
        id
        options {
          id
          name
          position
          linkedMetafield { namespace key }
          optionValues { id name linkedMetafieldValue }
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

/** A new option on an existing product. CREATE, not LEAVE_AS_IS: a second
 *  option nobody can order is not what "add a variant" means. */
export const PRODUCT_OPTIONS_CREATE = `#graphql
  mutation productOptionsCreate($productId: ID!, $options: [OptionCreateInput!]!) {
    productOptionsCreate(productId: $productId, options: $options, variantStrategy: CREATE) {
      product {
        id
        options {
          id
          name
          position
          linkedMetafield { namespace key }
          optionValues { id name linkedMetafieldValue }
          values
        }
      }
      userErrors { field message }
    }
  }
`;

// NOTE (outside the document -- a `#graphql` literal carries no comments):
// `strategy: DEFAULT`, not NON_DESTRUCTIVE. Removing one option of a 2x2 matrix
// necessarily deletes variants, so NON_DESTRUCTIVE would REFUSE the delete on
// every product that has more than one option -- and refuse it as a generic
// userError, after the merchant confirmed a dialog promising the opposite. The
// confirmation names the consequence; the strategy has to match it.
/** Removing a whole option collapses the matrix onto the remaining ones. */
export const PRODUCT_OPTIONS_DELETE = `#graphql
  mutation productOptionsDelete($productId: ID!, $options: [ID!]!) {
    productOptionsDelete(productId: $productId, options: $options, strategy: DEFAULT) {
      product {
        id
        options {
          id
          name
          position
          linkedMetafield { namespace key }
          optionValues { id name linkedMetafieldValue }
          values
        }
      }
      userErrors { field message }
    }
  }
`;

/** Order only. It does not touch values, so it cannot lose a variant. */
export const PRODUCT_OPTIONS_REORDER = `#graphql
  mutation productOptionsReorder($productId: ID!, $options: [OptionReorderInput!]!) {
    productOptionsReorder(productId: $productId, options: $options) {
      product {
        id
        options {
          id
          name
          position
          linkedMetafield { namespace key }
          optionValues { id name linkedMetafieldValue }
          values
        }
      }
      userErrors { field message }
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
 *
 * The echo selects `owner { ... on Product { id } }` because the returned
 * metafields carry no owner by themselves: a caller writing the SAME key for
 * many owners in one call could otherwise only recognise its writes by
 * matching the value back, which confirms the wrong owner as soon as two of
 * them get identical content. (services/seo/video-schema.server.ts depends on
 * this to decide whether a product's write actually landed.)
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
        owner {
          ... on Product {
            id
          }
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

// ────────────────────────────────────────────────────────────────────────────
// DELETE mutations
//
// The FIRST content deletes in this app (before these, only productDeleteMedia
// existed). Each returns the deleted id, and that id is the ONLY thing that
// counts as confirmation: `userErrors: []` means Shopify did not object, not
// that anything was removed. If the id does not come back, the local cache row
// must stay — a cache that forgets an object Shopify still has is worse than
// one that briefly remembers a deleted one, because only the second self-heals
// on the next sync.
// ────────────────────────────────────────────────────────────────────────────

export const DELETE_PRODUCT = `#graphql
  mutation deleteProduct($input: ProductDeleteInput!) {
    productDelete(input: $input) {
      deletedProductId
      userErrors { field message }
    }
  }
`;

export const DELETE_COLLECTION = `#graphql
  mutation deleteCollection($input: CollectionDeleteInput!) {
    collectionDelete(input: $input) {
      deletedCollectionId
      userErrors { field message }
    }
  }
`;

export const DELETE_PAGE = `#graphql
  mutation deletePage($id: ID!) {
    pageDelete(id: $id) {
      deletedPageId
      userErrors { field message code }
    }
  }
`;

export const DELETE_ARTICLE = `#graphql
  mutation deleteArticle($id: ID!) {
    articleDelete(id: $id) {
      deletedArticleId
      userErrors { field message code }
    }
  }
`;

/** Deleting a blog deletes every article inside it — the UI must say so. */
export const DELETE_BLOG = `#graphql
  mutation deleteBlog($id: ID!) {
    blogDelete(id: $id) {
      deletedBlogId
      userErrors { field message code }
    }
  }
`;

export const DELETE_METAOBJECT = `#graphql
  mutation deleteMetaobject($id: ID!) {
    metaobjectDelete(id: $id) {
      deletedId
      userErrors { field message code }
    }
  }
`;

/**
 * Deletes a metaobject DEFINITION -- the type itself, and with it every entry
 * of that type.
 *
 * Needs `write_metaobject_definitions`, which this app requests since the scope
 * change of 2026-08. It is the most destructive call in this codebase: the
 * entries are not asked about, they go with the container. The confirmation in
 * front of it says so and names how many there are.
 */
export const DELETE_METAOBJECT_DEFINITION = `#graphql
  mutation deleteMetaobjectDefinition($id: ID!) {
    metaobjectDefinitionDelete(id: $id) {
      deletedId
      userErrors { field message code }
    }
  }
`;

/** Duplicate mutations — PLAN_CONTENT_CREATION §1.9 / §2.5f.
 *
 *  Both are ASYNCHRONOUS: they return a `job`, not a finished object. The
 *  caller therefore cannot select the new item straight away the way the
 *  synchronous create path does, and must say "being created" rather than
 *  pretend otherwise. */
export const DUPLICATE_PRODUCT = `#graphql
  mutation duplicateProduct($productId: ID!, $newTitle: String!, $newStatus: ProductStatus, $includeImages: Boolean) {
    productDuplicate(productId: $productId, newTitle: $newTitle, newStatus: $newStatus, includeImages: $includeImages) {
      newProduct { id title handle status }
      productDuplicateOperation { id status }
      userErrors { field message }
    }
  }
`;

/** Measured on 2026-07 (PLAN §1.2a): `copyPublications` comes along, which
 *  settles the §2.3 "active but invisible" trap for the copy in one step. */
export const DUPLICATE_COLLECTION = `#graphql
  mutation duplicateCollection($input: CollectionDuplicateInput!) {
    collectionDuplicate(input: $input) {
      collection { id title handle }
      job { id done }
      userErrors { field message code }
    }
  }
`;

/**
 * Rule-based collection create — 2026-07 and later ONLY.
 *
 * The argument name differs from the manual path (`collection:` vs `input:`)
 * because the whole input type is different: `CollectionCreateInput` carries
 * `sources[]`, `CollectionInput` carries the deprecated `ruleSet`. The two are
 * not interchangeable (PLAN §1.2a), which is why this is a separate mutation
 * rather than a conditional variable on the existing one.
 *
 * `sources` is selected back so the echo can confirm the rules landed —
 * NEVER `ruleSet`, which is a lossy projection that would report a
 * multi-condition source as a single legacy rule.
 */
export const CREATE_COLLECTION_WITH_SOURCES = `#graphql
  mutation createCollectionWithSources($collection: CollectionCreateInput!) {
    collectionCreate(collection: $collection) {
      collection {
        id
        title
        handle
        descriptionHtml
        sortOrder
        seo { title description }
        sources { __typename }
      }
      userErrors { field message }
    }
  }
`;
