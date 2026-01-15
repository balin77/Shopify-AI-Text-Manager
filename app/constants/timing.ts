/**
 * Timing constants for animations and delays
 * Centralizes all magic numbers related to timing
 */

export const TIMING = {
  /** Delay before executing pending navigation after save */
  NAVIGATION_DELAY_MS: 500,
  /** Duration of highlight animations */
  HIGHLIGHT_DURATION_MS: 1500,
  /** Duration of smooth scroll animations */
  SCROLL_ANIMATION_MS: 300,
} as const;
