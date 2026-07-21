# AI-Batch-Translation-Contract

**Was das ist:** der aktive Architektur-Vertrag für das Batching der AI-Übersetzungen. Beschreibt, wie ContentPilot N Felder × M Locales in einen einzigen AI-Call zusammenzieht, wann und wie in Chunks gesplittet wird, und wie Teilausfälle behandelt werden. Gilt für Templates, Content (Products/Collections/Pages/Blogs/Policies), Theme-Content und Alt-Text.

**Warum das existiert:** Ohne Batching entstehen bei einem `translateAll` auf Templates schnell 30 Felder × 3 Locales = 90 sequenzielle AI-Calls; das ist Latenz und Provider-Kosten für Round-Trips ohne Nutzen. Der Batch-Pfad kollabiert das auf 1 Call — solange die geschätzte Antwortgröße das Provider-Output-Limit nicht sprengt. Wird das Limit überschritten, sind die Fallback-Strategien nicht offensichtlich (Locale- vs. Field-Chunking, wann per-locale `translateContent`), und die Failure-Semantik unterscheidet sich absichtlich vom Sequential-Pfad — das gehört dokumentiert, nicht nur in Kommentaren.

**Historie:** ursprünglich in `docs/plans/PLAN_BATCH_TRANSLATION.md` (Phase 1 Service + Phase 2 Templates + Phase 3 Content) formuliert, 2026-07 im Wesentlichen ausgeliefert und dieser Plan entfernt. Was hier steht ist der destillierte Kern; die Umsetzungshistorie ist in Git.

---

## Die Kern-API

Zwei Funktionen in [ai.service.ts](../../src/services/ai.service.ts) — Aufrufer nutzt fast immer die zweite:

- **`translateFieldsToLocalesBatch(fields, fromLang, targetLocales, options)`** — ein einziger AI-Call. Prompt gruppiert Felder unter `### <key>`-Headern und fordert JSON in der Shape `{ locale: { key: translated } }`. Kein `maxLength`-Cap auf den Feldwerten (lange HTML-Bodies müssen intakt zum Modell).
- **`translateFieldsToLocalesChunked(fields, fromLang, targetLocales, options)`** — der Chunking-Wrapper. Schätzt Output-Größe; wenn unter Schwelle → 1 Call. Sonst dreistufige Fallback-Kaskade (siehe unten).

Antwort-Shape ist immer `Record<locale, Record<fieldKey, translated>>`. Fehlende Zellen sind **nicht** Fehler — der Aufrufer überspringt sie (N-H3: nie source-as-translation persistieren).

## Wann Batching WIRKLICH hilft

Batching lohnt sich, wenn **N Felder × M Locales > 1**. Endpoint-Handler, die pro HTTP-Request nur 1 Feld × 1 Locale übersetzen (z. B. [api.metaobjects.$.tsx:291](../../app/routes/api.metaobjects.$.tsx#L291), Alt-Text-Single-Locale in [alt-text.handler.ts:352](../../app/routes/api-ai-handlers/alt-text.handler.ts#L352)), sind **keine** Batch-Kandidaten. `translateContent` dort NICHT durch `translateFieldsToLocalesChunked` ersetzen — das ist reiner Overhead ohne Round-Trip-Reduktion und macht die Fehlerpfade komplizierter.

Aktive Call-Sites (die echten N×M-Reduktionen):

| Ort | Reduktion |
|---|---|
| [templates-translate-all.action.ts:83](../../app/actions/templates/templates-translate-all.action.ts#L83) | N × M → 1 (größter Gewinn) |
| [templates-translate-field.action.ts:223](../../app/actions/templates/templates-translate-field.action.ts#L223) | 1 × M → 1 |
| [text-translation.handler.ts:978](../../app/routes/api-ai-handlers/text-translation.handler.ts#L978) | 1 × M → 1 (Content long-field-Pfad) |
| [theme-content-api.server.ts:294](../../app/services/theme-content-api.server.ts#L294) | 1 × M → 1 |

Alt-Text hat einen eigenen spezialisierten Batcher (`translateAltTextsBatch`), der die alt-text-spezifische Prompt-Führung behält.

## Die drei Chunking-Stufen

Reihenfolge in [`translateFieldsToLocalesChunked`](../../src/services/ai.service.ts#L1424), sobald die Fast-Path-Schätzung (`Σ(fieldLen) × |locales| × 1.3`) `CHUNK_THRESHOLD_CHARS` überschreitet:

1. **Locale-Chunking** (Standard) — Felder bleiben zusammen, Locales werden in Gruppen gesplittet, sodass jede Gruppe unter Schwelle bleibt. Mehrere Batch-Calls parallel (`MAX_CONCURRENCY`).
2. **Field-Chunking** (Fallback) — wenn schon **eine** Locale mit allen Feldern die Schwelle sprengt, werden zusätzlich die Felder in Gruppen aufgeteilt (dann Field-Group × Locale-Group).
3. **Per-Locale `translateContent`** (Fallback) — ein **einzelnes** Feld ist alleine schon größer als das Budget einer Locale (z. B. 15 000-Zeichen-Legal-Page). Batch-JSON-Wrapping bringt hier nichts; für dieses eine Feld × jede Locale wird `translateContent` einzeln aufgerufen. Der Ergebnis-Merge in die `{ locale: { key } }`-Map ist derselbe.

Ergebnisse aller Chunks werden in **eine** Antwort-Map gemerged; der Aufrufer sieht keinen Unterschied.

## Failure-Semantik (bewusst anders als Sequential)

- **Ein Chunk failed**: nur seine Zellen fehlen im Ergebnis. Der Aufrufer überspringt fehlende Zellen (N-H3). Andere Locales bleiben sauber.
- **Alle Chunks failed**: `translateFieldsToLocalesChunked` wirft. Aufrufer sollte in `try/catch` auf den heutigen Sequential-Pfad zurückfallen (Beispiel: [alt-text.handler.ts:465-495](../../app/routes/api-ai-handlers/alt-text.handler.ts#L465)).
- **JSON-Struktur unvollständig**: `AIService.assertNestedComplete` wirft laut, bevor die Funktion returned. Das ist Absicht — ein abgeschnittenes JSON (fehlender `}` in einem langen Body) würde sonst spätere Zellen still verschlucken, während der Task success meldet.
- **Auth-Fehler** (401): Fallbacks MÜSSEN das durchreichen. Jede weitere Locale würde denselben 401 werfen — `isAuthError` prüfen und rethrowen (siehe alt-text-Fallback).

## Echo-Guard (nicht offensichtlich)

Ein zurückgegebener Wert, der **byte-identisch** zur Quelle ist, ist meistens korrekt: "Hotel", "Information", "Schadenfreude", Markennamen — viele kurze Wörter sind sprachübergreifend gleich. `translateFieldsToLocalesBatch` behält solche Werte.

**Nur** ab `ECHO_FAILURE_MIN_CHARS` (200) wird ein identischer Echo als fehlgeschlagene Übersetzung interpretiert (ein ganzer Absatz gleicht nie legitim seiner Quelle) und die Zelle gedroppt — der Aufrufer sieht sie als „fehlend" und überspringt sie (N-H3). Die Schwelle ist bewusst hoch: lieber ein paar echte Kurz-Echos akzeptieren als lange Ausfälle als „Übersetzung" persistieren.

## Tuning-Konstanten

Alle in [`TRANSLATION_BATCH` in constants.ts](../../app/config/constants.ts#L139) — hier zentralisiert, damit Tuning ohne Code-Search geht.

| Konstante | Wert | Warum |
|---|---|---|
| `CHUNK_THRESHOLD_CHARS` | 40 000 | Provider laufen mit `max_tokens: 8192` (~32k Zeichen Output bei ~4 Zeichen/Token); 40k ist die praktische Obergrenze mit dem head-room, den der Expansion-Factor schon einrechnet. |
| `OUTPUT_EXPANSION_FACTOR` | 1.3 | Übersetzungen sind meist etwas länger als die Quelle; konservativer Durchschnitt über die unterstützten Sprachen. |
| `MAX_CONCURRENCY` | 3 | Chunk-Calls parallel, aber nicht so viele dass das translatable-resource-Rate-Limit ([Community-Thread](https://community.shopify.dev/t/translatable-resource-rate-limit/15107)) getroffen wird. |
| `ECHO_FAILURE_MIN_CHARS` | 200 | Siehe Echo-Guard oben. |

## Was NICHT zu machen ist

- **Kein `Object.assign(translations, { [locale]: sourceText })`-Fallback** wenn eine Zelle fehlt. N-H3-Konvention: fehlende Werte = skip, nicht „Source als Übersetzung". Der Aufrufer-Loop soll `continue`en.
- **Kein `maxLength`-Cap** auf den Feldwerten vor dem Batch-Call — lange HTML-Bodies müssen intakt zum Modell (der Provider errort laut bei Overflow, statt still zu truncieren; genau das wollen wir).
- **Nicht `translateContent` durch `translateFieldsToLocalesChunked` ersetzen**, wenn die Aufrufstelle nur 1 Feld × 1 Locale hat (siehe „Wann Batching WIRKLICH hilft"). Der Batch-Pfad hat mehr Overhead und macht die Fehlerpfade komplizierter, ohne Round-Trips zu sparen.
- **Kein neuer paralleler Batch-Helper** — jede zusätzliche Batch-Funktion muss die Echo-Guard-Nuance, `assertNestedComplete` und die N-H3-Fehlerbehandlung erneut korrekt bauen. Wenn ein neuer Anwendungsfall auftaucht, `translateFieldsToLocalesChunked` mit passendem `contextLabel` nutzen oder die vorhandene Funktion erweitern.
