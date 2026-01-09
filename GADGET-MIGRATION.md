# 🚀 Migration zu Gadget - Komplette Anleitung

## Warum Gadget?

### Problem mit lokalem Setup:
- ❌ Localhost funktioniert nicht mit Shopify embedded apps
- ❌ Tunnel (ngrok/cloudflare) sind umständlich
- ❌ Session-Management manuell
- ❌ Deployment kompliziert
- ❌ Infrastruktur selbst verwalten

### Lösung mit Gadget:
- ✅ Automatisches Tunneling für Development
- ✅ OAuth & Sessions automatisch
- ✅ Hosting & Deployment integriert
- ✅ Datenbank (Postgres) inklusive
- ✅ GraphQL API automatisch generiert
- ✅ TypeScript Support
- ✅ Kostenloser Development-Tier

---

## 🎯 Schritt 1: Gadget Account erstellen

### 1.1 Registrieren

1. Gehe zu: [https://gadget.dev](https://gadget.dev)
2. Klicke auf **"Sign up"**
3. Registriere dich mit E-Mail oder GitHub

### 1.2 Neues Projekt erstellen

1. Nach Login: Klicke **"Create new app"**
2. Wähle: **"Shopify app"** Template
3. App Name: `ContentPilot AI` (oder dein Wunschname)
4. Klicke **"Create"**

Gadget erstellt automatisch:
- Komplette Shopify App-Struktur
- Datenbank-Modelle für Shopify-Ressourcen
- OAuth-Flow
- Beispiel-Frontend

---

## 🔗 Schritt 2: Shopify Connection einrichten

### 2.1 App-Credentials in Gadget eintragen

Im Gadget Dashboard:

1. Gehe zu **Settings** → **Plugins** → **Shopify**
2. Klicke **"Connect to Shopify Partners"**
3. Trage ein:
   - **App API Key**: `***REMOVED***`
   - **App API Secret**: `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`
4. Klicke **"Save"**

### 2.2 Scopes konfigurieren

In **Settings** → **Plugins** → **Shopify** → **API Scopes**:

Wähle:
```
read_locales
read_online_store_navigation
write_online_store_navigation
read_online_store_pages
write_online_store_pages
read_product_listings
write_product_listings
read_products
write_products
read_content
write_content
read_translations
write_translations
```

### 2.3 URLs automatisch setzen

Gadget gibt dir automatisch URLs wie:
```
https://contentpilot-ai--development.gadget.app
```

Diese musst du im Shopify Partners Dashboard eintragen:
1. [Shopify Partners Dashboard](https://partners.shopify.com/)
2. Deine App öffnen
3. **Configuration** → **URLs**
4. App URL: `https://contentpilot-ai--development.gadget.app`
5. Redirect URLs: `https://contentpilot-ai--development.gadget.app/auth/callback`

---

## 📦 Schritt 3: Deine Services migrieren

### 3.1 Datenstruktur verstehen

Gadget erstellt automatisch Models für Shopify-Daten:
- `shopifyProduct` - Synced mit Shopify
- `shopifyCollection` - Synced mit Shopify
- `shopifyShop` - Shop-Informationen
- `shopifySync` - Sync-Status

### 3.2 Custom Actions erstellen

Für deine SEO-Optimierung:

#### Action: `generateSEO`

In Gadget IDE:
1. **Actions** → **New Action**
2. Name: `generateProductSEO`
3. Model: `shopifyProduct`

```typescript
// api/models/shopifyProduct/actions/generateProductSEO.ts

import { ActionOptions } from "gadget-server";

export const run: ActionRun = async ({ params, record, logger, api, connections }) => {
  const { productId, aiProvider = "huggingface" } = params;

  // Produkt laden
  const product = await api.shopifyProduct.findOne(productId);

  if (!product) {
    throw new Error("Product not found");
  }

  // AI Service aufrufen (siehe unten)
  const aiService = new AIService(aiProvider);
  const suggestion = await aiService.generateSEO(
    product.title,
    product.body || ""
  );

  // Ergebnis zurückgeben
  return {
    seoTitle: suggestion.seoTitle,
    metaDescription: suggestion.metaDescription,
    reasoning: suggestion.reasoning,
  };
};

export const options: ActionOptions = {
  actionType: "custom",
};
```

#### Action: `applySEO`

```typescript
// api/models/shopifyProduct/actions/applySEO.ts

import { ActionOptions } from "gadget-server";

export const run: ActionRun = async ({ params, logger, api, connections }) => {
  const { productId, seoTitle, metaDescription } = params;

  // Produkt via Shopify API updaten
  await api.shopifyProduct.update(productId, {
    seo: {
      title: seoTitle,
      description: metaDescription,
    },
  });

  return { success: true };
};

export const options: ActionOptions = {
  actionType: "custom",
};
```

### 3.3 AI Service als Global Action

Erstelle eine globale Action für AI-Services:

```typescript
// api/actions/ai/generateSEO.ts

import { HfInference } from "@huggingface/inference";
import { GoogleGenerativeAI } from "@google/generative-ai";

export const run = async ({ params }) => {
  const { title, description, provider = "huggingface" } = params;

  if (provider === "huggingface") {
    const hf = new HfInference(process.env.HUGGINGFACE_API_KEY);

    const prompt = `Generate SEO-optimized content for this product:
Title: ${title}
Description: ${description}

Return JSON with:
{
  "seoTitle": "optimized 60 char title",
  "metaDescription": "optimized 160 char description",
  "reasoning": "explanation"
}`;

    const result = await hf.textGeneration({
      model: "mistralai/Mistral-7B-Instruct-v0.2",
      inputs: prompt,
      parameters: { max_new_tokens: 500 },
    });

    return JSON.parse(result.generated_text);
  }

  if (provider === "gemini") {
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-pro" });

    const prompt = `Generate SEO content for: ${title}...`;
    const result = await model.generateContent(prompt);

    return JSON.parse(result.response.text());
  }

  throw new Error(`Unknown provider: ${provider}`);
};
```

### 3.4 Environment Variables in Gadget

In **Settings** → **Environment Variables**:

```
HUGGINGFACE_API_KEY=***REMOVED***
GOOGLE_API_KEY=***REMOVED***
AI_PROVIDER=huggingface
```

---

## 🎨 Schritt 4: Frontend erstellen

### 4.1 Gadget's React Framework

Gadget nutzt Vite + React. Frontend ist in `/web` Ordner:

```typescript
// web/routes/index.tsx

import { Page, Layout, Card, Button } from "@shopify/polaris";
import { useNavigate } from "react-router-dom";

export default function HomePage() {
  const navigate = useNavigate();

  return (
    <Page title="ContentPilot AI">
      <Layout>
        <Layout.Section>
          <Card>
            <p>Welcome to ContentPilot AI!</p>
            <Button onClick={() => navigate("/products")}>
              Produkte verwalten
            </Button>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
```

### 4.2 Products Page

```typescript
// web/routes/products.tsx

import { Page, ResourceList, Button } from "@shopify/polaris";
import { useAction, useFindMany } from "@gadgetinc/react";
import { api } from "../api";

export default function ProductsPage() {
  // Produkte laden
  const [{ data: products, fetching }] = useFindMany(api.shopifyProduct);

  // Action für SEO-Generierung
  const [{ data, fetching: generating }, generateSEO] = useAction(
    api.shopifyProduct.generateProductSEO
  );

  const handleGenerateSEO = async (productId: string) => {
    await generateSEO({ productId, aiProvider: "huggingface" });
    // Show modal with results
  };

  return (
    <Page title="Produkte">
      <ResourceList
        items={products || []}
        renderItem={(product) => (
          <ResourceList.Item id={product.id}>
            <h3>{product.title}</h3>
            <Button onClick={() => handleGenerateSEO(product.id)}>
              SEO optimieren
            </Button>
          </ResourceList.Item>
        )}
      />
    </Page>
  );
}
```

---

## 🚀 Schritt 5: App deployen

### 5.1 Development Environment

Gadget gibt dir automatisch eine Development-URL:
```
https://contentpilot-ai--development.gadget.app
```

Diese ist sofort live! Kein Build, kein Deploy nötig.

### 5.2 Production Deployment

Wenn bereit:
1. Gehe zu **Settings** → **Environments**
2. Klicke **"Deploy to Production"**
3. Production URL: `https://contentpilot-ai.gadget.app`

### 5.3 App installieren

Nutze die Installation-URL:
```
https://8c19f3-ce.myshopify.com/admin/oauth/install/app?client_id=***REMOVED***
```

Oder installiere direkt aus Gadget heraus (Button: "Install on development store")

---

## 📊 Vorteile von Gadget

| Feature | Remix (Lokal) | Gadget |
|---------|---------------|--------|
| Setup Zeit | 2-3 Stunden | 10 Minuten |
| Tunneling | Manuell (ngrok) | Automatisch |
| OAuth | Selbst implementieren | Automatisch |
| Datenbank | Selbst hosten | Inklusive |
| Deployment | Manuell | Ein-Klick |
| Scaling | Selbst verwalten | Automatisch |
| Kosten (Dev) | Infrastruktur | Kostenlos |

---

## 🔄 Migration Checklist

- [ ] Gadget Account erstellt
- [ ] Neues Projekt angelegt
- [ ] Shopify Connection konfiguriert
- [ ] Scopes gesetzt
- [ ] URLs im Partners Dashboard aktualisiert
- [ ] AI Service als Global Action implementiert
- [ ] Product Actions (generateSEO, applySEO) erstellt
- [ ] Environment Variables gesetzt
- [ ] Frontend erstellt (Dashboard, Products)
- [ ] App auf Development Store installiert
- [ ] SEO-Generierung getestet
- [ ] Production Deployment (optional)

---

## 📚 Ressourcen

- [Gadget Docs](https://docs.gadget.dev)
- [Gadget Shopify Guide](https://docs.gadget.dev/guides/plugins/shopify)
- [Gadget Actions](https://docs.gadget.dev/guides/actions)
- [Gadget React Framework](https://docs.gadget.dev/guides/frontend-development)

---

## 💡 Best Practices

### 1. Nutze Gadget's Data Sync

Gadget synchronisiert automatisch Shopify-Daten:
```typescript
// Produkte sind immer aktuell
const products = await api.shopifyProduct.findMany();
```

### 2. Nutze Actions für Business Logic

Alle Logik in Actions statt im Frontend:
```typescript
// ❌ Schlecht: Logik im Frontend
const result = await fetch(`/api/generate-seo?productId=${id}`);

// ✅ Gut: Action aufrufen
const [result] = await api.shopifyProduct.generateProductSEO({ productId: id });
```

### 3. Nutze Gadget's Type Safety

Gadget generiert automatisch TypeScript-Types:
```typescript
import { api } from "../api"; // Vollständig typisiert!
```

---

## 🎉 Nächste Schritte nach Migration

1. **Übersetzungen hinzufügen**: Nutze `shopifyTranslation` Model
2. **Bulk-Operations**: Batch-Actions für mehrere Produkte
3. **Analytics**: Track SEO-Verbesserungen
4. **Webhooks**: Automatische Optimierung bei neuen Produkten

---

**Los geht's!** Erstelle deinen Gadget Account und wir migrieren zusammen! 🚀
