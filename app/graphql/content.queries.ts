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
