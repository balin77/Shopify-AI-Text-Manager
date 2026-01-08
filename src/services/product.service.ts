import { ShopifyConnector } from '../shopify-connector';

export class ProductService {
  constructor(private connector: ShopifyConnector) {}

  async getAllProducts(limit: number = 250) {
    const result = await this.connector.getAllProducts(limit);
    return result.products.edges.map((edge: any) => ({
      id: edge.node.id,
      title: edge.node.title,
      handle: edge.node.handle,
      productType: edge.node.productType,
      tags: edge.node.tags,
      featuredImage: edge.node.featuredImage?.url || null,
    }));
  }

  async getProductDetails(productId: string) {
    const query = `
      query getProductSEO($id: ID!) {
        product(id: $id) {
          id
          title
          descriptionHtml
          handle
          seo {
            title
            description
          }
          metafields(first: 50) {
            edges {
              node {
                namespace
                key
                value
              }
            }
          }
          images(first: 10) {
            edges {
              node {
                altText
              }
            }
          }
        }
      }
    `;

    const result = await this.connector.executeQuery(query, { id: productId });
    return result.product;
  }

  async updateProduct(productId: string, data: {
    title?: string;
    descriptionHtml?: string;
    handle?: string;
    seoTitle?: string;
    metaDescription?: string;
  }) {
    const updateMutation = `
      mutation updateProduct($input: ProductInput!) {
        productUpdate(input: $input) {
          product {
            id
            title
            descriptionHtml
            handle
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

    const input: any = { id: productId };

    if (data.title) input.title = data.title;
    if (data.descriptionHtml) input.descriptionHtml = data.descriptionHtml;
    if (data.handle) input.handle = data.handle;

    if (data.seoTitle || data.metaDescription) {
      input.seo = {};
      if (data.seoTitle) input.seo.title = data.seoTitle;
      if (data.metaDescription) input.seo.description = data.metaDescription;
    }

    const result = await this.connector.executeMutation(updateMutation, { input });

    if (result.productUpdate.userErrors.length > 0) {
      throw new Error(result.productUpdate.userErrors[0].message);
    }

    return result.productUpdate.product;
  }

  calculateSEOScore(product: any) {
    const descriptionText = product.descriptionHtml.replace(/<[^>]*>/g, '').trim();
    let score = 0;
    const issues: string[] = [];

    // Title length
    if (product.title.length >= 30 && product.title.length <= 70) {
      score += 15;
    } else {
      issues.push('Titel-Länge optimieren (30-70 Zeichen)');
    }

    // SEO Title
    if (product.seo.title && product.seo.title.length <= 60) {
      score += 15;
    } else {
      issues.push('SEO-Titel setzen/optimieren (max. 60 Zeichen)');
    }

    // Description length
    if (descriptionText.length >= 150) {
      score += 20;
    } else {
      issues.push('Beschreibung erweitern (mind. 150 Zeichen)');
    }

    // Meta description
    if (
      product.seo.description &&
      product.seo.description.length >= 120 &&
      product.seo.description.length <= 160
    ) {
      score += 20;
    } else {
      issues.push('Meta-Description optimieren (120-160 Zeichen)');
    }

    // Image alt texts
    const imagesWithoutAlt = product.images.edges.filter((e: any) => !e.node.altText).length;
    if (imagesWithoutAlt === 0) {
      score += 30;
    } else {
      issues.push(`${imagesWithoutAlt} Bilder ohne Alt-Text`);
    }

    return { score, issues };
  }
}
