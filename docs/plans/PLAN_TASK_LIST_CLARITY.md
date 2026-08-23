# PLAN — Task list: details, labels and completion clarity

Status: proposed (2026-08-23). Scope: `/app/tasks`, the navigation badge's
hover card, and the completion notifications. No task RUNNER is changed — every
number this plan renders is already written to `Task.result` today.

---

## 0. Why

The Tasks tab was built when the only task was "translate this field with AI".
It now carries **23 task types**, most of them not AI at all, and three
assumptions from that first cut have quietly become wrong:

1. **The expand dropdown renders exactly one thing: `task.prompt`**
   ([app.tasks.tsx](../../app/routes/app.tasks.tsx) L506). That field is never
   set at `task.create` — it is back-filled by `AIService.savePromptToTask()`
   ([ai.service.ts](../../src/services/ai.service.ts) L1826), i.e. only when
   the task really goes through the AI service. The `▶` arrow is nevertheless
   rendered on **every** row, so eight task types offer a dropdown that is
   guaranteed to open onto nothing.
2. **Every runner writes a structured `result` JSON, and none of it is ever
   shown.** The loader selects it (L67, comment: "Include result for displaying
   AI output"), ships it to the client, and the JSX never touches it.
   `truncateTaskResult()` ([constants.ts](../../app/config/constants.ts) L300)
   is dead code. For two task types the per-cell failure list in `result` is
   the ONLY record of what went wrong anywhere in the app.
3. **The label maps have not kept up with the task types.** Nine types render
   their raw identifier, `resourceType: "seo"` (8 types) renders as the word
   "seo", and `seoBulkFix` shows a machine string as its subject line — the
   Tasks page never got the humanising logic that
   [MainNavigation.tsx](../../app/components/MainNavigation.tsx) grew for the
   toasts.

---

## 1. Inventory — what each task type actually has

Verified by extracting every `db.task.create()` call in the repo and checking
each runner for an `AIService` reference.

### 1.1 Has an AI prompt (dropdown has content today)

`translation`, `bulkTranslation`, `aiGeneration`, `bulkAIGeneration`,
`bulkAiGeneration`, `formatting`, `aiFormatting`, `insertKeyword`,
`seoBulkFix`, `bulkEditorTranslate`, `distributeKeywords`(suggest),
`seoInternalLinks`, `seoRobotsAdvice`, `aiDiscoveryIntro`

### 1.2 No AI call — the dropdown is guaranteed empty

`seoCrawl`, `seoAudit`, `seoJsonLdAudit`, `seoBulkMeta`, `altTextTemplateApply`,
`imageWebpConversion`, `blogArticleRedirects`, `distributeKeywords`(apply),
`pageSpeed`

`grep -c AIService` is 0 in all of these runners. `pageSpeed` calls PageSpeed
Insights, not an AI provider — the three `AIService` hits in
[app.seo.performance.tsx](../../app/routes/app.seo.performance.tsx) belong to
that route's separate alt-text `aiGeneration` task (L563), not to this one.

### 1.3 What sits in `result`, per type

| Type | `result` shape | Worth rendering |
|---|---|---|
| `seoBulkMeta` | `BulkApplyResult` = `{saved, failures:[{rowId, rowType, columnId?, locale?, marketId?, message}]}` | **Yes — highest value.** Failures are per CELL. The merchant sees only "3 of 40 row(s) failed"; which cell and why exists nowhere else. |
| `bulkEditorTranslate` | `{saved, failed, skippedHandles, failures[]}` | **Yes.** Same failure list, plus `skippedHandles` — a deliberate skip that is never explained anywhere. |
| `seoCrawl` | `CrawlSummary` = `{status, error?, pagesCrawled, totalDiscovered, pagesOk, pagesBroken, pagesServerError, pagesBlocked, blockedBy, orphanCount, headDriftCount, externalFound, externalChecked, externalBroken}` | **Yes.** Complete run summary. `status: "capped"` and `pagesBlocked` are otherwise invisible. |
| `blogArticleRedirects` | `{created, failed, skippedDrafts, skippedOverCap}` | **Yes.** `skippedOverCap > 0` means articles now 404 with no redirect — currently reported nowhere. |
| `seoAudit` | `{averageScore, totalScanned, totalAvailable, capped}` | **Yes.** `capped: true` = the scan was incomplete. |
| `seoJsonLdAudit` | `JsonLdAuditAggregate` = `{generatedAt, totalScanned, totalAvailable, capped, buckets[], galleryVideos?}` | **Yes** (counts + capped only; the buckets belong to the SEO section). `galleryVideos` is three-valued: `undefined` = not checked, `null` = the sweep failed, object = a result. Never render the first two as "none found". |
| `altTextTemplateApply` | `{applied, attempted, errors}` | Yes |
| `seoInternalLinks` | `InternalLinksSummary` = `{targetsConsidered, targetsWithSynonyms, synonymRequests, sourcesScanned, created, updated, cappedByPendingLimit}` | Yes |
| `seoBulkFix` | `{succeeded[], failed:[{type, id, error}]}` | Yes — counts + the failed list |
| `distributeKeywords`(suggest) | `DistributionSuggestResult` = `{stage, groupName, keywordCount, itemCount, batches, failedBatches, suggestions[], itemTitles{}}` | Counts only. `suggestions`/`itemTitles` are the SEO section's payload, not a task detail. |
| `distributeKeywords`(apply) | `DistributionApplyResult` = `{stage, applied, demotedToSecondary, skipped, errors}` | Yes |
| `seoRobotsAdvice` | `{advised, total}` | Yes |
| `aiDiscoveryIntro` | `{file, chars}` | Yes |
| `translation` (direct-translations) | `{translated, total}` | Yes |
| `translation` (stale-sync) | `{retranslated, purged}` | Yes |
| `pageSpeed` | `{url, strategy}` | **NO — the job INPUT again** ([app.seo.performance.tsx](../../app/routes/app.seo.performance.tsx) L640/L655, written identically at start and at finish). The route's own loader (L287) reads it to restore the active audit; it is state, not an outcome. |
| `imageWebpConversion` | `{sourceUrl, mediaId, productImageId, productId, altText, position}` | **NO — the job INPUT, not a result** ([api.convert-webp.tsx](../../app/routes/api.convert-webp.tsx) L132). A generic JSON dump would show a merchant an internal job spec. This is exactly why the renderer must be per type and never a `<pre>{result}</pre>`. |

---

## 2. Bugs found — clarity of "what is running / what finished"

### B1 — Nine task types render their raw identifier
`t.tasks.taskType` (identical key set in `en`/`de`/`es`) carries 14 keys.
Created but unlabelled: `bulkAIGeneration`, `aiFormatting`, `formatting`,
`insertKeyword`, `altTextTemplateApply`, `imageWebpConversion`,
`blogArticleRedirects`, `seoRobotsAdvice`, `aiDiscoveryIntro`.
The merchant reads the literal string `imageWebpConversion` as a card heading.
Affects the Tasks page AND `RunningTasksPreview`.

### B2 — Casing: `bulkAIGeneration` vs `bulkAiGeneration`
The alt-text paths create `bulkAIGeneration`
([alt-text.action.ts](../../app/actions/content/alt-text.action.ts) L247,
[alt-text.handler.ts](../../app/routes/api-ai-handlers/alt-text.handler.ts) L227)
while the i18n key is `bulkAiGeneration`. One letter — so every bulk alt-text
task falls through to the raw name. `MainNavigation` already special-cases both
spellings in its toast branch, which is how it stayed hidden.

Fix in the LABEL map (add the `bulkAIGeneration` spelling), never by renaming
the created type: running rows carry the old string, and
`LONG_RUNNING_TASK_TYPES` in
[task-recovery.service.js](../../task-recovery.service.js) matches on it.

### B3 — `completed_with_errors` never produces a notification
Four translation paths write that status
([translation.action.ts](../../app/actions/content/translation.action.ts)
L377/L413/L539,
[api.grouped-field-translations.tsx](../../app/routes/api.grouped-field-translations.tsx) L201),
but
[api.recently-completed-tasks.tsx](../../app/routes/api.recently-completed-tasks.tsx) L25
queries `status: { in: ["completed", "failed"] }`. A bulk translation where
three locales failed ends **completely silently**. `MainNavigation` already has
`partialTitle` / `partialSummary` for exactly this case — the row just never
reaches it.

`cancelled` stays excluded on purpose: the merchant pressed the button.

### B4 — The Tasks page does not share the toasts' humanising logic
[MainNavigation.tsx](../../app/components/MainNavigation.tsx) L108–L165 decodes
`seoBulkFix` subjects (`"metaDescriptionMissing:fr"` → the dashboard's problem
label), `allAltTexts` and `altText_<n>`. The Tasks page has none of it, so the
raw machine string is rendered as the card's subject with a `seo` badge next to
it. Two copies of one rule, already drifted.

Raw values reaching the UI unlabelled:
- `resourceType`: `"seo"` (8 types), `"Product"` (capitalised,
  [app.seo.performance.tsx](../../app/routes/app.seo.performance.tsx) L516),
  `"products"` (plural,
  [api.translate-alt-text-template.tsx](../../app/routes/api.translate-alt-text-template.tsx) L47),
  `"templateTitles"`
- `fieldType`: `allAltTexts`, `altText`, `altTextTemplate`, `sub-resources`,
  `direct-translations`, `autoTranslateExternalChange`, `suggest`, `apply`,
  `multi`, `robots`, `general`

### B5 — The loader ships every prompt and every result on each page load
`app.tasks.tsx` L64 spreads `...task`, so 20 rows' worth of full AI prompts
**including full AI responses** plus every `result` blob crosses the wire on
every visit and on every 3-second revalidation while a task runs — for the 19
cards nobody expands.

---

## 3. The change

### 3.1 One module owns task vocabulary — `app/services/tasks/task-labels.shared.ts`

Client-safe, import-free apart from `extractReadableName`. Pure functions, each
taking the already-resolved `t` bundle so no component reaches into i18n by
hand:

```
taskTypeLabel(type, t): string
resourceTypeLabel(resourceType, t): string | null
fieldTypeLabel(raw, t): string | null      // allAltTexts, altText_<n>, extractReadableName, raw
taskSubjectLabel(task, t): string | null   // seoBulkFix machine string → problem label; else resourceTitle
```

Rules:
- An unknown key falls back to a **humanised** form
  (`imageWebpConversion` → `Image WebP conversion`), never the raw identifier.
  A missing label then costs polish, not comprehension.
- `bulkAIGeneration` and `bulkAiGeneration` both resolve, from one entry.
- `MainNavigation`, `RunningTasksPreview` and `app.tasks.tsx` all call it.
  The toast branch in `MainNavigation` keeps its message wording; only the
  name-resolution moves.

### 3.2 One module decides whether a task HAS details — `app/services/tasks/task-details.shared.ts`

```
interface TaskSummaryLine { labelKey: string; value: string; tone?: "critical" | "warning" }
interface TaskFailureLine { subject: string; message: string }

summariseTaskResult(type, resultJson): { lines: TaskSummaryLine[]; failures: TaskFailureLine[] } | null
hasTaskDetails({ type, hasPrompt, hasResult }): boolean
```

- `summariseTaskResult` is **pure and per type**. A type with no entry returns
  `null` — that is what keeps `imageWebpConversion`'s job spec off the screen.
- Malformed / truncated JSON returns `null`. It must never throw: this renders
  rows a merchant cannot delete except through this page.
- A count that is **absent** from the blob is omitted, never rendered as 0 —
  the `attributesSyncedAt` rule. `galleryVideos: undefined | null` is the
  named case (§1.3).
- `hasTaskDetails` takes booleans, not the payload, so it still answers after
  §3.4 stops shipping `prompt`/`result` in the list.

### 3.3 The Tasks page renders the summary and drops the empty dropdown

- The `▶` arrow and the click target are rendered only when
  `hasTaskDetails(...)`. A row without details is a plain card.
- Expanded order: **result summary first, failure list second, AI prompt last.**
  What happened outranks how it was asked for.
- The failure list caps at 20 entries with "+N more" (a 500-row bulk save can
  fail 500 cells).
- The subject line uses `taskSubjectLabel`, the badges `resourceTypeLabel` /
  `fieldTypeLabel`.

### 3.4 Details load on expand

- Loader: replace `...task` with an explicit `select` that omits `prompt` and
  `result`; add `hasPrompt: boolean` and `hasResult: boolean`.
- [api.task-result.tsx](../../app/routes/api.task-result.tsx) gains an opt-in
  `detail=1` parameter that adds `prompt` to its `select`. Without it the
  response is byte-identical to today — `app.bulk_.translate.tsx` polls that
  route every second and must not start pulling prompts.
- The page fetches details once per expand, and re-fetches while the card is
  open when that task's `updatedAt` moves (the loader already revalidates every
  3 s while anything runs), so a running task's prompt log keeps filling in.

### 3.5 `completed_with_errors` reaches the notifications

- `api.recently-completed-tasks.tsx`: status filter becomes
  `["completed", "completed_with_errors", "failed"]`.
- `CompletedTask.status` in
  [TaskCountContext.tsx](../../app/contexts/TaskCountContext.tsx) widens to
  include it.
- `MainNavigation`: `completed_with_errors` maps to the existing `warning`
  tone + `partialTitle`. The existing `processed < total` and `errorText`
  branches stay — they cover types that report partial failure without setting
  that status.

---

## 4. Out of scope

- A **task-type filter** on the Tasks page. Genuinely useful with 23 types, but
  it is a new feature, not a clarity fix. Note it, do not build it here.
- Renaming any `Task.type` string (§B2).
- Anything inside a runner. Every number rendered here is already persisted.

---

## 5. Work split

| Phase | Files | Depends on |
|---|---|---|
| **P1** Label + details modules, all new i18n keys in `de`/`en`/`es` | `app/services/tasks/task-labels.shared.ts`, `task-details.shared.ts`, `app/i18n/{de,en,es}.ts` | — |
| **P2** Notification path | `api.recently-completed-tasks.tsx`, `TaskCountContext.tsx`, `MainNavigation.tsx` | P1 |
| **P3** Tasks page + hover card | `app.tasks.tsx`, `RunningTasksPreview.tsx`, `api.task-result.tsx` | P1 |
| **P4** Unit tests | `tests/unit/task-labels.test.ts`, `task-details.test.ts` | P1 |

P1 owns **all three i18n files** so P2/P3 never edit them — three agents
appending to one `tasks: {}` block is a merge conflict by construction.

## 6. Acceptance

- No task type renders a raw camelCase identifier anywhere (Tasks page, hover
  card, toast).
- `imageWebpConversion`, `pageSpeed` and `distributeKeywords`(apply) show no
  expand arrow.
- A `seoBulkMeta` run with failures lists the failed cells.
- A `completed_with_errors` bulk translation produces a warning notification.
- `npm run typecheck` and `npm run test` are green.
- The tasks-list loader payload no longer contains prompts or results.
