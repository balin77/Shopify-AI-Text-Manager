# 🧪 Test-Suite für ContentPilot

Umfassende Tests **ohne** echte API-Keys oder Shopify-Installation.

## 📋 Übersicht

```
tests/
├── unit/                      # Unit Tests (schnell, isoliert)
│   ├── aiService.test.ts      # AI Provider Tests (gemockt)
│   ├── product-sync.service.test.ts  # Shopify Sync Tests (gemockt)
│   ├── ai-queue-service.test.ts      # Queue & Rate Limiting Tests
│   └── encryption.test.ts     # Sicherheits-Tests
├── integration/               # Integration Tests (lokale Services)
│   └── (zukünftig)
├── e2e/                       # End-to-End Tests (optional)
│   └── (nur für CI/CD)
├── mocks/                     # Mock-Factories
│   ├── ai-provider.mock.ts    # AI Response Mocks
│   └── shopify-graphql.mock.ts # Shopify API Mocks
├── helpers/                   # Test-Utilities
│   └── test-database.ts       # In-Memory DB Helper
├── setup.ts                   # Globale Test-Setup
└── README.md                  # Diese Datei
```

---

## 🚀 Schnellstart

### Alle Tests ausführen
```bash
npm run test
```

### Tests im Watch-Mode (Development)
```bash
npm run test:watch
```

### Coverage-Report generieren
```bash
npm run test:coverage
```

### Interaktive Test-UI
```bash
npm run test:ui
```

---

## 🎯 Test-Strategie

### ✅ Was wird getestet (OHNE echte APIs)

| Komponente | Test-Typ | Mock-Strategie |
|------------|----------|----------------|
| **AI Services** | Unit | Mock AI Provider SDKs (HuggingFace, Gemini, Claude, etc.) |
| **Shopify GraphQL** | Unit | Mock Admin Client mit vorgefertigten Responses |
| **Queue System** | Unit | In-Memory Queue, gemockte DB-Updates |
| **Database** | Integration | SQLite In-Memory (statt PostgreSQL) |
| **Actions** | Integration | Mocked AI + Shopify, echte Business-Logik |
| **Components** | Unit | React Testing Library mit Mocks |

---

## 📝 Beispiel: Neuen Test schreiben

### 1. Unit Test für Service

```typescript
// tests/unit/translation.service.test.ts
import { describe, it, expect, vi } from 'vitest';
import { TranslationService } from '~/../../src/services/translation.service';
import { createMockShopifyAdmin } from '../mocks/shopify-graphql.mock';
import { createMockAIService } from '../mocks/ai-provider.mock';

describe('TranslationService', () => {
  it('sollte Produkttitel übersetzen', async () => {
    const mockAdmin = createMockShopifyAdmin();
    const mockAI = createMockAIService();

    const service = new TranslationService(mockAdmin, 'test-shop.myshopify.com');

    const result = await service.translateProductTitle(
      'gid://shopify/Product/123',
      'en'
    );

    expect(result).toBeDefined();
    expect(mockAI.translateContent).toHaveBeenCalled();
  });
});
```

### 2. Integration Test mit Test-DB

```typescript
// tests/integration/product-workflow.test.ts
import { beforeEach, it, expect } from 'vitest';
import { setupTestDatabase, resetTestDatabase, createTestFixtures } from '../helpers/test-database';

beforeEach(async () => {
  await setupTestDatabase();
  await resetTestDatabase();
  await createTestFixtures();
});

it('sollte Produkt-Workflow komplett durchlaufen', async () => {
  // Test mit echter DB-Logik, aber gemockten APIs
});
```

---

## 🔧 Konfiguration

### Vitest Config ([vitest.config.ts](../vitest.config.ts))

```typescript
export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom', // Für React-Tests
    setupFiles: ['./tests/setup.ts'],
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://localhost:5432/shopify_test', // Wird für Unit-Tests gemockt
      SHOPIFY_API_KEY: 'test-api-key', // Dummy-Keys
      ENCRYPTION_KEY: 'test-encryption-key-32-chars!!',
    },
  },
});
```

**Wichtig**: Diese Dummy-Keys werden NUR für Tests verwendet und niemals committet.

---

## 🛡️ Sicherheit

### API-Keys im Test

✅ **Richtig**: Mock-Provider verwenden
```typescript
import { createMockAIService } from '../mocks/ai-provider.mock';

const mockAI = createMockAIService();
// Keine echten API-Keys nötig!
```

❌ **Falsch**: Echte API-Keys in .env.test
```bash
# ❌ NICHT MACHEN
ANTHROPIC_API_KEY=sk-ant-real-key-123
```

### Lokale vs. CI/CD

| Umgebung | Datenbank | API-Keys | Shopify |
|----------|-----------|----------|---------|
| **Lokal (Dev)** | SQLite In-Memory | Alle gemockt | Gemockt |
| **CI/CD** | PostgreSQL Test-DB | Test-Keys in Secrets | Dev Store (optional) |
| **Production** | Railway PostgreSQL | Encrypted in DB | Echte Shops |

---

## 📊 Coverage-Ziele

### Aktueller Stand
```bash
npm run test:coverage
```

**Ausgabe:**
```
File                           | % Stmts | % Branch | % Funcs | % Lines
-------------------------------|---------|----------|---------|--------
src/services/ai.service.ts     |   XX.XX |    XX.XX |   XX.XX |   XX.XX
src/services/ai-queue.service.ts | XX.XX |  XX.XX |   XX.XX |   XX.XX
...
-------------------------------|---------|----------|---------|--------
All files                      |   XX.XX |    XX.XX |   XX.XX |   XX.XX
```

### Ziele (Roadmap)

- [ ] **Phase 1 (Jetzt)**: 40% Coverage (Critical Paths)
  - AI Queue Service
  - Product Sync Service
  - Translation Service

- [ ] **Phase 2 (Nächste 2 Wochen)**: 70% Coverage
  - Alle Services
  - Actions (Product, Unified Content)
  - Wichtigste Components

- [ ] **Phase 3 (Langfristig)**: 85% Coverage
  - React Components
  - Edge Cases
  - E2E Critical Flows

---

## 🐛 Debugging Tests

### Test läuft nicht durch?

1. **Check Mock-Imports**:
   ```typescript
   // ❌ Falsch
   import { AIService } from '~/services/ai.service';

   // ✅ Richtig
   vi.mock('~/services/ai.service', () => ({
     AIService: vi.fn(() => createMockAIService())
   }));
   ```

2. **DB-Mock überprüfen**:
   ```typescript
   // In beforeEach:
   vi.clearAllMocks();
   ```

3. **Console-Logs aktivieren**:
   ```bash
   npm run test -- --reporter=verbose
   ```

### Test ist zu langsam?

- Unit Tests sollten <100ms sein
- Wenn länger: Wahrscheinlich echte API-Calls → Mocks überprüfen
- `vitest --reporter=verbose` zeigt langsame Tests

---

## 📚 Weitere Ressourcen

- [Vitest Docs](https://vitest.dev/)
- [React Testing Library](https://testing-library.com/react)
- [MSW (Mock Service Worker)](https://mswjs.io/) - Für HTTP-Mocks
- [Prisma Testing Guide](https://www.prisma.io/docs/guides/testing)

---

## 🤝 Best Practices

### DOs ✅
- Mocks für alle externen APIs verwenden
- Tests isoliert halten (keine Abhängigkeiten zwischen Tests)
- Aussagekräftige Test-Namen (`sollte X tun wenn Y`)
- `beforeEach` für Setup, `afterEach` für Cleanup
- Coverage regelmäßig überprüfen

### DON'Ts ❌
- Echte API-Keys in Tests verwenden
- Tests gegen Production-DB laufen lassen
- Tests überspringen mit `it.skip()` (außer temporär)
- `console.log()` in Tests lassen (verwende `logger.debug()` wenn nötig)
- Sehr lange Tests (>500ms) ohne guten Grund

---

## 🎓 Training-Tests

Für neue Entwickler: Beginne mit diesen einfachen Tests:

1. [tests/unit/encryption.test.ts](./unit/encryption.test.ts) - Einfache Unit-Tests
2. [tests/unit/aiService.test.ts](./unit/aiService.test.ts) - Service-Tests mit Mocks
3. [tests/unit/product-sync.service.test.ts](./unit/product-sync.service.test.ts) - Komplexere Integration

---

## 🚨 CI/CD Integration

### GitHub Actions Beispiel

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

      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          files: ./coverage/coverage-final.json
```

---

## 💡 FAQ

**Q: Warum SQLite statt PostgreSQL für Tests?**
A: Schneller Setup (<50ms), kein Docker nötig, ideal für Unit-Tests. Für Integration-Tests kannst du später PostgreSQL in Docker verwenden.

**Q: Kann ich Tests gegen echte Shopify Dev Store laufen lassen?**
A: Ja, aber nur für E2E-Tests in CI/CD. Verwende separate Test-API-Keys in GitHub Secrets.

**Q: Was ist mit React Component Tests?**
A: Verwende `@testing-library/react` mit gemockten Contexts (PlanContext, I18nContext). Beispiele folgen in Phase 2.

**Q: Wie teste ich Webhooks?**
A: Mock den Webhook-Payload und teste nur die Handler-Logik. MSW kann HTTP-Requests mocken.

---

**Happy Testing! 🎉**
