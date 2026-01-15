/**
 * Layout Constants
 *
 * Central place for all layout-related constants used across the application.
 * This ensures consistency and makes it easy to adjust layout values globally.
 */

/**
 * Maximum height for scrollable content areas
 * Format: calc(100vh - [offset]px)
 *
 * Adjust the offset value to control how much space is reserved for:
 * - Header navigation (73px)
 * - Content type navigation tabs (~47px)
 * - Padding and borders
 *
 * Higher offset = smaller content area (less scrolling needed)
 * Lower offset = larger content area (more scrolling needed)
 */
export const CONTENT_MAX_HEIGHT = "calc(100vh - 300px)";

/**
 * Legacy value (for reference): "calc(100vh - 200px)"
 */
