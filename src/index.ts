import { ShopifyConnector } from './shopify-connector';

// Export the connector class
export { ShopifyConnector };

// Example usage
async function main() {
  try {
    // Initialize connector (uses .env file)
    const connector = new ShopifyConnector({
      shopName: process.env.SHOPIFY_SHOP_NAME || '',
      accessToken: process.env.SHOPIFY_ACCESS_TOKEN || '',
    });

    console.log('Shopify Connector initialized successfully!');
    console.log('');

    // Example 1: Get all products
    console.log('Fetching all products...');
    const products = await connector.getAllProducts(250);
    console.log(`Found ${products.products.edges.length} products`);
    console.log('');

    // Display all products
    console.log('Product List:');
    console.log('─'.repeat(80));
    products.products.edges.forEach((edge: any, index: number) => {
      const product = edge.node;
      console.log(`${index + 1}. ${product.title}`);
      console.log(`   ID: ${product.id}`);
      console.log(`   Handle: ${product.handle}`);
      console.log(`   Type: ${product.productType || 'N/A'}`);
      console.log(`   Tags: ${product.tags.join(', ') || 'N/A'}`);
      console.log('');
    });
    console.log('─'.repeat(80));

    // Example 2: Get a specific product (uncomment and replace with your product ID)
    // const productId = '1234567890';
    // const product = await connector.getProduct(productId);
    // console.log('Product details:', product.product);
    // console.log('');

    // Example 3: Update product title (uncomment and replace with your product ID)
    // const updatedProduct = await connector.updateProductTitle(
    //   '1234567890',
    //   'New Product Title'
    // );
    // console.log('Updated product:', updatedProduct);
    // console.log('');

    // Example 4: Update product metafield (uncomment and replace with your product ID)
    // const metafield = await connector.updateProductMetafield(
    //   '1234567890',
    //   'custom',
    //   'seo_description',
    //   'This is a custom SEO description'
    // );
    // console.log('Updated metafield:', metafield);
    // console.log('');

    // Example 5: Update product description (uncomment and replace with your product ID)
    // const description = await connector.updateProductDescription(
    //   '1234567890',
    //   '<p>This is the new product description with <strong>HTML</strong> formatting.</p>'
    // );
    // console.log('Updated description:', description);
    // console.log('');

    // Example 6: Custom GraphQL query
    // const customQuery = `
    //   query {
    //     shop {
    //       name
    //       email
    //       currencyCode
    //     }
    //   }
    // `;
    // const shopInfo = await connector.executeQuery(customQuery);
    // console.log('Shop info:', shopInfo);

  } catch (error) {
    console.error('Error:', error);
  }
}

// Run the example if this file is executed directly
if (require.main === module) {
  main();
}
