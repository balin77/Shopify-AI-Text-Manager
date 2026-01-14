import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useRevalidator, useSearchParams } from "@remix-run/react";
import { useEffect, useState, useCallback } from "react";
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
import { MainNavigation } from "../components/MainNavigation";
import { useI18n } from "../contexts/I18nContext";
import { getTaskDateRange } from "../../src/utils/task.utils";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  try {
    const { db } = await import("../db.server");

    // Parse query parameters for filtering and pagination
    const url = new URL(request.url);
    const statusFilter = url.searchParams.get("status") || "all"; // all, completed, failed
    const hoursFilter = parseInt(url.searchParams.get("hours") || "72"); // 1, 6, 12, 24, 48, 72
    const page = parseInt(url.searchParams.get("page") || "1");
    const pageSize = 20;

    // Build where clause
    const where: any = { shop: session.shop };

    // Status filter
    if (statusFilter === "completed") {
      where.status = "completed";
    } else if (statusFilter === "failed") {
      where.status = "failed";
    }

    // Date range filter (max 72 hours = 3 days)
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
      result: null, // Don't send result to client, we don't display it anyway
      error: task.error ? String(task.error).substring(0, 500) : null,
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
  } catch (error: any) {
    return json({
      tasks: [],
      shop: session.shop,
      error: error.message,
      pagination: { page: 1, pageSize: 20, totalCount: 0, totalPages: 0 },
      filters: { status: "all", hours: 72 }
    }, { status: 500 });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const action = formData.get("action");
  const taskId = formData.get("taskId") as string;

  const { db } = await import("../db.server");

  if (action === "cancel") {
    try {
      await db.task.update({
        where: { id: taskId },
        data: { status: "cancelled", completedAt: new Date() },
      });
      return json({ success: true });
    } catch (error: any) {
      return json({ success: false, error: error.message }, { status: 500 });
    }
  }

  if (action === "delete") {
    try {
      await db.task.delete({
        where: { id: taskId },
      });
      return json({ success: true });
    } catch (error: any) {
      return json({ success: false, error: error.message }, { status: 500 });
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
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();

  // Auto-refresh every 3 seconds if there are running tasks
  useEffect(() => {
    const hasRunningTasks = tasks.some((task: any) =>
      task.status === "pending" || task.status === "running"
    );

    if (hasRunningTasks) {
      const interval = setInterval(() => {
        revalidator.revalidate();
      }, 3000);

      return () => clearInterval(interval);
    }
  }, [tasks, revalidator]);

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

  return (
    <Page fullWidth>
      <MainNavigation />

      <div style={{ padding: "1rem" }}>
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
                      { label: t.tasks.timeRangeOptions.last2Days, value: "48" },
                      { label: t.tasks.timeRangeOptions.last3Days, value: "72" },
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
              {tasks.map((task: any) => (
                <Card key={task.id}>
                  <BlockStack gap="300">
                    {/* Header */}
                    <InlineStack align="space-between" blockAlign="center">
                      <InlineStack gap="200" blockAlign="center">
                        <Text as="h2" variant="headingMd" fontWeight="semibold">
                          {(t.tasks.taskType as any)[task.type] || task.type}
                        </Text>
                        {getStatusBadge(task.status)}
                      </InlineStack>
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
                        {(task.status === "completed" || task.status === "failed" || task.status === "cancelled") && (
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
                    </InlineStack>

                    {/* Resource Info */}
                    {task.resourceTitle && (
                      <InlineStack gap="200">
                        {task.resourceType && (
                          <Badge tone="info">
                            {(t.tasks.resourceType as any)[task.resourceType] || task.resourceType}
                          </Badge>
                        )}
                        <Text as="p" variant="bodyMd">
                          {task.resourceTitle}
                        </Text>
                      </InlineStack>
                    )}

                    {/* Field Type */}
                    {task.fieldType && (
                      <Text as="p" variant="bodySm" tone="subdued">
                        {t.tasks.fieldType && (t.tasks.fieldType as any)[task.fieldType]
                          ? (t.tasks.fieldType as any)[task.fieldType]
                          : task.fieldType}
                        {task.targetLocale && ` → ${task.targetLocale}`}
                      </Text>
                    )}

                    {/* Progress Bar */}
                    {(task.status === "running" || task.status === "pending") && (
                      <div>
                        <ProgressBar progress={task.progress} size="small" />
                        <Text as="p" variant="bodySm" tone="subdued">
                          {t.tasks.progress}: {task.progress}%
                          {task.total && task.processed !== undefined &&
                            ` (${task.processed}/${task.total})`}
                        </Text>
                      </div>
                    )}

                    {/* Time Info */}
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
                    </InlineStack>

                    {/* Error Message */}
                    {task.error && (
                      <div style={{ padding: "0.75rem", background: "#fbeae5", borderRadius: "8px", border: "1px solid #d72c0d" }}>
                        <Text as="p" variant="bodySm" tone="critical">
                          {task.error}
                        </Text>
                      </div>
                    )}
                  </BlockStack>
                </Card>
              ))}

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
