# Storefront-Extension: Liquid-Budget zurückgewinnen — Plan

**Status:** Plan, nicht umgesetzt. Ist-Zustand am 2026-10-02 auf Branch `claude/storefront-liquid-budget` gemessen (Commit `a8da7d1`).

**Frage, die dieser Plan beantwortet:** Wie kommt die Theme-App-Extension wieder deutlich unter das 100-KiB-Liquid-Limit von Shopify, und wie verschwinden die drei Theme-Check-Warnungen — ohne dass sich am Storefront etwas ändert?

**Antwort in einem Satz:** Der größte Hebel ist nicht „Markup nach `assets/` verschieben", sondern dass der Minifier ~32 KB des Embed-Blocks nie anfassen darf, weil sie in einem `<script type="application/json">` stehen — wer die JSON-Erzeugung aus dem `<script>`-Element in ein `capture` holt und die 19 kopierten Objekt-Körper in **ein** Snippet legt, spart dort allein ~19 KB; zusammen mit einer Minifier-Erweiterung für `{% liquid %}`-Tags landen wir bei **~69 KiB statt 95,8 KiB** (−28 KB).

---

## 0. Gemessener Ist-Zustand

### 0.1 Budget (`npm run minify:blocks`)

| Datei | Quelle | minifiziert | gespart |
|---|---:|---:|---:|
| blocks/direct-translation.liquid | 2 621 | 1 435 | 45 % |
| blocks/locale-switcher.liquid | 24 130 | 19 264 | 20 % |
| blocks/localized-media.liquid | 3 393 | 1 509 | 56 % |
| blocks/social-meta.liquid | 5 003 | 2 975 | 41 % |
| blocks/structured-data.liquid | 40 350 | 26 159 | 35 % |
| **blocks/variant-gallery-embed.liquid** | 41 459 | **36 750** | **11 %** |
| blocks/variant-gallery.liquid | 8 193 | 6 637 | 19 % |
| blocks/web-vitals.liquid | 2 757 | 714 | 74 % |
| snippets/cp-external-video.liquid | 4 680 | 2 043 | 56 % |
| snippets/cp-localized-image.liquid | 1 774 | 596 | 66 % |
| **TOTAL** | 134 360 | **98 082** | — |

**95,8 KiB von 100 KiB** — knapp unter dem Ziel von 96 KiB (`LIQUID_TARGET_BYTES`). Beim letzten `npm run deploy` lag der Wert bei 96–98 KiB; eine einzige weitere Block-Änderung kann den Deploy brechen.

### 0.2 Woraus die minifizierten Bytes bestehen

Gemessen mit `scanRegions()` aus [minify-liquid-blocks.mjs](../../scripts/minify-liquid-blocks.mjs) (Bytes der Region im Quelltext; „geschützt" = vom Minifier byte-identisch gelassen):

| Block | JSON-Insel (`<script type=application/json\|ld+json>`) | `{% … %}`-Tags (inkl. `{% liquid %}`) | inline `<script>` JS | inline `<style>` |
|---|---:|---:|---:|---:|
| variant-gallery-embed | **32 174** | 195 | 886 (davon 812 FOUC-Setter) | 279 |
| structured-data | 6 258 | **15 587** | 570 (404-Beacon) | — |
| locale-switcher | — | **9 124** | 367 (Layout-Shift-Guard) | — |
| variant-gallery | 2 145 | 1 597 | 68 | — |

**Warum der Embed-Block nur 11 % schrumpft:** Die komplette JSON-Erzeugung (Zeilen 55–603, alle Schleifen, alle `{%- comment -%}`-Blöcke, alle Einrückungen) steht *innerhalb* von `<script type="application/json" id="cp-embed-data-…">`. Der Minifier behandelt jedes `<script>`-Element als geschützte Region — korrekt für JS (ASI), aber hier verliert er dadurch 32 KB, darunter ~4 KB Kommentare, die er sonst entfernen würde.

**Warum structured-data und locale-switcher „feststecken":** Der Minifier lässt das *Innere* jedes `{% … %}`-Tags byte-identisch — also auch mehrzeilige `{%- liquid … -%}`-Blöcke mit ihren `#`-Kommentarzeilen und ihrer Einrückung (15,6 KB bzw. 9,1 KB).

**Inline-JS/-CSS ist klein.** Über alle Blöcke zusammen ~2,3 KB, und der größte Teil davon *muss* inline bleiben (§1.2). „Inline-Skripte nach `assets/` verschieben" bringt ~0,5 KB — der Hebel liegt woanders.

### 0.3 Theme-Check-Warnungen (aus dem Deploy, auf den minifizierten Dateien)

| Warnung | Ort | Ursache |
|---|---|---|
| `LiquidNestingDepth` 11 > 10 | variant-gallery-embed.liquid, Quelle Z. ~142 | `for variant` › `if order` › `for entry` › `if file` › `for item` › `if id-match` › `elsif video` › `if preview` › `for src` › `unless forloop.first` |
| `LiquidComplexity` 123 > 120 | variant-gallery-embed.liquid | 19 kopierte Objekt-Körper mit je eigenen `if`/`for` |
| `LiquidComplexity` 146 > 120 | structured-data.liquid | ganze Datei; gemeldet um Z. 650 (Galerie-Video-Akkumulation) |

Die genaue Metrik ist im Sandbox nicht verfügbar (kein `node_modules`, keine Shopify CLI). Ein Näherungszähler — Summe der Schlüsselwörter `if`/`elsif`/`unless`/`for`/`when`/`and`/`or` über alle Liquid-Tags der *minifizierten* Datei — ergibt **122** für den Embed (gemeldet: 123) und **156** für structured-data (gemeldet: 146). Für den Embed trifft er also fast exakt; für structured-data überschätzt er um ~10. **Schluss:** Die Metrik ist offenbar **pro Datei**. Eine Datei kommt nur unter 120, wenn Verzweigungen die Datei *verlassen* (Snippet) — Umformulieren innerhalb der Datei spart wenige Punkte.

### 0.4 Wer die Embed-JSON liest

[assets/variant-gallery-embed.js](../../extensions/storefront/assets/variant-gallery-embed.js) liest `document.getElementById('cp-embed-data-' + blockId).textContent` und `JSON.parse` (Z. 171–176); dazu der Inline-FOUC-Setter im Block selbst (nur `data[String(id)].length`). Gelesene Schlüssel pro Eintrag:

| `type` | gelesene Schlüssel (JS Z. 460–583, 870–883) |
|---|---|
| `image` (Default bei fehlendem `type`) | `src_400`, `src_800`, `src_1200`, `thumb`, `w`, `h`, `alt` |
| `video` | `thumb`, `poster`, `w`, `h`, `alt`, `sources[].src`, `sources[].mime` |
| `external_video` | `thumb`, `poster`, `w`, `h`, `alt`, `host`, `external_id` |
| `model` | `thumb`, `poster`, `w`, `h`, `alt`, `model_src` |

Der Vertrag ist **`JSON.parse`-Gleichheit**, nicht Byte-Gleichheit: Whitespace zwischen Tokens und die Schreibweise `\u003c` statt `<` innerhalb eines Strings ergeben nach `JSON.parse` dieselben Werte.

### 0.5 Die 19 Objekt-Körper im Embed (verifiziert)

| Typ | Zeilen (Quelle) | Anzahl |
|---|---|---:|
| Bild, `variant.featured_image` (alt = `variant.title`) | 90–99, 361–370, 505–514 | 3 |
| Bild, `vg.value`-Eintrag (alt = `item.alt \| default: variant.title`) | 117–126, 244–253, 394–403 | 3 |
| Bild, `product.media` (alt = `media.alt \| default: product.title`) | 526–535 | 1 |
| Video (`sources`-Schleife) | 133–146, 260–273, 413–426, 542–555 | 4 |
| Externe URL über `cp-external-video` (alt = `variant.title`) | 162–184, 288–310, 444–466 | 3 |
| Externes Video, `product.media` | 562–571 | 1 |
| 3D-Modell aus `custom.variant_3d_models` (alt = `variant.title`) | 211–223, 336–348, 484–496 | 3 |
| 3D-Modell, `product.media` (GLB-Suche) | 574–595 | 1 |

---

## 1. Was nach `assets/` darf — und was nicht

### 1.1 Regel

`assets/` zählt nicht zum Budget, wird aber **erst im Browser** wirksam. Alles, was ein Crawler, ein Besucher ohne JS oder der erste Paint braucht, bleibt in Liquid.

### 1.2 Muss in Liquid bleiben

| Inhalt | Warum |
|---|---|
| **Alle JSON-LD-Inseln** (structured-data) | Crawler lesen das Server-HTML; per JS erzeugtes JSON-LD ist für viele Konsumenten unsichtbar, und die App misst den Server-Output (Crawl, `data-contentpilot`-Marker). Nie nach JS verschieben. |
| **OG-/Twitter-Tags** (social-meta) | dieselbe Begründung, Social-Crawler führen kein JS aus |
| **Daten aus Metafeldern / `product` / `localization`** (Embed-JSON, Galerie-JSON, Locale-Optionen) | Nur Liquid kann sie lesen; der Storefront hat keine Admin-API. |
| **FOUC-Setter + Prehide-`<style>`** im Embed (~1,1 KB) | muss *synchron während des `<head>`-Parsens* laufen; ein `defer`-Asset läuft erst nach dem Parsen, also nach dem ersten Paint — genau das, was er verhindern soll. |
| **Layout-Shift-Guard** im Locale-Switcher (~0,3 KB) | gleiche Begründung (dokumentiert im Block, Z. 313–332) |
| **No-JS-Markup** des Locale-Switchers (`<form>`, `<select>`, Optionstexte inkl. Währung) und der `variant-gallery`-Thumbs/Hauptbild | funktioniert ohne JS; Hauptbild ist `loading: eager` (LCP) |
| **`{% schema %}`-Blöcke** (~14,4 KB minifiziert, davon Locale-Switcher 6,6 KB) | Shopify liest sie nur dort. `info`-Texte kürzen wäre eine händlersichtbare Änderung im Theme-Editor → außerhalb des Umfangs. |

### 1.3 Darf raus (gemessen)

| Kandidat | Ersparnis | Schritt |
|---|---:|---|
| 404-Beacon in structured-data → `assets/seo-404.js` | **510 B** | Schritt 6 |
| Locale-Switcher: Flaggen-Auflösung Stufe 2–5 nach `locale-switcher.js` | ~1,3 KB | **nicht** in diesem Plan (§8) — lohnt das Risiko nach Schritt 1–5 nicht mehr |

---

## 2. Übersicht der Schritte

| # | Schritt | Dateien | Ersparnis (minifiziert) | Pflicht? |
|---|---|---|---:|---|
| 1 | Minifier: Whitespace-Control beim Entfernen von Kommentaren exakt nachbilden | `scripts/minify-liquid-blocks.mjs`, Test | ±0 (Korrektheit) | **ja**, vor Schritt 3 |
| 2 | Minifier: Inneres von `{% liquid %}` minifizieren | `scripts/minify-liquid-blocks.mjs`, Test | **~7,4 KB** | empfohlen |
| 3 | Embed: JSON in `capture` + Snippet `cp-vg-item` + Fallback-Memo | `blocks/variant-gallery-embed.liquid`, **neu** `snippets/cp-vg-item.liquid`, **neu** Test | **~19,2 KB** netto | **ja** |
| 4 | structured-data: doppelte Dedup-Akkumulation zu einer zusammenfassen | `blocks/structured-data.liquid` | ~1,0 KB | empfohlen |
| 5 | structured-data: Video-Abschnitt in Snippet `cp-sd-videos` | `blocks/structured-data.liquid`, **neu** `snippets/cp-sd-videos.liquid`, 2 Tests | ±0 | nur für die Complexity-Warnung |
| 6 | 404-Beacon nach `assets/seo-404.js`; toter `flag_only`-Zweig im Locale-Switcher | `blocks/structured-data.liquid`, **neu** `assets/seo-404.js`, `blocks/locale-switcher.liquid` | ~0,8 KB | optional |
| 7 | variant-gallery.liquid: JSON-Insel ebenfalls per `capture` | `blocks/variant-gallery.liquid` | ~0,5 KB | optional |

**Erwartung gesamt:** 98 082 → **~70 500 B nach Schritt 1–4** (68,8 KiB) → ~69 830 B mit Schritt 6, ~69 360 B mit Schritt 7 (67,7 KiB). Gemessen mit Wegwerf-Prototypen (§9.1); die Snippet-Version ist im Anhang A/B vollständig ausgeschrieben.

Reihenfolge der Commits: 1 → 2 → 3 → 4 → (5) → (6) → (7). Jeder Schritt ist für sich deploybar und einzeln rückrollbar.

---

## 3. Schritt 1 — Kommentar-Entfernung bildet `{%-` / `-%}` exakt nach

### 3.1 Problem

Heute entfernt der Minifier `{%- comment -%}…{%- endcomment -%}` ersatzlos, lässt aber den Whitespace stehen, den die Bindestriche beim Rendern *weggeschnitten* hätten. Beispiel aus dem eigenen Test: `x {%- comment -%} note {%- endcomment -%} y` rendert in Liquid als `xy`, minifiziert als `x  y`. In HTML ist das meist harmlos (aber nicht immer: zwischen zwei Inline-Elementen entsteht ein sichtbares Leerzeichen). Sobald in Schritt 3 JSON-Text in eine nicht geschützte Region wandert, wäre derselbe Effekt *innerhalb eines JSON-Strings* eine Datenänderung. Heute steht kein Kommentar innerhalb eines Strings — aber die Garantie soll der Minifier geben, nicht die Disziplin.

### 3.2 Änderung in `minifyLiquid` / `createEmitter`

1. Der Emitter bekommt eine Methode `trimTrailingWhitespace()`, die Whitespace `[ \t\n\r\f\v]` am Ende der Ausgabe entfernt — **aber nur innerhalb des unmittelbar vorangehenden `plain`-Segments** (Liquid schneidet nur das direkt vorangehende Text-Token). Danach `lineHasContent` aus der verbliebenen letzten Zeile neu bestimmen, `blankRun = 0`.
   - Umsetzungstipp: In `minifyLiquid` merkt man sich den Index in `out`, ab dem das aktuelle `plain`-Segment geschrieben wurde; getrimmt wird nur ab dort.
2. In der Schleife von `minifyLiquid` für ein `comment`-Segment:
   - beginnt es mit `{%-` **und** war das vorherige Segment `plain` → `trimTrailingWhitespace()`;
   - endet es mit `-%}` (das schließende `endcomment`) → beim **nächsten** Segment, falls `plain`, führenden Whitespace `^[ \t\n\r\f\v]+` vor `pushPlain` entfernen.
3. Bewusst **nicht** `\s` verwenden: JS-`\s` enthält NBSP und Unicode-Leerzeichen, Liquid (`lstrip`/`rstrip`) nur ASCII-Whitespace.

### 3.3 Tests ([minify-liquid-blocks.test.ts](../../tests/unit/minify-liquid-blocks.test.ts))

- Z. 37–39 „removes an inline comment without eating its neighbours": Erwartung von `'x  y'` auf **`'xy'`** ändern und den Testnamen auf „…exactly as Liquid's whitespace control would" anpassen.
- Neu: `'a \n {% comment %}c{% endcomment %} \n b'` → Whitespace bleibt (ohne Bindestriche wird nichts getrimmt).
- Neu: `'"a {%- comment -%}x{%- endcomment -%} b"'` → `'"ab"'` (der JSON-String-Fall).
- Neu: zwei aufeinanderfolgende Kommentare (`a  {%- comment -%}1{%- endcomment -%}{%- comment -%}2{%- endcomment -%}  b` → `ab`).
- Z. 242–254 „changes nothing but whitespace outside the protected regions": Der Vergleich normalisiert Whitespace zu einem Leerzeichen; wenn die Emulation einen reinen Whitespace-Rest *komplett* entfernt, verschwindet dort auch das eine Leerzeichen. Den Helper so ändern, dass er Whitespace **ganz entfernt** (`.replace(/\s+/g, '')`) statt zu einem Leerzeichen zusammenzufassen — die Aussage „nur Whitespace hat sich geändert" bleibt dieselbe.
- Idempotenz-Tests (Z. 186–205) müssen unverändert grün bleiben.

---

## 4. Schritt 2 — Inneres von `{% liquid %}` minifizieren

### 4.1 Regel

In einem mehrzeiligen `{%- liquid … -%}`-Tag ist jede Zeile ein eigenes Tag; führender Whitespace ist bedeutungslos, und eine Zeile, deren erstes Nicht-Leerzeichen `#` ist, ist ein Kommentar. Strings können keine Zeile überspannen. Also für jede geschützte Region, die mit `/^\{%-?\s*liquid\b/` beginnt:

1. Erste Zeile (`{%- liquid` plus evtl. Code dahinter) **unverändert** lassen.
2. Jede weitere Zeile: führenden und nachgestellten `[ \t]` entfernen.
3. Zeilen dazwischen (nicht die letzte!), die danach leer sind oder mit `#` beginnen, **entfernen**.
4. Letzte Zeile (enthält `-%}`/`%}`) immer behalten, nur Einrückung entfernen.
5. **Nicht** anfassen: ein `#` *hinter* Code auf derselben Zeile (`assign x = 1 # …`) — die Zeile bleibt komplett. Kein Versuch, Inline-Kommentare abzuschneiden (ein `#` kann in einem String-Literal stehen).

Umsetzen als neue reine Funktion `minifyLiquidTag(text)` im Modul (exportiert, damit testbar) und in `minifyLiquid` für `protected`-Segmente aufrufen, bevor `pushProtected` sie schreibt. Alle anderen geschützten Regionen bleiben byte-identisch.

### 4.2 Ersparnis (gemessen, auf den heutigen Quellen)

| Datei | vorher | nachher |
|---|---:|---:|
| locale-switcher | 19 264 | 15 985 |
| structured-data | 26 159 | 22 366 |
| cp-external-video | 2 043 | 1 480 |
| social-meta | 2 975 | 2 813 |
| localized-media | 1 509 | 1 361 |
| cp-localized-image | 596 | 506 |
| variant-gallery | 6 637 | 6 621 |
| **Summe** | 98 082 | **90 031** (−8 051) |

### 4.3 Tests

- Z. 169–172 „keeps the indented interior of a multi-line {% liquid %} tag": umbenennen und Erwartung ändern: `['{%- liquid', '  assign a = 1', '      assign b = 2', '-%}']` → `'{%- liquid\nassign a = 1\nassign b = 2\n-%}'`.
- Neu: `#`-Zeile wird entfernt, `assign x = '#'` und `assign y = 1 # note` bleiben unverändert.
- Neu: `capture`/`echo`/`endcapture` innerhalb von `{% liquid %}` bleiben in Reihenfolge erhalten.
- Neu: Ein einzeiliges `{% liquid assign a = 1 %}` bleibt byte-identisch.
- Z. 234–240 „keeps every protected region of every block byte-identical": `{% liquid %}`-Regionen vom Vergleich ausnehmen und stattdessen prüfen, dass `minifyLiquidTag(before) === after` gilt.
- Z. 256–264 („no Liquid comments") um einen Check ergänzen: kein minifiziertes `{% liquid %}` enthält eine Zeile, die mit `#` beginnt.

### 4.4 CLAUDE.md nachziehen (nach dem Merge, nicht in diesem Plan)

Der Satz unter „Deploy-critical gotchas" — *„Minification skips … every `{% … %}` / `{{ … }}` interior byte-identically, so comments inside a JSON island buy no headroom"* — wird falsch für `{% liquid %}`. Neu formulieren: `{% liquid %}`-Inneres wird von Einrückung und `#`-Zeilen befreit; JSON-Inseln mit Liquid-Logik gehören in ein `capture` *vor* dem `<script>` (Schritt 3), sonst zählt jeder Kommentar darin voll.

---

## 5. Schritt 3 — Embed: ein Snippet für alle 19 Objekt-Körper

### 5.1 Drei Teile

**(a) JSON-Erzeugung aus dem `<script>` holen.** Z. 55 `<script type="application/json" id="cp-embed-data-{{ block.id }}">` wird zu `{%- capture cp_vg_json -%}`; Z. 603 `</script>` wird zu

```liquid
{%- endcapture -%}
<script type="application/json" id="cp-embed-data-{{ block.id }}">{{ cp_vg_json }}</script>
```

Id und Element bleiben gleich; Setter und Controller merken nichts. Damit liegt die Logik in einer `plain`-Region: Kommentare und Einrückung werden minifiziert. **Allein dieser Teil** bringt 36 750 → 23 395 B. Der ursprüngliche Kommentarblock R3-H1 (Z. 46–54) bleibt vor dem `capture` stehen.

**(b) Snippet `snippets/cp-vg-item.liquid`** (vollständiger Text: Anhang A). Gibt **ein** JSON-Objekt aus — oder **nichts**, wenn der Eintrag nach den bisherigen Regeln nicht emittiert würde. Parameter:

| Parameter | Bedeutung |
|---|---|
| `m` | Shopify-Media- oder Image-Objekt (Bild, Video, externes Video, Modell) |
| `kind` | erzwingt den Typ; nur `'image'` für `variant.featured_image` |
| `alt` | roher Alt-Text (`item.alt`, `media.alt`) oder weglassen |
| `fb` | Fallback-Alt (`variant.title` oder `product.title`) |
| `url` | externe Video-URL → Modus „externe URL" (ruft intern `cp-external-video`) |
| `model` | Modell-URL aus `custom.variant_3d_models` → Modus „Metafeld-Modell" |
| `preview` | Vorschau-URL zum Modell (`''` wenn keine) |

Vorrang im Snippet: `url` → `model` → `kind`/`m.media_type`. Alt wird einmal berechnet: `alt | default: fb | json`.

**Escape-Regel (wichtig):** Das Snippet sammelt sein Objekt in `capture cp_i_out` und gibt es **einmal** aus als `{{- cp_i_out | replace: "<", "\u003c" | replace: ">", "\u003e" -}}`. Das ersetzt die bisherigen Einzel-`replace`s am `alt` (R3-H1) und hat zwei Folgen, beide gewollt:

1. Die Ausgabe enthält **garantiert kein `<` und kein `>`**. JSON-Struktur enthält diese Zeichen nie, sie können nur in String-Werten stehen, und dort ist `<` ein gültiges Escape, das `JSON.parse` zurückverwandelt. Daraus folgt, dass das Abschneiden von Shopifys `<!-- BEGIN app snippet … -->`-Annotation mit `split: '-->' | last | split: '<!--' | first` beim Aufrufer **beweisbar** nichts vom Objekt abschneidet — heute könnte eine Modell-URL mit `-->` das theoretisch.
2. Auch `model_src` und Video-`src` (bisher nur `| json`) können das `<script>`-Element nicht mehr verlassen — eine kostenlose Härtung, `JSON.parse`-gleich.

**(c) Aufrufer-Muster** — an jeder Aufrufstelle exakt diese drei Zeilen (die zweite Zeile wie im bestehenden Code linksbündig, damit sie beim Suchen auffällt):

```liquid
{%- capture cp_o -%}{%- render 'cp-vg-item', m: item, alt: item.alt, fb: variant.title -%}{%- endcapture -%}
{%- assign cp_o = cp_o | split: '-->' | last | split: '<!--' | first | strip -%}
{%- if cp_o != blank -%}{%- if cp_has_any %},{% endif -%}{{ cp_o }}{%- assign cp_has_any = true -%}{%- endif -%}
```

Komma und `cp_has_any` bleiben beim Aufrufer — der Snippet kennt keinen Zustand (`render` ist scope-isoliert). Die Dedup-Mengen (`cp_seen_file_ids`, `cp_seen_urls`, `cp_seen_models`) und die Vorschau-Suche für Modelle bleiben **unverändert** beim Aufrufer.

### 5.2 Die Aufrufstellen

Vollständiger neuer Insel-Text: Anhang B. Struktur:

| Pfad | Vorher | Nachher |
|---|---|---|
| Order-Pfad (`variant_gallery_order` gesetzt) | Featured + `for entry` mit 3 Zweigen (file/url/model), Körper je Zweig inline | Featured: 1 Aufruf. `for entry`: die Zweige setzen nur Parameter (`cp_rm` = gefundenes Item, `cp_ru` = URL, `cp_rmod`/`cp_rpv` = Modell/Vorschau), **ein** Aufruf am Ende der Iteration. `continue` überspringt ihn wie bisher die Emission. Die vier Parameter am **Anfang** jeder Iteration auf `''` zurücksetzen (vor jedem `continue`). |
| Order-Tail `vg.value` | inline Bild+Video | 1 Aufruf, nur wenn `media_type` `image` oder `video` |
| Order-Tail externe URLs | inline Parser + Körper | 1 Aufruf mit `url:` |
| Order-Tail Modelle | inline | 1 Aufruf mit `model:`/`preview:` |
| Default-Pfad | Featured, Bild-Pass, Video-Pass, URLs, Modelle | je 1 Aufruf (5) — die zwei Pässe bleiben getrennt (Reihenfolge „alle Bilder, dann alle Videos") |
| Fallback `product.media` | Featured + 4 Medientypen inline, **pro Variante** | Featured: 1 Aufruf pro Variante. `product.media` wird **einmal pro Produkt** gerendert (Memo, §5.4) |

**Strenge-Regel für `vg.value`-Einträge:** Bisher emittierten die `vg.value`-Schleifen nur `image`- und `video`-Einträge; der Snippet kennt auch `external_video`/`model`. Laut Kommentar im Block liefert `list.file_reference` diese Typen nie — trotzdem rendern die Aufrufer im Order-Pfad (file-Zweig) und im Order-Tail **nur** bei `item.media_type == 'image' or item.media_type == 'video'`, damit das Verhalten auch für den Fall, dass Shopify das ändert, identisch bleibt. Die Default-Pässe filtern ohnehin schon nach Typ.

### 5.3 Verhaltens-Äquivalenz im Detail

| Detail | Vorher | Nachher | gleich? |
|---|---|---|---|
| Bild `src_800` leer → nicht emittieren | `if cp_src != blank` | Snippet gibt nichts aus, Aufrufer prüft `cp_o != blank` | ja |
| Featured-Bild: keine `cp_src`-Prüfung, `w`/`h` = `vfi.width/height` | | `kind: 'image'` → Bild-Zweig mit Prüfung; `w` = `vfi.preview_image.width \| default: vfi.width` | ja, solange `image_url` eines vorhandenen Bildes nie leer ist und `preview_image` eines Bildes das Bild selbst ist (dokumentiertes Shopify-Verhalten; **im Storefront-Check §9.3 verifizieren**) |
| Featured-Alt = `variant.title` (nicht `vfi.alt`) | | `alt` weglassen, `fb: variant.title` | ja |
| Video nur mit `preview_image` **und** `sources.size > 0` | | gleiche Bedingung im Snippet | ja |
| externes Video / Modell aus `product.media` nur mit `preview_image`; Modell nur mit GLB-Quelle | | gleich | ja |
| Externe URL: YouTube-Thumb `https://img.youtube.com/vi/<id>/hqdefault.jpg`, Vimeo `""` | | gleich, `"w":0,"h":0` als Literal statt `{{ 0 \| json }}` | ja |
| Metafeld-Modell: `"w":800,"h":800`, `thumb`=`poster`=Vorschau oder `""` | | gleich; `preview \| default: ''` im Snippet, damit ein fehlender Parameter nicht zu `null` wird | ja |
| Schlüssel und Reihenfolge der Schlüssel | | identisch (Anhang A) | ja |
| Escaping | `alt` mit `<`/`>` | **alle** Strings | `JSON.parse`-gleich, strenger |
| Whitespace in der Insel | Einrückungen | kompakter | `JSON.parse`-gleich |

### 5.4 Render-Kosten und das Fallback-Memo

**Problem:** Jedes `render` kostet einen isolierten Kontext plus `capture`/`split`. Der Fallback-Pfad (Variante ohne Metafelder — also der **häufigste** Fall: jedes Produkt, für das der Händler nichts in der App gepflegt hat) emittiert heute *pro Variante* alle `product.media`. Naiv umgebaut wären das bei 100 Varianten × 20 Medien 2 000 Renders pro Seitenaufruf.

**Lösung (Anhang B, Anfang):** Vor der Varianten-Schleife jedes `product.media` **einmal** rendern und in einen String `cp_fb` sammeln als `<media.id>` + `<` + `<JSON>` + `>`. Im Fallback pro Variante: `cp_fb | split: '>'`, je Stück `split: '<'` → Id und JSON; emittieren, wenn die Id nicht die des Featured-Bildes ist. Das ist sicher, **weil** die Snippet-Ausgabe nach §5.1(b) kein `<`/`>` enthalten kann — die Trennzeichen kollidieren nie mit Daten. Ids werden als Strings verglichen (`cp_vfi_id | append: ''`; ohne Featured-Bild `''`, was mit keiner Id übereinstimmt — wie bisher `blank`).

**Ergebnis:** Renders pro Seite ≈ `|product.media|` + `|variants|` (Featured) + Zahl der Metafeld-Einträge. Für 100 Varianten ohne Metafelder: ~120 statt 2 000. **Urteil:** vertretbar; die Metafeld-Pfade rendern pro Eintrag, aber dort sind es die Einträge, die der Händler ohnehin pro Variante gepflegt hat. Bitte nach dem Deploy einmal mit dem **Shopify Theme Inspector** (Chrome-Erweiterung, Liquid-Profil) ein Produkt mit vielen Varianten messen (§9.3).

**Beobachtung, nicht anfassen:** Der heutige Fallback vergleicht `media.id` (Media-Id) mit `variant.featured_image.id` (Image-Id). Laut [cp-localized-image.liquid](../../extensions/storefront/snippets/cp-localized-image.liquid) sind das *verschiedene* Zahlen für dasselbe Bild — die Dedup greift also vermutlich nie, und das Featured-Bild erscheint im Fallback doppelt. Der Umbau **übernimmt genau diesen Vergleich**; eine Korrektur wäre eine sichtbare Änderung und gehört in einen eigenen Schritt (§8).

### 5.5 Ersparnis und Warnungen (gemessen am Prototyp)

| | vorher | nachher |
|---|---:|---:|
| variant-gallery-embed.liquid (minifiziert) | 36 750 | **14 725** |
| snippets/cp-vg-item.liquid (minifiziert, neu) | — | **2 845** |
| **netto** | | **−19 180 B** |
| Näherungs-Complexity Embed | 122 | **89** |
| Näherungs-Complexity Snippet | — | 18 |
| maximale Verschachtelung Embed | 11 | **8** (`capture` › `for variant` › `if order` › `for entry` › `if file` › `for item` › `if id` › `if media_type`) |
| maximale Verschachtelung Snippet | — | 5 |

Beide Embed-Warnungen sollten damit verschwinden.

### 5.6 Neuer Test `tests/unit/variant-gallery-embed-snippet.test.ts`

Liquid lässt sich in Vitest nicht ausführen (kein Liquid-Renderer in den Abhängigkeiten). Der Test pinnt deshalb, was von außen prüfbar ist:

1. **Schlüssel-Vertrag:** Für jeden `type` aus §0.4 enthält `cp-vg-item.liquid` `"type":"<type>"` und jeden dort gelisteten Schlüssel als `"<key>":`. Die Tabelle steht einmal im Test als Konstante.
2. **Konsument liest nichts anderes:** Jede Eigenschaft, die `variant-gallery-embed.js` auf einem Galerie-Eintrag liest (`img.` / `item.` / `s.`-Zugriffe in den Render-Funktionen), steht in dieser Tabelle — per Regex `/\b(?:img|item|s)\.(\w+)/g` über den Datei-Abschnitt Z. 455–600 (Zeilen nicht hart kodieren: zwischen `_renderImage`/`_renderModel` o. ä. schneiden — Funktionsnamen im Test nachschlagen).
3. **Escape-Regel:** Der Snippet endet mit `replace: "<", "\u003c" | replace: ">", "\u003e"`; ein `"alt":` ohne vorheriges `| json` gibt es nicht.
4. **Annotation:** Anzahl `render 'cp-vg-item'` im Block === Anzahl `assign cp_o = cp_o | split: '-->' | last | split: '<!--' | first | strip`.
5. **Keine Rückkehr der Duplikate:** Der Block enthält **kein** `"type":` mehr (alle Objekt-Körper leben im Snippet), und das `<script type="application/json" id="cp-embed-data-{{ block.id }}">` umschließt ausschließlich `{{ cp_vg_json }}`.
6. **Platzhalter bleibt letztes Element** (Head-Invariante aus dem Block-Kommentar): `<cp-embed-gallery` steht nach dem `variant-gallery-embed.js`-`<script>` und vor `{%- endif -%}`.

**Optional, stärker:** ein Differenz-Rendertest mit `liquidjs` (neue devDependency — nur mit Zustimmung des Owners): alte Insel vs. neue Insel + Snippet über Fixtures (Bild/Video/ext. Video/Modell, mit und ohne `variant_gallery_order`, Dubletten, Vimeo, Alt mit `</script>`), Filter `image_url` als Stub, Vergleich per `JSON.parse` + `toEqual`. Dann den Plan-Satz „lässt sich nicht ausführen" im Testkopf streichen.

---

## 6. Schritt 4 — structured-data: eine Dedup-Akkumulation statt zwei

### 6.1 Änderung (Quelle Z. 649–690)

Heute existiert der Dedup-Körper (`v_needle_tok`, `unless v_seen_toks contains …`, zwei `append`) zweimal identisch — für `variant_gallery_order`-URLs und für `variant_external_videos`. Neu: beide Schleifen hängen nur noch an (`v_gallery_urls | append: v_tok | append: ','`, weiterhin nur bei `v_tok != blank`), und die Dedup passiert **einmal** beim Aufteilen:

```liquid
{%- assign v_gallery_toks = v_gallery_urls | split: ',' | uniq -%}
```

`v_seen_toks` entfällt ersatzlos; die zwei wiederholten `#`-Kommentare ebenso (der `{%- comment -%}`-Block über dem Abschnitt bekommt stattdessen einen Satz: „dedupliziert wird beim Split mit `uniq`, das die erste Fundstelle behält"). Der irreführende Satz „variant-gallery-embed.liquid uses this set" fällt weg (der Embed hat eigene Mengen).

### 6.2 Warum verhaltensgleich

- `uniq` behält die **erste** Fundstelle in Reihenfolge — exakt die Menge und Reihenfolge, die die heutige Akkumulation erzeugt.
- Leere Tokens kommen nicht hinein (Prüfung bleibt), Kommas in URLs sind durch `url_encode` ausgeschlossen (wie bisher).
- Die Emissions-Schleife (5er-Deckel, `cp-external-video`, `v_seen_ids` nach host|id) bleibt unverändert.
- Kosten: Der Zwischenstring enthält jetzt Dubletten (dieselbe URL an 100 Varianten ≈ 100 × URL-Länge, einige KB) — billiger als 100 `contains`-Scans über den wachsenden Seen-String.

### 6.3 Ersparnis und Warnung

26 159 → **25 183 B** (−976; nach Schritt 2 noch ~−200, weil die `#`-Kommentare dann ohnehin fielen). Complexity sinkt nur um ~4 — **die 146 > 120 bleiben**. Dafür Schritt 5.

### 6.4 Tests

[structured-data.service.test.ts](../../tests/unit/structured-data.service.test.ts) Z. 546–548 pinnt nur die beiden Metafeld-Namen — bleibt grün. Neuer Assertion-Satz im selben `describe`: `liquid` enthält `| split: ',' | uniq` und **nicht** mehr `v_seen_toks`.

---

## 7. Schritt 5 (optional) — Video-Abschnitt als Snippet, für die Complexity-Warnung

### 7.1 Wann

Nur wenn die `LiquidComplexity`-Warnung in structured-data verschwinden soll. Bytes bringt der Schritt nicht (±50 B). Die Warnung blockiert den Deploy nicht.

### 7.2 Änderung

- Quelle Z. 482–720 (der gesamte Block `{%- if want_video and request.page_type == 'product' and product -%}` … `{%- endif -%}`) wird zu:

  ```liquid
  {%- if want_video and request.page_type == 'product' and product -%}
    {%- render 'cp-sd-videos', product: product -%}
  {%- endif -%}
  ```

- Der Inhalt zwischen `if` und `endif` (inkl. aller Kommentare) wandert unverändert nach **`snippets/cp-sd-videos.liquid`**. Er benutzt außer `product` keine Variable des Blocks (geprüft: `v_desc`, `v_upload_override`, `v_upload_map`, `v_printed`, `v_seen_ids`, `v_gallery_urls` werden alle im Abschnitt selbst gesetzt; `want_video` bleibt im Block).
- Die Ausgabe sind `<script type="application/ld+json" data-contentpilot="video">`-Elemente, **direkt** ausgegeben (kein `capture`). Shopifys Snippet-Annotation landet dann als HTML-Kommentar zwischen den `<script>`-Elementen — harmlos für HTML, Crawler und den Crawl der App (der nach `data-contentpilot` sucht). JSON-LD bleibt server-gerendert.
- Näherungs-Complexity danach: Block 97, Snippet 59.

### 7.3 Tests, die angepasst werden müssen

- [structured-data.service.test.ts](../../tests/unit/structured-data.service.test.ts) Z. 494–585 (`describe` mit `uploadDate`, Dedup, Galerie, Duration, `enable_video`): die Konstante `liquid` dort auf `block + "\n" + snippet` umstellen (Snippet aus `extensions/storefront/snippets/cp-sd-videos.liquid` lesen). Die Assertion Z. 584–585 (`"id": "enable_video"`, `assign want_video = …`) muss weiter gegen den **Block** laufen.
- [seo-video-schema.test.ts](../../tests/unit/seo-video-schema.test.ts) Z. 116–135: ebenso Block + Snippet.
- Kommentarverweise nachziehen: [gallery-video-audit.server.ts](../../app/services/seo/gallery-video-audit.server.ts) Z. 23 (`structured-data.liquid, v_seen_ids` → `cp-sd-videos.liquid`); CLAUDE.md-Bullets „A video's `uploadDate`…" und „A gallery video is found…" erwähnen „the block" — nach dem Merge präzisieren.

---

## 8. Schritt 6 und 7 (optional, klein)

### 8.1 Schritt 6a — 404-Beacon nach `assets/seo-404.js` (−510 B)

- Neue Datei `extensions/storefront/assets/seo-404.js` mit exakt dem heutigen IIFE-Inhalt (structured-data Z. 771–784).
- Im Block Z. 769–785 ersetzen durch:

  ```liquid
  {%- if request.page_type == '404' -%}
  <script src="{{ 'seo-404.js' | asset_url }}" defer></script>
  {%- endif -%}
  ```

  (Muster wie `web-vitals.liquid`: `asset_url` + `defer`.)
- Verhaltensunterschied: Der Beacon feuert nach dem Parsen statt währenddessen — für eine 404-Zählung irrelevant; `location`/`referrer` sind identisch. Ein zusätzlicher (gecachter) Request nur auf 404-Seiten.

### 8.2 Schritt 6b — toter Zweig im Locale-Switcher (~−330 B Quelle, nach Schritt 2 ~−150 B)

Z. 267–279: Die Zweige `if country_display == 'flag_only'` und `else` berechnen `c_label_full` **identisch**. Durch einmal den Inhalt eines Zweigs ersetzen; den Kommentar Z. 264–266 behalten (er erklärt, warum `flag_only` trotzdem den vollen Text bekommt).

### 8.3 Schritt 7 — variant-gallery.liquid (−473 B)

Gleiches Muster wie Schritt 3(a): Z. 29 `<script type="application/json" id="cp-gallery-data-{{ block.id }}">` → `{%- capture cp_g_json -%}`, Z. 73 `</script>` → `{%- endcapture -%}` + `<script type="application/json" id="cp-gallery-data-{{ block.id }}">{{ cp_g_json }}</script>`. Kein Snippet: Dieser Block emittiert *kein* `"type"` und nutzt für `vg`-Bilder `variant.title` als Alt — eine Wiederverwendung von `cp-vg-item` würde das ändern.

---

## 9. Verifikation

### 9.1 Messen (vor jedem Commit)

```bash
npm run minify:blocks
```

Erwartete Summen (±1 %): nach Schritt 1 unverändert 98 082; nach 2 ≈ 90 030; nach 3 ≈ 70 850; nach 4 ≈ 70 490; nach 6 ≈ 69 830; nach 7 ≈ 69 360.

Die Zahlen in diesem Plan stammen aus Wegwerf-Skripten, die `minifyLiquid`/`scanRegions` aus `scripts/minify-liquid-blocks.mjs` direkt importieren, z. B.:

```bash
node -e "import('./scripts/minify-liquid-blocks.mjs').then(m=>{const fs=require('fs');const s=fs.readFileSync(process.argv[1],'utf8');console.log(Buffer.byteLength(m.minifyLiquid(s)))})" extensions/storefront/blocks/variant-gallery-embed.liquid
```

### 9.2 Tests

```bash
npm test -- tests/unit/minify-liquid-blocks.test.ts tests/unit/variant-gallery-embed-snippet.test.ts \
  tests/unit/structured-data.service.test.ts tests/unit/seo-video-schema.test.ts \
  tests/unit/external-video-parser-parity.test.ts tests/unit/extension-schema-hygiene.test.ts \
  tests/unit/localized-media-storefront.test.ts
npm test
```

`npm run typecheck` nur nötig, wenn ein Test als `.ts` neu entsteht (Schritt 3/5) — ja, also laufen lassen. Der Minifier ist `.mjs` und wird nicht typgeprüft.

Was die Tests **nicht** abdecken: Liquid-Ausführung. Deshalb §9.3.

### 9.3 Storefront-Check für den Owner (Dev-Shop, nach `npm run deploy -- -c dev --allow-updates`)

1. **Deploy-Ausgabe:** keine `LiquidNestingDepth`-/`LiquidComplexity`-Warnung für `variant-gallery-embed.liquid` (und für `structured-data.liquid`, falls Schritt 5 umgesetzt). Budgetzeile ≈ 69 KiB. Falls eine Warnung bleibt: Wert notieren und hier nachtragen.
2. **Embed-JSON:** Auf einer Produktseite im Quelltext (`view-source:`) `cp-embed-data-` suchen, Inhalt kopieren, in der Konsole `JSON.parse(document.getElementById('cp-embed-data-…').textContent)` — darf nicht werfen, und es darf **kein** `<!-- BEGIN app snippet` darin stehen.
3. **Vorher/Nachher-Vergleich (der eigentliche Äquivalenztest):** *Vor* dem Deploy auf dem Dev-Shop für die Produkte unten das Ergebnis von `JSON.stringify(JSON.parse(document.getElementById('cp-embed-data-…').textContent))` in eine Datei kopieren; nach dem Deploy dasselbe; die beiden Strings müssen gleich sein, abgesehen von `<`/`>` statt `<`/`>` (nach `JSON.parse` identisch, also auch im `stringify` identisch). Produkte:
   - a) Produkt **ohne** jegliche Varianten-Metafelder (Fallback-Pfad, mit Bildern, einem Video, einem YouTube-Media, einem 3D-Modell, falls vorhanden),
   - b) Varianten mit `variant_gallery` **ohne** Reihenfolge (Default-Pfad: Bilder vor Videos),
   - c) Varianten **mit** gespeicherter Reihenfolge im Image Manager (Bild, Video, YouTube-Link, Vimeo-Link, 3D-Modell gemischt) plus danach neu hinzugefügte Einträge (Tail-Pfade),
   - d) derselbe YouTube-Link an mehreren Varianten / doppelt in Reihenfolge und Liste (Dedup),
   - e) eine Variante, deren Titel `</script>` oder `<b>` enthält.
4. **Sichtprüfung:** Galerie wechselt beim Variantenwechsel, Thumbnails, Video spielt, YouTube/Vimeo-Embed lädt, 3D-Modell lädt, kein Aufblitzen der nativen Galerie beim Laden (FOUC).
5. **Theme Inspector:** Liquid-Profil eines Produkts mit vielen Varianten (≥ 50) vor und nach dem Deploy; die Renderzeit des Embed darf nicht spürbar steigen (Richtwert: < +20 ms).
6. **Falls Schritt 4/5:** Rich Results Test auf einem Produkt mit Galerie-YouTube-Video — weiterhin genau ein `VideoObject` pro Video, gleiche Anzahl wie vorher. Bei Schritt 5 zusätzlich: App → Strukturierte Daten → Crawl neu starten; `VideoObject` wird weiter als „von der App" erkannt.
7. **Falls Schritt 6a:** eine nicht existierende URL aufrufen → in der App unter SEO → 404 erscheint der Treffer.
8. **Verschachteltes `render`** (Snippet `cp-vg-item` rendert `cp-external-video`): Ist das in einer Theme-App-Extension nicht erlaubt, meldet der Deploy einen Fehler oder ein YouTube-Link aus Fall c) fehlt im JSON. **Fallback:** URL-Parsing zurück zum Aufrufer (die bisherigen 4 Zeilen `capture`/`split`) und dem Snippet `host:`/`xid:` übergeben statt `url:`; kostet ~+700 B.

### 9.4 Minifier-Bericht um Theme-Check-Metriken erweitern?

**Nein.** Die echte Metrik ist hier nicht verfügbar, der Näherungszähler liegt bei structured-data um ~10 daneben — eine Warnung aus `minify:blocks`, die nicht mit der des Deploys übereinstimmt, schafft falsche Sicherheit oder falschen Alarm. Die Autorität ist die Deploy-Ausgabe (§9.3 Punkt 1). Was der Bericht stattdessen bereits leistet, reicht: die Budgetzahl pro Datei.

---

## 10. Invarianten, die sich nicht ändern dürfen

1. `JSON.parse` der Embed-Insel liefert für jede Variante dieselbe Liste mit denselben Objekten in derselben Reihenfolge (einzige zulässige Abweichung auf Byte-Ebene: Whitespace und `\u003c`/`\u003e` statt `<`/`>`).
2. Die Insel-Id `cp-embed-data-{{ block.id }}`, der FOUC-Setter, die Prehide-Styles, die Reihenfolge der Head-Elemente und `<cp-embed-gallery>` als **letztes** Element im `if` bleiben unverändert.
3. Dedup-Regeln unverändert: Datei-Ids, URL-Tokens per `url_encode`, Modell-Tokens per `url_encode`; Default-Pfad „alle Bilder, dann alle Videos, dann URLs, dann Modelle".
4. Jeder `{% render %}`-Aufruf, dessen Ausgabe gecaptured wird, schneidet Shopifys Annotation mit `split: '-->' | last | split: '<!--' | first | strip` ab.
5. JSON-LD und OG-Tags bleiben server-gerendert; kein strukturiertes Datum wandert nach JS.
6. Nur `parseExternalVideoUrl` (TS) und `cp-external-video` (Liquid) parsen Video-URLs — `cp-vg-item` **ruft** den Snippet, kopiert ihn nicht ([external-video-parser-parity.test.ts](../../tests/unit/external-video-parser-parity.test.ts) bleibt unverändert grün).
7. Minifizierte Dateien werden nie committet; `blocks/` und `snippets/` bleiben kommentiert im Git.
8. Weiterhin genau **eine** Theme-App-Extension; neue Dateien liegen unter `extensions/storefront/`.
9. Structured-data: maximal 5 `VideoObject`s, Upload-Datum für Galerie-Videos nur aus dem Händler-Override, nie geschätzt.

## 11. Risiken

| Risiko | Wahrscheinlichkeit | Folge | Gegenmaßnahme |
|---|---|---|---|
| Annotation landet in der Insel (falsches Abschneiden) | niedrig | **gesamte** Galerie fällt aus (`JSON.parse` wirft, Controller loggt Fehler, native Galerie bleibt sichtbar — kein kaputter Shop) | Escape-Regel §5.1(b) macht das Abschneiden beweisbar sicher; Test §5.6 Punkt 4; Storefront-Check §9.3 Punkt 2 |
| Verschachteltes `render` nicht erlaubt | niedrig | YouTube/Vimeo-Links fehlen | §9.3 Punkt 8, Fallback dokumentiert |
| Featured-Bild über `preview_image`/`cp_src`-Prüfung verhält sich anders als `vfi.width` | sehr niedrig | `w`/`h` anders → nur Seitenverhältnis-Reservierung | §9.3 Punkt 3 vergleicht genau das |
| Render-Kosten auf Produkten mit vielen Varianten | mittel bei Metafeld-Pfaden | langsamere Seitenauslieferung | Fallback-Memo §5.4; Theme Inspector §9.3 Punkt 5 |
| `{% liquid %}`-Minifizierung entfernt eine Zeile, die kein Kommentar war | sehr niedrig | Logik fehlt | nur Zeilen, die mit `#` *beginnen*; nie die letzte Zeile; Tests §4.3; Idempotenz- und Region-Tests über alle echten Blöcke |
| Kommentar-Emulation trimmt zu viel | niedrig | Leerzeichen zwischen Inline-Elementen fehlt | nur direkt angrenzendes `plain`-Segment, nur ASCII-Whitespace — exakt Liquid; jede Änderung macht die Ausgabe **näher** am echten Rendering |
| `uniq` verhält sich anders als die Seen-Menge | sehr niedrig | doppeltes/fehlendes VideoObject | §6.2; Rich Results Test §9.3 Punkt 6 |

## 12. Außerhalb des Umfangs

- JSON-LD, OG-Tags oder Galerie-Daten clientseitig erzeugen (§1.2).
- Den Featured-Bild-Dedup im Fallback korrigieren (Media-Id vs. Image-Id, §5.4) — sichtbare Änderung, eigener Schritt mit eigener Messung.
- Locale-Switcher: Flaggen-Auflösung Stufe 2–5 nach `locale-switcher.js` (~1,3 KB). Möglich, weil Flaggen nur mit JS sichtbar sind, aber nach Schritt 1–4 ist der Puffer > 30 KiB und das Risiko (zweite Implementierung der Zuordnung, Änderungen an 30 KB JS) lohnt nicht.
- `{% schema %}`-`info`-Texte kürzen (händlersichtbar im Theme-Editor).
- Inline-FOUC-Setter, Prehide-Styles, Layout-Shift-Guard auslagern (müssen pre-paint laufen, §1.2).
- Minifier-Variante „Inneres von JSON-Inseln minifizieren" (gemessen: −14,6 KB auf dem heutigen Stand). Nach Schritt 3/7 bleiben in Inseln nur noch ~6 KB JSON-LD-Gerüst (−0,7 KB möglich); der Gewinn rechtfertigt nicht, eine semantische Annahme („Ausgabe ist gültiges JSON") in den Minifier zu holen.
- `variant-gallery.liquid` auf `cp-vg-item` umstellen (anderes Alt-Verhalten, kein `type`).
- Theme-Check-Metriken im `minify:blocks`-Bericht (§9.4).
- CLAUDE.md selbst — die nötigen Korrekturen stehen in §4.4 und §7.3 und werden mit dem jeweiligen Merge gemacht.

## 13. Öffentlicher Guide

**Kein Update nötig.** Keine Änderung ist für Händler sichtbar: gleiche Galerie, gleiche Daten, gleiche Einstellungen, gleiche strukturierte Daten. (Ausnahme nur, falls jemand später den Featured-Bild-Dedup korrigiert — das wäre sichtbar und bekäme dann eine Zeile im Galerie-Thema.)

---

## Anhang A — `snippets/cp-vg-item.liquid` (Prototyp, gemessen)

Der Docstring ist hier gekürzt; im echten Snippet ausformulieren: Zweck, Parameter-Tabelle aus §5.1, die Escape-Regel und warum sie das Annotation-Abschneiden sicher macht, die Strenge-Regel aus §5.2, Hinweis auf `cp-external-video` als einzigen URL-Parser.

```liquid
{%- comment -%}
  ONE entry of the variant-gallery-embed JSON island, printed as a JSON object,
  or NOTHING when the entry would not have been emitted before. (Docstring: see
  PLAN_STOREFRONT_LIQUID_BUDGET §5.1 — parameters, escape rule, strictness rule.)
{%- endcomment -%}
{%- capture cp_i_out -%}
  {%- assign cp_i_alt = alt | default: fb | json -%}
  {%- assign cp_i_kind = kind | default: m.media_type -%}
  {%- if url != blank -%}
    {%- capture cp_i_pair -%}{%- render 'cp-external-video', url: url -%}{%- endcapture -%}
{%- assign cp_i_pair = cp_i_pair | split: '-->' | last | split: '<!--' | first | strip -%}
    {%- assign cp_i_host = cp_i_pair | split: '|' | first | default: '' -%}
    {%- assign cp_i_id = cp_i_pair | split: '|' | last | default: '' -%}
    {%- if cp_i_host != blank and cp_i_id != blank -%}
      {%- assign cp_i_thumb = '' -%}
      {%- if cp_i_host == 'youtube' -%}
        {%- assign cp_i_thumb = 'https://img.youtube.com/vi/' | append: cp_i_id | append: '/hqdefault.jpg' -%}
      {%- endif -%}
      {"type":"external_video","thumb":{{ cp_i_thumb | json }},"poster":{{ cp_i_thumb | json }},"w":0,"h":0,"alt":{{ cp_i_alt }},"host":{{ cp_i_host | json }},"external_id":{{ cp_i_id | json }}}
    {%- endif -%}
  {%- elsif model != blank -%}
    {%- assign cp_i_pv = preview | default: '' -%}
    {"type":"model","thumb":{{ cp_i_pv | json }},"poster":{{ cp_i_pv | json }},"w":800,"h":800,"alt":{{ cp_i_alt }},"model_src":{{ model | json }}}
  {%- elsif cp_i_kind == 'image' -%}
    {%- assign cp_i_src = m | image_url: width: 800 -%}
    {%- if cp_i_src != blank -%}
      {%- assign cp_i_w = m.preview_image.width | default: m.width -%}
      {%- assign cp_i_h = m.preview_image.height | default: m.height -%}
      {"type":"image","src_400":{{ m | image_url: width: 400 | json }},"src_800":{{ cp_i_src | json }},"src_1200":{{ m | image_url: width: 1200 | json }},"thumb":{{ m | image_url: width: 160 | json }},"w":{{ cp_i_w | json }},"h":{{ cp_i_h | json }},"alt":{{ cp_i_alt }}}
    {%- endif -%}
  {%- elsif m.preview_image != blank -%}
    {%- assign cp_i_pi = m.preview_image -%}
    {%- capture cp_i_media -%}"thumb":{{ cp_i_pi | image_url: width: 160 | json }},"poster":{{ cp_i_pi | image_url: width: 1200 | json }},"w":{{ cp_i_pi.width | json }},"h":{{ cp_i_pi.height | json }},"alt":{{ cp_i_alt }}{%- endcapture -%}
    {%- if cp_i_kind == 'video' and m.sources.size > 0 -%}
      {"type":"video",{{ cp_i_media }},"sources":[
      {%- for s in m.sources -%}
        {%- unless forloop.first %},{% endunless -%}
        {"src":{{ s.url | json }},"mime":{{ s.mime_type | json }}}
      {%- endfor -%}
      ]}
    {%- elsif cp_i_kind == 'external_video' -%}
      {"type":"external_video",{{ cp_i_media }},"host":{{ m.host | json }},"external_id":{{ m.external_id | json }}}
    {%- elsif cp_i_kind == 'model' -%}
      {%- assign cp_i_glb = blank -%}
      {%- for s in m.sources -%}
        {%- assign cp_i_fmt = s.format | downcase -%}
        {%- if cp_i_fmt == 'glb' and cp_i_glb == blank -%}{%- assign cp_i_glb = s.url -%}{%- endif -%}
      {%- endfor -%}
      {%- if cp_i_glb != blank -%}
        {"type":"model",{{ cp_i_media }},"model_src":{{ cp_i_glb | json }}}
      {%- endif -%}
    {%- endif -%}
  {%- endif -%}
{%- endcapture -%}
{{- cp_i_out | replace: "<", "\u003c" | replace: ">", "\u003e" -}}
```

Hinweis zum Video-Zweig: Die Bedingung des Originals ist `preview_image != blank and sources.size > 0`. Hier steht `preview_image != blank` außen und `sources.size > 0` innen — gleiche Wirkung.

## Anhang B — neue JSON-Insel im Embed (ersetzt Quelle Z. 55–603)

Kommentare hier gekürzt: **alle bestehenden `{%- comment -%}`-Blöcke an ihren Stellen übernehmen** (sie kosten nach Teil (a) keine Bytes mehr). Neu kommentieren: das Fallback-Memo (§5.4, inkl. warum `<`/`>` als Trenner sicher sind) und das Aufrufer-Muster (§5.1 c).

```liquid
{%- comment -%} Fallback memo: every product.media rendered ONCE per product (§5.4). {%- endcomment -%}
{%- assign cp_fb = '' -%}
{%- for media in product.media -%}
  {%- capture cp_o -%}{%- render 'cp-vg-item', m: media, alt: media.alt, fb: product.title -%}{%- endcapture -%}
{%- assign cp_o = cp_o | split: '-->' | last | split: '<!--' | first | strip -%}
  {%- if cp_o != blank -%}{%- assign cp_fb = cp_fb | append: media.id | append: '<' | append: cp_o | append: '>' -%}{%- endif -%}
{%- endfor -%}
{%- capture cp_vg_json -%}
  {
    {%- for variant in product.variants -%}
      {%- assign vg = variant.metafields.custom.variant_gallery -%}
      {%- assign cp_order_mf = variant.metafields.custom.variant_gallery_order -%}
      {%- assign cp_models_mf = variant.metafields.custom.variant_3d_models -%}
      {%- assign cp_previews_mf = variant.metafields.custom.variant_3d_previews -%}
      "{{ variant.id }}": [
        {%- assign cp_has_any = false -%}
        {%- assign cp_seen_file_ids = ',' -%}
        {%- assign cp_seen_urls = ',' -%}
        {%- assign cp_seen_models = ',' -%}
        {%- assign cp_has_vg     = false -%}
        {%- assign cp_has_models = false -%}
        {%- if vg != blank and vg.value != blank -%}{%- assign cp_has_vg = true -%}{%- endif -%}
        {%- if cp_models_mf != blank and cp_models_mf.value != blank -%}{%- assign cp_has_models = true -%}{%- endif -%}
        {%- if cp_order_mf != blank and cp_order_mf.value != blank -%}
          {%- if variant.featured_image != blank -%}
            {%- assign vfi = variant.featured_image -%}
            {%- assign vfi_id_str = vfi.id | append: '' -%}
            {%- assign cp_seen_file_ids = cp_seen_file_ids | append: vfi_id_str | append: ',' -%}
            {%- capture cp_o -%}{%- render 'cp-vg-item', m: vfi, kind: 'image', fb: variant.title -%}{%- endcapture -%}
{%- assign cp_o = cp_o | split: '-->' | last | split: '<!--' | first | strip -%}
            {%- if cp_o != blank -%}{%- if cp_has_any %},{% endif -%}{{ cp_o }}{%- assign cp_has_any = true -%}{%- endif -%}
          {%- endif -%}
          {%- for entry in cp_order_mf.value -%}
            {%- assign cp_rm = '' -%}
            {%- assign cp_ru = '' -%}
            {%- assign cp_rmod = '' -%}
            {%- assign cp_rpv = '' -%}
            {%- assign entry_val = entry.value | append: '' -%}
            {%- if entry.kind == 'file' -%}
              {%- assign needle = ',' | append: entry_val | append: ',' -%}
              {%- if cp_seen_file_ids contains needle -%}{%- continue -%}{%- endif -%}
              {%- for item in vg.value -%}
                {%- assign item_id_str = item.id | append: '' -%}
                {%- if item_id_str == entry_val -%}
                  {%- assign cp_seen_file_ids = cp_seen_file_ids | append: entry_val | append: ',' -%}
                  {%- if item.media_type == 'image' or item.media_type == 'video' -%}{%- assign cp_rm = item -%}{%- endif -%}
                  {%- break -%}
                {%- endif -%}
              {%- endfor -%}
            {%- elsif entry.kind == 'url' -%}
              {%- assign url_token = entry_val | url_encode -%}
              {%- assign url_needle = ',' | append: url_token | append: ',' -%}
              {%- if cp_seen_urls contains url_needle -%}{%- continue -%}{%- endif -%}
              {%- assign cp_seen_urls = cp_seen_urls | append: url_token | append: ',' -%}
              {%- assign cp_ru = entry_val | strip -%}
            {%- elsif entry.kind == 'model' -%}
              {%- assign model_token = entry_val | url_encode -%}
              {%- assign model_needle = ',' | append: model_token | append: ',' -%}
              {%- if cp_seen_models contains model_needle -%}{%- continue -%}{%- endif -%}
              {%- assign cp_seen_models = cp_seen_models | append: model_token | append: ',' -%}
              {%- assign cp_rmod = entry_val | strip -%}
              {%- if cp_previews_mf != blank and cp_previews_mf.value != blank and cp_models_mf != blank and cp_models_mf.value != blank -%}
                {%- for cp_m_url in cp_models_mf.value -%}
                  {%- if cp_m_url == cp_rmod -%}
                    {%- assign cp_rpv = cp_previews_mf.value[forloop.index0] | default: '' -%}
                    {%- break -%}
                  {%- endif -%}
                {%- endfor -%}
              {%- endif -%}
            {%- endif -%}
            {%- capture cp_o -%}{%- render 'cp-vg-item', m: cp_rm, url: cp_ru, model: cp_rmod, preview: cp_rpv, alt: cp_rm.alt, fb: variant.title -%}{%- endcapture -%}
{%- assign cp_o = cp_o | split: '-->' | last | split: '<!--' | first | strip -%}
            {%- if cp_o != blank -%}{%- if cp_has_any %},{% endif -%}{{ cp_o }}{%- assign cp_has_any = true -%}{%- endif -%}
          {%- endfor -%}
          {%- if vg != blank and vg.value != blank -%}
            {%- for item in vg.value -%}
              {%- assign item_id_str = item.id | append: '' -%}
              {%- assign tail_needle = ',' | append: item_id_str | append: ',' -%}
              {%- if cp_seen_file_ids contains tail_needle -%}{%- continue -%}{%- endif -%}
              {%- assign cp_seen_file_ids = cp_seen_file_ids | append: item_id_str | append: ',' -%}
              {%- if item.media_type == 'image' or item.media_type == 'video' -%}
                {%- capture cp_o -%}{%- render 'cp-vg-item', m: item, alt: item.alt, fb: variant.title -%}{%- endcapture -%}
{%- assign cp_o = cp_o | split: '-->' | last | split: '<!--' | first | strip -%}
                {%- if cp_o != blank -%}{%- if cp_has_any %},{% endif -%}{{ cp_o }}{%- assign cp_has_any = true -%}{%- endif -%}
              {%- endif -%}
            {%- endfor -%}
          {%- endif -%}
          {%- assign cp_tail_extvids = variant.metafields.custom.variant_external_videos -%}
          {%- if cp_tail_extvids != blank and cp_tail_extvids.value != blank -%}
            {%- for cp_url_raw in cp_tail_extvids.value -%}
              {%- assign cp_url = cp_url_raw | strip -%}
              {%- assign url_tail_token = cp_url | url_encode -%}
              {%- assign url_tail_needle = ',' | append: url_tail_token | append: ',' -%}
              {%- if cp_seen_urls contains url_tail_needle -%}{%- continue -%}{%- endif -%}
              {%- assign cp_seen_urls = cp_seen_urls | append: url_tail_token | append: ',' -%}
              {%- capture cp_o -%}{%- render 'cp-vg-item', url: cp_url, fb: variant.title -%}{%- endcapture -%}
{%- assign cp_o = cp_o | split: '-->' | last | split: '<!--' | first | strip -%}
              {%- if cp_o != blank -%}{%- if cp_has_any %},{% endif -%}{{ cp_o }}{%- assign cp_has_any = true -%}{%- endif -%}
            {%- endfor -%}
          {%- endif -%}
          {%- if cp_models_mf != blank and cp_models_mf.value != blank -%}
            {%- for cp_model_url_raw in cp_models_mf.value -%}
              {%- assign cp_model_url = cp_model_url_raw | strip -%}
              {%- assign model_tail_token = cp_model_url | url_encode -%}
              {%- assign model_tail_needle = ',' | append: model_tail_token | append: ',' -%}
              {%- if cp_seen_models contains model_tail_needle -%}{%- continue -%}{%- endif -%}
              {%- assign cp_seen_models = cp_seen_models | append: model_tail_token | append: ',' -%}
              {%- assign cp_model_preview = '' -%}
              {%- if cp_previews_mf != blank and cp_previews_mf.value != blank -%}
                {%- assign cp_model_preview = cp_previews_mf.value[forloop.index0] | default: '' -%}
              {%- endif -%}
              {%- capture cp_o -%}{%- render 'cp-vg-item', model: cp_model_url, preview: cp_model_preview, fb: variant.title -%}{%- endcapture -%}
{%- assign cp_o = cp_o | split: '-->' | last | split: '<!--' | first | strip -%}
              {%- if cp_o != blank -%}{%- if cp_has_any %},{% endif -%}{{ cp_o }}{%- assign cp_has_any = true -%}{%- endif -%}
            {%- endfor -%}
          {%- endif -%}
        {%- elsif cp_has_vg or cp_has_models -%}
          {%- if variant.featured_image != blank -%}
            {%- capture cp_o -%}{%- render 'cp-vg-item', m: variant.featured_image, kind: 'image', fb: variant.title -%}{%- endcapture -%}
{%- assign cp_o = cp_o | split: '-->' | last | split: '<!--' | first | strip -%}
            {%- if cp_o != blank -%}{%- if cp_has_any %},{% endif -%}{{ cp_o }}{%- assign cp_has_any = true -%}{%- endif -%}
          {%- endif -%}
          {%- for item in vg.value -%}
            {%- if item.media_type == 'image' -%}
              {%- capture cp_o -%}{%- render 'cp-vg-item', m: item, alt: item.alt, fb: variant.title -%}{%- endcapture -%}
{%- assign cp_o = cp_o | split: '-->' | last | split: '<!--' | first | strip -%}
              {%- if cp_o != blank -%}{%- if cp_has_any %},{% endif -%}{{ cp_o }}{%- assign cp_has_any = true -%}{%- endif -%}
            {%- endif -%}
          {%- endfor -%}
          {%- for item in vg.value -%}
            {%- if item.media_type == 'video' -%}
              {%- capture cp_o -%}{%- render 'cp-vg-item', m: item, alt: item.alt, fb: variant.title -%}{%- endcapture -%}
{%- assign cp_o = cp_o | split: '-->' | last | split: '<!--' | first | strip -%}
              {%- if cp_o != blank -%}{%- if cp_has_any %},{% endif -%}{{ cp_o }}{%- assign cp_has_any = true -%}{%- endif -%}
            {%- endif -%}
          {%- endfor -%}
          {%- assign cp_extvids = variant.metafields.custom.variant_external_videos -%}
          {%- if cp_extvids != blank and cp_extvids.value != blank -%}
            {%- for cp_url_raw in cp_extvids.value -%}
              {%- assign cp_url = cp_url_raw | strip -%}
              {%- capture cp_o -%}{%- render 'cp-vg-item', url: cp_url, fb: variant.title -%}{%- endcapture -%}
{%- assign cp_o = cp_o | split: '-->' | last | split: '<!--' | first | strip -%}
              {%- if cp_o != blank -%}{%- if cp_has_any %},{% endif -%}{{ cp_o }}{%- assign cp_has_any = true -%}{%- endif -%}
            {%- endfor -%}
          {%- endif -%}
          {%- if cp_models_mf != blank and cp_models_mf.value != blank -%}
            {%- for cp_model_url_raw in cp_models_mf.value -%}
              {%- assign cp_model_url = cp_model_url_raw | strip -%}
              {%- assign cp_model_preview = '' -%}
              {%- if cp_previews_mf != blank and cp_previews_mf.value != blank -%}
                {%- assign cp_model_preview = cp_previews_mf.value[forloop.index0] | default: '' -%}
              {%- endif -%}
              {%- capture cp_o -%}{%- render 'cp-vg-item', model: cp_model_url, preview: cp_model_preview, fb: variant.title -%}{%- endcapture -%}
{%- assign cp_o = cp_o | split: '-->' | last | split: '<!--' | first | strip -%}
              {%- if cp_o != blank -%}{%- if cp_has_any %},{% endif -%}{{ cp_o }}{%- assign cp_has_any = true -%}{%- endif -%}
            {%- endfor -%}
          {%- endif -%}
        {%- endif -%}
        {%- unless cp_has_any -%}
          {%- assign cp_vfi_id = '' -%}
          {%- if variant.featured_image != blank -%}
            {%- capture cp_o -%}{%- render 'cp-vg-item', m: variant.featured_image, kind: 'image', fb: variant.title -%}{%- endcapture -%}
{%- assign cp_o = cp_o | split: '-->' | last | split: '<!--' | first | strip -%}
            {%- if cp_o != blank -%}{%- if cp_has_any %},{% endif -%}{{ cp_o }}{%- assign cp_has_any = true -%}{%- endif -%}
            {%- assign cp_vfi_id = variant.featured_image.id -%}
          {%- endif -%}
          {%- assign cp_vfi_key = cp_vfi_id | append: '' -%}
          {%- assign cp_fb_items = cp_fb | split: '>' -%}
          {%- for cp_fb_item in cp_fb_items -%}
            {%- assign cp_fb_id = cp_fb_item | split: '<' | first -%}
            {%- if cp_fb_id != cp_vfi_key -%}{%- if cp_has_any %},{% endif -%}{{ cp_fb_item | split: '<' | last }}{%- assign cp_has_any = true -%}{%- endif -%}
          {%- endfor -%}
        {%- endunless -%}
      ]{% unless forloop.last %},{% endunless %}
    {%- endfor -%}
  }
{%- endcapture -%}
<script type="application/json" id="cp-embed-data-{{ block.id }}">{{ cp_vg_json }}</script>
```

Hinweise für die Umsetzung:

- Im Order-Pfad ist `alt: cp_rm.alt` für URL-/Modell-Einträge `nil` (weil `cp_rm` `''` ist) → `fb: variant.title` greift, wie bisher bei URL und Modell.
- Das Memo steht **innerhalb** von `{%- if product != blank -%}` (Z. 44) und **vor** dem `capture`.
- `cp_vfi_id` wird jetzt mit `''` statt `blank` initialisiert, weil es danach per `append: ''` zum String wird; ohne Featured-Bild stimmt `''` mit keiner Media-Id überein — wie bisher.

## Anhang C — Entscheidungen nach dem Plan-Review (verbindlich, geht allem oben vor)

Ein unabhängiges Review hat den Plan mit Änderungen freigegeben. Wo Anhang C dem Text oben widerspricht, gilt Anhang C.

1. **Escape-Regel, byte-genau.** Die Ausgabe des Snippets endet mit `| replace: "<", "\u003c" | replace: ">", "\u003e"` — doppelte Anführungszeichen, Backslash, `u003c`/`u003e`, exakt wie heute im Embed. ACHTUNG: Werkzeuge können `\u003c` beim Schreiben zu `<` dekodieren. Nach jedem Schreiben mit `grep -c 'u003c'` prüfen. Der neue Test pinnt die exakten Bytes `\u003c`/`\u003e` und schlägt fehl, wenn Muster und Ersatz gleich sind.
2. **liquidjs-Differenztest ist Pflicht** (devDependency `liquidjs`, nur Tests). (a) Für Schritt 1+2: für jeden Block/jedes Snippet `render(source) === render(minify(source))` mit Stub-Kontext und Stub-Filtern (`image_url`, `asset_url`, `json` usw. als einfache Funktionen). (b) Für Schritt 3: alte Insel vs. neue Insel + Snippet über Fixtures (Produkt ohne Metafelder, mit Galerie-Reihenfolge, mit Video, mit externem Video, mit 3D-Modell, mit Alt-Text `</script><b>`), verglichen über `JSON.parse`. Vorher prüfen, dass liquidjs-`split` leere Endstücke wie Ruby verwirft; falls nicht, den Annotation-Schnitt im Test entsprechend stubben und das dokumentieren. Wo ein Shopify-Konstrukt in liquidjs nicht nachbildbar ist, im Test begründet überspringen, nicht stillschweigend.
3. **Schritt 3 in zwei Commits:** 3a = nur `capture`-Umzug (Ausgabe unverändert), 3b = Snippet + Memo.
4. **Verschachteltes Render absichern:** Das Snippet gibt ein `external_video`-Objekt nur aus, wenn `cp_i_host == 'youtube' or cp_i_host == 'vimeo'`. §9.3 Punkt 8 / §11 entsprechend.
5. **Tests in §5.6 korrigiert:** Test #2 nimmt eine explizite Liste der Eigenschaften, die `assets/variant-gallery-embed.js` liest (inkl. `thumb`; keine DOM-Aufrufe wie `img.decode`). Neuer Test: Aufrufer übergeben nur Parameter, die das Snippet kennt. Test #4 prüft, dass auf jede `capture` mit `render 'cp-vg-item'` direkt die Annotation-Schnitt-Zeile folgt.
6. **§3.3 Hilfsfunktion nicht auf `/\s+/g` lockern.** Erwartung durch Nachbilden des Liquid-Dash-Trims neben entfernten Kommentaren aufbauen (oder: Whitespace verschwindet nur neben entfernten `{%-`/`-%}`-Kommentaren).
7. **Fallback-Memo lazy:** erst beim ersten Varianten-Fallback aufbauen (Flag).
8. **Leerer Platzhalter `nil`** statt `''`.
9. **§9.3 Punkt 5:** auch auf "Memory limits exceeded" achten (100 Varianten × ~20 Medien im Fallback).
10. **`minifyLiquidTag`:** `\r` mit entfernen; Idempotenz-Test.
11. **CLAUDE.md im selben Commit wie Schritt 2** anpassen (Deploy-Gotcha zum Minifier), nicht erst nach dem Merge. §4.4 ist damit überholt.
12. Schritt-2-Ersparnis: −8 051 B (gemessen), nicht 7,4 KB.
13. **Bewusste Abweichung (Schritt 3b):** Ein `variant.featured_image` ohne URL erzeugt keinen Eintrag mehr (früher einen Bild-Eintrag mit leerem `src`); das Snippet gibt für ein Bild ohne URL nichts aus, und ein Eintrag ohne Bild nützt der Galerie nicht. Der Differenztest bildet das als einzigen erwarteten Unterschied ab (Variante 9011 im Review-Harness). Nebenwirkung: Setzt der Eintrag nicht mehr `cp_has_any`, fällt eine Variante mit URL-losem `featured_image` **und** URL-loser Galerie jetzt in den `product.media`-Fallback (sie bekommt die Galerie aller verwendbaren Produktmedien statt eines einzelnen kaputten Bildes). Gepinnt im Test `variant with a URL-less featured image and a URL-less gallery (9011)` in `variant-gallery-embed-snippet.test.ts`, mit dem erwarteten Unterschied ausdrücklich im Test (frozen: ein Eintrag mit leerem `src`; neu: Fallback-Liste).

**Umfang:** Schritte 1, 2, 3a, 3b, 6a, 6b, 7 werden umgesetzt. **Schritt 4 entfällt** (nach Schritt 2 nur ~200 B, berührt JSON-LD). **Schritt 5 wird zurückgestellt** (nur Warnung; Snippet-in-Snippet auf JSON-LD erst nach Bewährung von 3b im Dev-Shop). Die Complexity-Warnung in `structured-data.liquid` bleibt damit bewusst bestehen.

14. **Äußere Insel-`capture` entfernt, Minifier erreicht `application/json`-Inseln (nach dem Abschlussreview).** Das `capture` um die JSON-Insel (Schritt 3a im Embed, Schritt 7 in `variant-gallery.liquid`) vervielfachte Shopifys Liquid-Speicherscore (Ruby `cumulative_assign_score`; jedes in ein `capture` geschriebene Byte zählt, verschachtelte Captures erneut, direkte Ausgabe nicht). Es war nur eingeführt worden, damit der Minifier das Innere erreicht (er lässt `<script>`-Inhalte unverändert). Entscheidung: beide äußeren Captures entfallen, die Liquid-Logik steht wieder direkt im `<script type="application/json" id="…">`, und der Minifier minimiert das Innere von `<script type="application/json">` selbst (genau dieser Typ, Attributreihenfolge/Quoting egal; nicht `ld+json`, nicht JS, nicht `<style>`). Regeln im Inneren: dieselben wie für Plain-Segmente (Kommentare mit Dash-Replay und Inline-Kommentar-Fallback, `{% liquid %}`-Tags) plus Einrückung und **alle** Leerzeilen weg; Zeilen werden nie verbunden; Bytes in `{% %}`/`{{ }}` (auch mehrzeilig) bleiben unangetastet; ein nicht sicher parsebarer Inhalt oder ein per Liquid gebauter Öffnungstag bleibt unverändert. Im Quelltext bleiben die Kommentare stehen (nach der Minifizierung kosten sie nichts).

    Gemessen mit `liquid` (Ruby) und dem Stress-Harness, `cumulative_assign_score` (Produkt ohne Galerie-Metafelder, 20 Medien × 100 Varianten):

    | Block | alt (a8da7d1) | mit äußerem Capture (HEAD davor) | ohne äußeres Capture (jetzt) |
    |---|---|---|---|
    | Embed, Fallback 20×100 | 227 010 | 1 204 365 | 109 327 |
    | Embed, Fallback 50×40 | 224 024 | 1 219 217 | 122 417 |
    | Embed, mit `variant_gallery` 20×100 | 554 065 | 2 901 974 | 1 752 261 |
    | variant-gallery, 20×100 | 16 749 | 75 362 | 16 749 |
    | variant-gallery, mit `variant_gallery` 20×100 | 562 275 | 1 753 128 | 562 275 |

    Minifizierte Größe: Embed 14 511 B (vorher 14 572), variant-gallery 6 087 B (vorher 6 146), Summe der Extension 67,8 KiB. Der Embed-Fall mit `variant_gallery` liegt auch jetzt über dem alten Wert, weil jedes Item über `capture cp_o` (Snippet-Annotation abschneiden) läuft; das ist der Preis aus Schritt 3b und bleibt eine offene Beobachtung für den echten Shopify-Deploy.
