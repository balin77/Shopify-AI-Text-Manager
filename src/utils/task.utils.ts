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
 * @param hours Number of hours to look back (1, 6, 12, 24, 48, 72 - max 72 = 3 days)
 */
export function getTaskDateRange(hours: number = 72): Date {
  const maxHours = Math.min(hours, 72); // Enforce max 72 hours (3 days)
  const dateFrom = new Date();
  dateFrom.setHours(dateFrom.getHours() - maxHours);
  return dateFrom;
}
