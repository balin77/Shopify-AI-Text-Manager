# Shopify App-Genehmigung – Pflichten & Anforderungen (ContentPilot)

> **Zweck:** Nach der Bewilligung von ContentPilot durch Shopify fasst dieses Dokument
> alle relevanten Anforderungen, Pflichten und Empfehlungen aus den vier zentralen
> Shopify-Dokumenten zusammen. Jeder Abschnitt nennt die **Quell-URL**, damit die
> Aktualität der Angaben jederzeit überprüft werden kann.
>
> **Recherchestand:** 2026-05-16. Shopify ändert Anforderungen laufend – vor jeder
> wichtigen Entscheidung die unten verlinkten Originalseiten erneut prüfen.
>
> **Hauptquellen (vom Shopify-E-Mail referenziert):**
> - Go-to-Market Success: <https://shopify.dev/docs/apps/launch/distribution/go-to-market-success>
> - App Store Review: <https://shopify.dev/docs/apps/launch/app-store-review>
> - Partner Program Agreement: <https://www.shopify.com/partners/terms>
> - Built for Shopify: <https://shopify.dev/docs/apps/launch/built-for-shopify>
>
> **Changelog Built for Shopify:** <https://shopify.dev/changelog?filter=built_for_shopify>

---

## Inhaltsverzeichnis

1. [Die wichtigsten harten Regeln (Quick-Reference)](#1-die-wichtigsten-harten-regeln-quick-reference)
2. [App Store Review – Verfahren & Anforderungen](#2-app-store-review--verfahren--anforderungen)
3. [Pflicht-Compliance-Webhooks (DSGVO)](#3-pflicht-compliance-webhooks-dsgvo)
4. [Protected Customer Data](#4-protected-customer-data)
5. [Billing-Anforderungen](#5-billing-anforderungen)
6. [Partner Program Agreement & rechtliche Pflichten](#6-partner-program-agreement--rechtliche-pflichten)
7. [Go-to-Market Success (nach dem Launch)](#7-go-to-market-success-nach-dem-launch)
8. [Built for Shopify (BFS) – Qualitätsstatus](#8-built-for-shopify-bfs--qualit%C3%A4tsstatus)
9. [Verbotene Aktionen / Policy-Verstöße](#9-verbotene-aktionen--policy-verst%C3%B6%C3%9Fe)
10. [Numerische Schwellenwerte – Gesamtreferenz](#10-numerische-schwellenwerte--gesamtreferenz)
11. [Quellen-Verzeichnis (alle URLs)](#11-quellen-verzeichnis-alle-urls)

---

## 1. Die wichtigsten harten Regeln (Quick-Reference)

> Diese Punkte führen bei Nichteinhaltung am schnellsten zu Ablehnung oder Entfernung.

- **App Bridge:** Neueste Version per `app-bridge.js`-Script-Tag im `<head>` – Pflicht seit **13.03.2024**.
- **GraphQL Admin API:** Alle neuen Public Apps müssen ausschließlich die GraphQL Admin API nutzen – Pflicht seit **01.04.2025**.
- **3 Compliance-Webhooks** (`customers/data_request`, `customers/redact`, `shop/redact`): zwingend, auch ohne PII-Erhebung. Ohne korrekte Implementierung wird die App **abgelehnt**.
- **Performance:** App darf den Lighthouse-Performance-Score um **max. 10 Punkte** senken.
- **Billing:** Shopify Billing API / Managed Pricing zwingend. Plan-Up-/Downgrade ohne Support-Kontakt muss möglich sein.
- **OAuth:** Sofort nach Installation (auch bei Re-Install), bevor irgendein anderer Schritt erfolgt. Keine Pop-ups für OAuth/Charges.
- **API-Deprecation:** Apps, die APIs nutzen, die innerhalb von **90 Tagen** deprecated werden, können nicht eingereicht werden.
- **Privacy Policy:** Pflicht und im Listing verlinkt.
- **Protected Customer Data:** Zugriff muss im Partner Dashboard beantragt werden – vor Submission.
- **Datenschutz-Pflichten:** Datenleck-Meldung an Shopify **innerhalb von 24 Stunden**; Datenlöschung **innerhalb von 30 Tagen** nach Uninstall/Anfrage.
- **Kein KI/ML-Training** mit API-/Merchant-Daten ohne ausdrückliche Zustimmung von Shopify oder des Merchants. **(Für ContentPilot besonders relevant – siehe [Abschnitt 6](#6-partner-program-agreement--rechtliche-pflichten).)**
- **Shopify Checkout ist exklusiv** – kein alternativer Checkout/Payment ohne schriftliche Shopify-Genehmigung.
- **Keine Fake-Reviews / keine Anreize für positive Bewertungen** – führt zur Entfernung aus dem App Store.

---

## 2. App Store Review – Verfahren & Anforderungen

**Quelle Übersicht:** <https://shopify.dev/docs/apps/launch/app-store-review>
**Autoritative Anforderungsliste:** <https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements>
**Checkliste:** <https://shopify.dev/docs/apps/launch/app-requirements-checklist>

### 2.1 Review-Prozess

**Quelle:** <https://shopify.dev/docs/apps/launch/app-store-review/review-process>

Status-Ablauf: **Draft → Submitted → Reviewed → Published** (zusätzlich möglicher Status **Paused**).

- **Draft:** Alle auf der Review-Seite markierten Probleme müssen vor Einreichung gelöst sein.
- **Submitted:** Bestätigungs-E-Mail; Rückzug jederzeit über Status-Banner möglich.
- **Paused:** Kernanforderungen nicht erfüllt → E-Mail mit nötigen Änderungen; nach Korrektur „Submit fixes“.
- **Reviewed:** Weitere Klärungen nötig → E-Mail-Antwort erforderlich, um fortzufahren.
- **Published:** Bei Freigabe E-Mail-Benachrichtigung; App wird sichtbar.
- **Kein fixes Review-Zeitfenster** in der Doku angegeben.

E-Mail-Absender freischalten: `app-submissions@shopify.com` und `noreply@shopify.com`.

### 2.2 Häufigste Ablehnungsgründe

**Quelle:** <https://shopify.dev/docs/apps/launch/app-store-review/pass-app-review>

- **Billing:** ungenaue Preisangaben; Up-/Downgrade nicht möglich; nicht die Shopify Billing API genutzt.
- **Installation:** keine sofortige OAuth-Weiterleitung; fataler Fehler nach Install; Re-Install fehlerhaft.
- **Embedding:** App wechselt zwischen embedded/non-embedded → App Bridge + Session Tokens nötig.
- **UI:** kaputtes/unbenutzbares Interface; Web-Fehler (404/500/300).
- **Testing:** ohne Testanleitung/Zugangsdaten eingereicht; kein fertiges, stabiles Produkt.
- **Online-Store-Apps:** keine Theme App Extensions; Widgets werden nicht korrekt angezeigt.

Vorab-Selbstprüfung: Shopify AI Toolkit Befehl `/shopify-app-store-review` (nur Code-Level-Checks). In diesem Repo zusätzlich vorhanden: Skill `shopify-plugin:shopify-app-store-review`.

### 2.3 Kern-Anforderungen (nummerierte Policy)

**Quelle:** <https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements>

**Abschnitt 1 – Policy (Auswahl):**
- 1.1.1 Session Tokens nutzen; embedded ohne Third-Party-Cookies/Local Storage.
- 1.1.2 Shopify Checkout nutzen; kein Bypass / kein externes Payment Processing.
- 1.1.4 Nur faktische Infos; keine Fake-Reviews / falsche Kauf-Notifications.
- 1.1.5 Einzigartige Apps; nicht identisch zu eigenen anderen Apps.
- 1.1.9 Explizite Käufer-Zustimmung vor Zusatz-Charges; keine vorausgewählten optionalen Charges.
- 1.2.1–1.2.3 Shopify App Pricing / Billing API; korrektes Accept/Decline bei Re-Install; Plan-Up-/Downgrade ohne Support.

**Abschnitt 2 – Functionality:**
- 2.1.x Keine kritischen/minoren Fehler, die Abschluss verhindern; interaktive UI; Daten korrekt synchronisieren.
- 2.2.3 Neueste App Bridge per `app-bridge.js` (seit **13.03.2024**).
- 2.2.4 Alle neuen Public Apps ausschließlich GraphQL Admin API (seit **01.04.2025**).
- 2.2.7 Max-Modal nur bei Merchant-Interaktion.

**Abschnitt 3 – Security:**
- 3.1.1 Gültiges TLS/SSL ohne Fehler.
- 3.2.x Nur nötige Access Scopes; Begründungspflicht für sensible Scopes (`read_all_orders`, `write_payment_mandate`, `write_checkout_extensions_apis`, `read_advanced_dom_pixel_events`, `read_checkout_extensions_chat`).

**Abschnitt 4 – App Store Listing:**
- 4.1 App-Name in Dev Dashboard ≈ Submission-Formular; identisches Icon.
- 4.2 Vollständige Preisangaben, nur im Pricing-Bereich, nicht in Bildern/Icon.
- 4.3 Wahrheitsgemäßes Listing; keine unbelegten Claims („first/best/only“), keine Reviews/Testimonials im Listing.
- 4.4 Klare Assets, echte UI, einzigartige Bilder, keine Shopify-Trademark-Missbrauch.
- 4.5 Vollständige Submission: Demo-Screencast (Englisch/Untertitel), gültige Test-Zugangsdaten (aktuell halten), Notfall-Entwicklerkontakt im Partner Dashboard.

**Abschnitt 5 – Kategorie-spezifisch:** Online Store, Payment, Purchase Option/Subscriptions, Product Sourcing, Checkout Customization, Sales Channel, Post Purchase (max. 2 aufeinanderfolgende Requests), Mobile App Builders, Donation, Blockchain – jeweils eigene Pflichtregeln (Details in der Quelle).

### 2.4 Submission-Voraussetzungen

**Quelle:** <https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review>

- Alle automatischen Checks bestanden; keine Apps mit Fehlern/Beta.
- URLs dürfen nicht „Shopify“/„Example“ (oder Tippvarianten) enthalten.
- Compliance-Webhooks abonniert.
- App-Icon 1200×1200 px JPEG/PNG.
- API-Kontakt-E-Mail ohne „Shopify“-Variante.
- Notfallkontakt: E-Mail + Telefon für kritische technische Probleme.
- Primärsprache + mind. ein vollständiges App-Store-Listing.
- Protected-Customer-Data-Antrag falls nötig (nicht während laufendem Review beantragbar).

### 2.5 Privacy-Anforderungen

**Quelle:** <https://shopify.dev/docs/apps/launch/privacy-requirements>

- **Pflicht:** Privacy Policy bereitstellen und im Listing verlinken.
- Pflicht-Compliance-Webhooks abonnieren (siehe [Abschnitt 3](#3-pflicht-compliance-webhooks-dsgvo)).
- Empfohlene Offenlegung: erhobene Daten (API/Merchant/Customer), Zweck, Aufbewahrungsfristen, grenzüberschreitende Verarbeitung, Merchant-Kontakt.
- Datenrechte wahren: Zugriff, Korrektur, Löschung, Einschränkung.
- DSGVO: grenzüberschreitende Transfers benötigen EWR-äquivalenten Schutz.

---

## 3. Pflicht-Compliance-Webhooks (DSGVO)

**Quelle:** <https://shopify.dev/docs/apps/build/privacy-law-compliance>
(auch: <https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance>)

> Jede App im App Store **muss** diese drei Webhooks implementieren – auch wenn keine
> personenbezogenen Daten erhoben werden. Fehlende Implementierung = **Ablehnung**.
> Im Repo existiert bereits `app/routes/webhooks.articles.tsx` (ungetrackt) sowie
> `docs/architecture/GDPR_COMPLIANCE.md` – Abgleich mit diesen Anforderungen empfohlen.

1. **`customers/data_request`** – Kunde fordert gespeicherte Daten an. Payload: `shop_id`, `shop_domain`, `orders_requested`, `customer {id,email,phone}`, `data_request {id}`. App muss Daten an Store-Owner liefern.

2. **`customers/redact`** – Store-Owner verlangt Löschung von Kundendaten. Wird zurückgehalten, wenn der Kunde in den letzten **6 Monaten** bestellt hat (danach freigegeben); sonst **10 Tage** nach Anfrage gesendet. App muss löschen, außer gesetzliche Aufbewahrungspflicht.

3. **`shop/redact`** – **48 Stunden** nach Deinstallation gesendet. App muss alle Daten dieses Shops löschen.

**Technische Anforderungen:**
- POST mit JSON-Body, `Content-Type: application/json`.
- Antwort mit **200er-Statuscode** zur Bestätigung.
- Ungültiger Shopify-HMAC-Header → **401 Unauthorized** zurückgeben.
- Angeforderte Aktion **innerhalb von 30 Tagen** abschließen.
- Registrierung in `shopify.app.toml`:
  ```toml
  [[webhooks.subscriptions]]
  compliance_topics = ["customers/data_request", "customers/redact", "shop/redact"]
  uri = "https://app.example.com/webhooks"
  ```
- Endpoints: HTTPS (gültiges SSL), AWS EventBridge ARN oder Google Pub/Sub.

---

## 4. Protected Customer Data

**Quelle:** <https://shopify.dev/docs/apps/launch/protected-customer-data>

### Zugriffsstufen
- **Level 0:** keine Kundendaten – keine Aktion.
- **Level 1:** Kundendaten ohne Name/Adresse/Telefon/E-Mail – Zugriff im Partner Dashboard beantragen.
- **Level 2:** inkl. Name/Adresse/Telefon/E-Mail – Zugriff **+ Data-Protection-Review**.

**Geschützte Quellen:** Customers, Orders/Draft Orders/Refunds/Transactions, Shipping/Fulfillment, kundenbezogene Webhooks & Metafields, Checkout/Payment, Online-Store-Kommentare, Einzelkunden-Gift-Cards. (Produkt-Queries / nicht-individuelle Daten sind NICHT geschützt.)

**Geschützte Felder (einzeln beantragen):** Name (Vor/Nach), Adresse (Zeile 1–2, Geolocation, Billing/Shipping-PLZ), E-Mail, Telefon.

### Level-1-Pflichten (zwingend)
Datenminimierung · Merchant-Transparenz · Zweckbindung · Kunden-Consent respektieren · Opt-out aus Datenweitergabe („Data Sale“) · Opt-out automatisierter Entscheidungen mit rechtlicher Wirkung · Datenschutzvereinbarungen mit Merchants · Aufbewahrungsfristen · **Verschlüsselung at rest & in transit**.

### Level-2-Pflichten (zusätzlich, zwingend)
Backups verschlüsseln · Test-/Produktionsdaten trennen · Data-Loss-Prevention-Strategie · Mitarbeiter-Zugriff beschränken · starke Passwörter · Zugriffslog auf geschützte Daten · Security-Incident-Response-Policy.

**API-Verhalten:** Genehmigte Felder liefern Daten; nicht genehmigte liefern `null` mit HTTP 200, Grund im `errors`-Hash. Review wird strenger bei hohen Install-Zahlen / großen Kundenmengen / mehr Feldern / längerer Aufbewahrung.

**Antragsweg:** Partner Dashboard → Apps → App → API Access Requests → Protected customer data access → Request access → Daten/Felder + Begründung → Data protection details → Submit for review.

---

## 5. Billing-Anforderungen

**Quelle:** <https://shopify.dev/docs/apps/launch/billing>

- **Pflicht:** Shopify-Billing-Lösung – Shopify App Pricing (Managed, empfohlen) oder Manual Pricing / Billing API (Legacy). Off-Platform-Billing verboten.
- Charge-Typen: recurring (free/monatlich/jährlich), usage-based (App Events API), one-time (nur Manual Pricing).
- Plan-Wechsel **ohne Support-Kontakt** möglich (Ref. Req. 1.2.3).
- Multi-Currency via `shopBillingPreferences` (GraphQL).
- Shopify übernimmt Chargebacks; Entwickler erhält automatisch Revenue Share.
- Best Practice: einfache Preise, wenige Pläne, Free Trials (an Shopifys $1-Trial ausrichten), in lokaler Merchant-Währung abrechnen.

> Repo-Referenz: `docs/architecture/BILLING_SYSTEM.md`, `docs/architecture/PLAN_SYSTEM.md` mit diesen Regeln abgleichen.

---

## 6. Partner Program Agreement & rechtliche Pflichten

### 6.1 Partner Program Agreement (PPA)

**Quelle:** <https://www.shopify.com/partners/terms>
Geltendes Recht: Ontario, Kanada (ausschließlicher Gerichtsstand Ontario).

- **Revenue Share:** Von Shopify nach eigenem Ermessen festgelegt (aktuelle Sätze in den Billing-Docs/Help-Center, nicht im Vertragstext fixiert).
- **Auszahlung (Shopify Billing Resource):** zweimal pro Kalendermonat; Mindestguthaben **25 USD**, sonst Übertrag.
- **Auszahlung (Manual Billing, nur mit schriftlicher Shopify-Erlaubnis):** monatlich per Wire/ACH; Mindestguthaben **1.000 USD**. Kontakt: `app-commissions@shopify.com`.
- **Merchant-Daten:** nur zur Leistungserbringung nutzen/speichern; **nicht verkaufen/weitergeben**; nur so lange wie nötig aufbewahren.
- **KI/ML-Beschränkung:** Keine Nutzung von API-/Merchant-Daten zum Erstellen/Trainieren/Fine-Tunen/Verbessern von ML-/KI-Systemen **ohne vorherige schriftliche Zustimmung von Shopify ODER des Merchants**. ⚠️ **Für ContentPilot kritisch prüfen**, da KI-gestützte Content-Generierung.
- **Datenleck-Meldung:** sofort, spätestens **innerhalb von 24 Stunden** nach Entdeckung.
- **Verbotene Aktivitäten:** Review-Manipulation; Crypto-Mining/SEO-Fälschung/obfuskierter Code; kriminelle/betrügerische Nutzung; mehrere Apps mit im Wesentlichen gleichem Service; Ersetzen der Kreditkarten-Felder im Checkout ohne schriftliche Zustimmung.
- **IP/Trademark:** Entwickler behält App-IP; gewährt Shopify weltweite, nicht-exklusive Lizenz an Marken/Logos. Keine Shopify-Trademarks (oder Varianten/Tippfehler) im Firmen-/Produktnamen; kein PPC/Keyword-Kauf auf Shopify-Marken.
- **Sanktionen/Geografie:** kein Sanctioned Person / Unsupported Region. Liste: <https://help.shopify.com/en/manual/your-account/legal/unsupported-countries-and-regions>
- **Merchant-Vereinbarung:** schriftliche Vereinbarung mit Merchants erforderlich (Pflichtinhalte siehe API Terms).
- **Kündigung:** beidseitig jederzeit, mit/ohne Grund, sofort wirksam; Shopify ohne Vorankündigung bei Betrug/AUP-Verstoß. Audit-Rechte überdauern Kündigung.
- **Indemnification:** Entwickler stellt Shopify frei (App-Nutzung, IP-Verletzung, Merchant-Beziehungen).
- **Ad-Badge-Nutzung:** durch Part A, Section 5.2 des PPA gewährt.

### 6.2 API License and Terms of Use

**Quelle:** <https://www.shopify.com/legal/api-terms>
**Compliance-Guidelines:** <https://shopify.dev/docs/apps/build/compliance/api-terms-compliance>

- **Rate Limits:** einhalten (<https://shopify.dev/api/usage/rate-limits>); keine Umgehung; kein Benchmarking/Monitoring.
- **Pflicht-Sync Customer Data** (Public Apps): erhobene/aktualisierte Kundendaten automatisch ins Merchant Store Admin synchronisieren (oder manuelle Sync-Funktion). Felder z. B.: `firstName`, `lastName`, `phone`, `email`, `state`, `taxExempt`, `addresses`, Marketing-Consent-Felder. Ohne Sensitive Personal Information.
- **Pflicht-Sync Order Data:** verfügbare Order-Daten via definierte Mutations (`orderEdit*`, `refundCreate`, `returnCreate`, `orderCancel`, `fulfillment*` etc.) bzw. `orderCreate` für Drittplattform-Orders.
- **Datenlöschung:** alle Kopien innerhalb **30 Tagen** nach Uninstall / Wegfall / Löschanfrage.
- **Datenleck:** Meldung innerhalb **24 Stunden**; Behebung auf eigene Kosten.
- **KI/ML-Verbot:** s. o. – ohne Shopify-/Merchant-Zustimmung untersagt.
- **Consent Tracking API** integrieren (Customer Privacy API).
- **Verbotene Nutzung:** Scraping/Data-Mining; Commerce/Produkt-Index aufbauen; Custom App für >1 Merchant; Apps zur Migration weg von Shopify; Crypto-Mining im App-Code.
- **Checkout-Exklusivität:** kein alternativer Checkout ohne schriftliche Genehmigung.
- **Merchant-Agreement-Pflichtinhalte:** Entwickler allein verantwortlich; Shopify nicht haftbar; Shopify kann nicht beim App-Support helfen; Entwickler haftet allein.
- **Developer Privacy Policy** erforderlich; Compliance mit DSGVO, ePrivacy (2002/58/EC), PIPEDA, FTC Act, COPPA.
- **Haftungsobergrenze Shopify: 100 USD** aggregiert; „as-is“, alle Gewährleistungen ausgeschlossen.
- **Updates:** stets aktuellste API-Version nutzen; Weiternutzung nach Update = Zustimmung.

### 6.3 Acceptable Use Policy (AUP)

**Quelle:** <https://www.shopify.com/legal/aup>

- Gesetze/Plattformregeln befolgen; keine Gewalt/Selbstschädigung; keine HIPAA-PHI.
- Kein Betrug an Shopify/Merchants/Käufern; kein Spam; kein „Gaming“ der Systeme.
- Enforcement: Notice → Selbstkorrektur → Produkt-Level → Account-Kündigung als letztes Mittel.

### 6.4 Privacy Policy (Partner)

**Hauptpolicy:** <https://www.shopify.com/legal/privacy>
**Partner-spezifisch:** <https://www.shopify.com/legal/privacy/partners>
**Subprozessoren:** <https://help.shopify.com/en/manual/your-account/privacy/GDPR/subprocessors>
**Privacy-Policy-Vorlage:** <https://shopify.dev/concepts/app-store/getting-your-app-approved/data-and-user-privacy/privacy-policy-template>

- Shopify = Controller für direkt erhobene Partnerdaten, Processor für Merchant-Kundendaten (Merchant = Controller, App ≈ Sub-Processor).
- Kein separates „Data Protection Addendum“ – DPA-Pflichten sind in den API Terms + Partner Privacy Policy eingebettet.

> Repo-Referenz: `docs/architecture/GDPR_COMPLIANCE.md`, `docs/SESSION_PII_ENCRYPTION_SETUP.md`,
> `docs/API_KEY_ENCRYPTION_SETUP.md` gegen diese Pflichten prüfen.

---

## 7. Go-to-Market Success (nach dem Launch)

**Quelle:** <https://shopify.dev/docs/apps/launch/distribution/go-to-market-success>

Nach Genehmigung ist die App standardmäßig gelistet. Acht empfohlene Aktivitäten:

1. **App-Qualität verbessern → Built for Shopify** (siehe [Abschnitt 8](#8-built-for-shopify-bfs--qualit%C3%A4tsstatus)).
2. **Verbotene Aktionen vermeiden** (siehe [Abschnitt 9](#9-verbotene-aktionen--policy-verst%C3%B6%C3%9Fe)).
3. **Marketing über Shopify** – <https://shopify.dev/docs/apps/launch/marketing>
4. **Shopify App Store Ad Badge** verwenden – <https://shopify.dev/docs/apps/launch/marketing/shopify-brand-assets>
5. **Pressemitteilung** versenden – <https://shopify.dev/docs/apps/launch/marketing/write-press-release>
6. **Reviews managen** – <https://shopify.dev/docs/apps/launch/marketing/manage-app-reviews>
7. **Tech-Support anbieten** – <https://shopify.dev/docs/apps/launch/distribution/support-your-customers>
8. **Nutzung tracken** – <https://shopify.dev/docs/apps/launch/distribution/track-app-usage>

### 7.1 Marketing

**Quelle:** <https://shopify.dev/docs/apps/launch/marketing>

- Extern: Webinare, YouTube/Vimeo-Tutorials, Facebook-Retargeting, E-Mail, Shopify Community/Reddit.
- Community Code of Conduct beachten (kein Spam); Freemium erhöht Retention/Install-Rate.
- Listing-SEO: alle Felder ausfüllen, Korrekturlesen, Google Ads Keyword Planner, keine Symbole in Keywords („tshirt“ statt „t-shirt“), mehrere Schreibweisen.
- **Verbot:** keine Fake-Reviews / Anreize → Entfernung aus App Store.

### 7.2 Pressemitteilung

**Quelle:** <https://shopify.dev/docs/apps/launch/marketing/write-press-release>

- **Pflicht:** Vor Veröffentlichung jeder Shopify erwähnenden Mitteilung E-Mail an **`press@shopify.com`**. Review **bis zu 1 Woche** – früh einsenden.
- Struktur: Headline · Opening (eigenständig, kritische Infos) · Background · Executive-Quote · Detail/Chart · Partner-Quote · Call to Action · Boilerplate.

### 7.3 Shopify Brand Assets / Ad Badge

**Quelle:** <https://shopify.dev/docs/apps/launch/marketing/shopify-brand-assets>
**Download:** <https://shopify.dev/zip/shopify-app-store-badges.zip>

- Zwei Versionen (bevorzugt weiß-auf-schwarz / alternativ schwarz-auf-weiß).
- **Mindesthöhe 30 px**; Mindestabstand = halbe Badge-Höhe ringsum.
- Nie: beschneiden, verzerren, drehen, umfärben, Gradient/Schatten, animieren, umrahmen, über Logos legen.
- Nutzung erfordert schriftliche Shopify-Autorisierung (für Partner: PPA Part A, Section 5.2).
- Auf Webseiten muss der Badge auf das App-Store-Listing verlinken.

### 7.4 Reviews managen

**Quelle:** <https://shopify.dev/docs/apps/launch/marketing/manage-app-reviews>

- Gesamtrating gewichtet (Aktualität/Nützlichkeit/Vertrauen), kein simpler Durchschnitt.
- **AI-Review-Summaries:** benötigen **≥ 100 Reviews mit Text UND ≥ 4.0 Rating**; bis zu **14 Tage** bis Anzeige.
- Deep-Link: `https://apps.shopify.com/[app]#modal-show=WriteReviewModal`.
- **Erlaubt:** neutrale Feedback-Anfrage nach Support, in-product, nicht blockierend.
- **Verboten:** Bitte um positive Reviews; incentivierte Reviews; unaufgeforderte Review-Mails (CASL/CAN-SPAM); erzwungene Edits negativer Reviews; Fake/bezahlte Reviews; Anfrage während Onboarding.
- Antworten: Account-Owner oder Staff mit „Manage public listings“.
- **Konsequenzen bei Verstoß:** Review-Entfernung, Ranking-Abstufung, Entfernung von Promo-Flächen, Unpublishing.

### 7.5 Support

**Quelle:** <https://shopify.dev/docs/apps/launch/distribution/support-your-customers>

- **Alle Public Apps: mind. ein Support-Kanal.** Gültige Support-E-Mail muss immer gepflegt sein.
- Kanäle: E-Mail (Pflicht/Default), Support-Portal-URL (optional), Telefon (optional, nur Anzeige).
- Sichtbar an 3 Stellen: App-Settings im Admin, App-Home-Aktionsmenü, App-Store-Listing.

### 7.6 Nutzung tracken

**Quelle:** <https://shopify.dev/docs/apps/launch/distribution/track-app-usage>

- Partner Dashboard → Apps → App → Overview; Default 30 Tage; Export Merchants/Earnings/History.
- **Datenverzug bis 10 Minuten.**
- Earnings: RecurringApplicationCharge bis **37 Tage**; ApplicationCharge innerhalb **7 Tage**.
- Charge verfällt ohne Merchant-Aktion innerhalb **48 Stunden**.

### 7.7 App Store Ads

**Quelle:** <https://shopify.dev/docs/apps/launch/marketing/advertising>

- Cost-Per-Click (CPC); relevante Apps zahlen weniger / ranken höher.
- Nur publizierte Apps; Partner in gutem Standing; ein Ad = eine App.

---

## 8. Built for Shopify (BFS) – Qualitätsstatus

**Quelle Übersicht:** <https://shopify.dev/docs/apps/launch/built-for-shopify>
**Anforderungen:** <https://shopify.dev/docs/apps/launch/built-for-shopify/requirements>
**Achievement Criteria:** <https://shopify.dev/docs/apps/launch/built-for-shopify/achievement-criteria>
**Status verlieren/zurückgewinnen:** <https://shopify.dev/docs/apps/launch/built-for-shopify/regain-lost-status>

### 8.1 Was es bringt
Highlight oben im Listing · Badge auf App-Cards · Such-Filter · **Priority App Review für künftige Submissions** · Plan-basiertes Ad-Targeting · höheres Such-Ranking · Eligibility für Homepage-/Admin-Discovery („Picked for you“) · Story-Pages.

### 8.2 Beantragung & Pflege
- Antrag: Partner Dashboard → Apps → App → **Distribution** → „Apply now“ (Berechtigung „Manage apps“).
- **Gleiches Kriterium 3× in Folge nicht bestanden → Antrag 3 Monate gesperrt.**
- **Jährliche** Überprüfung; **60 Tage** Frist zur Behebung, sonst Statusverlust.
- Automatisch geprüfte Kriterien: nach **60 Tagen** Verstoß Status verloren; automatische Rückgewinnung bei Wiedererfüllung (keine Neubewerbung nötig).

### 8.3 Voraussetzungen (Prerequisites)
- App-Store-Anforderungen weiterhin erfüllt (Audit bei Antrag).
- Gutes Partner-Standing (keine aktiven Infractions).
- **≥ 50 Netto-Installs** von aktiven Shops auf **bezahlten** Plänen.
- **≥ 5 Reviews.**
- Mindest-Rating (Wert nicht öffentlich genannt).

### 8.4 Performance (zwingend)
**Admin** (75. Perzentil, **≥ 100 Calls / 28 Tage**, via neueste App Bridge / Web Vitals):
- **LCP ≤ 2,5 s**
- **CLS ≤ 0,1**
- **INP ≤ 200 ms**

**Storefront:** Lighthouse-Score-Reduktion **≤ 10 Punkte**.

**Checkout** (Carrier-/Rate-Apps, **≥ 1.000 Requests / 28 Tage**): **p95 ≤ 500 ms**, **Failure-Rate ≤ 0,1 %** (Carrier-Services: **≥ 99,9 % Erfolg**).

Mess-Details: <https://shopify.dev/docs/apps/build/performance/admin-installation-oauth> · <https://shopify.dev/docs/apps/build/performance/checkout>

### 8.5 Integration (zwingend)
- Embedded im Admin via neueste App Bridge (`app-bridge.js` im `<head>`), Session-Token-Auth, keine externen Seiten einbetten.
- Primär-Workflows im Admin abschließbar.
- Nahtloser Signup via Shopify-Credentials, sofort nutzbar.
- Key-Metriken auf App-Home zeigen.
- Third-Party-Connection-Settings innerhalb der embedded App.
- Clean Uninstall via Theme App Extensions.
- Keine Asset-API-Modifikation von Theme-Dateien (Ausnahmen: Page Builder, Backup/Restore, read-only SEO/Dev-Tools).

### 8.6 Design (zwingend, außer „empfohlen“)
- **Familiar:** Shopify-UX (Cards, Admin-Buttons, Sans-Serif), **WCAG 2.1 AA Kontrast**, mobile-friendly, kurzer App-Name (keine Truncation), App-Bridge-Navigation `s-app-nav`, Contextual Save Bar, korrekte Modals (`s-modal`).
- **Helpful:** korrekte Rechtschreibung, knappes/dismissbares Onboarding, hilfreiche Homepage & Fehlermeldungen, logische Aktions-Hierarchie, Echtzeit-Previews.
- **User-friendly (Verbote):** keine falschen Outcome-Claims; keine Druck-Taktiken/Countdowns/5-Stern-Belohnungen; keine Auto-Popups/Ablenkungen; max. 1 Banner pro Bereich; keine Shopify-Imitation (kein Sidekick-Icon / „Magic“-Lila); dismissbare Ads; Premium-Features visuell+funktional deaktiviert (Plus-Features für Nicht-Plus verborgen).

### 8.7 Kategorie-spezifisch (Auswahl)
- Ads/Affiliate/Analytics/E-Mail/SMS/Forms: Web-Pixel-Extensions, Shopify Segments, Visitors API, Customer-Data-Sync.
- Carrier Services: ≥ 1.000 Req/28 T, p95 ≤ 500 ms, ≥ 99,9 % Erfolg.
- Discount Apps: Discount Functions / native APIs; `discountRedeemCodeBulkAdd`.
- Fulfillment: ≥ 100 Orders/28 T; 99 % Completion; Tracking 80 % < 1 h; Response 99 % < 4 h; Cancel 99 % < 1 h.
- Subscriptions/Bundles/Reviews/Returns/Invoices: jeweils vorgeschriebene Primitives/Extensions.

> **Hinweis:** Exakter Mindest-Rating-Wert ist nicht publiziert. App Bridge: „neueste“ Version
> (keine fixe Versionsnummer). Session-Token-Auth für embedded Apps faktisch Pflicht.

---

## 9. Verbotene Aktionen / Policy-Verstöße

**Quelle:** <https://shopify.dev/docs/apps/launch/app-store-review/policy-violations>

- Einhaltung von **Partner Program Agreement** (<https://www.shopify.com/partners/terms>) und **API License and Terms of Use** (<https://www.shopify.com/legal/api-terms>).
- Verstöße können zur Entfernung aus dem App Store führen; Maßnahmen variieren je nach Policy.
- Enforcement-Details: <https://help.shopify.com/partners/faq/removal>
- Verstoß melden: <https://www.shopify.com/legal/tools/report-an-issue/report-a-partner-violation>

---

## 10. Numerische Schwellenwerte – Gesamtreferenz

| Kennzahl | Schwellenwert | Bedingung |
|---|---|---|
| Netto-Installs (BFS) | ≥ 50 | aktive Shops, bezahlte Pläne |
| Reviews (BFS) | ≥ 5 | — |
| App-Rating (BFS) | Minimum (nicht publiziert) | aktuelles Rating |
| LCP (Admin) | ≤ 2,5 s | 75. Perzentil, ≥ 100 Calls/28 T |
| CLS (Admin) | ≤ 0,1 | 75. Perzentil, ≥ 100 Calls/28 T |
| INP (Admin) | ≤ 200 ms | 75. Perzentil, ≥ 100 Calls/28 T |
| Lighthouse-Impact (Storefront) | ≤ 10 Punkte | Home 17 % / Product 40 % / Collection 43 % |
| Checkout p95 | ≤ 500 ms | ≥ 1.000 Req/28 T |
| Checkout Failure-Rate | ≤ 0,1 % | ≥ 1.000 Req/28 T |
| Carrier-Service-Erfolg | ≥ 99,9 % | ≥ 1.000 Req/28 T |
| API-Deprecation-Cutoff | nicht < 90 Tage deprecated | Submission |
| App-Name-Länge | ≤ 30 Zeichen | Listing & TOML |
| App-Icon | 1200×1200 px JPEG/PNG | — |
| App-Intro / Details / Feature | ≤ 100 / ≤ 500 / ≤ 80 Zeichen | Listing |
| Screenshots | 1600×900 (16:9), 3–6 Desktop | Listing |
| Compliance-Webhook-Aktion | ≤ 30 Tage | nach Anfrage |
| `shop/redact` | 48 h nach Uninstall | — |
| `customers/redact` | 10 Tage (bzw. nach 6-Monats-Fenster) | — |
| Datenleck-Meldung | ≤ 24 Stunden | an Shopify |
| Datenlöschung nach Uninstall | ≤ 30 Tage | — |
| Auszahlung Min. (Billing Resource) | 25 USD | 2×/Monat |
| Auszahlung Min. (Manual Billing) | 1.000 USD | monatlich |
| Shopify-Haftungsobergrenze | 100 USD | aggregiert |
| Charge-Verfall | 48 Stunden | ohne Merchant-Aktion |
| BFS-Behebungsfrist | 60 Tage | alle Review-Typen |
| BFS-Antragssperre | 3× gleiches Kriterium → 3 Monate | Antragsphase |
| Press-Release-Review | bis 1 Woche | press@shopify.com |
| AI-Review-Summary | ≥ 100 Reviews + ≥ 4.0 | bis 14 Tage Anzeige |
| Post-Purchase-Requests | max. 2 aufeinanderfolgend | Kategorie-Regel |

---

## 11. Quellen-Verzeichnis (alle URLs)

**Vom Shopify-E-Mail referenziert:**
- <https://shopify.dev/docs/apps/launch/distribution/go-to-market-success>
- <https://shopify.dev/docs/apps/launch/app-store-review>
- <https://www.shopify.com/partners/terms>
- <https://shopify.dev/docs/apps/launch/built-for-shopify>

**App Store Review:**
- <https://shopify.dev/docs/apps/launch/app-store-review/review-process>
- <https://shopify.dev/docs/apps/launch/app-store-review/pass-app-review>
- <https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review>
- <https://shopify.dev/docs/apps/launch/app-store-review/policy-violations>
- <https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements>
- <https://shopify.dev/docs/apps/launch/app-requirements-checklist>
- <https://shopify.dev/docs/apps/launch/privacy-requirements>
- <https://shopify.dev/docs/apps/launch/protected-customer-data>
- <https://shopify.dev/docs/apps/launch/billing>

**Compliance / Webhooks / API:**
- <https://shopify.dev/docs/apps/build/privacy-law-compliance>
- <https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance>
- <https://shopify.dev/docs/apps/build/compliance/api-terms-compliance>
- <https://shopify.dev/api/usage/rate-limits>
- <https://shopify.dev/docs/api/usage/versioning>

**Built for Shopify:**
- <https://shopify.dev/docs/apps/launch/built-for-shopify/requirements>
- <https://shopify.dev/docs/apps/launch/built-for-shopify/achievement-criteria>
- <https://shopify.dev/docs/apps/launch/built-for-shopify/regain-lost-status>
- <https://shopify.dev/docs/apps/build/performance/admin-installation-oauth>
- <https://shopify.dev/docs/apps/build/performance/checkout>
- <https://shopify.dev/changelog?filter=built_for_shopify>

**Go-to-Market / Marketing:**
- <https://shopify.dev/docs/apps/launch/marketing>
- <https://shopify.dev/docs/apps/launch/marketing/write-press-release>
- <https://shopify.dev/docs/apps/launch/marketing/shopify-brand-assets>
- <https://shopify.dev/docs/apps/launch/marketing/manage-app-reviews>
- <https://shopify.dev/docs/apps/launch/marketing/advertising>
- <https://shopify.dev/docs/apps/launch/distribution/support-your-customers>
- <https://shopify.dev/docs/apps/launch/distribution/track-app-usage>
- <https://shopify.dev/docs/apps/launch/distribution/revenue-share>
- <https://shopify.dev/docs/apps/launch/distribution/visibility>

**Rechtlich:**
- <https://www.shopify.com/partners/terms>
- <https://www.shopify.com/legal/api-terms>
- <https://www.shopify.com/legal/aup>
- <https://www.shopify.com/legal/privacy>
- <https://www.shopify.com/legal/privacy/partners>
- <https://www.shopify.com/legal/trademarks>
- <https://help.shopify.com/partners/faq/removal>
- <https://help.shopify.com/en/manual/your-account/legal/unsupported-countries-and-regions>
- <https://help.shopify.com/en/manual/your-account/privacy/GDPR/subprocessors>
- <https://www.shopify.com/legal/tools/report-an-issue/report-a-partner-violation>
- <https://shopify.dev/concepts/app-store/getting-your-app-approved/data-and-user-privacy/privacy-policy-template>

**Asset-Downloads:**
- Submission-Templates: <https://shopify.dev/zip/SubmissionTemplates.zip>
- Ad-Badges: <https://shopify.dev/zip/shopify-app-store-badges.zip>

---

*Erstellt am 2026-05-16 durch gründliche Recherche der oben verlinkten Shopify-Seiten
inkl. Unterseiten. Bei Unstimmigkeiten gilt immer die Originalquelle – Links oben prüfen.*
