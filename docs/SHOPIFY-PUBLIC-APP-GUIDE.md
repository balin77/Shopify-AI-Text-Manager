# Shopify Public App Guide - Von Development bis App Store

Dieser Guide erklärt wie du deine App für den öffentlichen Verkauf im Shopify App Store vorbereitest.

---

## 📋 Übersicht: Public App Requirements

### Shopify App Store Anforderungen:

1. ✅ **App Funktionalität** - Stabile, funktionierende App
2. ✅ **Billing/Subscription System** - Integriertes Shopify Billing
3. ✅ **Privacy Policy** - Öffentliche Datenschutzerklärung
4. ✅ **Support Kontakt** - Email oder Support System
5. ✅ **App Listing** - Beschreibung, Screenshots, Videos
6. ✅ **App Review** - Shopify prüft deine App (kann 2-4 Wochen dauern)
7. ✅ **Merchant Experience** - Onboarding, Help Docs, etc.

---

## 🏗️ App-Typen und Strategie

### Für Development & Testing:
```
App Type: Custom App (oder Unlisted)
Name: ContentPilot AI Dev
Environment: Development Railway
Billing: Disabled (oder Test Mode)
```

### Für Production & App Store:
```
App Type: Public App
Name: ContentPilot AI
Environment: Production Railway
Billing: Active (Shopify Billing API)
App Store: Listed (nach Review)
```

---

## 💰 Pricing & Billing Strategy

### Schritt 1: Entscheide deine Pricing Tiers

**Typische SaaS Pricing Strategie:**

#### Option A: Einfaches 3-Tier Model (Empfohlen für Start)
```
🆓 FREE TIER (Optional)
- Kostenlos
- Limitierte Features (z.B. 10 Produkte/Monat)
- Ideal für Testing & Akquise

💎 BASIC - $9.99/month
- 100 Produkte/Monat
- Basic AI Features
- Email Support

🚀 PRO - $29.99/month
- 500 Produkte/Monat
- Alle AI Features
- Priority Support
- Bulk Operations

⭐ ENTERPRISE - $79.99/month
- Unlimited Produkte
- Premium AI Models
- Dedicated Support
- Custom Features
```

#### Option B: Usage-Based Pricing
```
PAY-AS-YOU-GO - $0.10/product
- Keine monatliche Fee
- Zahle nur für was du nutzt
- Minimum: $4.99/month
```

#### Option C: Hybrid Model
```
BASE PLAN - $14.99/month
+ $0.05 per zusätzliches Produkt über 200
```

### Schritt 2: Feature-Matrix erstellen

Definiere genau welche Features in welchem Plan verfügbar sind:

| Feature | Free | Basic | Pro | Enterprise |
|---------|------|-------|-----|------------|
| Produkte/Monat | 10 | 100 | 500 | Unlimited |
| AI Übersetzungen | ✓ | ✓ | ✓ | ✓ |
| Bulk Operations | ✗ | ✗ | ✓ | ✓ |
| Premium AI Models | ✗ | ✗ | ✓ | ✓ |
| SEO Optimization | ✗ | ✗ | ✓ | ✓ |
| API Access | ✗ | ✗ | ✗ | ✓ |
| Priority Support | ✗ | ✗ | ✓ | ✓ |
| Custom Workflows | ✗ | ✗ | ✗ | ✓ |

---

## 🔧 Shopify Billing API Integration

### Billing Types in Shopify:

1. **Recurring Application Charge** (Monatliches Abo)
2. **Usage Charge** (Pay-per-use)
3. **One-time Charge** (Einmalige Zahlung)

### Code Implementation

Deine App nutzt `@shopify/shopify-app-remix` - das hat Billing bereits integriert!

#### 1. Billing Configuration definieren

Erstelle: `app/shopify.billing.server.ts`

```typescript
// app/shopify.billing.server.ts
import { BillingInterval } from "@shopify/shopify-app-remix/server";

export const billingConfig = {
  "Basic Plan": {
    amount: 9.99,
    currencyCode: "USD",
    interval: BillingInterval.Every30Days,
    trialDays: 7, // 7 Tage kostenlos testen
  },
  "Pro Plan": {
    amount: 29.99,
    currencyCode: "USD",
    interval: BillingInterval.Every30Days,
    trialDays: 7,
  },
  "Enterprise Plan": {
    amount: 79.99,
    currencyCode: "USD",
    interval: BillingInterval.Every30Days,
    trialDays: 14, // Längere Trial für Enterprise
  },
};

// Feature Limits pro Plan
export const planLimits = {
  free: {
    productsPerMonth: 10,
    bulkOperations: false,
    premiumAI: false,
    prioritySupport: false,
  },
  basic: {
    productsPerMonth: 100,
    bulkOperations: false,
    premiumAI: false,
    prioritySupport: false,
  },
  pro: {
    productsPerMonth: 500,
    bulkOperations: true,
    premiumAI: true,
    prioritySupport: true,
  },
  enterprise: {
    productsPerMonth: -1, // Unlimited
    bulkOperations: true,
    premiumAI: true,
    prioritySupport: true,
    apiAccess: true,
  },
};
```

#### 2. Billing in Shopify App Setup integrieren

Update: `app/shopify.server.ts`

```typescript
import { shopifyApp } from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { billingConfig } from "./shopify.billing.server";

// ... existing imports ...

export const shopify = shopifyApp({
  // ... existing config ...

  billing: billingConfig, // Billing hinzufügen

  hooks: {
    afterAuth: async ({ session, admin }) => {
      // Nach erfolgreicher Installation
      // Registriere Webhooks, erstelle initial Subscription, etc.

      // Optional: Redirect zu Billing Page wenn kein aktiver Plan
      const hasActiveSubscription = await checkSubscription(session);
      if (!hasActiveSubscription) {
        return redirect("/app/billing");
      }
    },
  },
});
```

#### 3. Billing Routes erstellen

**Route: Subscription erstellen**

```typescript
// app/routes/app.billing.tsx
import { json, redirect } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, Form } from "@remix-run/react";
import { authenticate } from "~/shopify.server";
import { billingConfig } from "~/shopify.billing.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { billing, session } = await authenticate.admin(request);

  // Check ob bereits Subscription existiert
  const subscription = await billing.check({
    plans: Object.keys(billingConfig),
    isTest: process.env.NODE_ENV !== "production",
  });

  return json({
    subscription,
    plans: billingConfig,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { billing } = await authenticate.admin(request);
  const formData = await request.formData();
  const plan = formData.get("plan") as string;

  // Erstelle Billing Request
  const billingResponse = await billing.request({
    plan,
    isTest: process.env.NODE_ENV !== "production",
    returnUrl: `${process.env.SHOPIFY_APP_URL}/app/billing/callback`,
  });

  // Redirect zu Shopify Billing Page
  return redirect(billingResponse.confirmationUrl);
}

export default function BillingPage() {
  const { subscription, plans } = useLoaderData<typeof loader>();

  return (
    <div>
      <h1>Choose Your Plan</h1>

      {Object.entries(plans).map(([planName, config]) => (
        <div key={planName}>
          <h2>{planName}</h2>
          <p>${config.amount}/month</p>
          {config.trialDays && <p>{config.trialDays} days free trial</p>}

          <Form method="post">
            <input type="hidden" name="plan" value={planName} />
            <button type="submit">Subscribe</button>
          </Form>
        </div>
      ))}
    </div>
  );
}
```

**Route: Billing Callback (nach Zahlung)**

```typescript
// app/routes/app.billing.callback.tsx
import { redirect } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "~/shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { billing, session } = await authenticate.admin(request);

  // Verify billing wurde accepted
  const billingCheck = await billing.check({
    plans: Object.keys(billingConfig),
    isTest: process.env.NODE_ENV !== "production",
  });

  if (!billingCheck.hasActivePayment) {
    // Billing wurde nicht accepted
    return redirect("/app/billing");
  }

  // Store subscription in DB
  await prisma.subscription.upsert({
    where: { shop: session.shop },
    update: {
      plan: billingCheck.appSubscriptions[0].name,
      status: "active",
    },
    create: {
      shop: session.shop,
      plan: billingCheck.appSubscriptions[0].name,
      status: "active",
    },
  });

  // Success! Redirect zu App
  return redirect("/app");
}
```

#### 4. Feature Gating Middleware

```typescript
// app/utils/billing.server.ts
import { prisma } from "~/db.server";
import { planLimits } from "~/shopify.billing.server";

export async function checkFeatureAccess(
  shop: string,
  feature: keyof typeof planLimits.free
) {
  const subscription = await prisma.subscription.findUnique({
    where: { shop },
  });

  if (!subscription) {
    // Kein Plan = Free Tier
    return planLimits.free[feature];
  }

  const plan = subscription.plan.toLowerCase().replace(" plan", "");
  return planLimits[plan as keyof typeof planLimits][feature];
}

export async function checkUsageLimit(shop: string, action: string) {
  const subscription = await prisma.subscription.findUnique({
    where: { shop },
    include: { usage: true },
  });

  const plan = subscription?.plan || "free";
  const limit = planLimits[plan as keyof typeof planLimits].productsPerMonth;

  if (limit === -1) return true; // Unlimited

  const currentUsage = subscription?.usage?.productsThisMonth || 0;
  return currentUsage < limit;
}
```

#### 5. Usage in API Routes

```typescript
// app/routes/api.translate.tsx
import { checkUsageLimit } from "~/utils/billing.server";

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);

  // Check if user has reached limit
  const canUse = await checkUsageLimit(session.shop, "translate");

  if (!canUse) {
    return json(
      { error: "Monthly limit reached. Please upgrade your plan." },
      { status: 403 }
    );
  }

  // ... do translation ...

  // Increment usage counter
  await prisma.usage.upsert({
    where: { shop: session.shop },
    update: { productsThisMonth: { increment: 1 } },
    create: { shop: session.shop, productsThisMonth: 1 },
  });

  return json({ success: true });
}
```

---

## 📊 Database Schema für Billing

Update: `prisma/schema.prisma`

```prisma
model Subscription {
  id        String   @id @default(cuid())
  shop      String   @unique
  plan      String   // "Basic Plan", "Pro Plan", etc.
  status    String   // "active", "cancelled", "trial"
  trialEndsAt DateTime?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  usage     Usage?
}

model Usage {
  id                String   @id @default(cuid())
  shop              String   @unique
  productsThisMonth Int      @default(0)
  monthStartDate    DateTime @default(now())
  subscription      Subscription @relation(fields: [shop], references: [shop])
}
```

---

## 🎨 Public App Listing - App Store Submission

### Was du für App Store brauchst:

#### 1. App Listing Informationen

**In Shopify Partners → App → "App listing":**

```
App Name: ContentPilot AI
Tagline: AI-powered content creation and translation for Shopify stores
(max 70 characters)

App Description:
Ausführliche Beschreibung (min 200 Wörter)
- Was macht die App?
- Welche Probleme löst sie?
- Key Features
- Benefits für Merchants

Key Features (min 3, max 5):
1. AI-powered product descriptions
2. Multi-language translation
3. Bulk content operations
4. SEO optimization
5. Custom content templates

App Category:
Marketing > Content & SEO

Pricing:
☑ Free plan available
☑ Paid plans available
Starting at: $9.99/month
```

#### 2. Screenshots & Media

**Required:**
- Minimum 3 Screenshots (1280x720 oder 1920x1080)
- App Icon (512x512 PNG)
- Optional: Demo Video (Empfohlen!)

**Screenshot Ideas:**
1. Dashboard Overview
2. Product Editing Interface
3. AI Translation in Action
4. Bulk Operations
5. Results/Analytics

#### 3. URLs & Legal

```
App URL: https://shopify-ai-text-manager-production.up.railway.app

Privacy Policy URL:
https://shopify-ai-text-manager-production.up.railway.app/privacy

Support Email: support@yourdomain.com

Support URL (optional):
https://shopify-ai-text-manager-production.up.railway.app/help
```

#### 4. Privacy Policy erstellen

Erstelle eine öffentliche Privacy Policy Page. Shopify hat Requirements:

**Required Sections:**
- What data you collect
- How you use the data
- How you store/secure data
- Third-party services (OpenAI, etc.)
- User rights (GDPR)
- Contact information

Du kannst einen Generator nutzen: https://www.shopify.com/tools/policy-generator

---

## ✅ App Review Checklist

Bevor du submitest, checke:

### Functionality:
- [ ] App installiert ohne Errors
- [ ] Alle Features funktionieren
- [ ] OAuth Flow funktioniert
- [ ] Billing/Subscription funktioniert
- [ ] Uninstall funktioniert sauber

### User Experience:
- [ ] Onboarding Flow für neue User
- [ ] Help/Support leicht findbar
- [ ] Error Messages sind hilfreich
- [ ] Mobile-responsive (embedded app)

### Performance:
- [ ] Schnelle Ladezeiten (<3 Sekunden)
- [ ] Keine Console Errors
- [ ] Efficient API Usage (respects rate limits)

### Compliance:
- [ ] Privacy Policy vorhanden und vollständig
- [ ] GDPR-compliant (wenn EU)
- [ ] Data handling transparent
- [ ] Uninstall löscht User-Daten (optional, aber empfohlen)

### Documentation:
- [ ] README/Help Docs verfügbar
- [ ] FAQ Section
- [ ] Video Tutorial (optional)

---

## 🚀 Deployment & Launch Strategy

### Phase 1: Development (JETZT)
```
✓ Build & test auf Development Environment
✓ Implement Billing System
✓ Create Privacy Policy
✓ Setup Support Email
```

### Phase 2: Private Beta (Optional aber empfohlen)
```
- Erstelle Unlisted App (nicht im Store)
- Teile Link mit Beta Testern
- Sammle Feedback
- Fix Bugs
- Iteration
```

### Phase 3: Production Deployment
```
- Erstelle Public Production App
- Deploy zu Production Railway
- Teste alles nochmal
- Aktiviere Billing
```

### Phase 4: App Store Submission
```
- Complete App Listing
- Upload Screenshots
- Submit for Review
- Wait 2-4 weeks für Approval
```

### Phase 5: Launch
```
- App geht live im Store
- Marketing (Social Media, Blog, etc.)
- Monitor Metrics
- Customer Support
```

---

## 💡 Best Practices & Tips

### Pricing Strategy:
1. **Start mit Free Tier** - Mehr Installations, mehr Reviews
2. **Trial Period** - 7-14 Tage, erhöht Conversion
3. **Annual Discount** - 2 Monate gratis bei Jahresabo
4. **Grandfather Pricing** - Early adopters behalten niedrige Preise

### App Store Optimization:
1. **Keywords** - In Titel & Description für SEO
2. **Screenshots** - Zeige Value, nicht nur Features
3. **Reviews** - Bitte zufriedene User um Reviews
4. **Updates** - Regelmäßige Updates = besseres Ranking

### Marketing:
1. **Landing Page** - Außerhalb Shopify für SEO
2. **Content Marketing** - Blog, Tutorials
3. **Social Proof** - Testimonials, Case Studies
4. **Partnerships** - Mit Agencies, Influencern

---

## 📞 Support & Resources

### Shopify Resources:
- **App Store Requirements**: https://shopify.dev/docs/apps/store/requirements
- **Billing API**: https://shopify.dev/docs/apps/billing
- **App Design Guidelines**: https://polaris.shopify.com/
- **Partner Academy**: https://partner-training.shopify.com/

### Community:
- Shopify Partners Slack
- Shopify Community Forums
- Reddit: r/shopifypartners

---

## 🎯 Next Steps für dich

1. **Entscheide Pricing Strategy** - Welches Model passt?
2. **Implement Billing** - Code anpassen (siehe oben)
3. **Create Production App** - In Shopify Partners
4. **Test Billing Flow** - Auf Development
5. **Privacy Policy** - Erstellen & deployen
6. **Screenshots** - Design & Produktion
7. **App Listing** - Ausfüllen in Partners
8. **Beta Test** - Mit echten Usern
9. **Submit to App Store** - Final submission

Soll ich dir helfen mit einem spezifischen Teil? Z.B. Billing Code implementieren oder Privacy Policy Template?
