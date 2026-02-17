# Shopify Public App Guide - Von Development bis App Store

Dieser Guide erklärt wie du deine App für den öffentlichen Verkauf im Shopify App Store vorbereitest.
Enthält alle offiziellen Anforderungen von https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements

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

## 📜 Offizielle Shopify App Store Requirements

> Quelle: https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements

### 1. POLICY

#### 1.1 Build and Operate Within Shopify's Platform

| Nr. | Anforderung | Relevant für ContentPilot? | Status |
|-----|-------------|---------------------------|--------|
| 1.1.1 | **Session Tokens** statt Third-Party Cookies verwenden. Embedded App muss ohne Third-Party Cookies funktionieren. | Ja - Kritisch | [ ] |
| 1.1.2 | **Shopify Checkout** nutzen - Kein Bypass des Checkouts, keine Transaktionen außerhalb Shopify. | Nein (kein Checkout) | N/A |
| 1.1.3 | **Shopify Theme Store** - Apps dürfen keine Theme-Downloads erlauben, Themes nur über offiziellen Store. | Nein | N/A |
| 1.1.4 | **Nur faktische Informationen** - Keine Fake Reviews, keine falschen Daten, keine irreführenden Informationen. | Ja | [ ] |
| 1.1.5 | **Einzigartige Apps** - Apps dürfen nicht identisch mit anderen veröffentlichten Apps desselben Developers sein. | Ja | [ ] |
| 1.1.6 | **Single-Merchant Storefronts** - Keine Classifieds-Style Marktplätze; Sales Channels für Multi-Merchant nutzen. | Nein | N/A |
| 1.1.7 | **Payment Gateway Apps** benötigen Payments API Authorization. | Nein | N/A |
| 1.1.8 | **POS Apps** - Nur Shopify POS, keine Third-Party POS Systeme. | Nein | N/A |
| 1.1.9 | **Explizite Buyer-Zustimmung** vor Zusatzkosten - Kosten klar anzeigen und explizites Einverständnis einholen. | Nein (keine Buyer-Kosten) | N/A |
| 1.1.10 | **Günstigste Versandoption** als Default beibehalten. | Nein | N/A |
| 1.1.11 | **Browser Extensions** nur als optionale Features anbieten. | Nein | N/A |
| 1.1.12 | **Web-basierte App** - Kein Desktop-App-Zwang zum Funktionieren. | Ja | [ ] |
| 1.1.13 | **Produktinformationen** nur von autorisierten Quellen duplizieren. | Nein | N/A |
| 1.1.14 | **Keine Merchant-Vermittlung** an externe Agenturen. | Ja | [ ] |
| 1.1.15 | **Refunds** über Original-Zahlungsprozessor abwickeln. | Nein | N/A |
| 1.1.16 | **Kein Kapitalverleih** - Keine Kredite, Cash Advances oder Forderungskäufe. | Nein | N/A |

#### 1.2 Bill Through Shopify Billing API or Managed Pricing

| Nr. | Anforderung | Relevant? | Status |
|-----|-------------|-----------|--------|
| 1.2.1 | **Shopify Managed Pricing oder Billing API** nutzen - Off-Platform Billing darf nicht über den App Store vertrieben werden. | Ja - Pflicht | [ ] |
| 1.2.2 | **Billing korrekt implementieren** - Accept, Decline und Charge Approval bei Reinstall korrekt handhaben. | Ja - Pflicht | [ ] |
| 1.2.3 | **Plan-Wechsel ohne Support-Kontakt** ermöglichen - Merchants müssen Upgrade/Downgrade ohne Kontakt zum Support oder Reinstall durchführen können. | Ja - Pflicht | [ ] |

---

### 2. FUNCTIONALITY

#### 2.1 Create Reliable and User-Friendly Apps

| Nr. | Anforderung | Relevant? | Status |
|-----|-------------|-----------|--------|
| 2.1.1 | **Keine kritischen Fehler** - Keine UI Bugs, Display Issues oder Error Pages die das Review verhindern. | Ja - Pflicht | [ ] |
| 2.1.2 | **Keine Minor Errors** - Keine UI Bugs die das Review teilweise verhindern. | Ja - Pflicht | [ ] |
| 2.1.3 | **Funktionale User Interface** - App muss über UI funktionieren, egal wie sie gestartet wird. Keine 404s, 500s oder Web Errors. | Ja - Pflicht | [ ] |
| 2.1.4 | **Daten korrekt synchronisieren** - Datentransfer muss konsistent sein zwischen Shopify Admin, App und abhängigen Plattformen. | Ja - Pflicht | [ ] |

#### 2.2 Use Shopify's APIs and Platform Tools

| Nr. | Anforderung | Relevant? | Status |
|-----|-------------|-----------|--------|
| 2.2.1 | **Shopify APIs nutzen** - Apps müssen offizielle APIs verwenden; Apps ohne API-Nutzung sind nicht erlaubt. | Ja - Pflicht | [ ] |
| 2.2.2 | **Konsistente Embedded Experience** - Off-Platform Features müssen direkt im Admin integriert sein. | Ja - Pflicht | [ ] |
| 2.2.3 | **Neueste Shopify App Bridge** nutzen - Alle Apps müssen die neueste App Bridge verwenden (`app-bridge.js` Script Tag). | Ja - Kritisch | [ ] |
| 2.2.4 | **GraphQL Admin API** - Seit April 2025 müssen alle neuen Public Apps ausschließlich die GraphQL Admin API nutzen (kein REST). | Ja - Kritisch | [ ] |
| 2.2.5 | **Admin Extensions feature-complete** - Müssen eigenständige Funktionalität bieten, keine unnötigen Promotions. | Falls Extensions genutzt | [ ] |
| 2.2.6 | **Keine Eigenwerbung in Admin Extensions** - Keine Self-Promotion, keine verwandte App-Werbung, keine Review-Requests. | Falls Extensions genutzt | [ ] |
| 2.2.7 | **Max Modal nur bei Merchant-Interaktion** öffnen - Darf nicht automatisch oder aus dem Navigation Menu gestartet werden. | Falls Modals genutzt | [ ] |

#### 2.3 Provide Seamless and Secure Installation

| Nr. | Anforderung | Relevant? | Status |
|-----|-------------|-----------|--------|
| 2.3.1 | **Installation nur über Shopify Surface** starten - Keine manuelle URL-Eingabe erforderlich. | Ja - Pflicht | [ ] |
| 2.3.2 | **Sofort nach Install authentifizieren** - OAuth Authentication vor jeder UI-Interaktion. | Ja - Pflicht | [ ] |
| 2.3.3 | **Nach Installation zur App UI redirecten** - Merchants werden nach OAuth-Akzeptanz zur App-UI weitergeleitet. | Ja - Pflicht | [ ] |
| 2.3.4 | **OAuth auch bei Reinstall** - Merchants müssen sich auch bei erneuter Installation authentifizieren. | Ja - Pflicht | [ ] |

---

### 3. SECURITY

#### 3.1 Secure Data with Valid TLS/SSL Certificates

| Nr. | Anforderung | Relevant? | Status |
|-----|-------------|-----------|--------|
| 3.1.1 | **Gültiges TLS/SSL-Zertifikat** - Alle ausgetauschten Daten müssen via TLS mit gültigem Zertifikat verschlüsselt werden. | Ja - Pflicht | [ ] |

#### 3.2 Request Only Necessary Access Scopes

| Nr. | Anforderung | Relevant? | Status |
|-----|-------------|-----------|--------|
| 3.2.1 | **`read_all_orders`** nur bei funktionaler Notwendigkeit anfordern. | Prüfen | [ ] |
| 3.2.2 | **`write_payment_mandate`** nur bei funktionaler Notwendigkeit anfordern. | Nein | N/A |
| 3.2.3 | **`write_checkout_extensions_apis`** nur bei funktionaler Notwendigkeit anfordern. | Nein | N/A |
| 3.2.4 | **`read_advanced_dom_pixel_events`** nur für Heatmap/Session Recording im Checkout. | Nein | N/A |
| 3.2.5 | **`read_checkout_extensions_chat`** nur bei funktionaler Notwendigkeit. | Nein | N/A |

**Generelle Regel:** Nur die Scopes anfordern, die die App tatsächlich braucht. Jeder unnötige Scope kann zur Ablehnung führen.

---

### 4. APP STORE LISTING

#### 4.1 Brand Your App Consistently

| Nr. | Anforderung | Relevant? | Status |
|-----|-------------|-----------|--------|
| 4.1.1 | **App-Name konsistent** - Name im Developer Dashboard und im Submission Form müssen übereinstimmen oder gemeinsame Wörter enthalten. | Ja - Pflicht | [ ] |
| 4.1.2 | **App Icon im Dev Dashboard** hochladen - Icons müssen zwischen Dashboard und Listing identisch sein. In Settings bearbeiten. | Ja - Pflicht | [ ] |

#### 4.2 Keep Pricing Accurate and in Designated Areas

| Nr. | Anforderung | Relevant? | Status |
|-----|-------------|-----------|--------|
| 4.2.1 | **Korrekte Pricing-Informationen** - Alle Optionen angeben: Free Trial Dauer, Kosten, Details. | Ja - Pflicht | [ ] |
| 4.2.2 | **Keine Preise in Bildern** - Pricing darf NICHT im App Icon, Banner oder Screenshots erscheinen. | Ja - Pflicht | [ ] |
| 4.2.3 | **Keine Preise außerhalb des Pricing-Bereichs** - Pricing-Infos nur im dafür vorgesehenen Abschnitt. | Ja - Pflicht | [ ] |

#### 4.3 Provide Accurate and Truthful Listing Information

| Nr. | Anforderung | Relevant? | Status |
|-----|-------------|-----------|--------|
| 4.3.1 | **Online Store Requirement angeben** - Klarstellen ob Merchants den Online Store Channel brauchen. | Ja | [ ] |
| 4.3.2 | **Nur vollständig unterstützte Sprachen angeben** - Gelistete Sprachen müssen komplett in der Merchant-UI unterstützt sein. | Ja - Wichtig für ContentPilot! | [ ] |
| 4.3.3 | **Keine unbelegten Statistiken/Claims im Text** - Keine Begriffe wie "the first", "the best", keine unbelegten Daten. | Ja - Pflicht | [ ] |
| 4.3.4 | **Keine unbelegten Claims in Bildern** - Statistiken und Superlative sind auch in visuellen Inhalten verboten. | Ja - Pflicht | [ ] |
| 4.3.5 | **Korrekte Tags verwenden** - Tags müssen die primäre App-Funktion widerspiegeln. Kategorie-Definitionen prüfen. | Ja - Pflicht | [ ] |
| 4.3.6 | **Keine Reviews in Bildern** - Reviews und Testimonials sind in Listing-Bildern verboten. | Ja - Pflicht | [ ] |
| 4.3.7 | **Keine Reviews im Listing-Text** - Reviews werden basierend auf Merchant-Feedback hinzugefügt, nicht vom Developer. | Ja - Pflicht | [ ] |
| 4.3.8 | **Geografische Anforderungen angeben** - Standort- oder berechtigungsspezifische Requirements angeben. | Ja | [ ] |

#### 4.4 Provide Clear Assets and Descriptions

| Nr. | Anforderung | Relevant? | Status |
|-----|-------------|-----------|--------|
| 4.4.1 | **Effektive App Card Subtitles** - App knapp zusammenfassen; keine Keywords für SEO, Statistiken oder unaufgeforderte Daten. | Ja - Pflicht | [ ] |
| 4.4.2 | **App Details Guidelines folgen** - Klare Erklärung der Funktionalität mit ausreichenden Feature-Informationen. | Ja - Pflicht | [ ] |
| 4.4.3 | **Shopify-Marke nicht missbrauchen** in Grafiken - Trademarks nur gemäß Brand Guidelines für Kompatibilität verwenden. | Ja - Pflicht | [ ] |
| 4.4.4 | **Klare, fokussierte Bilder** - Screenshots müssen aufgeräumt sein; Hintergründe und Browser-Fenster zuschneiden. | Ja - Pflicht | [ ] |

#### 4.5 Ensure Submission is Complete and Accurate

| Nr. | Anforderung | Relevant? | Status |
|-----|-------------|-----------|--------|
| 4.5.1 | **Sales Channels** in der entsprechenden Kategorie einreichen. | Nein (kein Sales Channel) | N/A |
| 4.5.2 | **Als reguläre App einreichen** wenn kein Sales Channel. | Ja | [ ] |
| 4.5.3 | **Demo Screencast beifügen** (PFLICHT!) - Onboarding und Features demonstrieren, Schritt-für-Schritt Setup, Englisch oder englische Untertitel. | Ja - Pflicht | [ ] |
| 4.5.4 | **Test-Credentials beifügen** (PFLICHT!) - Account-Zugangsdaten in den Testing Instructions angeben und aktuell halten. | Ja - Pflicht | [ ] |
| 4.5.5 | **Funktionale Test-Credentials** - Credentials müssen gültig sein und vollen Feature-Zugang gewähren. | Ja - Pflicht | [ ] |
| 4.5.6 | **Emergency Developer Contact** im Partner Dashboard hinterlegen - Kontakt für kritische technische Informationen. | Ja - Pflicht | [ ] |

---

### 5. CATEGORY-SPECIFIC REQUIREMENTS

#### 5.1 Online Store (Relevant wenn App das Theme modifiziert)

| Nr. | Anforderung | Relevant? | Status |
|-----|-------------|-----------|--------|
| 5.1.1 | **Theme App Extensions** nutzen - Wenn App das Merchant-Theme modifiziert, Theme App Extensions statt Code-Änderungen verwenden. | Prüfen | [ ] |
| 5.1.2 | **Theme App Extension korrekt anzeigen** - Widget muss fehlerfrei im Theme Editor und Online Store angezeigt werden. | Falls Themes geändert | [ ] |
| 5.1.3 | **Detailliertes Onboarding für Theme Extensions** - Detaillierte Setup-Anleitungen mit Deep Links empfohlen. | Falls Themes geändert | [ ] |
| 5.1.4 | **App Name Branding** - Branding nur wenn Kunden direkt mit der App interagieren als Key Buying Experience. | Prüfen | [ ] |
| 5.1.5 | **Gesammelte Daten zurück an Merchant** senden - Via Shopify Services gesammelte Daten müssen zum Merchant Admin zurück. | Ja | [ ] |

#### 5.2 Payment (Nicht relevant für ContentPilot)

<details>
<summary>Payment Requirements (5.2.1 - 5.2.15) - Aufklappen falls nötig</summary>

| Nr. | Anforderung |
|-----|-------------|
| 5.2.1 | Detaillierte Testing Instructions für Payment Apps |
| 5.2.2 | Screencasts für alle unterstützten Browser |
| 5.2.3 | Funktionaler Buyer Flow auf Desktop/Mobile |
| 5.2.4 | Korrekte Payment API Scopes |
| 5.2.5 | Payment Apps als Standalone (nicht embedded) |
| 5.2.6 | Buyer muss Zahlung abbrechen können |
| 5.2.7 | Merchants mit korrekter URL redirecten |
| 5.2.8 | Revenue Share Agreement unterzeichnen |
| 5.2.9 | Offsite Payment muss Checkout-Infos matchen |
| 5.2.10 | Nur Shopify-genehmigte Payment Methods anzeigen |
| 5.2.11 | Test Mode anbieten |
| 5.2.12 | Kein Upsell im Payment Flow |
| 5.2.13 | Payment Apps korrekt benennen |
| 5.2.14 | Single Checkout UI Extension |
| 5.2.15 | Keine Banner/Logos im Checkout |

</details>

#### 5.3 Payment Facilitator (Nicht relevant)

<details>
<summary>Payment Facilitator Requirements (5.3.1 - 5.3.3) - Aufklappen falls nötig</summary>

| Nr. | Anforderung |
|-----|-------------|
| 5.3.1 | Muss vom Gateway Owner eingereicht werden |
| 5.3.2 | Getrennt von finanziellen Transaktionen |
| 5.3.3 | Muss kostenlos für Merchants sein |

</details>

#### 5.4 Purchase Option / Subscriptions (Nicht relevant)

<details>
<summary>Purchase Option Requirements (5.4.1 - 5.4.20) - Aufklappen falls nötig</summary>

| Nr. | Anforderung |
|-----|-------------|
| 5.4.1 | Screencasts für alle unterstützten Browser |
| 5.4.2 | Korrekte Subscription API Scopes |
| 5.4.3 | Keine inkorrekten API Scopes |
| 5.4.4 | Alle Browser-Versionen Desktop/Mobile unterstützen |
| 5.4.5 | Buyer muss Subscription Payment Methods ändern können |
| 5.4.6 | Selling Plan Erstellung von Produktseite |
| 5.4.7 | Zugang über Shopify Customer Portal |
| 5.4.8 | Kündigung ermöglichen oder Bedingungen kommunizieren |
| 5.4.9 | Navigation zum Customer Portal |
| 5.4.10 | Purchase Options und Timing klar anzeigen |
| 5.4.11 | Purchase Option Entfernung in App Extension |
| 5.4.12 | Subscriptions mit Shopify Customers verlinken |
| 5.4.13 | Alle Subscriptions im Customer Portal zeigen |
| 5.4.14 | Multi-Currency und Discounts korrekt updaten |
| 5.4.15 | Subscriptions mit Orders im Admin verlinken |
| 5.4.16 | Selling Plan Name im Cart anzeigen |
| 5.4.17 | Pre-Order Verzögerungen kommunizieren |
| 5.4.18 | Prepaid Item Details klar anzeigen |
| 5.4.19 | Variant-Level Product Selection |
| 5.4.20 | APIs nicht für verbotene Aktionen nutzen |

</details>

#### 5.5 Product Sourcing (Nicht relevant)

<details>
<summary>Product Sourcing Requirements (5.5.1 - 5.5.5) - Aufklappen falls nötig</summary>

| Nr. | Anforderung |
|-----|-------------|
| 5.5.1 | Fulfillment Request ermöglichen (`fulfillmentOrderSubmitFulfillmentRequest`) |
| 5.5.2 | Cost of Goods Sold Details |
| 5.5.3 | PCI-konformes Payment Gateway |
| 5.5.4 | Keine High-Risk Produkte |
| 5.5.5 | Zahlung verifizieren vor Fulfillment |

</details>

#### 5.6 Checkout Customization (Nicht relevant)

<details>
<summary>Checkout Customization Requirements (5.6.1 - 5.6.9) - Aufklappen falls nötig</summary>

| Nr. | Anforderung |
|-----|-------------|
| 5.6.1 | Extensions korrekt im Storefront anzeigen |
| 5.6.2 | Merchants Kontrolle über Promo-Content geben |
| 5.6.3 | Keine Eigenwerbung im Checkout |
| 5.6.4 | Gleiche Produktinfos wie im Store anzeigen |
| 5.6.5 | Explizite Zustimmung vor Order Changes |
| 5.6.6 | Keine Countdown Timer im Checkout |
| 5.6.7 | Chat nur für Customer Service |
| 5.6.8 | Keine Standard Checkout-Feld-Daten sammeln |
| 5.6.9 | Keine Zahlungsinformationen in Extension |

</details>

#### 5.7 Sales Channel (Nicht relevant)

<details>
<summary>Sales Channel Requirements (5.7.1 - 5.7.18) - Aufklappen falls nötig</summary>

| Nr. | Anforderung |
|-----|-------------|
| 5.7.1 | `read_only_own_orders` Scope hinzufügen |
| 5.7.2 | Mit Polaris Components bauen |
| 5.7.3 | ResourceFeedback API nutzen |
| 5.7.4 | Publishing Section Details bereitstellen |
| 5.7.5 | Marketplace Link im Channel |
| 5.7.6 | Commission kommunizieren |
| 5.7.7 | T&C in neuem Fenster öffnen |
| 5.7.8 | Banners für Approval/Rejection |
| 5.7.9 | Polaris Cards in Publishing |
| 5.7.10 | Nach Install zur Account Section redirecten |
| 5.7.11 | Error Feedback in Publishing |
| 5.7.12 | Account Disconnection erlauben |
| 5.7.13 | Account-Informationen korrekt anzeigen |
| 5.7.14 | Kunden zu Shopify Checkout führen |
| 5.7.15 | Account Approval Process kommunizieren |
| 5.7.16 | Sales Attribution nutzen |
| 5.7.17 | Eligibility Issues kommunizieren |
| 5.7.18 | Navigation Icon (16x16 SVG) |

</details>

#### 5.8 Post-Purchase (Nicht relevant)

<details>
<summary>Post-Purchase Requirements (5.8.1 - 5.8.10) - Aufklappen falls nötig</summary>

| Nr. | Anforderung |
|-----|-------------|
| 5.8.1 | `write_checkout_extensions_apis` Scope |
| 5.8.2 | Transparenter Upsell mit Accept/Decline Buttons |
| 5.8.3 | Gleiche Produktinfos anzeigen |
| 5.8.4 | Max 2 konsekutive Requests an Buyer |
| 5.8.5 | Purchase Option Kategorie korrekt zuweisen |
| 5.8.6 | Zur Order Confirmation redirecten |
| 5.8.7 | CalloutBanner Component nutzen |
| 5.8.8 | Price Breakdown dynamisch updaten |
| 5.8.9 | Keine Third-Party Ads |
| 5.8.10 | Kein Order Tracking auf Post-Purchase Page |

</details>

#### 5.9 Mobile App Builders (Nicht relevant)

<details>
<summary>Mobile App Builder Requirements (5.9.1 - 5.9.3)</summary>

| Nr. | Anforderung |
|-----|-------------|
| 5.9.1 | Zu Sales Channel konvertieren |
| 5.9.2 | App Store Submission Info inkludieren |
| 5.9.3 | Theme Customization bereitstellen |

</details>

#### 5.10 Donation (Nicht relevant)

<details>
<summary>Donation Requirements (5.10.1 - 5.10.7)</summary>

| Nr. | Anforderung |
|-----|-------------|
| 5.10.1 | Hide Add-to-Cart Instructions |
| 5.10.2 | Nachweis der Spende im App Interface |
| 5.10.3 | Betriebskosten-Anteil angeben |
| 5.10.4 | Gemeinnützigkeitsstatus verifizieren |
| 5.10.5 | Theme App Block für Donations |
| 5.10.6 | PCI-konforme Sammlung |
| 5.10.7 | Donations über Shopify Checkout |

</details>

#### 5.11 Blockchain (Nicht relevant)

<details>
<summary>Blockchain Requirements (5.11.1 - 5.11.13)</summary>

| Nr. | Anforderung |
|-----|-------------|
| 5.11.1 | Keine Fungible Tokens verkaufen (außer Payment Partner) |
| 5.11.2 | NFT Order State Interface |
| 5.11.3 | Blockchain Transaction ID ins Tracking schreiben |
| 5.11.4 | Listing verhindern bis genehmigt |
| 5.11.5 | NFT Claim Message bereitstellen |
| 5.11.6 | Erstellung/Review aus Embedded App |
| 5.11.7 | Nur Creator Royalties |
| 5.11.8 | NFTs dürfen keine Securities sein |
| 5.11.9 | Nur Primary Sales |
| 5.11.10 | Wallet-Erstellung nach Kauf erlauben |
| 5.11.11 | Keine persönlichen Daten on-chain |
| 5.11.12 | Destination Email nicht editierbar |
| 5.11.13 | End-to-End Testing ermöglichen |

</details>

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

WICHTIG (Req 4.4.1): Keine SEO-Keywords, keine Statistiken im Subtitle!

App Description:
Ausführliche Beschreibung (min 200 Wörter)
- Was macht die App?
- Welche Probleme löst sie?
- Key Features
- Benefits für Merchants

WICHTIG (Req 4.3.3): Keine unbelegten Claims wie "the best", "the first",
"#1 translation app" etc. verwenden!

Key Features (min 3, max 5):
1. AI-powered product descriptions
2. Multi-language translation
3. Bulk content operations
4. SEO optimization
5. Custom content templates

App Category:
Marketing > Content & SEO

WICHTIG (Req 4.3.5): Tags müssen primäre App-Funktion widerspiegeln!

Pricing:
☑ Free plan available
☑ Paid plans available
Starting at: $9.99/month

WICHTIG (Req 4.2.1): Alle Pricing-Details korrekt angeben
(Trial-Dauer, Kosten pro Plan, etc.)
```

#### 2. Screenshots & Media

**Required:**
- Minimum 3 Screenshots (1280x720 oder 1920x1080)
- App Icon (512x512 PNG)
- **Demo Screencast (PFLICHT - Req 4.5.3!)** - Onboarding + Features demonstrieren, Englisch oder englische Untertitel

**Screenshot Rules (Req 4.2.2, 4.3.4, 4.3.6, 4.4.4):**
- KEINE Preise in Screenshots, Banner oder Icon
- KEINE unbelegten Statistiken oder Claims in Bildern
- KEINE Reviews oder Testimonials in Bildern
- Screenshots müssen aufgeräumt sein - Browser-Fenster und Hintergründe zuschneiden
- KEINE Shopify-Marken missbrauchen (Req 4.4.3)

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

#### 5. Submission-spezifische Pflichten

**Test-Credentials (Req 4.5.4, 4.5.5):**
- Account-Zugangsdaten in den Testing Instructions angeben
- Credentials müssen gültig sein und vollen Feature-Zugang gewähren
- Regelmäßig aktualisieren!

**Emergency Developer Contact (Req 4.5.6):**
- Im Partner Dashboard hinterlegen
- Kontakt für kritische technische Informationen von Shopify

**Sprachen im Listing (Req 4.3.2):**
- Nur Sprachen angeben, die KOMPLETT in der Merchant-UI unterstützt werden
- Teilweise Übersetzungen reichen nicht!

**Geografische Anforderungen (Req 4.3.8):**
- Standort- oder berechtigungsspezifische Requirements angeben
- Z.B. wenn bestimmte AI-APIs nur in bestimmten Regionen verfügbar sind

---

## ✅ App Review Checklist

Bevor du submitest, checke:

### 1. Policy Compliance:
- [ ] **Session Tokens** statt Third-Party Cookies (Req 1.1.1)
- [ ] App ist **web-basiert**, kein Desktop-Zwang (Req 1.1.12)
- [ ] **Nur faktische Informationen** verwendet (Req 1.1.4)
- [ ] Keine Merchant-Vermittlung an externe Agenturen (Req 1.1.14)

### 2. Billing:
- [ ] **Shopify Billing API** oder Managed Pricing implementiert (Req 1.2.1)
- [ ] Billing Accept/Decline korrekt gehandhabt (Req 1.2.2)
- [ ] Billing Charge Approval bei **Reinstall** korrekt (Req 1.2.2)
- [ ] **Plan-Wechsel ohne Support-Kontakt** möglich (Req 1.2.3)
- [ ] Upgrade UND Downgrade ohne Reinstall möglich (Req 1.2.3)

### 3. Functionality:
- [ ] App installiert **ohne kritische Errors** (Req 2.1.1)
- [ ] App hat **keine Minor UI Bugs** (Req 2.1.2)
- [ ] **Funktionale UI** - keine 404s, 500s, Web Errors (Req 2.1.3)
- [ ] **Daten korrekt synchronisiert** zwischen App und Shopify (Req 2.1.4)
- [ ] **Shopify APIs** korrekt genutzt (Req 2.2.1)
- [ ] **Konsistente Embedded Experience** (Req 2.2.2)
- [ ] **Neueste App Bridge** (`app-bridge.js` Script Tag) (Req 2.2.3)
- [ ] **Ausschließlich GraphQL Admin API** (kein REST!) (Req 2.2.4)
- [ ] Falls Admin Extensions: feature-complete, keine Promo (Req 2.2.5, 2.2.6)
- [ ] Falls Max Modal: nur bei Merchant-Interaktion (Req 2.2.7)

### 4. Installation:
- [ ] Installation nur über **Shopify Surface** (Req 2.3.1)
- [ ] **Sofort OAuth** nach Install (Req 2.3.2)
- [ ] **Redirect zur App UI** nach Installation (Req 2.3.3)
- [ ] **OAuth auch bei Reinstall** funktioniert (Req 2.3.4)

### 5. Security:
- [ ] **Gültiges TLS/SSL-Zertifikat** (Req 3.1.1)
- [ ] **Nur notwendige Access Scopes** angefordert (Req 3.2.x)
- [ ] Keine unnötigen Scopes wie `read_all_orders` (Req 3.2.1)

### 6. App Store Listing:
- [ ] **App-Name konsistent** zwischen Dashboard und Listing (Req 4.1.1)
- [ ] **App Icon** im Dev Dashboard hochgeladen (Req 4.1.2)
- [ ] **Pricing korrekt** und vollständig (Req 4.2.1)
- [ ] **Keine Preise in Screenshots/Banner/Icon** (Req 4.2.2)
- [ ] **Keine Preise außerhalb Pricing-Bereich** (Req 4.2.3)
- [ ] **Online Store Requirement** angegeben falls nötig (Req 4.3.1)
- [ ] **Nur komplett unterstützte Sprachen** gelistet (Req 4.3.2)
- [ ] **Keine unbelegten Claims** im Text (Req 4.3.3)
- [ ] **Keine unbelegten Claims** in Bildern (Req 4.3.4)
- [ ] **Tags korrekt** (Req 4.3.5)
- [ ] **Keine Reviews/Testimonials** in Bildern (Req 4.3.6)
- [ ] **Keine Reviews** im Listing-Text (Req 4.3.7)
- [ ] **Geografische Anforderungen** angegeben (Req 4.3.8)
- [ ] **Effektiver Subtitle** ohne SEO-Keywords (Req 4.4.1)
- [ ] **App Details** klar und ausführlich (Req 4.4.2)
- [ ] **Shopify-Marke** nicht missbraucht (Req 4.4.3)
- [ ] **Screenshots** aufgeräumt und fokussiert (Req 4.4.4)

### 7. Submission:
- [ ] **Demo Screencast** erstellt (PFLICHT!) (Req 4.5.3)
- [ ] **Test-Credentials** beigefügt und funktional (Req 4.5.4, 4.5.5)
- [ ] **Emergency Developer Contact** im Partner Dashboard (Req 4.5.6)

### 8. User Experience:
- [ ] Onboarding Flow für neue User
- [ ] Help/Support leicht findbar
- [ ] Error Messages sind hilfreich
- [ ] Mobile-responsive (embedded app)

### 9. Performance:
- [ ] Schnelle Ladezeiten (<3 Sekunden)
- [ ] Keine Console Errors
- [ ] Efficient API Usage (respects rate limits)

### 10. Compliance:
- [ ] Privacy Policy vorhanden und vollständig
- [ ] GDPR-compliant (wenn EU)
- [ ] Data handling transparent
- [ ] Uninstall löscht User-Daten (optional, aber empfohlen)

### 11. Documentation:
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
✓ Sicherstellen: Session Tokens (Req 1.1.1)
✓ Sicherstellen: Neueste App Bridge (Req 2.2.3)
✓ Sicherstellen: Nur GraphQL Admin API (Req 2.2.4)
✓ Sicherstellen: TLS/SSL Zertifikat (Req 3.1.1)
✓ Sicherstellen: Nur notwendige Scopes (Req 3.2.x)
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
- Teste Plan-Wechsel (Upgrade/Downgrade) (Req 1.2.3)
- Teste OAuth bei Reinstall (Req 2.3.4)
```

### Phase 4: App Store Submission
```
- Complete App Listing (alle Req 4.x beachten!)
- Upload Screenshots (keine Preise, keine Claims!)
- Demo Screencast erstellen (Req 4.5.3)
- Test-Credentials vorbereiten (Req 4.5.4)
- Emergency Contact hinterlegen (Req 4.5.6)
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
1. **Keywords** - In Titel & Description für SEO (aber NICHT im Subtitle! Req 4.4.1)
2. **Screenshots** - Zeige Value, nicht nur Features (keine Preise! Req 4.2.2)
3. **Reviews** - Bitte zufriedene User um Reviews (aber NICHT im Listing platzieren! Req 4.3.7)
4. **Updates** - Regelmäßige Updates = besseres Ranking

### Marketing:
1. **Landing Page** - Außerhalb Shopify für SEO
2. **Content Marketing** - Blog, Tutorials
3. **Social Proof** - Testimonials, Case Studies (nur auf eigener Seite, NICHT im Shopify Listing!)
4. **Partnerships** - Mit Agencies, Influencern

---

## 📞 Support & Resources

### Shopify Resources:
- **App Store Requirements**: https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements
- **Billing API**: https://shopify.dev/docs/apps/billing
- **App Design Guidelines**: https://polaris.shopify.com/
- **Partner Academy**: https://partner-training.shopify.com/
- **App Bridge**: https://shopify.dev/docs/api/app-bridge
- **GraphQL Admin API**: https://shopify.dev/docs/api/admin-graphql

### Community:
- Shopify Partners Slack
- Shopify Community Forums
- Reddit: r/shopifypartners

---

## 🎯 Next Steps für dich

1. **Entscheide Pricing Strategy** - Welches Model passt?
2. **Implement Billing** - Code anpassen (siehe oben)
3. **Prüfe Session Tokens** - Embedded App ohne Third-Party Cookies (Req 1.1.1)
4. **Prüfe App Bridge** - Neueste Version mit `app-bridge.js` Script Tag (Req 2.2.3)
5. **Prüfe GraphQL** - Kein REST API mehr! (Req 2.2.4)
6. **Prüfe TLS/SSL** - Gültiges Zertifikat (Req 3.1.1)
7. **Prüfe Access Scopes** - Nur notwendige anfordern (Req 3.2.x)
8. **Create Production App** - In Shopify Partners
9. **Test Billing Flow** - Auf Development
10. **Test Plan-Wechsel** - Upgrade/Downgrade ohne Support (Req 1.2.3)
11. **Test Reinstall OAuth** - OAuth muss bei Reinstall funktionieren (Req 2.3.4)
12. **Privacy Policy** - Erstellen & deployen
13. **Demo Screencast** - Erstellen (PFLICHT! Req 4.5.3)
14. **Test-Credentials** - Vorbereiten (PFLICHT! Req 4.5.4)
15. **Emergency Contact** - Im Partner Dashboard hinterlegen (Req 4.5.6)
16. **Screenshots** - Design & Produktion (keine Preise/Claims!)
17. **App Listing** - Ausfüllen in Partners (alle Req 4.x beachten)
18. **Beta Test** - Mit echten Usern
19. **Submit to App Store** - Final submission
