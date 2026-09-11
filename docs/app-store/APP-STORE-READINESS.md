# Shopify App Store - Readiness Checklist

**Last Updated:** 2026-09-11
**App Name:** ContentPilot AI
**Status:** 🟢 LIVE im Shopify App Store
**Listing:** https://apps.shopify.com/contentpilot-ai

---

## 📊 Launched

```
████████████████████████████ live
```

Dieses Dokument ist ab hier ein **Protokoll**, keine Arbeitsliste mehr. Was
noch offen ist, steht in zwei Abschnitten und nur dort: §9 (Beta-Testing, nie
durchgefuehrt) und die Post-Launch-Strategie am Ende, die jetzt die laufende
Arbeit beschreibt.

### Was ein Haken hier bedeutet

Die Abschnitte §7, §8, §10, §11 und §12 sind abgehakt, **weil Shopifys Review
sie prueft und die App zugelassen wurde** — Listing-Material, Listing-Text,
OAuth- und Installationsverhalten, Billing, Embedded-Erlebnis und die
Einreichung selbst kommen ohne diese Punkte nicht durch. Ein Haken dort heisst
also "von Shopify bestaetigt", nicht zwingend "einzeln von uns nachgemessen".
Der Unterschied ist beim naechsten Audit wichtig: eine Zulassung von 2026-09
sagt nichts ueber eine Anforderung, die Shopify spaeter hinzufuegt.

---

## ✅ COMPLETED (Ready for App Store)

### 1. Development & Production Infrastructure ✅
- [x] Development Environment (Railway)
  - Branch: `develop`
  - Auto-deploy: Active
  - Database: Separate PostgreSQL
  - URL: `https://shopify-ai-text-manager-development.up.railway.app`

- [x] Production Environment (Railway)
  - Branch: `master`
  - Manual deploy (controlled)
  - Database: Separate PostgreSQL
  - URL: `https://shopify-ai-text-manager-production.up.railway.app`

- [x] Git Workflow
  - `develop` → Development (Auto-deploy)
  - `master` → Production (Manual)
  - Clean separation

### 2. Shopify Apps Configuration ✅
- [x] Development App: "ContentPilot AI Dev"
  - Client ID: `433cf493223c0c6b95bdb91b0de5961a`
  - URLs configured correctly
  - OAuth working

- [x] Production App: "ContentPilot AI Beta"
  - Client ID: `05b7e4e9557741e79328007157527971`
  - URLs configured correctly
  - OAuth working

### 3. Pricing & Billing System ✅
**4 Subscription Tiers:**

```
🆓 FREE
├─ €0/Monat
├─ 15 Produkte max
├─ Featured Images only
└─ Products, Collections

💎 BASIC
├─ €9.90/Monat
├─ 50 Produkte max
├─ All Images
├─ 7 Tage Trial
└─ Products, Collections, Pages, Policies

🚀 PRO
├─ €19.90/Monat
├─ 150 Produkte max
├─ All Images
├─ 7 Tage Trial
├─ AI Instructions editierbar
└─ Products, Collections, Articles, Pages, Policies, Themes, Menus

⭐ MAX
├─ €49.90/Monat
├─ Unlimited Produkte
├─ All Images
├─ 7 Tage Trial
├─ AI Instructions editierbar
└─ Alle Content Types (inkl. Metaobjects, Metadata)
```

**Billing Features:**
- [x] Shopify Billing API Integration
- [x] Subscription Creation/Cancellation
- [x] Trial Period Support (7 Tage)
- [x] Feature Gating per Plan
- [x] Usage Limits Implementation
- [x] Billing UI with German Localization
- [x] Webhook Handler
- [x] Database Sync
- [x] Test Mode für Development

### 4. Legal & Compliance ✅
- [x] Privacy Policy (`/privacy`)
  - GDPR-compliant
  - Third-party AI disclosure
  - Data collection transparency
  - User rights documented
  - Security measures listed
  - Contact information

- [x] Terms of Service (`/terms`)
  - Subscription terms
  - Usage restrictions
  - Liability disclaimers
  - Cancellation policy
  - Intellectual property rights
  - Governing law (Switzerland)

**URLs:**
- Privacy: `https://shopify-ai-text-manager-production.up.railway.app/privacy`
- Terms: `https://shopify-ai-text-manager-production.up.railway.app/terms`

### 5. Technical Implementation ✅
- [x] Feature-complete AI Content System
- [x] Multi-language Translation
- [x] Bulk Operations
- [x] Theme Content Management
- [x] Product/Collection/Page/Policy Management
- [x] Cache System with Plan-based Limits
- [x] Error Handling
- [x] Loading States
- [x] Responsive UI

### 6. Contact Information & App Icon ✅
- [x] Contact Information Updated
  - Company Name: "Gubler - Multimedia und Print"
  - Support Email: gublerra@gmail.com
  - Last Updated: 2026-02-04
  - Updated in `privacy.tsx` and `terms.tsx`

- [x] App Icon Created
  - Size: 512x512 PNG ✅
  - Location: `public/app-icon.png`
  - Ready for Shopify Partner Dashboard upload
  - Design files in `psd/` (excluded from git)

---

## ✅ ERLEDIGT (war: TODO vor der Einreichung)

### 7. App Store Listing Materials 🎨

#### B. Screenshots (REQUIRED)
- [x] Create 3-5 screenshots (minimum 3, maximum 5)
- [x] Size: 1280x720 oder 1920x1080
- [x] Show key features and value proposition

**Suggested Screenshots:**
1. **Dashboard Overview**
   - Show main interface
   - Highlight key metrics/stats

2. **Product Translation in Action**
   - Before/After view
   - Multiple languages visible

3. **Bulk Operations**
   - Show efficiency (multiple products at once)
   - Progress indicator

4. **Billing/Plans Page**
   - Clear pricing
   - Feature comparison

5. **Content Management** (Optional)
   - Theme editor or unified content view
   - Advanced features

**Tools:**
- Browser DevTools for responsive view
- Cleanshot X / Snagit for capture
- Figma for annotation/polish
- Add annotations/highlights to show features

**Estimated Time:** 1 Tag (capture + polish)

#### C. Demo Video / Screencast (PFLICHT laut Shopify)
- [x] Screencast erstellen: Onboarding + Kernfunktionen Schritt-fuer-Schritt
- [x] Auf Englisch ODER mit englischen Untertiteln
- [x] Zeigt wie App eingerichtet und genutzt wird

**Tools:**
- Loom for screen recording
- ScreenFlow/Camtasia for editing
- Add captions/annotations

**Estimated Time:** 2-4 Stunden

---

### 8. App Store Listing Content 📝

#### A. App Description (REQUIRED)
- [x] Write compelling description (minimum 200 words)
- [x] Highlight key benefits (not just features)
- [x] Include use cases
- [x] SEO-friendly keywords

**Template Structure:**
```markdown
# Hook (1-2 sentences)
Transform your Shopify store content with AI-powered translation and optimization.

# What it does (2-3 sentences)
ContentPilot AI helps merchants create and translate product descriptions,
collections, pages, and more using advanced AI technology. Save hours of
manual work while maintaining high-quality, multilingual content.

# Key Benefits (4-5 bullet points)
• AI-Powered Content Generation
• Multi-language Translation
• Bulk Operations (save hours)
• Theme Content Management
• SEO Optimization

# Use Cases (2-3 scenarios)
Perfect for merchants who...
- Sell internationally and need multilingual content
- Have large catalogs and need efficient content management
- Want to improve SEO with better product descriptions

# How it works (3-4 steps)
1. Install the app
2. Choose your plan
3. Select content to translate/optimize
4. Let AI do the work

# Support
Dedicated support available via [support email]
```

**Estimated Time:** 2-3 Stunden

#### B. Tagline (REQUIRED)
- [x] Write catchy tagline (max 70 characters)

**Examples:**
- "AI-powered content creation for Shopify stores"
- "Translate and optimize your store content with AI"
- "Multilingual content made easy with AI"

**Estimated Time:** 30 Minuten

#### C. Key Features (REQUIRED)
- [x] List 3-5 key features

**Suggested:**
1. AI-Powered Translation & Content Generation
2. Bulk Operations for Efficiency
3. Multi-language Support (4+ languages)
4. Theme Content Management
5. Flexible Pricing with Free Tier

**Estimated Time:** 30 Minuten

#### D. App Category & Tags (REQUIRED)
- [x] Select appropriate category
- [x] Tags muessen primaere Funktionen widerspiegeln (Kategorie-Definitionen pruefen)

**Recommended:**
- Primary: **Marketing > Content & SEO**
- Secondary: **Productivity > Translation**

#### E. Listing-Compliance (Shopify-Pflicht)
- [x] App-Name in TOML-Datei und Einreichungsformular stimmen ueberein
- [x] App-Symbol identisch in Dev Dashboard und App-Listing
- [x] Keine Statistiken/Daten im Listing (keine Begriffe wie "die beste", "die erste", "die einzige")
- [x] Keine Bewertungen/Testimonials im Listing-Text (nur im offiziellen Review-Bereich)
- [x] Keine Shopify-Marken in App-Symbol, Banner oder Screenshots
- [x] Keine SEO-Keywords im Untertitel (nur sachliche Beschreibung)
- [x] Sprachen-Bereich: Nur Sprachen auflisten, in denen die App-UI verfuegbar ist
- [x] Preisinformationen vollstaendig: Trial-Zeitraum, alle Gebuehren, Plan-Details
- [x] Preisinfos NICHT in App-Logo oder andere nicht vorgesehene Bereiche

#### F. Test-Zugangsdaten fuer Shopify-Reviewer
- [x] Gueltige Test-Zugangsdaten fuer Review vorbereiten
- [x] Zugangsdaten gewaehren vollen Zugriff auf alle App-Funktionen
- [x] In Testanweisungen dokumentieren und aktuell halten

---

### 9. Beta Testing 🧪 — NICHT durchgefuehrt, durch den Launch ueberholt

> **Bewusst nicht abgehakt.** Ein formales Beta-Programm hat es nie gegeben;
> die App ist ohne eines durch die Shopify-Review gegangen und live. Diese
> Haken zu setzen wuerde ein Testprogramm protokollieren, das nicht
> stattgefunden hat — und der naechste Leser (auch ein Audit) wuerde daraus
> schliessen, die Punkte darunter seien mit echten Testern geprueft worden.
>
> Die Liste bleibt trotzdem stehen, weil sie die richtigen Fragen enthaelt.
> Was sie leistet, leisten jetzt echte Installationen: Rueckmeldungen,
> Bewertungen und Fehlerberichte aus dem App Store. Wer ein Beta-Programm fuer
> ein groesseres Feature aufsetzt, hat hier die Vorlage.

- [ ] Recruit 5-10 beta testers
- [ ] Create feedback form/survey
- [ ] Test all subscription flows
- [ ] Identify and fix bugs
- [ ] Collect testimonials

**Where to Find Beta Testers:**
- Shopify Partners Slack
- Reddit: r/shopify, r/ecommerce
- Facebook Groups (Shopify merchants)
- Your own network
- Beta testing platforms (BetaList)

**What to Test:**
- [ ] Installation flow
- [ ] Onboarding experience
- [ ] Each subscription plan
- [ ] Upgrade/downgrade flow
- [ ] Content translation quality
- [ ] Bulk operations
- [ ] Error handling
- [ ] Mobile responsiveness
- [ ] Uninstall flow

**Estimated Time:** 1-2 Wochen

---

### 10. Shopify-Pflicht-Anforderungen (aus SHOPIFY_APP_STORE_REQUIREMENTS.md)

#### A. Eingebettetes Erlebnis & App Bridge
- [x] App Bridge (`app-bridge.js`) eingebunden als erstes Script-Tag (root.tsx:44)
- [x] **MANUELL PRUEFEN**: Alle Funktionen vollstaendig im Shopify-Admin eingebettet (keine externen Seiten)
- [x] **MANUELL PRUEFEN**: Max-Modal startet NICHT automatisch (nur durch Benutzerinteraktion)
- [x] **CODEFIX ERLEDIGT**: localStorage/sessionStorage komplett entfernt (2026-02-14)
  - localStorage entfernt aus: ReloadButton.tsx, app.content.tsx, app.products.tsx
  - sessionStorage entfernt aus: useAppNavigation.ts, app._index.tsx, app.tsx, useUnifiedContentEditor.ts, app.products.tsx
  - Ersetzt durch: URL-Parameter (Navigation/Reload-Loop) + In-Memory-Map (Translation-Timing)
- [x] App funktioniert im Chrome Inkognito-Modus (getestet 2026-02-14)

#### B. OAuth & Installation
- [x] OAuth greift sofort - kein UI-Zugriff vor Authentifizierung
- [x] Nach OAuth-Akzeptierung: Weiterleitung zur App-UI
- [x] Reinstall-Flow: App funktioniert nahtlos nach Deinstallation + Neuinstallation
- [x] Keine manuelle Eingabe von myshopify.com-URL waehrend Installation

> **Achtung bei der Website.** Genau dieser Punkt ist der Grund, warum
> `/install` auf der oeffentlichen Website (siehe
> [app/routes/_public.($lang).install.tsx](../../app/routes/_public.\($lang\).install.tsx))
> heute nur noch ein 302 auf das App-Store-Listing ist. Das Formular dahinter
> fragt die `.myshopify.com`-Adresse ab — es existiert ausschliesslich als
> Fallback fuer `MARKETING_SITE.appStoreUrl === null`, also fuer den Zustand
> VOR der Veroeffentlichung. Wer diese Konstante je wieder auf `null` setzt,
> stellt den Haken oben mit in Frage.

#### C. API-Scopes Audit
- [x] **CODEFIX ERLEDIGT**: 3 ueberflüssige Scopes entfernt aus shopify.app.toml (2026-02-14):
  - `write_online_store_navigation`, `write_product_listings`, `write_themes`
  - `write_products` behalten (wird fuer productUpdate/productUpdateMedia in Hauptsprache benoetigt)
- [x] Keine sensiblen Scopes (read_all_orders, write_customer_payment_methods, etc.) angefordert

#### D. Abrechnung
- [x] Upgrade/Downgrade ohne Support-Kontakt und ohne Neuinstallation moeglich
- [x] Gebuehren erscheinen korrekt im Shopify-Admin unter "Verlauf der Anwendungsgebühren"
- [x] Bei Neuinstallation: erneute Gebuehren-Genehmigung wird angefordert

#### E. Datensynchronisation
- [x] Uebersetzungsdaten konsistent zwischen Shopify-Admin, App-UI und Datenbank
- [x] Keine verwaisten oder inkonsistenten Daten nach Sync-Operationen

#### F. Webfehler
- [x] ErrorBoundary in root.tsx fuer 404/500 mit benutzerfreundlicher UI implementiert
- [x] ErrorBoundary in app.tsx fuer App-Layout-Fehler + Manifest-Mismatch-Handling
- [x] Catch-all Routes fuer Auth (auth.$.tsx) und API (api.templates.$.tsx)
- [x] **MANUELL PRUEFEN**: Alle 14 App-Routen durchklicken und auf HTTP-Fehler pruefen
- [x] **MANUELL PRUEFEN**: Alle 19 API-Routen auf korrekte Fehlerbehandlung testen

---

### 11. Quality Assurance Checklist

#### Functionality
- [x] App installs without errors
- [x] OAuth flow works correctly
- [x] All features function as expected
- [x] Billing/subscription flow works
- [x] Trial period activates correctly
- [x] Upgrade/downgrade works
- [x] Cancellation works
- [x] Uninstall is clean (data removal)

#### User Experience
- [x] Onboarding is clear
- [x] Help/Support is accessible
- [x] Error messages are helpful
- [x] Loading states are clear
- [x] Success confirmations visible
- [x] Mobile-friendly (Polaris ensures this)

#### Performance
- [x] Pages load in <3 seconds
- [x] No console errors
- [x] API calls are efficient
- [x] Rate limits respected

#### Security
- [x] No credentials in code
- [x] Proper encryption (AES-256)
- [x] HTTPS everywhere
- [x] Input validation
- [x] SQL injection protected (Prisma handles)

#### Compliance
- [x] Privacy Policy accurate and complete
- [x] Terms of Service cover all scenarios
- [x] GDPR requirements met
- [x] Data handling transparent
- [x] Uninstall deletes user data (or clearly states retention)

---

### 12. Shopify App Store Submission 🚀

#### Pre-Submission Checklist
- [x] All above sections completed
- [x] App tested on Production environment
- [x] No critical bugs
- [x] Documentation reviewed
- [x] Screenshots/media uploaded
- [x] Listing content polished

#### Submission Steps
1. [x] Go to Shopify Partners → Your App
2. [x] Click "App listing"
3. [x] Fill in all required fields:
   - App name
   - Tagline
   - Description
   - Key features
   - Screenshots (3-5)
   - App icon
   - Category
   - Privacy policy URL
   - Support email
4. [x] Review everything twice
5. [x] Submit for review
6. [x] Wait for Shopify response (2-4 weeks)

#### During Review
- [x] Monitor email for Shopify feedback
- [x] Respond quickly to any questions
- [x] Make requested changes if needed
- [x] Be patient (review can take time)

#### After Approval
- [x] Celebrate! 🎉
- [x] Announce launch (social media, blog, etc.)
- [x] Monitor initial installations
- [x] Respond to user feedback
- [x] Provide excellent support

---

## 📅 Suggested Timeline (historisch)

> Der Plan von 2026-02. Er ist aufgegangen: die App ist seit 2026-09 live.
> Die offenen Haken hier sind Planungsartefakte und werden nicht mehr
> nachgezogen — was davon wirklich passiert ist, steht in den Abschnitten
> darueber.

### Week 1 (damals)
- [x] Complete Privacy Policy & Terms ✅
- [x] Update contact information ✅
- [x] Design app icon (or commission) ✅
- [ ] Start planning screenshots

### Week 2
- [ ] Create screenshots
- [ ] Write app store listing
- [ ] Start recruiting beta testers
- [ ] Polish UI/UX based on own testing

### Week 3-4
- [ ] Beta testing in progress
- [ ] Fix identified bugs
- [ ] Collect testimonials
- [ ] Final QA

### Week 5
- [ ] Final review of all materials
- [ ] Double-check compliance
- [ ] Submit to App Store
- [ ] Begin waiting period

### Week 6-9 (Shopify Review)
- Wait for Shopify review
- Respond to any feedback
- Make requested changes

### Week 10
- 🎉 **GO LIVE!**

**Total Timeline:** ~8-10 weeks from today to live app

---

## 💰 Estimated Costs (historisch)

### Required
- **App Icon Design:** €0-50 (DIY vs outsource)
- **Total Required:** €0-50

### Optional
- **Premium Screenshots:** €50-150 (professional designer)
- **Demo Video:** €100-300 (professional videographer)
- **Beta Tester Incentives:** €0-100 (optional discounts/gifts)
- **Total Optional:** €150-550

**Grand Total: €0-600**
(Most can be done DIY for near-zero cost)

---

## 🎯 Critical Path (Must Do)

**Cannot skip these:**
1. ✅ Privacy Policy & Terms
2. ✅ Update contact information
3. ✅ App Icon
4. ✅ Screenshots
5. ✅ App Listing
6. ❌ Beta Testing — **uebersprungen.** Stand hier als "cannot skip" und wurde
   trotzdem nie gemacht; die App ist ohne es zugelassen worden. Festgehalten,
   weil eine Liste, die ihre eigene Verletzung verschweigt, beim naechsten Mal
   wieder als verbindlich gelesen wird.
7. ✅ QA Checklist
8. ✅ Submit — zugelassen, live seit 2026-09

**Everything else is optional or nice-to-have.**

---

## 📞 Support & Resources

### Shopify Resources
- **App Store Requirements:** https://shopify.dev/docs/apps/store/requirements
- **App Listing Guide:** https://shopify.dev/docs/apps/store/listing
- **Partner Academy:** https://partner-training.shopify.com/

### Community
- **Shopify Partners Slack:** https://shopifypartners.slack.com
- **Community Forums:** https://community.shopify.com/
- **Reddit:** r/shopifypartners

### Tools
- **Screenshot Tools:** Cleanshot X, Snagit, ScreenFlow
- **Icon Design:** Figma, Canva, Affinity Designer
- **Video:** Loom, ScreenFlow, Camtasia

---

## ✨ Quick Wins for Better Approval Chances

1. **Professional Screenshots:** First impression matters
2. **Clear Value Proposition:** Make benefits obvious
3. **Demo Video:** Shows vs tells
4. **Social Proof:** Beta tester testimonials
5. **Excellent Documentation:** Help center/FAQ
6. **Responsive Support:** Quick response time promise
7. **Transparent Pricing:** No hidden fees
8. **Free Tier:** Lowers barrier to entry

---

## 🚫 Common Rejection Reasons (Avoid These)

1. ❌ Incomplete privacy policy
2. ❌ Poor quality screenshots
3. ❌ Confusing app description
4. ❌ Non-functional features
5. ❌ Broken OAuth flow
6. ❌ Missing billing implementation
7. ❌ Security vulnerabilities
8. ❌ Poor user experience
9. ❌ Insufficient testing
10. ❌ Unresponsive support

**You're already avoiding most of these!** ✅

---

## 📈 Post-Launch Strategy — AB HIER LAEUFT ES

Der einzige Abschnitt dieses Dokuments, der noch Zukunft beschreibt.

### Week 1-2 After Launch
- Monitor installations closely
- Respond to ALL user feedback quickly
- Fix any critical bugs immediately
- Start collecting reviews

### Month 1
- Gather user feedback
- Identify feature requests
- Plan first update
- Start marketing efforts

### Month 2-3
- Release first major update
- Improve based on user feedback
- Optimize conversion funnel (free → paid)
- Expand marketing

### Long-term
- Regular updates (monthly)
- Add requested features
- Expand language support
- Consider annual plans
- Build community

---

## 🎉 Current Status Summary

**Die App ist seit 2026-09 im Shopify App Store:**
https://apps.shopify.com/contentpilot-ai

**Was der Launch beweist** (Shopify prueft es, sonst keine Zulassung):
- ✅ Embedded-Erlebnis + App Bridge, kein Zugriff vor OAuth
- ✅ Installation, Reinstall und Weiterleitung in die App-UI
- ✅ Billing: Plaene, Trial, Upgrade/Downgrade ohne Support-Kontakt
- ✅ Listing-Material (Screenshots, Screencast) und Listing-Text
- ✅ Listing-Compliance: keine Shopify-Marken, keine Statistiken, keine
  Testimonials, vollstaendige Preisangaben
- ✅ Privacy Policy und Terms, GDPR-Webhooks

**Was der Launch NICHT beweist und hier offen bleibt:**
- ⚠️ **Beta-Testing (§9) hat nie stattgefunden.** Bewusst nicht abgehakt —
  Begruendung steht im Abschnitt selbst.
- ⚠️ Eine Zulassung ist eine Momentaufnahme. Shopify aendert die
  Anforderungen; dieses Dokument altert ab dem Tag der Zulassung.

**Wo die Website dazugehoert:**
Die oeffentliche Produktseite (`/`, `/features`, `/videos`, dreisprachig) liegt
im selben Repo und im selben Railway-Service wie die App. Jeder
Install-Button dort zeigt auf das Listing; `/install` ist nur noch der
Fallback-Redirect. Siehe die §10-B-Notiz oben.

**Was jetzt laeuft:** siehe Post-Launch Strategy.

---

Last Updated: 2026-09-11
