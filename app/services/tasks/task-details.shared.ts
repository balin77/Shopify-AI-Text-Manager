/**
 * Task result summaries — pure, no i18n, no React, no server imports.
 *
 * Every runner already persists a structured `Task.result` JSON; none of it
 * was ever shown. This module turns one of those blobs into display lines,
 * PER TYPE and never generically.
 *
 * The rules below carry the weight:
 *
 *  1. **Per type, never a JSON dump.** A type with no registered summariser
 *     returns `null`. `pageSpeed` and `imageWebpConversionItem` deliberately
 *     have NO summariser: their `result` is the job INPUT, not an outcome, so a
 *     generic renderer would show a merchant an internal job spec. See the
 *     note above the registry — do not "fix that gap" for either.
 *
 *     `imageWebpConversion` used to be in that list for exactly the same
 *     reason and no longer is, which is the ONE distinction to keep straight
 *     here: a conversion run is now an aggregate row (`imageWebpConversion`,
 *     one per run) over N work items (`imageWebpConversionItem`, one per
 *     image). The items still hold the job spec and stay out; the aggregate
 *     holds a real outcome — `{converted, failed, total, failures[]}` — and is
 *     registered.
 *  2. **An absent key is OMITTED, never rendered as 0.** Old rows predate
 *     later fields, and a fabricated 0 is a wrong number — the same rule as
 *     `attributesSyncedAt` / `indexabilityKnown`. `galleryVideos` is the named
 *     three-valued case: key missing = not checked, `null` = the sweep failed,
 *     object = a result.
 *  3. **Never throws.** These rows can only be removed from the Tasks page,
 *     so a summariser that throws on a truncated blob would take away the one
 *     way to delete it.
 *  4. **A REGISTERED type may still answer `null`, and the consumer must
 *     tolerate that.** `hasTaskDetails` answers from the registry — i.e. from
 *     the type alone — while this function reads the blob, and several types
 *     are written by many runners with different shapes: the translation
 *     family stores a bare AI response string (`text-translation.handler.ts`
 *     L234), an ARRAY of per-locale AI responses (L1512), or the sentence
 *     `Translated to N locales` (`templates-translate-field.action.ts` L316);
 *     `ai-queue.service.ts` L700 truncates ANY recovered task's result to 500
 *     characters, which turns a valid blob into unparseable JSON. None of
 *     those is a summary, so `null` is the right answer and the page must
 *     render "details fetched, nothing to summarise" without drawing an empty
 *     box (PLAN §3.2 / §3.3).
 *  5. **The type is resolved through the SAME alias map the labels use.** This
 *     module otherwise imports nothing on purpose, and `TASK_TYPE_ALIASES` is
 *     the one import worth having: `bulkAIGeneration` / `bulkAiGeneration` is
 *     the one-letter split this whole feature exists to kill (PLAN §B2), and a
 *     registry looked up RAW would reintroduce it one layer down — a
 *     summariser registered under the i18n spelling would silently never fire
 *     for the rows the alt-text paths really create. A second copy of that map
 *     here is the same bug with an extra step, so it is imported from
 *     `task-labels.shared.ts`, which owns it.
 */

import { TASK_TYPE_ALIASES } from "./task-labels.shared";

export interface TaskSummaryLine {
  /** Key under `t.tasks.resultLabels` — the component looks it up. */
  labelKey: string;
  /** Already-formatted display text. Numbers arrive as strings. */
  value: string;
  tone?: "critical" | "warning";
}

export interface TaskFailureLine {
  /**
   * What failed. May be an empty string for runners that record an
   * unstructured error line (altTextTemplateApply) — render the message alone
   * in that case.
   */
  subject: string;
  message: string;
  /**
   * The same identity as `subject`, in PIECES, wherever this module really has
   * them. `subject` is a machine string by construction — an internal column id
   * (`field.seoTitle`, where the grid header says "SEO title"), the English
   * words `Product` / `Market` in a German UI, a bare locale code — and this
   * module is deliberately i18n-free, so it cannot be the one to fix that.
   * The RENDERER can: it holds the bundle, `resourceTypeLabel`, the column
   * descriptors and the locale names.
   *
   * `subject` stays exactly what it was, so a consumer that ignores `parts`
   * renders precisely what it rendered before — this is an addition, never a
   * replacement. Ids are the NUMERIC tail of a GID (`gid://shopify/Product/8123`
   * -> `8123`), which is the id the Shopify admin URL carries; a non-GID id is
   * passed through as it stands.
   */
  parts?: {
    rowType?: string;
    rowId?: string;
    columnId?: string;
    locale?: string;
    marketId?: string;
  };
}

export interface TaskResultSummary {
  lines: TaskSummaryLine[];
  failures: TaskFailureLine[];
}

type Blob = Record<string, unknown>;
type Summariser = (blob: Blob) => TaskResultSummary | null;

// ── helpers ─────────────────────────────────────────────────────────────────

/** Push a numeric line ONLY when the key really carries a number. */
function num(
  lines: TaskSummaryLine[],
  blob: Blob,
  key: string,
  labelKey: string,
  tone?: (v: number) => TaskSummaryLine["tone"],
): void {
  const v = blob[key];
  if (typeof v !== "number" || !Number.isFinite(v)) return;
  const t = tone?.(v);
  lines.push(t ? { labelKey, value: String(v), tone: t } : { labelKey, value: String(v) });
}

const criticalWhenPositive = (v: number): TaskSummaryLine["tone"] =>
  v > 0 ? "critical" : undefined;
const warningWhenPositive = (v: number): TaskSummaryLine["tone"] =>
  v > 0 ? "warning" : undefined;

/** A flag line ("the scan was capped") — only when the flag is really `true`. */
function flag(lines: TaskSummaryLine[], blob: Blob, key: string, labelKey: string): void {
  if (blob[key] === true) lines.push({ labelKey, value: "", tone: "warning" });
}

function text(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function arrayLength(v: unknown): number | null {
  return Array.isArray(v) ? v.length : null;
}

/**
 * `gid://shopify/Product/8123` -> `{type: "Product", id: "8123"}`; anything
 * that is not a Shopify GID answers `null`. A GID may carry a query string
 * (`?namespace=…` on a metafield), so the id stops at the first `?` or `#`.
 */
function parseGid(raw: string): { type: string; id: string } | null {
  const m = /^gid:\/\/shopify\/([A-Za-z]+)\/([^/?#]+)/.exec(raw);
  return m ? { type: m[1], id: m[2] } : null;
}

/**
 * A row id a merchant can act on: `gid://shopify/Product/8123` reads as
 * `Product 8123` — the numeric tail is the id the Shopify admin URL carries,
 * and the full GID is a machine string of exactly the kind PLAN §B4 exists to
 * remove from the UI. The row's own `rowType` names the thing when it has one
 * ("variant" is friendlier than the GID's `ProductVariant`); the GID's type
 * segment is the fallback. An id that is NOT a GID is already readable (a
 * policy handle, a composite key) and is passed through untouched.
 */
function readableRowId(rowId: string, rowType: string): string {
  const gid = parseGid(rowId);
  const word = rowType ? rowType.charAt(0).toUpperCase() + rowType.slice(1) : (gid?.type ?? "");
  const id = gid ? gid.id : rowId;
  return word ? `${word} ${id}`.trim() : id;
}

/**
 * `seoBulkMeta` stores the bulk editor's `BulkFailure[]` verbatim (`{rowId,
 * rowType, columnId?, locale?, marketId?, message}`); `columnId` is absent on
 * a ROW-level failure and `locale` on a primary-locale one. The
 * `bulkEditorTranslate` task stores a NARROWER copy of the same list —
 * `bulk-editor-translate.handler.ts` maps it down to `{rowId, columnId?,
 * message}` — so every optional field here is read defensively and the GID's
 * own type segment names the row when `rowType` did not travel.
 *
 * `marketId` is part of the SUBJECT because it is part of the identity: the
 * same cell in the same locale can fail once for the global layer and once for
 * a market override, and two failure lines a merchant cannot tell apart are
 * worth about as much as one. `marketId: ""` is the global layer and is NOT
 * shown — the bulk editor's own rule, where "" and a market GID are different
 * rows, not a missing value.
 */
function bulkFailures(v: unknown): TaskFailureLine[] {
  if (!Array.isArray(v)) return [];
  const out: TaskFailureLine[] = [];
  for (const entry of v) {
    if (!entry || typeof entry !== "object") continue;
    const f = entry as Blob;
    const rowId = readableRowId(text(f.rowId), text(f.rowType));
    const columnId = text(f.columnId);
    let subject = columnId ? `${rowId} · ${columnId}` : rowId;
    const scope: string[] = [];
    const locale = text(f.locale);
    if (locale) scope.push(locale);
    const marketId = text(f.marketId);
    if (marketId) {
      const market = parseGid(marketId);
      scope.push(market ? `${market.type} ${market.id}` : marketId);
    }
    if (scope.length > 0) subject = `${subject} [${scope.join(" · ")}]`;

    // The same identity in pieces, for a renderer that can name them (see
    // `TaskFailureLine.parts`). Every field is omitted where it is absent, so
    // `parts` never asserts a global layer ("" market) or a primary locale that
    // the blob did not record.
    const rowTypeRaw = text(f.rowType);
    const gid = parseGid(text(f.rowId));
    const parts: NonNullable<TaskFailureLine["parts"]> = {};
    if (rowTypeRaw) parts.rowType = rowTypeRaw;
    else if (gid) parts.rowType = gid.type;
    const idPart = gid ? gid.id : text(f.rowId);
    if (idPart) parts.rowId = idPart;
    if (columnId) parts.columnId = columnId;
    if (locale) parts.locale = locale;
    if (marketId) {
      const market = parseGid(marketId);
      parts.marketId = market ? market.id : marketId;
    }

    out.push(
      Object.keys(parts).length > 0
        ? { subject, message: text(f.message), parts }
        : { subject, message: text(f.message) },
    );
  }
  return out;
}

// ── summarisers ─────────────────────────────────────────────────────────────

/** CrawlSummary — crawl.service.ts L1376. */
const seoCrawl: Summariser = (blob) => {
  const lines: TaskSummaryLine[] = [];

  // A FAILED run writes a summary of eleven honest zeros plus an `error`
  // (crawl.service.ts L1463-1480: `status: "failed", error: "invalid_domain"`,
  // every count 0). Rendering those zeros as measurements tells a merchant
  // their storefront has no pages, no broken links and no head drift — a
  // confident report about a crawl that never left the gate. Only the reason
  // is a fact, so only the reason is shown.
  if (blob.status === "failed") {
    lines.push({ labelKey: "crawlFailedReason", value: text(blob.error), tone: "critical" });
    return { lines, failures: [] };
  }

  num(lines, blob, "pagesCrawled", "pagesCrawled");
  num(lines, blob, "totalDiscovered", "pagesDiscovered");
  num(lines, blob, "pagesOk", "pagesOk");
  num(lines, blob, "pagesBroken", "pagesBroken", criticalWhenPositive);
  num(lines, blob, "pagesServerError", "pagesServerError", criticalWhenPositive);
  num(lines, blob, "pagesBlocked", "pagesBlocked", warningWhenPositive);
  num(lines, blob, "orphanCount", "orphanPages");
  num(lines, blob, "headDriftCount", "headDrift");
  // The external-link pass is OPT-OUT (`AISettings.seoCrawlExternalLinks`,
  // crawl-run.server.ts L161-172). With it off the crawl still writes honest
  // numeric zeros, and "found: 0 / checked: 0 / dead: 0" then reads as "your
  // shop links nowhere and nothing is broken" — the reverse of what happened.
  // The blob carries no flag saying which of the two it was, so all three
  // lines are omitted when every one of them is 0: that is honest under BOTH
  // readings, and it is the same rule the crawl UI already follows ("with it
  // off the UI shows '—', never 0"). A run that really found links reports
  // them as before.
  const externalKeys = ["externalFound", "externalChecked", "externalBroken"] as const;
  const anyExternal = externalKeys.some((key) => {
    const v = blob[key];
    return typeof v === "number" && Number.isFinite(v) && v > 0;
  });
  if (anyExternal) {
    num(lines, blob, "externalFound", "externalFound");
    num(lines, blob, "externalChecked", "externalChecked");
    num(lines, blob, "externalBroken", "externalBroken", criticalWhenPositive);
  }
  // "dead: 1" while 440 targets were never reached is the crawler's own
  // "a missing row is indistinguishable from a healthy one" hazard, so the two
  // qualifiers ride along whenever they say something: an unchecked COUNT and
  // the fact that the pass ran out of its budget.
  const unchecked = blob.externalUnchecked;
  if (typeof unchecked === "number" && Number.isFinite(unchecked) && unchecked > 0) {
    lines.push({ labelKey: "externalUnchecked", value: String(unchecked), tone: "warning" });
  }
  flag(lines, blob, "externalTimedOut", "externalTimedOut");
  // `status: "capped"` is otherwise invisible — the crawl stopped at its page
  // limit, so every number above describes a prefix of the storefront.
  if (blob.status === "capped") {
    lines.push({ labelKey: "crawlCapped", value: "", tone: "warning" });
  }
  return { lines, failures: [] };
};

/** {averageScore, totalScanned, totalAvailable, capped} — seo-audit.handler.ts. */
const seoAudit: Summariser = (blob) => {
  const lines: TaskSummaryLine[] = [];
  // `{averageScore: 0, totalScanned: 0, …}` is what the handler writes when
  // EVERY locale scan failed (seo-audit.handler.ts L230-236) — the same
  // all-zero shape a failed crawl writes. A score of 0 over 0 scanned items is
  // not a bad score, it is no measurement at all, and the merchant reads it as
  // the former. The scanned count stays: "0 items scanned" is a true statement
  // about what happened.
  const scanned = blob.totalScanned;
  if (!(typeof scanned === "number" && scanned === 0)) {
    num(lines, blob, "averageScore", "averageScore");
  }
  num(lines, blob, "totalScanned", "itemsScanned");
  num(lines, blob, "totalAvailable", "itemsAvailable");
  flag(lines, blob, "capped", "capped");
  return { lines, failures: [] };
};

/** JsonLdAuditAggregate — json-ld-audit.service.ts L67. */
const seoJsonLdAudit: Summariser = (blob) => {
  const lines: TaskSummaryLine[] = [];
  num(lines, blob, "totalScanned", "itemsScanned");
  num(lines, blob, "totalAvailable", "itemsAvailable");
  flag(lines, blob, "capped", "capped");

  // Three-valued on purpose: key absent = the sweep predates this field and
  // never ran; `null` = it ran and failed (throttled/refused). Neither is a
  // finding, and "0 gallery videos" would be a confident false negative.
  const gv = blob.galleryVideos;
  if (gv && typeof gv === "object" && !Array.isArray(gv)) {
    const g = gv as Blob;
    num(lines, g, "totalProducts", "galleryVideoProducts");
    num(lines, g, "missingDate", "galleryVideosMissingDate", warningWhenPositive);
    num(lines, g, "mediaMissingDate", "mediaVideosMissingDate", warningWhenPositive);
    num(lines, g, "withVimeo", "galleryVideosVimeo", warningWhenPositive);
  }
  return { lines, failures: [] };
};

/**
 * BulkApplyResult — bulk-editor/columns.shared.ts L1388-1407.
 *
 * The two numbers count DIFFERENT THINGS and each line therefore names its own
 * unit. `saved` counts row GROUPS with no attributed failure (apply.server.ts
 * L3137-3141) while `failures` is per CELL, so a 40-row save where 3 rows fail
 * on 4 columns each is 37 rows and 12 cells — printed as "Saved: 37 / Failed:
 * 12" that is 49 of 40 rows, directly under the runner's own always-visible
 * `Task.error` string "3 of 40 row(s) failed". Neither number is wrong; the
 * unlabelled pairing was.
 */
const seoBulkMeta: Summariser = (blob) => {
  const lines: TaskSummaryLine[] = [];
  num(lines, blob, "saved", "savedRows");
  const failures = bulkFailures(blob.failures);
  const failedCount = arrayLength(blob.failures);
  if (failedCount !== null) {
    lines.push(
      failedCount > 0
        ? { labelKey: "failedFields", value: String(failedCount), tone: "critical" }
        : { labelKey: "failedFields", value: "0" },
    );
  }
  return { lines, failures };
};

/** {saved, failed, skippedHandles, failures[]} — bulk-editor-translate.handler.ts L386. */
const bulkEditorTranslate: Summariser = (blob) => {
  const lines: TaskSummaryLine[] = [];
  num(lines, blob, "saved", "translationsSaved");
  num(lines, blob, "failed", "failed", criticalWhenPositive);
  num(lines, blob, "skippedHandles", "skippedHandles");
  return { lines, failures: bulkFailures(blob.failures) };
};

/**
 * {succeeded[], failed[]} — seo-bulk-fix.handler.ts.
 * The runner has two failure shapes: `{type, id, error}` (the per-item and
 * per-job runners) and `{code, error}` (the single-item multi-code runner).
 * Both are handled; guessing one of them would drop the other's list.
 */
const seoBulkFix: Summariser = (blob) => {
  const lines: TaskSummaryLine[] = [];
  const succeeded = arrayLength(blob.succeeded);
  if (succeeded !== null) lines.push({ labelKey: "succeeded", value: String(succeeded) });
  const failedCount = arrayLength(blob.failed);
  if (failedCount !== null) {
    lines.push(
      failedCount > 0
        ? { labelKey: "failed", value: String(failedCount), tone: "critical" }
        : { labelKey: "failed", value: "0" },
    );
  }

  const failures: TaskFailureLine[] = [];
  if (Array.isArray(blob.failed)) {
    for (const entry of blob.failed) {
      if (!entry || typeof entry !== "object") continue;
      const f = entry as Blob;
      const type = text(f.type);
      const id = text(f.id);
      const code = text(f.code);
      // Same readability rule as the bulk failure list: `{type: "product",
      // id: "gid://shopify/Product/8123"}` reads as `Product 8123`. A `{code}`
      // entry is already a word.
      const subject = type || id ? readableRowId(id, type) : code;
      // Same pieces as the bulk failure list, for the renderer that can name
      // them. A `{code}` entry has no row identity at all and carries none.
      const gid = parseGid(id);
      const parts: NonNullable<TaskFailureLine["parts"]> = {};
      if (type) parts.rowType = type;
      else if (gid) parts.rowType = gid.type;
      const idPart = gid ? gid.id : id;
      if (idPart) parts.rowId = idPart;
      failures.push(
        Object.keys(parts).length > 0
          ? { subject, message: text(f.error), parts }
          : { subject, message: text(f.error) },
      );
    }
  }
  return { lines, failures };
};

/** {created, failed, skippedDrafts, skippedOverCap} — blog-article-redirects.server.ts L52. */
const blogArticleRedirects: Summariser = (blob) => {
  const lines: TaskSummaryLine[] = [];
  num(lines, blob, "created", "redirectsCreated");
  num(lines, blob, "failed", "failed", criticalWhenPositive);
  num(lines, blob, "skippedDrafts", "skippedDrafts");
  // Over the cap means those articles now 404 with no redirect — reported
  // nowhere else in the app.
  num(lines, blob, "skippedOverCap", "skippedOverCap", warningWhenPositive);
  return { lines, failures: [] };
};

/**
 * {applied, attempted, errors} — api.apply-alt-text-templates.tsx L417.
 * `errors` is a STRING ARRAY there, not a count (the plan's table says
 * "errors" without a type). Its length is the count; each entry is an
 * unstructured line of the form "<variant> (Position n, GID …): <message>",
 * split at the first "): " where that shape is present.
 */
const altTextTemplateApply: Summariser = (blob) => {
  const lines: TaskSummaryLine[] = [];
  num(lines, blob, "applied", "applied");
  num(lines, blob, "attempted", "attempted");

  const failures: TaskFailureLine[] = [];
  const errors = blob.errors;
  if (typeof errors === "number" && Number.isFinite(errors)) {
    lines.push(
      errors > 0
        ? { labelKey: "errors", value: String(errors), tone: "critical" }
        : { labelKey: "errors", value: "0" },
    );
  } else if (Array.isArray(errors)) {
    for (const entry of errors) {
      if (typeof entry !== "string" || !entry.trim()) continue;
      // GREEDY to the LAST "): " on the first line. The runner's shape is
      // `${variant.title} (Position n, GID gid://…): ${message}`
      // (api.apply-alt-text-templates.tsx L321-372) and a variant title may
      // itself contain brackets: non-greedy, `Blau (matt) / M (Position 3, GID
      // …): boom` split after `Blau (matt`, putting the rest of the title, the
      // position AND the GID into the merchant's error message.
      const match = entry.match(/^(.*\))\s*:\s*([\s\S]+)$/);
      if (match) failures.push({ subject: match[1].trim(), message: match[2].trim() });
      else failures.push({ subject: "", message: entry.trim() });
    }
    // COUNT WHAT IS LISTED. The line used to carry `errors.length` while the
    // loop skipped non-string and blank entries, so a blob the runner cannot
    // actually produce (but a truncated or hand-edited one can) said "3
    // errors" above an empty list — a number the merchant has no way to
    // reconcile with what is under it.
    lines.push(
      failures.length > 0
        ? { labelKey: "errors", value: String(failures.length), tone: "critical" }
        : { labelKey: "errors", value: "0" },
    );
  }
  return { lines, failures };
};

/** InternalLinksSummary — internal-links.service.ts L430-443. */
const seoInternalLinks: Summariser = (blob) => {
  const lines: TaskSummaryLine[] = [];
  num(lines, blob, "sourcesScanned", "sourcesScanned");
  num(lines, blob, "targetsConsidered", "targetsConsidered");
  num(lines, blob, "created", "suggestionsCreated");
  num(lines, blob, "updated", "suggestionsUpdated");
  num(lines, blob, "synonymRequests", "synonymRequests");
  flag(lines, blob, "cappedByPendingLimit", "internalLinksCapped");
  return { lines, failures: [] };
};

/**
 * ONE summariser for BOTH keyword-distribution stages — the task TYPE is the
 * same string for both, so the blob's own `stage` field is the discriminator
 * (keyword-distribution.handler.ts L61 / L79).
 */
const distributeKeywords: Summariser = (blob) => {
  const lines: TaskSummaryLine[] = [];
  if (blob.stage === "suggest") {
    num(lines, blob, "keywordCount", "keywords");
    num(lines, blob, "itemCount", "items");
    num(lines, blob, "batches", "batches");
    num(lines, blob, "failedBatches", "failedBatches", criticalWhenPositive);
    return { lines, failures: [] };
  }
  if (blob.stage === "apply") {
    num(lines, blob, "applied", "applied");
    num(lines, blob, "demotedToSecondary", "demotedToSecondary");
    num(lines, blob, "skipped", "skipped");
    num(lines, blob, "errors", "errors", criticalWhenPositive);
    return { lines, failures: [] };
  }
  return null;
};

/** {advised, total} — seo-robots-advice.handler.ts L79. */
const seoRobotsAdvice: Summariser = (blob) => {
  const lines: TaskSummaryLine[] = [];
  num(lines, blob, "advised", "rulesAdvised");
  num(lines, blob, "total", "rulesTotal");
  return { lines, failures: [] };
};

/** {file, chars} — ai-discovery-intro.handler.ts L86. `file` is "llms" | "agents". */
const AI_DISCOVERY_FILE_NAMES: Record<string, string> = {
  llms: "llms.txt",
  agents: "agents.md",
};

const aiDiscoveryIntro: Summariser = (blob) => {
  const lines: TaskSummaryLine[] = [];
  const file = text(blob.file);
  // A file NAME is not translatable text — it is the literal path served.
  if (file) lines.push({ labelKey: "file", value: AI_DISCOVERY_FILE_NAMES[file] ?? file });
  num(lines, blob, "chars", "characters");
  return { lines, failures: [] };
};

/**
 * `bulkAiGeneration` / `bulkAIGeneration` — ONE summariser for both spellings
 * and both blobs, because the two spellings are one task type (PLAN §B2) and
 * the registry resolves the alias before it looks up. The two runners that
 * share it write different shapes and are told apart by their own keys:
 *
 *   - `{generated, failed}` — the notification-title generator
 *     (template-titles.handler.ts L169), which creates the type as
 *     `bulkAiGeneration`.
 *   - `{generatedAltTexts, failedIndices}` — the bulk alt-text generator
 *     (alt-text.handler.ts L341/L364), which creates it as `bulkAIGeneration`.
 *     Its non-`/api/ai` twin (alt-text.action.ts L316) writes the same map
 *     WITHOUT `failedIndices`; that is an absent key, so it reports how many
 *     landed and claims nothing about what did not.
 *
 * `generatedAltTexts` is the PAYLOAD (the generated texts) and is not rendered,
 * the same rule that keeps `translations` off the screen; its key count is the
 * "how many landed" number the runner itself uses (L352).
 *
 * `failedIndices` is the only record anywhere of WHICH images failed — the
 * task's own `error` string carries a count and the last message, nothing per
 * image — so each index becomes a failure line. The stored index is ZERO-based
 * and merchants count from one, the same +1 the `altText_<n>` field label
 * applies in `task-labels.shared.ts`.
 */
const bulkAiGeneration: Summariser = (blob) => {
  const lines: TaskSummaryLine[] = [];
  const failures: TaskFailureLine[] = [];

  num(lines, blob, "generated", "generated");
  num(lines, blob, "failed", "failed", criticalWhenPositive);

  const generatedAltTexts = blob.generatedAltTexts;
  if (generatedAltTexts && typeof generatedAltTexts === "object" && !Array.isArray(generatedAltTexts)) {
    const landed = Object.values(generatedAltTexts as Blob).filter(
      (v) => typeof v === "string" && v.trim().length > 0,
    ).length;
    lines.push({ labelKey: "altTextsGenerated", value: String(landed) });
  }

  const failedIndices = blob.failedIndices;
  if (Array.isArray(failedIndices)) {
    const numbers: number[] = [];
    for (const entry of failedIndices) {
      if (typeof entry !== "number" || !Number.isFinite(entry)) continue;
      numbers.push(Math.trunc(entry) + 1);
    }
    lines.push(countedLine("imagesFailed", numbers.length, "critical"));
    for (const n of numbers) {
      // The message is empty on purpose: the runner keeps no per-image error
      // (only the LAST one, in `Task.error`), and inventing one would be a
      // sentence no runner wrote. `parts` hands the renderer the pieces so the
      // word in front of the number can be localised — `subject` is the
      // English fallback for a consumer that ignores it.
      failures.push({
        subject: `Image ${n}`,
        message: "",
        parts: { rowType: "image", rowId: String(n) },
      });
    }
  }

  if (lines.length === 0 && failures.length === 0) return null;
  return { lines, failures };
};

/**
 * The AGGREGATE row of a WebP conversion run — `{converted, failed, total,
 * failures[]}`, written by webp-processor.service.js as its items finish.
 *
 * Every number here is a RECOUNT of the item rows, so a running batch shows a
 * true partial count and a finished one shows the outcome. `total` is the image
 * count the run was started with and is the only key present before the first
 * item finishes; the counts appear as they become facts, which is why they are
 * pushed through `num` (an absent count is omitted, never a 0).
 *
 * The failure list is the only per-IMAGE record a merchant reaches from here:
 * the aggregate's own `error` carries the count and nothing else, and the item
 * rows that hold the full message are hidden from the Tasks list. An entry is
 * named by its POSITION in the product gallery (stored zero-based, counted from
 * one for a merchant, the same +1 as `altText_<n>` and `failedIndices`) and
 * falls back to the media GID's numeric tail — a picture the merchant can find
 * either way. `parts` hands the renderer the pieces so "Image" is translated;
 * `subject` is the English fallback for a consumer that ignores them.
 */
const imageWebpConversion: Summariser = (blob) => {
  const lines: TaskSummaryLine[] = [];
  num(lines, blob, "converted", "imagesConverted");
  num(lines, blob, "failed", "imagesFailed", criticalWhenPositive);
  num(lines, blob, "total", "imagesTotal");

  const failures: TaskFailureLine[] = [];
  if (Array.isArray(blob.failures)) {
    for (const entry of blob.failures) {
      if (!entry || typeof entry !== "object") continue;
      const f = entry as Blob;
      const position = f.position;
      const message = text(f.message);
      if (typeof position === "number" && Number.isFinite(position) && position >= 0) {
        const n = String(Math.trunc(position) + 1);
        failures.push({ subject: `Image ${n}`, message, parts: { rowType: "image", rowId: n } });
        continue;
      }
      const mediaId = text(f.mediaId);
      const gid = parseGid(mediaId);
      if (gid) {
        failures.push({
          subject: readableRowId(mediaId, "image"),
          message,
          parts: { rowType: "image", rowId: gid.id },
        });
        continue;
      }
      // Neither a position nor a resolvable media id: the message alone, which
      // is the documented empty-subject case. A row whose message is empty too
      // says nothing at all and is dropped rather than rendered as a blank
      // line under a red heading.
      if (message) failures.push({ subject: "", message });
    }
  }

  if (lines.length === 0 && failures.length === 0) return null;
  return { lines, failures };
};

/**
 * Does this entry of a per-locale map hold anything? A seeded-but-never-filled
 * `{}` is the shape the translation write path leaves behind for a locale that
 * reached nothing (see `translationFamily`), and it must not count as a
 * translated language.
 */
function hasContent(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value as Blob).length > 0;
  return false;
}

/** The string entries of an array — a locale list, cleaned. */
function stringList(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const entry of v) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

/**
 * `Record<locale, fieldKey[]>` (shopify-content.service.ts L1378-1379) as a
 * flat, order-preserving list. A non-object answers `null` (= omit the line);
 * a present-but-empty `{}` answers `[]`, which is a real "none", not a
 * missing key.
 */
function localeFieldGroups(v: unknown): { locale: string; fields: string[] }[] | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: { locale: string; fields: string[] }[] = [];
  for (const [locale, fields] of Object.entries(v as Blob)) {
    const names = stringList(fields);
    if (names && names.length > 0) out.push({ locale, fields: names });
  }
  return out;
}

function countedLine(
  labelKey: string,
  count: number,
  tone: TaskSummaryLine["tone"],
): TaskSummaryLine {
  return count > 0 ? { labelKey, value: String(count), tone } : { labelKey, value: String(count) };
}

/**
 * `translation` and `bulkTranslation` — ONE summariser for both, because the
 * two types are not two shapes: twenty call sites write them and the SAME blob
 * appears under either name (the sub-resource and alt-text paths write the
 * single-locale variant as `translation` and the all-locales variant as
 * `bulkTranslation`, from the same code).
 *
 * This is the family whose partial failure is already a STATUS
 * (`completed_with_errors`) with nothing behind it, so `failedLocales`,
 * `rejectedFields` and `skippedFields` are the point of the exercise: each is
 * a count LINE and a `failures` entry, so the merchant reads the locale codes
 * and the field names rather than "something failed".
 *
 * Detection is by which keys are present — no runner writes a discriminator.
 * The shapes found in the repo, all covered here:
 *   - `{translated, total}`                        direct-translation-ai.server.ts L118
 *   - `{retranslated, purged}`                     stale-translation-sync.server.ts L662
 *   - `{synced, failed, total}`                    api.grouped-field-translations.tsx L204
 *   - `{translatedCount, failedCount, targetLocale}`   sub-resources.action.ts L488
 *   - `{translatedLocales[], failedLocales[]}`     sub-resources.action.ts L689
 *   - `{success, locales[], failedLocales[], rejectedFields{}, skippedFields{}}`
 *                                                  translation.action.ts L380/L416
 *   - `{success, targetLocale, translations{}, failedLocales[], …}`
 *                                                  translation.action.ts L542/L578
 *   - `{translations{}, fieldType, failedLocales[], …}`  translation.action.ts L706
 *   - `{translatedAltTexts{}, imageIndex, targetLocales[], savedLocales[], failedLocales[]}`
 *                                                  alt-text.action.ts L514/L662
 *
 * Deliberately NOT rendered: `translations`, `translatedAltTexts` and
 * `translatedAltText` are the translated CONTENT. A payload is not a summary —
 * the same rule that keeps `imageWebpConversion` out of the registry. Their
 * key SETS are counted where the blob says what a key is (see below), and the
 * blobs that carry nothing else (a bare alt text, an array of AI responses, a
 * `Translated to N locales` sentence) answer `null` per rule 4 above.
 */
const translationFamily: Summariser = (blob) => {
  const lines: TaskSummaryLine[] = [];
  const failures: TaskFailureLine[] = [];

  // Read first, because the counts above depend on them: `locales` is the
  // TARGET list, not the achieved one (see below).
  const failedLocales = stringList(blob.failedLocales);
  const failedSet = new Set(failedLocales ?? []);
  const rejected = localeFieldGroups(blob.rejectedFields);
  const skipped = localeFieldGroups(blob.skippedFields);

  // ── what was done ────────────────────────────────────────────────────────
  num(lines, blob, "translated", "translated");
  num(lines, blob, "translatedCount", "translated");
  num(lines, blob, "synced", "synced");
  num(lines, blob, "retranslated", "retranslated");
  num(lines, blob, "purged", "purged");

  // `locales: Object.keys(allTranslations)` (translation.action.ts L382/L418)
  // is NOT the list of locales that worked, and subtracting `failedLocales`
  // does not make it one. shopify-content.service.ts L1381 SEEDS that map with
  // an empty object per target locale before the first AI call and fills it
  // ONLY from `allSaved` (L1818-1819) — where `savePerLocaleBatch`'s own
  // `failed` list is discarded, and `failedLocales` is pushed to from the AI
  // stages alone (L1733/L1753/L1759). So a locale whose every field SHOPIFY
  // refused stays a key with an empty map and appears in neither list: the
  // panel said "Languages translated: 3 / failed: 0" for a run where two
  // thirds reached nothing.
  //
  // The key NAMES therefore substantiate no number at all, and this module's
  // own rule is that an absent number beats a wrong one — so the line is
  // OMITTED for that shape. Where the blob carries the map itself, a locale
  // counts when its entry really holds something. `translatedLocales`
  // (sub-resources.action.ts L689) is a different key written pre-filtered by
  // its runner and stays countable.
  //
  // The write path is where this is really fixed (the save failures would have
  // to reach `failedLocales`); that is a runner decision, not a display one.
  const localesValue = blob.locales;
  const localeMap =
    localesValue && typeof localesValue === "object" && !Array.isArray(localesValue)
      ? (localesValue as Blob)
      : null;
  const translatedLocales = localeMap ? null : stringList(blob.translatedLocales);
  if (localeMap) {
    const achieved = Object.entries(localeMap).filter(
      ([locale, value]) => !failedSet.has(locale) && hasContent(value),
    );
    lines.push({ labelKey: "localesTranslated", value: String(achieved.length) });
  } else if (translatedLocales) {
    const achieved = translatedLocales.filter((locale) => !failedSet.has(locale));
    lines.push({ labelKey: "localesTranslated", value: String(achieved.length) });
  } else if (blob.translations && typeof blob.translations === "object" && !Array.isArray(blob.translations)) {
    // `translations` is a payload, but its KEY SET is a count — and WHICH
    // dimension it counts differs per runner, so it is only counted where the
    // blob itself says which: `fieldType` present = one field across locales
    // (translation.action.ts L706), `targetLocale` present = one locale across
    // fields (L542/L578). With neither, the keys are not countable as anything
    // and nothing is emitted.
    const map = blob.translations as Blob;
    // An entry is only a translation when it carries text: L695 fills
    // `flattened[locale] = fields[fieldType] || ""` for EVERY locale in the
    // seeded map, failures included.
    const filled = Object.entries(map).filter(
      ([, value]) => typeof value === "string" && value.trim().length > 0,
    );
    if (typeof blob.fieldType === "string") {
      const achieved = filled.filter(([locale]) => !failedSet.has(locale));
      lines.push({ labelKey: "localesTranslated", value: String(achieved.length) });
    } else if (typeof blob.targetLocale === "string") {
      // One locale: its keys are FIELDS. If that very locale failed, nothing
      // was saved and a field count would describe an AI answer nobody
      // received — no line at all rather than a number that reads as success.
      if (!failedSet.has(blob.targetLocale)) {
        lines.push({ labelKey: "fieldsTranslated", value: String(filled.length) });
      }
    }
  }

  const savedLocales = stringList(blob.savedLocales);
  if (savedLocales) lines.push({ labelKey: "localesSaved", value: String(savedLocales.length) });
  const targetLocales = stringList(blob.targetLocales);
  if (targetLocales) lines.push({ labelKey: "localesTargeted", value: String(targetLocales.length) });

  num(lines, blob, "total", "total");

  // ── what did not happen ──────────────────────────────────────────────────
  num(lines, blob, "failed", "failed", criticalWhenPositive);
  num(lines, blob, "failedCount", "failed", criticalWhenPositive);

  if (failedLocales) lines.push(countedLine("localesFailed", failedLocales.length, "critical"));

  if (rejected) {
    const count = rejected.reduce((n, g) => n + g.fields.length, 0);
    lines.push(countedLine("fieldsRejected", count, "critical"));
  }
  if (skipped) {
    const count = skipped.reduce((n, g) => n + g.fields.length, 0);
    // A skip is deliberate — shopify-content.service.ts L1424 skips a handle
    // whose translation equals the primary one, which is a routing conflict
    // avoided, not a loss. It is a WARNING count and deliberately NOT a
    // `failures` entry: that list renders as a red "failed items" box, and a
    // task that finished `completed` would open onto one.
    lines.push(countedLine("fieldsSkipped", count, "warning"));
  }

  // The list follows the order of the lines above. A locale whose REJECTED
  // fields are named is not listed a second time as a bare code — that entry
  // already carries the locale and says more.
  const named = new Set<string>((rejected ?? []).map((g) => g.locale));
  for (const locale of failedLocales ?? []) {
    // An empty subject is the documented "render the message alone" case: a
    // locale code with a trailing colon and nothing after it reads as a line
    // whose text failed to load.
    if (!named.has(locale)) failures.push({ subject: "", message: locale });
  }
  for (const group of rejected ?? []) {
    failures.push({ subject: group.locale, message: group.fields.join(", ") });
  }

  if (lines.length === 0 && failures.length === 0) return null;
  return { lines, failures };
};

// ── registry ────────────────────────────────────────────────────────────────

/**
 * TWO task types are ABSENT on purpose, for the same reason — their
 * `Task.result` holds the job INPUT, not an outcome, so a summariser here
 * would show a merchant an internal job spec. Do not "fix the gap":
 *
 *  - `imageWebpConversionItem` — `{sourceUrl, mediaId, productImageId,
 *    productId, altText, position, parentTaskId}` (api.convert-webp.tsx), the
 *    per-image work item of a conversion run. It is hidden from the Tasks list
 *    and the notifications anyway; a summariser for it would only be waiting
 *    for the day somebody unhides it.
 *  - `pageSpeed` — `{url, strategy}`, written IDENTICALLY at task creation
 *    (app.seo.performance.tsx L640) and at completion (L655); it is restore
 *    state, which that route's own loader reads back at L287 to re-attach the
 *    running audit. It calls PageSpeed Insights, not an AI provider, so it has
 *    no prompt either.
 *
 * `imageWebpConversion` is PRESENT, and used to be the first name on that list
 * — it named the per-image row and its result was the job spec above. It now
 * names the ONE aggregate row of a conversion run, whose result is an outcome,
 * so the reason for the exclusion moved to the item type with the job spec.
 */
const SUMMARISERS: Record<string, Summariser> = Object.assign(Object.create(null), {
  seoCrawl,
  seoAudit,
  seoJsonLdAudit,
  seoBulkMeta,
  bulkEditorTranslate,
  seoBulkFix,
  blogArticleRedirects,
  altTextTemplateApply,
  seoInternalLinks,
  distributeKeywords,
  seoRobotsAdvice,
  aiDiscoveryIntro,
  // ONE entry for both spellings — `bulkAIGeneration` reaches it through
  // TASK_TYPE_ALIASES, exactly as the label map does. Registering the second
  // spelling here as well would be the duplicated map this module refuses.
  bulkAiGeneration,
  imageWebpConversion,
  translation: translationFamily,
  bulkTranslation: translationFamily,
});

/**
 * The registry lookup, through the SAME alias map the labels use (rule 5 at
 * the top of this file). A raw lookup would register a summariser under one
 * spelling of a type created under another — the `bulkAIGeneration` /
 * `bulkAiGeneration` split, one layer below the labels where it was found.
 */
function summariserFor(type: unknown): Summariser | undefined {
  if (typeof type !== "string" || !type) return undefined;
  return SUMMARISERS[TASK_TYPE_ALIASES[type] ?? type] ?? SUMMARISERS[type];
}

export function summariseTaskResult(
  type: string,
  result: string | null | undefined,
): TaskResultSummary | null {
  if (typeof type !== "string" || !type) return null;
  if (typeof result !== "string" || !result.trim()) return null;

  const summarise = summariserFor(type);
  if (!summarise) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    // Truncated or malformed — these rows can only be deleted from the Tasks
    // page, so this must never throw.
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  try {
    const summary = summarise(parsed as Blob);
    if (!summary) return null;
    if (summary.lines.length === 0 && summary.failures.length === 0) return null;
    return summary;
  } catch {
    return null;
  }
}

/**
 * Does this task have anything to show behind the expand arrow?
 *
 * Takes BOOLEANS, not the payload: after §3.4 the list loader no longer ships
 * `prompt`/`result`, and this question still has to be answerable from the
 * row. That is also its limit: it answers from the REGISTRY, so `true` means
 * "this type can summarise SOME blob", never "this blob summarises". A
 * registered type whose stored result is a payload, a sentence or a truncated
 * blob still yields `null` from `summariseTaskResult` (rule 4 at the top of
 * this file) — the consumer must render that case without an empty box.
 *
 * It asks the registry through the alias map for the same reason the summary
 * does: the two must answer about the SAME type, or a row draws an arrow onto
 * nothing (or, worse, hides one that has content).
 */
export function hasTaskDetails(input: {
  type: string;
  hasPrompt: boolean;
  hasResult: boolean;
}): boolean {
  if (input?.hasPrompt === true) return true;
  return input?.hasResult === true && Boolean(summariserFor(input?.type));
}
