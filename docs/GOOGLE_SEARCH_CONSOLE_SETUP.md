# Google Search Console — Setup (SEO-Tab, Phase 6)

Diese Anleitung richtet die **Google-Search-Console-Integration** des SEO-Tabs ein
(`/app/seo/search-console`, nur **Pro & Max**). Sie liefert echte Ranking-,
Klick- und Impressionsdaten und reichert damit die verfolgten Keywords an.

> **Wer macht was?**
> - **Du (App-Betreiber):** legst **einmal** ein Google-Cloud-OAuth-Projekt an und
>   setzt drei Env-Vars. Eine **eine** Client-ID/Secret gilt für die **gesamte App**.
> - **Händler:** tragen **nichts** ein — sie klicken nur „Mit Google verbinden"
>   und autorisieren Zugriff auf **ihre eigene** Search-Console-Property.
>
> Solange die Env-Vars fehlen, zeigt die Sektion sauber „nicht konfiguriert".

---

## 0. Voraussetzungen

- Der Shop (bzw. die Domain) ist in der [Google Search Console](https://search.google.com/search-console)
  **verifiziert** (Domain- oder URL-Präfix-Property). Ohne verifizierte Property
  findet die App keine Daten.
- `ENCRYPTION_KEY` ist gesetzt (64 Hex-Zeichen) — wird ohnehin app-weit benötigt;
  der Google-Refresh-Token wird damit verschlüsselt gespeichert.
- Die App läuft unter einer festen HTTPS-URL (`SHOPIFY_APP_URL`).

---

## 1. Google-Cloud-Projekt + API

1. [Google Cloud Console](https://console.cloud.google.com/) öffnen → **Projekt anlegen**
   (z. B. „ContentPilot SEO").
2. **APIs & Dienste → Bibliothek** → „**Google Search Console API**" suchen → **Aktivieren**.

---

## 2. OAuth-Zustimmungsbildschirm (Consent Screen)

1. **APIs & Dienste → OAuth-Zustimmungsbildschirm**.
2. **Nutzertyp: „Extern"** wählen.
   - „Intern" gibt es nur mit Google-Workspace-Organisation und wäre für eine
     öffentliche App ohnehin falsch. **Extern** = jeder Google-Account darf
     verbinden — genau das, was wir wollen. **Kein Workspace nötig.**
3. App-Infos ausfüllen (Name, Support-E-Mail, Logo optional).
4. **Scopes** hinzufügen — die App verwendet genau diese:
   - `https://www.googleapis.com/auth/webmasters.readonly` (Analytics + URL-Inspection)
   - `https://www.googleapis.com/auth/webmasters` (Sitemap einreichen)
   - `openid`, `email` (nur um das verbundene Google-Konto anzuzeigen)

   > Diese Search-Console-Scopes gelten bei Google als **„sensibel"** (nicht
   > „restricted"). Für die **Produktion** braucht es daher Marken-/App-Verifizierung,
   > aber **kein** teures Drittanbieter-Sicherheits-Audit.
5. **Testnutzer** hinzufügen: **trage hier deine eigene Google-Adresse** (und ggf.
   weitere Test-Händler) ein. Im Testmodus blockt Google sonst auch **dich**.

---

## 3. OAuth-Client erstellen

1. **APIs & Dienste → Anmeldedaten → Anmeldedaten erstellen → OAuth-Client-ID**.
2. **Anwendungstyp: „Webanwendung"**.
3. **Autorisierte Redirect-URIs** → **exakt** diese eine URI eintragen:

   ```
   https://<DEINE-APP-URL>/auth/google/callback
   ```

   - Muss **identisch** sein mit `${SHOPIFY_APP_URL}/auth/google/callback`
     (bzw. mit `GOOGLE_OAUTH_REDIRECT_URI`, falls du sie explizit setzt).
   - Genau matchen: Schema, Host, Pfad, **kein** Trailing-Slash — sonst
     `redirect_uri_mismatch`.
   - Beispiel: `https://contentpilotai.up.railway.app/auth/google/callback`

4. **Autorisierte JavaScript-Quellen** → **leer lassen**.
   Wir nutzen den **serverseitigen** Authorization-Code-Flow (Redirect-basiert),
   keinen Browser-/JS-Token-Flow. Das Feld ist nur für clientseitige Flows nötig.

5. **Client-ID** und **Client-Secret** kopieren.

---

## 4. Environment-Variablen

Setze (Railway → Variables, oder `.env` lokal):

| Variable | Pflicht | Wert |
|---|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | ✅ | Client-ID aus Schritt 3 |
| `GOOGLE_OAUTH_CLIENT_SECRET` | ✅ | Client-Secret aus Schritt 3 |
| `GOOGLE_OAUTH_REDIRECT_URI` | optional | überschreibt den abgeleiteten Wert; sonst wird `${SHOPIFY_APP_URL}/auth/google/callback` verwendet |

`scripts/validate-env.js` meldet beim Start den Status:
- alle drei gesetzt → „✅ konfiguriert"
- keine gesetzt → „deaktiviert" (Sektion zeigt „nicht konfiguriert")
- **teilweise** gesetzt → Warnung (GSC bleibt deaktiviert, bis alle drei vorhanden sind)

Nach dem Setzen die App **neu starten/deployen**.

---

## 5. Testmodus vs. Produktion

Bei „Extern" entscheidet der **Veröffentlichungsstatus**, nicht der Nutzertyp:

| Status | Wer darf verbinden? | Verifizierung | Haken |
|---|---|---|---|
| **Testing** (Default) | nur eingetragene Testnutzer (bis 100) | ❌ nein | Refresh-Token läuft nach **7 Tagen** ab; Consent-Screen zeigt „nicht verifiziert" |
| **In Produktion** | alle Händler | ✅ ja (sensible Scopes) | Google-Freigabeprozess (kostenlos) |

**Empfehlung:** Für Entwicklung/Beta im **Testing**-Modus bleiben (sofort nutzbar).
Vor dem öffentlichen App-Store-Launch die **Verifizierung** einplanen.

**7-Tage-Ablauf im Testmodus wird sauber abgefangen:** läuft der Token ab,
liefert Google `invalid_grant` → die App löscht die Verbindung und zeigt
**„Neu verbinden"**. Kein Crash, kein Datenverlust — einfach erneut verbinden.

---

## 6. Ablauf aus Händlersicht

1. SEO-Tab → **Search Console** (nur sichtbar/aktiv ab **Pro**).
2. **„Mit Google verbinden"** → Google-Consent (öffnet sich im ganzen Fenster,
   `target="_top"`).
3. Nach Zustimmung Rücksprung in die Sektion; die passende verifizierte Property
   wird automatisch gewählt.
4. Verfügbar: **Top-Suchanfragen (28 Tage)**, **Keyword-Rankings synchronisieren**
   (schreibt Position/Klicks/Impressionen/CTR auf die Keyword-Einträge aus Phase 5),
   **Sitemap an Google melden**, **Trennen**.

---

## 7. Troubleshooting

| Symptom | Ursache / Lösung |
|---|---|
| `redirect_uri_mismatch` | Redirect-URI im OAuth-Client ≠ App-URI. Exakt `${SHOPIFY_APP_URL}/auth/google/callback` eintragen (kein Trailing-Slash). |
| „Diese App ist nicht verifiziert" | Normal im Testing-Modus. Über **Erweitert → Weiter zu … (unsicher)** fortfahren. Für Produktion: verifizieren. |
| Verbindung „abgelaufen/widerrufen" | Im Testmodus nach 7 Tagen erwartbar. Einfach **„Neu verbinden"**. |
| „nicht konfiguriert" in der Sektion | `GOOGLE_OAUTH_*`-Env-Vars fehlen oder unvollständig → siehe Schritt 4. |
| Verbunden, aber keine Daten | Property in der Search Console nicht/zu neu verifiziert, oder noch keine 2–3 Tage Daten. Wir fragen nur **finalisierte** Daten ab (`dataState: final`). |
| `access_denied` / Login blockiert | Eigene Adresse als **Testnutzer** eintragen (Schritt 2.5). |

---

## 8. Sicherheit / Datenschutz (für die Akte)

- Der **Refresh-Token** wird **verschlüsselt** gespeichert (AES-256-GCM, gleiche
  Utility wie die KI-API-Keys) — Spalte `GoogleSearchConsoleConnection.refreshToken`.
- **Access-Tokens** werden pro Request aus dem Refresh-Token abgeleitet und **nie**
  persistiert.
- Der OAuth-`state` ist **HMAC-signiert** (CSRF-Schutz; trägt shop/host für den
  Rücksprung in die eingebettete App).
- Die Verbindung ist **shop-scoped** und wird bei Deinstallation/GDPR-Redact
  vollständig gelöscht (`redactShopData` → `googleSearchConsoleConnection.deleteMany`).
