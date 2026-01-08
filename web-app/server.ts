import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { ShopifyConnector } from '../src/shopify-connector';

// Import new services
import { ProductService } from '../src/services/product.service';
import { TranslationService } from '../src/services/translation.service';
import { AIService } from '../src/services/ai.service';

dotenv.config();

const app = express();
const PORT = 3001;

// Serve static files from web-app directory
app.use(express.json());
app.use(express.static(path.resolve(process.cwd(), 'web-app')));

const connector = new ShopifyConnector();

// Initialize new services
const productService = new ProductService(connector);
const translationService = new TranslationService(connector);
const aiService = new AIService(process.env.AI_PROVIDER as any || 'huggingface');


// Get all products
app.get('/api/products', async (req, res) => {
  try {
    const products = await productService.getAllProducts(250);
    res.json({ success: true, products });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get product details including SEO
app.get('/api/products/:id', async (req, res) => {
  try {
    const productId = req.params.id;

    // Use services
    const product = await productService.getProductDetails(productId);
    const translations = await translationService.getTranslations(
      productId,
      ['en', 'fr', 'es', 'it']
    );
    const { score, issues } = productService.calculateSEOScore(product);

    res.json({
      success: true,
      product: { ...product, seoScore: score, seoIssues: issues },
      translations,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// AI SEO optimization suggestion
app.post('/api/products/:id/suggest-seo', async (req, res) => {
  try {
    const productId = req.params.id;
    const product = await productService.getProductDetails(productId);

    const suggestion = await aiService.generateSEO(
      product.title,
      product.descriptionHtml
    );

    res.json({ success: true, suggestion });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Apply SEO optimization
app.post('/api/products/:id/apply-seo', async (req, res) => {
  try {
    const productId = req.params.id;
    const { seoTitle, metaDescription } = req.body;

    await productService.updateProduct(productId, {
      seoTitle,
      metaDescription,
    });

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Translate product fields (selective translation)
app.post('/api/products/:id/translate', async (req, res) => {
  try {
    const productId = req.params.id;
    const changedFields = req.body; // Object with only changed fields

    // Generate translations using AI for changed fields only
    const translations = await aiService.translateFields(changedFields, ['en', 'fr', 'es', 'it']);

    // Save translations
    const results: any = {};
    for (const [locale, trans] of Object.entries(translations)) {
      try {
        await translationService.saveTranslation(productId, locale, trans as any);
        results[locale] = true;
      } catch (e) {
        results[locale] = false;
      }
    }

    res.json({ success: true, translations, results });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Save translation for a specific language
app.post('/api/products/:id/save-translation/:locale', async (req, res) => {
  try {
    const productId = req.params.id;
    const locale = req.params.locale;
    const { title, description, handle, seoTitle, metaDescription } = req.body;

    // If locale is 'de', update the product directly
    if (locale === 'de') {
      await productService.updateProduct(productId, {
        title,
        descriptionHtml: description,
        handle,
        seoTitle,
        metaDescription,
      });
    } else {
      // For other locales, use translations API
      await translationService.saveTranslation(productId, locale, {
        title,
        description,
        handle,
        seoTitle,
        metaDescription,
      });
    }

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Generate AI content for title or description
app.post('/api/products/:id/generate-ai-content', async (req, res) => {
  try {
    const productId = req.params.id;
    const { fieldType, currentValue, locale } = req.body;

    // Get product details for context
    const product = await productService.getProductDetails(productId);

    // Generate content based on field type
    const result = await aiService.generateContent(
      fieldType,
      currentValue,
      {
        productTitle: product.title,
        productDescription: product.descriptionHtml,
        productType: product.productType,
        locale
      }
    );

    res.json({
      success: true,
      generatedContent: result.content,
      reasoning: result.reasoning
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log('');
  console.log('🚀 Shopify SEO Optimizer läuft!');
  console.log('═'.repeat(60));
  console.log(`   URL: http://localhost:${PORT}`);
  console.log('');
  console.log('   Öffne diese URL in deinem Browser');
  console.log('═'.repeat(60));
  console.log('');
});
