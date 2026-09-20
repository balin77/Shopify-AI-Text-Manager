/**
 * When a managed call may be retried on the OTHER provider — PLAN_MANAGED_AI_KEY §3a.
 *
 * Pure and client-safe so the trigger list is testable without a provider, a
 * clock or a database. Everything stateful (the breaker, the ceilings) lives
 * in the server module beside it.
 *
 * **The exclusions are where the money is.** The fallback is ~14x the price of
 * the default, and a failover that fires on an error the second provider will
 * answer identically means we paid twice for the same refusal:
 *
 * - **input-too-long** — the fallback's context window is SMALLER, so it is
 *   guaranteed to fail too.
 * - **a content-policy refusal** — both providers refuse the same content.
 * - **a malformed-request 400** — our payload is wrong, not their service.
 * - **a 429**, until the queue's own retries are exhausted. A rate limit is a
 *   wait, and paying 14x to skip a wait is the most expensive way to be
 *   impatient.
 */

/** What went wrong, as much as we can tell from an error object. */
export interface FailoverSignal {
  status?: number;
  message: string;
  /** True once the queue has already re-enqueued this call to its limit. */
  rateLimitRetriesExhausted?: boolean;
}

export type FailoverVerdict =
  | { failOver: true; reason: "connection" | "timeout" | "server" | "modelNotFound" | "ourAuth" | "rateLimited" }
  | { failOver: false; reason: "inputTooLong" | "contentRefusal" | "badRequest" | "rateLimitedRetryFirst" | "unknown" };

const CONNECTION_PATTERNS = [
  "econnreset",
  "econnrefused",
  "enotfound",
  "etimedout",
  "socket hang up",
  "network error",
  "fetch failed",
];

const TIMEOUT_PATTERNS = ["timed out", "timeout"];

const MODEL_NOT_FOUND_PATTERNS = [
  "model not found",
  "does not exist",
  "unknown model",
  "invalid model",
  "model_not_found",
];

const INPUT_TOO_LONG_PATTERNS = [
  "maximum context length",
  "context_length_exceeded",
  "prompt is too long",
  "request payload size exceeds",
  "input is too long",
  "too many tokens",
];

const CONTENT_REFUSAL_PATTERNS = [
  "content policy",
  "content_policy",
  "safety",
  "was blocked",
  "refused",
  "violat",
];

export function classifyFailover(signal: FailoverSignal): FailoverVerdict {
  const msg = (signal.message || "").toLowerCase();
  const status = signal.status ?? 0;

  // EXCLUSIONS FIRST. Each one is a case where the second provider returns
  // the same answer and we have paid twice.
  if (INPUT_TOO_LONG_PATTERNS.some((p) => msg.includes(p))) {
    return { failOver: false, reason: "inputTooLong" };
  }
  if (CONTENT_REFUSAL_PATTERNS.some((p) => msg.includes(p))) {
    return { failOver: false, reason: "contentRefusal" };
  }

  if (status === 429) {
    // A rate limit is a WAIT. Only once the queue has stopped waiting is
    // paying 14x to skip it the better answer.
    return signal.rateLimitRetriesExhausted
      ? { failOver: true, reason: "rateLimited" }
      : { failOver: false, reason: "rateLimitedRetryFirst" };
  }

  // A 401/403 on OUR key is an operator incident, not a merchant one — it
  // fails over AND alerts, and it never wears the BYO wording (§3a rule 9:
  // in managed mode the AI-keys tab is hidden, so sending a merchant there
  // is nonsense).
  if (status === 401 || status === 403) return { failOver: true, reason: "ourAuth" };

  if (MODEL_NOT_FOUND_PATTERNS.some((p) => msg.includes(p))) {
    return { failOver: true, reason: "modelNotFound" };
  }

  // A malformed request is ours. Only AFTER the model-not-found check, which
  // some providers also report as a 400.
  if (status === 400) return { failOver: false, reason: "badRequest" };

  if (status >= 500 && status < 600) return { failOver: true, reason: "server" };
  if (TIMEOUT_PATTERNS.some((p) => msg.includes(p))) return { failOver: true, reason: "timeout" };
  if (CONNECTION_PATTERNS.some((p) => msg.includes(p))) {
    return { failOver: true, reason: "connection" };
  }

  // Anything unrecognised does NOT fail over. The default has to be the cheap
  // one: an unknown error that the fallback would also refuse costs double
  // every time it happens, and an unknown error nobody has classified is the
  // most likely kind to repeat.
  return { failOver: false, reason: "unknown" };
}

/** Pull a status code off whatever the provider SDKs threw. */
export function statusOf(error: unknown): number | undefined {
  const e = error as { status?: number; statusCode?: number; response?: { status?: number } } | null;
  return e?.status ?? e?.statusCode ?? e?.response?.status;
}
