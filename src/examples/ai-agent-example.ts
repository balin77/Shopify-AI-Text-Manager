import { ShopifyConnector } from '../shopify-connector';

/**
 * This example demonstrates how an AI agent could use the Shopify Connector
 * to programmatically modify product content
 */

interface ProductUpdate {
  productId: string;
  title?: string;
  description?: string;
  metafields?: Array<{
    namespace: string;
    key: string;
    value: string;
    type?: string;
  }>;
}

export class AIShopifyAgent {
  private connector: ShopifyConnector;

  constructor(connector: ShopifyConnector) {
    this.connector = connector;
  }

  /**
   * Translate product content to another language
   */
  async translateProduct(
    productId: string,
    targetLocale: string,
    translatedTitle: string,
    translatedDescription: string
  ) {
    console.log(`Translating product ${productId} to ${targetLocale}...`);

    try {
      // Update product title translation
      await this.connector.updateProductTranslation(
        productId,
        targetLocale,
        'title',
        translatedTitle
      );

      // Update product description translation
      await this.connector.updateProductTranslation(
        productId,
        targetLocale,
        'description',
        translatedDescription
      );

      console.log(`Successfully translated product ${productId}`);
      return { success: true };
    } catch (error) {
      console.error('Translation failed:', error);
      return { success: false, error };
    }
  }

  /**
   * Optimize product SEO metadata
   */
  async optimizeProductSEO(
    productId: string,
    seoTitle: string,
    seoDescription: string,
    keywords: string[]
  ) {
    console.log(`Optimizing SEO for product ${productId}...`);

    try {
      // Update SEO title metafield
      await this.connector.updateProductMetafield(
        productId,
        'global',
        'title_tag',
        seoTitle,
        'single_line_text_field'
      );

      // Update SEO description metafield
      await this.connector.updateProductMetafield(
        productId,
        'global',
        'description_tag',
        seoDescription,
        'multi_line_text_field'
      );

      // Update keywords metafield
      await this.connector.updateProductMetafield(
        productId,
        'custom',
        'seo_keywords',
        keywords.join(','),
        'single_line_text_field'
      );

      console.log(`Successfully optimized SEO for product ${productId}`);
      return { success: true };
    } catch (error) {
      console.error('SEO optimization failed:', error);
      return { success: false, error };
    }
  }

  /**
   * Batch update multiple products
   */
  async batchUpdateProducts(updates: ProductUpdate[]) {
    console.log(`Updating ${updates.length} products...`);

    const results = [];

    for (const update of updates) {
      try {
        // Update title if provided
        if (update.title) {
          await this.connector.updateProductTitle(update.productId, update.title);
        }

        // Update description if provided
        if (update.description) {
          await this.connector.updateProductDescription(update.productId, update.description);
        }

        // Update metafields if provided
        if (update.metafields) {
          for (const metafield of update.metafields) {
            await this.connector.updateProductMetafield(
              update.productId,
              metafield.namespace,
              metafield.key,
              metafield.value,
              metafield.type
            );
          }
        }

        results.push({ productId: update.productId, success: true });
        console.log(`Successfully updated product ${update.productId}`);
      } catch (error) {
        results.push({ productId: update.productId, success: false, error });
        console.error(`Failed to update product ${update.productId}:`, error);
      }
    }

    return results;
  }

  /**
   * Enhance product description with AI-generated content
   */
  async enhanceProductDescription(
    productId: string,
    enhancedDescription: string,
    addBulletPoints: boolean = true
  ) {
    console.log(`Enhancing description for product ${productId}...`);

    try {
      // Get current product data
      const productData = await this.connector.getProduct(productId);
      const currentDescription = productData.product.descriptionHtml;

      // Combine or replace description
      let finalDescription = enhancedDescription;

      if (addBulletPoints) {
        finalDescription = `
          ${enhancedDescription}
          <h3>Key Features:</h3>
          <ul>
            <li>High quality materials</li>
            <li>Durable construction</li>
            <li>Easy to use</li>
          </ul>
        `;
      }

      // Update the description
      await this.connector.updateProductDescription(productId, finalDescription);

      console.log(`Successfully enhanced description for product ${productId}`);
      return { success: true, oldDescription: currentDescription };
    } catch (error) {
      console.error('Description enhancement failed:', error);
      return { success: false, error };
    }
  }

  /**
   * Smart product analysis - Get product data for AI processing
   */
  async analyzeProduct(productId: string) {
    console.log(`Analyzing product ${productId}...`);

    try {
      const productData = await this.connector.getProduct(productId);
      const product = productData.product;

      const analysis = {
        id: product.id,
        title: product.title,
        descriptionLength: product.descriptionHtml?.length || 0,
        hasMetafields: product.metafields.edges.length > 0,
        tags: product.tags,
        productType: product.productType,
        vendor: product.vendor,
        metafields: product.metafields.edges.map((edge: any) => ({
          namespace: edge.node.namespace,
          key: edge.node.key,
          value: edge.node.value,
        })),
      };

      console.log('Product analysis:', analysis);
      return analysis;
    } catch (error) {
      console.error('Product analysis failed:', error);
      return null;
    }
  }
}

// Example usage
async function runAIAgentExample() {
  try {
    // Initialize connector
    const connector = new ShopifyConnector();
    const agent = new AIShopifyAgent(connector);

    console.log('AI Agent initialized!');
    console.log('');

    // Example: Analyze a product (replace with your product ID)
    // const analysis = await agent.analyzeProduct('1234567890');
    // console.log('Analysis result:', analysis);

    // Example: Translate a product
    // await agent.translateProduct(
    //   '1234567890',
    //   'de',
    //   'Übersetzter Produkttitel',
    //   'Übersetzte Produktbeschreibung'
    // );

    // Example: Optimize SEO
    // await agent.optimizeProductSEO(
    //   '1234567890',
    //   'Amazing Product - Buy Now',
    //   'This is an amazing product that will change your life',
    //   ['amazing', 'product', 'quality']
    // );

    // Example: Batch update
    // const updates: ProductUpdate[] = [
    //   {
    //     productId: '1234567890',
    //     title: 'New Title 1',
    //     description: '<p>New description 1</p>',
    //   },
    //   {
    //     productId: '0987654321',
    //     title: 'New Title 2',
    //   },
    // ];
    // const results = await agent.batchUpdateProducts(updates);
    // console.log('Batch update results:', results);

    console.log('Examples completed!');
  } catch (error) {
    console.error('Error:', error);
  }
}

// Run if executed directly
if (require.main === module) {
  runAIAgentExample();
}

export { runAIAgentExample };
