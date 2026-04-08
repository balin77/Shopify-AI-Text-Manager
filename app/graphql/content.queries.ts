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
  query getTranslations($resourceId: ID!, $locale: String!) {
    translatableResource(resourceId: $resourceId) {
      translations(locale: $locale) {
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

/**
 * Fetch all menu translatable resources with nested link resources.
 *
 * Uses Shopify's `translatableResources(resourceType: MENU)` to discover
 * menus as translatable resources, and `nestedTranslatableResources(resourceType: LINK)`
 * to discover individual menu items (links) that can be translated.
 *
 * Each link is a separate translatable resource with its own resourceId and digest.
 */
export const GET_MENU_TRANSLATABLE_RESOURCES = `#graphql
  query getMenuTranslatableResources($first: Int!) {
    translatableResources(first: $first, resourceType: MENU) {
      edges {
        node {
          resourceId
          translatableContent {
            key
            value
            digest
            locale
          }
          nestedTranslatableResources(first: 250, resourceType: LINK) {
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
