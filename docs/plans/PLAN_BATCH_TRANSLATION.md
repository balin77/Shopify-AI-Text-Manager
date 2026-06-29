# Plan: Batch-Übersetzung mit Chunking für lange Texte

## Ziel
Aus N×M sequenziellen AI-Calls (N Felder × M Locales) wird **1 Call**, der ein JSON `{ locale: { key: translated } }` zurückgibt. Nur wenn die geschätzte Payload eine Schwelle überschreitet, wird in Chunks aufgeteilt.

---

## Phase 1 — Neuer Service-Baustein

### 1.1 `translateFieldsToLocalesBatch` in [src/services/ai.service.ts](../src/services/ai.service.ts)

Signatur:
```ts
async translateFieldsToLocalesBatch(
  fields: Record<string, string>,        // key → sourceText
  fromLang: string,
  targetLocales: string[],
  options?: {
    preserveHtml?: boolean;              // default true (für description/body)
    contextLabel?: string;               // z. B. "template content", "product description"
  }
): Promise<Record<string, Record<string, string>>>  // locale → key → translated
```

Implementation:
- Prompt-Aufbau analog zu `translateShortFieldsBatch` ([ai.service.ts:649](../src/services/ai.service.ts#L649)), aber:
  - Kein `maxLength`-Cap im `sanitizePromptInput` (lange HTML-Inhalte müssen durch — siehe Kommentar bei `translateContent`, [ai.service.ts:222-229](../src/services/ai.service.ts#L222))
  - HTML-Tag-Preservation-Hinweis im Prompt (`Keep HTML tags`)
  - Erwartete JSON-Struktur als Skelett im Prompt
- Validierung über vorhandene `AIService.assertNestedComplete(..., targetLocales, Object.keys(fields))` → fail-loud bei fehlenden Locale/Feld-Kombinationen
- Echo-Guard wie bei `translateContent` ([ai.service.ts:252-263](../src/services/ai.service.ts#L252)): wirft, wenn ein Wert unverändert zur Quelle ist (pro field/locale), damit kein `source-as-translation` persistiert wird.

### 1.2 Chunking-Wrapper `translateFieldsToLocalesChunked`

Same Signature, plus interne Aufteilung:

```ts
// Schwelle: geschätzte Output-Größe in Zeichen
const CHUNK_THRESHOLD_CHARS = 40_000;   // ≈ ~10k Tokens Output

// Schätzung: Σ(fieldLen) × |targetLocales| × 1.3 (Expansion)
const sourceChars = Object.values(fields).reduce((a, v) => a + v.length, 0);
const estimatedOutput = sourceChars * targetLocales.length * 1.3;

if (estimatedOutput <= CHUNK_THRESHOLD_CHARS) {
  return translateFieldsToLocalesBatch(fields, fromLang, targetLocales, opts);
}
```

**Chunking-Strategie (in dieser Reihenfolge):**

1. **Locale-Chunking** (Standard): Targets in Gruppen aufteilen, sodass jeder Chunk unter Schwelle bleibt. `chunkSize = max(1, floor(CHUNK_THRESHOLD_CHARS / (sourceChars × 1.3)))`. Mehrere Batch-Calls **parallel** (`Promise.all` mit Concurrency-Limit 3, um Provider-Rate-Limits zu schonen). Ergebnisse mergen.

2. **Field-Chunking** (Fallback): Wenn ein **einzelnes** Feld bereits zu groß für 1 Locale-Chunk ist (z. B. 10 000-Zeichen-Legal-Page × 1 Locale > Schwelle), Felder in kleinere Gruppen splitten und pro Field-Gruppe × Locale-Gruppe einen Call machen.

3. **Single-Field-Single-Locale-Fallback**: Wenn auch ein einzelnes Feld × eine einzelne Locale die Schwelle überschreitet (>40k Output für 1 Übersetzung), fallback auf existierendes `translateContent` (wie heute) — also bewusst der Sequential-Pfad nur für diesen Extremfall.

Konstanten zentralisieren in [app/config/constants.ts](../app/config/constants.ts) damit Tuning ohne Code-Search möglich ist.

### 1.3 Tests

Neuer Test in [tests/unit/aiService.test.ts](../tests/unit/aiService.test.ts):
- 5 Felder × 3 Locales → 1 Call (Mock prüft Call-Count)
- Ein 50 000-Zeichen-Feld × 5 Locales → mehrere Chunks
- Fehlende Locale im JSON → wirft via `assertNestedComplete`
- Echo (translated == source) → wirft

---

## Phase 2 — Templates umstellen (größter Gewinn)

### 2.1 [app/actions/templates/templates-translate-all.action.ts:77-100](../app/actions/templates/templates-translate-all.action.ts#L77-L100)

Ersetze die Doppelschleife durch:

```ts
const fieldsToTranslate: Record<string, string> = {};
for (const [key, item] of uniqueContent.entries()) {
  if (item.value) fieldsToTranslate[key] = item.value;
}

const result = await aiService.translateFieldsToLocalesChunked(
  fieldsToTranslate, primaryLocale, targetLocales,
  { preserveHtml: true, contextLabel: "template content" }
);

for (const locale of targetLocales) {
  translations[locale] = {};
  for (const key of Object.keys(fieldsToTranslate)) {
    const value = result[locale]?.[key];
    if (!value) continue;                   // fehlend → nicht persistieren (N-H3-Konvention)
    translations[locale][key] = value;
    pendingUpserts.push({ key, locale, value, resId: keyToResourceId.get(key) || resourceId });
  }
}
```

**Wichtig**: das Shopify-Save-Batching (`shopifyBatches`-Map ab [Zeile 110](../app/actions/templates/templates-translate-all.action.ts#L110)) bleibt komplett unverändert — wir tauschen nur die AI-Beschaffung. Failure-Semantik (`translateContent` warf bisher pro Feld; jetzt wirft der Batch-Call ganz oder gar nicht) wird via Try/Catch um den Batch-Call gewrappt + per-Locale-Chunk-Try/Catch, damit ein kaputter Chunk nicht alle Locales kippt.

**Progress-Updates**: statt N×M Granularität → 3 Phasen (10 % AI starten, 60 % AI fertig, 100 % Shopify done).

### 2.2 [app/actions/templates/templates-translate-field.action.ts:217-240](../app/actions/templates/templates-translate-field.action.ts#L217-L240)

1 Feld × M Locales → `translateFieldsToLocalesChunked({ [fieldType]: sourceText }, …, targetLocales)`. Resultat in `translations[locale]`-Form bringen.

### 2.3 Alter `case "translateAll"` in [app/routes/api.templates.$.tsx:256-318](../app/routes/api.templates.$.tsx#L256-L318)

Falls noch genutzt (prüfen via Grep auf `actionType=translateAll` im Client): gleiche Umstellung, sonst löschen.

---

## Phase 3 — Content (Products / Collections / Pages / Blogs / Policies)

### 3.1 [app/routes/api-ai-handlers/text-translation.handler.ts:887-1336](../app/routes/api-ai-handlers/text-translation.handler.ts#L887-L1336)

Der Sequential-Pfad für **lange** Felder. Hier ist es **1 Feld × M Locales** (der Handler arbeitet immer auf einem Feld).

- Vor der Schleife: `const batchResults = await aiService.translateFieldsToLocalesChunked({ [fieldType]: sourceText }, primaryLocale, targetLocales, { preserveHtml: true, contextLabel: contentType })`
- Pro Locale aus `batchResults[locale][fieldType]` lesen statt `await translateContent(...)`
- Die gesamte Shopify-Persist-Logik (Digest-Cache, GraphQL-Call, DB-Upsert) bleibt **identisch** — wir vermeiden nur den AI-Call innerhalb der Schleife.
- Per-Locale-Fehler: wenn `batchResults[locale]?.[fieldType]` fehlt → `rejectedFields[locale].push(fieldType)`, `continue` (gleiche Semantik wie Batch-Pfad bei Short-Fields heute, [Zeile 446-456](../app/routes/api-ai-handlers/text-translation.handler.ts#L446)).
- Bei vollständigem Batch-Fail (alle Chunks kaputt): Fallback auf den heutigen Sequential-Pfad behalten — Try/Catch um den `translateFieldsToLocalesChunked`-Call.

### 3.2 Slug-Felder

`translateSlugBatch` existiert bereits → keine Änderung.

---

## Phase 4 — Alt-Text & Metaobjects (kleinerer Gewinn)

### 4.1 [app/routes/api-ai-handlers/alt-text.handler.ts:465](../app/routes/api-ai-handlers/alt-text.handler.ts#L465)

`translateAltTextsBatch` existiert bereits in `ai.service.ts` — Schleife ersetzen durch einen einzigen Call. Prüfen, ob die Stelle es nicht schon nutzt (Grep zeigt 2 `translateContent`-Stellen im Handler — entsprechend umstellen).

### 4.2 [app/routes/api.metaobjects.$.tsx:276](../app/routes/api.metaobjects.$.tsx#L276)

Wenn dort über mehrere Locales geschleift wird → gleiche Umstellung wie Templates. Erst Code lesen, ggf. niedrige Priorität wenn nur 1 Locale pro Aufruf.

---

## Phase 5 — Cleanup & Validierung

1. **Manuell verifizieren** (siehe `verify`-Skill):
   - Templates `translateAll` mit 30 Feldern × 3 Locales → Netzwerk-Tab muss **1 AI-Call** zeigen (statt 90).
   - Templates `translateAll` mit einer Legal-Page mit 8 000 Zeichen × 10 Locales → mehrere Chunks, alle erfolgreich.
   - Eine Locale produziert Müll → andere Locales bleiben sauber, kaputte Locale in `rejectedFields`.

2. **Logging**: in `translateFieldsToLocalesChunked` einmaliges Info-Log `{ fields, locales, chunks, estimatedOutput }` — macht spätere Tuning-Entscheidungen einfach.

3. **Konstanten dokumentieren** in [app/config/constants.ts](../app/config/constants.ts) mit Kommentar warum 40 000 (ca. Output-Limit Claude/Sonnet bei `max_tokens=8192` × 4 Zeichen/Token).

4. **N-H3-Konvention prüfen**: keine `Object.assign(translations, { [locale]: sourceText })`-Fallbacks in den neuen Pfaden — fehlende Werte = skip, nicht „source als Übersetzung speichern".

---

## Reihenfolge & Risiko

| Phase | Aufwand | Gewinn | Risiko |
|-------|---------|--------|--------|
| 1 (Service) | M | — | gering, isoliert, testbar |
| 2 (Templates) | S | **sehr hoch** (N×M → 1) | mittel — Shopify-Persist-Logik berühren wir nicht, nur AI-Fetch |
| 3 (Content long fields) | M | hoch | mittel — Per-Locale-Fehlerpfade |
| 4 (Alt-Text/Metaobjects) | S | klein | gering |
| 5 (Verify) | S | — | — |

Phase 1+2 zusammen committen, Phase 3 separat, Phase 4 separat — so bleibt jeder PR überschaubar.
