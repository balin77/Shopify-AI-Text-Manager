/**
 * Brute-force protection for the /admin password login.
 *
 * The login compared the password in constant time but accepted unlimited
 * attempts. This limiter counts FAILED attempts only (a correct password
 * clears the caller's count) and enforces two caps:
 *
 * - per client IP: `perKeyMax` failures within `windowMs` lock that IP out
 *   for a full `windowMs` from the failure that hit the cap;
 * - globally: `globalMax` failures within `windowMs` across ALL clients lock
 *   the login for everybody until the window has passed — a distributed guess
 *   (one attempt per IP from a botnet) never reaches a per-IP cap. Stated
 *   trade-off: an attacker can use this to keep the real operator out for a
 *   while; the admin page is an operator tool, and being locked out of it is
 *   the cheaper failure than a guessed password.
 *
 * In-memory and per process, like the express limiters in
 * app/middleware/rate-limit-cjs.cjs (single Railway instance). It lives in the
 * route rather than as an express middleware because a React Router form POST
 * goes to `/admin.data` and expects a single-fetch body: an express-side 429
 * JSON would surface as an error boundary instead of the login form's message.
 */

export interface LoginLimiterOptions {
  perKeyMax?: number;
  globalMax?: number;
  windowMs?: number;
  /** Upper bound on tracked keys, so a spray of spoofed keys cannot grow memory without end. */
  maxKeys?: number;
}

export interface LoginLimitDecision {
  allowed: boolean;
  /** Seconds until another attempt is accepted (0 when allowed). */
  retryAfterSec: number;
}

interface KeyState {
  failures: number[];
  lockedUntil: number;
}

export function createLoginLimiter(options: LoginLimiterOptions = {}) {
  const perKeyMax = options.perKeyMax ?? 10;
  const globalMax = options.globalMax ?? 100;
  const windowMs = options.windowMs ?? 15 * 60 * 1000;
  const maxKeys = options.maxKeys ?? 10_000;

  const keys = new Map<string, KeyState>();
  let globalFailures: number[] = [];
  let globalLockedUntil = 0;

  const prune = (list: number[], now: number) => list.filter((t) => now - t < windowMs);

  function check(key: string, now: number = Date.now()): LoginLimitDecision {
    if (globalLockedUntil > now) {
      return { allowed: false, retryAfterSec: Math.ceil((globalLockedUntil - now) / 1000) };
    }
    const state = keys.get(key);
    if (state && state.lockedUntil > now) {
      return { allowed: false, retryAfterSec: Math.ceil((state.lockedUntil - now) / 1000) };
    }
    return { allowed: true, retryAfterSec: 0 };
  }

  function recordFailure(key: string, now: number = Date.now()): void {
    let state = keys.get(key);
    if (!state) {
      if (keys.size >= maxKeys) {
        // Drop expired entries first; if still full, evict the oldest insert.
        for (const [k, s] of keys) {
          if (s.lockedUntil <= now && prune(s.failures, now).length === 0) keys.delete(k);
        }
        if (keys.size >= maxKeys) {
          const oldest = keys.keys().next().value;
          if (oldest !== undefined) keys.delete(oldest);
        }
      }
      state = { failures: [], lockedUntil: 0 };
      keys.set(key, state);
    }
    state.failures = prune(state.failures, now);
    state.failures.push(now);
    if (state.failures.length >= perKeyMax) {
      state.lockedUntil = now + windowMs;
      state.failures = [];
    }

    globalFailures = prune(globalFailures, now);
    globalFailures.push(now);
    if (globalFailures.length >= globalMax) {
      globalLockedUntil = now + windowMs;
      globalFailures = [];
    }
  }

  function recordSuccess(key: string): void {
    keys.delete(key);
  }

  return { check, recordFailure, recordSuccess };
}

/**
 * The client IP as Railway's edge reported it. `server.js` trusts exactly one
 * proxy hop, so the RIGHTMOST `X-Forwarded-For` entry is the one the platform
 * appended; anything to its left is client-supplied and spoofable.
 */
export function clientIpFromRequest(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const parts = forwarded
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) return last.startsWith("::ffff:") ? last.slice(7) : last;
  }
  return "unknown";
}

/** The process-wide limiter the admin route uses. */
export const adminLoginLimiter = createLoginLimiter();
