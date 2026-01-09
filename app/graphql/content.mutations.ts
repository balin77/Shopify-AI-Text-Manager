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

export const UPDATE_PAGE = `#graphql
  mutation updatePage($id: ID!, $page: PageInput!) {
    pageUpdate(id: $id, page: $page) {
      page {
        id
        title
        handle
        body
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
      }
      userErrors {
        field
        message
      }
    }
  }
`;
