import { useState, useRef, useCallback, useEffect } from "react";
import { ProgressBar, Spinner, Text, Badge, BlockStack, InlineStack } from "@shopify/polaris";
import { useI18n } from "../contexts/I18nContext";
import {
  taskTypeLabel,
  resourceTypeLabel,
  fieldTypeLabel,
  taskSubjectLabel,
} from "../services/tasks/task-labels.shared";

interface RunningTaskPreview {
  id: string;
  type: string;
  status: string;
  resourceType: string | null;
  resourceTitle: string | null;
  fieldType: string | null;
  targetLocale: string | null;
  progress: number;
  processed: number | null;
  total: number | null;
  startedAt: string;
}

// Hover card shown on the "Tasks" navigation badge. Gives an at-a-glance list
// of the top running tasks (name / type / progress) without leaving the page.
// Heavy detail (prompts, results) is intentionally omitted — that lives on the
// /app/tasks page.
export function RunningTasksPreview({ count }: { count: number }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState<RunningTaskPreview[] | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inflightRef = useRef(false);
  const mountedRef = useRef(true);

  const fetchTasks = useCallback(async () => {
    if (inflightRef.current) return;
    inflightRef.current = true;
    setLoading(true);
    try {
      const res = await fetch("/api/running-tasks-list");
      if (res.ok) {
        const data = await res.json();
        // Guard against a fetch resolving after the component unmounted — the
        // badge is removed the moment the running count hits 0.
        if (mountedRef.current) {
          setTasks(data?.tasks ?? []);
          setTotalCount(data?.totalCount ?? (data?.tasks?.length ?? 0));
        }
      }
    } catch {
      // Silent — the badge count is the source of truth; the preview is a nicety.
    } finally {
      if (mountedRef.current) setLoading(false);
      inflightRef.current = false;
    }
  }, []);

  const handleEnter = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setOpen(true);
    fetchTasks();
  }, [fetchTasks]);

  const handleLeave = useCallback(() => {
    hideTimer.current = setTimeout(() => setOpen(false), 150);
  }, []);

  // Refresh the list while the card stays open so progress keeps moving.
  useEffect(() => {
    if (!open) return;
    const id = setInterval(fetchTasks, 2000);
    return () => clearInterval(id);
  }, [open, fetchTasks]);

  useEffect(() => () => {
    mountedRef.current = false;
    if (hideTimer.current) clearTimeout(hideTimer.current);
  }, []);

  const formatDuration = (startedAt: string) => {
    const ms = Date.now() - new Date(startedAt).getTime();
    if (ms < 0) return "0s";
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  };

  // Remaining tasks beyond the previewed slice. Derived from the endpoint's
  // own total so it stays consistent with the listed rows (not the separately
  // polled badge count).
  const extra = tasks ? Math.max(0, totalCount - tasks.length) : 0;
  const clampProgress = (p: number) => Math.max(0, Math.min(100, Math.round(p)));

  return (
    <div
      style={{ position: "relative", display: "inline-flex" }}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <div
        style={{
          backgroundColor: "#0066CC",
          color: "white",
          borderRadius: "10px",
          padding: "2px 8px",
          fontSize: "12px",
          fontWeight: 600,
          minWidth: "20px",
          textAlign: "center",
          cursor: "default",
        }}
      >
        {count}
      </div>

      {open && (
        <div
          // The panel is a DOM descendant of the navigation tab <button>, so a
          // click here would otherwise bubble up and navigate to /app/tasks
          // (and trip the unsaved-changes save bar).
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            left: "50%",
            transform: "translateX(-50%)",
            width: "320px",
            maxWidth: "90vw",
            background: "white",
            borderRadius: "12px",
            boxShadow: "0 8px 24px rgba(0,0,0,0.16)",
            border: "1px solid #e3e3e3",
            padding: "12px",
            zIndex: 1000,
          }}
        >
          <BlockStack gap="200">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="span" variant="headingSm" fontWeight="semibold">
                {t.tasks.runningPreviewTitle}
              </Text>
              {loading && tasks === null && <Spinner size="small" />}
            </InlineStack>

            {tasks !== null && tasks.length === 0 ? (
              <Text as="p" variant="bodySm" tone="subdued">
                {t.tasks.runningPreviewEmpty}
              </Text>
            ) : (
              <BlockStack gap="300">
                {(tasks ?? []).map((task) => {
                  const origin = resourceTypeLabel(task.resourceType, t);
                  const field = fieldTypeLabel(task.fieldType, t);
                  // The DECODED subject wins over the stored one. `seoBulkFix`
                  // writes a machine string into `resourceTitle`
                  // ("metaDescriptionMissing:fr", "fixAllForItem:product:8123"),
                  // which this card rendered verbatim while the Tasks page and
                  // the toast both named the problem — three surfaces, three
                  // names for one task. taskSubjectLabel answers null where it
                  // cannot decode (every `fixAllForItem:…` run), so the
                  // existing fallbacks stay exactly as they were.
                  const subject = taskSubjectLabel(task, t);
                  const name = subject || field || taskTypeLabel(task.type, t);
                  const progress = clampProgress(task.progress);
                  return (
                    <div key={task.id}>
                      <BlockStack gap="100">
                        <InlineStack align="space-between" blockAlign="center" gap="200" wrap={false}>
                          <div style={{ minWidth: 0 }}>
                            <Text as="span" variant="bodySm" fontWeight="medium" truncate>
                              {name}
                            </Text>
                          </div>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {progress}%
                          </Text>
                        </InlineStack>

                        <ProgressBar progress={progress} size="small" />

                        <InlineStack gap="150" blockAlign="center" wrap={false}>
                          <Badge tone="info" size="small">
                            {taskTypeLabel(task.type, t)}
                          </Badge>
                          <Text as="span" variant="bodyXs" tone="subdued" truncate>
                            {[origin, field, task.status === "running" ? formatDuration(task.startedAt) : null]
                              .filter(Boolean)
                              .join(" · ")}
                          </Text>
                        </InlineStack>
                      </BlockStack>
                    </div>
                  );
                })}

                {extra > 0 && (
                  <Text as="p" variant="bodyXs" tone="subdued">
                    {t.tasks.runningPreviewMore.replace("{n}", String(extra))}
                  </Text>
                )}
              </BlockStack>
            )}
          </BlockStack>
        </div>
      )}
    </div>
  );
}
