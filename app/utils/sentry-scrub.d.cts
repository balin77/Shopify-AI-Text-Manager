// Types for the shared CommonJS scrub module (app/utils/sentry-scrub.cjs).
// Kept deliberately loose: the Sentry Event/Breadcrumb shapes differ slightly
// between @sentry/node and @sentry/react, and the scrubber is structural.

export function redactString(input: unknown): unknown;
export function stripUrl(url: unknown): unknown;
export function scrubValue(value: unknown, depth?: number): unknown;
export function scrubBreadcrumb<T>(breadcrumb: T): T | null;
export function scrubEvent<T>(event: T): T;
export function sentryEnabled(): boolean;
