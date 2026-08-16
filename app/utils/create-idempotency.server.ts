/**
 * Create-request de-duplication (PLAN_CONTENT_CREATION §1.7).
 *
 * A disabled submit button does NOT make creation idempotent. It covers a
 * double-click and nothing else: a request that times out on the client while
 * Shopify still processes it, or a reload mid-flight, both produce a second
 * POST with the button freshly enabled — and a duplicate product in the shop.
 * Unlike a wrong value, that one is not fixable from inside this app today
 * (there is no content delete, §0.1).
 *
 * `productSet(identifier: { handle })` is the real fix where it applies, since
 * Shopify itself then treats the retry as an update. This is the fallback for
 * every type without such an identifier: the client mints a request id, and a
 * repeat within the window returns the FIRST result instead of creating again.
 *
 * In-memory on purpose, exactly like product-delete-lock.server.ts: it guards a
 * seconds-long window against the same user's own retry, not a distributed
 * race. A restart losing the map costs at worst one duplicate in the rare case
 * where a retry straddles it.
 */

const EXPIRY_MS = 120_000;
const MAX_ENTRIES = 500;

interface Entry {
  at: number;
  /** Resolved once the create finishes; pending until then. */
  result?: unknown;
}

const inFlight = new Map<string, Entry>();

function evictExpired(): void {
  const now = Date.now();
  for (const [key, entry] of inFlight) {
    if (now - entry.at > EXPIRY_MS) inFlight.delete(key);
  }
}

function keyFor(shop: string, requestId: string): string {
  return `${shop}::${requestId}`;
}

/**
 * Claim a request id. `false` means this exact request is already in flight or
 * has just completed — the caller must NOT create again.
 */
export function claimCreateRequest(shop: string, requestId: string): boolean {
  if (!requestId) return true; // no id supplied ⇒ nothing to dedupe against
  const key = keyFor(shop, requestId);
  const existing = inFlight.get(key);
  if (existing && Date.now() - existing.at <= EXPIRY_MS) return false;
  if (inFlight.size > MAX_ENTRIES) evictExpired();
  inFlight.set(key, { at: Date.now() });
  return true;
}

/** Remember what the first attempt produced, so a retry can return it verbatim. */
export function recordCreateResult(shop: string, requestId: string, result: unknown): void {
  if (!requestId) return;
  const key = keyFor(shop, requestId);
  const existing = inFlight.get(key);
  if (existing) existing.result = result;
}

/**
 * What the first attempt produced, if it has finished.
 *
 * `undefined` while the first attempt is still running: the honest answer to a
 * retry then is "already in progress", NOT a fresh create and NOT an error —
 * the object is very likely about to exist.
 */
export function previousCreateResult(shop: string, requestId: string): unknown | undefined {
  if (!requestId) return undefined;
  return inFlight.get(keyFor(shop, requestId))?.result;
}

/** Release a claim whose create failed, so the merchant can genuinely retry. */
export function releaseCreateRequest(shop: string, requestId: string): void {
  if (!requestId) return;
  inFlight.delete(keyFor(shop, requestId));
}

/** Test seam. */
export function __resetCreateIdempotency(): void {
  inFlight.clear();
}
