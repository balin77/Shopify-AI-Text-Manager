# SEO-Section „Ladezeit & Qualität"

**Was das ist:** der destillierte, dauerhaft gültige Kern der PageSpeed-Section ([app.seo.performance.tsx](../../app/routes/app.seo.performance.tsx), [pagespeed.service.ts](../../app/services/seo/pagespeed.service.ts)). Der Umsetzungs-Plan (`docs/plans/PLAN_ACCESSIBILITY.md`, Phasen 1–6) wurde 2026-07 vollständig ausgeliefert und danach gelöscht — hier steht nur, was ein späterer Entwickler wissen muss. Für die allgemeine Section-Mechanik gilt der [SEO_SECTION_CONTRACT.md](SEO_SECTION_CONTRACT.md).

---

## Ein PSI-Aufruf, drei Kategorien, Tabs

Ein PageSpeed-Insights-Aufruf liefert **alle** Lighthouse-Kategorien in **einer** Antwort — derselbe Testlauf, Cache-Eintrag und History-Zeile. Deshalb gibt es **keine** eigene „Qualität"-Section: Ladezeit, Barrierefreiheit und Best Practices sind Tabs innerhalb der bestehenden Performance-Section, mit einem Score-Strip (kleine Ring-Scores) darüber.

- **Section-Id bleibt `performance`** ([seo-sections.ts](../../app/config/seo-sections.ts)), Pfad `/app/seo/performance`, Icon 🚀 — nur der **angezeigte Name** ist „Ladezeit & Qualität" / „Speed & quality" / „Velocidad y calidad". Id/Pfad umbenennen bricht Deep-Links und Tests.
- **Angefordert werden nur `performance`, `accessibility`, `best-practices`** ([pagespeed.service.ts](../../app/services/seo/pagespeed.service.ts), `fetchPageSpeedInsights`). Bewusst **nicht**:
  - **`seo`** — ContentPilot prüft dasselbe über den ganzen Katalog und tiefer ([seo-score.ts](../../app/utils/seo-score.ts), bulk-meta, hreflang). Zwei SEO-Zahlen mit verschiedenen Bändern nebeneinander würden den eigenen, besseren Score relativieren.
  - **`agentic-browsing`** — über den `category`-Parameter der PSI-API v5 nicht anforderbar, und **empirisch geprüft (2026-07-24, LH 13.4.0): kommt auch nicht ungefragt** in `lighthouseResult.categories` mit.
- **Kontingent zählt Requests, nicht Kategorien.** Drei Kategorien kosten exakt so viel wie eine. Tagesbudget über `PlanLimits.dailyPageSpeedRuns` (Verbrauch, kein Plan-Gate — dieselbe Logik wie `monthlyImageOperations`); die Prüfung sitzt **nach** dem Cache-Lookup, ein gecachtes Ergebnis kostet nichts.

## Best Practices fließt in keine Aggregation

Best Practices kommt gratis mit, geht aber in **keine** Gesamtbewertung ein (die Kategorie prüft überwiegend Dinge außerhalb von Merchant/App-Einfluss: HTTPS/HSTS bei Shopify, CSP/Konsolenfehler beim Theme oder Fremd-Apps). Eigener Tab als „Zusatzinformationen", **keine** History-Score-Spalte, kein Score-Beitrag. Die Zahl steht gleichberechtigt im Score-Strip — „kein Score-Beitrag" heißt „keine Aggregation", nicht „versteckt".

## Barrierefreiheit: Ehrlichkeits-Hinweis ist Pflicht

Lighthouse' Accessibility-Score basiert auf axe-core und erkennt nur einen Teil der realen Barrieren. Der nicht-ausblendbare Hinweis im Tab (`t.seo.performancePage.a11y.disclaimer`) sagt ausdrücklich, dass ein hoher Score **keine** Barrierefreiheit und **keine Rechtssicherheit** (European Accessibility Act) bedeutet. Das ist Haftungsvermeidung, kein Nice-to-have — nicht entfernen.

## Alt-Texte: die zentrale Nicht-Offensichtlichkeit

**Lighthouse `image-alt` feuert auf Shopify-Storefronts praktisch nie.** Shopify-Themes geben immer ein `alt`-Attribut aus; ohne gepflegten Alt-Text wird daraus `alt=""`, und **axe-core wertet leeres `alt=""` als „dekoratives Bild" → bestanden**. „Kein Alt-Text im Admin" ≠ „fehlendes `alt`-Attribut im HTML". Empirisch bestätigt (2026-07-24): Produkt ohne Alt-Texte → `image-alt` score=1, 0 items.

**Deshalb kommt die Alt-Text-Warnung aus ContentPilots eigenen Daten, nicht aus Lighthouse** (Loader `computeAltTextAudit` in [app.seo.performance.tsx](../../app/routes/app.seo.performance.tsx), Anzeige im Barrierefreiheit-Tab, katalogweit):
- **Hauptsprache:** `ProductImage` mit leerem/fehlendem `altText`.
- **Foreign Locales:** je aktiver publizierter Fremdsprache Bilder mit vorhandenem Haupt-Alt-Text, aber ohne `ProductImageAltTranslation` (marketId `""`). Bilder ohne Haupt-Alt-Text sind ausgenommen (schon im Haupt-Warnpunkt erfasst).

Der alte Lighthouse-gekoppelte Brückenschlag (der „Alt-Text generieren"-Button in `image-alt`-Befunden, matcht CDN-URL → `ProductImage`) bleibt als **harmloser Fallback** bestehen — greift nur im seltenen Fall, dass doch ein `image-alt`-Befund auftaucht.

## Element-Screenshots bei Qualitäts-Befunden

Barrierefreiheits-/Best-Practices-Befunde tragen Element-Rects aus der Full-Page-Screenshot-Node-Map (dieselbe `nodesMap`, die die Performance-Befunde nutzen): `extractQuality` → `extractTable`/`extractQualityIssueItems` reichen sie durch, die UI rendert dieselben Thumbnail-Crops (z. B. die betroffenen Elemente von `color-contrast`).

## Datenmodell & Timeout

- **Kein neues Prisma-Modell.** `SeoPageSpeedAudit` bekam zwei nullable Spalten `a11yScore` + `bestPracticesScore` (denormalisiert für die History-Liste, wie `score`); die Befunde selbst liegen im bestehenden `result`-JSON (`quality?: QualityResult`, optional → alte Läufe bleiben typkonform und lösen den „vor der Qualitätsprüfung gespeichert"-Leerzustand aus). Migration additiv/nullable, kein Backfill. GDPR unverändert (`redactShopData` löscht die Tabelle bereits).
- **`PSI_TIMEOUT_MS = 90_000`** (nicht 60 s). Grund: mit drei Kategorien wurde eine schwere Startseite mit ~42 s mobil gemessen (Produkt/Collection ~22–23 s); PSI-Laufzeiten schwanken mit Googles Serverlast, 60 s hätten eine gesunde Startseite fälschlich abgebrochen. Dauertexte (`runningHint`, `helpBody2`) nennen „20–45 Sekunden, bei umfangreichen Startseiten auch länger".

## Dev-only Mess-Werkzeuge (`PROBE`-markiert, entfernbar)

Zwei temporäre Hilfen aus der Umsetzung, über `grep -rn "PROBE (accessibility" app/` auffindbar:
- **Scandauer-Anzeige** neben dem „Getestet"-Zeitstempel (Ladezeit-Tab) — reine PSI-Round-Trip-Zeit, `scanDurationMs` im `result`-JSON.
- **PageSpeed-Raw-Probe** — dev-only Settings-Tab (`SettingsPageSpeedProbeTab`, gegated wie „Translation Probe": `APP_ENV === "development"`), lädt die komplette rohe PSI-Antwort als Datei; postet an den `debugRawPsi`-Intent von `/app/seo/performance` **via `useFetcher`** (roher `fetch` auf eine UI-Route gäbe das HTML-Dokument zurück, nicht JSON).

Beide haben ihren Messzweck erfüllt und können jederzeit ersatzlos entfernt werden.
