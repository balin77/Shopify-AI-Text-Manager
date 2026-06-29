import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useRevalidator, useSearchParams } from "@remix-run/react";
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
import { extractReadableName } from "~/utils/templates-field-factory";
import { logger } from "~/utils/logger.server";
import { getFormString } from "~/utils/form-data.utils";


export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  try {
    const { db } = await import("../db.server");

    // Parse query parameters for filtering and pagination
    const url = new URL(request.url);
    const statusFilter = url.searchParams.get("status") || "all"; // all, completed, failed
    const hoursFilter = parseInt(url.searchParams.get("hours") || "24", 10); // 1, 6, 12, 24 (max 1 day)
    const page = parseInt(url.searchParams.get("page") || "1", 10);
    const pageSize = 20;

    // Build where clause
    const where: any = { shop: session.shop };

    // Status filter
    if (statusFilter === "completed") {
      where.status = { in: ["completed", "completed_with_errors"] };
    } else if (statusFilter === "failed") {
      where.status = "failed";
    }

    // Date range filter (max 24 hours = 1 day)
    const dateFrom = getTaskDateRange(hoursFilter);
    where.createdAt = { gte: dateFrom };

    // Get total count for pagination
    const totalCount = await db.task.count({ where });

    // Get tasks with pagination
    const tasks = await db.task.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    // Sanitize tasks to prevent JSON serialization errors
    const sanitizedTasks = tasks.map(task => ({
      ...task,
      result: task.result, // Include result for displaying AI output
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
  const [expandedPromptIds, setExpandedPromptIds] = useState<Set<string>>(new Set());
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

  const togglePromptExpanded = (promptId: string) => {
    setExpandedPromptIds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(promptId)) {
        newSet.delete(promptId);
      } else {
        newSet.add(promptId);
      }
      return newSet;
    });
  };

  // Helper to truncate text if too long
  const TRUNCATE_LENGTH = 500;
  const shouldTruncate = (text: string) => text.length > TRUNCATE_LENGTH;
  const truncateText = (text: string, id: string) => {
    const isExpanded = expandedPromptIds.has(id);
    if (!shouldTruncate(text) || isExpanded) {
      return text;
    }
    return text.substring(0, TRUNCATE_LENGTH);
  };

  // Generate Shopify admin URL from resourceId and resourceType
  const getShopifyAdminUrl = (resourceId: string | null, resourceType: string | null): string | null => {
    if (!resourceId || !resourceType || !shop) return null;

    // Extract numeric ID from Shopify GID (e.g., "gid://shopify/Product/123456789" -> "123456789")
    const match = resourceId.match(/\/(\d+)$/);
    if (!match) return null;

    const numericId = match[1];

    // Map resourceType to Shopify admin path
    const pathMap: Record<string, string> = {
      product: "products",
      collection: "collections",
      page: "pages",
      blog: "articles", // Blog articles use /articles path
    };

    const path = pathMap[resourceType];
    if (!path) return null;

    // Return full Shopify admin URL
    return `https://${shop}/admin/${path}/${numericId}`;
  };

  return (
    <Page fullWidth>
      {/* Page padding is owned globally by .Polaris-Page (responsive.css,
          --app-page-padding); .app-page-content zeroes Polaris' own
          Page__Content inset so the gutter is even on all sides (incl. top
          and bottom), matching the content page. */}
      <div className="app-page-content">
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
                return (
                <Card key={task.id}>
                  <BlockStack gap="300">
                    {/* Header - Clickable to expand/collapse */}
                    <div
                      onClick={() => toggleTaskExpanded(task.id)}
                      style={{ cursor: "pointer" }}
                    >
                      <InlineStack align="space-between" blockAlign="center">
                        <InlineStack gap="200" blockAlign="center">
                          <Text as="span" variant="headingMd" fontWeight="medium">
                            {isExpanded ? "▼" : "▶"}
                          </Text>
                          <Text as="h2" variant="headingMd" fontWeight="semibold">
                            {(t.tasks.taskType as any)[task.type] || task.type}
                          </Text>
                          {getStatusBadge(task.status)}
                        </InlineStack>
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

                    {/* Resource Info - Always Visible */}
                    {task.resourceTitle && (
                      <InlineStack gap="200">
                        {task.resourceType && (
                          <Badge tone="info">
                            {(t.tasks.resourceType as any)[task.resourceType] || task.resourceType}
                          </Badge>
                        )}
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
                                {task.resourceTitle}
                              </a>
                            );
                          }
                          return (
                            <Text as="p" variant="bodyMd">
                              {task.resourceTitle}
                            </Text>
                          );
                        })()}
                      </InlineStack>
                    )}

                    {/* Field Type - Always Visible */}
                    {task.fieldType && (
                      <Text as="p" variant="bodySm" tone="subdued">
                        {t.tasks.fieldType && (t.tasks.fieldType as any)[task.fieldType]
                          ? (t.tasks.fieldType as any)[task.fieldType]
                          : (task.fieldType.includes('.') || task.fieldType.includes(':'))
                            ? extractReadableName(task.fieldType)
                            : task.fieldType}
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
                          {task.error}
                        </Text>
                      </div>
                    )}

                    {/* Expandable Details - AI Prompt & Output */}
                    {isExpanded && (
                      <BlockStack gap="300">
                        {/* AI Prompt & Response Section */}
                        {task.prompt && (
                          <div style={{ padding: "1rem", background: "#f0f7ff", borderRadius: "8px", border: "1px solid #b3d9ff" }}>
                            <BlockStack gap="200">
                              <Text as="h3" variant="headingSm" fontWeight="semibold">
                                {t.tasks.aiPrompt || "AI Prompt"} {(() => {
                                  try {
                                    const parsed = JSON.parse(task.prompt);
                                    if (Array.isArray(parsed)) {
                                      return `(${parsed.length} ${t.tasks.requests || "requests"})`;
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
                                    const parsed = JSON.parse(task.prompt);
                                    if (Array.isArray(parsed)) {
                                      // New format: array of { timestamp, prompt, response? }
                                      return (
                                        <BlockStack gap="300">
                                          {parsed.map((entry: { timestamp: string; prompt: string; response?: string }, index: number) => {
                                            const promptId = `${task.id}-prompt-${index}`;
                                            const responseId = `${task.id}-response-${index}`;
                                            const promptTruncated = shouldTruncate(entry.prompt);
                                            const responseTruncated = entry.response ? shouldTruncate(entry.response) : false;

                                            return (
                                            <div key={index} style={{ padding: "0.75rem", background: "white", borderRadius: "4px", border: "1px solid #e5e5e5" }}>
                                              <Text as="p" variant="bodySm" tone="subdued">
                                                #{index + 1} - {isClient ? new Date(entry.timestamp).toLocaleTimeString() : entry.timestamp}
                                              </Text>
                                              <div style={{ fontFamily: "monospace", fontSize: "11px", whiteSpace: "pre-wrap", marginTop: "0.5rem", maxHeight: "400px", overflowY: "auto" }}>
                                                {truncateText(entry.prompt, promptId)}
                                                {promptTruncated && (
                                                  <div style={{ marginTop: "0.5rem" }}>
                                                    <Button
                                                      size="slim"
                                                      variant="plain"
                                                      onClick={() => togglePromptExpanded(promptId)}
                                                    >
                                                      {expandedPromptIds.has(promptId) ? (t.tasks as any).showLess || "Show less" : `...${(t.tasks as any).showMore || "Show more"} (${entry.prompt.length} chars)`}
                                                    </Button>
                                                  </div>
                                                )}
                                              </div>
                                              {entry.response && (
                                                <div style={{ marginTop: "0.5rem", padding: "0.5rem", background: "#f0fff4", borderRadius: "4px", border: "1px solid #9ae6b4" }}>
                                                  <Text as="p" variant="bodySm" fontWeight="semibold" tone="success">
                                                    {t.tasks.aiOutput || "AI Output"} #{index + 1}
                                                  </Text>
                                                  <div style={{ fontFamily: "monospace", fontSize: "11px", whiteSpace: "pre-wrap", marginTop: "0.25rem", maxHeight: "400px", overflowY: "auto" }}>
                                                    {truncateText(entry.response, responseId)}
                                                    {responseTruncated && (
                                                      <div style={{ marginTop: "0.5rem" }}>
                                                        <Button
                                                          size="slim"
                                                          variant="plain"
                                                          onClick={() => togglePromptExpanded(responseId)}
                                                        >
                                                          {expandedPromptIds.has(responseId) ? (t.tasks as any).showLess || "Show less" : `...${(t.tasks as any).showMore || "Show more"} (${entry.response.length} chars)`}
                                                        </Button>
                                                      </div>
                                                    )}
                                                  </div>
                                                </div>
                                              )}
                                            </div>
                                            );
                                          })}
                                        </BlockStack>
                                      );
                                    }
                                  } catch {
                                    // Not JSON, display as single prompt
                                  }
                                  // Legacy format: single prompt string
                                  const legacyPromptId = `${task.id}-legacy-prompt`;
                                  const legacyTruncated = shouldTruncate(task.prompt);
                                  return (
                                    <div style={{ padding: "0.75rem", background: "white", borderRadius: "4px" }}>
                                      <div style={{ fontFamily: "monospace", fontSize: "12px", whiteSpace: "pre-wrap", maxHeight: "400px", overflowY: "auto" }}>
                                        {truncateText(task.prompt, legacyPromptId)}
                                      </div>
                                      {legacyTruncated && (
                                        <div style={{ marginTop: "0.5rem" }}>
                                          <Button
                                            size="slim"
                                            variant="plain"
                                            onClick={() => togglePromptExpanded(legacyPromptId)}
                                          >
                                            {expandedPromptIds.has(legacyPromptId) ? (t.tasks as any).showLess || "Show less" : `...${(t.tasks as any).showMore || "Show more"} (${task.prompt.length} chars)`}
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
