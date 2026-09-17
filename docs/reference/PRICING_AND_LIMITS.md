# Pricing & Limits — Entscheidungsprotokoll

> Verschoben aus `docs/ROADMAP.md` (2026-09-12), inhaltlich unverändert.
> Die Roadmap selbst ist seither [app/config/roadmap.server.ts](../../app/config/roadmap.server.ts);
> dieses Dokument haelt die BEGRUENDUNGEN hinter den Plan-Limits und der
> Preisstrategie fest, auf die `app/config/plans.ts`, `app/utils/planUtils.ts`
> und `app/utils/imageOperations.server.ts` verweisen.

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

---

## Nachtrag 2026-09-17 — „AI kostet uns nichts" gilt nur noch fuer BYO

Jeder Befund oben argumentiert aus einer Praemisse: *AI-Tokens sind BYO, also
hat dieser App keine variablen AI-Kosten*. Diese Praemisse bleibt fuer den
BYO-Modus wahr und wird fuer den geplanten **Managed-Key-Modus** falsch —
siehe [docs/plans/PLAN_MANAGED_AI_KEY.md](../plans/PLAN_MANAGED_AI_KEY.md) und
die Roadmap-Eintraege `managed-ai-key`, `ai-usage-metering`,
`managed-ai-pricing`.

Was davon beruehrt wird, und was nicht:

- **Befund 2 (Locales unbegrenzt)** — die Begruendung („Zusatzsprachen kosten
  uns nichts") gilt weiter fuer BYO. Im Managed-Modus kosten sie etwas, aber
  die Grenze ist dort das **Monatsbudget**, nicht eine Sprachzahl. Das USP
  bleibt damit unveraendert formulierbar; `maxLocales: Infinity` bleibt.
- **Preisstrategie-Entscheid 2026-05 („Preise nicht breit senken, Marge in
  Leistung investieren")** — unveraendert. Der Managed-Modus senkt keinen
  Preis, er ist ein **Aufpreis** auf denselben Tarif.
- **Neu und nicht durch dieses Dokument gedeckt:** eine zweite Achse neben dem
  Plan (Key-Quelle), ein Provider-Kosten-Budget pro Tarif, und ein
  Margen-Guard als Test. Diese Zahlen stehen im Plan, nicht hier, weil sie erst
  nach der Messung (`ai-usage-metering`) endgueltig sind.
- **Der Kostentreiber-Satz oben** („realer Kostentreiber ist DB-Storage &
  Sync/Compute, nicht AI") ist ab dem Managed-Modus nur noch die halbe
  Wahrheit: fuer Managed-Shops ist AI ein direkter, pro Shop messbarer
  Rechnungsposten — der erste in dieser App, der mit der Nutzung mitwaechst und
  nicht mit dem Katalog.

Der Free-Tarif bekommt bewusst **kein monatliches** Managed-Budget, sondern
eine einmalige Probe von rund 350 Aktionen (ein voller Durchlauf ueber das, was
Free ueberhaupt freischaltet). Ein monatliches Freikontingent von 2 EUR waere
mehr AI-Volumen gewesen als der bezahlte Basic-Tarif bekommt, und es skaliert
mit Installationen statt mit Kunden — Begruendung mit Zahlen in §10 des Plans.
