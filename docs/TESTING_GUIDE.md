# 🧪 Testing Guide für ContentPilot

## 📋 Problem: Railway + Shopify App + Dummy Keys

**Herausforderung**: Du entwickelst eine Shopify App, die auf Railway deployed ist. Lokal verwendest du Dummy-API-Keys aus Sicherheitsgründen. Wie kannst du trotzdem umfassend testen?

**Lösung**: Multi-Layer Testing-Strategie **ohne echte APIs**.

---

## ✅ Was JETZT schon funktioniert (lokal, ohne echte APIs)

### 1. **Unit Tests mit vollständigen Mocks**

```bash
# Alle Tests ausführen (schnell: <2s)
npm run test

# Nur ProductSync-Tests
npm run test -- tests/unit/product-sync.service.test.ts

# Mit Coverage-Report
npm run test:coverage
```

**Beispiel-Output:**
```
✓ tests/unit/product-sync.service.test.ts (11 tests) 21ms
  ✓ sollte ein Produkt mit allen Daten synchronisieren
  ✓ sollte Bilder mit MediaIds speichern
  ✓ sollte Image Alt-Text Übersetzungen speichern
  ✓ sollte Translations korrekt filtern
  ✓ sollte User-Modifications von Alt-Texten bewahren
  ... (6 weitere)

Test Files  1 passed (1)
     Tests  11 passed (11)
  Duration  611ms
```

**✅ Keine echten API-Keys nötig!**

---

## 🎯 Was wird getestet?

### **Aktuelle Test-Coverage (Phase 1)**

| Service/Komponente | Tests | Status | Benötigt echte APIs? |
|-------------------|-------|--------|---------------------|
| **ProductSyncService** | 11 | ✅ Alle bestanden | ❌ Nein (gemockt) |
| **AIQueueService** | 13 | ⚠️ 8/13 bestanden | ❌ Nein (gemockt) |
| **AIService** | 4 | ✅ Vorhanden | ❌ Nein (gemockt) |
| **Encryption** | 2 | ✅ Vorhanden | ❌ Nein |
| **Sample Tests** | 1 | ✅ Vorhanden | ❌ Nein |

**Total: 31 Tests** (29 bestanden, 2 timing-bedingte Fails)

---

## 🔐 Sicherheit: API-Keys in Tests

### ✅ **RICHTIG**: Alles mocken

```typescript
// tests/unit/product-sync.service.test.ts
import { createMockShopifyAdmin } from '../mocks/shopify-graphql.mock';

const mockAdmin = createMockShopifyAdmin(); // Gibt vorgefertigte Responses zurück
// Kein echter API-Call an Shopify!

const service = new ProductSyncService(mockAdmin, 'test-shop.myshopify.com');
await service.syncProduct('gid://shopify/Product/123');

// Verifiziere: Wurde der richtige GraphQL-Query aufgerufen?
expect(mockAdmin.graphql).toHaveBeenCalledWith(
  expect.stringContaining('query getProduct'),
  { variables: { id: 'gid://shopify/Product/123' } }
);
```

### ❌ **FALSCH**: Echte Keys verwenden

```typescript
// ❌ NICHT MACHEN!
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
```

**Grund**: Keys könnten versehentlich in Git landen oder in Logs auftauchen.

---

## 📦 Mock-Factories

### Verfügbare Mocks (bereits erstellt)

#### 1. **AI Provider Mocks** ([tests/mocks/ai-provider.mock.ts](../tests/mocks/ai-provider.mock.ts))

```typescript
import { createMockAIService, mockAIResponses } from '../mocks/ai-provider.mock';

const mockAI = createMockAIService();

// Simulate AI SEO generation (instant, no API call)
const result = await mockAI.generateSEO('Product Title', 'Description', 'en');

console.log(result);
// {
//   seoTitle: 'Premium Leather Wallet - RFID Protection',
//   metaDescription: '...',
//   reasoning: 'Optimized for search...'
// }
```

**Unterstützt alle 6 Provider:**
- HuggingFace
- Google Gemini
- Anthropic Claude
- OpenAI
- Grok
- DeepSeek

#### 2. **Shopify GraphQL Mocks** ([tests/mocks/shopify-graphql.mock.ts](../tests/mocks/shopify-graphql.mock.ts))

```typescript
import { createMockShopifyAdmin, mockShopifyProduct } from '../mocks/shopify-graphql.mock';

const mockAdmin = createMockShopifyAdmin();

// Simulate Shopify Product Query
const response = await mockAdmin.graphql(`
  query getProduct($id: ID!) {
    product(id: $id) { id title handle }
  }
`, { variables: { id: 'gid://shopify/Product/123' } });

const data = await response.json();
console.log(data.data.product);
// {
//   id: 'gid://shopify/Product/123456789',
//   title: 'Premium Leather Wallet',
//   handle: 'premium-leather-wallet',
//   ...
// }
```

**Unterstützt Queries:**
- Products (inkl. Media, Options, Metafields)
- Collections
- Shop Locales
- Translatable Content
- Translation Mutations

#### 3. **Test Database Helper** ([tests/helpers/test-database.ts](../tests/helpers/test-database.ts))

```typescript
import { setupTestDatabase, createTestFixtures, getTestDb } from '../helpers/test-database';

beforeEach(async () => {
  await setupTestDatabase(); // In-Memory SQLite
  await createTestFixtures(); // Test-Produkt + Übersetzungen
});

it('sollte Produkt aus DB laden', async () => {
  const db = getTestDb();
  const product = await db.product.findFirst();

  expect(product.title).toBe('Test Product');
});
```

**✅ Kein echtes PostgreSQL nötig!** (SQLite In-Memory für schnelle Tests)

---

## 🚀 Lokale Entwicklung: Workflow

### **Schritt 1: Code schreiben**

```bash
# Development-Server starten (mit Dummy-Keys in .env)
npm run dev
```

### **Schritt 2: Tests schreiben**

```typescript
// tests/unit/my-new-feature.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createMockShopifyAdmin } from '../mocks/shopify-graphql.mock';

describe('MyNewFeature', () => {
  it('sollte X tun wenn Y', async () => {
    const mockAdmin = createMockShopifyAdmin();
    // ... Test-Logik
  });
});
```

### **Schritt 3: Tests lokal ausführen**

```bash
# Watch-Mode (re-runs on file changes)
npm run test:watch

# Oder: Einmal ausführen
npm run test
```

**✅ Alles lokal, keine echten API-Calls!**

### **Schritt 4: Coverage prüfen**

```bash
npm run test:coverage
```

**Output:**
```
File                           | % Stmts | % Branch | % Funcs | % Lines
-------------------------------|---------|----------|---------|--------
src/services/ai.service.ts     |   XX.XX |    XX.XX |   XX.XX |   XX.XX
src/services/product-sync.service.ts | XX.XX | XX.XX | XX.XX | XX.XX
-------------------------------|---------|----------|---------|--------
All files                      |   XX.XX |    XX.XX |   XX.XX |   XX.XX
```

**Ziel**: 70% Coverage für kritische Services

---

## 🌐 CI/CD: Railway + GitHub Actions (Optional)

### **GitHub Actions Workflow** (zukünftig)

```yaml
# .github/workflows/test.yml
name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Run tests
        run: npm run test:coverage
        env:
          DATABASE_URL: postgresql://localhost:5432/test_db
          SHOPIFY_API_KEY: ${{ secrets.TEST_SHOPIFY_API_KEY }}
          SHOPIFY_API_SECRET: ${{ secrets.TEST_SHOPIFY_API_SECRET }}

      - name: Upload coverage to Codecov
        uses: codecov/codecov-action@v3
        with:
          files: ./coverage/coverage-final.json
```

**✅ Test-API-Keys in GitHub Secrets** (separate von Production!)

### **Railway Deployment**

```bash
# Railway verwendet Production-Keys aus Environment Variables
railway up

# Tests laufen NICHT auf Railway (nur GitHub Actions oder lokal)
```

---

## 🧩 Test-Struktur verstehen

### **Anatomie eines Tests**

```typescript
// tests/unit/example.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MyService } from '~/services/my-service';
import { createMockShopifyAdmin } from '../mocks/shopify-graphql.mock';

// Mock externe Dependencies
vi.mock('~/db.server', () => ({
  db: {
    product: {
      findMany: vi.fn().mockResolvedValue([])
    }
  }
}));

describe('MyService', () => {
  let service: MyService;
  let mockAdmin: any;

  beforeEach(() => {
    vi.clearAllMocks(); // Reset Mocks vor jedem Test
    mockAdmin = createMockShopifyAdmin();
    service = new MyService(mockAdmin, 'test-shop.myshopify.com');
  });

  it('sollte Produkte synchronisieren', async () => {
    // ARRANGE: Setup
    const productId = 'gid://shopify/Product/123';

    // ACT: Aktion ausführen
    await service.syncProduct(productId);

    // ASSERT: Verifizieren
    expect(mockAdmin.graphql).toHaveBeenCalledWith(
      expect.stringContaining('query getProduct'),
      { variables: { id: productId } }
    );
  });

  it('sollte Fehler behandeln', async () => {
    // Mock einen Fehler
    mockAdmin.graphql = vi.fn().mockRejectedValue(new Error('Network error'));

    await expect(service.syncProduct('123')).rejects.toThrow('Network error');
  });
});
```

---

## 📊 Coverage-Ziele (Roadmap)

### **Phase 1: Critical Paths (JETZT)** - 40% Coverage
✅ AI Queue Service
✅ Product Sync Service
✅ AI Service
⬜ Translation Service
⬜ Content Sync Service

### **Phase 2: Business Logic** (2 Wochen) - 70% Coverage
⬜ Actions (Product, Unified Content)
⬜ GraphQL Mutations
⬜ Webhook Handlers
⬜ Task Recovery

### **Phase 3: Full Coverage** (Langfristig) - 85% Coverage
⬜ React Components
⬜ Edge Cases
⬜ E2E Critical Flows (mit Shopify Dev Store)

---

## 🐛 Troubleshooting

### **Problem: Test findet Module nicht**

```
Error: Failed to resolve import "~/services/..." from "tests/unit/..."
```

**Lösung**: Relativen Pfad verwenden
```typescript
// ❌ Falsch
import { MyService } from '~/services/my-service';

// ✅ Richtig (von tests/unit/ aus)
import { MyService } from '../../app/services/my-service';
```

### **Problem: DB-Mock funktioniert nicht**

```
TypeError: Cannot read properties of undefined (reading 'findMany')
```

**Lösung**: Mock-Return-Values hinzufügen
```typescript
const mockDb = {
  product: {
    findMany: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({ id: '123', title: 'Test' })
  }
};
```

### **Problem: Test ist zu langsam (>500ms)**

**Ursache**: Wahrscheinlich echter API-Call statt Mock

**Lösung**: Check `vi.mock()` Statements
```typescript
// Stelle sicher, dass ALLE externen Dependencies gemockt sind
vi.mock('~/db.server', () => ({ db: mockDb }));
vi.mock('~/utils/logger.server', () => ({ logger: mockLogger }));
vi.mock('@shopify/shopify-api', () => ({ ... }));
```

---

## 💡 Best Practices

### ✅ DOs

1. **Mock alle externen APIs** (Shopify, AI-Provider, DB)
2. **Tests isoliert halten** (keine Abhängigkeiten zwischen Tests)
3. **Verwende `beforeEach` für Setup** (Reset Mocks)
4. **Aussagekräftige Test-Namen** ("sollte X tun wenn Y")
5. **Coverage regelmäßig prüfen** (`npm run test:coverage`)

### ❌ DON'Ts

1. ❌ Echte API-Keys in Tests verwenden
2. ❌ Tests gegen Production-DB laufen lassen
3. ❌ Tests mit `it.skip()` überspringen (außer temporär)
4. ❌ `console.log()` in Tests lassen
5. ❌ Sehr lange Tests (>500ms) ohne guten Grund

---

## 🎓 Nächste Schritte

### **Für Einsteiger:**

1. **Lese existierende Tests:**
   - [tests/unit/encryption.test.ts](../tests/unit/encryption.test.ts)
   - [tests/unit/product-sync.service.test.ts](../tests/unit/product-sync.service.test.ts)

2. **Schreibe deinen ersten Test:**
   - Wähle eine einfache Utility-Funktion
   - Erstelle Test-Datei in `tests/unit/`
   - Verwende Mocks aus `tests/mocks/`

3. **Erweitere Coverage:**
   - Run `npm run test:coverage`
   - Finde Service mit <50% Coverage
   - Füge Tests hinzu

### **Für Fortgeschrittene:**

1. **Integration Tests schreiben:**
   - Verwende `test-database.ts` Helper
   - Teste komplette Workflows (z.B. Produkt erstellen → übersetzen → speichern)

2. **React Component Tests:**
   - Setup [@testing-library/react](https://testing-library.com/react)
   - Mocke Contexts (PlanContext, I18nContext)

3. **E2E Tests (optional):**
   - Setup Shopify Dev Store
   - Verwende separate Test-API-Keys
   - Nur für CI/CD

---

## 📚 Ressourcen

- [Vitest Docs](https://vitest.dev/)
- [React Testing Library](https://testing-library.com/react)
- [Test README](../tests/README.md)
- [Mock Factories](../tests/mocks/)

---

## ✅ Zusammenfassung

**Frage**: Wie teste ich lokal mit Dummy-Keys?

**Antwort**:
1. ✅ Verwende Mocks für alle externen APIs (Shopify, AI)
2. ✅ Teste Business-Logik isoliert
3. ✅ In-Memory SQLite statt echtem PostgreSQL
4. ✅ Keine echten API-Keys nötig (lokal)
5. ✅ CI/CD verwendet separate Test-Keys (optional)

**Status Quo**: 31 Tests, 29 bestanden, **ALLE lokal ohne echte APIs ausführbar! 🎉**

---

**Happy Testing! 🧪**
