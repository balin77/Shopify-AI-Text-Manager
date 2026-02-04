/**
 * Task Utilities
 * Helper functions for task management
 */

/**
 * Calculate expiration date for a task (1 day from now)
 */
export function getTaskExpirationDate(): Date {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 1); // 1 day from now
  return expiresAt;
}

/**
 * Get date range for filtering tasks
 * @param hours Number of hours to look back (1, 6, 12, 24 - max 24 = 1 day)
 */
export function getTaskDateRange(hours: number = 24): Date {
  const maxHours = Math.min(hours, 24); // Enforce max 24 hours (1 day)
  const dateFrom = new Date();
  dateFrom.setHours(dateFrom.getHours() - maxHours);
  return dateFrom;
}
