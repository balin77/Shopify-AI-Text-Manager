# SEO-Checkliste für die öffentliche Website

Stand: 2026-09-30. Was im Code bereits erledigt ist, steht am Ende. Die Punkte davor musst du selbst erledigen, sobald die Seite online ist, in der angegebenen Reihenfolge.

## 1. Direkt beim Livegang

- [ ] **Eigene Domain anschliessen.** Eine eigene Domain (z. B. `contentpilot.ai`) wirkt vertrauenswürdiger und rankt besser als `contentpilotai.up.railway.app`. In Railway beim Production-Service unter *Settings → Networking → Custom Domain* eintragen und den DNS-Eintrag beim Domain-Anbieter setzen.
- [ ] **`PUBLIC_SITE_URL` setzen** (nur Production), z. B. `PUBLIC_SITE_URL=https://contentpilot.ai`. Danach zeigen Canonical, hreflang, Sitemap, robots.txt, llms.txt und die strukturierten Daten immer auf diese Domain.
- [ ] **Shopify-App-URL nicht ändern**, solange nichts anderes geplant ist: Die App im Shopify-Admin darf weiter auf der Railway-Adresse laufen. Soll auch die App auf die neue Domain umziehen, gemeinsam planen, denn das betrifft die Shopify-Konfiguration und alle installierten Shops.
- [ ] **Development vor Google verstecken.** Beim Development-Service prüfen, dass `APP_ENV=development` gesetzt ist. Kontrolle: `curl -I https://shopify-ai-text-manager-development.up.railway.app/` muss `X-Robots-Tag: noindex, nofollow` zeigen. Production darf diesen Header nicht zeigen.
- [ ] **Vergleichsseiten prüfen, bevor sie online gehen.** `/compare` nennt echte Konkurrenten mit Funktionen und Preismodellen (Stand September 2026). Einmal selbst durchlesen und die Angaben in den App-Store-Einträgen der vier Apps gegenprüfen, besonders die Felder „Keine Angabe“. Die Fakten stehen an einer Stelle; Korrekturen einfach mir sagen.
- [ ] **Kurztest der wichtigsten Adressen** auf der Live-Domain: `/`, `/de`, `/es`, `/features`, `/guide`, `/guide/glossary`, `/compare`, `/compare/weglot`, `/sitemap.xml`, `/robots.txt`, `/llms.txt`. Alle müssen mit 200 antworten, `/features/` mit 301 auf `/features`.

## 2. Suchmaschinen anmelden (erste Woche)

- [ ] **Google Search Console:** Eine *Domain-Property* anlegen (Bestätigung per DNS-TXT-Eintrag). Unter *Sitemaps* `https://<domain>/sitemap.xml` einreichen.
- [ ] Mit der **URL-Prüfung** Startseite, `/de`, `/es` und `/guide` prüfen und „Indexierung beantragen“.
- [ ] **Bing Webmaster Tools:** Website aus der Search Console importieren (ein Klick) und die Sitemap bestätigen. Bing ist wichtig, weil ChatGPT-Suche und Microsoft Copilot auf Bing aufbauen.
- [ ] **Strukturierte Daten testen:** Startseite und eine Anleitungsseite in Googles [Rich-Results-Test](https://search.google.com/test/rich-results) und im [Schema Markup Validator](https://validator.schema.org/) prüfen. Erwartung: Organization, WebSite, SoftwareApplication und FAQPage auf der Startseite; TechArticle und Breadcrumbs auf Anleitungsseiten. Hinweis: Google zeigt FAQ-Snippets heute fast nur noch bei Behörden- und Gesundheitsseiten. Das Markup schadet nicht und hilft KI-Suchen.
- [ ] **PageSpeed Insights** (mobil) für Startseite, `/features` und eine Anleitungsseite laufen lassen. Ziel: „Gut“ bei allen Core Web Vitals. Ergebnis gerne an mich schicken.

## 3. Inhalte, die nur du liefern kannst (erste Wochen)

- [ ] **Screenshots statt Platzhaltern.** Auf Startseite und `/features` steht noch „Bild folgt“. Echte Screenshots machen die Seite glaubwürdiger und können über die Google-Bildersuche gefunden werden. Die Beschreibungen, was jedes Bild zeigen soll, stehen bereits im Code (`media.alt` in `app/i18n/marketing/*.ts`). Dateien einfach mir geben.
- [ ] **Teilen-Bild 1200 × 630 px** erstellen (Logo, Name, ein Satz). Aktuell wird das quadratische App-Icon verwendet, darum erscheinen geteilte Links auf LinkedIn, Facebook und in Slack nur als kleine Kachel.
- [ ] **Videos** nach dem Drehplan (`docs/marketing/video-drehplan.md`) produzieren. Auf YouTube mit aussagekräftigem Titel veröffentlichen, in der Beschreibung auf die passende Anleitungsseite verlinken, dann die ID bei mir melden. Beim ersten veröffentlichten Video ergänze ich das VideoObject-Markup, damit Videos in der Google-Suche erscheinen.
- [ ] **App-Store-Eintrag verlinken:** Im Shopify-Partner-Dashboard beim App-Eintrag die Website als Entwickler-Website und `/guide` als Dokumentation bzw. FAQ hinterlegen. Das ist der stärkste Link, den du bekommen kannst.

## 4. Bekanntheit und Links (laufend)

- [ ] In der **Shopify Community** (community.shopify.com) Fragen zu Übersetzung, Märkten, Alt-Texten und SEO beantworten und dabei, wo es passt, auf eine Anleitungsseite verlinken. Echte Hilfe, keine Werbung.
- [ ] **LinkedIn-Profil und Firmenseite** mit Link zur Website. Launch-Beitrag mit einem der Videos.
- [ ] Eintrag in **App-Verzeichnissen und Vergleichslisten** (z. B. Artikel „beste Shopify-Übersetzungs-Apps“). Autoren anschreiben, ob die App aufgenommen werden kann.
- [ ] **Agenturen und Freelancer** im Shopify-Umfeld ansprechen. Ein Link von deren Website oder eine Erwähnung im Blog zählt mehr als viele Verzeichnisse.
- [ ] Optional: Launch auf **Product Hunt**.

## 5. Nach 4–6 Wochen: mit echten Daten weitermachen

- [ ] In der Search Console unter *Leistung* nachsehen, bei welchen Suchbegriffen die Seite erscheint, aber kaum geklickt wird (Position 5–20). Mir die Liste geben, dann passe ich Titel und Beschreibungen gezielt an.
- [ ] **Vergleichsseiten erweitern:** `/compare` gibt es bereits (Translate & Adapt, Weglot, Transcy, LangShop). Wenn in der Search Console Suchen nach weiteren Apps auftauchen (z. B. „langify alternative"), mir sagen, dann ergänze ich sie.
- [ ] **Anwendungsfall-Seiten** für Suchbegriffe, die in der Search Console auftauchen, z. B. „Shopify Shop auf Französisch übersetzen“ oder „Shopify Märkte Schweiz Übersetzung“.
- [ ] Monatlich die Search Console prüfen: *Seiten* (nicht indexiert?), *Core Web Vitals*, *hreflang*-Hinweise.

## Bereits im Code erledigt

- Titel, Beschreibung, Canonical, Open Graph und Twitter-Karte auf jeder Seite; hreflang für EN/DE/ES plus x-default; `<html lang>` passend zur Sprache.
- Sitemap mit allen Seiten und allen 40 Anleitungsthemen in drei Sprachen, inklusive hreflang-Alternativen. robots.txt sperrt nur App- und Technik-Pfade.
- Feste kanonische Domain über `PUBLIC_SITE_URL`.
- 301-Weiterleitung von URLs mit Schrägstrich am Ende (`/features/` → `/features`).
- Strukturierte Daten (JSON-LD): Organization, WebSite, SoftwareApplication, FAQPage (Startseite); TechArticle und BreadcrumbList (Anleitung).
- `/llms.txt` mit allen Seiten und Anleitungsthemen für KI-Assistenten.
- Interne Links von jedem Funktionsblock zur passenden Anleitungskategorie.
- Vergleichsseiten `/compare` (Übersicht) und `/compare/<app>` für Translate & Adapt, Weglot, Transcy und LangShop, in drei Sprachen, mit Breadcrumbs, in Sitemap und llms.txt.
- `noindex`-Header für Nicht-Produktions-Umgebungen, Apple-Touch-Icon.
- Keine Cookies und keine Drittanbieter-Skripte vor einem Klick; YouTube lädt erst beim Abspielen. Das ist gut für Ladezeit und Datenschutz.
