# Zusatzsprachen — Plan (mehr Sprachen, als Shopify erlaubt)

**Status:** Entwurf 2026-09-30. Nichts gebaut, nichts gemessen. Offen und bewusst **nicht** entschieden: ob Stufe 1, Stufe 2 oder beide gebaut werden. Arbeitsannahme des Owners: Stufe 1 für **Max**, Stufe 2 für einen allfälligen **Enterprise**-Tarif (`enterprise-tier` in der Roadmap).
**Roadmap:** `extra-languages-browser` (Stufe 1) und `extra-languages-proxy` (Stufe 2) in [roadmap.server.ts](../../app/config/roadmap.server.ts).
**Ziel:** Ein Shop verkauft in mehr Sprachen, als Shopify ihm als Shop-Sprachen erlaubt. Die Sprachen innerhalb des Limits bleiben **nativ**, also mit Shopifys Übersetzungsspeicher, `/fr/`-Unterordnern, Checkout und Mails. **Zusatzsprachen** laufen über ContentPilot und werden entweder im Browser ausgeliefert (Stufe 1) oder über einen Proxy auf einer Subdomain (Stufe 2).

> **Der Plan ist so geschnitten, dass die Stufenfrage spät fallen darf.** Beide Stufen hängen an **derselben** Datenschicht: Segmentierer, Segmentspeicher, Befüllung und Admin-UI (Phasen 1, 3, 4). Stufe 1 und Stufe 2 sind nur zwei **Auslieferungswege** für dieselben Übersetzungen. Wer die Datenschicht baut, hat noch nichts entschieden.

---

## 0. Ist-Zustand (2026-09-30, gegen den Code gelesen)

- **Sprachen kommen ausschliesslich aus Shopify.** `shopLocales` über den 60-s-Cache ([shop-locales-cache.server.ts](../../app/utils/shop-locales-cache.server.ts)). Veröffentlichen und Zurückziehen macht die App selbst ([shop-locale-publish.server.ts](../../app/services/shop-locale-publish.server.ts), Scope `write_locales` vorhanden). Eine Sprache, die Shopify nicht führt, gibt es in der App nicht.
- **Jeder Übersetzungs-Schreibweg endet in `translationsRegister`.** `ContentTranslation` und die übrigen `*Translation`-Tabellen **spiegeln**, was Shopify angenommen hat, sie sind keine eigene Quelle ([apply.server.ts](../../app/services/bulk-editor/apply.server.ts) spiegelt nur bestätigte Schlüssel).
- **Die Storefront-Laufzeit für Stufe 1 existiert schon halb:** die Direktübersetzungen.
  - [direct-translation.js](../../extensions/storefront/assets/direct-translation.js) läuft mit einem `TreeWalker` über Textknoten, ersetzt sie aus einem Wörterbuch, beobachtet nachgeladenen Inhalt per `MutationObserver` und cacht in `localStorage` mit `version` (stale-while-revalidate).
  - Das Wörterbuch kommt über den App Proxy `/apps/contentpilot/dynamic-translations` ([proxy.dynamic-translations.tsx](../../app/routes/proxy.dynamic-translations.tsx)), HMAC-geprüft, nur für Max.
  - Die Laufzeit ist an `request.locale` gebunden, also an eine Sprache, die Shopify ausliefert. Sie arbeitet **Textknoten für Textknoten** und lädt das **ganze** Wörterbuch einer Sprache. Beides trägt für ganze Seiten nicht (§3).
- **Der Sprachumschalter** ([locale-switcher.liquid](../../extensions/storefront/blocks/locale-switcher.liquid)) postet Shopifys `form 'localization'` und kennt nur veröffentlichte Sprachen.
- **hreflang** erzeugt Shopify selbst. Die App auditiert nur ([hreflang.service.ts](../../app/services/seo/hreflang.service.ts)).
- **Ein Storefront-Crawler existiert** ([crawl.service.ts](../../app/services/seo/crawl.service.ts), `SeoCrawlPage`). Er besucht die Seiten des Shops bereits und ist der naheliegende Lieferant für Segmente (§6.3).
- **Öffentlich versprochen** ist heute „Alle Sprachen, die Shopify erlaubt, in jedem Plan“ ([compare/de.ts](../../app/i18n/marketing/compare/de.ts)). Diese Aussage bleibt stehen, bis eine Stufe **ausgeliefert** ist.

---

## 1. Die eine Tatsache, aus der alles folgt

**Eine Zusatzsprache hat keinen Platz in Shopify.** Shopify kennt den Text nicht, liefert keine `/ja/`-URL aus, rendert keinen Checkout in dieser Sprache und schickt keine Mail darin. Alles, was die Zusatzsprache ausmacht, passiert **nachdem** Shopify eine Seite in einer **Quellsprache** gerendert hat: Die Seite wird genommen und ihr Text ersetzt, im Browser (Stufe 1) oder auf dem Weg zum Browser (Stufe 2).

Daraus folgen drei Festlegungen für den ganzen Plan:

1. **Jede Zusatzsprache hat eine Quellsprache.** Das ist eine veröffentlichte Shop-Sprache, standardmässig die primäre. Japanisch kann auf Englisch aufsetzen, wenn Englisch nativ veröffentlicht ist. Dann bekommt der japanische Kunde den Checkout wenigstens auf Englisch statt auf Deutsch. Die Quellsprache ist also auch die **Checkout-Sprache** der Zusatzsprache, und das wird dem Händler so gesagt.
2. **Die Übersetzungseinheit ist das Segment, nicht das Shopify-Feld.** Ein Segment ist ein Textblock, wie er in der gerenderten Seite steht, mit Platzhaltern für Inline-Markup (§3). Nur ein Segment ist in der Seite **wiederauffindbar**. Ein Feld wie `body_html` ist das nicht, weil das Theme es beliebig umbaut.
3. **Nichts verschwindet still.** Was keine Übersetzung hat, bleibt in der Quellsprache stehen und wird gezählt (Abdeckung pro Sprache, §7). Eine halb übersetzte Seite ist ein erwartbarer Zustand, kein Fehler, und sie muss sichtbar sein.

---

## 2. Stufe 1 und Stufe 2 im Vergleich

| | Stufe 1 — Browser | Stufe 2 — Proxy auf Subdomain |
|---|---|---|
| Arbeitsannahme Tarif | Max | Enterprise |
| URL | unverändert, Sprache per Cookie / `?cp_lang=ja` | `ja.shop.ch/…` (CNAME auf unseren Dienst) |
| Suchmaschinen | sehen die Übersetzung **nicht** | sehen sie, mit `hreflang`, übersetzter Sitemap und Canonical |
| Aufblitzen der Quellsprache | ja, gedämpft (§5.3) | nein |
| Checkout, Mails | Quellsprache | Quellsprache |
| Infrastruktur | keine neue, nur App Proxy und Theme App Extension | neuer Dienst, TLS pro Kundendomain, HTML-Cache |
| Betriebsrisiko | gering | Shopify-Bot-Schutz, Warenkorb über Domains, Ausfall = Shop offline in dieser Sprache |
| Gemeinsam | Segmentierer, Segmentspeicher, Befüllung, Admin-UI, Glossar, Tonalität, Kostenrahmen |

Die Tabelle ist der Grund für die Reihenfolge der Phasen: Alles unter „Gemeinsam“ kommt zuerst. Danach ist Stufe 1 der billigere der beiden Auslieferungswege.

---

## 3. Der Segmentierer (gemeinsam, das Herzstück)

Die heutige Direktübersetzung ersetzt **Textknoten**. Für Widget-Texte wie „Write a review“ reicht das, für Fliesstext nicht. `Unser <strong>Bio</strong>-Tee aus Japan` zerfällt in drei Textknoten, und keiner davon ist allein sinnvoll übersetzbar, schon gar nicht in eine Sprache mit anderer Wortstellung.

**Regel:** Ein Segment ist ein **Blockelement**, dessen Kinder nur Text und Inline-Elemente sind (`a, strong, em, b, i, span, br, small, sup, sub, code, mark`). Aus dem Inhalt wird ein Schlüssel mit nummerierten Platzhaltern:

```
<p>Unser <strong>Bio</strong>-Tee aus <a href="/collections/japan">Japan</a></p>
→ Schlüssel:  "Unser <1>Bio</1>-Tee aus <2>Japan</2>"
→ ja:         "<2>日本</2>産の<1>オーガニック</1>茶"
```

Die KI übersetzt den Schlüssel mitsamt Platzhaltern. Beim Einsetzen werden die **Originalknoten** (mit `href`, Klassen, Event-Handlern) an die Stelle ihrer Platzhalter gehängt. Neu gebaut wird also nichts, nur umgeordnet. Das ist das Verfahren der Proxy-Anbieter, und es ist der Unterschied zwischen „übersetzt“ und „Wortsalat“.

Weitere Regeln:

- **Attribute** sind eigene Segmente: `alt`, `title`, `placeholder`, `aria-label`, `value` von Buttons, dazu `content` von `meta[name=description]` und `og:*` (die zählen nur in Stufe 2, aber der Segmentierer kennt sie).
- **Übersprungen** wird wie heute (`shouldSkip` in direct-translation.js): `script`, `style`, `[translate=no]`, `.notranslate`, reine Zahlen, Preise und Währungen, E-Mail-Adressen. Neu dazu kommt `[data-cp-no-translate]` für Händler.
- **Normalisierung und Hash** sind **eine** Funktion, heute doppelt vorhanden (`normalize` in direct-translation.js, `normalizeSource`/`sourceHash` in [direct-translation.server.ts](../../app/services/direct-translation.server.ts)).

**Der Segmentierer existiert genau einmal.** Er läuft auf dem Server (Befüllung aus Feldern und Crawl, §6; Proxy, Stufe 2) **und** im Browser (Stufe 1). Weichen die beiden um ein Leerzeichen ab, trifft kein Hash, und die Zusatzsprache bleibt stumm, ohne dass ein Fehler auftritt. Deshalb:

- eine Quelldatei `app/services/extra-languages/segmenter.shared.ts` ohne DOM-Bibliotheks-Abhängigkeit. Sie arbeitet auf einem minimalen Knoten-Interface, das im Browser `Node` ist und auf dem Server der `cheerio`-Baum, den der Crawler schon nutzt ([crawl.service.ts](../../app/services/seo/crawl.service.ts));
- ein Build-Schritt, der daraus das Theme-Asset erzeugt;
- ein Test, der fehlschlägt, wenn das eingecheckte Asset nicht dem Build-Ergebnis entspricht;
- ein Test mit echten Theme-HTML-Schnipseln (Dawn und `patis-universe-test-shop`), der für Server- und Browser-Pfad dieselben Hashes verlangt.

---

## 4. Datenmodell

Neue Tabellen. Die Direktübersetzungs-Tabellen werden **nicht** mitbenutzt: Dort pflegt der Händler einzelne Einträge, und die ganze Liste geht pro Sprache an den Browser. Tausende automatisch erzeugte Segmente würden beides ersticken, die Verwaltungsseite wie die Wörterbuch-Antwort.

```prisma
model ExtraLanguage {
  shop         String
  locale       String   // "ja", "pt-BR" — gleiche Validierung wie isValidLocale
  sourceLocale String   // veröffentlichte Shop-Sprache; zugleich Checkout-Sprache
  published    Boolean  @default(false) // wie bei Shopify: vorbereiten, dann veröffentlichen
  delivery     String   @default("browser") // "browser" | "proxy"
  proxyHost    String?  // Stufe 2: "ja.shop.ch"
  createdAt    DateTime @default(now())
  @@id([shop, locale])
}

model PageSegment {          // Quelltext, sprachunabhängig
  id           String   @id @default(cuid())
  shop         String
  sourceLocale String
  hash         String   // sourceHash(normalize(schlüssel))
  sourceKey    String   @db.Text // mit Platzhaltern
  origin       String   // "field" | "theme" | "crawl" | "collector"
  lastSeenAt   DateTime @default(now()) // für die Aufräumung (§6.5)
  @@unique([shop, sourceLocale, hash])
}

model SegmentTranslation {
  segmentId  String
  locale     String
  targetKey  String   @db.Text
  source     String   // "ai" | "user"  — "user" wird nie von der KI überschrieben
  sourceHash String   // Hash des Quelltexts zur Zeit der Übersetzung
  updatedAt  DateTime @updatedAt
  @@id([segmentId, locale])
}

model SegmentPage {          // welche Segmente stehen auf welchem Pfad (für §5.2)
  shop     String
  path     String   // normalisiert, ohne Query
  hashes   String[] // Reihenfolge egal
  seenAt   DateTime
  @@id([shop, path])
}
```

- **Mandanten:** Jede Abfrage trägt `shop`. Auf `shop/redact` wird mitgelöscht, genau wie bei den Direktübersetzungen. Das gehört in denselben Löschpfad, nicht in einen zweiten.
- **Markt-Ebene:** In v1 **nicht** vorgesehen. Eine Zusatzsprache ist global. Wer marktspezifische Wörter braucht, hat dafür die nativen Sprachen.
- **Direktübersetzungen gelten weiter**, auch für Zusatzsprachen. Ein Händler-Eintrag schlägt ein automatisches Segment (`user` vor `ai`), und die Laufzeit fragt beide ab (§5.1).

---

## 5. Stufe 1 — Auslieferung im Browser (Arbeitsannahme: Max)

### 5.1 Laufzeit

Die Direktübersetzung wird zu **einer** Laufzeit mit zwei Wörterbüchern ausgebaut. Einen zweiten Skript-Block mit eigenem `TreeWalker` und eigenem `MutationObserver` gibt es nicht, denn zwei Beobachter, die sich gegenseitig die DOM-Änderungen melden, sind eine Endlosschleife mit Anlauf.

- **Aktivierung:** Das Cookie `cp_lang` oder der Parameter `?cp_lang=ja` (der setzt das Cookie, damit Links teilbar sind). Zusätzlich muss `request.locale` die **Quellsprache** der Zusatzsprache sein. Ist sie es nicht (der Kunde steht auf `/fr/`), leitet der Umschalter erst auf die Quellsprache um (§5.4).
- **`<html lang>`** und `dir` setzt die Laufzeit auf die Zusatzsprache.
- **Reihenfolge je Segment:** Direktübersetzung des Händlers → `SegmentTranslation` → Quelltext stehen lassen und als Kandidat melden (bestehender Collector, nur wenn der Händler das Sammeln eingeschaltet hat).

### 5.2 Wörterbuch pro Seite statt pro Sprache

Das ganze Wörterbuch einer Sprache ist bei einem vollen Katalog Megabytes gross. Deshalb:

1. Die Laufzeit segmentiert die Seite und schickt die **Hashes** (nicht die Texte) an `/apps/contentpilot/extra/<locale>?path=…`.
2. Die Antwort enthält nur die Übersetzungen dieser Hashes und ist pro `(shop, locale, path, version)` cachebar.
3. `SegmentPage` erlaubt einen zweiten Weg: Kennt der Server die Seite schon, liefert er ohne Hash-Liste und kann per `GET` gecacht werden. Das ist der schnelle Pfad für wiederkehrende Seiten.
4. `localStorage` hält die letzten N Seiten, Invalidierung über dieselbe `version` wie heute.

**Offen (Phase 0):** ob Shopifys App Proxy `Cache-Control` der Antwort respektiert und an seinem Rand cacht, oder ob jede Anfrage bis zu Railway durchgeht. Davon hängt ab, ob Stufe 1 bei Traffic-Spitzen eines Shops unseren einzigen Produktions-Knoten belastet (Produktion läuft auf **einer** Instanz — Owner 2026-09-18, siehe `managed-ai-pricing` in der Roadmap).

### 5.3 Das Aufblitzen der Quellsprache

- **Nur wenn eine Zusatzsprache aktiv ist**, versteckt ein Inline-Stil im App Embed den `main`-Bereich (`visibility`, nicht `display`, damit das Layout nicht springt), bis die Seite übersetzt ist, **höchstens 800 ms**. Danach wird aufgedeckt, was da ist.
- Ohne Cookie macht die Laufzeit **gar nichts** ausser dem heutigen Direktübersetzungs-Verhalten. Das ist die Bedingung für die App-Store-Regel zur Performance: Lighthouse misst ohne Cookie, und ein normaler Besucher bezahlt für das Feature keine Millisekunde.

### 5.4 Umschalter

[locale-switcher.liquid](../../extensions/storefront/blocks/locale-switcher.liquid) bekommt die veröffentlichten Zusatzsprachen als zweite Gruppe. Liquid kennt sie nicht, deshalb schreibt die App sie als App-Metafield `$app:contentpilot.extra_languages` (JSON: Code, Name, Quellsprache). Ein Klick auf eine Zusatzsprache:

1. Steht der Kunde nicht auf der Quellsprache, wird zuerst das `localization`-Formular mit `locale_code = sourceLocale` abgeschickt, mit `return_to` samt `?cp_lang=ja`.
2. Sonst wird nur das Cookie gesetzt und die Seite neu gerendert (Neuladen ist einfacher und ehrlicher als eine Rückübersetzung im DOM).

Ein Klick auf eine **native** Sprache löscht das Cookie.

### 5.5 Was Stufe 1 ausdrücklich nicht kann

- Keine Indexierung, kein `hreflang`, keine übersetzten URLs.
- Checkout, Kundenkonto-Seiten auf `shopify.com` und Mails bleiben in der Quellsprache.
- Keine Texte in fremden iframes (wie heute).

Das steht im Admin **bei der Aktivierung**, nicht in einer Hilfeseite. Auf der Website steht es in der Roadmap-Karte.

---

## 6. Befüllung (gemeinsam)

Übersetzt wird **vorher**, nicht beim ersten Besuch. Eine Zusatzsprache, die der erste japanische Kunde halb deutsch sieht, ist verloren.

### 6.1 Aus Shopify-Feldern (der grösste und sauberste Anteil)

Die primären Texte liegen schon im Cache (Produkte, Kollektionen, Seiten, Artikel, Metaobjekte, Menüs, Richtlinien). Der Segmentierer (§3) zerlegt ihr HTML **auf dem Server** in Segmente mit `origin = "field"`. Solange das Theme ein Feld unverändert ausgibt (`{{ product.description }}`), treffen diese Segmente in der gerenderten Seite. Wie oft es trifft, ist Messfrage 0.3.

### 6.2 Aus dem Theme

Die Theme-Locale-Dateien der Quellsprache (bestehender Pfad der Theme-Übersetzung) liefern Buttons, Warenkorb, Formulare und Fehlermeldungen. Platzhalter wie `{{ count }}` werden vor dem Hash durch die Laufzeit-Werte ersetzt, weil die Seite `3 Artikel` zeigt und nicht `{{ count }} Artikel`. Pluralformen und ICU-artige Muster sind der Teil, der am ehesten scheitert. Er ist in 0.3 mitzumessen.

### 6.3 Aus dem Crawl

Der bestehende Storefront-Crawler besucht die Seiten in der Quellsprache und segmentiert sie. Was weder aus Feldern noch aus dem Theme stammt (Apps, Section-Texte, Metafelder in Sections), kommt so mit `origin = "crawl"` herein. Nebenbei entsteht `SegmentPage`, also die Seitenliste für §5.2.

### 6.4 Übersetzen

- Über die **bestehende** Übersetzungs-Pipeline: Batch-Prompts, Glossar, Tonalität, `LOCALE_NAMES`. Die Platzhalter `<n>…</n>` sind Teil des Vertrags. Eine Antwort, deren Platzhalter nicht exakt denen der Quelle entsprechen (Menge und Verschachtelung), wird **verworfen und neu angefragt**, nicht repariert.
- Kostenrahmen: Eine Zusatzsprache ist ein ganzer Shop mal eine Sprache. Vor dem Start zeigt der Admin die Segment- und Zeichenzahl und im Managed-Modus die Budget-Wirkung (`ai-usage-metering`). Der Lauf ist ein Task mit Fortschritt und Abbruch, kein Request.
- **Laufende Pflege:** Ändert sich ein primärer Text, ändert sich sein Hash. Das neue Segment wird übersetzt, das alte veraltet (§6.5). Das hängt an denselben Auslösern wie die Max-Auto-Übersetzung (`reconcileAfterPrimarySave`, `translation-drift-auto-run.service.ts`), nicht an einem zweiten Mechanismus.

### 6.5 Aufräumen

Segmente, die kein Crawl und kein Feld mehr gesehen hat (`lastSeenAt` älter als 60 Tage), werden gelöscht, **ausser** es hängt eine `user`-Übersetzung daran. Die wird nur markiert, denn eine Händler-Korrektur ist Arbeit, die niemand still wegwirft.

---

## 7. Admin-UI (gemeinsam)

- **Einstellungen → Sprachen und Märkte** ([SettingsShopLanguagesTab.tsx](../../app/components/SettingsShopLanguagesTab.tsx)) bekommt einen zweiten Abschnitt „Zusatzsprachen“. Er ist absichtlich getrennt von den Shopify-Sprachen, mit dem Satz, was der Unterschied ist (§5.5). Hinzufügen, Quellsprache wählen, vorbereiten, veröffentlichen, analog zu den nativen Sprachen.
- **Abdeckung pro Zusatzsprache:** Anteil übersetzter Segmente, gewichtet nach Seitenaufrufen, sofern `SegmentPage` sie kennt, sonst nach Anzahl. Die Zahl gehört in dieselbe Abdeckungs-Ansicht wie die nativen Sprachen, nicht in ein zweites Dashboard (siehe Kopf von hreflang.service.ts).
- **Prüfliste:** Segmente mit Übersetzung, filterbar nach Seite und Herkunft, und bearbeitbar. Eine Bearbeitung setzt `source = "user"`.
- **Sprachleiste im Editor:** In v1 **nicht**. Die Editoren schreiben in Shopify-Felder, und jeder ihrer Schreibwege endet in `translationsRegister`. Zusatzsprachen dort hinein zu verdrahten hiesse, jeden Schreibweg zu gabeln. Das ist eine eigene Etappe (Phase 7) und nur zu begründen, wenn die Prüfliste nicht reicht.

---

## 8. Stufe 2 — Proxy auf Subdomain (Arbeitsannahme: Enterprise)

### 8.1 Aufbau

Ein **eigener** Railway-Dienst `contentpilot-edge`, nicht die App. Ein langsamer Shop-Abruf darf die Admin-App nicht ausbremsen, und umgekehrt. Er liest denselben Segmentspeicher (Postgres, nur lesend) und nutzt denselben Segmentierer (§3).

```
Kunde → ja.shop.ch (CNAME) → contentpilot-edge
          → holt https://shop.ch/<pfad> in der Quellsprache
          → segmentiert, ersetzt, schreibt um:
              Links shop.ch/… → ja.shop.ch/…
              <html lang>, <link rel=canonical>, hreflang, og:locale
          → Cache (nur ohne Warenkorb-/Kunden-Cookie)
          → Antwort
```

### 8.2 SEO

- Auf den Proxy-Seiten gibt es `hreflang` auf alle Sprachen, native wie Zusatzsprachen, dazu ein Canonical auf sich selbst und eine übersetzte `sitemap.xml` unter `ja.shop.ch`.
- **Auf den nativen Shopify-Seiten** fehlt der Rückverweis auf `ja.shop.ch`. Ein App Embed mit `target: head` gibt `<link rel="alternate" hreflang="ja" href="https://ja.shop.ch{{ request.path }}">` aus. Ohne diesen Rückverweis wertet Google die Beziehung als einseitig. Er gehört in [hreflang-coverage.shared.ts](../../app/services/seo/hreflang-coverage.shared.ts) als geprüfte Aussage.
- URLs bleiben in v1 unübersetzt (`ja.shop.ch/products/bio-tee`).

### 8.3 Die harten Teile, jeder mit einer Messfrage in Phase 0

- **Warenkorb und Checkout über Domains.** Der Warenkorb hängt an Cookies der Shop-Domain. Der Proxy muss `/cart/*.js` durchreichen und `Set-Cookie`-Domains umschreiben, und der Sprung in den Checkout muss den Warenkorb mitnehmen. Genau hier melden die Kunden anderer Proxy-Apps ihre CORS- und Warenkorbprobleme.
- **Shopify-Bot-Schutz.** Alle Abrufe kommen von wenigen Rechenzentrums-IPs. Ob Shopify sie drosselt oder mit einer Challenge beantwortet, entscheidet über die ganze Stufe.
- **TLS pro Kundendomain.** Jede Subdomain braucht ein Zertifikat. Railway-Custom-Domains pro Dienst sind begrenzt. Die Alternative ist ein Anbieter für „Custom Hostnames“ vor dem Dienst. Zu klären sind Grenze, Preis und Automatisierbarkeit per API, bevor ein einziger Kunde eingerichtet wird.
- **Ausfall.** Fällt der Dienst aus, ist der Shop in dieser Sprache offline. Das verlangt Healthcheck, Monitoring und einen Rückfall: bei Fehlern eine 302-Weiterleitung auf die Quellsprache statt einer Fehlerseite.
- **Plattform-Regeln.** Ob ein Dienst, der Storefront-HTML ausliefert, unter Shopifys App-Store-Anforderungen und Nutzungsbedingungen fällt, wird vor Phase 6 **nachgelesen und zitiert**, nicht angenommen.

---

## 9. Tarife und Entitlements

In [plans.ts](../../app/config/plans.ts) kommt ein neues Entitlement dazu, keine neue Tarif-Achse:

```ts
extraLanguages: { browser: boolean; proxy: boolean; max: number }
```

- Arbeitsannahme: Max bekommt `browser: true, proxy: false`, Enterprise bekommt `proxy: true`. Freigegeben ist damit **nichts**. Ein `max` von `Infinity` wäre ein Versprechen auf unbegrenzte KI-Kosten im Managed-Modus und braucht vorher die Messung aus 0.5.
- Die Durchsetzung liegt am **Server** (App Proxy, Edge-Dienst, Befüllungs-Task), nicht im Theme. Im Theme ist sie Kosmetik.
- Downgrade: Die Zusatzsprachen werden **unveröffentlicht**, nicht gelöscht. Die Daten bleiben, bis `shop/redact` kommt.

---

## 10. Phasen

| Phase | Inhalt | Gehört zu | Entscheidet die Stufenfrage? |
|---|---|---|---|
| **0** | Messungen (§11) | beide | nein, liefert die Grundlage dafür |
| **1** | Segmentierer shared + Build + Tests (§3), Datenmodell + Migration (§4) | beide | nein |
| **2** | Befüllung aus Feldern, Theme und Crawl, Übersetzungs-Task, Pflege, Aufräumen (§6) | beide | nein |
| **3** | Admin-UI: Zusatzsprachen, Abdeckung, Prüfliste (§7), Entitlement (§9) | beide | nein |
| **4** | Stufe 1: Laufzeit, Seiten-Wörterbuch, Aufblitz-Dämpfung, Umschalter (§5) | Stufe 1 | **ja** |
| **5** | Stufe 1 ausliefern: Roadmap-Status, Vergleichsseite nachziehen | Stufe 1 | — |
| **6** | Stufe 2: Edge-Dienst, Domains, Warenkorb, SEO, Monitoring (§8) | Stufe 2 | **ja** |
| **7** | optional: Zusatzsprachen in der Editor-Sprachleiste (§7) | beide | — |

Nach Phase 3 hat der Händler Übersetzungen, die er prüfen, aber noch nirgends ausliefern kann. Das ist gewollt: Genau an dieser Stelle fällt die Stufenfrage, mit gemessenen Zahlen statt Vermutungen.

---

## 11. Phase 0 — was gemessen wird, bevor gebaut wird

1. **Shopifys Sprachlimit, wörtlich.** Wie viele Sprachen erlaubt `shopLocaleEnable` pro Shopify-Tarif, und mit welcher Fehlermeldung scheitert die nächste? Gemessen auf einem Dev-Store, nicht aus einem Blogartikel abgeschrieben. Die Zahl entscheidet, für wie viele Händler das Feature überhaupt ein Problem löst.
2. **App-Proxy-Caching.** Cacht Shopify eine App-Proxy-Antwort mit `Cache-Control: public`? Die Latenz wird kalt und warm gemessen (§5.2).
3. **Trefferquote des Segmentierers.** Auf Dawn und `patis-universe-test-shop`: Welcher Anteil des sichtbaren Textes einer Produkt-, Kollektions- und Startseite wird von Segmenten aus Feldern und Theme (§6.1, §6.2) **ohne Crawl** getroffen? Liegt der Wert unter etwa 70 %, trägt der Crawl die Hauptlast, und §6 muss umgewichtet werden.
4. **Aufblitzen.** Die Zeit von DOMContentLoaded bis „übersetzt“ bei warmem und kaltem Cache, auf einem Mittelklasse-Handy mit gedrosseltem Netz. Sie entscheidet, ob 800 ms (§5.3) reichen.
5. **Kosten einer Zusatzsprache.** Segmente und Zeichen eines echten Shops mal Preis pro Zeichen des Managed-Standardmodells. Das Ergebnis ist die Zahl für `extraLanguages.max` (§9).
6. **Nur für Stufe 2:** Warenkorb bis Checkout über `ja.<testdomain>`, Bot-Schutz bei 1 und bei 10 Anfragen pro Sekunde von einer Railway-IP, Grenze und Automatisierbarkeit der Custom-Domain-Zertifikate (§8.3).

---

## 12. Was den Plan kippen würde

- **Trefferquote (0.3) deutlich unter 50 %, auch mit Crawl.** Dann wäre Stufe 1 bei echten Themes ein Flickenteppich, und die Befüllung müsste auf den Crawl allein setzen. Das ist teurer und langsamer, aber nicht tot.
- **Shopify blockt oder drosselt den Proxy (0.6).** Dann gibt es keine Stufe 2, es sei denn über eine andere Architektur (etwa Headless mit der Storefront API). Das wäre ein neuer Plan und keine Phase dieses Plans.
- **Warenkorb über Domains nicht verlässlich (0.6).** Eine Stufe 2, die den Kauf abbricht, ist schlechter als keine.
- **Sehr hohe Limits bei Shopify (0.1).** Wenn praktisch jeder Tarif so viele Sprachen erlaubt, wie Händler brauchen, schrumpft der Nutzen auf wenige Grosshändler. Dann ist Stufe 2 als Enterprise-Merkmal der einzige Teil mit einem Käufer.

## 13. Nicht-Ziele (v1)

Übersetzte URLs, marktspezifische Zusatzsprachen, übersetzte Checkout-Seiten und Mails, Bilder pro Sprache, Rückübersetzung ohne Neuladen, Zusatzsprachen in der Editor-Sprachleiste (bis Phase 7).
