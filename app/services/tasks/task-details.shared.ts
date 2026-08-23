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
      // Same readability rule as the bulk failure list: `{type: "product",
      // id: "gid://shopify/Product/8123"}` reads as `Product 8123`. A `{code}`
      // entry is already a word.
      const subject = type || id ? readableRowId(id, type) : code;
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
    for (const entry of errors) {
      if (typeof entry !== "string" || !entry.trim()) continue;
      const match = entry.match(/^(.*?\))\s*:\s*([\s\S]+)$/);
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

  // `locales: Object.keys(allTranslations)` (translation.action.ts L418) is NOT
  // the list of locales that worked: shopify-content.service.ts L1381 SEEDS
  // that map with an empty object per target locale before the first AI call,
  // so a locale that failed outright stays in the key set and only
  // `failedLocales` records it. Reporting its length as "languages translated"
  // printed "3" directly above "2 failed" — a fabricated count, the rule-2
  // failure mode one level up. The failed ones are subtracted here, which also
  // costs nothing where the runner already excluded them
  // (sub-resources.action.ts L689 writes `translatedLocales` pre-filtered).
  const translatedLocales = stringList(blob.locales) ?? stringList(blob.translatedLocales);
  if (translatedLocales) {
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
  translation: translationFamily,
  bulkTranslation: translationFamily,
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
 * row. That is also its limit: it answers from the REGISTRY, so `true` means
 * "this type can summarise SOME blob", never "this blob summarises". A
 * registered type whose stored result is a payload, a sentence or a truncated
 * blob still yields `null` from `summariseTaskResult` (rule 4 at the top of
 * this file) — the consumer must render that case without an empty box.
 */
export function hasTaskDetails(input: {
  type: string;
  hasPrompt: boolean;
  hasResult: boolean;
}): boolean {
  if (input?.hasPrompt === true) return true;
  return input?.hasResult === true && Boolean(SUMMARISERS[input?.type]);
}
