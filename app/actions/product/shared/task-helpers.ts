/**
 * Task Management Helpers
 *
 * Centralizes task creation, updates, and lifecycle management
 * to reduce code duplication across product actions.
 */

import { logger } from "~/utils/logger.server";
import { getTaskExpirationDate } from "../../../../src/utils/task.utils";

type TaskType = "aiGeneration" | "translation" | "bulkTranslation" | "bulkAIGeneration";
type TaskStatus = "pending" | "queued" | "running" | "completed" | "failed";

interface TaskCreateOptions {
  shop: string;
  type: TaskType;
  resourceId: string;
  fieldType?: string;
  targetLocale?: string;
  estimatedTokens?: number;
}

interface Task {
  id: string;
  shop: string;
  type: string;
  status: string;
  resourceType: string | null;
  resourceId: string | null;
  fieldType: string | null;
  targetLocale: string | null;
  progress: number;
  result: string | null;
  error: string | null;
  queuePosition: number | null;
  retryCount: number;
  estimatedTokens: number | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Creates a new task for a product operation
 */
export async function createProductTask(
  options: TaskCreateOptions
): Promise<Task> {
  const { db } = await import("~/db.server");

  logger.info("Creating product task", {
    context: "TaskHelper",
    type: options.type,
    resourceId: options.resourceId,
    fieldType: options.fieldType,
  });

  const task = await db.task.create({
    data: {
      shop: options.shop,
      type: options.type,
      status: "pending",
      resourceType: "product",
      resourceId: options.resourceId,
      fieldType: options.fieldType || null,
      targetLocale: options.targetLocale || null,
      progress: 0,
      estimatedTokens: options.estimatedTokens || null,
      expiresAt: getTaskExpirationDate(),
    },
  });

  return task;
}

/**
 * Updates task progress
 */
export async function updateTaskProgress(
  taskId: string,
  progress: number,
  additionalData?: {
    processed?: number;
    total?: number;
  }
): Promise<void> {
  const { db } = await import("~/db.server");

  const updateData: any = {
    progress: Math.min(100, Math.max(0, progress)),
  };

  if (additionalData?.processed !== undefined) {
    updateData.processed = additionalData.processed;
  }

  if (additionalData?.total !== undefined) {
    updateData.total = additionalData.total;
  }

  await db.task.update({
    where: { id: taskId },
    data: updateData,
  });

  logger.debug("Task progress updated", {
    context: "TaskHelper",
    taskId,
    progress: updateData.progress,
  });
}

/**
 * Marks task as completed with result
 */
export async function completeTask(
  taskId: string,
  result: any
): Promise<void> {
  const { db } = await import("~/db.server");

  const resultString = typeof result === "string"
    ? result
    : JSON.stringify(result);

  await db.task.update({
    where: { id: taskId },
    data: {
      status: "completed",
      progress: 100,
      result: resultString.substring(0, 500), // Limit result length
    },
  });

  logger.info("Task completed", {
    context: "TaskHelper",
    taskId,
  });
}

/**
 * Marks task as failed with error
 */
export async function failTask(
  taskId: string,
  error: Error | string
): Promise<void> {
  const { db } = await import("~/db.server");

  const errorMessage = typeof error === "string" ? error : error.message;

  await db.task.update({
    where: { id: taskId },
    data: {
      status: "failed",
      error: errorMessage.substring(0, 1000), // Limit error length
    },
  });

  logger.error("Task failed", {
    context: "TaskHelper",
    taskId,
    error: errorMessage,
  });
}

/**
 * Updates task status
 */
export async function updateTaskStatus(
  taskId: string,
  status: TaskStatus,
  additionalData?: {
    error?: string;
    result?: string;
    progress?: number;
  }
): Promise<void> {
  const { db } = await import("~/db.server");

  const updateData: any = { status };

  if (additionalData?.error) {
    updateData.error = additionalData.error.substring(0, 1000);
  }

  if (additionalData?.result) {
    updateData.result = additionalData.result.substring(0, 500);
  }

  if (additionalData?.progress !== undefined) {
    updateData.progress = Math.min(100, Math.max(0, additionalData.progress));
  }

  await db.task.update({
    where: { id: taskId },
    data: updateData,
  });

  logger.debug("Task status updated", {
    context: "TaskHelper",
    taskId,
    status,
  });
}

/**
 * Gets task by ID
 */
export async function getTask(taskId: string): Promise<Task | null> {
  const { db } = await import("~/db.server");
  return db.task.findUnique({
    where: { id: taskId },
  });
}

/**
 * Calculates progress percentage based on processed/total items
 */
export function calculateProgress(
  processed: number,
  total: number,
  startPercent: number = 10,
  endPercent: number = 90
): number {
  if (total === 0) return startPercent;

  const range = endPercent - startPercent;
  const progressPercent = startPercent + (processed / total) * range;

  return Math.round(progressPercent);
}
