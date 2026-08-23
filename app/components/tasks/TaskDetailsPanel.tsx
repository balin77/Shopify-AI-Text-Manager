import { useEffect, useState } from "react";
import { BlockStack, Button, Text } from "@shopify/polaris";
import { useI18n } from "../../contexts/I18nContext";
import {
  summariseTaskResult,
  type TaskSummaryLine,
} from "../../services/tasks/task-details.shared";

/**
 * The expanded half of a card on /app/tasks (PLAN_TASK_LIST_CLARITY §3.3/§3.4).
 *
 * Three rules live here, each with a reason:
 *
 *  - **The list loader ships neither `prompt` nor `result`** — 20 rows of full
 *    AI prompts INCLUDING the responses crossed the wire on every visit and on
 *    every 3-second revalidation, for the 19 cards nobody expanded. So this
 *    panel fetches `/api/task-result?detail=1` on mount, i.e. once per expand.
 *  - **`updatedAt` is a PROP, and a change re-fetches.** A running AI task keeps
 *    appending to its prompt log; the page already revalidates every 3s while
 *    anything runs, so the moving value comes from the loader data the page
 *    already receives. No second polling timer.
 *  - **Result first, failures second, the prompt last.** What happened outranks
 *    how it was asked for. The prompt block below is the page's own former
 *    rendering, moved down unchanged.
 *
 * An in-flight RE-fetch keeps the previous content on screen: the loading line
 * is for the first load only, or an open card would blink every three seconds.
 */

interface TaskDetailsPanelProps {
  taskId: string;
  type: string;
  /** Loader value. A change re-fetches while the card stays open. */
  updatedAt: string;
  /** Timestamps are only formatted after mount, to avoid a hydration mismatch. */
  isClient: boolean;
}

interface FetchedDetail {
  prompt: string | null;
  result: string | null;
}

/** Reads `t.tasks.resultLabels[key]` defensively — the bundle is `any`. */
function resultLabel(t: any, key: string): string {
  const value = t?.tasks?.resultLabels?.[key];
  return typeof value === "string" && value ? value : key;
}

/** How many failed cells a 500-row bulk save may list before "+N more". */
const FAILURE_CAP = 20;
/** Prompts/responses are collapsed past this many characters. */
const TRUNCATE_LENGTH = 500;

export function TaskDetailsPanel({ taskId, type, updatedAt, isClient }: TaskDetailsPanelProps) {
  const { t } = useI18n();
  const [detail, setDetail] = useState<FetchedDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setFailed(false);

    (async () => {
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
          result: typeof task.result === "string" ? task.result : null,
        });
      } catch {
        // The card must never sit blank; the merchant sees detailsError.
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [taskId, updatedAt]);

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

  const summary = summariseTaskResult(type, detail.result);
  const prompt = detail.prompt;

  // Reached when the row promised details (hasTaskDetails) but the blob turned
  // out to be malformed or the prompt was cleared meanwhile. Never blank.
  if (!summary && !prompt) {
    return (
      <Text as="p" variant="bodySm" tone="subdued">
        {t.tasks?.detailsError}
      </Text>
    );
  }

  const failures = summary?.failures ?? [];
  const shownFailures = failures.slice(0, FAILURE_CAP);
  const hiddenFailures = failures.length - shownFailures.length;

  const lineTone = (tone: TaskSummaryLine["tone"]) =>
    tone === "critical" ? ("critical" as const) : tone === "warning" ? ("caution" as const) : undefined;

  // `skippedOverCap > 0` means those articles now 404 with no redirect — the
  // count alone does not say that anywhere, and it is reported nowhere else.
  const overCapLine =
    type === "blogArticleRedirects"
      ? summary?.lines.find((l) => l.labelKey === "skippedOverCap" && l.tone === "warning")
      : undefined;

  return (
    <BlockStack gap="300">
      {/* 1. Result summary */}
      {summary && summary.lines.length > 0 && (
        <div
          style={{
            padding: "1rem",
            background: "#f6f6f7",
            borderRadius: "8px",
            border: "1px solid var(--app-surface-border-color, #e3e3e3)",
          }}
        >
          <BlockStack gap="200">
            <Text as="h3" variant="headingSm" fontWeight="semibold">
              {t.tasks?.resultHeading}
            </Text>
            <BlockStack gap="100">
              {summary.lines.map((line, index) => (
                <Text
                  as="p"
                  variant="bodySm"
                  key={`${line.labelKey}-${index}`}
                  tone={lineTone(line.tone)}
                >
                  {/* An empty value is a FLAG sentence (the label says it all),
                      never "Label: " with nothing behind it. */}
                  {line.value
                    ? `${resultLabel(t, line.labelKey)}: ${line.value}`
                    : resultLabel(t, line.labelKey)}
                </Text>
              ))}
              {overCapLine && (
                <Text as="p" variant="bodySm" tone="caution">
                  {String(t.tasks?.redirectsOverCap ?? "").replace("{n}", overCapLine.value)}
                </Text>
              )}
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
            background: "#fbeae5",
            borderRadius: "8px",
            border: "1px solid #d72c0d",
          }}
        >
          <BlockStack gap="200">
            <Text as="h3" variant="headingSm" fontWeight="semibold">
              {t.tasks?.failuresHeading}
            </Text>
            <BlockStack gap="100">
              {shownFailures.map((failure, index) => (
                <Text as="p" variant="bodySm" key={`${failure.subject}-${index}`}>
                  {/* The subject may legitimately be empty (altTextTemplateApply
                      records an unstructured line) — no dangling separator. */}
                  {failure.subject ? `${failure.subject}: ${failure.message}` : failure.message}
                </Text>
              ))}
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
                                  {isClient
                                    ? new Date(entry.timestamp).toLocaleTimeString()
                                    : entry.timestamp}
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
