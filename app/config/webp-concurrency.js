/**
 * Per-plan WebP conversion concurrency — single source of truth.
 *
 * Plain ESM (no TS) on purpose: this file is consumed BOTH by the bundled
 * TypeScript app (app/config/plans.ts → PlanLimits.maxConcurrentWebpConversions)
 * AND by webp-processor.service.js, which Node imports directly at runtime and
 * therefore cannot load a .ts module. Keeping the numbers here eliminates the
 * old hardcoded mirror + "keep in sync" comment in the worker.
 *
 * Pro→Max is a deliberate cost-aligned value differentiator (image processing
 * is real compute; AI tokens are merchant-funded BYO). See docs/ROADMAP.md
 * §Limit-Review Befund 4.
 */
export const PLAN_WEBP_CONCURRENCY = {
  free: 2,
  basic: 2,
  pro: 2,
  max: 6,
};

/** Fallback when a shop's plan string is unknown. */
export const DEFAULT_WEBP_CONCURRENCY = 2;
