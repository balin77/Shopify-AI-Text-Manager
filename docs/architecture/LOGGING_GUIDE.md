# 📝 Logging Guide - Strukturiertes Logging mit Winston

**Erstellt:** 15. Januar 2026
**Version:** 1.0.0

---

## 🎯 Übersicht

Das Projekt verwendet **Winston** für strukturiertes Logging anstelle von `console.log`. Dies bietet:

- **Umgebungsbasierte Log-Levels** (Debug in Development, Info in Production)
- **Strukturierte Daten** im JSON-Format
- **Context-Tagging** für bessere Filterung
- **File + Console Output** mit Rotation
- **Performance-Tracking** mit Timing-Helpers

---

## 📚 Verwendung

### Basic Logging

```typescript
import { logger } from '~/utils/logger.server';

// Info Level (immer geloggt)
logger.info('Product updated successfully', {
  context: 'ProductSync',
  productId: 'gid://shopify/Product/123',
  shop: 'example.myshopify.com'
});

// Error Level (mit Stack Trace)
try {
  await someOperation();
} catch (error) {
  logger.error('Operation failed', {
    context: 'ProductSync',
    error: error.message,
    stack: error.stack,
    productId: 'gid://shopify/Product/123'
  });
}

// Debug Level (nur in Development)
logger.debug('Processing queue item', {
  context: 'AIQueue',
  queueLength: 5,
  estimatedTokens: 500
});

// Warning Level
logger.warn('Rate limit approaching', {
  context: 'AIQueue',
  provider: 'OpenAI',
  currentUsage: '80%'
});
```

---

## 🏷️ Context-Specific Loggers

Für häufig verwendete Bereiche gibt es vordefinierte Logger:

```typescript
import { loggers } from '~/utils/logger.server';

// AI Service Logging
loggers.ai('info', 'AI generation completed', {
  provider: 'OpenAI',
  tokens: 350,
  duration: 1200
});

// Queue Logging
loggers.queue('debug', 'Task added to queue', {
  taskId: 'abc123',
  queuePosition: 3
});

// Product Sync Logging
loggers.product('info', 'Product synchronized', {
  productId: 'gid://123',
  updatedFields: ['title', 'description']
});

// Translation Logging
loggers.translation('info', 'Translation completed', {
  locale: 'de',
  fieldCount: 5
});

// Webhook Logging
loggers.webhook('info', 'Webhook received', {
  topic: 'products/update',
  shop: 'example.myshopify.com'
});

// Auth Logging
loggers.auth('warn', 'Failed login attempt', {
  ip: '192.168.1.1',
  reason: 'invalid_credentials'
});
```

---

## ⏱️ Performance Logging

```typescript
import { logPerformance } from '~/utils/logger.server';

async function expensiveOperation() {
  const startTime = Date.now();

  // Do work...
  await processData();

  // Automatisches Timing
  logPerformance('processData', startTime, {
    recordCount: 1000
  });
}

// Output: "Performance: processData { duration: '1234ms', recordCount: 1000 }"
```

---

## 🌐 API Call Logging

```typescript
import { logApiCall } from '~/utils/logger.server';

async function callShopifyAPI() {
  const startTime = Date.now();

  try {
    const response = await fetch('https://api.shopify.com/...');
    const duration = Date.now() - startTime;

    logApiCall('Shopify', 'products/query', 'success', duration, {
      productCount: 50
    });

    return response;
  } catch (error) {
    const duration = Date.now() - startTime;

    logApiCall('Shopify', 'products/query', 'error', duration, {
      error: error.message
    });

    throw error;
  }
}
```

---

## 🔧 Konfiguration

### Log Levels

| Environment | Level | Beschreibung |
|-------------|-------|--------------|
| Development | `debug` | Alle Logs inkl. Debug-Infos |
| Production | `info` | Nur Info, Warning und Error |
| Custom | `LOG_LEVEL=warn` | Environment Variable überschreibt |

### File Output (nur Production)

```bash
logs/
├── error.log          # Nur Errors
├── combined.log       # Alle Logs
└── (rotiert bei 5MB)
```

**Rotation Settings:**
- Max Size: 5 MB pro File
- Max Files: 5 (älteste wird gelöscht)
- Format: JSON (strukturiert für Log-Analyse)

### Console Output

In Development:
```
2026-01-15 10:30:45 [info] [ProductSync]: Product updated { productId: 'gid://123' }
```

In Production (JSON):
```json
{
  "timestamp": "2026-01-15T10:30:45.123Z",
  "level": "info",
  "message": "Product updated",
  "context": "ProductSync",
  "productId": "gid://123"
}
```

---

## 🚫 Was NICHT zu loggen ist

### Sensitive Daten

❌ **NIEMALS loggen:**
- API Keys / Access Tokens
- Passwords
- PII ohne Hashing (Email, Namen in Plaintext)
- Kreditkartendaten
- OAuth Refresh Tokens

✅ **Stattdessen:**
```typescript
// FALSCH
logger.info('API call', { apiKey: apiKey });

// RICHTIG
logger.info('API call', {
  apiKeyPrefix: apiKey.substring(0, 8) + '...',
  provider: 'OpenAI'
});

// FALSCH
logger.info('User logged in', { email: user.email });

// RICHTIG
logger.info('User logged in', {
  userId: user.id,
  shop: user.shop
});
```

---

## 📊 Migration von console.log

### Vorher (console.log)

```typescript
console.log('📮 [PRODUCT.ACTIONS] Request method:', request.method);
console.log('🎯 [TranslateAll] Starting translation for locale:', locale);
console.error('❌ Translation failed:', error);
```

### Nachher (Winston)

```typescript
logger.info('Request received', {
  context: 'ProductActions',
  method: request.method
});

loggers.translation('info', 'Starting translation', {
  locale: locale
});

loggers.translation('error', 'Translation failed', {
  error: error.message,
  locale: locale
});
```

### Vorteile

| Feature | console.log | Winston Logger |
|---------|-------------|----------------|
| Strukturiert | ❌ | ✅ |
| Filterbar | ❌ | ✅ (nach Context) |
| Timestamps | ❌ | ✅ |
| Log Levels | ❌ | ✅ (debug/info/warn/error) |
| File Output | ❌ | ✅ |
| Production-Ready | ❌ | ✅ |
| Searchable | ❌ | ✅ (JSON-Format) |

---

## 🔍 Log-Analyse

### Grep nach Context

```bash
# Alle AI-bezogenen Logs
grep '"context":"AIService"' logs/combined.log

# Alle Fehler im Product Sync
grep '"context":"ProductSync"' logs/error.log
```

### JSON Parsing mit jq

```bash
# Top 10 langsame Operationen
cat logs/combined.log | jq 'select(.context == "Performance") | .duration' | sort -nr | head -10

# Alle Failed API Calls
cat logs/combined.log | jq 'select(.context == "API" and .status == "error")'

# Anzahl Logs pro Context
cat logs/combined.log | jq -r '.context' | sort | uniq -c | sort -nr
```

---

## 🎯 Best Practices

### 1. Immer Context angeben

```typescript
// SCHLECHT
logger.info('Task completed');

// GUT
logger.info('Task completed', {
  context: 'AIQueue',
  taskId: task.id,
  duration: '1234ms'
});
```

### 2. Strukturierte Daten verwenden

```typescript
// SCHLECHT
logger.info(`Product ${productId} updated for shop ${shop}`);

// GUT
logger.info('Product updated', {
  context: 'ProductSync',
  productId: productId,
  shop: shop
});
```

### 3. Richtige Log Levels

```typescript
// DEBUG - Entwickler-Infos (nur in Dev)
logger.debug('Processing item', { item: data });

// INFO - Normale Operationen
logger.info('Product created', { productId: '123' });

// WARN - Potenzielle Probleme
logger.warn('Rate limit approaching', { usage: '80%' });

// ERROR - Fehler die Attention brauchen
logger.error('API call failed', { error: err.message });
```

### 4. Performance Tracking

```typescript
async function importProducts() {
  const startTime = Date.now();

  try {
    const products = await fetchProducts();
    logPerformance('importProducts', startTime, {
      productCount: products.length
    });
    return products;
  } catch (error) {
    logger.error('Import failed', {
      context: 'ProductImport',
      duration: Date.now() - startTime,
      error: error.message
    });
    throw error;
  }
}
```

---

## 🚀 Deployment Notes

### Railway

Winston erstellt automatisch das `logs/` Verzeichnis. In Railway werden Logs über `railway logs` verfügbar:

```bash
# Live Logs anzeigen
railway logs

# Nach Context filtern
railway logs | grep "ProductSync"

# Letzte 100 Error Logs
railway logs | grep '"level":"error"' | tail -100
```

### Environment Variables

```bash
# Optional: Log Level überschreiben
LOG_LEVEL=debug  # Für mehr Details
LOG_LEVEL=warn   # Nur Warnings & Errors
LOG_LEVEL=error  # Nur Errors
```

---

## 📖 Weitere Ressourcen

- [Winston Documentation](https://github.com/winstonjs/winston)
- [Log Levels Best Practices](https://www.loggly.com/blog/logging-best-practices/)
- [Structured Logging Guide](https://www.structuredlogging.org/)

---

**Letzte Aktualisierung:** 15. Januar 2026
