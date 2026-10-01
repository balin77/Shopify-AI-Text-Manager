/**
 * Operator alerts — a message to the team's Discord (or Slack) channel.
 *
 * Everything in managed AI that means "paying merchants are about to lose, or
 * have lost, the AI they bought" used to end in a log line, and a log line is
 * read after a merchant writes in. This posts the same finding to
 * `ALERT_WEBHOOK_URL`, the webhook the DB-volume alarm (scripts/db-alert.mjs)
 * already uses, in the same body shape (`content` for Discord, `text` for
 * Slack).
 *
 * Three rules:
 *
 * - It NEVER throws and never blocks the caller for long: every caller is on
 *   a request path or inside an AI call, and an unreachable Discord must not
 *   fail a translation. A 5s timeout bounds it; callers do not await it.
 * - It is THROTTLED per key: one message per key per hour by default. A
 *   breaker that opens on every minute of an outage would otherwise post
 *   sixty messages an hour, and a channel that spams is a channel nobody
 *   reads. `onceKey` callers (a threshold crossed in a period) pass a key
 *   that already carries the period, so "once" means once per period.
 * - It names the ENVIRONMENT. Development and production share the channel,
 *   and a dev deploy with a test key must not read like a production outage.
 *
 * In-memory throttle: production is a single instance (see the roadmap note
 * on managed AI), so a process-local map is the whole truth; a restart may
 * repeat one message, which is the cheap direction.
 */

import { logger } from "../utils/logger.server";

const DEFAULT_THROTTLE_MS = 60 * 60 * 1000;
const lastSent = new Map<string, number>();

/** Discord rejects a `content` longer than 2000 characters. */
const MAX_LENGTH = 1900;

function environmentLabel(): string {
  return (
    process.env.RAILWAY_ENVIRONMENT_NAME ||
    process.env.APP_ENV ||
    process.env.NODE_ENV ||
    "unknown"
  );
}

export interface OpsAlertOptions {
  /** Minimum gap between two messages with the same key. Default one hour. */
  throttleMs?: number;
  /** Test seam. */
  now?: number;
  /** Test seam: replaces the network call. */
  post?: (url: string, body: string) => Promise<void>;
}

async function defaultPost(url: string, body: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`webhook answered ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Post an operator alert. Returns whether a message was SENT (false when
 * throttled, when no webhook is configured, or when the post failed), so a
 * test can assert on it; callers ignore it.
 */
export async function sendOpsAlert(
  key: string,
  message: string,
  opts: OpsAlertOptions = {},
): Promise<boolean> {
  try {
    const url = process.env.ALERT_WEBHOOK_URL;
    if (!url) return false;

    const now = opts.now ?? Date.now();
    const throttle = opts.throttleMs ?? DEFAULT_THROTTLE_MS;
    const previous = lastSent.get(key);
    if (previous !== undefined && now - previous < throttle) return false;
    // Claimed BEFORE the post, so two callers racing on one key send once —
    // and handed back when the post fails, or a Discord blip would silence a
    // once-per-month key (a budget threshold) for the rest of the month.
    lastSent.set(key, now);

    const text = `[ContentPilot · ${environmentLabel()}] ${message}`.slice(0, MAX_LENGTH);
    // Provider error text goes in verbatim; it must never ping a channel.
    const body = JSON.stringify({ content: text, text, allowed_mentions: { parse: [] } });
    try {
      await (opts.post ?? defaultPost)(url, body);
    } catch (postError) {
      if (previous === undefined) lastSent.delete(key);
      else lastSent.set(key, previous);
      throw postError;
    }
    return true;
  } catch (error) {
    logger.warn(
      `[OpsAlert] Could not send alert "${key}": ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

/** Fire-and-forget form for code paths that must not wait. */
export function notifyOps(key: string, message: string, opts?: OpsAlertOptions): void {
  void sendOpsAlert(key, message, opts);
}

/** Test seam. */
export function resetOpsAlertThrottle(): void {
  lastSent.clear();
}
