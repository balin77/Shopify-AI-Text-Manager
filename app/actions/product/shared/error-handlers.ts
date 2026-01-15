/**
 * Error Handlers
 *
 * Unified error handling for product actions
 * with consistent logging and task updates.
 */

import { json } from "@remix-run/node";
import { logger } from "~/utils/logger.server";
import { failTask } from "./task-helpers";

interface ActionError {
  message: string;
  code?: string;
  statusCode?: number;
  details?: any;
}

/**
 * Handles action errors with optional task update
 */
export async function handleActionError(
  error: Error | ActionError,
  context: {
    action: string;
    taskId?: string;
    productId?: string;
    additionalInfo?: Record<string, any>;
  }
): Promise<Response> {
  const errorMessage = error instanceof Error ? error.message : error.message;
  const statusCode =
    "statusCode" in error && error.statusCode ? error.statusCode : 500;

  // Log error
  logger.error(`Action failed: ${context.action}`, {
    context: "ProductAction",
    action: context.action,
    error: errorMessage,
    productId: context.productId,
    taskId: context.taskId,
    ...context.additionalInfo,
  });

  // Update task if provided
  if (context.taskId) {
    try {
      await failTask(context.taskId, errorMessage);
    } catch (taskError: any) {
      logger.error("Failed to update task status", {
        context: "ErrorHandler",
        taskId: context.taskId,
        error: taskError.message,
      });
    }
  }

  // Return error response
  return json(
    {
      success: false,
      error: errorMessage,
      action: context.action,
    },
    { status: statusCode }
  );
}

/**
 * Handles validation errors
 */
export function handleValidationError(
  field: string,
  message: string,
  context: {
    action: string;
    productId?: string;
  }
): Response {
  logger.warn(`Validation error: ${field}`, {
    context: "ProductAction",
    action: context.action,
    field,
    message,
    productId: context.productId,
  });

  return json(
    {
      success: false,
      error: `Validation error: ${message}`,
      field,
      action: context.action,
    },
    { status: 400 }
  );
}

/**
 * Handles API quota/rate limit errors
 */
export async function handleQuotaError(
  error: Error,
  context: {
    action: string;
    taskId?: string;
    productId?: string;
    provider?: string;
  }
): Promise<Response> {
  const message = `API quota or rate limit exceeded. Please check your ${
    context.provider || "AI provider"
  } settings and ensure you have sufficient API credits.`;

  logger.warn("Quota/rate limit error", {
    context: "ProductAction",
    action: context.action,
    provider: context.provider,
    error: error.message,
    productId: context.productId,
  });

  if (context.taskId) {
    await failTask(context.taskId, message);
  }

  return json(
    {
      success: false,
      error: message,
      action: context.action,
      isQuotaError: true,
    },
    { status: 429 }
  );
}

/**
 * Handles partial success scenarios
 * (e.g., 3 out of 4 locales translated successfully)
 */
export function handlePartialSuccess(
  successCount: number,
  totalCount: number,
  context: {
    action: string;
    errors: string[];
    result?: any;
  }
): Response {
  const message = `Partially completed: ${successCount} of ${totalCount} succeeded`;

  logger.warn("Partial success", {
    context: "ProductAction",
    action: context.action,
    successCount,
    totalCount,
    errors: context.errors,
  });

  return json(
    {
      success: successCount > 0, // Success if at least one succeeded
      partialSuccess: true,
      message,
      successCount,
      totalCount,
      errors: context.errors,
      result: context.result,
    },
    { status: successCount > 0 ? 200 : 500 }
  );
}

/**
 * Wraps an action handler with error handling
 */
export function withErrorHandling<T extends (...args: any[]) => Promise<Response>>(
  handler: T,
  actionName: string
): T {
  return (async (...args: any[]) => {
    try {
      return await handler(...args);
    } catch (error: any) {
      logger.error(`Unhandled error in ${actionName}`, {
        context: "ProductAction",
        action: actionName,
        error: error.message,
        stack: error.stack,
      });

      return json(
        {
          success: false,
          error: "An unexpected error occurred. Please try again.",
          action: actionName,
        },
        { status: 500 }
      );
    }
  }) as T;
}

/**
 * Checks if error is a rate limit/quota error
 */
export function isQuotaError(error: Error): boolean {
  const quotaKeywords = [
    "rate limit",
    "quota",
    "too many requests",
    "429",
    "exceeded",
    "throttle",
  ];

  const errorMessage = error.message.toLowerCase();
  return quotaKeywords.some((keyword) => errorMessage.includes(keyword));
}

/**
 * Checks if error is a network/timeout error
 */
export function isNetworkError(error: Error): boolean {
  const networkKeywords = [
    "timeout",
    "network",
    "econnrefused",
    "enotfound",
    "fetch failed",
  ];

  const errorMessage = error.message.toLowerCase();
  return networkKeywords.some((keyword) => errorMessage.includes(keyword));
}

/**
 * Creates a user-friendly error message
 */
export function formatErrorMessage(error: Error): string {
  if (isQuotaError(error)) {
    return "API rate limit exceeded. Please wait a moment and try again.";
  }

  if (isNetworkError(error)) {
    return "Network error occurred. Please check your connection and try again.";
  }

  // Default to original message but sanitize
  return error.message.substring(0, 200);
}
