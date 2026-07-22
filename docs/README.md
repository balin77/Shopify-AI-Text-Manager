# 📚 Dokumentation — ContentPilot

Nur zwei Dokumente liegen direkt hier: dieser Index und die Roadmap. Alles andere ist
nach Zweck sortiert.

| Ordner | Inhalt | Lebensdauer |
|--------|--------|-------------|
| [architecture/](architecture/) | System-Design-Verträge und Konventionen | dauerhaft gültig |
| [setup/](setup/) | Deployment- und Einrichtungs-Anleitungen | gültig, bis sich die Infrastruktur ändert |
| [operations/](operations/) | Runbooks für den laufenden Betrieb | gültig, bis sich der Betrieb ändert |
| [app-store/](app-store/) | Shopify-App-Store: Anforderungen, Compliance, Launch | bis zum Launch bzw. Policy-Update |
| [reference/](reference/) | Nachschlagewerke und Recherchen | Snapshot mit Datum |
| [plans/](plans/) | Aktive Umsetzungs-Pläne | wird nach Abschluss in `architecture/` überführt und gelöscht |

> **Wohin gehört ein neues Dokument?** Beschreibt es, **wie das System funktioniert** →
> `architecture/`. Beschreibt es, **wie man etwas einmalig einrichtet** → `setup/`.
> Beschreibt es, **was man tut, wenn X passiert** → `operations/`. Ist es ein Plan für
> noch nicht gebaute Arbeit → `plans/` (und nach der Umsetzung als Contract nach
> `architecture/` extrahieren).

---

## 📍 Direkt hier

| Dokument | Beschreibung |
|----------|--------------|
| [ROADMAP.md](ROADMAP.md) | **⭐ Product Roadmap** — Vision, geplante Features, Timeline, Pricing |

## 🏛️ Architektur — [architecture/](architecture/)

Dauerhaft gültige Verträge. Wenn Code und Doku sich widersprechen, gilt der Code — dann
die Doku korrigieren.

| Dokument | Beschreibung |
|----------|--------------|
| [SYNC_AND_WEBHOOKS.md](architecture/SYNC_AND_WEBHOOKS.md) | Webhook-Topics, HMAC/Async-Contract, Retry, Drift-Reconcile, Scheduler-Parameter |
| [DATA_RETENTION_AND_CLEANUP.md](architecture/DATA_RETENTION_AND_CLEANUP.md) | Was der stündliche Cleanup löscht + Retention-Pflicht für neue Tabellen |
| [THEME_SELECTION.md](architecture/THEME_SELECTION.md) | Theme-Auswahl (Option B-lite), Theme-Scoping von Sync und Translations |
| [TRANSLATION_COVERAGE.md](architecture/TRANSLATION_COVERAGE.md) | Abdeckung der übersetzbaren Shopify-Ressourcen |
| [AI_BATCH_TRANSLATION.md](architecture/AI_BATCH_TRANSLATION.md) | Batch-Übersetzung über die AI-Provider |
| [THEME_RICHTEXT_HANDLING.md](architecture/THEME_RICHTEXT_HANDLING.md) | Richtext-Konvention für Theme-Settings (Autofix, Save-Error-Coverage) |
| [SEO_SECTION_CONTRACT.md](architecture/SEO_SECTION_CONTRACT.md) | Vertrag für alle SEO-Sections (Descriptor, Findings, Tasks, GDPR) |
| [KEYWORDS_CONTRACT.md](architecture/KEYWORDS_CONTRACT.md) | Keyword-System (Assignments, AI-Verteilung, Recherche, Kannibalisierung) |
| [PLAN_SYSTEM.md](architecture/PLAN_SYSTEM.md) | Subscription-Pläne, Gates, Limits |
| [BILLING_SYSTEM.md](architecture/BILLING_SYSTEM.md) | Shopify-Billing-Integration (Subscription-Flow, Webhooks) |
| [GDPR_COMPLIANCE.md](architecture/GDPR_COMPLIANCE.md) | Compliance-Webhooks, `redactShopData` |
| [SECURITY_IMPROVEMENTS.md](architecture/SECURITY_IMPROVEMENTS.md) | Verschlüsselung, Secret-Rotation-Runbook |
| [LOGGING_GUIDE.md](architecture/LOGGING_GUIDE.md) | Strukturiertes Logging mit Winston, „NIEMALS loggen"-Liste |

## 🚀 Setup & Deployment — [setup/](setup/)

| Dokument | Beschreibung |
|----------|--------------|
| [RAILWAY_DEPLOYMENT.md](setup/RAILWAY_DEPLOYMENT.md) | **⭐ Custom Start Command** für Railway mit automatischen Migrationen |
| [PRODUCTION_DEPLOYMENT.md](setup/PRODUCTION_DEPLOYMENT.md) | Production-Deployment-Checkliste |
| [PRISMA_MIGRATION_GUIDE.md](setup/PRISMA_MIGRATION_GUIDE.md) | **Haupt-Guide** für Datenbank-Migrationen auf Railway |
| [WEBHOOK-SETUP-GUIDE.md](setup/WEBHOOK-SETUP-GUIDE.md) | Webhooks registrieren und initialen Sync fahren |
| [API_KEY_ENCRYPTION_SETUP.md](setup/API_KEY_ENCRYPTION_SETUP.md) | Setup der API-Key-Verschlüsselung |
| [SESSION_PII_ENCRYPTION_SETUP.md](setup/SESSION_PII_ENCRYPTION_SETUP.md) | Setup der Session-PII-Verschlüsselung |
| [GOOGLE_SEARCH_CONSOLE_SETUP.md](setup/GOOGLE_SEARCH_CONSOLE_SETUP.md) | OAuth-Setup für Google Search Console |

## 🛠️ Betrieb — [operations/](operations/)

| Dokument | Beschreibung |
|----------|--------------|
| [DATABASE_MAINTENANCE.md](operations/DATABASE_MAINTENANCE.md) | Runbook: DB-Größe prüfen, Cleanup fahren, Disk-Full beheben |
| [TESTING_GUIDE.md](operations/TESTING_GUIDE.md) | Test-Setup, Mock-Factories, Workflows |

## 🛒 App Store — [app-store/](app-store/)

| Dokument | Beschreibung |
|----------|--------------|
| [APP-STORE-READINESS.md](app-store/APP-STORE-READINESS.md) | Launch-Checkliste — Status & nächste Schritte |
| [SHOPIFY_COMPLIANCE_AUDIT.md](app-store/SHOPIFY_COMPLIANCE_AUDIT.md) | Compliance-Audit (Blocker, Risiken, Runbook) |
| [SHOPIFY_APPROVAL_REQUIREMENTS.md](app-store/SHOPIFY_APPROVAL_REQUIREMENTS.md) | Genehmigungs-Pflichten inkl. Schwellenwerte und Quellen |
| [SHOPIFY_APP_STORE_REQUIREMENTS.md](app-store/SHOPIFY_APP_STORE_REQUIREMENTS.md) | Anforderungs-Kurzreferenz nach Kategorie |
| [SHOPIFY-PUBLIC-APP-GUIDE.md](app-store/SHOPIFY-PUBLIC-APP-GUIDE.md) | Public-App-Distribution von Development bis Listing |

## 📚 Referenz — [reference/](reference/)

| Dokument | Beschreibung |
|----------|--------------|
| [SHOPIFY_TRANSLATABLE_CONTENT_TYPES.md](reference/SHOPIFY_TRANSLATABLE_CONTENT_TYPES.md) | Komplette Liste aller übersetzbaren Shopify-Content-Types |
| [COMPETITIVE_ANALYSIS.md](reference/COMPETITIVE_ANALYSIS.md) | Wettbewerbsanalyse + Feature-Gaps |
| [TECHNICAL_DEBT.md](reference/TECHNICAL_DEBT.md) | Technical Debt aus Code-Reviews |
| [AI_PROVIDER_BALANCE_FEASIBILITY.md](reference/AI_PROVIDER_BALANCE_FEASIBILITY.md) | Machbarkeitsanalyse Restguthaben pro AI-Provider (recherchiert, nicht umgesetzt) |

## 📋 Pläne — [plans/](plans/)

| Dokument | Beschreibung |
|----------|--------------|
| [PLAN_SEO_SUITE_COMPLETION.md](plans/PLAN_SEO_SUITE_COMPLETION.md) | Fertigstellung der SEO-Suite |

---

## 🎯 Quick Links

- **Railway Custom Start Command** → [setup/RAILWAY_DEPLOYMENT.md](setup/RAILWAY_DEPLOYMENT.md#custom-start-command)
- **Neue Migration erstellen** → [setup/PRISMA_MIGRATION_GUIDE.md](setup/PRISMA_MIGRATION_GUIDE.md#schnellanleitung)
- **Webhooks einrichten** → [setup/WEBHOOK-SETUP-GUIDE.md](setup/WEBHOOK-SETUP-GUIDE.md#deployment-schritte)
- **Wie Sync & Webhooks funktionieren** → [architecture/SYNC_AND_WEBHOOKS.md](architecture/SYNC_AND_WEBHOOKS.md)
- **Datenbank läuft voll** → [operations/DATABASE_MAINTENANCE.md](operations/DATABASE_MAINTENANCE.md#wenn-die-datenbank-wieder-vollläuft)
- **Plan-System verstehen** → [architecture/PLAN_SYSTEM.md](architecture/PLAN_SYSTEM.md#übersicht)
- **Neue SEO-Section bauen** → [architecture/SEO_SECTION_CONTRACT.md](architecture/SEO_SECTION_CONTRACT.md)

---

Die Hauptdokumentation der App liegt in [../README.md](../README.md), die
Architektur-Kurzfassung für Claude Code in [../CLAUDE.md](../CLAUDE.md).

**Letzte Aktualisierung:** 2026-07-21
