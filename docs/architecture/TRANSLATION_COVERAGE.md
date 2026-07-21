# Translation-Coverage-Contract

**Was das ist:** der aktive Architektur-Vertrag für die von ContentPilot abgedeckte Shopify-Übersetzungsoberfläche. Beschreibt die 31 `TranslatableResourceType`-Werte, wo die Inhalte tatsächlich leben (nicht wo man es vermuten würde), welche Rubric sie im UI bedienen, und welche Fallstricke die `translationsRegister`-Mechanik hat. Gilt für alle Content-Familien, nicht nur Theme.

**Warum das existiert:** Mehrere frühere Annahmen waren falsch (chiefly: "checkout strings live in SHOP"). Der Abgleich gegen Translate & Adapt hat gezeigt, dass die T&A-UI eine andere Gruppierung nutzt als die API — die 5 T&A-Rubriken sind eine Neu-Sortierung der 31 Enum-Werte, nicht eine eigene API-Ebene. Wer diese Zuordnung nicht kennt, baut Coverage-Löcher oder Doppel-Sync.

**Historie:** ursprünglich in `docs/plans/PLAN_TRANSLATION_COVERAGE.md` (Phase 0 Spike + Phase 1–5 Umsetzung) formuliert, 2026-07 im Wesentlichen ausgeliefert und dieser Plan entfernt. Was hier steht ist der destillierte Kern; die Umsetzungshistorie ist in Git.

---

## Die 31 Resource Types

Die `TranslatableResourceType`-Enum in `2025-10` stable exponiert **30** Werte. `COOKIE_BANNER` ist in `unstable` dokumentiert (funktioniert dort, noch nicht promoted) → effektiv **31**.

Autoritative Referenz: [TranslatableResourceType (2025-10)](https://shopify.dev/docs/api/admin-graphql/latest/enums/TranslatableResourceType) und [(unstable)](https://shopify.dev/docs/api/admin-graphql/unstable/enums/TranslatableResourceType).

`SMS_TEMPLATE` ist **nicht** Teil des Enums — Shopify-SMS-Notifications nutzen keine translatable Templates. Frühere interne Docs haben das falsch gelistet.

## Wo die Inhalte wirklich liegen

Nicht-triviale Zuordnungen — die Einträge, die man ohne Spike-Ergebnisse falsch verortet:

| Inhalt | Liegt in | Falsche Vermutung war |
|---|---|---|
| Checkout-Strings (page_title, error page, thank-you, payment labels, SMS opt-in, …) | `ONLINE_STORE_THEME_LOCALE_CONTENT` unter `shopify.checkout.*` (~2590 shopify.*-Keys, davon mehrere hundert `shopify.checkout.*`) | `SHOP` |
| Shop-SEO (`meta_title`, `meta_description`) | `SHOP` — nur diese zwei Keys | „SHOP enthält die Checkout-Overrides" |
| Meta-Title/Description auf Pages/Blogs/Articles | `global.title_tag` / `description_tag` **Metafields**, NICHT das native `seo`-Feld. Leeren erfordert `metafieldsDelete` (Empty-String löscht nicht) | Ist native `seo`-Feld |
| Cookie-Banner (25 Keys) | `COOKIE_BANNER` via **unstable** Endpoint, mit Auto-Fallback auf „Coming Soon" bei Schema-Bruch | Über die pinned 2025-10 erreichbar (führt zu „invalid id") |
| Theme-Standardinhalte (T&A-Rubrik) | `ONLINE_STORE_THEME_LOCALE_CONTENT`, im UI gruppiert nach Top-Level-Prefix (accessibility, checkout, general, gift_cards, …) — NICHT eine eigene API-Surface | Eigene API-Ressource |
| `ONLINE_STORE_THEME` | ~99% Duplikat von `LOCALE_CONTENT` — im Sync gedroppt | Eigenständige Ressource |

## Rubric → Resource Type Mapping

Die Info-Architektur (5 Rubriken unter „Inhalte") ist die T&A-Struktur, gefaltet unter unseren Parent. Config lebt in [`app/config/content-rubrics.ts`](../../app/config/content-rubrics.ts); die Level-2-Navigation ([`RubricNavigation.tsx`](../../app/components/RubricNavigation.tsx)) rendert daraus.

| Rubric | Resource Types |
|---|---|
| **Katalog** | `PRODUCT`, `PRODUCT_OPTION`, `PRODUCT_OPTION_VALUE`, `MEDIA_IMAGE`, `COLLECTION`, `COLLECTION_IMAGE`, (`SELLING_PLAN*` cond.) |
| **Online Store** | `PAGE`, `ARTICLE`, `ARTICLE_IMAGE`, `BLOG`, `MENU`, `LINK`, `SHOP_POLICY`, `METAOBJECT`, `METAFIELD`, `FILTER`, `SHOP`, `COOKIE_BANNER` |
| **Theme** | `ONLINE_STORE_THEME_JSON_TEMPLATE`, `_LOCALE_CONTENT`, `_SECTION_GROUP`, `_SETTINGS_CATEGORY`, `_SETTINGS_DATA_SECTIONS`, `_APP_EMBED` |
| **System** | `EMAIL_TEMPLATE` (~50 Templates × 2 Keys), `DELIVERY_METHOD_DEFINITION`, (`PAYMENT_GATEWAY` cond.), (`PACKING_SLIP_TEMPLATE` cond.) |
| **Direkte Übersetzungen** | keine Shopify-API-Ressource — Storefront-Strings, die von Third-Party-Apps gerendert werden und in keinem `translatableResource` liegen |

`(cond.)` = Rubric-Eintrag versteckt, wenn keine Ressource dieses Typs im Shop existiert.

T&A **exponiert nicht**: `PACKING_SLIP_TEMPLATE`, `PAYMENT_GATEWAY`, `SELLING_PLAN*`, `SELLING_PLAN_GROUP` — hier haben wir Coverage-Vorsprung.

Shopify-API-**limitiert**: `MENU` / `LINK` können nur teilweise übersetzt werden. Hint in der UI.

## `translationsRegister`-Mechanik

Nicht-offensichtliche Regeln, die man beim Bauen neuer Save-Pfade wissen muss:

- **Per-Key `translatableContentDigest` ist pflicht.** An den aktuellen Source-Value gebunden — bei Primary-Change wird der Digest ungültig, alle bisherigen Foreign-Übersetzungen dieses Keys müssen re-registriert werden. Der Templates-Flow handhabt das bereits.
- **Erfolg = Shopify muss die Keys im `translations`-Array zurückgeben.** `userErrors.length === 0` allein reicht nicht — Shopify akzeptiert Calls silently und speichert nichts. Historic Bug-Pattern in mehreren Save-Pfaden ([templates-update.action.ts STEP 1](../../app/actions/templates/templates-update.action.ts)). Ohne Echo → kein DB-Write, `success: false`.
- **`translationsRemove` verhält sich identisch.** Silent no-op möglich. Wenn Shopify die Removal nicht bestätigt: DB-Row NICHT löschen, sonst State-Divergenz.
- **Market-aware.** `TranslationInput.marketId` optional; omitted → global für die Locale; gesetzt → nur für diesen Market.
- **Resource-ID-Format hängt vom Typ ab.** Shop-GID (`gid://shopify/Shop/…`) für `SHOP`. Theme-GID (`gid://shopify/OnlineStoreTheme/…`) für alle `ONLINE_STORE_THEME_*` — an das aktive Theme gebunden, muss bei Theme-Wechsel re-registriert werden.
- **Eigenes Rate-Limit** ([Community-Thread](https://community.shopify.dev/t/translatable-resource-rate-limit/15107)) — separat vom restlichen Admin-API-Bucket. Batch + Back-off.
- **CookieBanner nutzt einen anderen Endpoint.** Der pinned stable `translationsRegister` liefert „invalid id" für CookieBanner-GIDs → Route über den `unstable`-Endpoint (`writeCookieBannerTranslations` in [text-translation.handler.ts](../../app/routes/api-ai-handlers/text-translation.handler.ts) via `registerTemplateFieldTranslation`).

## Built-in-33-Sprachpaket

Shopify liefert professionelle Default-Übersetzungen für 33 Sprachen (Bulgarisch, Chinesisch Simplified/Traditional, Kroatisch, Tschechisch, Dänisch, Niederländisch, Englisch, Finnisch, Französisch, Deutsch, Griechisch, Hindi, Ungarisch, Indonesisch, Italienisch, Japanisch, Koreanisch, Litauisch, Malaiisch, Norwegisch Bokmål, Polnisch, Portugiesisch BR/PT, Rumänisch, Russisch, Slowakisch, Slowenisch, Spanisch, Schwedisch, Thai, Türkisch, Vietnamesisch).

Diese sind die *Defaults* für `shopify.*`, `customer_accounts.*` und ähnliche built-in Keys, sobald der Merchant eine dieser Sprachen aktiviert.

**Offene Frage — nicht blockierend, aber merken:** Bei einem Write auf `shopify.checkout.general.page_title` in einer built-in-Sprache (z.B. DE) — wer gewinnt: unsere Override oder Shopifys Built-in? Für die unsupported Sprachen (Arabisch, Hebräisch, Ukrainisch, Filipino, Bengalisch, …) gewinnen wir garantiert (kein Built-in zum Konkurrieren). Precedence bei den 33 supported Sprachen ist per Manual Smoke Test zu verifizieren, bevor Systemtexte in bekannten Sprachen als „übersetzbar" beworben werden.

## Cookie-Banner-Availability-Pattern

Der `COOKIE_BANNER`-Resource-Type steht in `unstable`, nicht in stable. Statt zu warten läuft die Editorfunktion sofort, mit Auto-Fallback bei Schema-Bruch:

- [`app/utils/cookie-banner-availability.server.ts`](../../app/utils/cookie-banner-availability.server.ts) — In-Memory + DB-backed Availability-Cache, 15-Min TTL. `getCookieBannerAvailability(session)` → `"available" | "unavailable"`.
- Cache-Miss: Tiny-Probe (1 Resource, 1 Key) gegen `/admin/api/unstable/graphql.json`. Erfolg → 15 Min „available". Beliebiger Fehler (Invalid Enum, Netzwerk, Auth) → 15 Min „unavailable".
- Loader entscheidet Editor vs. „Coming Soon"-Placeholder. Save-Action macht Pre-Flight Re-Check.
- Recovery ist automatisch bei nächster erfolgreicher Probe.
- **Stable Promotion:** Sobald 2025-10 (oder späteres pinned Release) `COOKIE_BANNER` akzeptiert, kann der Data-Path in einem kleinen Commit vom `unstable`-Raw-Fetch auf den normalen Admin-Client umgestellt werden. Der Availability-Cache funktioniert weiter identisch.

## App-Embed-Ownership statt Selektor-Heuristik

`ONLINE_STORE_THEME_APP_EMBED` enthält bei den meisten Themes hauptsächlich CSS-Selektoren, die nicht übersetzbar sind. Wir sperren die Editor-Inputs für App-Embeds, **die zu unserer eigenen App gehören** — nicht per 80%-CSS-Selektor-Heuristik (fehlerträchtig), sondern per authoritativer Owner-Info aus `block.type` beim Full-Sync (`ThemeContent.appEmbedOwned`, gesetzt in [theme-content-domain.server.ts:109](../../app/utils/theme-content-domain.server.ts#L109)). Fremd-App-Embeds bleiben editierbar — Parität mit T&A.

Siehe Memory `app-embed-fields-locked` für die read-only-Detail-Semantik.

## Coverage-Vorsprung gegenüber T&A

- **AI-getriebene Übersetzung mit Brand Voice / Tone** — T&A kann nur generische MT
- **Direkte Übersetzungen** für Storefront-Strings, die von Third-Party-Apps ohne `translatableResource` gerendert werden — echte T&A-Blindstelle
- **Bulk-Operationen** — translate-all-locales, group-level Actions, lazy Field-Pagination
- **3 Resource-Types, die T&A nicht exponiert** — `PACKING_SLIP_TEMPLATE`, `PAYMENT_GATEWAY`, `SELLING_PLAN*` (bedingt auf Vorhandensein)

## Referenzen

- [TranslatableResourceType enum (2025-10)](https://shopify.dev/docs/api/admin-graphql/latest/enums/TranslatableResourceType)
- [TranslatableResourceType enum (unstable)](https://shopify.dev/docs/api/admin-graphql/unstable/enums/TranslatableResourceType)
- [CookieBanner object](https://shopify.dev/docs/api/admin-graphql/latest/objects/CookieBanner)
- [translatableResource query](https://shopify.dev/docs/api/admin-graphql/latest/queries/translatableresource)
- [translationsRegister mutation](https://shopify.dev/docs/api/admin-graphql/latest/mutations/translationsregister)
- [Storefront locale files](https://shopify.dev/themes/architecture/locales/storefront-locale-files)
- [Manage translations of merchant-provided content](https://shopify.dev/docs/apps/build/markets/manage-translated-content)
- [Translatable resource rate limit (Community)](https://community.shopify.dev/t/translatable-resource-rate-limit/15107)
- [Translate & Adapt — Help Center](https://help.shopify.com/en/manual/international/translate-adapt-app)
