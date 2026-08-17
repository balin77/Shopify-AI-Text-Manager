# AI-Provider Restguthaben – Machbarkeitsanalyse

> **Status: Recherchiert, NICHT umgesetzt (Stand 2026-07-05).**
> Dieses Dokument hält den Rechercheergebnis fest, damit die Frage nicht erneut
> von Grund auf untersucht werden muss, falls das Feature später doch geplant wird.

## Ausgangsfrage

Alle AI-Provider, die mit ContentPilot verbunden werden können, kosten Geld. Der
Merchant muss aktuell die jeweilige Provider-Webseite ansteuern, um sein
Restguthaben zu sehen. Frage: Lässt sich das Restguthaben in den Settings direkt
abfragen und anzeigen?

Kontext: ContentPilot nutzt **Bring-Your-Own-Key** (jeder Shop hinterlegt seinen
eigenen, verschlüsselt gespeicherten API-Key – siehe `encryption.server.ts`,
`SettingsAITab.tsx`). Es gibt bewusst keinen Operator-Key (Shopify PPA / API-Terms).

## Kernergebnis

**Teilweise machbar, aber uneinheitlich.** Es existiert kein providerübergreifender
Standard für „Restguthaben". Mit dem **Inference-Key**, den der Merchant bereits
hinterlegt hat, funktioniert es nur bei einem Teil der Provider.

## Stand pro Provider

| Provider | Restguthaben abfragbar? | Wie / Warum nicht |
|---|---|---|
| **DeepSeek** | ✅ Ja, sauber | `GET https://api.deepseek.com/user/balance` mit **demselben** Bearer-Key. Liefert `total_balance`, `granted_balance`, `topped_up_balance` + `is_available`. |
| **Grok / xAI** | ⚠️ Ja, aber **separater Key** | Billing-Endpunkt auf `management-api.x.ai` – braucht einen eigenen **Management-Key** (Read-Rechte), NICHT den Inference-Key aus den Settings. |
| **Claude / Anthropic** | ⚠️ Nur Usage/Cost, kein Guthaben | Usage & Cost Admin API (`/v1/organizations/...`) braucht einen **separaten Admin-Key** (`sk-ant-admin…`). Zeigt Verbrauch/Kosten, **kein** verbleibendes Prepaid-Guthaben. |
| **OpenAI** | ❌ Nein | Kein offiziell unterstützter Endpunkt. Das alte `/dashboard/billing/credit_grants` ist session-/cookie-basiert, inoffiziell und für Prepaid faktisch tot. Nur über Dashboard. |
| **Gemini / Google** | ❌ Praktisch nein | Abrechnung über Google Cloud Billing (OAuth, komplex) – nicht über den Gemini-API-Key. Kein simpler Guthaben-Endpunkt. |
| **HuggingFace** | ❌ Nein | Abo-/PRO-Modell, kein monetäres Per-Key-Guthaben. |

## Konsequenz für eine spätere Umsetzung

Ein einheitlicher „So viel Geld hast du noch"-Wert für alle Provider ist **nicht**
machbar. Realistisch wäre nur ein **kapabilitäts-basiertes Best-Effort-Feature**:

1. **Sofort, ohne Extra-Aufwand für den Merchant:** nur **DeepSeek** – funktioniert
   mit dem bereits hinterlegten Key.
2. **Optional, wenn der Merchant einen zweiten Key hinterlegt:** **Grok**
   (Management-Key) und **Claude** (Admin-Key, aber nur Kosten/Verbrauch statt
   Restguthaben).
3. **Nicht per API möglich:** OpenAI, Gemini, HuggingFace → nur Deep-Link
   „Guthaben im Dashboard prüfen ↗" zur jeweiligen Billing-Seite.

### Technische Leitplanken (falls doch umgesetzt)

- Balance-Calls **serverseitig** ausführen (Keys liegen verschlüsselt vor,
  `encryption.server.ts`) – niemals den Key an den Client geben.
- **Kurzer Cache**, damit nicht jeder Settings-Aufruf eine Fremdanfrage auslöst.
- Anzeige direkt neben dem jeweiligen API-Key-Feld in `SettingsAITab.tsx`.

## Quellen

- [DeepSeek – Get User Balance](https://api-docs.deepseek.com/api/get-user-balance)
- [xAI – Billing Management (Management API)](https://docs.x.ai/developers/rest-api-reference/management/billing)
- [Anthropic – Usage and Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api)
- [OpenAI Community – kein offizieller Guthaben-Endpunkt](https://community.openai.com/t/add-api-endpoint-to-check-remaining-credits-or-balance-on-openai-account/1365221)
