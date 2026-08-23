import { data as json, type LoaderFunctionArgs, type ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useRevalidator, useSearchParams } from "react-router";
import React, { useEffect, useState, useCallback, useRef } from "react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Button,
  ProgressBar,
  EmptyState,
  Select,
  Pagination,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { getTaskDateRange } from "~/config/constants";
import { taskErrorText } from "~/utils/task-error-text";
import { logger } from "~/utils/logger.server";
import { getFormString } from "~/utils/form-data.utils";
import {
  taskTypeLabel,
  resourceTypeLabel,
  fieldTypeLabel,
  taskSubjectLabel,
} from "~/services/tasks/task-labels.shared";
import { hasTaskDetails } from "~/services/tasks/task-details.shared";
import { WEBP_ITEM_TASK_TYPE } from "~/config/webp-tasks.js";
import { TaskDetailsPanel } from "~/components/tasks/TaskDetailsPanel";

/**
 * A `seoBulkFix` run that fixed EVERY problem of one item stores
 * `fixAllForItem:<itemType>:<numeric id>[:<locale>]` as its `resourceTitle`
 * (seo-bulk-fix.handler.ts L388). `taskSubjectLabel` answers `null` for it —
 * correctly, because the string names no dashboard problem code and a machine
 * string must never be rendered raw — but this card gates its WHOLE resource
 * row on that answer, so the card stopped naming the item it fixed at all.
 * Removing the machine string was right; removing the information was not.
 *
 * The string carries exactly the two facts a merchant needs, so they are read
 * out of it and phrased here rather than in `task-labels.shared.ts`, whose
 * current answer other callers (MainNavigation's toast) depend on: the
 * resource type through the same label map the badge uses, and the numeric id
 * — the one the Shopify admin URL carries.
 */
const FIX_ALL_FOR_ITEM_PREFIX = "fixAllForItem:";

function fixAllForItemSubject(
  task: { type?: string | null; resourceTitle?: string | null },
  t: any,
): string | null {
  if (task?.type !== "seoBulkFix") return null;
  const title = typeof task.resourceTitle === "string" ? task.resourceTitle.trim() : "";
  if (!title.startsWith(FIX_ALL_FOR_ITEM_PREFIX)) return null;
  // "<itemType>:<id>[:<locale>]" — the optional locale tail is ignored here;
  // the card already renders `targetLocale` on its own line.
  const [itemType, itemId] = title.slice(FIX_ALL_FOR_ITEM_PREFIX.length).split(":");
  if (!itemId) return null;
  const resource = resourceTypeLabel(itemType, t) ?? "";
  const template = typeof t?.tasks?.fixAllSubject === "string" ? t.tasks.fixAllSubject : "";
  if (!template) return resource ? `${resource} ${itemId}` : itemId;
  return template
    .replace("{resource}", resource)
    .replace("{id}", itemId)
    // A resource type the label map cannot name leaves a hole, never a
    // double space in the middle of the sentence.
    .replace(/\s{2,}/g, " ")
    .trim();
}


export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  try {
    const { db } = await import("../db.server");

    // Parse query parameters for filtering and pagination
    const url = new URL(request.url);
    const statusFilter = url.searchParams.get("status") || "all"; // all, completed, completed_with_errors, failed
    const hoursFilter = parseInt(url.searchParams.get("hours") || "24", 10); // 1, 6, 12, 24 (max 1 day)
    const page = parseInt(url.searchParams.get("page") || "1", 10);
    const pageSize = 20;

    // Build where clause
    const where: any = { shop: session.shop };

    // A WebP conversion is ONE merchant-facing task with N work items behind
    // it. The items carry the per-image job data the processor and the
    // recovery path need — they are not a report, and twenty of them for one
    // upload is what this filter exists to keep off the page.
    where.type = { not: WEBP_ITEM_TASK_TYPE };

    // Status filter. The three options are DISJOINT and "Successful" is
    // clean-only: it used to answer `{ in: ["completed", "completed_with_errors"] }`,
    // which hid the one status this page exists to surface — a run that saved
    // most of its work and lost the rest was filed under a label that claims
    // it lost nothing. "All Tasks" is still the union, so no row is
    // unreachable, and an unknown value falls through to no filter at all.
    if (statusFilter === "completed") {
      where.status = "completed";
    } else if (statusFilter === "completed_with_errors") {
      where.status = "completed_with_errors";
    } else if (statusFilter === "failed") {
      where.status = "failed";
    }

    // Date range filter (max 24 hours = 1 day)
    const dateFrom = getTaskDateRange(hoursFilter);
    where.createdAt = { gte: dateFrom };

    // Get total count for pagination
    const totalCount = await db.task.count({ where });

    // Get tasks with pagination.
    //
    // `prompt` and `result` are read but NEVER shipped: the page used to spread
    // the whole row, so 20 rows of full AI prompts INCLUDING their responses
    // plus every result blob crossed the wire on each visit and again on every
    // 3-second revalidation while a task ran — for the 19 cards nobody expanded.
    // The expanded card fetches them one at a time from /api/task-result.
    //
    // They stay in the SELECT because Prisma cannot compute `prompt IS NOT NULL`
    // (a select takes booleans, not expressions), and the cost that matters here
    // is the wire, not the query.
    const tasks = await db.task.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        type: true,
        status: true,
        resourceType: true,
        resourceId: true,
        resourceTitle: true,
        fieldType: true,
        targetLocale: true,
        progress: true,
        total: true,
        processed: true,
        error: true,
        aiModel: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
        updatedAt: true,
        expiresAt: true,
        prompt: true,
        result: true,
      },
    });

    // Sanitize tasks to prevent JSON serialization errors
    const sanitizedTasks = tasks.map(({ prompt, result, ...task }) => ({
      ...task,
      // Booleans only — `hasTaskDetails` answers "is there anything behind the
      // arrow" from these, so the payload never carries the text itself.
      hasPrompt: typeof prompt === "string" && prompt.length > 0,
      hasResult: typeof result === "string" && result.length > 0,
      error: task.error ? String(task.error) : null, // Full error message
      startedAt: task.startedAt.toISOString(),
      completedAt: task.completedAt ? task.completedAt.toISOString() : null,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
      expiresAt: task.expiresAt ? task.expiresAt.toISOString() : null,
    }));

    return json({
      tasks: sanitizedTasks,
      shop: session.shop,
      pagination: {
        page,
        pageSize,
        totalCount,
        totalPages: Math.ceil(totalCount / pageSize),
      },
      filters: {
        status: statusFilter,
        hours: hoursFilter,
      }
    });
  } catch (error: unknown) {
    logger.error("Failed to load tasks", { context: "TasksRoute", error: error instanceof Error ? error.message : String(error) });
    return json({
      tasks: [],
      shop: session.shop,
      error: "An internal error occurred",
      pagination: { page: 1, pageSize: 20, totalCount: 0, totalPages: 0 },
      filters: { status: "all", hours: 24 }
    }, { status: 500 });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const action = formData.get("action");
  const taskId = getFormString(formData, "taskId");
  if (!taskId) {
    return json({ success: false, error: "Missing required field: taskId" }, { status: 400 });
  }

  const { db } = await import("../db.server");

  if (action === "cancel") {
    try {
      await db.task.update({
        where: { id: taskId, shop: session.shop },
        data: { status: "cancelled", completedAt: new Date() },
      });
      return json({ success: true });
    } catch (error: unknown) {
      logger.error("Failed to cancel task", { context: "TasksRoute", taskId, error: error instanceof Error ? error.message : String(error) });
      return json({ success: false, error: "An internal error occurred" }, { status: 500 });
    }
  }

  if (action === "delete") {
    try {
      await db.task.delete({
        where: { id: taskId, shop: session.shop },
      });
      return json({ success: true });
    } catch (error: unknown) {
      logger.error("Failed to delete task", { context: "TasksRoute", taskId, error: error instanceof Error ? error.message : String(error) });
      return json({ success: false, error: "An internal error occurred" }, { status: 500 });
    }
  }

  return json({ success: false, error: "Unknown action" }, { status: 400 });
};

export default function TasksPage() {
  const loaderData = useLoaderData<typeof loader>();
  const { tasks, shop, pagination, filters } = loaderData;
  const error = 'error' in loaderData ? loaderData.error : undefined;
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  // Use ref for revalidator to avoid unstable reference in effect deps
  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const [expandedTaskIds, setExpandedTaskIds] = useState<Set<string>>(new Set());
  const [isClient, setIsClient] = useState(false);

  // Mark when we're on the client to avoid hydration mismatches with date formatting
  useEffect(() => {
    setIsClient(true);
  }, []);

  // Auto-refresh every 3 seconds if there are running tasks
  useEffect(() => {
    const hasRunningTasks = tasks.some((task: any) =>
      task.status === "pending" || task.status === "running"
    );

    if (hasRunningTasks) {
      const interval = setInterval(() => {
        revalidatorRef.current.revalidate();
      }, 3000);

      return () => clearInterval(interval);
    }
  }, [tasks]);

  // Handle filter changes
  const handleStatusFilterChange = useCallback((value: string) => {
    const params = new URLSearchParams(searchParams);
    params.set("status", value);
    params.set("page", "1"); // Reset to first page
    setSearchParams(params);
  }, [searchParams, setSearchParams]);

  const handleHoursFilterChange = useCallback((value: string) => {
    const params = new URLSearchParams(searchParams);
    params.set("hours", value);
    params.set("page", "1"); // Reset to first page
    setSearchParams(params);
  }, [searchParams, setSearchParams]);

  const handlePageChange = useCallback((direction: "previous" | "next") => {
    const params = new URLSearchParams(searchParams);
    const currentPage = pagination.page;
    const newPage = direction === "next" ? currentPage + 1 : currentPage - 1;
    params.set("page", newPage.toString());
    setSearchParams(params);
  }, [searchParams, setSearchParams, pagination.page]);

  const handleCancelTask = (taskId: string) => {
    fetcher.submit({ action: "cancel", taskId }, { method: "POST" });
  };

  const handleDeleteTask = (taskId: string) => {
    fetcher.submit({ action: "delete", taskId }, { method: "POST" });
  };

  const getStatusBadge = (status: string) => {
    const toneMap: Record<string, "success" | "info" | "warning" | "critical" | undefined> = {
      pending: "info",
      running: "info",
      completed: "success",
      completed_with_errors: "warning",
      failed: "critical",
      cancelled: "warning",
    };

    return (
      <Badge tone={toneMap[status]}>
        {(t.tasks.status as any)[status] || status}
      </Badge>
    );
  };

  const formatDuration = (startedAt: string, completedAt?: string | null) => {
    const start = new Date(startedAt);
    const end = completedAt ? new Date(completedAt) : new Date();
    const durationMs = end.getTime() - start.getTime();

    const seconds = Math.floor(durationMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  };

  const toggleTaskExpanded = (taskId: string) => {
    setExpandedTaskIds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(taskId)) {
        newSet.delete(taskId);
      } else {
        newSet.add(taskId);
      }
      return newSet;
    });
  };

  // Generate Shopify admin URL from resourceId and resourceType
  const getShopifyAdminUrl = (resourceId: string | null, resourceType: string | null): string | null => {
    if (!resourceId || !resourceType || !shop) return null;

    // Extract numeric ID from Shopify GID (e.g., "gid://shopify/Product/123456789" -> "123456789")
    const match = resourceId.match(/\/(\d+)$/);
    if (!match) return null;

    const numericId = match[1];

    // Map resourceType to Shopify admin path.
    //
    // Runners write this column in several spellings — `"products"`
    // (api.translate-alt-text-template.tsx), `"Product"`
    // (app.seo.performance.tsx), plus `"seo"` and `"templateTitles"`, which
    // name no single admin object at all. The lookup is therefore normalised
    // and the map lists every spelling EXPLICITLY: a type that is not in it
    // (site-wide SEO tasks, e-mail templates) yields no link, which is the
    // right answer — never a guessed, broken admin URL.
    const pathMap: Record<string, string> = {
      product: "products",
      products: "products",
      collection: "collections",
      collections: "collections",
      page: "pages",
      pages: "pages",
      blog: "articles", // Blog articles use /articles path
      blogs: "articles",
    };

    const path = pathMap[resourceType.trim().toLowerCase()];
    if (!path) return null;

    // Return full Shopify admin URL
    return `https://${shop}/admin/${path}/${numericId}`;
  };

  return (
    <Page fullWidth>
      {/* Page padding is owned globally by .Polaris-Page (responsive.css,
          --app-page-padding); .app-page-content zeroes Polaris' own
          Page__Content inset so the gutter is even on all sides (incl. top
          and bottom), matching the content page.

          .app-page-width caps and centres the FRAME (same reading width as the
          SEO sections — the value lives in responsive.css :root, never here),
          which leaves the frame's padding and its inner scroll container
          untouched. <Page fullWidth> stays: without it Polaris' own ~1000px
          cap would win before ours is ever reached. */}
      <div className="app-page-content app-page-width">
        <BlockStack gap="400">
          {/* Filters */}
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="400" wrap={false}>
                <div style={{ minWidth: "200px" }}>
                  <Select
                    label={t.tasks.statusFilter}
                    options={[
                      { label: t.tasks.statusOptions.all, value: "all" },
                      { label: t.tasks.statusOptions.completed, value: "completed" },
                      { label: t.tasks.statusOptions.partial, value: "completed_with_errors" },
                      { label: t.tasks.statusOptions.failed, value: "failed" },
                    ]}
                    value={filters.status}
                    onChange={handleStatusFilterChange}
                  />
                </div>
                <div style={{ minWidth: "200px" }}>
                  <Select
                    label={t.tasks.timeRangeFilter}
                    options={[
                      { label: t.tasks.timeRangeOptions.lastHour, value: "1" },
                      { label: t.tasks.timeRangeOptions.last6Hours, value: "6" },
                      { label: t.tasks.timeRangeOptions.last12Hours, value: "12" },
                      { label: t.tasks.timeRangeOptions.lastDay, value: "24" },
                    ]}
                    value={filters.hours.toString()}
                    onChange={handleHoursFilterChange}
                  />
                </div>
              </InlineStack>

              {/* Pagination Info */}
              {pagination.totalCount > 0 && (
                <Text as="p" variant="bodySm" tone="subdued">
                  {t.tasks.tasksFound.replace('{count}', pagination.totalCount.toString())} - {t.tasks.page} {pagination.page} {t.tasks.of} {pagination.totalPages}
                </Text>
              )}
            </BlockStack>
          </Card>

          {tasks.length === 0 ? (
            <Card>
              <EmptyState
                heading={t.tasks.noTasks}
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>{t.tasks.noTasksDescription}</p>
              </EmptyState>
            </Card>
          ) : (
            <BlockStack gap="300">
              {tasks.map((task: any) => {
                const isExpanded = expandedTaskIds.has(task.id);
                // Eight task types never go through the AI service and write a
                // result this app has no summariser for — their dropdown was
                // guaranteed to open onto nothing. Without details the card is
                // plain: no arrow, no pointer, no click target.
                const expandable = hasTaskDetails({
                  type: task.type,
                  hasPrompt: Boolean(task.hasPrompt),
                  hasResult: Boolean(task.hasResult),
                });
                const subject = taskSubjectLabel(task, t) ?? fixAllForItemSubject(task, t);
                const resourceLabel = resourceTypeLabel(task.resourceType, t);
                const fieldLabel = fieldTypeLabel(task.fieldType, t);
                return (
                <Card key={task.id}>
                  <BlockStack gap="300">
                    {/* Header. The expand affordance sits on the LEFT half
                        only, never on the row: the row also contains the
                        Cancel/Delete buttons, and a button nested inside a
                        `role="button"` is worse than no affordance at all.

                        It is a real control — `role`, `tabIndex`,
                        `aria-expanded` and Enter/Space — because without them
                        a keyboard or screen-reader user could not open ANY of
                        these panels. The glyph is `aria-hidden` (a screen
                        reader announces "▶" as "black right-pointing
                        triangle") and the control carries the words instead.

                        The glyph's slot is rendered whether or not the row is
                        expandable: the arrow appears the moment a running
                        task's first prompt lands, and a conditionally RENDERED
                        arrow shifted the heading sideways mid-revalidation. */}
                    <div>
                      <InlineStack align="space-between" blockAlign="center">
                        <div
                          {...(expandable
                            ? {
                                role: "button",
                                tabIndex: 0,
                                "aria-expanded": isExpanded,
                                "aria-label": isExpanded
                                  ? t.tasks.hideDetails
                                  : t.tasks.viewDetails,
                                onClick: () => toggleTaskExpanded(task.id),
                                onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    toggleTaskExpanded(task.id);
                                  }
                                },
                                style: { cursor: "pointer" },
                              }
                            : {})}
                        >
                          <InlineStack gap="200" blockAlign="center">
                            <Text as="span" variant="headingMd" fontWeight="medium">
                              <span
                                aria-hidden="true"
                                style={{ display: "inline-block", width: "1.25rem" }}
                              >
                                {expandable ? (isExpanded ? "▼" : "▶") : ""}
                              </span>
                            </Text>
                            <Text as="h2" variant="headingMd" fontWeight="semibold">
                              {taskTypeLabel(task.type, t)}
                            </Text>
                            {getStatusBadge(task.status)}
                          </InlineStack>
                        </div>
                        <div onClick={(e: React.MouseEvent) => e.stopPropagation()}>
                          <InlineStack gap="200">
                            {(task.status === "pending" || task.status === "running") && (
                              <Button
                                size="slim"
                                onClick={() => handleCancelTask(task.id)}
                                loading={fetcher.state !== "idle" && fetcher.formData?.get("taskId") === task.id && fetcher.formData?.get("action") === "cancel"}
                              >
                                {t.tasks.cancel}
                              </Button>
                            )}
                            {(task.status === "completed" || task.status === "completed_with_errors" || task.status === "failed" || task.status === "cancelled") && (
                              <Button
                                size="slim"
                                tone="critical"
                                onClick={() => handleDeleteTask(task.id)}
                                loading={fetcher.state !== "idle" && fetcher.formData?.get("taskId") === task.id && fetcher.formData?.get("action") === "delete"}
                              >
                                {t.tasks.delete}
                              </Button>
                            )}
                          </InlineStack>
                        </div>
                      </InlineStack>
                    </div>

                    {/* Resource Info - Always Visible.
                        Gated on the SUBJECT, not on the raw resourceTitle: the
                        seoBulkFix rows store a machine string, and a badge with
                        nothing beside it is an empty row. A "fix everything for
                        this item" run names no dashboard problem code, so
                        `taskSubjectLabel` answers null for it and
                        `fixAllForItemSubject` phrases the item instead — the
                        row must still say WHICH product was fixed. */}
                    {subject && (
                      <InlineStack gap="200">
                        {resourceLabel && <Badge tone="info">{resourceLabel}</Badge>}
                        {(() => {
                          const adminUrl = getShopifyAdminUrl(task.resourceId, task.resourceType);
                          if (adminUrl) {
                            return (
                              <a
                                href={adminUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{ color: "#008060", textDecoration: "none" }}
                                onClick={(e: React.MouseEvent) => e.stopPropagation()}
                              >
                                {subject}
                              </a>
                            );
                          }
                          return (
                            <Text as="p" variant="bodyMd">
                              {subject}
                            </Text>
                          );
                        })()}
                      </InlineStack>
                    )}

                    {/* Field Type - Always Visible */}
                    {fieldLabel && (
                      <Text as="p" variant="bodySm" tone="subdued">
                        {fieldLabel}
                        {task.targetLocale && ` → ${task.targetLocale}`}
                      </Text>
                    )}

                    {/* Progress Bar - Always Visible */}
                    {(task.status === "running" || task.status === "pending" || task.status === "queued") && (
                      <div>
                        <ProgressBar progress={task.progress} size="small" />
                        <Text as="p" variant="bodySm" tone="subdued">
                          {t.tasks.progress}: {task.progress}%
                          {task.total && task.processed !== undefined &&
                            ` (${task.processed}/${task.total})`}
                        </Text>
                      </div>
                    )}

                    {/* Time Info - Always Visible (only render after client mount to avoid hydration issues) */}
                    {isClient && (
                      <InlineStack gap="400">
                        <Text as="p" variant="bodySm" tone="subdued">
                          {t.tasks.startedAt}: {new Date(task.startedAt).toLocaleString()}
                        </Text>
                        {task.completedAt && (
                          <Text as="p" variant="bodySm" tone="subdued">
                            {t.tasks.duration}: {formatDuration(task.startedAt, task.completedAt)}
                          </Text>
                        )}
                        {!task.completedAt && task.status === "running" && (
                          <Text as="p" variant="bodySm" tone="subdued">
                            {t.tasks.duration}: {formatDuration(task.startedAt)}
                          </Text>
                        )}
                        {task.aiModel && (
                          <Text as="p" variant="bodySm" tone="subdued">
                            {task.aiModel}
                          </Text>
                        )}
                      </InlineStack>
                    )}

                    {/* Error Message - Always Visible */}
                    {task.error && (
                      <div style={{ padding: "0.75rem", background: "#fbeae5", borderRadius: "8px", border: "1px solid #d72c0d" }}>
                        <Text as="p" variant="bodySm" tone="critical">
                          {taskErrorText(task.error, t)}
                        </Text>
                      </div>
                    )}

                    {/* Expandable Details — result summary, failure list and
                        the AI prompt, in that order (what happened outranks how
                        it was asked for). Fetched on expand: the loader ships
                        neither prompt nor result. `updatedAt` is passed in so a
                        running task's log keeps filling in off the page's own
                        3-second revalidation, without a second timer; `status`
                        so a task that can never move again is never re-fetched
                        at all. */}
                    {expandable && isExpanded && (
                      <TaskDetailsPanel
                        taskId={task.id}
                        type={task.type}
                        status={task.status}
                        updatedAt={task.updatedAt}
                        isClient={isClient}
                      />
                    )}
                  </BlockStack>
                </Card>
                );
              })}

              {/* Pagination */}
              {pagination.totalPages > 1 && (
                <Card>
                  <div style={{ display: "flex", justifyContent: "center" }}>
                    <Pagination
                      hasPrevious={pagination.page > 1}
                      onPrevious={() => handlePageChange("previous")}
                      hasNext={pagination.page < pagination.totalPages}
                      onNext={() => handlePageChange("next")}
                      label={`${t.tasks.page} ${pagination.page} ${t.tasks.of} ${pagination.totalPages}`}
                    />
                  </div>
                </Card>
              )}
            </BlockStack>
          )}
        </BlockStack>
      </div>
    </Page>
  );
}
