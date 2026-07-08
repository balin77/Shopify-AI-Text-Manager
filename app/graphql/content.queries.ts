// GraphQL queries for content management

export const GET_SHOP_LOCALES = `#graphql
  query getShopLocales {
    shopLocales {
      locale
      name
      primary
      published
    }
  }
`;

/**
 * MARKETS — enumerate the shop's markets and the locales each one serves.
 *
 * Backs the market-specific translation feature ("Translate & Adapt"): a
 * translation may target a single Market (gid://shopify/Market/<id>) so the same
 * locale can differ per market (e.g. English for UK vs. US).
 *
 * We need, per market, the set of locales it offers on its storefront. A market's
 * web presence exposes those via `rootUrls` (one entry per served locale — the
 * default locale at the domain root plus every alternate-locale subfolder). We
 * read the locale off each rootUrl rather than `defaultLocale`/`alternateLocales`
 * because rootUrls is the single, stable collection that already unions both.
 *
 * Requires the `read_markets` access scope. If the scope is missing or the shop
 * has no extra markets, loadMarkets() degrades to an empty list and the feature
 * stays invisible (see ShopifyContentService.loadMarkets).
 *
 * VERIFY against the pinned API version's GraphiQL explorer if markets ever fail
 * to load: field names on Market (`enabled`) and the web-presence relation
 * (`webPresences` connection vs. legacy singular `webPresence`) have shifted
 * across versions. This query targets 2025-10.
 */
export const GET_MARKETS = `#graphql
  query getMarkets($first: Int!) {
    markets(first: $first) {
      edges {
        node {
          id
          name
          handle
          enabled
          status
          webPresences(first: 10) {
            edges {
              node {
                rootUrls {
                  locale
                }
                defaultLocale {
                  locale
                }
                alternateLocales {
                  locale
                }
              }
            }
          }
        }
      }
    }
  }
`;

export const GET_BLOGS = `#graphql
  query getBlogs($first: Int!) {
    blogs(first: $first) {
      edges {
        node {
          id
          title
          handle
          articles(first: 50) {
            edges {
              node {
                id
                title
                handle
                body
                publishedAt
              }
            }
          }
        }
      }
    }
  }
`;

export const GET_COLLECTIONS = `#graphql
  query getCollections($first: Int!) {
    collections(first: $first) {
      edges {
        node {
          id
          title
          handle
          descriptionHtml
          seo {
            title
            description
          }
        }
      }
    }
  }
`;

export const GET_PAGES = `#graphql
  query getPages($first: Int!) {
    pages(first: $first) {
      edges {
        node {
          id
          title
          handle
          bodySummary
          body
          seoTitle: metafield(namespace: "global", key: "title_tag") { value }
          seoDescription: metafield(namespace: "global", key: "description_tag") { value }
        }
      }
    }
  }
`;

export const GET_TRANSLATIONS = `#graphql
  query getTranslations($resourceId: ID!, $locale: String!, $marketId: ID) {
    translatableResource(resourceId: $resourceId) {
      translations(locale: $locale, marketId: $marketId) {
        key
        value
        locale
      }
    }
  }
`;

export const GET_TRANSLATABLE_CONTENT = `#graphql
  query getTranslatableContent($resourceId: ID!) {
    translatableResource(resourceId: $resourceId) {
      resourceId
      translatableContent {
        key
        value
        digest
        locale
      }
    }
  }
`;

export const GET_SHOP_POLICIES = `#graphql
  query getShopPolicies {
    shop {
      shopPolicies {
        id
        title
        body
        type
        url
      }
    }
  }
`;

export const GET_SHOP_METADATA = `#graphql
  query getShopMetadata($metafieldsFirst: Int!, $metafieldsAfter: String) {
    shop {
      id
      name
      description
      email
      contactEmail
      currencyCode
      ianaTimezone
      primaryDomain {
        host
        url
      }
      myshopifyDomain
      metafields(first: $metafieldsFirst, after: $metafieldsAfter) {
        edges {
          node {
            id
            namespace
            key
            value
            type
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

/**
 * PRODUCT METAFIELD DEFINITIONS — discover all product metafield definitions.
 *
 * Unlike `translatableResource.translatableContent` (which only surfaces
 * metafields that are translatable), this lists EVERY product metafield
 * definition in the shop, including third-party app ones.
 *
 * Translatability is gated by STOREFRONT ACCESS, not a capability: a metafield
 * is translatable iff its definition's `access.storefront == PUBLIC_READ`
 * (Shopify: "you can translate metafields only if they are publicly
 * accessible"). There is NO `capabilities.translatable` for metafields — that
 * exists only for metaobjects. To make a shop-owned definition translatable we
 * set `access.storefront = PUBLIC_READ` via `metafieldDefinitionUpdate`.
 */
export const GET_PRODUCT_METAFIELD_DEFINITIONS = `#graphql
  query getProductMetafieldDefinitions($first: Int!, $after: String) {
    metafieldDefinitions(ownerType: PRODUCT, first: $first, after: $after) {
      edges {
        node {
          id
          namespace
          key
          name
          description
          ownerType
          type {
            name
          }
          access {
            storefront
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const GET_MENUS = `#graphql
  query getMenus($first: Int!) {
    menus(first: $first) {
      edges {
        node {
          id
          handle
          title
          items {
            id
            title
            url
            type
            items {
              id
              title
              url
              type
              items {
                id
                title
                url
                type
                items {
                  id
                  title
                  url
                  type
                  items {
                    id
                    title
                    url
                    type
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

export const GET_THEMES = `#graphql
  query getThemes($first: Int!) {
    themes(first: $first) {
      edges {
        node {
          id
          name
          role
          themeStoreId
          createdAt
          updatedAt
        }
      }
    }
  }
`;

export const GET_THEME_FILES = `#graphql
  query getThemeFiles($themeId: ID!, $filenames: [String!]!) {
    theme(id: $themeId) {
      files(filenames: $filenames, first: 250) {
        nodes {
          filename
          body {
            ... on OnlineStoreThemeFileBodyText {
              content
            }
          }
        }
      }
    }
  }
`;

export const GET_METAOBJECT_DEFINITIONS = `#graphql
  query getMetaobjectDefinitions($first: Int!) {
    metaobjectDefinitions(first: $first) {
      edges {
        node {
          id
          name
          type
          fieldDefinitions {
            name
            key
            type {
              name
            }
          }
        }
      }
    }
  }
`;

export const GET_METAOBJECTS = `#graphql
  query getMetaobjects($type: String!, $first: Int!) {
    metaobjects(type: $type, first: $first) {
      edges {
        node {
          id
          handle
          displayName
          type
          updatedAt
        }
      }
    }
  }
`;

export const GET_THEME_TRANSLATABLE_RESOURCES = `#graphql
  query getThemeTranslatableResources($first: Int!, $resourceType: TranslatableResourceType!, $after: String) {
    translatableResources(
      first: $first
      resourceType: $resourceType
      after: $after
    ) {
      edges {
        cursor
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
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const GET_THEME_TRANSLATIONS = `#graphql
  query getThemeTranslations($resourceId: ID!, $locale: String!) {
    translatableResource(resourceId: $resourceId) {
      resourceId
      translatableContent {
        key
        value
        digest
        locale
      }
      translations(locale: $locale) {
        key
        value
        locale
        outdated
      }
    }
  }
`;
