/**
 * An in-process, per-key FIFO lock with a bounded wait.
 *
 * Why it exists: the options & metafields card sends its primary saves one at a
 * time (sub-resource-save-queue.ts), but the browser can GIVE UP on a request
 * (its cut-off, a closed tab, a lost connection) while the server keeps
 * writing, and the next save then starts beside it - an older `metafieldsSet`
 * can land last and overwrite the newer value. Aborting a fetch does not cancel
 * the handler: the content-editor door rebuilds the Request for the page action,
 * so the client's abort signal never reaches it, and the handler does not look at
 * a signal anyway.
 *
 * So the server serialises the writes of ONE product itself. Railway runs this
 * app as a single web instance (RAILWAY-SETUP s.0), so a process-local lock is
 * enough; with a second replica it would degrade to "no lock", never to a
 * deadlock. During a zero-downtime deploy the old and the new container each
 * hold their own lock, a short window this cannot cover.
 *
 * The wait is BOUNDED (`maxWaitMs`): a holder that hangs must not block the
 * product for good. A waiter that times out proceeds, concurrently, which is the
 * situation without the lock - no worse.
 */

const tails = new Map<string, Promise<void>>();

export interface SerialLockOptions {
  /** How long to wait for the previous holder before going ahead anyway. */
  maxWaitMs?: number;
}

export const DEFAULT_SERIAL_LOCK_WAIT_MS = 5 * 60 * 1000;

export async function withSerialLock<T>(
  key: string,
  fn: () => Promise<T>,
  { maxWaitMs = DEFAULT_SERIAL_LOCK_WAIT_MS }: SerialLockOptions = {},
): Promise<T> {
  const previous = tails.get(key);
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  tails.set(key, mine);

  if (previous) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        previous,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, maxWaitMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    return await fn();
  } finally {
    release();
    if (tails.get(key) === mine) tails.delete(key);
  }
}

/** Test seam. */
export function __lockKeysForTests(): string[] {
  return [...tails.keys()];
}
