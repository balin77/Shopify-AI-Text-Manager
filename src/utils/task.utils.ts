/**
 * Task Utilities
 * Helper functions for task management
 */

/**
 * Calculate expiration date for a task (3 days from now)
 */
export function getTaskExpirationDate(): Date {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 3); // 3 days from now
  return expiresAt;
}

/**
 * Get date range for filtering tasks
 * @param days Number of days to look back (max 3)
 */
export function getTaskDateRange(days: number = 3): Date {
  const maxDays = Math.min(days, 3); // Enforce max 3 days
  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - maxDays);
  return dateFrom;
}
