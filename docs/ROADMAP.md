# ContentPilot AI - Product Roadmap

**Last Updated:** 2026-01-27
**Version:** 1.0
**Status:** Pre-Launch

---

## Vision

ContentPilot AI wird die führende KI-gestützte Content-Management-Lösung für Shopify-Händler, die internationale Märkte erschließen und hochwertige, mehrsprachige Inhalte effizient erstellen möchten.

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
| ~~Content Templates~~ | ~~Wiederverwendbare Vorlagen~~ ⛔ **verworfen 2026-07-19** — 2-Tages-Test ergab: `{{variables}}` lieferten der KI keine Info, die sie nicht ohnehin über die Handler-Prompt-Zeilen bekam (siehe `docs/COMPETITIVE_ANALYSIS.md` §3.1 Punkt 5). Re-Einstieg nur bei echten Zusatz-Variablen (`{{brand}}`, `{{price}}`, `{{tags}}` etc. aus Shopify). | — |
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
    [docs/COMPETITIVE_ANALYSIS.md](COMPETITIVE_ANALYSIS.md) §Switcher-Widget.
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

## Pricing Evolution

### Current (v1.0) — wie im Code (`app/config/plans.ts`)

| Plan | Price | Products | Locales | Collections | Articles | Pages |
|------|-------|----------|---------|-------------|----------|-------|
| Free | €0 | 50 | ∞ | 5 | 0 | 0 |
| Basic | €9.90/mo | 100 | ∞ | 50 | 0 | 20 |
| Pro | €19.90/mo | 500 | ∞ | 100 | 100 | 50 |
| Max | €59.90/mo | 2500 | ∞ | 500 | 300 | 200 |

> Stand 2026-05: Limit-Struktur überarbeitet (geometrische Produkt-Staffelung,
> Locales bewusst unbegrenzt, Max-Preis €49.90 → €59.90). Begründung im
> Abschnitt [Limit-Review](#limit-review-mai-2026). Frühere Doku-Werte
> (Free 15/25, Basic 50/75 …) waren veraltet.

### Wettbewerber-Preis-Benchmark (Mai 2026, USD/Monat)

> Markt: ~150 Apps in der Shopify-Kategorie *Currency & Translation*; davon
> ~40–60 reine Übersetzungs-Apps. Dominiert von ~8–10 großen Playern.
> Quelle: Shopify App Store, abgerufen 2026-05-18.

| App | Free | Einstieg | Mitte | Top | Preis-Metrik |
|-----|------|----------|-------|-----|--------------|
| **Shopify Translate & Adapt** | ✅ vollständig gratis | — | — | — | — (2 Sprachen auto) |
| **T Lab – AI Translate** | ✅ | $11.99 | $29.99 | $59.99 | Sprachen + Produkte |
| **Weglot** | ✅ (2k Wörter) | $17 | $32 | $87 | übersetzte **Wörter** |
| **langify** | ✅ (5 Spr., manuell) | $17.50 | $29.95 | $59.95 | Sprachen + AI-Wörter |
| **GTranslate** | ✅ | $9.99 | $19.99 | $29.99 | Sprachen + URL-Übers. |
| **Transcy** | ✅ | $14.90 | $29 | $69 | Sprachen + Währung |
| **LangShop** | ✅ (50 Prod.) | $10 | $40 | $75 | Sprachen + **Produkte** |
| **Hextom AI Translate & Currency** | ✅ | $9.99 | ~$19.99 | $49.99 | Sprachen + Währung |
| **ContentPilot (wir)** | ✅ (50 Prod., ∞ Spr.) | €9.90 | €19.90 | €59.90 | **Produkte** + Content-Breite |

**Beobachtungen:**
- Free-Tier ist Marktstandard — unser 50-Produkte-Free (∞ Sprachen) ist
  konkurrenzfähig (vgl. LangShop-Free 50).
- Markt staffelt primär nach **Sprachen** (oder Wörtern bei Weglot). Wir
  staffeln nach **Produkten** — ungewöhnlich, aber sinnvoll, weil unser
  Kostentreiber DB-/Sync-Footprint ist, **nicht** AI-Tokens (Merchant bringt
  eigenen AI-Key → kein variabler AI-Kosten für uns).
- Unsere Locale-Großzügigkeit (**unbegrenzt Sprachen ab €0/€9.90** vs. LangShop
  $40 / Weglot $32 für nur 3) ist ein **echter USP** (weil AI-Kosten beim
  Merchant liegen). Sollte aktiv vermarktet werden.
- Preis-Niveau passt in den Markt; €/USD ≈ Parität → eher am unteren Rand.

### Planned (v2.0 - Q4 2026)

| Plan | Price | Products | New Features |
|------|-------|----------|--------------|
| Free | €0 | 50 | - |
| Basic | €14.90/mo | 100 | +Templates |
| Pro | €29.90/mo | 500 | +Analytics |
| Max | €79.90/mo | 2500 | +API Access |
| Enterprise | Custom | Unlimited | +Everything |

*Bestandskunden behalten ihre ursprünglichen Preise (Grandfathering)*

---

## Limit-Review (Mai 2026)

> Anlass: Review der Plan-Limits gegen Kostenmodell + Wettbewerb.
> **Kernerkenntnis:** AI-Tokens sind **BYO** (Merchant-Key, siehe
> `api-ai-handlers/shared.ts` / `ai-key-gate.test.ts`). Der reale Kostentreiber
> für uns ist **DB-Storage & Sync/Compute** (Produkte × Locales × Felder als
> `ContentTranslation`-Zeilen + WebP-/Bulk-Image-Compute), **nicht** AI.
> Limits sollten daher Storage/Compute abbilden, nicht AI-Volumen.

### Befund 1 — Produkt-Limit-Sprung war ökonomisch kaputt ✅ behoben

War: `25 → 75 → 150 → 5000`, Preis `0 → 9.90 → 19.90 → 49.90`. Pro→Max war
**33×** Menge bei **2.5×** Preis; die Mittelklasse (150–5000) zahlte pauschal,
Preis/Produkt nicht-monoton.
**Umgesetzt (2026-05):** geometrische Staffelung **50 → 100 → 500 → 2500**,
Max-Preis €49.90 → **€59.90**. Free von 25 auf 50 angehoben (besserer
Evaluierungs-Hook; Monetarisierung läuft über Content-Type-Gating, nicht
Free-Produktzahl). Optionales Enterprise-Tier später (`> 2500` / custom).

### Befund 2 — `maxLocales` wurde nicht durchgesetzt ✅ entschieden

`maxLocales` wurde nur in der Plan-Karte/Usage-Anzeige gelesen, von keinem
Übersetzungs-/Sync-Pfad erzwungen.
**Entscheidung (2026-05):** Locales **bewusst unbegrenzt** auf allen Tiers
(`maxLocales: Infinity`). Da AI-Tokens BYO sind, kosten Zusatzsprachen nichts —
Sprach-Großzügigkeit ist ein bewusster USP, Segmentierung läuft über Produkte/
Content-Breite. Anzeige zeigt „Unbegrenzt".

### Befund 3 — Bulk-Image-Upload / WebP ohne Mengen-Limit ✅ behoben

War: Bild-Tools (Pro+) hatten **keine** quantitative Grenze außer
`maxConcurrentWebpConversions`. Bulk-Upload + WebP-Konvertierung ist echter
Compute-/Bandbreiten-Kostentreiber → unbeschränktes Kostenrisiko auf Max.
**Umgesetzt (2026-05):** Rolling-Monats-Quota `monthlyImageOperations`
(Free 0 / Basic 0 / **Pro 2000 / Max 10000**), zählt Bulk-Upload-Ops +
WebP-Konvertierungen. Single Source of Truth: `PlanLimits` in
`config/plans.ts`; reine Helfer in `utils/planUtils.ts`
(`getMonthlyImageOperationsLimit`, `currentImageOpPeriod`,
`isWithinImageOperationQuota`); atomarer Verbrauch (Ganze-Batch-Semantik,
UTC-Monats-Reset, kein Cron) in `utils/imageOperations.server.ts` gegen
`ImageOperationCounter`. Erzwungen an den realen Pfaden
`api.staged-upload` (1 Op/Bild) und `api.convert-webp`
(`images.length` Ops, ganze Batch oder gar nichts) mit `422` +
`code:"IMAGE_QUOTA_EXCEEDED"`; graceful i18n-Meldung (de/en/es) in
`VariantImageManager` + `BulkImageUploadPanel`; Anzeige in
`SettingsUsageLimitsTab` (vorhandenes `UsageRow`/`disabled`-Pattern).
Bewusst **keine** Sync-Phase / kein Downgrade-Cleanup — Nutzungs-, keine
Entitlement-Daten; lazy erzwungen wie `maxProducts`
(`getSyncScope`/`planCacheCleanup` unberührt).

### Befund 4 — Pro vs. Max nur „mehr von allem" ✅ entschieden/behoben

War: identische `contentTypes`, `cacheEnabled`, `aiInstructionsEditable`,
`variantImageManager`; einziger Unterschied = numerische Caps + WebP-Parallelität.
**Entscheidung & Umsetzung (2026-05):** Da AI BYO ist, wird Pro→Max über die
**realen Kosten** differenziert, nicht über AI:
1. **Bild-Mengen-Quota** als primärer Differenzierer (Pro 2000 / Max 10000,
   Befund 3).
2. **WebP-Parallelität gespreizt** Pro 2 / **Max 6** (war 4). `maxConcurrent
   WebpConversions` ist jetzt zentralisiert in `config/webp-concurrency.js` —
   die früher hartkodierte Kopie + „keep in sync"-Kommentar in
   `webp-processor.service.js` wurde **entfernt** (Drift-Bug behoben); ein
   Drift-Guard-Test sichert die Parität. Die AI-Queue
   (`src/services/ai-queue.service.ts`) blieb bewusst unangetastet (global
   serialisiert; per-Plan-Concurrency dort ökonomisch schwach bei BYO-AI und
   risikoreich am Multi-Tenant-Kern).
Künftige echte Feature-Differenziale (Analytics/Glossar/Templates Pro-/Max-only)
bei neuen Features weiterhin mitdenken (siehe Status).

### Status & offene Punkte

- ✅ **Befund 1 behoben** — geometrische Caps 50/100/500/2500, Max €59.90.
- ✅ **Befund 2 entschieden** — Locales unbegrenzt (USP), nicht erzwungen.
- ✅ **Befund 3 behoben** — `monthlyImageOperations` Rolling-Quota
  (0/0/2000/10000), erzwungen an Upload-/Convert-Pfaden, Anzeige + i18n.
- ✅ **Befund 4 entschieden/behoben** — Pro→Max über reale Kosten
  differenziert: Bild-Quota + WebP-Parallelität 2/2/2/6 (zentralisiert,
  Drift-Bug behoben). Echtes Feature-Differenzial (Templates/Analytics/Glossar
  Pro-only) bei künftigen Features weiter mitdenken.

**Pricing-Strategie-Entscheid (2026-05):** Preise *nicht* breit senken. „Keine
AI-Kosten" = hohe Marge in *mehr Leistung pro Tier* investieren (∞ Sprachen,
großzügige Limits), nicht in niedrigeren Preis. Akquise-Hebel = Free-Tier +
Trial + Value-Story, nicht Preisdumping. Für Launch-Traction: zeitlich
begrenzte Promo / Lifetime-Deal für die ersten 20–50 Kunden (Reviews/Social-
Proof) statt dauerhaft niedriger Preise. Kein Grandfathering-Aufwand (noch
keine Kunden).

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

## Competitive Advantages

1. **Multi-AI Support** - Nicht an einen Anbieter gebunden
2. **Schweizer Datenschutz** - GDPR+ Compliance
3. **Faire Preise** - Günstiger als Konkurrenz
4. **Theme Translation** - Wenige bieten das
5. **Bulk Operations** - Effizienz-Fokus
6. **Deutsche Lokalisierung** - DACH-Markt

---

## Open Questions / Decisions Needed

- [ ] Annual Plans einführen? (20% Rabatt?)
- [ ] Affiliate-Programm starten?
- [ ] Shopify Plus nur-Features?
- [ ] Mobile App entwickeln?
- [ ] Chrome Extension?

---

## Resources & Links

- [App Store Readiness Checklist](APP-STORE-READINESS.md)
- [Billing System Documentation](BILLING_SYSTEM.md)
- [Security Documentation](SECURITY_IMPROVEMENTS.md)
- [Technical Debt & Future Improvements](TECHNICAL_DEBT.md)
- [Shopify App Store Requirements](https://shopify.dev/docs/apps/store/requirements)
- [Shopify Partner Dashboard](https://partners.shopify.com/)

---

## Changelog

| Date | Version | Changes |
|------|---------|---------|
| 2026-01-27 | 1.0 | Initial roadmap created |

---

**Document Owner:** Product Team
**Review Cycle:** Monthly
**Next Review:** 2026-02-27
