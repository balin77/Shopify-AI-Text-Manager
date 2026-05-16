# Shopify App Store Compliance-Audit — ContentPilot

> **Erstellt:** 2026-05-16 · **Branch:** `develop` · **Methode:** Code-Audit gegen
> `docs/SHOPIFY_APPROVAL_REQUIREMENTS.md` + parallele Subagenten (Webhooks, KI-Datenfluss,
> Auth/App-Bridge, Billing, Protected Customer Data).
>
> Repo-Doku wurde **gegen den echten Code verifiziert** – mehrere Doku-Aussagen sind
> nachweislich veraltet/falsch (siehe Abschnitt „Doku-Abweichungen").
>
> **Legende:** 🔴 BLOCKER (führt sicher zu Ablehnung/Entfernung) · 🟠 RISIKO
> (wahrscheinlich beanstandet / BFS-Verlust) · 🟡 HINWEIS (Best Practice).

---

## Management Summary

| Stufe | Anzah| Kernpunkte |
|---|---|---|
| 🔴 BLOCKER | 3 (+1 ✅ behoben: B1) | Off-Platform-Billing-Bypass `APP_ENV=development`, Session-PII unverschlüsselt trotz gegenteiliger Doku, fehlende KI-Consent/Disclosure (B1 `/api/update-plan` entfernt) |
| 🟠 RISIKO | 8 | Cross-Tenant-Lösch-Bug, fehlende Lösch-/Retention-Jobs, nicht angewandter Free-Trial, geleakte Secrets, unvollständige Privacy-Disclosure |
| 🟡 HINWEIS | 7 | App-Bridge-Placement, toter REST-Client, Doku-Inkonsistenzen, Webhook-Registrierung |

Die App ist in **Auth/Embedding/App-Bridge** und **grundsätzlicher Billing-API-Nutzung**
solide. Die schwerwiegenden Probleme liegen in **Billing-Bypass-Routen**, **KI-Datenfluss-
Transparenz/Consent** (für eine KI-App der kritischste Bereich) und **Datenschutz/Löschung**.

---

## 🔴 BLOCKER

### B1 — `/api/update-plan` vergibt jeden Bezahlplan ohne Shopify-Billing ✅ BEHOBEN

- **Status:** Behoben. Route `app/routes/api.update-plan.tsx` ersatzlos entfernt
  (war von keinem UI aufgerufen), `UpdatePlanSchema` aus `validation.ts` entfernt.
  Die nützliche Cache-Cleanup-Logik (`cleanupCacheForPlan`) wurde an den
  Shopify-verifizierten Sync-Punkt `checkAndSyncSubscription()` umgehängt und
  läuft jetzt nur noch bei einem verifizierten Plan-Wechsel (auch bei realen
  Downgrades). Es existiert kein Codepfad mehr, der `subscriptionPlan` aus einem
  Request-Body setzt.
- **Anforderung:** Shopify Billing API zwingend; kein Off-Platform-Billing. Bezahlfeatures
  nur nach Shopify-Charge. (Req 1.2.1–1.2.3 — <https://shopify.dev/docs/apps/launch/billing>,
  <https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements>)
- **Datei:** [app/routes/api.update-plan.tsx:49-58](app/routes/api.update-plan.tsx#L49-L58)
- **Ist-Zustand:** Authentifizierte Action schreibt `subscriptionPlan` per `upsert`
  direkt auf jeden Wert (`free|basic|pro|max`, nur durch `UpdatePlanSchema` validiert) —
  **kein einziger Aufruf der Shopify Billing API**. Jeder eingeloggte Merchant kann per
  `POST {"plan":"max"}` den Max-Plan kostenlos erhalten. Route ist live und erreichbar
  (Commit `6d90c2b`). Kein UI-Aufrufer in `app/**` gefunden — aber die Route allein ist
  ein direkter Billing-Umgehungsweg, den Shopify-Reviewer per Endpoint-Scan finden.
- **Fix:** Route entfernen **oder** den Plan ausschließlich aus einer verifizierten
  aktiven Shopify-`AppSubscription` ableiten (Cache-Cleanup-Logik beibehalten, aber
  Plan-Schreibrecht entkoppeln). Niemals planänderbaren Endpoint ohne Billing-Gate
  ausliefern.

### B2 — Production-Billing-Bypass über `APP_ENV=development`

- **Anforderung:** wie B1 — kein Off-Platform-Billing.
- **Dateien:** [app/routes/api.billing.create-subscription.tsx:34-41](app/routes/api.billing.create-subscription.tsx#L34-L41),
  [app/routes/api.billing.cancel-subscription.tsx:35-42](app/routes/api.billing.cancel-subscription.tsx#L35-L42),
  [app/components/SettingsPlanTab.tsx:87-91](app/components/SettingsPlanTab.tsx#L87-L91)
- **Ist-Zustand:** Wenn `NODE_ENV` **oder `APP_ENV`** = `development`, wird der Plan
  direkt in die DB geschrieben (`directUpdate:true`), die Shopify Billing API **nie**
  aufgerufen; das UI gewährt den Plan. Code-Kommentare nennen explizit „deployed custom
  apps" als Zweck. Es gibt **keine** `.toml`/Dockerfile-Festlegung, die `APP_ENV` in
  Produktion ausschließt — ein deployment-konfigurationsabhängiger Bypass im Public-App-
  Code.
- **Fix:** `APP_ENV`-Zweig vor Submission entfernen oder hart auf Nicht-Public-Builds
  gaten. Für die Public App darf es **keinen** Codepfad geben, der Bezahlpläne ohne
  Billing-API gewährt.

### B3 — Session-PII (Vorname/Nachname/E-Mail) wird unverschlüsselt gespeichert — Doku behauptet das Gegenteil

- **Anforderung:** Protected-Customer-Data Level 1 — Verschlüsselung at rest & in
  transit; Datenschutz-Transparenz. (<https://shopify.dev/docs/apps/launch/protected-customer-data>)
- **Dateien:** [app/utils/encrypted-session-storage.server.ts:24-47](app/utils/encrypted-session-storage.server.ts#L24-L47),
  [docs/SESSION_PII_ENCRYPTION_SETUP.md](docs/SESSION_PII_ENCRYPTION_SETUP.md) (Z. ~174, 210)
- **Ist-Zustand:** `EncryptedPrismaSessionStorage.storeSession` verschlüsselt **nur**
  `accessToken`/`refreshToken`. `firstName`/`lastName`/`email` werden unverändert an
  `PrismaSessionStorage` durchgereicht → **Klartext bei jedem Login/Token-Refresh**.
  `encryptPII()` existiert in `encryption.server.ts`, wird aber **nirgendwo** im
  Laufzeitcode aufgerufen (nur im einmaligen Backfill-Skript
  `scripts/migrate-encrypt-session-pii.ts`). Neue Zeilen führen sofort wieder Klartext
  ein. `docs/SESSION_PII_ENCRYPTION_SETUP.md` behauptet Verschlüsselung-at-rest — für
  Live-Daten **falsch**. (Hinweis: Diese Daten sind Merchant-/Staff-PII, nicht Käufer-PII;
  dennoch Verschlüsselungs- und Wahrheitspflicht.)
- **Fix:** `storeSession`/`loadSession` um `encryptPII`/`decryptPII` für
  `firstName`/`lastName`/`email` erweitern (analog Token-Pfad). Doku erst nach
  verifizierter Implementierung als „erfüllt" markieren.

### B4 — Keine KI-Datenverarbeitungs-Zustimmung / unzureichende Offenlegung (für eine KI-App kritisch)

- **Anforderung:** Keine Nutzung von API-/Merchant-Daten für ML/KI ohne **schriftliche
  Zustimmung von Shopify ODER des Merchants**; Privacy-Policy-Offenlegung der erhobenen
  Daten/Zwecke/Drittempfänger. (PPA §6.1 / API Terms — <https://www.shopify.com/partners/terms>,
  <https://www.shopify.com/legal/api-terms>; Privacy-Req —
  <https://shopify.dev/docs/apps/launch/privacy-requirements>)
- **Dateien:** [src/services/ai.service.ts:66-90](src/services/ai.service.ts#L66-L90),
  [app/routes/app.settings.tsx:86](app/routes/app.settings.tsx#L86),
  [app/routes/privacy.tsx:99](app/routes/privacy.tsx#L99),
  [app/routes/privacy.tsx:110-130](app/routes/privacy.tsx#L110-L130)
- **Ist-Zustand:**
  - Merchant-Content (Produkttitel, -beschreibungen, SEO-Felder, Policies, Bilder) wird
    im Klartext an Drittanbieter-KI gesendet.
  - **Default ohne Merchant-Key:** neue Shops starten mit `preferredProvider:"huggingface"`
    ohne eigenen Key → Daten laufen über den **App-eigenen Shared-Key** (HuggingFace,
    ggf. Free-Tier Google Gemini). Free-Tier Google darf Inhalte zur Produktverbesserung
    nutzen; HuggingFace Inference hat keine vertragliche „No-Training"-Garantie.
  - **Kein In-App-Consent-Gate, kein Opt-out-Toggle** vor dem ersten KI-Call; die
    Settings-Seite enthält **keinerlei** Datenschutz-/Consent-Hinweis und verlinkt die
    Privacy-Seite nicht.
  - `privacy.tsx` listet nur 4 von 6 aktiven Providern (Grok/X.AI und DeepSeek fehlen)
    und beschreibt den Zweck vage als „Feature Improvement".
  - Weder Shopify- noch Merchant-Schriftzustimmung wird erfasst.
- **Fix (eines der beiden, plus Disclosure):**
  1. BYO-Key erzwingen — `process.env.*_API_KEY`-Shared-Fallback in
     `ai.service.ts` entfernen, sodass nie über den App-Operator-Account verarbeitet wird;
     **oder**
  2. explizites, geloggtes In-App-Consent-Gate vor jedem KI-Call.
  Zusätzlich: alle 6 Provider + konkreten KI-Verarbeitungszweck in `privacy.tsx`
  offenlegen, Privacy-Seite aus Settings/KI-Screens verlinken, Free-Tier-Google-Key auf
  No-Train-Paid-Tier umstellen oder entfernen.

---

## 🟠 RISIKO

### R1 — `redactShopData` löscht `ContentTranslation` ohne Shop-Filter (Cross-Tenant-Datenverlust + Lösch-Defekt)

- **Anforderung:** Korrekte, mandantengetrennte Datenlöschung nach `shop/redact`
  (<https://shopify.dev/docs/apps/build/privacy-law-compliance>).
- **Datei:** [app/services/gdpr.service.ts:220-226](app/services/gdpr.service.ts#L220-L226)
- **Ist-Zustand:** Löschfilter `resourceId startsWith 'gid://shopify/'` **ohne
  `shop`-Bedingung**, innerhalb der Pro-Shop-Redaction-Transaktion. Da `ContentTranslation.shop`
  existiert und jede Zeile den Präfix trägt, löscht ein `shop/redact` eines Shops die
  Übersetzungen **aller** Shops.
- **Fix:** `where: { shop: shop_domain }` ergänzen (wie bei allen anderen `deleteMany`
  in dieser Funktion).

### R2 — Mehrere shop-bezogene Tabellen werden bei `shop/redact` nicht gelöscht

- **Anforderung:** Alle Daten des Shops innerhalb 30 Tagen / per `shop/redact` löschen.
- **Datei:** [app/services/gdpr.service.ts:158-246](app/services/gdpr.service.ts#L158-L246)
- **Ist-Zustand:** Nicht gelöscht: `AltTextTemplate`, `OptionValueMemory`,
  `GroupedFieldTranslation`, `ImageManagerSettings`, `MetaobjectDefinition`,
  `Metaobject`, `MetaobjectTranslation`, `WebhookRetry`. Diese überdauern die Redaction
  unbegrenzt.
- **Fix:** Alle shop-skopierten Modelle in die Lösch-Transaktion aufnehmen; idealerweise
  generisch über Prisma-Modell-Iteration absichern, damit künftige Modelle nicht vergessen
  werden.

### R3 — Keine 30-Tage-Lösch-Fallback nach Uninstall; `shop/redact`-Fehler werden verschluckt

- **Anforderung:** Datenlöschung ≤ 30 Tage nach Uninstall (API Terms §6.2).
- **Dateien:** [app/routes/webhooks.app-uninstalled.tsx:28-37](app/routes/webhooks.app-uninstalled.tsx#L28-L37),
  [app/routes/webhooks.compliance.tsx:70-79](app/routes/webhooks.compliance.tsx#L70-L79)
- **Ist-Zustand:** `app/uninstalled` löscht nur Sessions; vollständige Löschung hängt
  **ausschließlich** an `shop/redact` (~48 h später). Dessen Handler fängt Fehler ab
  und gibt trotzdem 200 zurück — **kein Retry/Dead-Letter**. Schlägt die Löschung fehl,
  bleiben Daten dauerhaft. `privacy.tsx:173` („deleted within 30 days") ist dann nicht
  durch Code gedeckt.
- **Fix:** Bei Lösch-Fehler 500 zurückgeben (Shopify wiederholt), plus geplanter
  Reaper-Job, der Shops ohne aktive Installation/Session nach 30 Tagen final purged.

### R4 — Keine durchgesetzte 3-Jahres-Retention für `GdprAuditLog`

- **Anforderung:** Datenminimierung / Aufbewahrungsfristen (Protected Customer Data
  Level 1; DSGVO Storage Limitation).
- **Dateien:** [app/services/gdpr.service.ts:255-257](app/services/gdpr.service.ts#L255-L257),
  [prisma/schema.prisma](prisma/schema.prisma) (GdprAuditLog ~Z. 599)
- **Ist-Zustand:** Code-Kommentar verspricht 3-Jahres-Cleanup „z. B. via scheduled job" —
  ein solcher Job **existiert nicht** (kein `gdprAuditLog.deleteMany` in `scripts/`,
  `src/services/`, Scheduler). `customerEmail`/`customerId` wachsen unbegrenzt.
- **Fix:** Geplanten Cleanup implementieren, der nur Zeilen `requestedAt < NOW() - 3 Jahre`
  entfernt; in `docs/GDPR_COMPLIANCE.md` dokumentieren.

### R5 — Beworbener 7-Tage-Free-Trial wird nicht angewandt

- **Anforderung:** Wahrheitsgemäße/genaue Preisangaben (Req 4.2, häufiger
  Ablehnungsgrund — <https://shopify.dev/docs/apps/launch/app-store-review/pass-app-review>).
- **Datei:** [app/services/billing.server.ts:122-131](app/services/billing.server.ts#L122-L131)
- **Ist-Zustand:** `trialDays` wird in `config/billing.ts` definiert und im Mutations-
  Result zurückgefragt, aber **nie in den `appSubscriptionCreate`-LineItems gesetzt**.
  UI ([SettingsPlanTab.tsx:298](app/components/SettingsPlanTab.tsx#L298)) und
  `docs/BILLING_SYSTEM.md` versprechen einen Trial, der nicht geliefert wird → Sofort-
  Charge entgegen Preisangabe.
- **Fix:** `trialDays: planConfig.trialDays` in das LineItem aufnehmen — oder Trial-
  Versprechen aus UI/Doku entfernen.

### R6 — Geleakte/Shared Provider-Secrets im Repo, Free-Tier-Google-Key

- **Anforderung:** Datenschutz/Sicherheit; KI/ML-Restriction (Free-Tier-Google nutzt
  Content u. U. zur Modellverbesserung).
- **Datei/Pfad:** `.env` (Z. ~19-22, populated `HUGGINGFACE_API_KEY`, real-aussehender
  `GOOGLE_API_KEY=AIzaSy...`) — referenziert von
  [src/services/ai.service.ts:66-90](src/services/ai.service.ts#L66-L90)
- **Ist-Zustand:** Funktionsfähige Shared-Keys im Repo; der Google-Free-Tier-Key ist
  genau der Provider ohne „No-Training"-Garantie und Default-Fallback.
- **Fix:** Keys rotieren/entfernen, `.env` aus Git-History bereinigen (BFG-Reports
  vorhanden — Prozess existiert bereits), Shared-Fallback streichen (vgl. B4).

### R7 — `getRestClient()` im ausgelieferten Code (REST-Admin-API-Oberfläche)

- **Anforderung:** Neue Public Apps ausschließlich GraphQL Admin API (Req 2.2.4, seit
  2025-04-01).
- **Datei:** [src/shopify-connector.ts:112-114](src/shopify-connector.ts#L112-L114)
- **Ist-Zustand:** `new this.shopify.clients.Rest(...)` — nie aufgerufen (toter Code),
  aber ein Reviewer-Scan auf `clients.Rest`/REST kann es beanstanden. Alle echten
  Shopify-Calls laufen über `/graphql.json` (verifiziert in `admin-client.server.ts`,
  `shopify-api-gateway.service.ts`, `webp-processor.service.js`).
- **Fix:** Methode löschen, um REST-Oberfläche vollständig zu entfernen.

### R8 — Unvollständige/zu vage Privacy-Policy-Offenlegung

- **Anforderung:** Privacy Policy muss erhobene Daten, Zweck, Drittempfänger,
  Aufbewahrung offenlegen (<https://shopify.dev/docs/apps/launch/privacy-requirements>).
- **Datei:** [app/routes/privacy.tsx:99](app/routes/privacy.tsx#L99),
  [app/routes/privacy.tsx:170-173](app/routes/privacy.tsx#L170-L173)
- **Ist-Zustand:** Nur 4 von 6 KI-Providern genannt (Grok/DeepSeek fehlen); Zweck
  „Feature Improvement" vage; Retention-Aussagen („cleaned up after 30 days", „deleted
  within 30 days") nicht durch Code gedeckt (siehe R3/R4); KI-Training-Posture nicht
  adressiert.
- **Fix:** Alle aktiven Provider, konkreten Verarbeitungszweck, tatsächliche
  Retention/Trigger (48 h `shop/redact` etc.) und ggf. Sub-Processor-Liste aufnehmen;
  aus Settings verlinken.

---

## 🟡 HINWEIS

### H1 — App-Bridge-Script & `shopify-api-key`-Meta nicht im `<head>`
[app/root.tsx:38-44](app/root.tsx#L38-L44): `app-bridge.js` und
`<meta name="shopify-api-key">` werden als `Document`-Children in `<body>` gerendert,
nicht in `<head>`. Funktioniert praktisch, aber Shopifys dokumentierte Best Practice
(Req 2.2.3) ist die Platzierung im `<head>`. Verschieben empfohlen.

### H2 — `webhooks.articles.tsx` nicht in `shopify.app.toml` registriert
[app/routes/webhooks.articles.tsx](app/routes/webhooks.articles.tsx) (ungetrackt)
verarbeitet `articles/*`, aber [shopify.app.toml:18-39](shopify.app.toml#L18-L39)
abonniert keine `articles/*`-Topics → Handler feuert nie, Artikel-Sync unvollständig
(Funktionalitäts-/„fertiges Produkt"-Risiko, Req 2.1.x). Auch `menus/*` wird vom
Handler `webhooks.menus.tsx` erwartet, ist aber nicht abonniert. Topics ergänzen oder
Handler/Doku bereinigen.

### H3 — DB-Default-Plan inkonsistent (`free` vs. `basic`)
[prisma/schema.prisma](prisma/schema.prisma) setzt `subscriptionPlan` Default `"free"`,
aber `prisma/migrations/00000000000000_baseline/migration.sql:40` und
`docs/PLAN_SYSTEM.md` setzen `'basic'`. Eine per Roh-DB-Default angelegte Zeile gewährt
Basic ohne Bezahlung. App-Code setzt den Wert explizit (Impact begrenzt), dennoch
angleichen auf `'free'`.

### H4 — Plan-Auflösung per Substring des Subscription-Namens
[app/services/billing.server.ts:234-244](app/services/billing.server.ts#L234-L244):
`name.includes('max'|'pro'|'basic')` ist fragil (z. B. „Promo Plan"). Robust per
LineItem-Preis / gespeicherter `AppSubscription.id` mappen.

### H5 — „Contact support" als Fallback bei Cancel-DB-Schreibfehler
[app/routes/api.billing.cancel-subscription.tsx:80](app/routes/api.billing.cancel-subscription.tsx#L80):
Nur Edge-Case (Shopify-Cancel erfolgreich, DB-Write 3× fehlgeschlagen). Akzeptabel, aber
durch automatischen Background-Reconcile ersetzen, um „Plan-Wechsel ohne Support" (Req
1.2.3) vollständig zu erfüllen.

### H6 — `WebhookLog`-Cleanup überspringt fehlgeschlagene Zeilen
[app/services/sync-scheduler.service.ts:233-238](app/services/sync-scheduler.service.ts#L233-L238):
nur `processed:true` wird nach 24 h gelöscht; fehlgeschlagene/`processed:false` nie.
Aktuell geringe Wirkung (payload = `"{}"`), aber Retention-Lücke schließen.

### H7 — Doku-Abweichungen (Doku ≠ Code, vor Submission bereinigen)
- `docs/PLAN_SYSTEM.md` Limit-Tabelle (Free 15 / Basic 100 / Pro 250 / Max ∞) ≠
  `app/config/plans.ts` (Free 25 / Basic 75 / Pro 150 / Max 5000).
- ✅ behoben: `docs/PLAN_SYSTEM.md` beschrieb einen MainNavigation-4-Button-Plan-Selector
  zu `/api/update-plan` (existierte nicht) — korrigiert auf den realen Flow
  (`SettingsPlanTab` via Billing-API, `checkAndSyncSubscription`).
- `docs/BILLING_SYSTEM.md` unterschätzt Test-Billing-Trigger (auch `APP_ENV`,
  `partnerDevelopment`) und bewirbt nicht implementierten Trial.
- `docs/SESSION_PII_ENCRYPTION_SETUP.md` behauptet PII-Verschlüsselung at rest (siehe B3).
- `docs/GDPR_COMPLIANCE.md` markiert HMAC-Verifikation als „TODO for Production" —
  tatsächlich ist HMAC durch `authenticate.webhook()` umgesetzt; Doku veraltet, aber
  KI/ML-Restriction & 3-Jahres-Retention werden in der Doku nicht behandelt.

---

## Was bereits konform ist (verifiziert)

- **Compliance-Webhooks:** Alle 3 (`customers/data_request`, `customers/redact`,
  `shop/redact`) in [shopify.app.toml:21-23](shopify.app.toml#L21-L23) registriert und in
  [app/routes/webhooks.compliance.tsx](app/routes/webhooks.compliance.tsx) implementiert;
  HMAC via `authenticate.webhook()` (→ 401 bei ungültig), 200-Antwort, **echte**
  Löschlogik (kein Stub) inkl. Audit-Log. Einschränkungen: R1/R2/R3.
- **Protected Customer Data:** App fordert **keine** Customer-/Order-Scopes an
  ([shopify.app.toml:9](shopify.app.toml#L9)); keine Käufer-PII/Order-Daten im Code
  (nur in `docs/`). Compliance-Webhooks trotzdem korrekt vorhanden. Scopes sind plausibel
  minimal für eine Content-/Übersetzungs-App; keine sensiblen Scopes mit Begründungspflicht.
- **Auth/Embedding:** App-Bridge per CDN (`https://cdn.shopify.com/shopifycloud/app-bridge.js`),
  kein npm-App-Bridge; `unstable_newEmbeddedAuthStrategy:true` (Session-Token/Token-Exchange),
  kein Cookie-/localStorage-Auth; OAuth sofort vor anderen Schritten, keine Pop-ups;
  durchgängig embedded; HTTPS/HSTS.
- **GraphQL-only:** Alle funktionalen Shopify-Calls über `/graphql.json` (Ausnahme:
  toter REST-Client R7).
- **Billing-Grundpfad:** Shopify GraphQL Billing API korrekt genutzt
  (`appSubscriptionCreate`/`appSubscriptionCancel`/`activeSubscriptions`),
  `confirmationUrl` top-level, Re-Install-Reconcile in `afterAuth`, kein externes
  Payment. Einschränkungen: B1/B2/R5.
- **API-Version:** `2025-10` ([shopify.app.toml:19](shopify.app.toml#L19)) — nicht
  innerhalb 90 Tagen deprecated (Stand 2026-05-16); kein Submission-Blocker.
- **Verschlüsselung (Teil):** AES-256-GCM, `ENCRYPTION_KEY` Pflicht (Startup-Fail-Fast);
  OAuth-Tokens und KI-API-Keys werden at-rest verschlüsselt. Lücke: Session-PII (B3).

---

## Empfohlene Abarbeitungs-Reihenfolge vor (erneuter) Submission

1. **B1, B2** — Billing-Bypässe schließen (höchstes Ablehnungs-/Removal-Risiko).
2. **B4, R6, R8** — KI-Datenfluss: BYO-Key erzwingen *oder* Consent-Gate; Provider
   vollständig offenlegen; Secrets rotieren. (Für eine KI-App der Kern-Prüfpunkt.)
3. **B3, R1, R2** — Session-PII verschlüsseln; Cross-Tenant-Lösch-Bug fixen; Lösch-
   Abdeckung vervollständigen.
4. **R3, R4, R5** — 30-Tage-Reaper + `shop/redact`-Retry; GdprAuditLog-Retention-Job;
   Trial anwenden oder Claim entfernen.
5. **R7, H1–H7** — REST-Client entfernen, App-Bridge-Placement, Webhook-Registrierung,
   Doku ↔ Code angleichen.

*Keine Code-Änderungen vorgenommen — reiner Audit-Bericht.*
