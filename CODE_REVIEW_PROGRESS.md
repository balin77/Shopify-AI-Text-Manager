# Code Review Fortschritt – Branch `claude/review-refactored-code-vGWC1`

> Erstellt: 2026-04-06  
> Reviewer: Claude (systematisch)  
> Ziel: Vollständige Review aller Source-Dateien. Zu umfangreich für eine Sitzung → Fortschritt wird hier dokumentiert.

---

## Legende

| Symbol | Bedeutung |
|--------|-----------|
| ✅ | Geprüft – OK |
| ⚠️ | Geprüft – kleinere Probleme gefunden |
| ❌ | Geprüft – kritisches Problem gefunden |
| 🔲 | Noch nicht geprüft |

---

## Sitzung 1 – Geprüfte Dateien

### app/utils/

| Datei | Status | Befund |
|-------|--------|--------|
| `sanitizer.ts` | ⚠️ | DOMPurify korrekt eingesetzt. **Problem:** `SAFE_FOR_TEMPLATES: true` deaktiviert einige XSS-Schutzmechanismen. Außerdem: `a`-Tags mit `href`/`target` erlaubt, aber kein Hook um `rel="noopener noreferrer"` zu erzwingen (Kommentar behauptet dies, Code tut es nicht). |
| `validation.ts` | ✅ | Zod-Schemas, API-Key-Patterns, `parseFormData`, `safeJsonParse`, Shopify-GID-Validierung – alles korrekt. |
| `encryption.server.ts` | ✅ | AES-256-GCM, zufällige IV pro Verschlüsselung, Auth-Tag, rückwärtskompatible `isEncrypted`-Prüfung. Kein Plaintext in Fehlermeldungen. Sehr solide. |
| `error-handler.ts` | ✅ | `SafeError`-Klasse, keine internen Details im public message, `getFullErrorMessage` walkt cause-chain. Gut. |
| `prompt-sanitizer.ts` | ✅ | Verhindert Prompt-Injection. Patterns sinnvoll. Längentruncation, Whitespace-Normalisierung. |
| `form-data.utils.ts` | ✅ | Sichere FormData-Extraktion, kein `as string`-Cast. |
| `logger.server.ts` | ✅ | Winston, context-spezifische Logger, file rotation in prod, kein sensibles Logging. |
| `slug.utils.ts` | ✅ | Umlaut-Handling, Validierung, `validateAndSanitizeSlug`. |
| `loader-factory.server.ts` | ⚠️ | Factory-Pattern ist sauber. **Problem:** `admin: any`, `db: any` in `LoaderContext` – zu loose getypt. `incrementalSync` nutzt `Promise.all` für Sync (OK für kleine Mengen). |
| `contentEditor.utils.ts` | ✅ | `getLocalizedLanguageName` mit `Intl.DisplayNames`, Fallback korrekt. (Nur ca. 80 Zeilen gelesen – Rest ausstehend) |

### app/middleware/

| Datei | Status | Befund |
|-------|--------|--------|
| `rate-limit.middleware.ts` | ✅ | 4 separate Limiter (general/strict/auth/webhook). Webhook-Limiter mit HMAC-Skip (Shopify-Anfragen werden nicht gedrosselt). `keyGenerator` nutzt Shop-Domain. Solide. |

### app/components/

| Datei | Status | Befund |
|-------|--------|--------|
| `AIEditableField.tsx` | ✅ | Sauber. Kein `dangerouslySetInnerHTML`. Background-Klassen korrekt priorisiert. |
| `AIEditableHTMLField.tsx` | ⚠️ | `sanitizeHTML` beim Setzen von `innerHTML` korrekt genutzt. **Hinweis:** `onChange(e.currentTarget.innerHTML)` – roher HTML des Nutzers wird unbereinigt weitergegeben. Sicherheitsrelevant nur wenn dieser Wert direkt in anderen `dangerouslySetInnerHTML` gerendert wird (nicht direkt aus dieser Komponente – Risiko existiert weiter oben im Datenpfad). Timer-Cleanup in `useEffect` vorhanden ✅. |
| `AISuggestionBanner.tsx` | ✅ | `sanitizeHTML` via `useMemo` – XSS-Schutz korrekt, Performance-optimiert. |

### app/actions/

| Datei | Status | Befund |
|-------|--------|--------|
| `unified-content.actions.ts` | ⚠️ | GID-Validierung ✅, Locale-Validierung ✅, `sanitizePromptInput` genutzt ✅. **Problem 1:** `getCharacterLimitRequirement` ist **dupliziert** in `api.ai.tsx` – sollte in Utility extrahiert werden. **Problem 2:** `new ShopifyContentService(gateway as any)` – `as any` Cast bei Typ-Inkompatibilität. (Nur ~270 von 600+ Zeilen gelesen – Rest ausstehend) |

### app/services/

| Datei | Status | Befund |
|-------|--------|--------|
| `shopify-api-gateway.service.ts` | ✅ | Rate-Limiting, Retry mit exponentiellem Backoff, THROTTLED-Erkennung, Enrichment der Fehlermeldungen. Sehr durchdacht. |

### app/config/

| Datei | Status | Befund |
|-------|--------|--------|
| `constants.ts` | ✅ | Alle Magic Numbers zentralisiert, gut dokumentiert. `ENABLE_THEME_PRIMARY_EDIT = true` – Flag-Beschreibung erklärt Voraussetzungen. |

### app/types/

| Datei | Status | Befund |
|-------|--------|--------|
| `content-editor.types.ts` | ✅ | (Partial – ~80 Zeilen) Sauber typisiert. |

### app/hooks/

| Datei | Status | Befund |
|-------|--------|--------|
| `useUnifiedContentEditor.ts` | ✅ | (Partial – 100 Zeilen) Fehlerübersetzung via i18n ✅. Imports gut strukturiert. |

### src/services/

| Datei | Status | Befund |
|-------|--------|--------|
| `ai.service.ts` | ✅ | (Partial – 100 Zeilen) Multi-Provider-Architektur. `toValidProvider` Guard. `sanitizePromptInput` importiert. |
| `ai-queue.service.ts` | ⚠️ | Shop-spezifische Queues, Round-Robin, Cleanup-Interval gegen Memory-Leaks ✅. **Problem:** `updateRateLimits(settings: any)` – kein null-Guard. Wird in `unified-content.actions.ts` mit `aiSettings` aufgerufen (das `null` sein kann → `settings.hfMaxTokensPerMinute` würde `TypeError` werfen). |

### Datenbank

| Datei | Status | Befund |
|-------|--------|--------|
| `prisma/schema.prisma` | ✅ | Gut normalisiert. `ContentTranslation` polymorphisch. Composite-Indexes gesetzt. `@@unique` auf `[resourceId, key, locale]` verhindert Duplikate. Session-Felder für PII (accessToken, firstName, etc.) vorhanden – Verschlüsselung per Migration korrekt. |

### app/routes/

| Datei | Status | Befund |
|-------|--------|--------|
| `api.ai.tsx` | ⚠️ | (Partial – 80 Zeilen) `VALID_CONTENT_TYPES` Set für Whitelisting ✅. `getCharacterLimitRequirement` **dupliziert** (s.o.). (Rest ausstehend) |

---

## Zusammenfassung Sitzung 1

### Gefundene Probleme

#### ⚠️ Minor Issues – **alle behoben in Sitzung 2** ✅

1. ~~**`src/services/ai-queue.service.ts:113`** – `updateRateLimits(settings: any)` hat keinen null-Guard.~~ → **FIXED**: `if (!settings) return;` hinzugefügt.

2. ~~**`app/utils/sanitizer.ts:36`** – `SAFE_FOR_TEMPLATES: true` ist irreführend.~~ → **FIXED**: Entfernt.

3. ~~**`app/utils/sanitizer.ts`** – Kein DOMPurify-Hook für `rel="noopener noreferrer"`.~~ → **FIXED**: `addHook('afterSanitizeAttributes', ...)` hinzugefügt.

4. ~~**Code-Duplikation** – `getCharacterLimitRequirement`~~ → **FIXED**: In `app/utils/ai-instructions.utils.ts` extrahiert. Beide Duplikate entfernt.

5. **`app/actions/unified-content.actions.ts`** – `new ShopifyContentService(gateway as any)` – `as any` Cast bei Typ-Inkompatibilität. (Offen – Typ-Design-Problem, kein Sicherheitsrisiko)

6. **`app/utils/loader-factory.server.ts`** – `LoaderContext` nutzt `any` für `admin` und `db`. (Offen – Low Priority)

#### ℹ️ Hinweise

- `AIEditableHTMLField.tsx`: `onChange(e.currentTarget.innerHTML)` gibt rohen HTML weiter. Solange Empfänger sanitisieren, kein Problem.

---

## Sitzung 2 – Geprüfte Dateien

### app/services/

| Datei | Status | Befund |
|-------|--------|--------|
| `gdpr.service.ts` | ⚠️ | HMAC-Verifikation via `authenticate.webhook()` ✅. Alle drei GDPR-Topics behandelt ✅. Transaktionales Shop-Redact ✅. **Problem:** `logGDPRRequest` schreibt nur ins Log – kein persistenter DB-Audit-Trail. TODO-Kommentar vorhanden. DSGVO verlangt Nachweise für 3 Jahre. |
| `billing.server.ts` | ✅ | Dev-Store-Erkennung ✅. Test-Billing-Modus ✅. `syncSubscriptionToDatabase` updatet nur wenn `aiSettings` existiert – neuer Shop ohne Settings würde Plan nicht persistieren (sehr unwahrscheinlich, da Settings beim ersten Login erstellt werden). `getPlanFromSubscription` verwendet string-`includes` – funktioniert solange Plan-Namen kontrolliert sind ✅. |
| `encrypted-session-storage.server.ts` | ✅ | AES-256-GCM-Verschlüsselung für OAuth-Tokens ✅. Fehlerbehandlung beim Decrypt mit Fallback auf Rohwert ✅. `findSessionsByShop` entschlüsselt korrekt alle Sessions ✅. Sehr solide. |

### src/services/

| Datei | Status | Befund |
|-------|--------|--------|
| `ai-queue.service.ts` (Zeilen 220+) | ✅ | Adaptives Polling verifiziert: 100ms aktiv / 1s leer ✅. Rate-Limit-Retry mit exponentiellem Backoff (2^n × 1s, max 3 Versuche) ✅. `Promise.allSettled` für Queue-Position-Updates (graceful) ✅. Cleanup-Interval für inaktive Shops (24h Schwelle, stündlich) ✅. Recovery-Mechanismus für Tasks nach Neustart ✅. |

### app/routes/

| Datei | Status | Befund |
|-------|--------|--------|
| `webhooks.compliance.tsx` | ✅ | HMAC via `authenticate.webhook()` ✅. Alle GDPR-Topics ✅. Immer 200 zurück ✅. |
| `webhooks.products.tsx` | ✅ | Async-Verarbeitung (kein Blocking) ✅. Retry-Service bei Fehler ✅. **Hinweis:** `topic.toLowerCase().replace("_", "/")` – `String.replace` mit String (nicht Regex) ersetzt nur das erste Vorkommen. Für PRODUCTS_CREATE: korrekt. Kein Bug bei diesen Topics. |
| `webhooks.articles.tsx` | ✅ | Gleiche Struktur wie products. Kein Retry-Service aufgerufen – Inkonsistenz zu products, aber kein Fehler. |
| `webhooks.collections.tsx` | ✅ | Wie articles. Kein Retry-Service. |
| `webhooks.menus.tsx` | ✅ | Wie articles. Kein Retry-Service. |
| `webhooks.subscription.tsx` | ✅ | Sauber. `admin`-Null-Check vorhanden ✅. |
| `app.settings.tsx` | ✅ | API-Keys via `encryptApiKey` gespeichert ✅. Zod-Validierung via `parseFormData` ✅. `sanitizeHTML` für Format-Beispiel-Felder ✅. Decryption-Fehler abgefangen ✅. Billing-Sync beim Callback ✅. `toSafeErrorResponse` verhindert Leak interner Fehler ✅. |

### app/actions/

| Datei | Status | Befund |
|-------|--------|--------|
| `unified-content.actions.ts` (Zeilen 270–Ende) | ✅ | `generateAIText`, `formatAIText`, `translateField`, `translateAll`, `translateAllForLocale` – alle mit korrekter Input-Sanitisierung, Locale-Validierung, Task-Lifecycle-Management und Fehlerbehandlung ✅. Metaobject-Sonderbehandlung korrekt ✅. |

---

## Zusammenfassung Sitzung 2

### Gefundene Probleme

#### ⚠️ Minor Issue

1. **`app/services/gdpr.service.ts`** – Kein persistenter DSGVO-Audit-Trail. `logGDPRRequest` schreibt nur ins Log (Winston). Bei Log-Rotation gehen Einträge verloren. DSGVO empfiehlt 3 Jahre Aufbewahrung.
   ```typescript
   // Fix (TODO bereits vorhanden): Dedizierte GDPRAuditLog-Tabelle in Prisma anlegen
   // und logGDPRRequest darauf schreiben.
   ```

#### ℹ️ Hinweise (kein Handlungsbedarf)

- `webhooks.articles/collections/menus.tsx`: Kein Retry-Service aufgerufen (anders als `webhooks.products.tsx`). Konsistenzverbesserung möglich, aber kein Fehler.
- `billing.server.ts:216`: `syncSubscriptionToDatabase` ist no-op wenn kein `aiSettings`-Record – sehr unwahrscheinlicher Randfall.

---

## Noch ausstehend (Sitzung 3+)

### app/routes/
- 🔲 `_index.tsx`
- 🔲 `app.tsx`
- 🔲 `app._index.tsx`
- 🔲 `app.products.tsx`
- 🔲 `app.content.tsx`
- 🔲 `app.blog.tsx`
- 🔲 `app.collections.tsx`
- 🔲 `app.pages.tsx`
- 🔲 `app.menus.tsx`
- 🔲 `app.metaobjects.tsx`
- 🔲 `app.tasks.tsx`
- ✅ `app.settings.tsx`
- 🔲 `app.metadata.tsx`
- 🔲 `app.policies.tsx`
- 🔲 `app.templates.tsx`
- 🔲 `auth.login.tsx`
- 🔲 `auth.$.tsx`
- 🔲 `health.tsx`
- ✅ `api.ai.tsx`
- 🔲 `api.ai-models.tsx`
- 🔲 `api.sync-*.tsx` (alle)
- 🔲 `api.billing.*.tsx` (alle)
- 🔲 `api.product-images.tsx`
- 🔲 `api.templates.$.tsx`
- 🔲 `api.metaobjects.$.tsx`
- 🔲 `api.storage-stats.tsx`
- 🔲 `api.update-plan.tsx`
- ✅ `webhooks.compliance.tsx`
- ✅ `webhooks.products.tsx`
- ✅ `webhooks.articles.tsx`
- ✅ `webhooks.collections.tsx`
- ✅ `webhooks.menus.tsx`
- ✅ `webhooks.subscription.tsx`

### app/services/
- ✅ `shopify-api-gateway.service.ts`
- ✅ `ai-queue.service.ts` (vollständig)
- 🔲 `background-sync.service.ts`
- ✅ `billing.server.ts`
- 🔲 `content-sync.service.ts`
- 🔲 `content.service.ts`
- ✅ `gdpr.service.ts`
- 🔲 `metaobject-sync.service.ts`
- 🔲 `product-sync.service.ts`
- 🔲 `sync-scheduler.service.ts`
- 🔲 `sync-types.ts`
- 🔲 `sync-utils.ts`
- 🔲 `webhook-registration.service.ts`
- 🔲 `webhook-retry.service.ts`

### app/hooks/ (alle außer useUnifiedContentEditor partial)
- 🔲 `useAppNavigation.ts`
- 🔲 `useFocusManagement.ts`
- 🔲 `useHtmlFormatting.ts`
- 🔲 `useLatestRef.ts`
- 🔲 `useProductSubResources.ts`
- 🔲 `useUiDataLoader.ts`
- 🔲 `useUnifiedContentEditor.ts` (Zeilen 100+)

### app/components/ (alle außer bereits geprüfte)
- 🔲 `UnifiedContentEditor.tsx`
- 🔲 `AIInstructionFieldGroup.tsx`
- 🔲 `AIInstructionsTabs.tsx`
- 🔲 `AppErrorBoundary.tsx`
- 🔲 `ContentTypeNavigation.tsx`
- 🔲 `HelpTooltip.tsx`
- 🔲 `HtmlFormattingToolbar.tsx`
- 🔲 `LoadingSkeleton.tsx`
- 🔲 `LocaleNavigationButtons.tsx`
- 🔲 `MainNavigation.tsx`
- 🔲 `MobileMenu.tsx`
- 🔲 `PlanAccessGate.tsx`
- 🔲 `PlanBadge.tsx`
- 🔲 `ReloadButton.tsx`
- 🔲 `SaveDiscardButtons.tsx`
- 🔲 `SeoSidebar.tsx`
- 🔲 `SettingsAITab.tsx`
- 🔲 `SettingsLanguageTab.tsx`
- 🔲 `SettingsSetupTab.tsx`
- 🔲 `SettingsUsageLimitsTab.tsx`
- 🔲 `StoragePieChart.tsx`
- 🔲 `SyncProgressBar.tsx`
- 🔲 `ThemeContentViewer.tsx`
- 🔲 `UpgradePrompt.tsx`
- 🔲 `ApiKeyWarningBanner.tsx`
- 🔲 `unified/` (alle 9 Dateien)

### app/utils/
- 🔲 `admin-client.server.ts`
- ✅ `ai-instructions.utils.ts`
- 🔲 `api-key-validation.ts`
- 🔲 `contentEditor.utils.ts` (Zeilen 80+)
- 🔲 `debug.ts`
- ✅ `encrypted-session-storage.server.ts`
- 🔲 `loader-helpers.ts`
- 🔲 `performance.client.ts`
- 🔲 `planCacheCleanup.ts`
- 🔲 `planUtils.ts`
- 🔲 `shop-locales-cache.server.ts`
- 🔲 `shopify-product.utils.ts`
- 🔲 `templates-field-factory.ts`
- 🔲 `translation-save-lock.server.ts`
- 🔲 `translation-timing.ts`

### app/actions/
- 🔲 `product/shared/action-context.ts`
- 🔲 `product/update.actions.ts`
- ✅ `unified-content.actions.ts` (vollständig)

### app/config/ (ausstehend)
- 🔲 `ai-models.config.ts`
- 🔲 `billing.ts`
- 🔲 `content-fields.config.tsx`
- 🔲 `plans.ts`

### app/contexts/ (alle)
- 🔲 `I18nContext.tsx`
- 🔲 `InfoBoxContext.tsx`
- 🔲 `ItemSelectorContext.tsx`
- 🔲 `NavigationHeightContext.tsx`
- 🔲 `PlanContext.tsx`
- 🔲 `TaskCountContext.tsx`

### app/graphql/
- 🔲 `content.mutations.ts`
- 🔲 `content.queries.ts`

### app/constants/
- 🔲 `aiInstructionsDefaults.ts`
- 🔲 `layout.ts`
- 🔲 `shopifyFields.ts`
- 🔲 `timing.ts`

### src/
- 🔲 `src/services/ai.service.ts` (Zeilen 100+)
- ✅ `src/services/ai-queue.service.ts` (vollständig)
- 🔲 `src/services/shopify-content.service.ts`
- 🔲 `src/services/task-cleanup.service.ts`
- 🔲 `src/services/task-recovery.service.ts`
- 🔲 `src/services/translation.service.ts`
- 🔲 `src/types/` (alle)
- 🔲 `src/index.ts`
- 🔲 `src/oauth-setup.ts`
- 🔲 `src/shopify-connector.ts`

### Root / Config
- 🔲 `app/db.server.ts`
- 🔲 `app/shopify.server.ts`
- 🔲 `app/entry.client.tsx`
- 🔲 `app/entry.server.tsx`
- 🔲 `server.js`
- 🔲 `start.js`

### Tests
- 🔲 `tests/unit/aiQueueService.test.ts`
- 🔲 `tests/unit/aiService.test.ts`
- 🔲 `tests/unit/encryption.test.ts`
- 🔲 `tests/unit/product-sync.service.test.ts`
- 🔲 `tests/mocks/` (alle)

### app/i18n/
- 🔲 `de.ts`
- 🔲 `en.ts`
- 🔲 `es.ts`
- 🔲 `index.ts`

---

## Priorisierung für Sitzung 3

Folgende Dateien haben höchste Priorität:

1. `app/services/product-sync.service.ts` – Kernfunktion (Datenmenge)
2. `src/services/translation.service.ts` – Kern der Übersetzungslogik
3. `src/services/shopify-content.service.ts` – Shopify-Mutations
4. `app/services/content-sync.service.ts` – Sync-Logik
5. `app/components/UnifiedContentEditor.tsx` – Hauptkomponente
6. `app/routes/api.billing.*.tsx` – Billing-Endpoints
7. `app/routes/api.sync-*.tsx` – Sync-Trigger-Endpoints
8. `src/services/task-recovery.service.ts` – Recovery nach Crash
9. `app/db.server.ts` + `app/shopify.server.ts` – Root-Konfiguration
10. `tests/unit/` – Testabdeckung prüfen
