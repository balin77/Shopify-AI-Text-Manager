# Interne Links per KI finden — Plan (Phasen 0–4)

**Status:** Entwurf 2026-10-29. Nichts gebaut, nichts gemessen. Der Ist-Zustand in §1 ist am 2026-10-29 gegen den Code verifiziert. Owner-Entscheid als Rahmen: **die Verbesserung läuft vollständig über KI — keine Regeln pro Sprache** (Shops können Hunderte Sprachen haben; Wortstämme, Komposita, Flexionstabellen pro Sprache sind ausgeschlossen). Offen und bewusst **nicht** entschieden: siehe §14.

Verwandte Dokumente: [PLAN_SEO_SUITE_COMPLETION.md](PLAN_SEO_SUITE_COMPLETION.md) §4 (der Ursprungsplan des heutigen Matchers), [PLAN_MANAGED_AI_KEY.md](PLAN_MANAGED_AI_KEY.md) (wessen Key eine KI-Anfrage bezahlt und wann sie verweigert wird), [KEYWORDS_CONTRACT.md](../architecture/KEYWORDS_CONTRACT.md) (Keyword-Zuordnungen pro Sprache).

---

## 0. Frage und Antwort in einem Satz

**Frage:** Der Scan unter SEO → Interne Links findet nur Stellen, an denen ein Produkt- oder Kollektionsname, ein zugeordnetes Keyword oder ein KI-Synonym **wortwörtlich** im Text steht — und nur in der Hauptsprache. Wie findet er auch „Glasvasen“ für das Produkt „Glasvase“, „die handgedrehte Schale aus Steinzeug“ für „Steinzeugschale Nr. 3“, und Erwähnungen in den übersetzten Texten?

**Antwort:** Die KI **wählt** im Text vorhandene Wortfolgen aus und ordnet sie einem Linkziel aus einer vorgegebenen, kurzen Kandidatenliste zu. Sie **schreibt nie** Text: der Server prüft jede Antwort gegen den Text (die Stelle muss buchstabengetreu in einem zulässigen Textknoten stehen), und eingefügt wird ausschließlich über den bestehenden Einfügeweg (`insertLinkIntoHtml`, cheerio, nur ein `<a>` um vorhandenen Text). Damit gilt für jede Sprache dieselbe Logik, ohne eine einzige Sprachregel.

---

## 1. Ist-Zustand (gegen den Code verifiziert)

| Was | Wo | Bedeutung für diesen Plan |
|---|---|---|
| Scan-Auslöser | Button „Vorschläge generieren“ auf [app.seo.internal-links.tsx](../../app/routes/app.seo.internal-links.tsx) → `/api/ai`, Aktion `seoInternalLinks` → [seo-internal-links.handler.ts](../../app/routes/api-ai-handlers/seo-internal-links.handler.ts) | Pro-Gate im Handler, Single-Flight über die `Task`-Zeile, losgelöster Runner. Bleibt der EINE Einstieg — keine neue Route (§10). |
| Matcher | `runInternalLinkSuggestions` / `matchSourceAgainstTargets` in [internal-links.service.ts](../../app/services/seo/internal-links.service.ts) | Ziele: ACTIVE-Produkte + alle Kollektionen (je max. `MAX_AUDIT_ITEMS_PER_TYPE` = 1000). Anker in Priorität Titel > Primär-Keyword > Sekundär-Keywords > Synonym. Regex mit Unicode-Wortgrenze `(?<=^|[^\p{L}\p{N}])…(?=$|[^\p{L}\p{N}])`, Groß/klein egal. Erster Treffer pro Ziel gewinnt. |
| Quellen | gleiche Datei | `Product.descriptionHtml`, `Article.body`, `Page.body` (DB-Cache, ohne Status-Filter). **Kollektionen sind KEINE Quelle**, obwohl [internal-links-routes.ts](../../app/services/seo/internal-links-routes.ts) sie im `RESOURCE_ROUTE` führt. |
| Sprache | gleiche Datei, Header „Locale rule“ | NUR Hauptsprache. Jede Zeile trägt `locale: ""`. Keywords werden auf `locale === ""` gefiltert (`keywordsByResource`). |
| Synonyme | `AIService.generateSynonymsBatch` ([ai.service.ts](../../src/services/ai.service.ts)) | 25 Begriffe pro Anfrage, max. 200 Ziele, pro Lauf flüchtig, abgelehnte Anker gehen als „nicht wiederholen“ in den Prompt und werden serverseitig herausgefiltert. Die Synonyme werden danach wieder **wortwörtlich** gesucht — eine Synonymliste trifft Flexionen nur zufällig. |
| Zulässige Textfläche | `collectTextNodes` | Textknoten außerhalb `a, h1–h6, script, style, title`. Dieselbe Regel für Suche und Einfügen — ein Treffer ist also garantiert einfügbar. |
| Grenzen | `MAX_SUGGESTIONS_PER_SOURCE` = 3, `MAX_PENDING_PER_SHOP` = 200 | Ist das Pending-Limit erreicht, werden echte Treffer dieses Laufs **verworfen** (`cappedByPendingLimit`) und beim nächsten Lauf neu gesucht. Für KI-Treffer wäre das bezahlte Arbeit im Müll (§6). |
| Persistenz | `SeoInternalLinkSuggestion` ([schema.prisma](../../prisma/schema.prisma)) | Unique `(shop, from…, to…, locale)` — die `locale`-Spalte existiert schon, wird aber nur mit `""` befüllt. Kein Feld für Herkunft, Kontext oder Match-Art. |
| Annehmen / Vorschau | [api.seo-internal-links.tsx](../../app/routes/api.seo-internal-links.tsx): `previewAccept`, `accept`, `acceptAll` (25 pro Klick) | `computeInsertion` liest den AKTUELLEN Inhalt aus dem DB-Cache, fügt per `insertLinkIntoHtml` ein (fehlt der Anker ⇒ `STALE`), speichert über `handleUnifiedContentActions` (`updateContent`, Hauptsprache). Vorschau `sanitizeHTML` auf beiden Seiten. |
| Übersetzungen mitführen | [internal-links-translate.server.ts](../../app/services/seo/internal-links-translate.server.ts), `carryLinkIntoTranslations` | Schon heute ein KI-Muster, das genau diesen Plan vorwegnimmt: `findLocalizedAnchors` bekommt den übersetzten Text und muss die Wortfolge **so zurückgeben, wie sie dort steht**; der Matcher prüft danach. Lokalisierter Pfad über `loadLocalePathPrefixes`, übersetzter Handle aus der Shopify-Übersetzung. Max. `MAX_CARRY_LOCALES` = 20. |
| KI-Schlüssel | `createAIService` in [shared.ts](../../app/routes/api-ai-handlers/shared.ts), `resolveAiCredentials` in [ai-credentials.server.ts](../../app/services/ai/ai-credentials.server.ts) | `seoInternalLinks` steht NICHT in `NON_AI_ACTIONS` von [api.ai.tsx](../../app/routes/api.ai.tsx) — ein Shop ohne KI-Zugang kann heute nicht einmal den KI-freien Wortlaut-Scan starten (siehe §16, Beobachtungen). |

**Was der Wortlaut-Matcher strukturell nicht kann** (gemessen ist das nicht — es folgt aus dem Regex):
1. Flexion und Plural: „Glasvasen“, „der Glasvase“ — die Wortgrenze verlangt das exakte Wort.
2. Komposita: „Vase“ in „Glasvase“ hat links einen Buchstaben ⇒ kein Treffer (gewollt), aber umgekehrt findet „Glasvase“ nie „Vasen aus Glas“.
3. Umschreibungen: „unsere handgedrehte Steinzeugschale“ für den Titel „Schale Nr. 3 — Steinzeug, matt“.
4. Andere Sprachen: übersetzte Bodies werden gar nicht gelesen.
5. Schriften ohne Leerzeichen (Chinesisch, Japanisch, Thai, …): die Wortgrenze `[^\p{L}\p{N}]` existiert dort im Fließtext kaum ⇒ praktisch nie ein Treffer, auch nicht wortwörtlich.

---

## 2. Ziele und Nicht-Ziele

**Ziele**
- Mehr **richtige** Vorschläge pro Text in jeder Sprache, ohne Sprachregeln: Flexion, Komposita, Umschreibungen, beliebige Schriften.
- Übersetzte Texte (globale Übersetzungsebene) als Quellen, mit Linkziel in derselben Sprache (übersetzter Handle, Sprachpräfix).
- Kosten vorher sichtbar, begrenzt und nur für geänderte Texte (Inkrementalität).
- Der Prüf- und Annahmefluss bleibt, wie er ist: Vorschau, Annehmen, Ablehnen, Alle annehmen, Übersetzungen mitführen.

**Nicht-Ziele**
- **KI schreibt keinen Text.** Kein „Satz umformulieren, damit ein Link passt“, keine neuen Absätze mit Links. Das wäre ein Inhaltsgenerator mit eigener Freigabe-, Übersetzungs- und Purge-Geschichte.
- Keine Regeln, Wortlisten, Stemmer oder Tokenizer pro Sprache (Owner-Entscheid). Erlaubt sind nur **sprachneutrale** Unicode-Eigenschaften (Schrift-Klassen, Buchstabe/Ziffer).
- Keine Embeddings / Vektor-DB (neue Infrastruktur, neuer Anbieter, neue Datenverarbeitung im Sinne der Datenschutzerklärung).
- Keine Markt-Ebene (`marketId`): Markt-Overrides werden weder gescannt noch beschrieben — dieselbe Grenze wie beim Mitführen.
- Keine automatische Anwendung. Vorschau + Bestätigung bleibt Pflicht (PLAN_SEO_SUITE_COMPLETION §„Keine Auto-Anwendung“).
- Kein unbeaufsichtigter Lauf in Phase 1–3 (kein Cron). Ein wöchentlicher Lauf nur für geänderte Texte ist §14-Frage und frühestens Phase 4.
- Keine neuen Linkziele: weiterhin nur Produkte und Kollektionen. Seiten/Artikel als Ziel ist ein eigener Schritt (§14).

---

## 3. Der Ablauf eines Laufs

```
Taste „Vorschläge generieren“
 ├─ Schritt 0  Schätzung (bereits vor dem Klick, §7.3)
 ├─ Schritt 1  Wortlaut-Durchgang (heutiger Matcher, kostenlos, Hauptsprache)
 ├─ Schritt 2  Texte bestimmen, die die KI sehen muss (Inkrementalität, §6)
 ├─ Schritt 3  Pro Text: Kandidatenliste vorauswählen (§5)
 ├─ Schritt 4  KI-Anfragen in Paketen (§4.3), Antwort = {Ziel-Kürzel, Wortfolge}
 ├─ Schritt 5  Server-Validierung jeder Antwort (§4.4) → Scan-Cache
 └─ Schritt 6  Vorschläge aus dem Cache in `SeoInternalLinkSuggestion` materialisieren (Caps, Ablehnungen)
```

Alles läuft im **bestehenden** `seoInternalLinks`-Task (Typ nicht umbenennen — laufende Tasks und Task-Zusammenfassungen in [task-details.shared.ts](../../app/services/tasks/task-details.shared.ts) hängen am Namen). Der Fortschritt zählt Texte, der Herzschlag bleibt `HEARTBEAT_EVERY_SOURCES`.

---

## 4. KI-Ankerfindung

### 4.1 Einheit der Arbeit: ein **Text**

Ein Text ist `(Quelltyp, Quell-ID, Sprache)`:
- Hauptsprache: `Product.descriptionHtml`, `Article.body`, `Page.body` (wie heute).
- Übersetzung (Phase 2): `ContentTranslation` mit `key = "body_html"`, `marketId = ""`, Wert nicht leer. Kein Live-Lesen von Shopify beim Scan (Kosten, Drosselung); der Spiegel ist die Quelle, Frische wird beim **Annehmen** live geprüft (§8.2).

Der KI wird **nicht** das HTML geschickt, sondern die zulässige Textfläche als nummerierte Segmente — ein Segment pro Textknoten aus `collectTextNodes` (sehr kurze Knoten werden für die Anzeige mit ihren Nachbarn zusammengezogen, behalten aber ihre Grenzen):

```
[S1] Unsere Vasen werden von Hand gedreht.
[S2] Besonders beliebt sind die Glasvasen in Rauchgrau, die …
```

Gründe: weniger Tokens (kein Markup), keine Chance, eine Stelle in einem Link, einer Überschrift oder einem Attribut zu wählen (sie sind gar nicht im Prompt), und die Antwort lässt sich einem Textknoten eindeutig zuordnen. Das ist dieselbe Überlegung, die `eligibleAnchorText` für `findLocalizedAnchors` schon begründet.

### 4.2 Die Kandidatenliste

Pro Text eine kurze Liste möglicher Linkziele, jedes mit einem **Kürzel** statt einer GID (`t1`, `t2`, …; die Zuordnung Kürzel→GID bleibt auf dem Server — eine erfundene GID ist damit unmöglich, ein erfundenes Kürzel trivial erkennbar):

```
t7  Glasvase „Rauch“            | Kollektion: Vasen | Keywords: Glasvase, Vase grau | „Mundgeblasene Vase aus Rauchglas, 30 cm …“
t12 Kollektion „Steinzeug“      | Keywords: Steinzeug Geschirr                    | „Handgedrehtes Steinzeug aus der Werkstatt …“
```

Felder pro Ziel, alle in der **Sprache des Textes** (Phase 2):
- Titel — Hauptsprache: `Product.title`/`Collection.title`; Übersetzung: `ContentTranslation(key "title", locale)`, sonst Haupttitel (Marken- und Produktnamen sind oft gleich).
- Keywords — `SeoKeywordAssignment` mit passender `locale` (Hauptsprache `""`), primär vor sekundär, max. 3.
- Kurzbeschreibung — die ersten ~120 Zeichen Klartext der Beschreibung (bzw. der Meta-Beschreibung, falls vorhanden), in der Textsprache wo übersetzt. Sie ist es, die „die handgedrehte Schale“ dem richtigen Produkt zuordnet.
- Handle wird **nicht** geschickt (kostet Tokens, hilft der Zuordnung kaum, und der Link wird ohnehin serverseitig gebaut).

### 4.3 Prompt, Antwortform, Pakete

Neue Methode `AIService.findLinkAnchorsBatch(texts, options)` in [ai.service.ts](../../src/services/ai.service.ts), Geschwister von `findLocalizedAnchors` und `generateSynonymsBatch` (gleiche Form: `sanitizePromptInput` auf jeden Text, `parseJSONResponse`, falsche Form ⇒ leeres Ergebnis + Warnung, nie ein Wurf, der den Lauf abbricht — **außer** einer Managed-Verweigerung, §7.2).

Anweisungen (sinngemäß, sprachneutral formuliert, Englisch wie alle Prompts in `ai.service.ts`):
- „Wähle Stellen, an denen der Text **über dieses Ziel spricht**. Kopiere die Wortfolge **zeichengenau** aus dem Segment, inklusive Beugung, Groß/Klein und Akzenten. Übersetze nichts, normalisiere nichts.“
- „Ganze Wörter, keine Wortteile — bei Schriften ohne Leerzeichen die kürzeste Folge, die das Ding benennt.“
- „Höchstens eine Stelle pro Ziel, höchstens N Stellen pro Text. Keine Stelle für Ziele, die im Text nicht vorkommen. Eine leere Liste ist eine richtige Antwort.“
- „Diese Wortfolgen hat der Händler für dieses Ziel abgelehnt: …“ (Ablehnungs-Rückkopplung wie heute, aber pro Text und Ziel).
- „Diese Ziele sind schon gefunden: …“ — die Wortlaut-Treffer aus Schritt 1, damit die KI keine Ausgabe-Tokens auf Bekanntes verwendet.

Antwort:

```json
{ "T3": [ { "t": "t7", "s": 2, "a": "Glasvasen in Rauchgrau", "r": 0.8 } ] }
```

`T3` = Text im Paket, `t` = Ziel-Kürzel, `s` = Segment, `a` = Wortfolge, `r` = Sicherheit 0–1 (nur zur Sortierung, nie als Freigabe).

**Pakete:** Kurze Texte (typische Produktbeschreibung < 1000 Zeichen) werden gebündelt, bis ein Paket ~6000 Zeichen Text + Kandidaten erreicht; jeder Text bringt seine eigene Kandidatenliste mit, gemeinsame Ziele werden im Paket nur einmal beschrieben. Lange Texte (Blogartikel) werden an Segmentgrenzen in Stücke à ~6000 Zeichen geteilt; jedes Stück ist eine eigene Anfrage mit derselben Kandidatenliste, die Ergebnisse werden zusammengeführt (ein Ziel pro Text gilt über alle Stücke). Die Planung als reine Funktion `planLinkScanBatches` analog zu `planLocaleChunks` in [translation-budget.shared.ts](../../app/services/ai/translation-budget.shared.ts), damit Schätzung (§7.3) und Lauf dieselben Pakete zählen.

Grobe Größe einer Anfrage: ~1,5k Tokens Text + ~1k Kandidaten (40 × ~25) + ~0,4k Anweisungen ≈ 3k Eingabe, ≤ 400 Ausgabe. Das ist eine **Annahme**, Phase 0 misst sie (§11).

### 4.4 Server-Validierung — die eigentliche Sicherung

Reines Modul `internal-links-ai.shared.ts` (neu, client-sicher, keine Server-Importe, damit es ohne DB getestet wird). Jede KI-Antwortzeile durchläuft in dieser Reihenfolge; jeder Ausfall wird mit **Grund** gezählt (§11):

| # | Prüfung | Grund-Code |
|---|---|---|
| 1 | Kürzel `t` steht in der Kandidatenliste DIESES Textes | `unknownTarget` |
| 2 | Segment `s` existiert | `unknownSegment` |
| 3 | `a` ist nicht leer, 2–80 Zeichen, enthält mindestens einen Buchstaben oder eine Ziffer (`\p{L}\p{N}`), keine Zeilenumbrüche | `badShape` |
| 4 | `a` steht **zeichengenau** im Segment (Groß/Klein-tolerant, aber der gespeicherte Anker ist die Originalschreibweise aus dem Text, wie `findFirstMatch` es heute macht); sonst Suche im ganzen Text, fallback nur auf ein anderes Segment, wenn dort genau EIN Vorkommen steht | `notInText` |
| 5 | Wortgrenzen: für Buchstaben aus Schriften mit Leerzeichen gilt die heutige Grenze; für Schriften ohne Wortabstand (Unicode-Script `Han`, `Hiragana`, `Katakana`, `Thai`, `Lao`, `Khmer`, `Myanmar`, `Tibetan`) entfällt sie an der jeweiligen Kante. Das ist eine Unicode-Eigenschaft, keine Sprachregel. | `partialWord` |
| 6 | Die Stelle liegt in einem zulässigen Textknoten (keine `<a>`, Überschrift, `script/style/title`; Attribute sind gar nicht Text) und überspannt keinen Knoten | `notEligible` |
| 7 | Quelle verlinkt das Ziel nicht schon (`isAlreadyLinked`, lokalisierte Pfade eingeschlossen) und Ziel ≠ Quelle | `alreadyLinked` |
| 8 | Ein Ziel pro Text (erster gültiger Treffer gewinnt, nach `r`), höchstens `MAX_SUGGESTIONS_PER_SOURCE` pro Text | `perTargetCap` / `perTextCap` |
| 9 | Dichte: nach Einfügen höchstens 1 Link je 300 Zeichen zulässiger Text (bestehende Links mitgezählt); gezählt in **Graphemen**, nicht Wörtern, damit es ohne Sprachwissen geht | `density` |
| 10 | Wortfolge wurde für (Quelle, Ziel, Sprache) abgelehnt | `rejected` |
| 11 | Probe-Einfügung: `insertLinkIntoHtml(html, a, href)` liefert `inserted: true` und das Ergebnis ist bis auf das neue `<a>` identisch (Textinhalt vorher/nachher gleich) | `insertFailed` |

Schritt 11 ist der Grund, warum §8 nichts Neues braucht: was die Validierung überlebt, ist exakt das, was „Annehmen“ später tut.

**Bekannte Lücke von #4/#11:** `insertLinkIntoHtml` verlinkt das **erste** Vorkommen im Dokument. Wählt die KI das zweite Vorkommen in Segment 7, wird beim Annehmen das erste in Segment 2 verlinkt. Für die Wirkung (ein Link aufs Ziel) gleichgültig, für die Vorschau korrekt, weil die Vorschau dieselbe Funktion nutzt. Ein Positions-Parameter für `insertLinkIntoHtml` ist bewusst nicht Teil dieses Plans (§14).

### 4.5 Was mit der Konfidenz passiert

`matchKind` bekommt den Wert `ai`. Basis 0,6, plus `0,3 × r` (gekappt), minus der heutige Positionsabzug. Wortlaut-Titeltreffer bleiben bei 0,95 und gewinnen jede Kollision (gleicher Unique-Key, §9). Die Liste sortiert weiter nach Konfidenz; ein „KI“-Abzeichen zeigt die Herkunft (§8.3).

---

## 5. Kandidaten-Vorauswahl (kleine Prompts ohne Embeddings)

Ein Shop mit 1000 Produkten kann nicht jedem Text 1000 Ziele mitgeben. Ziel: **≤ 40 Kandidaten pro Text**, sprachneutral bestimmt. Reines Modul `internal-links-candidates.ts`.

**Stufe A — Signale, alle ohne Sprachwissen:**
1. **Zeichen-n-Gramm-Überlappung** zwischen Text und Ziel (Titel, Keywords, Kurzbeschreibung in Textsprache): Trigramme über Buchstaben/Ziffern nach Unicode-Kleinschreibung und NFKC; für Schriften ohne Wortabstand Bigramme. Fängt Flexion und Komposita grob ein („glasvasen“ teilt fast alle Trigramme mit „glasvase“), ohne zu wissen, was eine Endung ist. Gewichtet mit inverser Häufigkeit über alle Ziele, damit „vase“ in 300 Titeln wenig zählt.
2. **Struktur:** Für eine Produktbeschreibung die Kollektionen des Produkts (`ProductCollection`) und Produkte derselben Kollektionen; für einen Artikel Produkte, deren Tags/Vendor im Artikel-Tagset stehen. Kostenlos, aus dem Cache.
3. **Wortlaut-Treffer aus Schritt 1** sind immer dabei (als „schon gefunden“, §4.3).
4. **Ablehnungen:** ein Ziel, dessen Vorschläge aus DIESEM Text alle abgelehnt wurden, fällt raus.

Die besten 40 nach kombiniertem Wert gehen in den Prompt. Hat der Shop ≤ 40 Ziele, gehen alle.

**Stufe B — optional, nur falls Phase 0 zeigt, dass Stufe A zu viele Umschreibungen verfehlt:** ein billiger KI-Vorlauf pro Paket „Welche dieser bis zu 300 Titel (nur Titel, ein Kürzel je Zeile) behandelt dieser Text?“ (~2,5k Tokens Eingabe, winzige Ausgabe), danach Stufe A nur noch auf diesem Kreis. Verdoppelt die Anfragezahl, deshalb kein Standard; Entscheidung nach Messung (§11).

Die Vorauswahl ist **deterministisch** — gleiche Eingaben ⇒ gleiche Liste. Daran hängt die Inkrementalität (§6).

---

## 6. Inkrementalität und Ergebnis-Cache

**Neues Modell** `SeoInternalLinkScan` (FK-los, shop-gebunden wie `ContentTranslation`):

```prisma
model SeoInternalLinkScan {
  shop            String
  resourceType    String   // "Product" | "Article" | "Page"
  resourceId      String
  locale          String   // "" = Hauptsprache, wie SeoInternalLinkSuggestion
  textDigest      String   // sha256 der zulässigen Textfläche (Segmente), nicht des HTML
  candidateDigest String   // sha256 der vorausgewählten Kandidaten (Kürzel→GID + gesendete Felder)
  promptVersion   Int      // Prompt/Validierung geändert ⇒ neu scannen
  hits            Json     // validierte Treffer: [{toType,toId,anchor,segment,r}]
  rejectedByReason Json    // Zähler aus §4.4, für die Messung
  scannedAt       DateTime
  @@id([shop, resourceType, resourceId, locale])
  @@index([shop, scannedAt])
}
```

- Ein Text wird nur an die KI geschickt, wenn `textDigest`, `candidateDigest` oder `promptVersion` sich geändert haben oder keine Zeile existiert. Eine reine Markup-Änderung (Link hinzugefügt) ändert die Textfläche — bewusst, denn der gerade angenommene Link entfernt Text aus der zulässigen Fläche.
- Neues Produkt im Katalog ⇒ nur Texte, in deren Vorauswahl es **tatsächlich** rutscht, bekommen einen neuen `candidateDigest`. Die Vorauswahl ist billig (kein KI-Aufruf), also wird sie für jeden Text jedes Mal gerechnet und verglichen.
- Der Scan-Cache **ist** das Ergebnis. Schritt 6 (Materialisieren) liest nur den Cache: Ist das Pending-Limit (200) erreicht, bleiben Treffer im Cache und erscheinen beim nächsten Lauf **ohne** neue KI-Kosten, sobald Platz ist. Damit verliert `cappedByPendingLimit` für KI-Treffer seine Wirkung als Kostenfalle.
- Ziel gelöscht / auf Draft gesetzt / Handle weg ⇒ beim Materialisieren gefiltert (wie heute über die Zielmenge), der Cache-Eintrag bleibt bis zum nächsten Scan des Textes.
- Eine Zeile wird nur geschrieben, wenn der Text **vollständig** bearbeitet wurde (alle Stücke). Ein abgebrochener Lauf (Verweigerung, Fehler, Absturz) hinterlässt für unbearbeitete Texte die alte Zeile ⇒ der nächste Lauf holt sie nach. Kein „Digest vorgerückt, Arbeit verloren“ — die Lehre aus der Primär-Baseline-Bremse.
- Lebenszyklus: `redactShopData` in [gdpr.service.ts](../../app/services/gdpr.service.ts) löscht nach `shop` (der Schema-Drift-Test verlangt das), `purgeContentFromCache` und die Sync-Löschhelfer nach `(shop, resourceId)`.

---

## 7. Kosten, Gating, Verweigerung

### 7.1 Tarif

Wortlaut-Scan bleibt **Pro** wie heute. KI-Ankerfindung: Vorschlag **Pro**, weil die Kosten über den Key bzw. das Managed-Budget des Händlers laufen und vorher angezeigt werden — Entscheidung beim Owner (§14). Das Gate sitzt im Handler (`/api/ai` hat kein Routen-Gate) **und** in der Schätzaktion (§10), beide direkt POST-erreichbar.

### 7.2 Wessen Key — und was eine Verweigerung bedeutet

- Der Runner baut seinen `AIService` weiterhin über `createAIService(settings, shop, taskId)` → `aiServiceFor` ([ai-credentials.server.ts](../../app/services/ai/ai-credentials.server.ts)). Keine zweite Schlüsselquelle. Der Task-Typ landet als `feature` im Ledger (`AiUsageCounter`), damit die Kosten eines Scans in der Nutzungsübersicht als eigene Zeile erscheinen.
- **`ManagedAiRefusedError`** (Budget aufgebraucht, Kill-Switch, Taster leer, Zustimmung fehlt): der Lauf **steht vollständig ab**, nicht nur das Paket. Bereits validierte Texte behalten ihre Cache-Zeile, unbearbeitete nicht (§6). Der Task endet nicht als „failed“, sondern mit `completed` + `managedStandDown: <reason>` in `result`, die Seite sagt es in der Sprache des Händlers (Code über `taskErrorText` / [ai-refusal-response.server.ts](../../app/utils/ai-refusal-response.server.ts), keine Rohmeldung). Die Wortlaut-Treffer aus Schritt 1 werden trotzdem materialisiert — sie haben nichts gekostet.
- Ein Shop **ohne jede KI-Möglichkeit** bekommt den Wortlaut-Scan trotzdem (heute nicht der Fall, §16): `seoInternalLinks` prüft den Schlüssel selbst und überspringt Schritte 2–5 mit dem Hinweis „KI-Suche benötigt einen KI-Zugang“, statt den ganzen Lauf mit 409 `NO_AI_KEY` abzulehnen.
- Ein Paket, das aus anderem Grund scheitert (Zeitüberschreitung, kaputtes JSON), kostet nur seine Texte: keine Cache-Zeile, nächster Lauf versucht es erneut. Nach zwei Fehlschlägen desselben Textes (Zähler in der Cache-Zeile) wird er in diesem Lauf übersprungen und in `result` gemeldet — sonst bezahlt ein dauerhaft unlesbarer Text bei jedem Lauf.

### 7.3 Schätzung vor dem Lauf

Neben „Vorschläge generieren“ steht vor dem Klick, was die KI tun würde: „KI prüft 84 geänderte Texte in 2 Sprachen (~17 Anfragen, ca. 0,04 €)“. Berechnet aus Schritt 2–3 (Digests + Vorauswahl, kein KI-Aufruf) und `planLinkScanBatches`, bepreist mit `priceCall` aus [ai-pricing.ts](../../app/config/ai-pricing.ts) für das Modell, das der Shop tatsächlich nutzt. Für einen Anbieter ohne Listenpreis (`UNPRICED_PROVIDERS`) nur die Anfragezahl. Im Managed-Modus zusätzlich „von Ihrem Monatsbudget verbleiben …“ aus `managedBudgetStatus`.

Die Schätzung wird **auf Anforderung** gerechnet (Aktion `estimateAiScan`, §10), nicht im Loader — Digests über 3000 Texte × Sprachen bei jedem Seitenaufruf wären teuer. Der Button öffnet einen Bestätigungsdialog mit der Zahl; ab einem Schwellwert (z. B. > 200 Anfragen) wird zusätzlich gefragt, ob nur die Hauptsprache gescannt werden soll.

### 7.4 Grenzen

- **Pro Lauf** eine harte Systemgrenze: höchstens `MAX_AI_SCAN_TEXTS_PER_RUN` = 500 Texte (der Rest ist Arbeit des nächsten Laufs, angezeigt als „x Texte warten noch“). Reihenfolge: Hauptsprache zuerst, dann Texte mit den meisten GSC-Impressionen (`SeoGscPageStat`), dann nie gescannte.
- **Tageslimit des Händlers** nach dem Muster von `autoTranslateDailyLimit`: neue Spalte `AISettings.seoLinksAiDailyLimit Int?` (Texte pro UTC-Tag), `null` = kein Limit, 0/negativ = kein Limit, gezählt in einer Tabelle nach dem Muster `AutoTranslateFillBudget` (atomarer bedingter Zuwachs, schließt bei DB-Fehler). Bearbeitet in den Einstellungen der Seite als **Entwurf** hinter der Speicherleiste (CLAUDE.md „A setting is never saved by the click that changes it“).
- **Sprachen pro Lauf:** der Händler wählt, welche Sprachen gescannt werden (Standard: alle, die übersetzte Bodies haben). Mit Hunderten Sprachen ist die Schätzung der Ort, an dem er das merkt — nicht eine stille Kappung wie `MAX_CARRY_LOCALES`.

---

## 8. Einbindung in den bestehenden Prüf- und Annahmefluss

### 8.1 Hauptsprache — unverändert

Ein KI-Vorschlag in der Hauptsprache ist für [api.seo-internal-links.tsx](../../app/routes/api.seo-internal-links.tsx) nicht von einem Wortlaut-Vorschlag zu unterscheiden: `anchorText` ist eine Wortfolge, die im Text steht. `computeInsertion` → `insertLinkIntoHtml` → `handleUnifiedContentActions(updateContent)` bleibt der EINE Schreibweg; `STALE`, Vorschau mit `sanitizeHTML`, `acceptAll` mit 25 pro Klick und Gruppierung nach Quelle bleiben. „Übersetzungen mitführen“ funktioniert unverändert — `localizedAnchorCandidates` und `findLocalizedAnchors` suchen dort ohnehin die Formulierung des übersetzten Textes.

### 8.2 Übersetzte Texte (Phase 2) — kleine, gezielte Erweiterung

- `computeInsertion` bekommt für `locale !== ""` einen zweiten Lesezweig: den **aktuellen** Übersetzungswert live von Shopify (`translatableResource.translations(locale:)`, wie `fetchTranslationsByLocale`), nicht den Spiegel — sonst überschreibt ein Annehmen eine in Shopify geänderte Übersetzung mit einer alten.
- Link-Ziel: `loadLocalePathPrefixes` (Sprachpräfix) + übersetzter Handle des Ziels (`ContentTranslation key "handle"` bzw. live), sonst Haupthandle — dieselbe Regel wie beim Mitführen. Ein gemeinsamer Helfer `localizedTargetHref` wird aus `internal-links-translate.server.ts` herausgezogen, damit Mitführen und Fremdsprachen-Annehmen nicht auseinanderlaufen.
- Gespeichert wird über `updateContent` mit `locale = <Fremdsprache>` — der bestehende, echo-geprüfte Fremdsprachen-Speicherweg des Editors (`translationsRegister`, Echo, DB-Spiegel, `markTranslationSaved`). Kein eigener Register-Aufruf (der Schreib-Guard-Test verbietet ihn ohnehin).
- **Veraltete Übersetzung:** Meldet Shopify die Übersetzung als `outdated`, wird NICHT angenommen (Code `TRANSLATION_OUTDATED`): ein Register gegen den aktuellen Digest würde die Markierung „veraltet“ löschen, obwohl der Text nicht zum Original passt. Der Händler sieht „Übersetzung ist veraltet — erst aktualisieren“.
- Kollision mit dem Mitführen: Wurde derselbe Link per Mitführen schon in die Übersetzung geschrieben, meldet `htmlAlreadyLinksTo` beim Annehmen „bereits verlinkt“ ⇒ der Fremdsprachen-Vorschlag wird als `accepted` (überholt) geschlossen statt als Fehler gezählt.

### 8.3 UI ([app.seo.internal-links.tsx](../../app/routes/app.seo.internal-links.tsx))

- Pro Zeile ein kleines „KI“-Abzeichen (Herkunft) und der **Satz**, in dem der Anker steht (aus dem Cache-Segment, gekürzt) — eine Umschreibung ist ohne Kontext nicht prüfbar.
- Sprach-Filter (Phase 2) als Chip-Zeile — **entfällt bei einsprachigen Shops** (CLAUDE.md „Single-language shops“: Sprachleisten entfernen, nicht deaktivieren). Ein fehlgeschlagener `getCachedShopLocales` (`[]`) zählt als „unbekannt“, nicht als einsprachig: gescannt wird dann nur die Hauptsprache, die Seite sagt warum.
- Die Sprachauswahl des Laufs (§7.4) ist ebenfalls nur bei mehrsprachigen Shops sichtbar.
- Ja/Nein-Entscheidungen als `ToggleRow` (Pill-Switch), nicht als Checkbox. Erklärtext in `t.help`-Einträgen (❓), nicht unter dem Steuerelement.
- i18n in `de.ts`, `en.ts`, `es.ts`.

---

## 9. Datenmodell-Änderungen

- `SeoInternalLinkSuggestion`: neu `matchKind String @default("title")` (`title|primary|secondary|synonym|ai`), `context String?` (Satz, ≤ 300 Zeichen), `scanVersion Int?`. Unique-Key bleibt — damit kollidieren Wortlaut- und KI-Treffer für dasselbe (Quelle, Ziel, Sprache) automatisch, und die Regel lautet: höhere Konfidenz überschreibt den Anker einer `pending`-Zeile, nie eine `dismissed`/`accepted`.
- `SeoInternalLinkScan` (§6), neu.
- `AISettings.seoLinksAiDailyLimit Int?` + Zähltabelle `SeoLinkAiBudget (shop, day, used)` (§7.4).
- Migration additiv; Default-Werte machen alte Zeilen lesbar. Alle neuen Tabellen in `redactShopData` (Schema-Drift-Test).

---

## 10. Routen — keine neue

| Bedarf | Wo |
|---|---|
| Lauf starten (Wortlaut + KI) | bestehende `/api/ai`-Aktion `seoInternalLinks`, Formfeld `languages` (Liste) und `ai=1/0` |
| Schätzung | neuer `actionType: "estimateAiScan"` auf [api.seo-internal-links.tsx](../../app/routes/api.seo-internal-links.tsx) (Pro-Gate ist dort schon) |
| Tageslimit speichern | bestehende Einstellungsseite / bestehende Aktion der Seite, nicht im Klick |
| Annehmen/Vorschau Fremdsprache | bestehende `accept` / `previewAccept`, Zweig über `suggestion.locale` |

Die Rate-Limits beider Routen in [server.js](../../server.js) bleiben, wie sie sind.

---

## 11. Messplan — Ertrag gegenüber heute

**Phase 0 (Schatten):** Der KI-Durchgang läuft auf einer Stichprobe (z. B. 50 Texte Hauptsprache + 50 übersetzte) eines Owner-Testshops, schreibt nur in `SeoInternalLinkScan` und `Task.result`, **nicht** in die Vorschlagsliste. Ausgelöst über `ai=shadow` an derselben `/api/ai`-Aktion, nur wenn die Umgebungsvariable `SEO_LINKS_AI_SHADOW=true` gesetzt ist (keine Probe-Route).

Gemessen und in `Task.result` (erweitertes `InternalLinksSummary`) abgelegt:

| Kennzahl | Wozu |
|---|---|
| Treffer/Text: nur Wortlaut, nur KI, beide | eigentlicher Ertrag |
| Verworfene KI-Antworten je Grund (§4.4) | Halluzinationsrate; `notInText` + `unknownTarget` > 15 % ⇒ Prompt/Modell nachschärfen |
| Anfragen, Eingabe-/Ausgabe-Tokens (aus dem Ledger), µ€ pro gültigem Treffer | stimmt die Annahme aus §4.3? |
| Anteil Treffer, deren Ziel nicht in den Top-40 war (nur mit Stufe B messbar) | braucht es Stufe B? |
| Laufzeit pro 100 Texte | passt der Lauf in die Task-Zeiten? |

Danach Owner-Sichtung der KI-Treffer (Stichprobe 100) mit den Noten „richtig / vertretbar / falsch“.

**Nach Freischaltung (Phase 1+):** pro `matchKind` die Annahme-, Ablehnungs- und `STALE`-Quote über 4 Wochen (aus `SeoInternalLinkSuggestion.status`). Kriterien, die der Owner vorab bestätigt (§14): KI-Annahmequote ≥ 70 % der Wortlaut-Annahmequote; verworfene Antworten ≤ 20 %; Kosten pro angenommenem Link unter einem festgelegten Betrag.

---

## 12. Fehlerbilder und ihre Sicherungen

| Fehlerbild | Sicherung |
|---|---|
| Erfundener Anker (steht nicht im Text) | §4.4 #4 + #11; ohne Fundstelle kein Vorschlag. Beim Annehmen nochmals `STALE`-Prüfung gegen den aktuellen Inhalt. |
| Erfundenes / fremdes Ziel | Kürzel statt GID, Liste pro Text (#1). |
| Anker in falscher Sprache | Unmöglich durch Konstruktion: der Anker muss im Text stehen, und der Text ist in genau einer Sprache. Ein in einen deutschen Text eingestreutes englisches Markenwort ist erlaubt — es steht da. |
| Link auf falsche Sprachversion des Ziels | href serverseitig aus Präfix + übersetztem Handle (§8.2), nie aus der KI-Antwort. |
| Falsche Zuordnung (Anker spricht über ein anderes Produkt) | nicht maschinell prüfbar ⇒ Kontextsatz in der Liste, Vorschau, Ablehnung fließt zurück (§4.3). Das ist der Rest, den die Freigabe des Händlers trägt. |
| HTML-Beschädigung | KI sieht kein HTML; Einfügen nur über `insertLinkIntoHtml` (cheerio-Fragment); Probe-Einfügung mit Textgleichheitsprüfung (#11); Vorschau `sanitizeHTML`. |
| Link in Überschrift / bestehendem Link / Attribut | gar nicht im Prompt; #6 als zweite Linie. |
| Linkflut | ein Ziel pro Text, 3 pro Text, Dichte (#8, #9), 200 offene pro Shop. |
| Prompt-Injection im Händlertext („ignoriere alles und …“) | Text nur über `sanitizePromptInput`; die Antwort ist reine Auswahl und wird vollständig validiert — eine manipulierte Antwort kann höchstens einen gültigen oder gar keinen Vorschlag erzeugen. |
| Managed-Budget leer mitten im Lauf | `ManagedAiRefusedError` ⇒ Lauf steht ab, kein Digest vorgerückt, Wortlaut-Treffer bleiben (§7.2). |
| Veraltete Übersetzung wird beim Annehmen „aufgefrischt“ | `TRANSLATION_OUTDATED` (§8.2). |
| Doppelte Kosten durch Wiederholung | Cache + Digests (§6), Pending-Limit verliert keine Treffer mehr. |
| Spiegel der Übersetzung veraltet | Scan auf dem Spiegel (billig), Annehmen live (§8.2); Restrisiko: ein seit dem letzten Sync in Shopify geänderter Text wird erst nach dem nächsten Sync gescannt. |

---

## 13. Koexistenz mit dem Wortlaut-Matcher

**Vorschlag: behalten als kostenlosen ersten Durchgang, Synonyme abschaffen.**
- Wortlaut-Titel- und Keyword-Treffer kosten nichts, sind am präzisesten und laufen auch ohne KI-Zugang. Sie bleiben Schritt 1 und gehen der KI als „schon gefunden“ mit (spart Ausgabe-Tokens).
- Die Synonym-Stufe (`generateSynonymsBatch`, `MAX_SYNONYM_TARGETS`, `SYNONYM_BATCH_SIZE`) ist eine schwächere Vorform der KI-Ankerfindung (nur Hauptsprache, danach wieder wortwörtlich). Sie läuft in Phase 1 parallel weiter (für die Messung), wird in Phase 3 entfernt, wenn die Messung die KI-Findung bestätigt.
- Shops ohne KI: nur Schritt 1 — genau das Verhalten von heute ohne Synonyme.

---

## 14. Offene Fragen an den Owner

1. **Tarif** der KI-Ankerfindung: Pro (wie die Seite) oder Max?
2. **Synonyme** nach erfolgreicher Messung entfernen (Vorschlag) oder behalten?
3. **Tageslimit**: Standard `null` (kein Limit, wie bei `autoTranslateDailyLimit` entschieden) — oder hier ein Standardwert, weil der Lauf vom Händler ausgelöst und vorher geschätzt wird?
4. **Sprachen pro Lauf**: Standard „alle mit übersetzten Texten“ oder „nur Hauptsprache, weitere zuschalten“?
5. **Kollektionen als Quelle** (Kollektionsbeschreibungen) — billig mitzunehmen, `RESOURCE_ROUTE` kennt sie schon.
6. **Seiten/Artikel als Linkziel** (z. B. Ratgeber → Ratgeber)? Eigene Phase, verändert die Kandidatenliste.
7. **Dichte-Grenze**: 1 Link / 300 Zeichen als Startwert ok? (Zeichen statt Wörter ist bewusst sprachneutral; für CJK bedeutet derselbe Wert mehr Inhalt pro Link.)
8. **Bestimmtes Vorkommen verlinken** (§4.4 Lücke): `insertLinkIntoHtml` um einen Positionsparameter erweitern, oder „erstes Vorkommen“ akzeptieren?
9. **Wöchentlicher Lauf** nur für geänderte Texte (Max), Phase 4 — gewünscht?
10. **Abnahmekriterien** aus §11 bestätigen (70 % / 20 % / Kosten pro Link).
11. **HuggingFace** (ohne Preis, schwaches JSON): KI-Findung dort zulassen oder mit Hinweis verweigern?

---

## 15. Phasen

| Phase | Inhalt | Aufwand (grob) |
|---|---|---|
| **0 — Schatten-Messung** | `findLinkAnchorsBatch`, Segmentierung, Validierungsmodul §4.4 mit Tests, Vorauswahl Stufe A, `ai=shadow` hinter `SEO_LINKS_AI_SHADOW`, Kennzahlen in `Task.result`. Kein UI, keine Migration außer `SeoInternalLinkScan`. Lauf auf zwei Owner-Testshops. | 3–4 Tage |
| **1 — KI-Findung Hauptsprache** | Materialisierung aus dem Cache, Inkrementalität, `matchKind`/`context`-Spalten, Schätzung (`estimateAiScan`) + Bestätigungsdialog, Managed-Verweigerung, Wortlaut-Scan ohne KI-Zugang, KI-Abzeichen + Kontextsatz, i18n ×3, **Guide** „Interne Verlinkung“ (Abschnitt „Wie die KI sucht“, Kosten, Herkunfts-Abzeichen; aus Händlersicht, ohne Technik), Review-Schleife nach CLAUDE.md. | 1,5–2 Wochen |
| **2 — Übersetzte Texte** | Quellen aus `ContentTranslation`, Ziele mit übersetzten Titeln/Keywords/Handles, `localizedTargetHref`, Fremdsprachen-Annehmen über `updateContent` + `TRANSLATION_OUTDATED`, Sprachfilter (entfällt bei einer Sprache), Sprachauswahl des Laufs, Guide-Ergänzung. | 1,5 Wochen |
| **3 — Kostenregler + Aufräumen** | `seoLinksAiDailyLimit` + Zähltabelle + Speicherleiste, Lauf-Grenze mit Restanzeige, Synonym-Stufe entfernen (nach Messung), Kennzahlen-Auswertung nach 4 Wochen. | 3–4 Tage |
| **4 — optional** | Stufe B der Vorauswahl, Kollektionen als Quelle, Seiten/Artikel als Ziel, wöchentlicher Lauf nur geänderter Texte (Max, mit Einwilligung über den bestehenden Schalter und Backoff-Stempel wie die anderen Sweeps). | je 2–5 Tage |

---

## 16. Beobachtungen am Ist-Code (nicht Teil dieses Plans, zur Entscheidung)

1. **Mitführen-Schalter speichert beim Klick** (`changeCarryTranslations` → `setCarryTranslations`): widerspricht der Regel „eine Einstellung wird nie durch den Klick gespeichert“. Klein (eine Präferenz), aber die einzige Stelle der Seite, die so arbeitet; zudem eine `Checkbox` statt Pill-Switch.
2. **Wortlaut-Scan verlangt einen KI-Zugang**, obwohl der Matcher KI-frei ist (`seoInternalLinks` nicht in `NON_AI_ACTIONS`). In Phase 1 behoben (§7.2), sonst ein Einzeiler-Umbau mit Synonym-Überspringen.
3. **`MAX_CARRY_LOCALES` = 20 kappt still**: Sprachen jenseits der 20. bekommen beim Mitführen keinen Link, ohne Meldung (`unlinked` zählt sie nicht). Bei „Hunderten Sprachen“ relevant.
4. **Kollektionen** stehen in `RESOURCE_ROUTE`, werden aber nie als Quelle gescannt (§14 Frage 5).
5. **Kollektionen als Ziel ohne Statusfilter** (im Code dokumentiert): eine nicht veröffentlichte Kollektion kann Linkziel werden.
