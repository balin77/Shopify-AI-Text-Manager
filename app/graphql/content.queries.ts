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
  query getShopMetadata {
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
      metafields(first: 100) {
        edges {
          node {
            id
            namespace
            key
            value
            type
          }
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
