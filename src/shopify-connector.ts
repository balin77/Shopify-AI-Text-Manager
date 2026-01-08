import '@shopify/shopify-api/adapters/node';
import { shopifyApi, Session, ApiVersion } from '@shopify/shopify-api';
import dotenv from 'dotenv';

dotenv.config();

export interface ShopifyConfig {
  shopName: string;
  accessToken: string;
  apiVersion?: string;
}

export class ShopifyConnector {
  private shopify;
  private session: Session;
  private shopName: string;
  private accessToken: string;
  private apiVersion: string;

  constructor(config?: ShopifyConfig) {
    const shopName = config?.shopName || process.env.SHOPIFY_SHOP_NAME;
    const accessToken = config?.accessToken || process.env.SHOPIFY_ACCESS_TOKEN;
    const apiVersion = config?.apiVersion || process.env.SHOPIFY_API_VERSION || '2025-01';
    const apiKey = process.env.SHOPIFY_API_KEY || 'not-needed-for-admin-api';
    const apiSecret = process.env.SHOPIFY_API_SECRET || 'not-needed-for-admin-api';

    if (!shopName || !accessToken) {
      throw new Error('Shopify shop name and access token are required');
    }

    // Normalize shop name
    const fullShopDomain = shopName.includes('.myshopify.com') ? shopName : `${shopName}.myshopify.com`;

    this.shopName = fullShopDomain;
    this.accessToken = accessToken;
    this.apiVersion = apiVersion;

    // Initialize Shopify API with OAuth credentials
    this.shopify = shopifyApi({
      apiKey: apiKey,
      apiSecretKey: apiSecret,
      scopes: process.env.SHOPIFY_SCOPES?.split(',') || ['read_products', 'write_products'],
      hostName: fullShopDomain.replace('https://', '').replace('http://', ''),
      apiVersion: apiVersion as ApiVersion,
      isEmbeddedApp: false,
    });

    // Create session manually for OAuth app
    this.session = new Session({
      id: `offline_${fullShopDomain}`,
      shop: fullShopDomain,
      state: 'test-state',
      isOnline: false,
      accessToken: accessToken,
    });
  }

  /**
   * Make a direct GraphQL request using fetch
   */
  private async graphqlRequest(query: string, variables?: any): Promise<any> {
    const url = `https://${this.shopName}/admin/api/${this.apiVersion}/graphql.json`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': this.accessToken,
      },
      body: JSON.stringify({
        query,
        variables,
      }),
    });

    if (!response.ok) {
      throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
    }

    const data: any = await response.json();

    if (data.errors) {
      throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
    }

    return data.data;
  }

  /**
   * Get the GraphQL client for making queries
   */
  getGraphQLClient() {
    return new this.shopify.clients.Graphql({ session: this.session });
  }

  /**
   * Get the REST client for making REST API calls
   */
  getRestClient() {
    return new this.shopify.clients.Rest({ session: this.session });
  }

  /**
   * Update product title
   */
  async updateProductTitle(productId: string, newTitle: string): Promise<any> {
    const mutation = `
      mutation updateProduct($input: ProductInput!) {
        productUpdate(input: $input) {
          product {
            id
            title
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    return await this.graphqlRequest(mutation, {
      input: {
        id: `gid://shopify/Product/${productId}`,
        title: newTitle,
      },
    });
  }

  /**
   * Update product metafields
   */
  async updateProductMetafield(
    productId: string,
    namespace: string,
    key: string,
    value: string,
    type: string = 'single_line_text_field'
  ): Promise<any> {
    const client = this.getGraphQLClient();

    const mutation = `
      mutation updateProductMetafield($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            namespace
            key
            value
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const response = await client.request(mutation, {
      variables: {
        metafields: [
          {
            ownerId: `gid://shopify/Product/${productId}`,
            namespace,
            key,
            value,
            type,
          },
        ],
      },
    });

    return response.data;
  }

  /**
   * Update product description
   */
  async updateProductDescription(productId: string, descriptionHtml: string): Promise<any> {
    const client = this.getGraphQLClient();

    const mutation = `
      mutation updateProduct($input: ProductInput!) {
        productUpdate(input: $input) {
          product {
            id
            descriptionHtml
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const response = await client.request(mutation, {
      variables: {
        input: {
          id: `gid://shopify/Product/${productId}`,
          descriptionHtml,
        },
      },
    });

    return response.data;
  }

  /**
   * Get product by ID
   */
  async getProduct(productId: string): Promise<any> {
    const client = this.getGraphQLClient();

    const query = `
      query getProduct($id: ID!) {
        product(id: $id) {
          id
          title
          descriptionHtml
          handle
          productType
          tags
          vendor
          metafields(first: 20) {
            edges {
              node {
                id
                namespace
                key
                value
              }
            }
          }
        }
      }
    `;

    const response = await client.request(query, {
      variables: {
        id: `gid://shopify/Product/${productId}`,
      },
    });

    return response.data;
  }

  /**
   * Get all products with pagination
   */
  async getAllProducts(limit: number = 50): Promise<any> {
    const query = `
      query getProducts($first: Int!) {
        products(first: $first) {
          edges {
            node {
              id
              title
              handle
              productType
              tags
              vendor
              featuredImage {
                url
                altText
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

    return await this.graphqlRequest(query, {
      first: limit,
    });
  }

  /**
   * Update product translations (for Shopify markets)
   */
  async updateProductTranslation(
    productId: string,
    locale: string,
    field: string,
    value: string
  ): Promise<any> {
    const client = this.getGraphQLClient();

    const mutation = `
      mutation updateTranslation($resourceId: ID!, $translations: [TranslationInput!]!) {
        translationsRegister(resourceId: $resourceId, translations: $translations) {
          translations {
            locale
            key
            value
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const response = await client.request(mutation, {
      variables: {
        resourceId: `gid://shopify/Product/${productId}`,
        translations: [
          {
            locale,
            key: field,
            value,
          },
        ],
      },
    });

    return response.data;
  }

  /**
   * Execute custom GraphQL query
   */
  async executeQuery(query: string, variables?: any): Promise<any> {
    const client = this.getGraphQLClient();
    const response = await client.request(query, { variables });
    return response.data;
  }

  /**
   * Execute custom GraphQL mutation
   */
  async executeMutation(mutation: string, variables?: any): Promise<any> {
    const client = this.getGraphQLClient();
    const response = await client.request(mutation, { variables });
    return response.data;
  }
}
