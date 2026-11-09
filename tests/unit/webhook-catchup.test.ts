/**
 * Catch-up of missed webhooks (PLAN_ADMIN_SHOP_OVERVIEW 2.4): runs for a shop
 * that owes one, clears its flag only when every type was ok and nothing was
 * dropped meanwhile (compare-and-delete), and runs once per shop at a time.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  row: null as Record<string, any> | null,
  updateMany: vi.fn(),
  block: vi.fn(),
  reconcile: vi.fn(),
  info: [] as string[],
}));

vi.mock("../../app/db.server", () => ({
  db: {
    shopInstallState: {
      findUnique: vi.fn(async () => (h.row ? { ...h.row } : null)),
      updateMany: (...a: unknown[]) => h.updateMany(...a),
    },
  },
}));
vi.mock("../../app/utils/shop-connection-state.server", () => ({
  getConnectionBlock: (...a: unknown[]) => h.block(...a),
}));
vi.mock("../../app/services/webhook-reconcile.service", () => ({
  reconcileWebhookBackedTypes: (...a: unknown[]) => h.reconcile(...a),
}));
vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: (m: string) => h.info.push(m), warn: vi.fn(), error: vi.fn() },
}));

import {
  __resetCatchUpForTests,
  clearResyncIfUnchanged,
  isCatchUpInFlight,
  runWebhookCatchUp,
} from "../../app/services/webhook-catchup.server";

const SHOP = "a.myshopify.com";
const SINCE = new Date("2026-11-01T00:00:00Z");
const allOk = { products: 1, collections: 0, ok: { products: true, collections: true } };

beforeEach(() => {
  __resetCatchUpForTests();
  h.info.length = 0;
  h.row = { initialSyncCompletedAt: new Date(), resyncRequiredSince: SINCE, droppedWebhookCount: 3 };
  h.updateMany.mockReset().mockResolvedValue({ count: 1 });
  h.block.mockReset().mockResolvedValue(null);
  h.reconcile.mockReset().mockResolvedValue(allOk);
});

describe("runWebhookCatchUp", () => {
  it("reconciles once and clears the flag by compare-and-delete when everything is ok", async () => {
    expect(await runWebhookCatchUp(SHOP, {} as never)).toBe("done");
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    expect(h.updateMany).toHaveBeenCalledWith({
      where: { shop: SHOP, resyncRequiredSince: SINCE, droppedWebhookCount: 3 },
      data: { resyncRequiredSince: null, droppedWebhookCount: 0 },
    });
  });

  it.each([
    ["products", { products: false, collections: true }],
    ["collections", { products: true, collections: false }],
  ])("keeps the flag when the %s type was not ok, and pauses the retry", async (_n, ok) => {
    h.reconcile.mockResolvedValue({ products: 0, collections: 0, ok });
    expect(await runWebhookCatchUp(SHOP, {} as never)).toBe("incomplete");
    expect(h.updateMany).not.toHaveBeenCalled();
    expect(await runWebhookCatchUp(SHOP, {} as never)).toBe("paused");
    expect(h.reconcile).toHaveBeenCalledTimes(1);
  });

  it("a webhook dropped DURING the run leaves the flag (the compare matches no row)", async () => {
    h.updateMany.mockResolvedValue({ count: 0 });
    expect(await runWebhookCatchUp(SHOP, {} as never)).toBe("done");
    expect(h.info.join("\n")).toContain("flag kept");
    // the compare used the count read BEFORE the run
    expect(h.updateMany.mock.calls[0][0].where.droppedWebhookCount).toBe(3);
  });

  it("does nothing without a flag, without a finished initial sync, or for a blocked shop", async () => {
    h.row = { initialSyncCompletedAt: new Date(), resyncRequiredSince: null, droppedWebhookCount: 0 };
    expect(await runWebhookCatchUp(SHOP, {} as never)).toBe("not_needed");
    h.row = { initialSyncCompletedAt: null, resyncRequiredSince: SINCE, droppedWebhookCount: 1 };
    expect(await runWebhookCatchUp(SHOP, {} as never)).toBe("not_needed");
    h.row = { initialSyncCompletedAt: new Date(), resyncRequiredSince: SINCE, droppedWebhookCount: 1 };
    h.block.mockResolvedValue({ state: "needs_reauth", since: null, reason: "no_token" });
    expect(await runWebhookCatchUp(SHOP, {} as never)).toBe("blocked");
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  it("runs at most once per shop at a time", async () => {
    let release: (v: unknown) => void = () => {};
    h.reconcile.mockImplementation(() => new Promise((r) => { release = r; }));
    const first = runWebhookCatchUp(SHOP, {} as never);
    for (let i = 0; i < 50 && h.reconcile.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(isCatchUpInFlight(SHOP)).toBe(true); // the scheduler runs no syncAll beside it
    expect(isCatchUpInFlight("other.myshopify.com")).toBe(false);
    expect(await runWebhookCatchUp(SHOP, {} as never)).toBe("busy");
    release(allOk);
    expect(await first).toBe("done");
    expect(isCatchUpInFlight(SHOP)).toBe(false);
    expect(h.reconcile).toHaveBeenCalledTimes(1);
  });

  it("never throws", async () => {
    h.reconcile.mockRejectedValue(new Error("boom"));
    expect(await runWebhookCatchUp(SHOP, {} as never)).toBe("error");
    expect(h.updateMany).not.toHaveBeenCalled();
  });
});

describe("clearResyncIfUnchanged", () => {
  it("reports a failed write as not cleared", async () => {
    h.updateMany.mockRejectedValue(new Error("db"));
    expect(await clearResyncIfUnchanged(SHOP, { since: SINCE, dropped: 0 })).toBe(false);
  });

  it("pause doubles per incomplete run and is capped", async () => {
    const { catchUpPauseMs, CATCHUP_RETRY_PAUSE_MS, CATCHUP_RETRY_PAUSE_MAX_MS } = await import("../../app/services/webhook-catchup.server");
    expect(catchUpPauseMs(1)).toBe(CATCHUP_RETRY_PAUSE_MS);
    expect(catchUpPauseMs(2)).toBe(2 * CATCHUP_RETRY_PAUSE_MS);
    expect(catchUpPauseMs(30)).toBe(CATCHUP_RETRY_PAUSE_MAX_MS);
  });

  it("gives up and clears the flag after 5 consecutive item-failure-only runs", async () => {
    vi.useFakeTimers();
    try {
      h.reconcile.mockResolvedValue({ products: 0, collections: 0, ok: { products: false, collections: true }, itemFailuresOnly: true });
      for (let i = 0; i < 5; i++) {
        expect(await runWebhookCatchUp(SHOP, {} as never)).toBe("incomplete");
        vi.advanceTimersByTime(7 * 60 * 60 * 1000);
      }
      expect(h.updateMany).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
