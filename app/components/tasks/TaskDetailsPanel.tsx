import { useEffect, useRef, useState } from "react";
import { BlockStack, Button, Text } from "@shopify/polaris";
import { useI18n } from "../../contexts/I18nContext";
import {
  type TaskFailureLine,
  type TaskResultSummary,
  type TaskSummaryLine,
} from "../../services/tasks/task-details.shared";
import { resourceTypeLabel } from "../../services/tasks/task-labels.shared";
import { getLocalizedLanguageName } from "../../utils/contentEditor.utils";
import { formatTime } from "../../utils/format";

/**
 * The expanded half of a card on /app/tasks (PLAN_TASK_LIST_CLARITY §3.3/§3.4).
 *
 * Three rules live here, each with a reason:
 *
 *  - **The list loader ships neither `prompt` nor `result`** — 20 rows of full
 *    AI prompts INCLUDING the responses crossed the wire on every visit and on
 *    every 3-second revalidation, for the 19 cards nobody expanded. So this
 *    panel fetches `/api/task-result?detail=1` on mount, i.e. once per expand.
 *  - **`updatedAt` is a PROP, and a change re-fetches — at most every 15s, and
 *    never once the task is finished.** A running AI task keeps appending to
 *    its prompt log; the page already revalidates every 3s while anything runs,
 *    so the moving value comes from the loader data the page already receives
 *    and no second polling timer is needed. But `updatedAt` moves on every
 *    prompt append AND every progress write, so an open card was re-downloading
 *    a monotonically growing, megabyte-sized prompt column every three seconds
 *    — precisely the payload this panel exists to keep off the wire. A TERMINAL
 *    status cannot move again, so a finished task is fetched exactly once.
 *  - **Result first, failures second, the prompt last.** What happened outranks
 *    how it was asked for. The prompt block below is the page's own former
 *    rendering, moved down unchanged.
 *  - **The summary arrives ALREADY SUMMARISED.** This panel used to receive
 *    the raw `result` blob and call `summariseTaskResult` itself, which for a
 *    `distributeKeywords`(suggest) row meant downloading its `suggestions[]`
 *    and `itemTitles{}` payload in order to render four numbers. The route
 *    runs the same pure function server-side and ships only its output; this
 *    component renders what it is given and parses nothing.
 *
 * An in-flight RE-fetch keeps the previous content on screen: the loading line
 * is for the first load only, or an open card would blink every three seconds.
 */

interface TaskDetailsPanelProps {
  taskId: string;
  type: string;
  /** Loader value. A finished task is never re-fetched — nothing can move. */
  status: string;
  /** Loader value. A change re-fetches while the card stays open (throttled). */
  updatedAt: string;
  /** From useHydrated(). Timestamps are only rendered in the merchant's local
   *  time after hydration — see app/utils/format.ts. */
  hydrated: boolean;
}

interface FetchedDetail {
  prompt: string | null;
  /** `null` = nothing to summarise, which is NOT an error. See below. */
  summary: TaskResultSummary | null;
}

/** The route's `resultSummary`, defensively — it crosses the wire as JSON. */
function readSummary(value: unknown): TaskResultSummary | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<TaskResultSummary>;
  if (!Array.isArray(candidate.lines) || !Array.isArray(candidate.failures)) return null;
  return { lines: candidate.lines, failures: candidate.failures };
}

/** Reads `t.tasks.resultLabels[key]` defensively — the bundle is `any`. */
function resultLabel(t: any, key: string): string {
  const value = t?.tasks?.resultLabels?.[key];
  return typeof value === "string" && value ? value : key;
}

/** Reads `t.bulkEditor.columns[key]` defensively — the bundle is `any`. */
function columnString(t: any, key: string): string | null {
  const value = t?.bulkEditor?.columns?.[key];
  return typeof value === "string" && value ? value : null;
}

/**
 * The bulk grid's OWN header label for a column id, so a failed cell is named
 * the way the merchant saw it named: `field.seoTitle` reads "SEO title", not
 * an internal column id.
 *
 * The id shapes are the contract documented on `ColumnDescriptor.id`
 * (bulk-editor/columns.shared.ts): "field.<name>" | "mf.<ns>.<key>" |
 * "mo.<type>.<fieldKey>" | "opt.<position>.<name|values>" | "var.<name>" |
 * "img.<name>". This resolves them from the ID ALONE because a failure blob
 * carries nothing else — `bulkColumnHeading()` needs the descriptor, which no
 * longer exists by the time a task row is read back.
 *
 * `null` means "not resolvable", never a guess: the caller then says "Field"
 * rather than printing a machine token.
 */
function columnHeadingForId(t: any, columnId: string): string | null {
  // Shop-defined name, rendered VERBATIM by the grid and never translated.
  if (columnId.startsWith("mf.")) return columnId.slice("mf.".length) || null;
  // The header shows the shop-defined FIELD NAME, which the id does not carry;
  // the field key is what travels, and is the grid's own fallback for it.
  if (columnId.startsWith("mo.")) return columnId.split(".").slice(2).join(".") || null;
  const option = /^opt\.(\d+)\.(name|values)$/.exec(columnId);
  if (option) {
    const template = columnString(t, option[2] === "name" ? "optionName" : "optionValues");
    return template ? template.replace("{position}", option[1]) : null;
  }
  // The two image columns whose label is not the tail of their id.
  if (columnId === "img.alt") return columnString(t, "imgAlt");
  if (columnId === "img.featuredAlt") return columnString(t, "featuredImgAlt");
  // "field.<name>" / "var.<name>" / a bare id — the label IS the tail.
  return columnString(t, columnId.replace(/^(?:field|var)\./, ""));
}

/**
 * One failure line's identity, in the merchant's language.
 *
 * `summariseTaskResult` is deliberately i18n-free, so its `subject` is a
 * machine string by construction — `Product 8123 · field.seoTitle [fr ·
 * Market 42]`, four machine tokens in a red box in a German UI. It hands the
 * same identity over in PIECES (`parts`), and this component holds everything
 * needed to name them: the bundle, the grid's column labels, the resource-type
 * map and `Intl`'s locale names.
 *
 * `parts` is an ADDITION, never a replacement — a blob that carries none (an
 * unstructured runner line) renders exactly the `subject` it always did.
 */
function failureSubject(failure: TaskFailureLine, t: any, appLocale: string): string {
  const parts = failure.parts;
  if (!parts) return failure.subject;

  const segments: string[] = [];

  if (parts.columnId) {
    segments.push(
      columnHeadingForId(t, parts.columnId) ??
        // The generic word beats a machine token. The raw id is the last
        // resort for a broken bundle only — losing the information entirely
        // would be worse than showing it unpolished.
        (typeof t?.tasks?.failureFieldFallback === "string" && t.tasks.failureFieldFallback
          ? t.tasks.failureFieldFallback
          : parts.columnId),
    );
  }

  // `resourceTypeLabel` humanises a type its map does not carry, which for
  // `image` — the bulk alt-text summariser's row type — is the English word
  // "Image" in a German UI, i.e. exactly the defect this composition exists to
  // remove. The tasks bundle names that one itself.
  const rowLabel = parts.rowType
    ? parts.rowType === "image" && typeof t?.tasks?.image === "string" && t.tasks.image
      ? t.tasks.image
      : resourceTypeLabel(parts.rowType, t)
    : null;
  const rowText = parts.rowId ? (rowLabel ? `${rowLabel} ${parts.rowId}` : parts.rowId) : rowLabel;
  if (rowText) segments.push(rowText);

  // Locale and market are the SCOPE of the failure, not part of the thing that
  // failed: the same cell can fail once globally and once per market.
  const scope: string[] = [];
  if (parts.locale) scope.push(getLocalizedLanguageName(parts.locale, appLocale));
  if (parts.marketId) {
    const template = typeof t?.tasks?.marketLabel === "string" ? t.tasks.marketLabel : "";
    scope.push(template ? template.replace("{id}", parts.marketId) : parts.marketId);
  }

  const head = segments.join(" · ");
  if (!head) return scope.length > 0 ? scope.join(", ") : failure.subject;
  return scope.length > 0 ? `${head} (${scope.join(", ")})` : head;
}

/** How many failed cells a 500-row bulk save may list before "+N more". */
const FAILURE_CAP = 20;
/** Prompts/responses are collapsed past this many characters. */
const TRUNCATE_LENGTH = 500;
/**
 * A task in one of these states can never write again, so its details are
 * fetched exactly once no matter how often the page revalidates.
 * `cancelled` is terminal too — the runner stops at its next checkpoint.
 */
const TERMINAL_STATUSES = new Set([
  "completed",
  "completed_with_errors",
  "failed",
  "cancelled",
]);
/**
 * Floor between two fetches of the SAME open card. The page revalidates every
 * 3s while anything runs and a running AI task's `updatedAt` moves on every
 * prompt append and every progress write; the prompt column grows
 * monotonically into the megabytes. The log still fills in, five times less
 * often.
 */
const MIN_REFETCH_MS = 15_000;

export function TaskDetailsPanel({
  taskId,
  type,
  status,
  updatedAt,
  hydrated,
}: TaskDetailsPanelProps) {
  const { t, locale: appLocale } = useI18n();
  const [detail, setDetail] = useState<FetchedDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  /** When the last request for THIS task was started (0 = never). */
  const lastFetchAtRef = useRef(0);
  /** The task the refs above describe — a different one starts over. */
  const fetchedTaskIdRef = useRef<string | null>(null);
  /** Whether the last request was made while the task was already finished. */
  const fetchedTerminalRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const isTerminal = TERMINAL_STATUSES.has(status);
    const firstForThisTask = fetchedTaskIdRef.current !== taskId;
    if (firstForThisTask) {
      lastFetchAtRef.current = 0;
      fetchedTerminalRef.current = false;
    } else if (isTerminal && fetchedTerminalRef.current) {
      // Read once in its final state, and that state cannot move again.
      return;
    }

    const run = async () => {
      fetchedTaskIdRef.current = taskId;
      fetchedTerminalRef.current = isTerminal;
      lastFetchAtRef.current = Date.now();
      if (!cancelled) setFailed(false);
      try {
        const res = await fetch(
          `/api/task-result?taskId=${encodeURIComponent(taskId)}&detail=1`,
          { headers: { Accept: "application/json" } },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = await res.json();
        const task = payload?.task;
        if (!task) throw new Error("no task in response");
        if (cancelled) return;
        setDetail({
          prompt: typeof task.prompt === "string" ? task.prompt : null,
          summary: readSummary(task.resultSummary),
        });
      } catch {
        // The card must never sit blank; the merchant sees detailsError.
        if (!cancelled) setFailed(true);
      }
    };

    const elapsed = Date.now() - lastFetchAtRef.current;
    // The FIRST fetch on expand is immediate, and so is the one that follows a
    // task FINISHING while its card is open: that transition is the moment the
    // result blob appears, and it is the last fetch there will ever be.
    // Everything in between is throttled.
    if (firstForThisTask || isTerminal || elapsed >= MIN_REFETCH_MS) {
      void run();
    } else {
      // Not dropped, deferred: the newest `updatedAt` is fetched as soon as
      // the floor is cleared, so the log still catches up on its own.
      timer = setTimeout(() => {
        void run();
      }, MIN_REFETCH_MS - elapsed);
    }

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [taskId, updatedAt, status]);

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const shouldTruncate = (text: string) => text.length > TRUNCATE_LENGTH;
  const truncateText = (text: string, id: string) =>
    !shouldTruncate(text) || expandedIds.has(id) ? text : text.substring(0, TRUNCATE_LENGTH);

  const showMoreLabel = (id: string, length: number) =>
    expandedIds.has(id)
      ? (t.tasks as any)?.showLess || "Show less"
      : `...${(t.tasks as any)?.showMore || "Show more"} (${length} chars)`;

  if (!detail) {
    return (
      <Text as="p" variant="bodySm" tone="subdued">
        {failed ? t.tasks?.detailsError : t.tasks?.detailsLoading}
      </Text>
    );
  }

  const summary = detail.summary;
  const prompt = detail.prompt;

  // Reached when the row promised details and the fetch SUCCEEDED, but this
  // particular blob summarised to nothing (the route answers `null`).
  // `hasTaskDetails` answers from the registry — "this type can summarise SOME
  // blob" — so a registered type whose row carries a payload, a bare AI string
  // or a result the recovery path truncated lands here legitimately. That is not an error and must not
  // be dressed as one: `detailsError` sends a merchant looking for a fault
  // that does not exist. The failed FETCH is handled above, where it belongs.
  if (!summary && !prompt) {
    return (
      <Text as="p" variant="bodySm" tone="subdued">
        {t.tasks?.detailsEmpty}
      </Text>
    );
  }

  const failures = summary?.failures ?? [];
  const shownFailures = failures.slice(0, FAILURE_CAP);
  const hiddenFailures = failures.length - shownFailures.length;

  const lineTone = (tone: TaskSummaryLine["tone"]) =>
    tone === "critical" ? ("critical" as const) : tone === "warning" ? ("caution" as const) : undefined;

  const lines = summary?.lines ?? [];

  // Two counts have a WORDED consequence, and the sentence already contains
  // the number: "Skipped (over the limit): 5" directly above "5 article(s) got
  // no redirect — their old URLs now return 404" said the same thing twice.
  // The sentence replaces its own count line — and only where it really
  // renders, so a plain 0 keeps its ordinary count line.
  //
  //  - `skippedOverCap`: those articles now 404, reported nowhere else.
  //  - `skippedHandles`: a deliberate skip nobody explained. The explanation
  //    exists, fully worded, on the page that starts the run.
  const sentenceTemplates: Record<string, { type: string; text: unknown; token: string }> = {
    skippedOverCap: {
      type: "blogArticleRedirects",
      text: t.tasks?.redirectsOverCap,
      token: "{n}",
    },
    skippedHandles: {
      type: "bulkEditorTranslate",
      text: (t as any)?.bulkEditor?.translateMissing?.skippedHandles,
      token: "{count}",
    },
  };

  const warningSentences: string[] = [];
  const shownLines = lines.filter((line) => {
    const spec = sentenceTemplates[line.labelKey];
    if (!spec || spec.type !== type) return true;
    if (!(Number(line.value) > 0)) return true;
    const template = typeof spec.text === "string" ? spec.text : "";
    if (!template) return true;
    warningSentences.push(template.replace(spec.token, line.value));
    return false;
  });

  // A `bulkEditorTranslate` run where nothing was missing writes
  // `{saved: 0, failed: 0, skippedHandles: 0}` — three zeros and no sentence,
  // which reads as a run that failed. It is the outcome the translate page
  // already has words for, so it says so in those words.
  const nothingToDo =
    type === "bulkEditorTranslate" &&
    lines.length > 0 &&
    failures.length === 0 &&
    lines.every((line) => line.value === "0");

  const hasResultBox = shownLines.length > 0 || warningSentences.length > 0 || nothingToDo;

  return (
    <BlockStack gap="300">
      {/* 1. Result summary */}
      {summary && hasResultBox && (
        <div
          style={{
            padding: "1rem",
            // Polaris' secondary surface — same rule as the failure box below:
            // this app states a colour literal in exactly one place, and it is
            // not this file.
            background: "var(--p-color-bg-surface-secondary, #f6f6f7)",
            borderRadius: "8px",
            border: "1px solid var(--app-surface-border-color, #e3e3e3)",
          }}
        >
          <BlockStack gap="200">
            <Text as="h3" variant="headingSm" fontWeight="semibold">
              {t.tasks?.resultHeading}
            </Text>
            <BlockStack gap="100">
              {nothingToDo ? (
                <Text as="p" variant="bodySm">
                  {t.tasks?.nothingToDo}
                </Text>
              ) : (
                shownLines.map((line, index) => (
                  <Text
                    as="p"
                    variant="bodySm"
                    key={`${line.labelKey}-${index}`}
                    tone={lineTone(line.tone)}
                  >
                    {/* An empty value is a FLAG sentence (the label says it
                        all), never "Label: " with nothing behind it. */}
                    {line.value
                      ? `${resultLabel(t, line.labelKey)}: ${line.value}`
                      : resultLabel(t, line.labelKey)}
                  </Text>
                ))
              )}
              {warningSentences.map((sentence, index) => (
                <Text as="p" variant="bodySm" tone="caution" key={`sentence-${index}`}>
                  {sentence}
                </Text>
              ))}
            </BlockStack>
          </BlockStack>
        </div>
      )}

      {/* 2. Failure list — for two task types this is the ONLY record of what
             went wrong anywhere in the app. */}
      {shownFailures.length > 0 && (
        <div
          style={{
            padding: "1rem",
            // Polaris' critical surface — the app states colour literals in
            // exactly one place (the root ErrorBoundary, which renders outside
            // the stylesheet's reach); everything else spends a token.
            background: "var(--p-color-bg-surface-critical, #fbeae5)",
            borderRadius: "8px",
            border: "1px solid var(--p-color-border-critical, #d72c0d)",
          }}
        >
          <BlockStack gap="200">
            <Text as="h3" variant="headingSm" fontWeight="semibold">
              {t.tasks?.failuresHeading}
            </Text>
            <BlockStack gap="100">
              {shownFailures.map((failure, index) => {
                const subject = failureSubject(failure, t, appLocale);
                // BOTH halves are optional and each is rendered alone rather
                // than with a dangling separator: `altTextTemplateApply`
                // records an unstructured line with no subject, and the bulk
                // alt-text summariser records a subject with no message (the
                // runner keeps no per-image error).
                return (
                  <Text as="p" variant="bodySm" key={`${subject}-${index}`}>
                    {subject && failure.message
                      ? `${subject}: ${failure.message}`
                      : subject || failure.message}
                  </Text>
                );
              })}
              {hiddenFailures > 0 && (
                <Text as="p" variant="bodySm" tone="subdued">
                  {String(t.tasks?.failuresMore ?? "").replace("{n}", String(hiddenFailures))}
                </Text>
              )}
            </BlockStack>
          </BlockStack>
        </div>
      )}

      {/* 3. AI prompt & response — the page's former rendering, relocated. */}
      {prompt && (
        <div
          style={{
            padding: "1rem",
            background: "#f0f7ff",
            borderRadius: "8px",
            border: "1px solid #b3d9ff",
          }}
        >
          <BlockStack gap="200">
            <Text as="h3" variant="headingSm" fontWeight="semibold">
              {t.tasks?.aiPrompt || "AI Prompt"}{" "}
              {(() => {
                try {
                  const parsed = JSON.parse(prompt);
                  if (Array.isArray(parsed)) {
                    return `(${parsed.length} ${t.tasks?.requests || "requests"})`;
                  }
                } catch {
                  // Not JSON, single prompt
                }
                return "";
              })()}
            </Text>
            <div style={{ maxHeight: "600px", overflowY: "auto" }}>
              {(() => {
                try {
                  const parsed = JSON.parse(prompt);
                  if (Array.isArray(parsed)) {
                    // New format: array of { timestamp, prompt, response? }
                    return (
                      <BlockStack gap="300">
                        {parsed.map(
                          (
                            entry: { timestamp: string; prompt: string; response?: string },
                            index: number,
                          ) => {
                            const promptId = `${taskId}-prompt-${index}`;
                            const responseId = `${taskId}-response-${index}`;
                            const promptTruncated = shouldTruncate(entry.prompt);
                            const responseTruncated = entry.response
                              ? shouldTruncate(entry.response)
                              : false;

                            return (
                              <div
                                key={index}
                                style={{
                                  padding: "0.75rem",
                                  background: "white",
                                  borderRadius: "4px",
                                  border: "1px solid #e5e5e5",
                                }}
                              >
                                <Text as="p" variant="bodySm" tone="subdued">
                                  #{index + 1} -{" "}
                                  {formatTime(entry.timestamp, hydrated, entry.timestamp)}
                                </Text>
                                <div
                                  style={{
                                    fontFamily: "monospace",
                                    fontSize: "11px",
                                    whiteSpace: "pre-wrap",
                                    marginTop: "0.5rem",
                                    maxHeight: "400px",
                                    overflowY: "auto",
                                  }}
                                >
                                  {truncateText(entry.prompt, promptId)}
                                  {promptTruncated && (
                                    <div style={{ marginTop: "0.5rem" }}>
                                      <Button
                                        size="slim"
                                        variant="plain"
                                        onClick={() => toggleExpanded(promptId)}
                                      >
                                        {showMoreLabel(promptId, entry.prompt.length)}
                                      </Button>
                                    </div>
                                  )}
                                </div>
                                {entry.response && (
                                  <div
                                    style={{
                                      marginTop: "0.5rem",
                                      padding: "0.5rem",
                                      background: "#f0fff4",
                                      borderRadius: "4px",
                                      border: "1px solid #9ae6b4",
                                    }}
                                  >
                                    <Text
                                      as="p"
                                      variant="bodySm"
                                      fontWeight="semibold"
                                      tone="success"
                                    >
                                      {t.tasks?.aiOutput || "AI Output"} #{index + 1}
                                    </Text>
                                    <div
                                      style={{
                                        fontFamily: "monospace",
                                        fontSize: "11px",
                                        whiteSpace: "pre-wrap",
                                        marginTop: "0.25rem",
                                        maxHeight: "400px",
                                        overflowY: "auto",
                                      }}
                                    >
                                      {truncateText(entry.response, responseId)}
                                      {responseTruncated && (
                                        <div style={{ marginTop: "0.5rem" }}>
                                          <Button
                                            size="slim"
                                            variant="plain"
                                            onClick={() => toggleExpanded(responseId)}
                                          >
                                            {showMoreLabel(responseId, entry.response.length)}
                                          </Button>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          },
                        )}
                      </BlockStack>
                    );
                  }
                } catch {
                  // Not JSON, display as single prompt
                }
                // Legacy format: single prompt string
                const legacyPromptId = `${taskId}-legacy-prompt`;
                const legacyTruncated = shouldTruncate(prompt);
                return (
                  <div style={{ padding: "0.75rem", background: "white", borderRadius: "4px" }}>
                    <div
                      style={{
                        fontFamily: "monospace",
                        fontSize: "12px",
                        whiteSpace: "pre-wrap",
                        maxHeight: "400px",
                        overflowY: "auto",
                      }}
                    >
                      {truncateText(prompt, legacyPromptId)}
                    </div>
                    {legacyTruncated && (
                      <div style={{ marginTop: "0.5rem" }}>
                        <Button
                          size="slim"
                          variant="plain"
                          onClick={() => toggleExpanded(legacyPromptId)}
                        >
                          {showMoreLabel(legacyPromptId, prompt.length)}
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          </BlockStack>
        </div>
      )}
    </BlockStack>
  );
}
