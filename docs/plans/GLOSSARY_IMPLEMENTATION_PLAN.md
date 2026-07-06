# Glossar / Terminologie-Management — Umsetzungsplan

## Context

[COMPETITIVE_ANALYSIS.md](../COMPETITIVE_ANALYSIS.md) §2.2/§3 markiert **Glossar/Terminologie** als kritischen Gap (Standard bei Transcy, Weglot, LangShop, T Lab): Begriffsdatenbank pro Shop mit „nie übersetzen" / „immer exakt so übersetzen", injiziert in den AI-Übersetzungsprompt.

**Nutzer-Vorschlag (Ausgangspunkt dieses Plans):**
- Settings-Tab „Glossar" mit Locale-Buttons wie in den Content-Editoren (Code ggf. wiederverwenden)
- „+"-Button für neue Einträge; Begriff wird in der Hauptsprache erfasst
- Pro Fremdsprache kann der Merchant die **gewünschte** Übersetzung gezielt hinterlegen
- Das Glossar wird jeder AI-Übersetzungsanfrage mitgeschickt

**Bewertung:** Der Vorschlag ist richtig und deckt sich mit der Analyse. Vier Verbesserungen werden eingearbeitet (Begründung jeweils unten):
1. **„Nie übersetzen"-Flag pro Begriff** (Marken-/Produktnamen) — aus der Analyse; spart das Eintippen des identischen Begriffs in jeder Sprache.
2. **Zentrale Injektion im `AIService`** statt pro Aufrufstelle — sonst deckt das Glossar nur die Content-Editoren ab, nicht Theme-Content, Direct Translations, Alt-Texte, SEO-Felder.
3. **Nur Begriffe injizieren, die im Quelltext tatsächlich vorkommen** — Token-Budget und Befolgungsrate; ein 200-Zeilen-Glossar in jedem Prompt verwässert die Instruktionen.
4. **Leere Fremdsprachen-Übersetzung = keine Regel** (AI entscheidet frei), statt Pflichtfeld — der Merchant pflegt nur die Sprachen, bei denen es ihm wichtig ist.

## Wichtiger Fund: bestehender Branch `origin/feature/glossary`

Es existiert bereits eine **vollständige Backend-Implementierung** (2 Commits, Stand 2026-05-19, **~450 Commits hinter `develop`**):

| Bestandteil | Zustand | Übernehmen? |
|---|---|---|
| `src/services/glossary.service.ts` (422 Z.) — Validation, CRUD, Prompt-Block-Builder, CSV-Import/Export (RFC-4180, ohne Dependency), Prompt-Injection-Härtung (M1: Verbots-Zeichen `"`/`->`/Control-Chars, doppelte Sanitization, „literal data"-Fencing) | Hohe Qualität | **Ja, portieren** (mit Anpassung ans neue Datenmodell) |
| `tests/unit/glossary.service.test.ts` (291 Z.) | Gut | **Ja, portieren + erweitern** |
| GDPR-Wiring (`redactShopData`) | Korrekt | **Ja** (Drift-Guard-Test erzwingt es ohnehin) |
| Prisma `GlossaryTerm` (Zeile pro Quell-/Ziellocale-Paar, `targetTerm null` = nie übersetzen) | Funktional, passt aber nicht zur gewünschten UI | **Anpassen** → Entry + per-Locale-Übersetzungen (unten) |
| Injektion nur in `app/actions/content/translation.action.ts` via `withGlossary()` | Deckt nur die 4 Content-Editor-Bulk-Aktionen ab | **Ersetzen** durch zentrale Injektion im `AIService` |
| `SettingsGlossaryTab.tsx` (flache Liste + Einzelformular, Ziellocale als Freitextfeld) | Entspricht nicht dem gewünschten Locale-Button-Modell | **Neu bauen** |

Der Branch wird **nicht gemergt/rebased** (zu weit hinter develop, `app.settings.tsx` stark divergiert); stattdessen werden Service/Tests/GDPR-Teile per Cherry-Pick-Inhalt auf den aktuellen Stand portiert.

## Architektur-Leitplanken (aus dem bestehenden Code, einhalten)

- **GDPR-Pflicht:** jedes neue shop-scoped Prisma-Modell in `redactShopData()` ([app/services/gdpr.service.ts](../../app/services/gdpr.service.ts)) per `deleteMany({ where: { shop } })` ergänzen — Drift-Guard-Test schlägt sonst fehl.
- **Prompt-Injection:** Merchant-Eingaben laufen durch `sanitizePromptInput()` ([app/utils/prompt-sanitizer.ts](../../app/utils/prompt-sanitizer.ts)); die M1-Härtung des feature-Branches (Verbots-Zeichen + Fencing) übernehmen.
- **Kein Plan-Gating:** Übersetzen selbst ist ungegated → Glossar ebenfalls (Entscheidung aus dem feature-Branch, konsistent halten). Optional später: Eintragslimit pro Plan.
- **`AIService` darf `db.server` dynamisch importieren** — tut er bereits fürs Token-Tracking (ai.service.ts ~Z. 1513) → Glossar-Lazy-Load im Service ist pattern-konform.
- **Settings-Tab-Mechanik:** Tab-Registrierung, `actionType`-Dispatch in der `app.settings.tsx`-Action, AppSaveBar/`hasChanges`-Integration wie bei den bestehenden Tabs.

## Datenmodell (Prisma)

Das UI-Modell des Nutzers („ein Eintrag, pro Sprache eine gewünschte Übersetzung") 1:1 abgebildet — statt des flachen `GlossaryTerm` des feature-Branches:

```prisma
model GlossaryEntry {
  id             String   @id @default(cuid())
  shop           String
  sourceTerm     String   // Begriff in der Shop-Hauptsprache
  sourceLocale   String   // Hauptsprache zum Erfassungszeitpunkt
  doNotTranslate Boolean  @default(false) // true = in ALLEN Sprachen verbatim lassen
  caseSensitive  Boolean  @default(false)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  translations   GlossaryEntryTranslation[]

  @@unique([shop, sourceTerm, sourceLocale])
  @@index([shop])
}

model GlossaryEntryTranslation {
  id      String @id @default(cuid())
  entryId String
  entry   GlossaryEntry @relation(fields: [entryId], references: [id], onDelete: Cascade)
  locale  String
  value   String // gewünschte feste Übersetzung

  @@unique([entryId, locale])
  @@index([entryId])
}
```

Semantik:
- `doNotTranslate = true` → Begriff bleibt in allen Sprachen unverändert (per-Locale-Übersetzungen dann irrelevant/ausgeblendet).
- Übersetzung für Locale X vorhanden → „immer exakt so übersetzen".
- Keine Übersetzung für Locale X → keine Regel, AI übersetzt frei.

Migration: eine neue Migration `add_glossary` (beide Tabellen). Die Migration `20260518110000_add_glossary_term` des feature-Branches wird **nicht** übernommen.

## Zentrale AI-Injektion (Kernstück)

Neuer schlanker Loader + Builder (portiert aus `glossary.service.ts` des Branches, umgebaut aufs neue Modell), aufgerufen **innerhalb von `AIService`**, damit automatisch jeder Übersetzungspfad abgedeckt ist:

```ts
// src/services/glossary.service.ts (Port + Umbau)
buildGlossaryDirective(entries, sourceTexts: string[], targetLocales: string[]): string
// app/... CRUD bleibt getrennt (siehe UI-Phase)
```

In `AIService` (kennt `shop` im Konstruktor):

```ts
// einmal pro Instanz lazy geladen + gecacht (eine Instanz = ein Request/Task)
private glossaryEntries?: Promise<GlossaryEntryWithTranslations[]>;
private async getGlossaryDirective(sourceTexts: string[], targetLocales: string[]): Promise<string>
```

- **Matching:** nur Einträge, deren `sourceTerm` (case-insensitiv, außer `caseSensitive`) als Substring in einem der Quelltexte vorkommt. Bewusst **kein** Wortgrenzen-Matching (deutsche Komposita, HTML). Cap `MAX_TERMS_IN_PROMPT = 200` bleibt.
- **Block-Format** (aus dem Branch übernommen, inkl. „literal data"-Fencing):
  - `Do NOT translate these terms; keep them verbatim: "…", "…"`
  - `Always translate "Hinterbau" -> "triangle arrière" (fr)`
- **Injektionspunkte** (alle in [src/services/ai.service.ts](../../src/services/ai.service.ts), Block wird an die bestehenden Instructions/Requirements angehängt):

| Methode | Deckt ab |
|---|---|
| `translateFields` | Content-Editor „alle Felder / alle Sprachen" (via shopify-content.service) |
| `translateContent` | Einzelfeld-Übersetzung (api.ai) |
| `translateShortFieldsBatch` | Kurzfeld-Batches (api.ai) |
| `translateFieldsToLocalesBatch` (+ `Chunked` erbt) | Theme-Content |
| `translateBatchValues` | Direct Translations, Options/Grouped Fields |
| `translateAltTextsBatch` | Alt-Texte |
| `translateSEO` | SEO-Felder |

- **Bewusst ausgenommen (v1):** `translateSlug*` (ASCII-Slug-Regeln kollidieren mit festen Übersetzungen), `translateTemplate*` (Alt-Text-Templates, TPLVAR-Mechanik; geringer Nutzen).
- Das `withGlossary()`-Threading des feature-Branches in `translation.action.ts` wird **nicht** portiert (durch die zentrale Injektion überflüssig).

### Edge-Cases (müssen in die Implementierung)

1. **„Unchanged = failed"-Guard:** `translateContent` (ai.service.ts ~Z. 308–326) wertet identische Ausgabe als Fehlschlag. Besteht ein Feld **komplett** aus einem `doNotTranslate`-Begriff (z. B. Titel = Markenname), ist „unverändert" aber korrekt. Lösung: vor dem AI-Call prüfen — wenn der getrimmte Quelltext exakt ein `doNotTranslate`-Term ist, AI-Call überspringen und Quelle zurückgeben (spart zugleich Tokens).
2. **Grouped-Field-/OptionValue-Cache:** `GroupedFieldTranslation`/`OptionValueMemory` liefern gecachte Übersetzungen ohne AI-Call — Glossaränderungen wirken dort erst bei Neuübersetzung. V1: dokumentieren (Hinweis im Tab); optional später „Cache leeren"-Button.
3. **Locale-Filter:** Einträge, deren einzige Regel eine Übersetzung für nicht angefragte Locales ist, nicht injizieren (`doNotTranslate` gilt immer).

## Settings-UI

**Neuer Tab „Glossar"** (`id: "glossary"`, zwischen „Übersetzungen" und „Metafields") in [app.settings.tsx](../../app/routes/app.settings.tsx).

**`app/components/SettingsGlossaryTab.tsx`** (neu, das UI des feature-Branches wird nicht übernommen):

- **Locale-Buttons oben** wie in den Content-Editoren. [LocaleNavigationButtons.tsx](../../app/components/LocaleNavigationButtons.tsx) ist an `TranslatableItem`/Validation-Overlays/ReloadButton gekoppelt → **nicht direkt wiederverwenden**, sondern eine schlanke Leiste im selben Look (Polaris `Button size="slim"`, `variant="primary"` für aktive Locale, Suffix „(Hauptsprache)", `getLocalizedLanguageName()` aus [contentEditor.utils](../../app/utils/contentEditor.utils.ts) wiederverwenden). Die `shopLocales` liefert der Settings-Loader bereits (Query um `name`/`published` erweitern).
- **Hauptsprache aktiv:** Tabelle der Einträge — `sourceTerm` (TextField) · Checkbox „Nie übersetzen" · Checkbox „Groß-/Kleinschreibung beachten" · Löschen-Button. Darunter **„+ Begriff hinzufügen"**.
- **Fremdsprache aktiv:** pro Eintrag `sourceTerm` (readonly) → TextField „Gewünschte Übersetzung" (Placeholder: „leer = AI übersetzt frei"). Einträge mit `doNotTranslate` erscheinen mit Badge „wird nie übersetzt" und ohne Eingabefeld.
- **Speichern:** lokaler Draft-State; ein `actionType: "saveGlossary"` POST mit dem kompletten Entry-Set als JSON; Server upsertet in einer Transaktion (Diff gegen Bestand: create/update/delete). `hasChanges` in die bestehende AppSaveBar-Logik des Settings-Screens einhängen.
- **CSV Import/Export** (Buttons oben rechts): Export client-seitig (Pattern aus dem feature-Branch: Blob-Download, kein Top-Level-Navigate im Embedded-Iframe!); Import über `actionType: "importGlossary"`. Neues flaches CSV-Format: `sourceTerm,doNotTranslate,caseSensitive,locale,value` (eine Zeile pro Begriff×Locale; Zeile mit leerem `locale` = nur Begriff/Flags). Parser/Serializer aus dem Branch portieren (Limits: 1 MB / 5000 Zeilen).
- **i18n:** Keys in `de.ts`, `en.ts`, `es.ts` (`t.settings.glossary*`), inkl. Hinweistext „Das Glossar wird allen AI-Übersetzungen mitgegeben. Bereits übersetzte Inhalte ändern sich erst bei Neuübersetzung."

**Validierung** (Port aus dem Branch): max. 200 Zeichen, keine `"`/`->`/Control-Chars; zusätzlich Eintragslimit pro Shop (z. B. 500) als DoS-Guard.

**Optional (v2, nicht in diesem Wurf):** AI-Vorschlag-Button pro Fremdsprachen-Feld („Übersetzung vorschlagen", nutzt `translateContent`); Nutzungs-Statistik (welcher Begriff wie oft injiziert).

## Phasen

### Phase 1 — Backend (Modell + Service)
- [ ] Prisma: `GlossaryEntry` + `GlossaryEntryTranslation` + Migration
- [ ] `src/services/glossary.service.ts`: Port aus `origin/feature/glossary` (Validation, Sanitization/M1-Härtung, CSV) + Umbau auf Entry-Modell + `buildGlossaryDirective` mit Quelltext-Matching
- [ ] GDPR: beide Modelle in `redactShopData()` (Entry-Delete kaskadiert auf Translations)
- [ ] Unit-Tests portieren/erweitern: Validation, CSV-Roundtrip, Directive-Builder (Matching, caseSensitive, Locale-Filter, Cap, Injection-Härtung)

### Phase 2 — Zentrale AI-Injektion
- [ ] `AIService.getGlossaryDirective()` (lazy load + Instanz-Cache, dynamischer `db.server`-Import)
- [ ] Injektion in die 7 Methoden der Tabelle oben
- [ ] Edge-Case 1 (Quelltext == doNotTranslate-Term → AI-Call skippen)
- [ ] Tests: Prompt enthält Block nur bei Match; kein Block bei leerem Glossar; unveränderte Methoden-Signaturen

### Phase 3 — Settings-UI
- [ ] Loader: `glossaryEntries` + vollständige `shopLocales` (name, published)
- [ ] Action: `saveGlossary` (Transaktions-Diff-Upsert), `importGlossary`
- [ ] `SettingsGlossaryTab.tsx` (Locale-Leiste, Entry-Tabelle, +‑Button, Fremdsprachen-Ansicht, CSV-Buttons)
- [ ] Tab-Registrierung, i18n de/en/es, AppSaveBar-Integration

### Phase 4 — Abschluss
- [ ] Manuelle Verifikation: Begriff anlegen → Produkt übersetzen (Editor, api.ai-Einzelfeld, Theme-Content, Direct Translation) → feste Übersetzung/Verbatim prüfen; Translation-Probe-Tab (dev) zur Prompt-Sichtung nutzen
- [ ] `docs/COMPETITIVE_ANALYSIS.md`: Gap #2 als erledigt markieren (Pattern wie beim Switcher-Widget), `docs/ROADMAP.md` aktualisieren

## Offene Entscheidungen (mit Empfehlung)

1. **Slugs einbeziehen?** Empfehlung: v1 nein (ASCII-Konflikt); bei Bedarf später nur `doNotTranslate`-Begriffe.
2. **Eintragslimit pro Plan?** Empfehlung: v1 ein globales Limit (500), kein Plan-Gating — konsistent mit ungegatetem Übersetzen.
3. **AI-Vorschlag-Button im Tab?** Empfehlung: v2 — der manuelle Eintrag ist der Kern („so soll es übersetzt werden"), der Button ist Komfort.
