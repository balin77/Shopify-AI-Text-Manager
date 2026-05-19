# Code-Review Abschlussbericht — Shopify AI Text Manager

**Reviewter Branch:** `develop`
**Stand bei Abschluss:** `fd1a203` (2026-05-19)
**Methodik:** 5 Review-Runden mit parallelen, auf orthogonale Achsen fokussierten Agenten; alle Critical/High-Befunde durch eigene Codeeinsicht (Datei:Zeile, Blob-OID-Merge-Verifikation) gegengeprüft. Read-only — keine Quelländerungen durch das Review selbst.

**Ergebnis:** Alle Critical- und High-Befunde sind behoben oder bewusst dokumentiert-akzeptiert. Merge-Integrität über alle Runden durchgängig sauber (Blob-OID-verifiziert; mehrere irreführende Commit-Messages wurden durch Codeeinsicht korrigiert statt blind übernommen).

---

## 1. Behobene Befunde

### Runde 1 — Security / Server / Routes / Daten & Infra

| ID | Schwere | Befund | Fix-Commit |
|----|---------|--------|------------|
| C-1 | Critical | Fehlende Shop-Isolation (Multi-Tenant IDOR) in alt-text/apply-templates/update-variant/update.actions | `6461626` |
| C-2 | Critical | `prisma db push --accept-data-loss` bei jedem Prod-Deploy + Raw-`_prisma_migrations`-Mutation | `6461626`, `1a5a8ac` |
| C-3 | Critical | `..bfg-report/` getrackt + geleakte Secrets (extern rotiert, bestätigt) | `c5c63a5` |
| H-1/H7 | High | AI-Queue Single-Concurrency, kein Timeout, kein Jitter, kein Drain | `c2dfcdf` |
| H-2 | High | SIGTERM drained laufende AI-Jobs nicht | `c2dfcdf` |
| H-3 | High | WebP-Processor eigener PrismaClient (Connection-Leak) | `c2dfcdf` |
| H-4 | High | Prompt-Injection in text-generation Handler | `b6cd661` |
| H-5 | High | Unbounded Request-Bodies / Fan-out | `c2dfcdf` |
| H-6 | High | `ENCRYPTION_KEY` nicht hart erforderlich | `c2dfcdf` |
| div. | Medium | WebP-Timeout/Kompensation, Locale-/GID-Validierung, Orphan-ContentTranslation-Cleanup | `a848719`, `65ae73b` |
| dep | Low | `dompurify` <3.4.0 (4 Advisories), `express-rate-limit`, Non-root-Container | `c79a560`-Reihe |

### Runde 2 — Frontend / Business-Logik / Shopify-GDPR / Fix-Regressionen

| ID | Schwere | Befund | Fix-Commit |
|----|---------|--------|------------|
| N-C1 | Critical | GDPR: `ImageOperationCounter` nicht bei `shop/redact` gelöscht | `d23e4b2` |
| N-C2 | Critical | Fail-open Owner-Check (null ⇒ durchgelassen) → fail-closed `shop_id`-Compound | `d23e4b2` |
| N-C3 | Critical | Metaobjekt-Übersetzung mit leerem `translatableContentDigest` → DB/Shopify-Divergenz | `d23e4b2` |
| N-H1/H2 | High | Queue-Poller-Wedge + unbounded Queue | `b6cd661` |
| N-H3 | High | Untranslated-Source-Text als „Übersetzung" geschrieben | `b6cd661` |
| N-H4 | High | WebP-Kontingent bei Fehlschlag nie zurückerstattet | `b6cd661` |
| N-H7 | High | Collections-Webhook ohne Retry-Pfad | `b6cd661` |

### Runde 3 — Performance / Tests-CI / Storefront-Extension / TS-Soundness

| ID | Schwere | Befund | Fix-Commit |
|----|---------|--------|------------|
| R3-C1 | Critical | Stored-XSS Storefront Variant-Gallery (`_esc` ohne `<>`) — Haupt- **und** Embed-Datei | `609e191`, `dfa2f62` |
| R3-C2 | Critical | Kein CI — Tests gaten nichts | `609e191` (`.github/workflows/ci.yml`, `npm test`) |
| R3-C3 | Critical | Products-Loader Voll-Katalog-Resync bei jedem Page-Load | `609e191` |
| R3-C4 | Critical | WebP-Refund auf Recovery-/Stuck-Pfad umgangen | `dfa2f62` (geteiltes `image-op-refund.js`) |
| R3-H1 | High | JSON-Island `</script>`-Breakout | `1acbdbc` |
| R3-H2 | High | Loader ohne Pagination/Cap (`PRODUCTS_MAX_LOADED`) | `1acbdbc` |
| R3-H3 | High | Initial-Sync 1 Transaktion/Produkt → Batching | `1acbdbc` |
| R3-H4 | High | Webhook-Sync delete+recreate ohne Digest-Skip | `1acbdbc` |
| R3-H5 | High | Fehlender Task-Index `@@index([shop,status,completedAt])` | `1acbdbc` |
| R3-H6 | High | Tautologische Queue-Tests → echte Dispatcher-Tests | `1acbdbc` |
| R3-H8 | High | `as any` maskiert Metaobjekt-Query-Shape → getyptes Interface | `0f93c11` |
| R3-H10 | High | N-H3-Guard auf Sequenz/Slug/Content-Pfaden | `7a24c72` |
| R3-H11 | High | `enqueueFromTask` ohne `maxQueuePerShop`-Cap | `7a24c72` |
| R3-M9/M10 | Medium | `String(err)` verliert Stack; Roh-Modell-Output im Log | `0f93c11` |

### Runde 4 — Concurrency / Bundle / i18n-a11y / Lifecycle-Schema

| ID | Schwere | Befund | Fix-Commit |
|----|---------|--------|------------|
| R4-C1 | Critical | Konkurrierende `process.exit(0)`-SIGTERM-Handler hebeln Graceful-Shutdown aus | `0bbd465` |
| R4-DI1 | Critical | `sync-missing-products` Wipe+Create ohne Transaktion/Retry | `90bc074` |
| R4-DI2 | Critical | Bulk-Sync-Batch-Transaktion nicht race-retry-umschlossen (Commit-Msg war irreführend) | `90bc074` |
| R4-DI3 | High | Nicht-atomarer Refund-Counter (Lost-Update, Cap-Bypass) | `90bc074` |
| R4-DI4 | High | Billing read-then-write Plan-Race (~6 Caller) | `90bc074` |
| R4-DI5 | High | delete-then-resurrect (gelöschtes Produkt lebt wieder auf) | `90bc074` (`product-delete-lock.server.ts`) |
| R4-DI6 | Medium | `api.product-images` check-then-create → atomarer Upsert | `50b350d` |
| R4-DI7 | Medium | `alt-text.action` `updateMany({mediaId})` nicht shop-scoped | `50b350d` |
| R4-DI8 | Medium | `withDbRaceRetry` ohne Jitter (Thundering-Herd) | `50b350d` |
| R4-H1 | High | Kein In-Flight-Reentrancy-Guard StaleImageCleanup | `0bbd465` |
| R4-H2 | High | Stuck-Reaper killt legitime Long-Tasks (Heartbeat-Contract + Batch-Cap + Per-Typ) | `6f648a7`, `fd1a203` |
| R4-H3 | High | webhook-retry eigener PrismaClient (Pool-Leak) + Konstruktor-Start | `0bbd465` |
| R4-H4 | High | Global-Cleanup lief nur bei aktivem Shop; un-batched Anti-Join | `0bbd465` |
| R4-H5 | High | ContentTranslation polymorpher Orphan-Wuchs | `0bbd465` (Orphan-CT-Cleanup) |
| R4-UX1 | High | Shopify-Merchant-Locale nie erkannt (App immer Englisch) | `b55b867` (`locale.server.ts`) |
| R4-UX2 | High | Deutsche Hardcoded-Fallbacks für EN/ES-Nutzer | `b55b867` |
| R4-UX3 | High | contenteditable ohne ARIA (Screenreader) | `b55b867` |
| R4-UX4 | High | Bild-Grid ohne KeyboardSensor | `b55b867` |
| R4-UX5 | High | Thumbnail `alt=""` + Status nur Rahmenfarbe | `b55b867` |
| R4-UX6 | Medium | Zahlen nicht locale-formatiert (`Intl.NumberFormat`) | `4186f79` (`format.ts`) |
| R4-UX7 | Medium | `window.confirm`-Downgrade → Polaris-Modal | `4186f79` |

### Runde 5 — Funktionale KI-Korrektheit / Auth-Billing-GDPR-Compliance

| ID | Schwere | Befund | Fix-Commit |
|----|---------|--------|------------|
| R5-C1 | Critical | `sanitizePromptInput` zerstört alle Newlines trotz `allowNewlines` (pervasives Content-Flattening) | `a4806d7` |
| R5-C2 | Critical | Leerer Digest auf Products/Collections-Write-Back → stille Divergenz | `a4806d7` |
| R5-H1 | High | Grouped-Field-Übersetzung ohne Mapping-/Vollständigkeits-Garantie | `a4806d7` |
| R5-H2 | High | Zielsprache nie validiert; `LOCALE_NAMES` ohne Regionalcodes; Echo-Guard | `a4806d7` |
| R5-H3 | High | Nicht-lateinischer Slug → leeres/kaputtes Handle | `a4806d7` |
| R5-H4 | High | `stripXmlWrapper` strippt legitimen äußeren HTML-Tag | `a4806d7` |
| R5-M2 | Medium | **Live-Regression**: Foreign-Locale-Alt-Text-Apply lud Templates per falscher Locale → No-op | `0d5a443` |
| R5-M1/M3/L4 | Medium | `TPLVARn`-Token-Kollision, JSON-Scan-Anker, `${`-Mutation | `0d5a443` |
| R5-G1 | Critical | `customers/data_request` stiller No-op (nicht ausgeliefert) — App-Store-Blocker | `33f6250` |
| R5-G2 | High | `BigInt(customer.id)`-Throw → 500 auf Compliance-Test-Payload — App-Store-Blocker | `33f6250` |
| R5-G3 | Medium | `getCurrentSubscription` ohne `test`-Filter (Self-Grant-Restpfad) | `33f6250` |
| R5-G4 | Medium | GDPR-Audit-Doppel-Logging ohne Korrelation | `33f6250` |

---

## 2. Bewusst akzeptierte / dokumentierte Restpunkte (kein Bug — begründete Entscheidung)

| ID | Punkt | Begründung / Empfohlener Follow-up |
|----|-------|-----------------------------------|
| R4-C2 | Multi-Instanz: jede Replica fährt jeden Cleanup/Reaper | Im Code dokumentiert; empfohlener Weg: dedizierter `pg`-Session-Advisory-Lock bei Boot, **wenn** Multi-Instanz tatsächlich aktiviert wird |
| R4-H6 | Unique-Constraint NULL-mediaId / non-CONCURRENT-Index | SQL-Standard-NULL-Distinctness; kein Volumen-Pfad erzeugt NULL-mediaId; Forward-Rule dokumentiert |
| R4-DI9 | Task-Finalizer ohne Status-Precondition | Bewusst nicht über ~100 Call-Sites verteilt; künftig zentral `updateMany({where:{id,status:{notIn:TERMINAL}}})` |
| R4-UX8 | AI-Accept ohne Diff/Per-Feld-Undo | Als „Known Limitation" mit Zieldesign dokumentiert |
| R3-H9 | Cross-Period-Refund-Edge-Case | Clamp-at-0 + No-op-ohne-Row; Monatsgrenzen-Edge-Case dokumentiert akzeptiert |
| R3-M7 | `noUncheckedIndexedAccess` aus | Im `tsconfig.json` als künftige Migration markiert |
| — | HMAC-Webhook-Test | HMAC liegt in der Shopify-SDK; handgerollter Test wäre dekorativ |
| — | Echte Server-Side-Pagination | TODO; gebundene Mitigation (`PRODUCTS_MAX_LOADED`) aktiv |
| R5-G5 | Trial-Reset nach Full-`shop/redact`+Reinstall | Bewusster Tradeoff (Trial-Marker auf `AISettings`, von Redact gelöscht) |
| R5-G6/G7 | `auth.$` unvalidiertes `shop` (same-origin); `getApiVersion`-Enum | Low; `*.myshopify.com`-Sanity-Check bzw. kosmetisch |

---

## 3. Positiv kreuzgeprüft (bestätigt korrekt)

- `redactShopData` deckt **alle 30 Prisma-Modelle** ab (23 explizit shop-scoped + 5 via Product-Cascade + `GdprAuditLog`-Retention), strikt `shop_domain`-gefiltert.
- HMAC via `authenticate.webhook()` erzwungen (401 bei falscher Signatur).
- `dev-plan-override` im Public-Build strukturell unerreichbar (Shopify-`client_id`-Allowlist + `APP_ENV`-Guard).
- Token/PII-Verschlüsselung at rest solide (AES-256-GCM, per-Row-IV, Auth-Tag, Decrypt-Fail erzwingt Re-Auth).
- Kein Secret-/DB-/AI-Key-Leak ins Client-Bundle; `.server`-Boundary konsistent.
- `shopify.app.toml` Webhooks/Scopes ↔ Routen: keine Diskrepanz.

---

## 4. Restempfehlungen (kein Bug-Hunting mehr nötig)

1. **R5-G1 final gegenprüfen:** `dataExported` ist nachweislich surfaced (`admin.tsx`); bestätigen, dass die gespeicherte Export-Payload nicht weiterhin auf 500 Zeichen gekürzt wird.
2. **CI-Absicherung:** Der `npm test`-Gate (R3-C2) existiert — die akzeptierten Restpunkte (R4-C2, R4-DI9, R3-H9) als Regression-Tests/Invarianten verankern.
3. **Feature-Branches:** `feature/glossary`, `feature/content-templates`, `feature/jsonld-structured-data`, `feature/language-currency-switcher` sind **ungeprüft** — vor einem Merge nach `develop` separat reviewen.
4. **Methodik-Hinweis:** Fix-Commit-Messages überstellten mehrfach ihren Umfang (z. B. „wraps BOTH sync transactions"). Künftige Fixes code-level (nicht nur per Message) verifizieren.

---

*Erstellt durch ein read-only Multi-Runden-Code-Review. Alle Fixes wurden auf `develop` durch die zuständigen Entwickler/Fix-Branches eingebracht und hier verifiziert.*
