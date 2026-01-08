# 🏛️ Architektur-Übersicht

## System-Diagramm

```
┌─────────────────────────────────────────────────────────────────┐
│                         Frontend (Browser)                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌──────────────────┐   ┌──────────────────┐                   │
│  │   index.html     │   │   app.js/main.js │                   │
│  │  (UI Structure)  │◄──│  (Application)    │                   │
│  └──────────────────┘   └────────┬─────────┘                   │
│                                   │                              │
│  ┌────────────────────────────────▼────────────────┐            │
│  │            JavaScript Modules                    │            │
│  ├──────────────────────────────────────────────────┤            │
│  │                                                   │            │
│  │  ┌─────────────┐  ┌──────────────┐             │            │
│  │  │   State     │  │  Components  │             │            │
│  │  │ Management  │  │              │             │            │
│  │  │             │  │ - Modal      │             │            │
│  │  │ - AppState  │  │ - ProductList│             │            │
│  │  └─────────────┘  └──────────────┘             │            │
│  │                                                   │            │
│  │  ┌─────────────┐  ┌──────────────┐             │            │
│  │  │  Services   │  │   Utils      │             │            │
│  │  │             │  │              │             │            │
│  │  │ - API       │  │ - Helpers    │             │            │
│  │  │   Service   │  │ - Validators │             │            │
│  │  └──────┬──────┘  └──────────────┘             │            │
│  │         │                                        │            │
│  └─────────┼────────────────────────────────────────┘            │
│            │                                                      │
└────────────┼──────────────────────────────────────────────────────┘
             │ HTTP/REST API
             │
┌────────────▼──────────────────────────────────────────────────────┐
│                      Backend (Node.js/Express)                     │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ┌────────────────────────────────────────────────────┐          │
│  │                 server.ts (Express)                 │          │
│  │              (API Routes & Middleware)              │          │
│  └────────────────────┬───────────────────────────────┘          │
│                       │                                            │
│  ┌────────────────────▼───────────────────────────────┐          │
│  │              Service Layer (Business Logic)         │          │
│  ├────────────────────────────────────────────────────┤          │
│  │                                                     │          │
│  │  ┌────────────────┐  ┌──────────────────────┐    │          │
│  │  │ ProductService │  │ TranslationService   │    │          │
│  │  │                │  │                      │    │          │
│  │  │ - getAllProducts│  │ - getTranslations   │    │          │
│  │  │ - getDetails   │  │ - saveTranslation   │    │          │
│  │  │ - updateProduct│  │                      │    │          │
│  │  │ - calcSEOScore │  │                      │    │          │
│  │  └────────┬───────┘  └────────┬─────────────┘    │          │
│  │           │                     │                  │          │
│  │  ┌────────▼─────────────────────▼──┐             │          │
│  │  │        AIService                 │             │          │
│  │  │                                  │             │          │
│  │  │ - generateSEO (multi-provider)  │             │          │
│  │  │ - translateContent              │             │          │
│  │  │                                  │             │          │
│  │  │ Providers: HuggingFace, Gemini, │             │          │
│  │  │           Claude, OpenAI        │             │          │
│  │  └─────────────────┬────────────────┘             │          │
│  │                    │                               │          │
│  └────────────────────┼───────────────────────────────┘          │
│                       │                                            │
│  ┌────────────────────▼───────────────────────────────┐          │
│  │          ShopifyConnector (API Client)             │          │
│  │                                                     │          │
│  │  - executeQuery (GraphQL)                          │          │
│  │  - executeMutation (GraphQL)                       │          │
│  │  - OAuth handling                                  │          │
│  └────────────────────┬───────────────────────────────┘          │
│                       │                                            │
└───────────────────────┼────────────────────────────────────────────┘
                        │ GraphQL API
                        │
┌───────────────────────▼────────────────────────────────────────────┐
│                      Shopify API                                    │
│                   (External Service)                                │
└─────────────────────────────────────────────────────────────────────┘
```

## 🔄 Request Flow

### Beispiel: Produkt laden

```
1. User clicks Product
   │
   ▼
2. Frontend: productController.selectProduct(id)
   │
   ▼
3. Check: hasUnsavedChanges?
   │
   ├─ Yes → Show Modal
   └─ No  → Continue
   │
   ▼
4. Frontend: apiService.getProduct(id)
   │
   ▼ HTTP GET /api/products/:id
   │
5. Backend: server.ts Route Handler
   │
   ▼
6. Backend: productService.getProductDetails(id)
   │
   ├─ Calls: connector.executeQuery(graphql)
   ├─ Calls: productService.calculateSEOScore()
   │
   ▼
7. Backend: translationService.getTranslations(id, locales)
   │
   ▼ GraphQL to Shopify
   │
8. Shopify API returns data
   │
   ▼
9. Backend: Formats & returns JSON
   │
   ▼ HTTP Response
   │
10. Frontend: Updates appState
    │
    ▼
11. Frontend: renderProductDetail()
    │
    ▼
12. User sees Product Details
```

## 📦 Daten-Flow

### State Management

```
┌─────────────────────────────────────────────────┐
│              AppState (Central)                  │
├─────────────────────────────────────────────────┤
│                                                  │
│  products: []                                   │
│  selectedProduct: null                          │
│  currentLanguage: 'de'                          │
│  productTranslations: {}                        │
│  hasUnsavedChanges: false                       │
│  originalData: {}                               │
│                                                  │
│  ┌────────────────────────────────┐            │
│  │      Pub/Sub Pattern           │            │
│  ├────────────────────────────────┤            │
│  │                                 │            │
│  │  subscribe('products', fn)     │            │
│  │  setProducts(data) → notify    │            │
│  │                                 │            │
│  └────────────────────────────────┘            │
│                                                  │
└──────────────┬───────────────────────────────────┘
               │
               ▼
     ┌─────────────────────┐
     │   UI Components     │
     │   auto-update       │
     └─────────────────────┘
```

### Beispiel: SEO mit KI optimieren

```
User Action: Click "SEO mit KI optimieren"
     │
     ▼
Frontend: suggestSEO()
     │
     ▼
API Call: POST /api/products/:id/suggest-seo
     │
     ▼
Backend: server.ts → aiService.generateSEO()
     │
     ├─ Get product data
     ├─ Format prompt
     ├─ Call AI Provider (HuggingFace/Gemini/etc)
     │
     ▼
AI Response: { seoTitle, metaDescription, reasoning }
     │
     ▼
Backend: Parse & validate response
     │
     ▼
Frontend: currentSuggestion = response.suggestion
     │
     ▼
Frontend: renderSuggestion()
     │
     ▼
User sees: Editable suggestion with reasoning
     │
     ▼
User: Edits + Clicks "Akzeptieren"
     │
     ▼
Frontend: acceptSuggestion()
     │
     ├─ POST /api/products/:id/apply-seo
     └─ POST /api/products/:id/translate
     │
     ▼
Backend:
     ├─ productService.updateProduct()
     └─ translationService.saveTranslation() (für jede Sprache)
     │
     ▼
Shopify: Updates via GraphQL mutations
     │
     ▼
Success: Product updated + translated!
```

## 🔐 Security Flow

```
User Request
     │
     ▼
[Environment Variables]
  ├─ SHOPIFY_ACCESS_TOKEN
  ├─ HUGGINGFACE_API_KEY
  └─ AI_PROVIDER
     │
     ▼
[ShopifyConnector]
  - Validates token
  - Adds auth headers
     │
     ▼
[Shopify API]
  - OAuth validation
  - Returns data
```

## 🎯 Separation of Concerns

### Backend

```
┌────────────────────────────────────────┐
│ Layer 1: Routes (server.ts)           │
│ - HTTP handling                        │
│ - Request validation                   │
│ - Response formatting                  │
└──────────────┬─────────────────────────┘
               │
┌──────────────▼─────────────────────────┐
│ Layer 2: Services                      │
│ - Business logic                       │
│ - Data transformation                  │
│ - External API calls                   │
└──────────────┬─────────────────────────┘
               │
┌──────────────▼─────────────────────────┐
│ Layer 3: Connectors                    │
│ - Shopify API communication            │
│ - GraphQL queries/mutations            │
│ - OAuth handling                       │
└────────────────────────────────────────┘
```

### Frontend

```
┌────────────────────────────────────────┐
│ Layer 1: UI (index.html + Components) │
│ - User interaction                     │
│ - Visual rendering                     │
└──────────────┬─────────────────────────┘
               │
┌──────────────▼─────────────────────────┐
│ Layer 2: Controllers/Logic             │
│ - Event handling                       │
│ - State management                     │
│ - Validation                           │
└──────────────┬─────────────────────────┘
               │
┌──────────────▼─────────────────────────┐
│ Layer 3: Services                      │
│ - API communication                    │
│ - Data transformation                  │
└────────────────────────────────────────┘
```

## 🧩 Module Dependencies

```
┌─────────────────────────────────────────────────┐
│              External Dependencies              │
├─────────────────────────────────────────────────┤
│ @shopify/shopify-api                           │
│ @huggingface/inference                         │
│ @google/generative-ai                          │
│ express                                         │
└────────────────┬────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────┐
│           Our Custom Services                   │
├─────────────────────────────────────────────────┤
│ ProductService ─┐                              │
│                 ├─► ShopifyConnector            │
│ TranslationSvc ─┘                              │
│                                                 │
│ AIService ──────► Multiple AI Providers        │
└─────────────────────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────┐
│           Express Server                        │
│         (Composes services)                     │
└─────────────────────────────────────────────────┘
```

## 📊 Performance Considerations

### Caching Strategy (Future)

```
Request → Check Cache → Hit? → Return cached
                      ↓ Miss
                Fetch from API
                      ↓
                Store in Cache
                      ↓
                Return data
```

### Parallel Requests

```typescript
// ✅ Good: Parallel execution
const [product, translations] = await Promise.all([
  productService.getProductDetails(id),
  translationService.getTranslations(id, locales)
]);

// ❌ Bad: Sequential execution
const product = await productService.getProductDetails(id);
const translations = await translationService.getTranslations(id, locales);
```

## 🧪 Testing Strategy

```
┌─────────────────────────────────────┐
│       Unit Tests (Future)           │
├─────────────────────────────────────┤
│ - Test each service method          │
│ - Mock Shopify API                  │
│ - Test state management             │
└─────────────────────────────────────┘
         │
┌────────▼────────────────────────────┐
│    Integration Tests (Future)       │
├─────────────────────────────────────┤
│ - Test API endpoints                │
│ - Test service interactions         │
└─────────────────────────────────────┘
         │
┌────────▼────────────────────────────┐
│      E2E Tests (Future)             │
├─────────────────────────────────────┤
│ - Test complete user workflows      │
│ - Test UI interactions              │
└─────────────────────────────────────┘
```

## 🚀 Deployment

```
Development:
npm run web → tsx web-app/server.ts → Hot reload

Production:
npm run build → tsc → dist/
npm start → node dist/server.js → Optimized
```

## 💻 Code-Beispiele

### Backend: API-Endpoint mit Services

**Vorher (Monolithisch - ~50 Zeilen):**
```typescript
app.get('/api/products/:id', async (req, res) => {
  try {
    const productId = req.params.id;
    const query = `...`; // 30 Zeilen GraphQL
    const result = await connector.executeQuery(query, { id: productId });
    // 10 Zeilen Translation Query
    // 15 Zeilen SEO Calculation
    res.json({ ... });
  } catch (error) { ... }
});
```

**Nachher (Service-basiert - ~15 Zeilen):**
```typescript
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
```

### Backend: Services initialisieren

```typescript
import { ShopifyConnector } from '../src/shopify-connector';
import { ProductService } from '../src/services/product.service';
import { TranslationService } from '../src/services/translation.service';
import { AIService } from '../src/services/ai.service';

const connector = new ShopifyConnector();

// Initialize services
const productService = new ProductService(connector);
const translationService = new TranslationService(connector);
const aiService = new AIService(process.env.AI_PROVIDER as any || 'huggingface');
```

### Vorteile der Service-Architektur

**Code-Länge:**
- `server.ts`: Von 613 → 166 Zeilen (73% Reduktion)
- Jeder Endpoint: Von ~50 → ~15 Zeilen (70% Reduktion)

**Wartbarkeit:**
- ✅ Jeder Service hat eine klare Verantwortung
- ✅ GraphQL-Queries sind in den Services gekapselt
- ✅ Business-Logik ist wiederverwendbar
- ✅ Einfach zu testen (Services können gemockt werden)

**Erweiterbarkeit:**
- Neue Features = neuer Service oder Methode im bestehenden Service
- Keine Änderungen an bestehenden Endpoints nötig
- AI-Provider wechseln = nur Umgebungsvariable ändern

---

Diese Architektur ist:
- ✅ Skalierbar
- ✅ Wartbar
- ✅ Testbar
- ✅ Erweiterbar
- ✅ Type-Safe (Backend)
