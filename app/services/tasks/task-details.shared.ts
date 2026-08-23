/**
 * Task result summaries — pure, no i18n, no React, no server imports.
 *
 * Every runner already persists a structured `Task.result` JSON; none of it
 * was ever shown. This module turns one of those blobs into display lines,
 * PER TYPE and never generically.
 *
 * Three rules carry the weight:
 *
 *  1. **Per type, never a JSON dump.** A type with no registered summariser
 *     returns `null`. `imageWebpConversion` and `pageSpeed` deliberately have
 *     NO summariser: their `result` is the job INPUT, not an outcome, so a
 *     generic renderer would show a merchant an internal job spec. See the
 *     note above the registry — do not "fix that gap" for either.
 *  2. **An absent key is OMITTED, never rendered as 0.** Old rows predate
 *     later fields, and a fabricated 0 is a wrong number — the same rule as
 *     `attributesSyncedAt` / `indexabilityKnown`. `galleryVideos` is the named
 *     three-valued case: key missing = not checked, `null` = the sweep failed,
 *     object = a result.
 *  3. **Never throws.** These rows can only be removed from the Tasks page,
 *     so a summariser that throws on a truncated blob would take away the one
 *     way to delete it.
 */

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
 * The bulk editor's `BulkFailure[]` (columns.shared.ts) and the bulk-editor
 * translate task's `failures[]` share a shape: `{rowId, columnId?, locale?,
 * message}`. `columnId` is absent on a ROW-level failure; `locale` is absent
 * on a primary-locale one.
 */
function bulkFailures(v: unknown): TaskFailureLine[] {
  if (!Array.isArray(v)) return [];
  const out: TaskFailureLine[] = [];
  for (const entry of v) {
    if (!entry || typeof entry !== "object") continue;
    const f = entry as Blob;
    const rowId = text(f.rowId);
    const columnId = text(f.columnId);
    let subject = columnId ? `${rowId} · ${columnId}` : rowId;
    const locale = text(f.locale);
    if (locale) subject = `${subject} [${locale}]`;
    out.push({ subject, message: text(f.message) });
  }
  return out;
}

// ── summarisers ─────────────────────────────────────────────────────────────

/** CrawlSummary — crawl.service.ts L1376. */
const seoCrawl: Summariser = (blob) => {
  const lines: TaskSummaryLine[] = [];
  num(lines, blob, "pagesCrawled", "pagesCrawled");
  num(lines, blob, "totalDiscovered", "pagesDiscovered");
  num(lines, blob, "pagesOk", "pagesOk");
  num(lines, blob, "pagesBroken", "pagesBroken", criticalWhenPositive);
  num(lines, blob, "pagesServerError", "pagesServerError", criticalWhenPositive);
  num(lines, blob, "pagesBlocked", "pagesBlocked", warningWhenPositive);
  num(lines, blob, "orphanCount", "orphanPages");
  num(lines, blob, "headDriftCount", "headDrift");
  num(lines, blob, "externalFound", "externalFound");
  num(lines, blob, "externalChecked", "externalChecked");
  num(lines, blob, "externalBroken", "externalBroken", criticalWhenPositive);
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
  num(lines, blob, "averageScore", "averageScore");
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

/** BulkApplyResult — bulk-editor/columns.shared.ts L1388-1407. */
const seoBulkMeta: Summariser = (blob) => {
  const lines: TaskSummaryLine[] = [];
  num(lines, blob, "saved", "saved");
  const failures = bulkFailures(blob.failures);
  const failedCount = arrayLength(blob.failures);
  if (failedCount !== null) {
    lines.push(
      failedCount > 0
        ? { labelKey: "failed", value: String(failedCount), tone: "critical" }
        : { labelKey: "failed", value: "0" },
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
      const subject = type || id ? `${type} ${id}`.trim() : code;
      failures.push({ subject, message: text(f.error) });
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
    lines.push(
      errors.length > 0
        ? { labelKey: "errors", value: String(errors.length), tone: "critical" }
        : { labelKey: "errors", value: "0" },
    );
    for (const entry of errors) {
      if (typeof entry !== "string" || !entry.trim()) continue;
      const match = entry.match(/^(.*?\))\s*:\s*([\s\S]+)$/);
      if (match) failures.push({ subject: match[1].trim(), message: match[2].trim() });
      else failures.push({ subject: "", message: entry.trim() });
    }
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
 * `translation` is written by several runners with DIFFERENT blobs. Only the
 * two that carry counts are summarised — detection is by which keys are
 * present, since neither carries a discriminator:
 *   - direct-translation-ai.server.ts L118: `{translated, total}`
 *   - stale-translation-sync.server.ts L662: `{retranslated, purged}`
 * Anything else returns null rather than guessing.
 */
const translation: Summariser = (blob) => {
  const lines: TaskSummaryLine[] = [];
  if (typeof blob.translated === "number" || typeof blob.total === "number") {
    num(lines, blob, "translated", "translated");
    num(lines, blob, "total", "total");
    return lines.length ? { lines, failures: [] } : null;
  }
  if (typeof blob.retranslated === "number" || typeof blob.purged === "number") {
    num(lines, blob, "retranslated", "retranslated");
    num(lines, blob, "purged", "purged");
    return lines.length ? { lines, failures: [] } : null;
  }
  return null;
};

// ── registry ────────────────────────────────────────────────────────────────

/**
 * TWO task types are ABSENT on purpose, for the same reason — their
 * `Task.result` holds the job INPUT, not an outcome, so a summariser here
 * would show a merchant an internal job spec. Do not "fix the gap":
 *
 *  - `imageWebpConversion` — `{sourceUrl, mediaId, productImageId, productId,
 *    altText, position}` (api.convert-webp.tsx L132).
 *  - `pageSpeed` — `{url, strategy}`, written IDENTICALLY at task creation
 *    (app.seo.performance.tsx L640) and at completion (L655); it is restore
 *    state, which that route's own loader reads back at L287 to re-attach the
 *    running audit. It calls PageSpeed Insights, not an AI provider, so it has
 *    no prompt either.
 */
const SUMMARISERS: Record<string, Summariser> = {
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
  translation,
};

export function summariseTaskResult(
  type: string,
  result: string | null | undefined,
): TaskResultSummary | null {
  if (typeof type !== "string" || !type) return null;
  if (typeof result !== "string" || !result.trim()) return null;

  const summarise = SUMMARISERS[type];
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
 * row.
 */
export function hasTaskDetails(input: {
  type: string;
  hasPrompt: boolean;
  hasResult: boolean;
}): boolean {
  if (input?.hasPrompt === true) return true;
  return input?.hasResult === true && Boolean(SUMMARISERS[input?.type]);
}
