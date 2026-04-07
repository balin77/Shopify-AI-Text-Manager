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

export const REMOVE_TRANSLATIONS = `#graphql
  mutation removeTranslations($resourceId: ID!, $translationKeys: [String!]!, $locales: [String!]!) {
    translationsRemove(resourceId: $resourceId, translationKeys: $translationKeys, locales: $locales) {
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

export const UPDATE_PAGE = `#graphql
  mutation updatePage($id: ID!, $page: PageUpdateInput!) {
    pageUpdate(id: $id, page: $page) {
      page {
        id
        title
        handle
        body
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
