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
| 🔴 BLOCKER | 0 (✅ alle 4 behoben: B1–B4) | B1 `/api/update-plan` entfernt · B2 `APP_ENV`-Billing-Bypass entfernt · B3 Session-PII at rest verschlüsselt · B4 KI-Datenfluss via erzwungenem BYO-Key gelöst — verifiziert (Code-Review, typecheck, Unit-Tests grün) |
| 🟠 RISIKO | 0 offen (✅ R1–R9 behoben) | R1/R2 Lösch-Bug+Vollständigkeit, R3 shop/redact-Retry+30-Tage-Reaper (inkl. Guard-Nachbesserung), R4 GdprAuditLog-3-Jahres-Job, R5 Trial angewandt, R6 hinfällig (nur Dummy-Keys), R7 REST-Client entfernt, R8 Privacy-Disclosure, **R9** Trial-Mehrfachvergabe via persistentem `trialConsumedAt`-Marker geschlossen |
| 🟡 HINWEIS | 1 bewusst akzeptiert (✅ H1–H4, H6, H7 behoben) | H5 (Cancel-DB-Fehler-Support-Hinweis) bleibt per Entscheidung unverändert — reiner Edge-Case ohne Überberechnung |

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

### B2 — Production-Billing-Bypass über `APP_ENV=development` ✅ BEHOBEN

- **Status:** Behoben (Commit `d9b607e`). Der `directUpdate`/`APP_ENV`/`NODE_ENV`-
  Zweig wurde aus [api.billing.create-subscription.tsx](app/routes/api.billing.create-subscription.tsx)
  und [api.billing.cancel-subscription.tsx](app/routes/api.billing.cancel-subscription.tsx)
  vollständig entfernt; beide Routen laufen jetzt **ausnahmslos** über die Shopify
  Billing API (`createSubscription`/`cancelSubscription`). Die `directUpdate`-
  Behandlung in `SettingsPlanTab.tsx` ist entfernt (Grep: kein Treffer mehr).
  Test-/Partner-Dev-Stores erhalten Test-Charges ausschließlich über Shopifys
  eigenes `test`-Flag in `billing.server.ts` — kein DB-Direktschreiben als Ersatz.
  Verifiziert per Code-Review + `npx tsc --noEmit` + `billing.server.test.ts` grün.
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

### B3 — Session-PII (Vorname/Nachname/E-Mail) wird unverschlüsselt gespeichert — Doku behauptet das Gegenteil ✅ BEHOBEN

- **Status:** Behoben (Commit `2a87f17`). `EncryptedPrismaSessionStorage`
  ver-/entschlüsselt jetzt `associated_user.{first_name,last_name,email}` per
  `encryptPII`/`decryptPII` in `storeSession`, `loadSession` und
  `findSessionsByShop`. Idempotenz über `isEncrypted`-Guard (Altbestand/Backfill-
  sicher); `onlineAccessInfo` wird vor Mutation deep-kopiert, sodass die
  In-Memory-Session des Aufrufers nicht mit Ciphertext kontaminiert wird;
  PII-Entschlüsselungsfehler werden nur geloggt und erzwingen **kein** Re-Auth
  (anders als beim Token). Verifiziert per Code-Review + `npx tsc --noEmit` +
  `encryption.test.ts` grün. Doku-Status in `docs/SESSION_PII_ENCRYPTION_SETUP.md`
  ist damit zutreffend (vorher: falsch).
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

### B4 — Keine KI-Datenverarbeitungs-Zustimmung / unzureichende Offenlegung (für eine KI-App kritisch) ✅ BEHOBEN (Ansatz A: BYO-Key)

- **Status:** Behoben durch **Ansatz A (BYO-Key erzwingen)**.
  - `process.env.*_API_KEY`-Shared-Fallback in
    [src/services/ai.service.ts](src/services/ai.service.ts) **vollständig entfernt**;
    fehlt der merchant-eigene Key, wirft `initializeProvider()` jetzt
    `MissingAIKeyError` (Code `NO_AI_KEY`) — garantierter Chokepoint für **alle**
    `new AIService(...)`-Aufrufer inkl. Hintergrund-Tasks. Es existiert **kein**
    Codepfad mehr, der Merchant-Content über einen App-/Operator-Account an eine
    Dritt-KI sendet.
  - Freundliche Vorab-Prüfung (`getMissingPreferredKey` / `noAiKeyResponse`,
    `409 NO_AI_KEY`, lokalisiert) an den HTTP-Eintrittspunkten:
    [api.ai.tsx](app/routes/api.ai.tsx) (deckt alle 11 Handler),
    [api.translate-alt-text-template.tsx](app/routes/api.translate-alt-text-template.tsx),
    [templates-translate-field.action.ts](app/actions/templates/templates-translate-field.action.ts).
  - `privacy.tsx`: alle **6** Provider (HuggingFace, Google Gemini, Anthropic,
    OpenAI, Grok/X.AI, DeepSeek) + konkreter Verarbeitungszweck + „kein
    Modell-Training" + Drittland-/EU-Transfer-Hinweis; aus dem Settings-AI-Tab
    verlinkt.
  - **No-Go:** Die Variablen `HUGGINGFACE_API_KEY`, `GOOGLE_API_KEY`,
    `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GROK_API_KEY`, `DEEPSEEK_API_KEY`
    dürfen **nicht** als Shared-/Operator-Keys gesetzt werden — sie werden vom
    Code nicht mehr gelesen und würden den Compliance-Verstoß wieder einführen.
    (`scripts/validate-env.js` erwartet diese Vars nicht — kein Pflicht-Env.)
    Bestehende Werte in `.env`/Deployment entfernen (siehe R6).
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

### R1 — `redactShopData` löscht `ContentTranslation` ohne Shop-Filter (Cross-Tenant-Datenverlust + Lösch-Defekt) ✅ BEHOBEN

- **Status:** Behoben (Commit `ab6521e`). `ContentTranslation`-Löschung jetzt
  `where: { shop: shop_domain }`; der mandantenübergreifende `startsWith
  'gid://shopify/'`-Filter ist entfernt. Regressionstest „Shop A löscht nichts
  von Shop B" in `tests/unit/gdpr.service.test.ts` grün.
- **Anforderung:** Korrekte, mandantengetrennte Datenlöschung nach `shop/redact`
  (<https://shopify.dev/docs/apps/build/privacy-law-compliance>).
- **Datei:** [app/services/gdpr.service.ts:220-226](app/services/gdpr.service.ts#L220-L226)
- **Ist-Zustand:** Löschfilter `resourceId startsWith 'gid://shopify/'` **ohne
  `shop`-Bedingung**, innerhalb der Pro-Shop-Redaction-Transaktion. Da `ContentTranslation.shop`
  existiert und jede Zeile den Präfix trägt, löscht ein `shop/redact` eines Shops die
  Übersetzungen **aller** Shops.
- **Fix:** `where: { shop: shop_domain }` ergänzen (wie bei allen anderen `deleteMany`
  in dieser Funktion).

### R2 — Mehrere shop-bezogene Tabellen werden bei `shop/redact` nicht gelöscht ✅ BEHOBEN

- **Status:** Behoben (Commit `ab6521e`). Alle zuvor fehlenden Tabellen ergänzt
  (`WebhookRetry`, `OptionValueMemory`, `GroupedFieldTranslation`,
  `AltTextTemplate`, `ImageManagerSettings` per `shopId`,
  `MetaobjectDefinition/Metaobject/MetaobjectTranslation`, `ShopInstallState`).
  „Completeness-Contract"-Kommentar + Schema-Coverage-Guard-Test, der bei neuen
  shop-skopierten Modellen automatisch fehlschlägt. Tests grün.
- **Anforderung:** Alle Daten des Shops innerhalb 30 Tagen / per `shop/redact` löschen.
- **Datei:** [app/services/gdpr.service.ts:158-246](app/services/gdpr.service.ts#L158-L246)
- **Ist-Zustand:** Nicht gelöscht: `AltTextTemplate`, `OptionValueMemory`,
  `GroupedFieldTranslation`, `ImageManagerSettings`, `MetaobjectDefinition`,
  `Metaobject`, `MetaobjectTranslation`, `WebhookRetry`. Diese überdauern die Redaction
  unbegrenzt.
- **Fix:** Alle shop-skopierten Modelle in die Lösch-Transaktion aufnehmen; idealerweise
  generisch über Prisma-Modell-Iteration absichern, damit künftige Modelle nicht vergessen
  werden.

### R3 — Keine 30-Tage-Lösch-Fallback nach Uninstall; `shop/redact`-Fehler werden verschluckt ✅ BEHOBEN (1 Nachbesserung offen)

- **Status:** Behoben (P2, Working Tree). Compliance-Webhook gibt bei Fehler
  **HTTP 500** zurück → Shopify-Retry; Best-Effort-Failed-Audit-Eintrag;
  Idempotenz begründet. `ShopReaperService` (`src/services/shop-reaper.service.ts`)
  purged Shops 30 Tage nach Uninstall via `redactShopData`; `uninstalledAt`-Marker
  in `ShopInstallState` (neues Model + Migration), bei Reinstall in `afterAuth`
  zurückgesetzt; Bootstrap in `shopify.server.ts`, Stop in `entry.server.tsx`.
  `shop-reaper.service.test.ts` grün.
- **⚠️ Offene Nachbesserung (separater Korrektur-Prompt vergeben):** Reaper
  Guard 2 überspringt Shops mit `subscriptionPlan !== "free"`. Da der Plan bei
  Uninstall nie auf `free` zurückgesetzt wird, werden **vormals zahlende,
  deinstallierte Shops nie final gepurged** — genau im Fallback-Fall. Fix:
  Guard 2 streichen (deinstallierte App hat per Definition keine aktive
  Subscription) oder `subscriptionPlan` bei Uninstall auf `free` setzen.
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

### R4 — Keine durchgesetzte 3-Jahres-Retention für `GdprAuditLog` ✅ BEHOBEN

- **Status:** Behoben (P3). `GdprAuditLogCleanupService`
  (`src/services/gdpr-audit-cleanup.service.ts` + `.js`-Mirror) löscht täglich
  ausschließlich `GdprAuditLog`-Zeilen mit `requestedAt < now − 3 Jahre`.
  Feld `requestedAt DateTime @default(now())` in `schema.prisma` verifiziert;
  in `server.js` gebootstrappt/gestoppt. `gdpr-audit-cleanup.service.test.ts` grün.
- **Anforderung:** Datenminimierung / Aufbewahrungsfristen (Protected Customer Data
  Level 1; DSGVO Storage Limitation).
- **Dateien:** [app/services/gdpr.service.ts:255-257](app/services/gdpr.service.ts#L255-L257),
  [prisma/schema.prisma](prisma/schema.prisma) (GdprAuditLog ~Z. 599)
- **Ist-Zustand:** Code-Kommentar verspricht 3-Jahres-Cleanup „z. B. via scheduled job" —
  ein solcher Job **existiert nicht** (kein `gdprAuditLog.deleteMany` in `scripts/`,
  `src/services/`, Scheduler). `customerEmail`/`customerId` wachsen unbegrenzt.
- **Fix:** Geplanten Cleanup implementieren, der nur Zeilen `requestedAt < NOW() - 3 Jahre`
  entfernt; in `docs/GDPR_COMPLIANCE.md` dokumentieren.

### R5 — Beworbener 7-Tage-Free-Trial wird nicht angewandt ✅ BEHOBEN

- **Status:** Behoben (Commit `868ae7f`). `trialDays` wird als Top-Level-Argument
  `$trialDays: Int` an `appSubscriptionCreate` übergeben
  (`hasExistingSubscription ? 0 : planConfig.trialDays`) — kein erneuter Trial
  beim paid→paid-Wechsel, dokumentiert. Config/Doku/UI konsistent.
  `billing.server.test.ts` grün. **Folge-Risiko siehe R9** (Trial-Mehrfachvergabe
  über Cancel/Re-Subscribe).
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

### R6 — Geleakte/Shared Provider-Secrets im Repo, Free-Tier-Google-Key ✅ BEHOBEN / HINFÄLLIG

- **Status:** Hinfällig + behoben. Klarstellung Betreiber: Die `.env`-Werte waren
  ausschließlich Dummy-Platzhalter, nie produktionsfähig — kein realer
  Secret-Leak. Zusätzlich Code/Doku-seitig erledigt (P5): Provider-Keys in
  `.env.*.template` geleert, `validate-env.js` erwartet sie nicht; kein
  Codepfad liest noch `process.env.*_API_KEY` (BYO-Key, B4); Secret-Rotation-
  Runbook in `docs/SECURITY_IMPROVEMENTS.md` (inkl. korrektem Hinweis,
  `ENCRYPTION_KEY` nicht blind zu rotieren).
- **Anforderung:** Datenschutz/Sicherheit; KI/ML-Restriction (Free-Tier-Google nutzt
  Content u. U. zur Modellverbesserung).
- **Datei/Pfad:** `.env` (Z. ~19-22, populated `HUGGINGFACE_API_KEY`, real-aussehender
  `GOOGLE_API_KEY=AIzaSy...`) — referenziert von
  [src/services/ai.service.ts:66-90](src/services/ai.service.ts#L66-L90)
- **Ist-Zustand:** Funktionsfähige Shared-Keys im Repo; der Google-Free-Tier-Key ist
  genau der Provider ohne „No-Training"-Garantie und Default-Fallback.
- **Fix:** Keys rotieren/entfernen, `.env` aus Git-History bereinigen (BFG-Reports
  vorhanden — Prozess existiert bereits), Shared-Fallback streichen (vgl. B4).

### R7 — `getRestClient()` im ausgelieferten Code (REST-Admin-API-Oberfläche) ✅ BEHOBEN

- **Status:** Behoben (P5). `getRestClient()` aus `src/shopify-connector.ts`
  entfernt; repo-weit **keine** REST-Admin-Oberfläche mehr
  (`clients.Rest`/`admin.rest`/`restResources` = 0 Treffer). Alle Shopify-Calls
  laufen über `/graphql.json`. typecheck grün.
- **Anforderung:** Neue Public Apps ausschließlich GraphQL Admin API (Req 2.2.4, seit
  2025-04-01).
- **Datei:** [src/shopify-connector.ts:112-114](src/shopify-connector.ts#L112-L114)
- **Ist-Zustand:** `new this.shopify.clients.Rest(...)` — nie aufgerufen (toter Code),
  aber ein Reviewer-Scan auf `clients.Rest`/REST kann es beanstanden. Alle echten
  Shopify-Calls laufen über `/graphql.json` (verifiziert in `admin-client.server.ts`,
  `shopify-api-gateway.service.ts`, `webp-processor.service.js`).
- **Fix:** Methode löschen, um REST-Oberfläche vollständig zu entfernen.

### R8 — Unvollständige/zu vage Privacy-Policy-Offenlegung ✅ BEHOBEN

> **Status:** Vollständig behoben. KI-Provider-Liste (alle 6), konkreter
> Verarbeitungszweck, „kein Training", Drittland-/EU-Transfer-Hinweis und
> Settings-Verlinkung mit B4 umgesetzt. Die zuvor offene Retention-Aussage
> (§5.3 in `privacy.tsx`) ist mit P2 angeglichen: `shop/redact` ~48 h +
> garantierter 30-Tage-Reaper-Fallback — deckt sich jetzt mit dem Code.


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

### R9 — Trial-Mehrfachvergabe über Cancel/Re-Subscribe ✅ BEHOBEN

- **Status:** Behoben & verifiziert. Persistenter Marker
  `AISettings.trialConsumedAt` (additive Migration
  `20260516000002`/`..._add_trial_consumed_at`, nullable, kein Backfill).
  `isTrialEligible()` gewährt einen Trial nur, wenn **kein** aktives Abo **und**
  `trialConsumedAt == null`; `trialDays` wird entsprechend auf 0 gesetzt.
  `markTrialConsumed()` ist idempotent (`updateMany where trialConsumedAt:null`)
  und wird am **Shopify-verifizierten** Punkt gesetzt (`checkAndSyncSubscription`,
  nur bei `subscription.trialDays > 0` & ACTIVE) — nicht optimistisch am
  Mutations-Call, nie zurückgesetzt. Damit ist free→basic[Trial]→cancel→pro
  geschlossen; nach vollständigem `shop/redact` + echter Neuinstallation wieder
  ein Trial möglich (bewusst). `billing.server.test.ts` 21/21 grün (inkl.
  „trialDays=0 nach Cancel mit gesetztem Marker", paid→paid, Marking am
  verifizierten Punkt). typecheck grün.
- **Anforderung:** Wahrheitsgemäße/genaue Preisangaben; kein Umgehen der
  Bezahlpflicht (Req 1.2.x / 4.2 —
  <https://shopify.dev/docs/apps/launch/app-store-review/pass-app-review>).
- **Datei:** [app/services/billing.server.ts:72](app/services/billing.server.ts#L72), [app/services/billing.server.ts:90](app/services/billing.server.ts#L90), [app/services/billing.server.ts:366](app/services/billing.server.ts#L366)
- **Ist-Zustand:** Folge-Risiko aus R5-Fix. Trial-Vergabe hängt allein an
  `hasExistingSubscription`. Die Sequenz free → basic (Trial) → cancel → pro
  setzt `hasExistingSubscription` wieder auf `false` → der Shop erhält einen
  **zweiten Trial**, beliebig wiederholbar = dauerhaft kostenlose Bezahlfeatures.
- **Fix:** Persistenter Trial-Konsum-Marker pro Shop (`trialConsumedAt` auf
  `AISettings`, additive Prisma-Migration), gesetzt am verifizierten
  Aktivierungspunkt (Billing-Callback / `checkAndSyncSubscription`), nie
  zurückgesetzt. `trialDays > 0` nur wenn kein `hasExistingSubscription` **und**
  `trialConsumedAt == null`. Bewusst akzeptiert: nach vollständigem `shop/redact`
  (AISettings gelöscht) ist nach echter Neuinstallation wieder ein Trial möglich
  (legitimer Reset). Korrektur-Prompt vergeben; Umsetzung ausstehend.

---

## 🟡 HINWEIS

### H1 — App-Bridge-Script & `shopify-api-key`-Meta nicht im `<head>` ✅ BEHOBEN
**Status:** Behoben. `Document` in [app/root.tsx](app/root.tsx) rendert
`<meta name="shopify-api-key">` (zuerst), `app-bridge.js`-Script, preconnect und
Font-Stylesheet jetzt im `<head>`; Reihenfolge meta→script entspricht Req 2.2.3.
`ErrorBoundary`-Pfad ohne API-Key lässt das Meta sauber weg. typecheck grün.

### H2 — `webhooks.articles.tsx` / `webhooks.menus.tsx` — Shopify bietet diese Topics gar nicht ✅ BEHOBEN
**Status:** Behoben. Verifiziert an Shopifys `WebhookSubscriptionTopic`-Enum
(API 2026-04): es existieren **keine** `ARTICLES_*`- oder `MENUS_*`-Topics.
Die beiden toten Handler (`webhooks.articles.tsx`, `webhooks.menus.tsx`) wurden
**restlos entfernt**; die README-Webhook-Tabelle korrigiert (Hinweis: Artikel/
Menüs werden ausschließlich über den manuellen/geplanten `ContentSyncService`-
Sync aktualisiert, nicht per Webhook). `ContentSyncService.syncArticle/syncMenu`
bleiben unverändert (anderweitig genutzt).

### H3 — DB-Default-Plan inkonsistent (`free` vs. `basic`) ✅ BEHOBEN
**Status:** Behoben. Additive Migration
`prisma/migrations/20260516000002_default_subscription_plan_free/` setzt
`ALTER TABLE "AISettings" ALTER COLUMN "subscriptionPlan" SET DEFAULT 'free'` —
DB-Default jetzt deckungsgleich mit dem Prisma-Schema; bestehende Zeilen
unverändert (App-Code setzt den Plan ohnehin explizit aus dem
Shopify-verifizierten Abo). `docs/PLAN_SYSTEM.md`-Migrations-Snippet korrigiert.
typecheck grün.

### H4 — Plan-Auflösung per Substring des Subscription-Namens ✅ BEHOBEN
**Status:** Behoben. `getPlanFromSubscription`
([billing.server.ts](app/services/billing.server.ts)) mappt jetzt deterministisch
gegen `BILLING_PLANS`: (1) exakter (case-insensitiver) Name-Match, (2) Fallback
über den Recurring-Preis des Line-Items; kein Substring/`includes` mehr. Kein
Treffer → `free` mit Warn-Log (kein Raten). `billing.server.test.ts` 21/21 grün.

### H5 — „Contact support" als Fallback bei Cancel-DB-Schreibfehler 🟡 BEWUSST AKZEPTIERT
**Status:** Per Entscheidung unverändert belassen. Reiner Edge-Case (Shopify-
Cancel erfolgreich, DB-Write 3× fehlgeschlagen) ohne Überberechnung des
Merchants; `checkAndSyncSubscription` korrigiert den DB-Plan ohnehin beim
nächsten Request selbsttätig.
[app/routes/api.billing.cancel-subscription.tsx:80](app/routes/api.billing.cancel-subscription.tsx#L80).

### H6 — `WebhookLog`-Cleanup überspringt fehlgeschlagene Zeilen ✅ BEHOBEN
**Status:** Behoben. `runDatabaseCleanup`
([sync-scheduler.service.ts](app/services/sync-scheduler.service.ts)) löscht jetzt
zusätzlich **alle** `WebhookLog`-Zeilen älter als 7 Tage — unabhängig von
`processed` —, sodass fehlgeschlagene/unverarbeitete Zeilen nicht mehr unbegrenzt
akkumulieren (7-Tage-Karenz für Inspektion/Retry). typecheck grün.

### H7 — Doku-Abweichungen (Doku ≠ Code) ✅ BEHOBEN
- ✅ `docs/PLAN_SYSTEM.md` Limit-Tabelle auf `app/config/plans.ts` angeglichen
  (Free 25 / Basic 75 / Pro 150 / Max 5000) inkl. korrekter Content-Types &
  AI-Instructions-Stufen (editierbar erst ab Pro); stale „15/100/250/∞"-Werte
  und der nicht mehr existente MainNavigation-4-Button-Selector korrigiert.
- ✅ `docs/PLAN_SYSTEM.md` Plan-Flow bereits zuvor auf `SettingsPlanTab` via
  Billing-API / `checkAndSyncSubscription` korrigiert.
- ✅ `docs/GDPR_COMPLIANCE.md` „TODO HMAC/Audit-Log" entfernt — als umgesetzt
  dokumentiert (`authenticate.webhook()` → 401, `GdprAuditLog` + 3-Jahres-
  Cleanup, 500→Retry); Status-Footer aktualisiert.
- ✅ `docs/BILLING_SYSTEM.md` (Trial) und `docs/SESSION_PII_ENCRYPTION_SETUP.md`
  (PII-at-rest) wurden bereits mit R5 bzw. B3 zutreffend gemacht.

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
