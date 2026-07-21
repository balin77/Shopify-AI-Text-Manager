# 📚 Dokumentation - Shopify AI Text Manager

Übersicht aller Projektdokumentationen.

## 📖 Verfügbare Dokumente

### 📍 Roadmap & Planning

| Dokument | Beschreibung |
|----------|--------------|
| [ROADMAP.md](ROADMAP.md) | **⭐ Product Roadmap** - Zukunftsvision, geplante Features, Timeline |
| [APP-STORE-READINESS.md](APP-STORE-READINESS.md) | App Store Launch Checklist - Status & nächste Schritte |
| [plans/](plans/) | Aktive Umsetzungs-Pläne (keywords, SEO-Suite, theme selection, translation coverage, batch translation) |

### 🚀 Deployment & Setup

| Dokument | Beschreibung |
|----------|--------------|
| [RAILWAY_DEPLOYMENT.md](RAILWAY_DEPLOYMENT.md) | **⭐ Custom Start Command** für Railway mit automatischen Migrationen |
| [PRODUCTION_DEPLOYMENT.md](PRODUCTION_DEPLOYMENT.md) | Production-Deployment-Checkliste |
| [PRISMA_MIGRATION_GUIDE.md](PRISMA_MIGRATION_GUIDE.md) | **Haupt-Guide** für Datenbank-Migrationen auf Railway |
| [WEBHOOK-SETUP-GUIDE.md](WEBHOOK-SETUP-GUIDE.md) | Setup-Anleitung für das Webhook-System |
| [API_KEY_ENCRYPTION_SETUP.md](API_KEY_ENCRYPTION_SETUP.md) | Setup der API-Key-Verschlüsselung |
| [SESSION_PII_ENCRYPTION_SETUP.md](SESSION_PII_ENCRYPTION_SETUP.md) | Setup der Session-PII-Verschlüsselung |
| [GOOGLE_SEARCH_CONSOLE_SETUP.md](GOOGLE_SEARCH_CONSOLE_SETUP.md) | OAuth-Setup für Google Search Console |

### 🏛️ Architektur

Dauerhaft gültige System-Design-Verträge und technische Konventionen. Siehe [architecture/](architecture/).

| Dokument | Beschreibung |
|----------|--------------|
| [architecture/SEO_SECTION_CONTRACT.md](architecture/SEO_SECTION_CONTRACT.md) | Architektur-Vertrag für alle SEO-Sections (Descriptor, Findings, Tasks, GDPR) |
| [architecture/PLAN_SYSTEM.md](architecture/PLAN_SYSTEM.md) | Subscription-Plan-System (4 Pläne, Gates, Limits) |
| [architecture/BILLING_SYSTEM.md](architecture/BILLING_SYSTEM.md) | Shopify-Billing-Integration (App-Subscription-Flow, Webhooks) |
| [architecture/GDPR_COMPLIANCE.md](architecture/GDPR_COMPLIANCE.md) | GDPR-Implementation (Compliance-Webhooks, `redactShopData`) |
| [architecture/SECURITY_IMPROVEMENTS.md](architecture/SECURITY_IMPROVEMENTS.md) | Sicherheits-Architektur (Verschlüsselung, Secret-Rotation) |
| [architecture/LOGGING_GUIDE.md](architecture/LOGGING_GUIDE.md) | Strukturiertes Logging mit Winston (Konventionen, „NIEMALS loggen"-Liste) |
| [architecture/THEME_RICHTEXT_HANDLING.md](architecture/THEME_RICHTEXT_HANDLING.md) | Theme-Richtext-Konvention (Autofix, Save-Error-Coverage) |

### 🛠️ Betrieb

| Dokument | Beschreibung |
|----------|--------------|
| [DATABASE_MAINTENANCE.md](DATABASE_MAINTENANCE.md) | Wartungsanleitung für Datenbank-Cleanup |
| [TESTING_GUIDE.md](TESTING_GUIDE.md) | Test-Setup und -Workflows |

### 🛒 Shopify App Store

| Dokument | Beschreibung |
|----------|--------------|
| [SHOPIFY-PUBLIC-APP-GUIDE.md](SHOPIFY-PUBLIC-APP-GUIDE.md) | Guide für die Public-App-Distribution |
| [SHOPIFY_APP_STORE_REQUIREMENTS.md](SHOPIFY_APP_STORE_REQUIREMENTS.md) | App-Store-Anforderungen |
| [SHOPIFY_APPROVAL_REQUIREMENTS.md](SHOPIFY_APPROVAL_REQUIREMENTS.md) | Approval-Prozess-Anforderungen |
| [SHOPIFY_COMPLIANCE_AUDIT.md](SHOPIFY_COMPLIANCE_AUDIT.md) | Compliance-Audit (Findings + Runbook) |

### 📚 Referenz

| Dokument | Beschreibung |
|----------|--------------|
| [SHOPIFY_TRANSLATABLE_CONTENT_TYPES.md](SHOPIFY_TRANSLATABLE_CONTENT_TYPES.md) | Komplette Liste aller Shopify Content-Types |
| [COMPETITIVE_ANALYSIS.md](COMPETITIVE_ANALYSIS.md) | Wettbewerbsanalyse + Feature-Gaps |
| [TECHNICAL_DEBT.md](TECHNICAL_DEBT.md) | Technical Debt aus Code-Reviews |
| [AI_PROVIDER_BALANCE_FEASIBILITY.md](AI_PROVIDER_BALANCE_FEASIBILITY.md) | Machbarkeitsanalyse: Restguthaben pro AI-Provider in Settings anzeigen (recherchiert, nicht umgesetzt) |

---

## 🎯 Quick Links

### Railway Deployment (Custom Start Command)
→ [RAILWAY_DEPLOYMENT.md](RAILWAY_DEPLOYMENT.md#custom-start-command)

### Neue Migration erstellen
→ [PRISMA_MIGRATION_GUIDE.md](PRISMA_MIGRATION_GUIDE.md#schnellanleitung)

### Webhooks einrichten
→ [WEBHOOK-SETUP-GUIDE.md](WEBHOOK-SETUP-GUIDE.md#deployment-schritte)

### Plan-System verstehen
→ [architecture/PLAN_SYSTEM.md](architecture/PLAN_SYSTEM.md#übersicht)

### Datenbank aufräumen
→ [DATABASE_MAINTENANCE.md](DATABASE_MAINTENANCE.md#solutions-implemented)

### Neue SEO-Section bauen
→ [architecture/SEO_SECTION_CONTRACT.md](architecture/SEO_SECTION_CONTRACT.md)

---

## 📝 Weitere Informationen

Die Hauptdokumentation der App findest du in [../README.md](../README.md).

**Letzte Aktualisierung:** 2026-07-21
