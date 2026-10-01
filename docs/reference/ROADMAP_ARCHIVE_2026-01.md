# Roadmap-Archiv — der Plan vom 2026-01-27

> Historischer Snapshot, unveraendert uebernommen (2026-09-12). Die App ist
> seit 2026-09 im App Store; die Phasen 1 und 2 sind damit Geschichte, die
> geplanten Features aus Phase 3/4 wurden kuratiert in
> [app/config/roadmap.server.ts](../../app/config/roadmap.server.ts) uebernommen — mit
> Status, ohne die Quartalsangaben, von denen keine gehalten hat. Was hier
> steht, wird nicht mehr gepflegt.

---

## Vision

ContentPilot AI wird die führende KI-gestützte Content-Management-Lösung für Shopify-Händler, die internationale Märkte erschließen und hochwertige, mehrsprachige Inhalte effizient erstellen möchten.

---

---

## Current Status: Pre-Launch (v1.0)

```
████████████████████░░░░░░░░ 70% App Store Ready
```

### Implementierte Features

| Feature | Status | Plan |
|---------|--------|------|
| Product Management | ✅ Complete | All |
| Collection Management | ✅ Complete | All |
| Page Management | ✅ Complete | Basic+ |
| Blog/Article Management | ✅ Complete | Pro+ |
| Policy Management | ✅ Complete | Basic+ |
| Menu Management | ✅ Complete | Pro+ |
| Theme Content Translation | ✅ Complete | Pro+ |
| AI Content Generation | ✅ Complete | All |
| Multi-Language Translation | ✅ Complete | All |
| Bulk Operations | ✅ Complete | All |
| Custom AI Instructions | ✅ Complete | Pro+ |
| Glossar/Terminologie (Settings-Tab + AI-Prompt-Injektion) | ✅ Complete (2026-07) | All |
| Billing System (4 Tiers) | ✅ Complete | - |
| GDPR Compliance | ✅ Complete | - |
| Webhook System | ✅ Complete | - |

---

---

## Phase 1: App Store Launch (Q1 2026)

**Ziel:** Erfolgreiche Veröffentlichung im Shopify App Store

### Milestone 1.1: Marketing Materials
- [ ] App Icon (512x512 PNG)
- [ ] Screenshots (1600x900, 3-5 Stück)
- [ ] Demo Video (30-90 Sekunden)
- [ ] App Store Beschreibung (DE/EN)

### Milestone 1.2: Beta Testing
- [ ] 5-10 Beta-Tester rekrutieren
- [ ] Feedback-Formular erstellen
- [ ] Alle Subscription-Flows testen
- [ ] Bugs identifizieren und beheben
- [ ] Testimonials sammeln

### Milestone 1.3: Quality Assurance
- [ ] Lighthouse Performance Test (<10 Punkte Reduktion)
- [ ] Chrome Incognito Kompatibilität
- [ ] Mobile Responsiveness
- [ ] Error Handling Review
- [ ] Security Audit

### Milestone 1.4: Submission
- [ ] App Store Listing finalisieren
- [ ] Shopify Review einreichen
- [ ] Review-Feedback bearbeiten
- [ ] **GO LIVE**

**Target Date:** Ende Februar 2026

---

---

## Phase 2: Post-Launch Optimization (Q2 2026)

**Ziel:** Erste Nutzer gewinnen, Feedback sammeln, optimieren

### Milestone 2.1: User Acquisition
- [ ] Launch-Ankündigung (Social Media, Blog)
- [ ] Partner-Outreach (Shopify Agencies)
- [ ] SEO-Optimierung der App Store Listing
- [ ] Content Marketing starten

### Milestone 2.2: User Feedback Integration
- [ ] In-App Feedback-System
- [ ] Feature-Request Tracking
- [ ] User-Interview-Programm
- [ ] NPS-Umfrage implementieren

### Milestone 2.3: Performance Optimization
- [ ] Caching-System verbessern
- [ ] API-Response-Zeiten optimieren
- [ ] Bulk-Operations beschleunigen
- [ ] Memory-Usage optimieren

### Milestone 2.4: First Major Update (v1.1)
- [ ] Top 3 Feature-Requests implementieren
- [ ] Bug Fixes aus User-Feedback
- [ ] UX-Verbesserungen
- [ ] Dokumentation erweitern

**Target Date:** Ende Mai 2026

---

---

## Phase 3: Feature Expansion (Q3-Q4 2026)

**Ziel:** Marktanteil ausbauen, Premium-Features

### Planned Features

#### 3.1 AI Enhancements
| Feature | Beschreibung | Priorität |
|---------|--------------|-----------|
| AI Tone Presets | Vordefinierte Schreibstile (professionell, casual, luxury) | High |
| Brand Voice Training | KI lernt den Markenstil des Shops | Medium |
| Competitor Analysis | KI analysiert Konkurrenz-Content | Low |
| A/B Testing Suggestions | KI schlägt Varianten vor | Medium |

#### 3.2 Content Features
| Feature | Beschreibung | Priorität |
|---------|--------------|-----------|
| Scheduled Translations | Zeitgesteuerte Übersetzungen | High |
| ~~Content Templates~~ | ~~Wiederverwendbare Vorlagen~~ ⛔ **verworfen 2026-07-19** — 2-Tages-Test ergab: `{{variables}}` lieferten der KI keine Info, die sie nicht ohnehin über die Handler-Prompt-Zeilen bekam (siehe `docs/reference/COMPETITIVE_ANALYSIS.md` §3.1 Punkt 5). Re-Einstieg nur bei echten Zusatz-Variablen (`{{brand}}`, `{{price}}`, `{{tags}}` etc. aus Shopify). | — |
| Version History | Änderungsverlauf für Content | Medium |
| Content Approval Workflow | Multi-User Freigabe-Prozess | Low |

#### 3.3 Analytics & Insights
| Feature | Beschreibung | Priorität |
|---------|--------------|-----------|
| Translation Dashboard | Übersetzungsfortschritt visualisieren | High |
| SEO Score Tracking | SEO-Performance über Zeit | Medium |
| Content Quality Metrics | Qualitätsbewertung der Texte | Medium |
| Usage Analytics | Nutzungsstatistiken für Merchants | Low |

#### 3.4 Integrations
| Feature | Beschreibung | Priorität |
|---------|--------------|-----------|
| DeepL Integration | Premium-Übersetzungen via DeepL | High |
| Google Translate Fallback | Backup-Übersetzung | Medium |
| Slack Notifications | Benachrichtigungen bei Completion | Low |
| Zapier Integration | Workflow-Automatisierung | Low |

**Target Date:** Ende 2026

---

---

## Phase 4: Enterprise & Scale (2027)

**Ziel:** Enterprise-Kunden, höhere Preisstufen, Skalierung

### Planned Features

#### 4.1 Enterprise Features
- [ ] **Multi-Store Management** - Ein Account für mehrere Shops
- [ ] **Team Collaboration** - Mehrere Benutzer pro Account
- [ ] **Role-Based Access** - Berechtigungssystem
- [ ] **White-Label Option** - Für Agenturen
- [ ] **API Access** - Externe Integration
- [ ] **SSO/SAML** - Enterprise Authentication
- [ ] **SLA & Priority Support** - Garantierte Response-Zeiten

#### 4.2 Advanced AI
- [ ] **Custom Model Training** - Eigenes KI-Modell pro Shop
- [ ] **Image Generation** - KI-generierte Produktbilder
- [ ] **Video Descriptions** - Automatische Video-Untertitel
- [ ] **Voice Content** - Text-to-Speech für Accessibility

#### 4.3 Localization
- [ ] **Regional Variants** - DE-DE vs DE-AT vs DE-CH
- [ ] **Currency Localization** - Preise in lokaler Währung
  - ⚠️ **Vor Umsetzung prüfen, ob überhaupt nötig** (Stand 2026-06-18).
  - Shopify rechnet **nativ und automatisch** in Lokalwährung um, sobald
    der Händler **Shopify Markets + Shopify Payments** nutzt: aktuelle
    Marktwechselkurse (Update alle paar Stunden), Anzeige im Storefront,
    Umrechnung an der Kasse **und** bei Refunds. Optional manuelle Kurse
    pro Markt via Managed Markets. Conversion Fee (0,5–2 % je nach Plan,
    ab 2026-04-06 auf Bruttobetrag berechnet) ist Shopify-seitig.
    Voraussetzungen: aktivierte Local Currency pro Markt, Country/Currency
    Selector im Theme, One-Page Checkout.
  - **Restlücke, in der ein eigener Converter Mehrwert hätte:**
    - Händler **ohne Shopify Payments** (PayPal-only, nicht unterstützte
      Länder) → bekommen keine native Checkout-Umrechnung.
    - Reine **Display-Anzeige** für Märkte, die der Händler in Shopify
      Markets (noch) nicht konfiguriert hat.
    - **Custom-Logik**: psychologische Preise (9,99 statt 9,87),
      eigene Rundungsregeln, mehrere Anzeige-Währungen gleichzeitig.
  - **Empfehlung:** Feature streichen oder auf **reinen Display-Switcher
    + Rundungsregeln** reduzieren, klar kommuniziert als „nur Anzeige,
    Abrechnung in Shop-Währung". Keine Doppelung von Shopify-Markets-
    Funktionalität bauen. Siehe auch Hinweise in
    [docs/reference/COMPETITIVE_ANALYSIS.md](reference/COMPETITIVE_ANALYSIS.md) §Switcher-Widget.
- [ ] **Cultural Adaptation** - Kulturspezifische Anpassungen
- [ ] **RTL Support** - Arabisch, Hebräisch

#### 4.4 New Pricing Tier

```
⭐ ENTERPRISE
├─ Custom Pricing (ab €199/Monat)
├─ Unlimited Everything
├─ Multi-Store Support
├─ Team Collaboration
├─ API Access
├─ Dedicated Support
└─ Custom SLA
```

**Target Date:** 2027

---

---

## Technical Roadmap

### Infrastructure

| Timeline | Improvement | Impact |
|----------|-------------|--------|
| Q2 2026 | Redis Caching | 50% faster API responses |
| Q2 2026 | CDN for Assets | Global performance boost |
| Q3 2026 | Background Job Queue (Bull) | Better bulk operations |
| Q4 2026 | Multi-Region Deployment | EU + US data centers |
| 2027 | Kubernetes Migration | Auto-scaling |

### Security

| Timeline | Improvement | Impact |
|----------|-------------|--------|
| Q2 2026 | Security Audit (External) | Compliance certification |
| Q3 2026 | SOC 2 Type 1 | Enterprise requirement |
| 2027 | SOC 2 Type 2 | Full compliance |
| 2027 | ISO 27001 | International standard |

### Monitoring

| Timeline | Improvement | Impact |
|----------|-------------|--------|
| Q1 2026 | Sentry Error Tracking | Better debugging |
| Q2 2026 | Datadog APM | Performance monitoring |
| Q3 2026 | Custom Analytics Dashboard | Business insights |
| 2027 | AI-Powered Alerting | Proactive issue detection |

---

---

## Success Metrics

### Phase 1 (Launch)
- **Installs:** 100+ in ersten 30 Tagen
- **Reviews:** 10+ mit 4+ Sternen
- **Conversion:** 5% Free → Paid

### Phase 2 (Growth)
- **Installs:** 500+ gesamt
- **MRR:** €1,000+
- **Churn Rate:** <10%

### Phase 3 (Scale)
- **Installs:** 2,000+ gesamt
- **MRR:** €5,000+
- **Retention:** 80%+ nach 3 Monaten

### Phase 4 (Enterprise)
- **Installs:** 5,000+ gesamt
- **MRR:** €20,000+
- **Enterprise Customers:** 10+

---

---

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| App Store Rejection | Medium | High | Thorough testing, follow guidelines |
| AI Provider Outage | Low | High | Multiple provider fallback |
| Competition | High | Medium | Unique features, better UX |
| Shopify API Changes | Medium | Medium | Stay updated, quick adaptation |
| Security Breach | Low | Critical | Regular audits, encryption |
| Scaling Issues | Medium | High | Infrastructure planning |

---

---

## Competitive Advantages

1. **Multi-AI Support** - Nicht an einen Anbieter gebunden
2. **Schweizer Datenschutz** - GDPR+ Compliance
3. **Faire Preise** - Günstiger als Konkurrenz
4. **Theme Translation** - Wenige bieten das
5. **Bulk Operations** - Effizienz-Fokus
6. **Deutsche Lokalisierung** - DACH-Markt

---

---

## Open Questions / Decisions Needed

- [ ] Annual Plans einführen? (20% Rabatt?)
- [ ] Affiliate-Programm starten?
- [ ] Shopify Plus nur-Features?
- [ ] Mobile App entwickeln?
- [ ] Chrome Extension?

---

---

## Changelog

| Date | Version | Changes |
|------|---------|---------|
| 2026-01-27 | 1.0 | Initial roadmap created |

---

**Document Owner:** Product Team
**Review Cycle:** Monthly
**Next Review:** 2026-02-27
