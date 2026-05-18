/**
 * Unit Tests for app/services/sync-scheduler.service.ts — R4
 *
 * R4 (concurrency-guard identity check): runSyncCycle's outer `finally` clears
 * `isRunning` ONLY when the timer entry it started with is still the one
 * registered for the shop:
 *
 *   if (syncTimer && this.activeTimers.get(shop) === syncTimer) {
 *     syncTimer.isRunning = false;
 *   }
 *
 * If startSyncForShop replaced the entry mid-cycle (upgrade trigger / force
 * re-sync / multi-tab), the OLD cycle finishing must NOT reset `isRunning` on
 * the NEW entry — otherwise two concurrent syncs could run for one shop (the
 * exact bug that took the server down).
 *
 * runSyncCycle is private; we drive it via the exported singleton with all
 * collaborators mocked and the incremental (marker-set) path selected, holding
 * the cycle open with a deferred syncAll() so the entry can be swapped in
 * flight. See the bottom of this file for the parts of R4 NOT unit-tested and
 * why.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  let resolveSync: (v: { total: number; duration: number }) => void = () => {};
  return {
    sisFindUnique: vi.fn(),
    isShopActive: vi.fn().mockResolvedValue(true),
    syncAll: vi.fn(),
    reconcile: vi.fn().mockResolvedValue(undefined),
    get resolveSync() {
      return resolveSync;
    },
    set resolveSync(fn) {
      resolveSync = fn;
    },
  };
});

vi.mock('~/db.server', () => ({
  db: { shopInstallState: { findUnique: h.sisFindUnique, upsert: vi.fn().mockResolvedValue({}) } },
}));
vi.mock('~/middleware/activity-tracker.middleware', () => ({
  isShopActive: (...a: unknown[]) => h.isShopActive(...a),
}));
vi.mock('~/services/background-sync.service', () => ({
  BackgroundSyncService: class {
    syncAll = (...a: unknown[]) => h.syncAll(...a);
  },
}));
vi.mock('~/services/webhook-reconcile.service', () => ({
  reconcileWebhookBackedTypes: (...a: unknown[]) => h.reconcile(...a),
}));
vi.mock('~/utils/logger.server', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { syncScheduler } from '~/services/sync-scheduler.service';

const shop = 'concurrency.myshopify.com';
const admin = {} as never;

type SyncTimer = {
  timer: unknown;
  shop: string;
  startedAt: Date;
  isRunning: boolean;
  abortController: AbortController;
  cycleCount: number;
};

function makeEntry(): SyncTimer {
  return {
    timer: 0,
    shop,
    startedAt: new Date(),
    isRunning: false,
    abortController: new AbortController(),
    cycleCount: 0,
  };
}
const sched = syncScheduler as unknown as {
  activeTimers: Map<string, SyncTimer>;
  runningSyncs: number;
  slotWaiters: Array<() => void>;
  runSyncCycle: (shop: string, admin: unknown) => Promise<void>;
};

/** Wait until the cycle has reached the (deferred) syncAll() call. The first
 *  dynamic import("../db.server") can take a moment on cold load, so poll. */
async function waitForSyncAll() {
  for (let i = 0; i < 200; i++) {
    if (h.syncAll.mock.calls.length > 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('syncAll() was never reached');
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the singleton's private scheduling state between tests.
  sched.activeTimers.clear();
  sched.runningSyncs = 0;
  sched.slotWaiters = [];
  // Incremental path: marker set.
  h.sisFindUnique.mockResolvedValue({ initialSyncCompletedAt: new Date() });
  h.isShopActive.mockResolvedValue(true);
  // syncAll stays pending until we resolve it.
  h.syncAll.mockImplementation(
    () => new Promise((res) => { h.resolveSync = res as typeof h.resolveSync; }),
  );
});

describe('runSyncCycle — R4 concurrency-guard identity check', () => {
  it('a stale cycle does NOT reset isRunning on a replaced entry', async () => {
    const entryA = makeEntry();
    sched.activeTimers.set(shop, entryA);

    const p = sched.runSyncCycle(shop, admin);
    await waitForSyncAll(); // let the cycle reach the pending syncAll()

    expect(entryA.isRunning).toBe(true);
    expect(h.syncAll).toHaveBeenCalledTimes(1);

    // Mid-flight: startSyncForShop-style entry replacement. The new entry's
    // own cycle has flagged itself running.
    const entryB = makeEntry();
    entryB.isRunning = true;
    sched.activeTimers.set(shop, entryB);

    // Old cycle A now completes.
    h.resolveSync({ total: 0, duration: 0 });
    await p;

    // The invariant: A's finally must NOT touch the live (B) entry.
    expect(entryB.isRunning).toBe(true);
    // And the live entry registered for the shop is still B.
    expect(sched.activeTimers.get(shop)).toBe(entryB);
  });

  it('a normal (non-replaced) cycle DOES reset its own isRunning', async () => {
    const entryA = makeEntry();
    sched.activeTimers.set(shop, entryA);

    const p = sched.runSyncCycle(shop, admin);
    await waitForSyncAll();
    expect(entryA.isRunning).toBe(true);

    h.resolveSync({ total: 0, duration: 0 });
    await p;

    // Entry never replaced → identity check passes → flag cleared so the
    // next interval tick is allowed to run.
    expect(entryA.isRunning).toBe(false);
    expect(sched.activeTimers.get(shop)).toBe(entryA);
  });
});

/*
 * NOT unit-tested for R4 (deliberately), and why:
 *
 * - The setTimeout/setInterval phase-offset + jittered first-run scheduling in
 *   startSyncForShop is timer-plumbing around the same guard; asserting it adds
 *   fake-timer flakiness without exercising new logic (the guard itself is
 *   covered above via the entry-identity contract).
 * - The global SYNC_MAX_CONCURRENCY slot queue (acquire/releaseSyncSlot) is a
 *   separate concern from R4 and is implicitly exercised here (the cycle
 *   acquires and releases a slot); a dedicated saturation test would belong to
 *   a concurrency-limit suite, not the R4 identity invariant.
 */
