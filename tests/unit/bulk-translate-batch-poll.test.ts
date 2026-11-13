/**
 * The tick of the Batch-API mode (PLAN_BULK_TRANSLATE_BATCHING 5.4 / 5.5 / 5.6 /
 * 6 / 19.4): the lease (compare-and-swap, exactly one holder, expiry = restart
 * safety), the gates (consent withdrawn = cancel + fetch NOTHING + book the
 * upper bound; the write gate refusing = book, do not write; an exhausted
 * budget stops neither), booking BEFORE writing, cancel_requested, an ended
 * batch with nothing usable, the unreachable provider with back-off, orphan rows
 * and blocked shops. The provider, the credentials module, the meter and the
 * collect run are doubles; the db is an in-memory fake with real predicate
 * matching, so the lease is exercised for real.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  rows: new Map<string, any>(),
  tasks: new Map<string, any>(),
  settings: { shop: "s.myshopify.com", subscriptionPlan: "pro", aiProcessingConsentAt: new Date("2026-10-01"), aiProcessingConsentVersion: "2026-09-20.2" } as any,
  order: [] as string[],
  settle: vi.fn(),
  resolve: vi.fn(),
  aiServiceFor: vi.fn(),
  booking: vi.fn(),
  convert: vi.fn(),
  release: vi.fn(),
  sweep: vi.fn(),
  expire: vi.fn(),
  retrieve: vi.fn(),
  cancel: vi.fn(),
  results: vi.fn(),
  deleteFile: vi.fn(),
  find: vi.fn(),
}));

/** Matches the where-shapes the poller uses: equality, {in}, {lt}, {notIn}, OR. */
function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([key, cond]: [string, any]) => {
    if (key === "OR") return (cond as any[]).some((w) => matches(row, w));
    if (key === "AND") return (cond as any[]).every((w) => matches(row, w));
    const value = row[key];
    if (cond === null) return value === null || value === undefined;
    if (cond instanceof Date) return value?.getTime?.() === cond.getTime();
    if (cond && typeof cond === "object") {
      if ("in" in cond) return cond.in.includes(value);
      if ("notIn" in cond) return !cond.notIn.includes(value);
      if ("lt" in cond) return value != null && value < cond.lt;
      if ("gte" in cond) return value != null && value >= cond.gte;
      return false;
    }
    return value === cond;
  });
}

vi.mock("~/db.server", () => {
  const touch = (r: any) => (r.updatedAt = new Date());
  return {
    db: {
      bulkTranslateBatch: {
        findMany: vi.fn(async ({ where, take }: any) => [...h.rows.values()].filter((r) => matches(r, where)).slice(0, take ?? 1000).map((r) => ({ ...r }))),
        findUnique: vi.fn(async ({ where }: any) => (h.rows.has(where.id) ? { ...h.rows.get(where.id) } : null)),
        updateMany: vi.fn(async ({ where, data }: any) => {
          let count = 0;
          for (const r of h.rows.values()) {
            if (!matches(r, where)) continue;
            Object.assign(r, data);
            touch(r);
            count++;
          }
          return { count };
        }),
      },
      task: {
        findUnique: vi.fn(async ({ where }: any) => (h.tasks.has(where.id) ? { ...h.tasks.get(where.id) } : null)),
        updateMany: vi.fn(async ({ where, data }: any) => {
          let count = 0;
          for (const t of h.tasks.values()) {
            if (!matches(t, where)) continue;
            Object.assign(t, data);
            count++;
          }
          return { count };
        }),
      },
      aISettings: { findUnique: vi.fn(async () => h.settings) },
      aIInstructions: { findUnique: vi.fn(async () => null) },
    },
  };
});
vi.mock("~/services/ai/ai-credentials.server", () => ({
  settlementCredentialsFor: (...a: unknown[]) => h.settle(...a),
  resolveAiCredentials: (...a: unknown[]) => h.resolve(...a),
  aiServiceFor: (...a: unknown[]) => h.aiServiceFor(...a),
}));
vi.mock("~/services/ai/usage-meter.server", () => ({
  settleBatchUsage: (...a: unknown[]) => (h.order.push("book"), h.booking(...a)),
  convertReservation: (...a: unknown[]) => (h.order.push("convert"), h.convert(...a)),
  releaseBudget: (...a: unknown[]) => (h.order.push("release"), h.release(...a)),
  releaseSettledReservations: (...a: unknown[]) => h.sweep(...a),
}));
vi.mock("~/services/bulk-editor/translate-batch-expiry.server", () => ({
  BATCH_UNREACHABLE_ERROR: "batch_unreachable",
  BATCH_SUBMIT_UNCONFIRMED_ERROR: "batch_submit_unconfirmed",
  OPEN_BATCH_MAX_AGE_MS: 48 * 60 * 60 * 1000,
  expireStaleBatches: (...a: unknown[]) => h.expire(...a),
}));
vi.mock("~/routes/api-ai-handlers/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/routes/api-ai-handlers/shared")>();
  return { ...actual, resolveSeoContext: () => ({ seoTitleMaxChars: 60, seoLimits: null, translationMode: undefined }) };
});
vi.mock("~/utils/logger.server", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import {
  LEASE_MS,
  MAX_FAILED_TICKS,
  MAX_ROWS_PER_TICK,
  acquireLease,
  collectEvidence,
  failedTickBackoffMs,
  pollBatchesOnce,
  processBatchRow,
} from "~/services/bulk-editor/translate-batch-poll.server";
import { itemSignature, serializeManifest, sourceHash, type BatchManifest } from "~/services/bulk-editor/translate-batch.shared";
import { db } from "~/db.server";

const SHOP = "s.myshopify.com";
const sig = (t: string) => itemSignature({ kind: "short", source: t });
const manifest: BatchManifest = {
  v: 1,
  rowType: "product",
  moType: "",
  locales: ["fr"],
  primaryLocale: "de",
  units: 2,
  cells: [{ r: "gid://shopify/Product/1", c: "field.title", l: ["fr"], h: sourceHash("Schal") }],
  requests: [{ customId: "ttask-1_p0", kind: "short", items: [sig("Schal")], maxTokens: 500, inputEstimate: 100 }],
  plan: { skippedChanged: 0, failures: [], mismatchesByKey: {}, notStarted: 0 },
  submittedAt: "2026-11-12T00:00:00Z",
};
const SUCCESS = {
  customId: "ttask-1_p0",
  outcome: "succeeded" as const,
  text: JSON.stringify({ k1: { fr: "Echarpe" } }),
  usage: { inputTokens: 300, outputTokens: 40 },
};

function putRow(over: Record<string, unknown> = {}) {
  h.rows.set("row-1", {
    id: "row-1",
    taskId: "task-1",
    shop: SHOP,
    state: "waiting",
    provider: "claude",
    model: "claude-haiku-4-5",
    source: "managed",
    role: "default",
    batchIds: ["msgbatch_1"],
    fileIds: [],
    manifest: serializeManifest(manifest),
    leaseToken: null,
    leaseUntil: null,
    failedTicks: 0,
    reservationState: "held",
    updatedAt: new Date("2026-11-12T00:00:00Z"),
    ...over,
  });
}
function putTask(status = "waiting_batch") {
  h.tasks.set("task-1", { id: "task-1", shop: SHOP, status });
}

const now = new Date("2026-11-12T10:00:00Z");
const deps = (over: Record<string, unknown> = {}) => ({
  db: db as never,
  now,
  adminFor: async () => ({}),
  // the collect run double: it settles the Task like the real run does
  runCollect: vi.fn(async (input: any) => {
    h.order.push("write");
    h.tasks.get(input.taskId).status = "completed";
    return { retries: 0 };
  }),
  ...over,
});

const DEFAULT_SETTINGS = h.settings;
beforeEach(() => {
  h.settings = DEFAULT_SETTINGS;
  h.rows.clear();
  h.tasks.clear();
  h.order.length = 0;
  for (const fn of [h.find, h.settle, h.resolve, h.aiServiceFor, h.booking, h.convert, h.release, h.sweep, h.expire, h.retrieve, h.cancel, h.results, h.deleteFile]) fn.mockReset();
  h.retrieve.mockResolvedValue({ providerStatus: "ended", ended: true, requestCounts: { total: 1, processing: 0, succeeded: 1, errored: 0, expired: 0, canceled: 0 } });
  h.cancel.mockResolvedValue({ providerStatus: "canceling", ended: false });
  h.results.mockImplementation(() => (async function* () { yield SUCCESS; })());
  h.deleteFile.mockResolvedValue(undefined);
  h.settle.mockResolvedValue({
    ok: true,
    transport: { findIntentBatch: (...a: unknown[]) => (h.order.push("find"), h.find(...a)), retrieve: (...a: unknown[]) => (h.order.push("retrieve"), h.retrieve(...a)), cancel: (...a: unknown[]) => (h.order.push("cancel"), h.cancel(...a)), results: (...a: unknown[]) => (h.order.push("results"), h.results(...a)), deleteFile: h.deleteFile },
  });
  h.resolve.mockReturnValue({ ok: true, source: "managed" });
  h.aiServiceFor.mockReturnValue({ service: { packageLimits: () => ({ provider: "claude" }) }, decision: { ok: true } });
  h.booking.mockResolvedValue({ applied: true, costMicros: 1234, billedMicros: 1234, calls: 1 });
  h.convert.mockResolvedValue({ applied: true, micros: 9 });
  h.release.mockResolvedValue({ applied: true, micros: 9 });
  h.sweep.mockResolvedValue({ released: 0, failed: 0 });
  h.expire.mockResolvedValue({ expired: 0, failed: 0 });
  putRow();
  putTask();
});

describe("the lease", () => {
  it("exactly ONE of two simultaneous ticks takes a row; the other is `busy` and touches nothing", async () => {
    let release!: () => void;
    h.retrieve.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ providerStatus: "in_progress", ended: false }); }));
    const first = processBatchRow("row-1", deps());
    await vi.waitFor(() => expect(h.retrieve).toHaveBeenCalled());
    // second tick while the first holds a valid lease
    expect(await processBatchRow("row-1", deps())).toBe("busy");
    expect(h.retrieve).toHaveBeenCalledTimes(1);
    release();
    expect(await first).toBe("waiting");
    // the lease is given back at the end
    expect(h.rows.get("row-1").leaseToken).toBeNull();
  });

  it("acquireLease is a compare-and-swap: a valid lease blocks, an EXPIRED one (a crashed holder) can be taken over", async () => {
    const a = await acquireLease(db as never, "row-1", now);
    expect(a).toEqual(expect.any(String));
    expect(await acquireLease(db as never, "row-1", now)).toBeNull();
    // the holder died: after LEASE_MS another tick takes over with a new token
    const later = new Date(now.getTime() + LEASE_MS + 1);
    const b = await acquireLease(db as never, "row-1", later);
    expect(b).toEqual(expect.any(String));
    expect(b).not.toBe(a);
  });

  it("never leases a settled row", async () => {
    h.rows.get("row-1").state = "done";
    expect(await acquireLease(db as never, "row-1", now)).toBeNull();
  });
});

describe("a batch the provider is still working on", () => {
  it("stays waiting, pushes the Task's expiry past the provider's, resets the failure count and collects nothing", async () => {
    h.retrieve.mockResolvedValue({ providerStatus: "in_progress", ended: false, expiresAt: "2026-11-13T00:00:00Z" });
    h.rows.get("row-1").failedTicks = 3;
    expect(await processBatchRow("row-1", deps({ now: new Date(now.getTime() + 3 * 3600_000) }))).toBe("waiting");
    expect(h.tasks.get("task-1").expiresAt).toEqual(new Date(Date.parse("2026-11-13T00:00:00Z") + 3 * 24 * 3600 * 1000));
    expect(h.rows.get("row-1").failedTicks).toBe(0);
    expect(h.results).not.toHaveBeenCalled();
    expect(h.booking).not.toHaveBeenCalled();
  });
});

describe("an ended batch: book, THEN write", () => {
  it("fetches the results, books the actual usage BEFORE the write, and settles the row", async () => {
    const d = deps();
    expect(await processBatchRow("row-1", d)).toBe("collected");
    expect(h.order.filter((s) => ["retrieve", "results", "book", "write"].includes(s))).toEqual(["retrieve", "results", "book", "write"]);
    const [rowId, usage, opts] = h.booking.mock.calls[0];
    expect(rowId).toBe("row-1");
    expect(usage).toEqual([{ provider: "claude", model: "claude-haiku-4-5", inputTokens: 300, outputTokens: 40, estimated: false, tier: "standard" }]);
    // the booking is held to THIS tick's lease token
    expect(opts.leaseToken).toEqual(expect.any(String));
    expect(d.runCollect).toHaveBeenCalledTimes(1);
    expect(d.runCollect.mock.calls[0][0]).toMatchObject({ taskId: "task-1", shop: SHOP, manifest: expect.objectContaining({ v: 1 }) });
    expect(h.rows.get("row-1")).toMatchObject({ state: "done", leaseToken: null });
  });

  it("restart mid-collection: a `collecting` row with an expired lease is picked up again, a booking that already happened is not repeated, the write runs again (fill-only)", async () => {
    putRow({ state: "collecting", leaseToken: "dead-holder", leaseUntil: new Date(now.getTime() - 1000) });
    h.booking.mockResolvedValue({ applied: false, reason: "alreadySettled" });
    const d = deps();
    expect(await processBatchRow("row-1", d)).toBe("collected");
    expect(d.runCollect).toHaveBeenCalledTimes(1);
  });

  it("a booking that lost its lease stops the tick before anything is written", async () => {
    h.booking.mockResolvedValue({ applied: false, reason: "leaseLost" });
    const d = deps();
    expect(await processBatchRow("row-1", d)).toBe("leaseLost");
    expect(d.runCollect).not.toHaveBeenCalled();
  });

  it("a booking that FAILED writes nothing and counts a failed tick (it is retried, never skipped)", async () => {
    h.booking.mockResolvedValue({ applied: false, reason: "failed" });
    const d = deps();
    expect(await processBatchRow("row-1", d)).toBe("failedTick");
    expect(d.runCollect).not.toHaveBeenCalled();
    expect(h.rows.get("row-1")).toMatchObject({ failedTicks: 1, state: "waiting" });
  });

  it("an exhausted BUDGET stops neither the fetch nor the write: the budget is not even consulted (the write gate is the resolver)", async () => {
    // nothing in this module reads the budget; the resolver (consent, kill switch, entitlement) is the gate
    const d = deps();
    expect(await processBatchRow("row-1", d)).toBe("collected");
    expect(d.runCollect).toHaveBeenCalled();
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "..", "..", "app/services/bulk-editor/translate-batch-poll.server.ts"), "utf8");
    expect(src).not.toMatch(/managedBudgetStatus|globalPoolStatus|budgetExceeded/);
  });

  it("an own-key row is collected and written without any consent or entitlement question", async () => {
    putRow({ source: "byo", reservationState: "none" });
    h.resolve.mockReturnValue({ ok: false, reason: "consentMissing" }); // would refuse a MANAGED row
    const d = deps();
    expect(await processBatchRow("row-1", d)).toBe("collected");
    expect(d.runCollect).toHaveBeenCalled();
    expect(h.convert).not.toHaveBeenCalled();
  });

  it("deletes the provider files the row names after collecting (none for Anthropic, but the path is there)", async () => {
    putRow({ fileIds: ["file_in"] });
    await processBatchRow("row-1", deps());
    expect(h.deleteFile).toHaveBeenCalledWith("file_in");
  });
});

const WITHDRAWN = { shop: SHOP, subscriptionPlan: "pro", aiProcessingConsentAt: null, aiProcessingConsentVersion: null } as any;
const OUTDATED = { shop: SHOP, subscriptionPlan: "pro", aiProcessingConsentAt: new Date("2026-10-01"), aiProcessingConsentVersion: "1999-01-01" } as any;

describe("consent withdrawn (owner decision): cancel at once, fetch NO CONTENT, write NOTHING, book from the counts or the upper bound", () => {
  it("cancels, reads only the status counts (never the results), books pro rata -- NOT a release -- and fails the Task with the managed code", async () => {
    h.settings = WITHDRAWN;
    const d = deps();
    expect(await processBatchRow("row-1", d)).toBe("consentWithdrawn");
    expect(h.cancel).toHaveBeenCalledWith("msgbatch_1");
    expect(h.retrieve).toHaveBeenCalled(); // a status read: request_counts carry no content
    expect(h.results).not.toHaveBeenCalled();
    expect(h.booking).not.toHaveBeenCalled();
    // one request succeeded: booked at THAT request's reserved upper bound, never released
    expect(h.convert).toHaveBeenCalledWith("row-1", { bookMicros: expect.any(Number) });
    expect(h.convert.mock.calls[0][1].bookMicros).toBeGreaterThan(0);
    expect(h.release).not.toHaveBeenCalled();
    expect(d.runCollect).not.toHaveBeenCalled();
    expect(h.tasks.get("task-1")).toMatchObject({ status: "failed", error: "managed_ai_refused:consentMissing" });
    expect(h.rows.get("row-1")).toMatchObject({ state: "done", consentWithdrawnAt: expect.any(Date) });
  });

  it("the provider proves nothing ran (ended, nothing succeeded): only then the hold goes back", async () => {
    h.settings = WITHDRAWN;
    h.retrieve.mockResolvedValue({ providerStatus: "ended", ended: true, requestCounts: { total: 1, processing: 0, succeeded: 0, errored: 0, expired: 0, canceled: 1 } });
    await processBatchRow("row-1", deps());
    expect(h.release).toHaveBeenCalledWith("row-1");
    expect(h.convert).not.toHaveBeenCalled();
  });

  it("the batch is still being cancelled (not ended): the hold is NOT settled yet, the row stays open and withdrawn", async () => {
    h.settings = WITHDRAWN;
    h.retrieve.mockResolvedValue({ providerStatus: "canceling", ended: false, requestCounts: { total: 1, processing: 1, succeeded: 0, errored: 0, expired: 0, canceled: 0 } });
    expect(await processBatchRow("row-1", deps())).toBe("consentWithdrawn");
    expect(h.convert).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
    expect(h.rows.get("row-1")).toMatchObject({ state: "cancel_requested", consentWithdrawnAt: expect.any(Date) });
    expect(h.tasks.get("task-1").status).toBe("waiting_batch");
    // next tick: the batch ended with a result: booked, closed -- even if the merchant consented again meanwhile
    h.settings = { ...WITHDRAWN, aiProcessingConsentAt: new Date(), aiProcessingConsentVersion: "2026-09-20.2" };
    h.retrieve.mockResolvedValue({ providerStatus: "ended", ended: true, requestCounts: { total: 1, processing: 0, succeeded: 1, errored: 0, expired: 0, canceled: 0 } });
    const d = deps();
    expect(await processBatchRow("row-1", d)).toBe("consentWithdrawn");
    expect(h.convert).toHaveBeenCalledWith("row-1", { bookMicros: expect.any(Number) });
    expect(d.runCollect).not.toHaveBeenCalled();
    expect(h.rows.get("row-1").state).toBe("done");
  });

  it("the counts cannot be read: the row waits (the absolute end converts the upper bound) -- never released", async () => {
    h.settings = WITHDRAWN;
    h.cancel.mockRejectedValue(new Error("down"));
    h.retrieve.mockRejectedValue(new Error("down"));
    expect(await processBatchRow("row-1", deps())).toBe("consentWithdrawn");
    expect(h.convert).not.toHaveBeenCalled(); // not the last look: the row waits
    expect(h.release).not.toHaveBeenCalled();
    expect(h.rows.get("row-1").state).toBe("cancel_requested");
  });

  it("withdrawal is judged before the kill switch: with the switch on the row waits (configBlocked), nothing is released or booked", async () => {
    h.settings = WITHDRAWN;
    h.settle.mockResolvedValue({ ok: false, reason: "managedDisabled" });
    expect(await processBatchRow("row-1", deps())).toBe("configBlocked");
    expect(h.release).not.toHaveBeenCalled();
    expect(h.convert).not.toHaveBeenCalled();
    expect(h.rows.get("row-1").failedTicks).toBe(0);
    expect(h.rows.get("row-1").consentWithdrawnAt).toEqual(expect.any(Date));
  });

  it("works for a shop whose Shopify connection is blocked: the consent gate comes before the admin lookup", async () => {
    h.settings = WITHDRAWN;
    const d = deps({ adminFor: async () => { throw new Error("connection blocked"); } });
    expect(await processBatchRow("row-1", d)).toBe("consentWithdrawn");
    expect(h.cancel).toHaveBeenCalled();
  });
});

describe("consent NOTICE VERSION bumped (not withdrawn): hold the row", () => {
  it("cancels nothing, reads nothing, fetches nothing, writes nothing, settles nothing", async () => {
    h.settings = OUTDATED;
    const d = deps();
    expect(await processBatchRow("row-1", d)).toBe("consentOutdated");
    for (const fn of [h.cancel, h.retrieve, h.results, h.booking, h.convert, h.release]) expect(fn).not.toHaveBeenCalled();
    expect(d.runCollect).not.toHaveBeenCalled();
    expect(h.rows.get("row-1").state).toBe("waiting");
    expect(h.tasks.get("task-1").status).toBe("waiting_batch");
  });

  it("when the merchant confirms the new notice the row simply continues", async () => {
    h.settings = OUTDATED;
    await processBatchRow("row-1", deps());
    h.settings = { ...OUTDATED, aiProcessingConsentVersion: "2026-09-20.2" };
    expect(await processBatchRow("row-1", deps())).toBe("collected");
  });
});

describe("the write gate refuses (kill switch / entitlement gone): collect and BOOK, do not write", () => {
  for (const reason of ["managedUnavailable", "noKey"] as const) {
    it(`${reason}: results are fetched and booked, nothing is written, the Task fails as managed_ai_refused`, async () => {
      h.resolve.mockReturnValue({ ok: false, reason });
      const d = deps();
      expect(await processBatchRow("row-1", d)).toBe("refusedWrite");
      expect(h.results).toHaveBeenCalled();
      expect(h.booking).toHaveBeenCalledTimes(1);
      expect(d.runCollect).not.toHaveBeenCalled();
      expect(h.tasks.get("task-1")).toMatchObject({ status: "failed", error: "managed_ai_refused:managedUnavailable" });
      expect(h.rows.get("row-1").state).toBe("done");
    });
  }
});

describe("cancel_requested (merchant cancel)", () => {
  it("cancels at the provider, THEN collects what is paid for and writes it", async () => {
    putTask("cancel_requested");
    putRow({ state: "cancel_requested" });
    const d = deps();
    expect(await processBatchRow("row-1", d)).toBe("collected");
    expect(h.order.indexOf("cancel")).toBeLessThan(h.order.indexOf("retrieve"));
    expect(d.runCollect).toHaveBeenCalled();
  });

  it("a cancel before anything ran (no usable result) ends the Task as `cancelled`, not failed", async () => {
    putTask("cancel_requested");
    putRow({ state: "cancel_requested" });
    h.retrieve.mockResolvedValue({ providerStatus: "ended", ended: true, requestCounts: { total: 1, processing: 0, succeeded: 0, errored: 1, expired: 0, canceled: 0 } });
    h.results.mockImplementation(() => (async function* () { yield { customId: "ttask-1_p0", outcome: "canceled" as const }; })());
    const d = deps();
    expect(await processBatchRow("row-1", d)).toBe("noResult");
    expect(h.tasks.get("task-1").status).toBe("cancelled");
    expect(d.runCollect).not.toHaveBeenCalled();
  });

  it("a cancel the provider refuses while the batch still runs is a failed tick (counted); cancelRequestedAt stays unset, so the next tick cancels again", async () => {
    putTask("cancel_requested");
    putRow({ state: "cancel_requested" });
    h.cancel.mockRejectedValue(new Error("503"));
    h.retrieve.mockResolvedValue({ providerStatus: "in_progress", ended: false });
    expect(await processBatchRow("row-1", deps())).toBe("failedTick");
    expect(h.rows.get("row-1").failedTicks).toBe(1);
    expect(h.rows.get("row-1").cancelRequestedAt).toBeUndefined();
    h.cancel.mockResolvedValue({ providerStatus: "canceling", ended: false });
    await processBatchRow("row-1", deps({ now: new Date("2026-11-12T11:00:00Z") }));
    expect(h.cancel).toHaveBeenCalledTimes(2);
    expect(h.rows.get("row-1").cancelRequestedAt).toEqual(expect.any(Date));
  });

  it("a cancel that errors but the batch has ENDED: collection goes on (an ended batch needs no cancel)", async () => {
    putTask("cancel_requested");
    putRow({ state: "cancel_requested" });
    h.cancel.mockRejectedValue(new Error("batch already ended"));
    expect(await processBatchRow("row-1", deps())).toBe("collected");
  });

  it("a confirmed cancel (cancelRequestedAt set) is NOT repeated: an ended batch whose cancel would error still collects", async () => {
    putTask("cancel_requested");
    putRow({ state: "cancel_requested", cancelRequestedAt: new Date("2026-11-12T09:00:00Z") });
    h.cancel.mockRejectedValue(new Error("batch already ended"));
    expect(await processBatchRow("row-1", deps())).toBe("collected");
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it("a cancel_requested row of an UNINSTALLED shop still gets its provider cancel every tick; no content is fetched, nothing written", async () => {
    putTask("cancel_requested");
    putRow({ state: "cancel_requested" });
    h.cancel.mockRejectedValue(new Error("503"));
    const d = deps({ adminFor: async () => { throw new Error("shop uninstalled"); } });
    expect(await processBatchRow("row-1", d)).toBe("skippedShop");
    expect(h.cancel).toHaveBeenCalledTimes(1);
    expect(h.rows.get("row-1").cancelRequestedAt).toBeUndefined();
    expect(h.rows.get("row-1").state).toBe("cancel_requested");
    h.cancel.mockResolvedValue({ providerStatus: "canceling", ended: false });
    expect(await processBatchRow("row-1", d)).toBe("skippedShop");
    expect(h.cancel).toHaveBeenCalledTimes(2);
    expect(h.rows.get("row-1").cancelRequestedAt).toEqual(expect.any(Date));
    expect(h.results).not.toHaveBeenCalled();
    expect(d.runCollect).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
  });

  it("no settlement access (own key gone): the row is NOT closed, left to the absolute end", async () => {
    putTask("cancel_requested");
    putRow({ state: "cancel_requested", source: "own" });
    h.settle.mockResolvedValue({ ok: false, reason: "ai_key_missing" });
    expect(await processBatchRow("row-1", deps())).toBe("keyMissing");
    expect(h.rows.get("row-1").state).toBe("cancel_requested");
    expect(h.tasks.get("task-1").status).toBe("cancel_requested");
  });
});

describe("rule: an orphan / withdrawn row closes only after a CONFIRMED cancel or an ENDED batch", () => {
  it("orphan, cancel fails, batch still running: row stays open, hold untouched; next tick retries the cancel", async () => {
    putTask("failed");
    h.cancel.mockRejectedValue(new Error("503"));
    h.retrieve.mockResolvedValue({ providerStatus: "in_progress", ended: false });
    expect(await processBatchRow("row-1", deps())).toBe("orphan");
    expect(h.rows.get("row-1").state).toBe("waiting");
    expect(h.rows.get("row-1").cancelRequestedAt).toBeUndefined();
    expect(h.convert).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
    await processBatchRow("row-1", deps());
    expect(h.cancel).toHaveBeenCalledTimes(2);
  });

  it("orphan, cancel fails but the provider shows the batch ENDED: settled and closed", async () => {
    putTask("failed");
    h.cancel.mockRejectedValue(new Error("already ended"));
    expect(await processBatchRow("row-1", deps())).toBe("orphan");
    expect(h.rows.get("row-1").state).toBe("done");
    expect(h.convert).toHaveBeenCalled();
  });

  it("withdrawn, cancel fails, batch running: no close, no content fetch", async () => {
    h.settings = WITHDRAWN;
    h.cancel.mockRejectedValue(new Error("503"));
    h.retrieve.mockResolvedValue({ providerStatus: "in_progress", ended: false });
    const d = deps();
    expect(await processBatchRow("row-1", d)).toBe("consentWithdrawn");
    expect(h.rows.get("row-1").state).not.toBe("done");
    expect(h.rows.get("row-1").cancelRequestedAt).toBeUndefined();
    expect(h.results).not.toHaveBeenCalled();
    expect(h.convert).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
  });
});

describe("L2: the result stream must account for every request the provider says succeeded", () => {
  it("a stream that stops early is a FAILED TICK: nothing booked, nothing written, the row goes back to waiting", async () => {
    h.retrieve.mockResolvedValue({ providerStatus: "ended", ended: true, requestCounts: { total: 2, processing: 0, succeeded: 2, errored: 0, expired: 0, canceled: 0 } });
    const d = deps();
    expect(await processBatchRow("row-1", d)).toBe("failedTick");
    expect(h.booking).not.toHaveBeenCalled();
    expect(d.runCollect).not.toHaveBeenCalled();
    expect(h.rows.get("row-1")).toMatchObject({ failedTicks: 1, state: "waiting" });
    expect(h.tasks.get("task-1").status).toBe("waiting_batch");
  });

  it("a complete stream (every succeeded request seen) proceeds; counts the provider did not give are not a reason to refuse", async () => {
    h.retrieve.mockResolvedValue({ providerStatus: "ended", ended: true });
    expect(await processBatchRow("row-1", deps())).toBe("collected");
  });
});

describe("an ended batch with nothing usable", () => {
  it("every request expired: a whole run without a result -> failed, batch_expired, booked (nothing to bill), nothing re-submitted", async () => {
    h.retrieve.mockResolvedValue({ providerStatus: "ended", ended: true, requestCounts: { total: 1, processing: 0, succeeded: 0, errored: 1, expired: 0, canceled: 0 } });
    h.results.mockImplementation(() => (async function* () { yield { customId: "ttask-1_p0", outcome: "expired" as const }; })());
    const d = deps();
    expect(await processBatchRow("row-1", d)).toBe("noResult");
    expect(h.tasks.get("task-1")).toMatchObject({ status: "failed", error: "batch_expired" });
    expect(d.runCollect).not.toHaveBeenCalled();
    expect(h.booking).toHaveBeenCalledWith("row-1", [], expect.anything());
  });

  it("every request errored: failed with batch_failed", async () => {
    h.retrieve.mockResolvedValue({ providerStatus: "ended", ended: true, requestCounts: { total: 1, processing: 0, succeeded: 0, errored: 1, expired: 0, canceled: 0 } });
    h.results.mockImplementation(() => (async function* () { yield { customId: "ttask-1_p0", outcome: "errored" as const, error: "overloaded" }; })());
    await processBatchRow("row-1", deps());
    expect(h.tasks.get("task-1")).toMatchObject({ status: "failed", error: "batch_failed" });
  });

  it("an unreadable manifest ends the run, the results cannot be matched but the batch RAN: the hold is converted to the upper bound, never released", async () => {
    putRow({ manifest: "not json" });
    expect(await processBatchRow("row-1", deps())).toBe("noResult");
    expect(h.convert).toHaveBeenCalledWith("row-1");
    expect(h.release).not.toHaveBeenCalled();
  });
});

describe("a provider that stops answering", () => {
  it("each failed retrieve is counted and the row goes back to waiting", async () => {
    h.retrieve.mockRejectedValue(new Error("404"));
    expect(await processBatchRow("row-1", deps())).toBe("failedTick");
    expect(h.rows.get("row-1")).toMatchObject({ failedTicks: 1, state: "waiting" });
    expect(h.tasks.get("task-1").status).toBe("waiting_batch");
  });

  it(`after ${MAX_FAILED_TICKS} failures in a row: batch_unreachable (terminal); unreadable = the hold is CONVERTED to the upper bound, not released`, async () => {
    endedAtLastLook();
    h.rows.get("row-1").failedTicks = MAX_FAILED_TICKS - 1;
    expect(await processBatchRow("row-1", deps())).toBe("unreachable");
    expect(h.tasks.get("task-1")).toMatchObject({ status: "batch_unreachable", error: "batch_unreachable" });
    expect(h.rows.get("row-1").state).toBe("done");
    expect(h.convert).toHaveBeenCalledWith("row-1");
    expect(h.release).not.toHaveBeenCalled();
  });

  it("a batch that is NOT provably ended is never given up on at tick 12: counting goes on, hold and Task untouched (the 48 h expiry is the end)", async () => {
    h.retrieve.mockRejectedValue(new Error("403"));
    h.rows.get("row-1").failedTicks = MAX_FAILED_TICKS - 1;
    expect(await processBatchRow("row-1", deps())).toBe("failedTick");
    expect(h.rows.get("row-1")).toMatchObject({ failedTicks: MAX_FAILED_TICKS, state: "waiting" });
    expect(h.tasks.get("task-1").status).toBe("waiting_batch");
    expect(h.convert).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
    h.rows.get("row-1").leaseToken = null;
    h.rows.get("row-1").updatedAt = new Date("2026-11-12T00:00:00Z");
    expect(await processBatchRow("row-1", deps())).toBe("failedTick");
    expect(h.rows.get("row-1").failedTicks).toBe(MAX_FAILED_TICKS + 1);
  });

  it("unreachable at the end but the counts CAN be read at the last look: an ended batch with nothing succeeded releases", async () => {
    h.retrieve.mockRejectedValueOnce(new Error("403")); // the tick's own retrieve fails ...
    h.retrieve.mockResolvedValue({ providerStatus: "ended", ended: true, requestCounts: { total: 1, processing: 0, succeeded: 0, errored: 1, expired: 0, canceled: 0 } }); // ... the last look works
    h.rows.get("row-1").failedTicks = MAX_FAILED_TICKS - 1;
    expect(await processBatchRow("row-1", deps())).toBe("unreachable");
    expect(h.release).toHaveBeenCalledWith("row-1");
  });

  it("a tick whose lease was taken over mid-tick gives up nothing, closes nothing, settles nothing (leaseLost)", async () => {
    h.rows.get("row-1").failedTicks = MAX_FAILED_TICKS - 1;
    h.retrieve.mockImplementation(async () => {
      h.rows.get("row-1").leaseToken = "someone-else";
      throw new Error("403");
    });
    expect(await processBatchRow("row-1", deps())).toBe("leaseLost");
    expect(h.tasks.get("task-1").status).toBe("waiting_batch");
    expect(h.rows.get("row-1").state).not.toBe("done");
    expect(h.convert).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
  });

  it("a withdrawn row whose settlement lookup keeps failing: no give-up while the batch is not provably ended (no transport)", async () => {
    h.settings = WITHDRAWN;
    h.settle.mockResolvedValue({ ok: false, reason: "lookup_failed" });
    h.rows.get("row-1").failedTicks = MAX_FAILED_TICKS - 1;
    h.rows.get("row-1").lastError = "batch_collect_failed:booking_failed";
    h.rows.get("row-1").reservationState = "converted";
    h.rows.get("row-1").cancelRequestedAt = new Date("2026-11-12T09:00:00Z");
    expect(await processBatchRow("row-1", deps())).toBe("failedTick");
    expect(h.tasks.get("task-1").status).toBe("waiting_batch");
  });

  it("an EARLIER tick reached the collect, the last one fails at a status read: given up as batch_collect_failed, never 'nothing was written'", async () => {
    h.rows.get("row-1").failedTicks = MAX_FAILED_TICKS - 1;
    h.rows.get("row-1").lastError = "batch_collect_failed:results_incomplete:0/1";
    endedAtLastLook();
    expect(await processBatchRow("row-1", deps())).toBe("unreachable");
    expect(h.tasks.get("task-1")).toMatchObject({ status: "failed", error: "batch_collect_failed" });
  });

  it("collectEvidence: marker / collecting / managed converted count; released, none and shop_removed do not", () => {
    expect(collectEvidence({ lastError: "batch_collect_failed:x" })).toBe(true);
    expect(collectEvidence({ state: "collecting" })).toBe(true);
    expect(collectEvidence({ source: "managed", reservationState: "converted" })).toBe(true);
    expect(collectEvidence({ source: "managed", reservationState: "released" })).toBe(false);
    expect(collectEvidence({ source: "managed", reservationState: "none" })).toBe(false);
    expect(collectEvidence({ source: "managed", reservationState: "converted", lastError: "shop_removed" })).toBe(false);
    expect(collectEvidence({ source: "own", reservationState: "converted" })).toBe(false);
  });

  it("collect failures add up across ticks: the counter is not reset by step 8 when the row carries a collect failure", async () => {
    h.rows.get("row-1").failedTicks = MAX_FAILED_TICKS - 1;
    h.rows.get("row-1").lastError = "batch_collect_failed:booking_failed";
    h.booking.mockResolvedValue({ applied: false, reason: "failed" });
    expect(await processBatchRow("row-1", deps())).toBe("unreachable");
    expect(h.tasks.get("task-1")).toMatchObject({ error: "batch_collect_failed" });
  });

  it("a collect failure is marked in lastError, and a later early failure keeps the mark", async () => {
    h.booking.mockResolvedValue({ applied: false, reason: "failed" });
    await processBatchRow("row-1", deps());
    expect(h.rows.get("row-1").lastError).toMatch(/^batch_collect_failed:/);
    h.rows.get("row-1").leaseToken = null;
    h.rows.get("row-1").updatedAt = new Date("2026-11-12T00:00:00Z");
    h.retrieve.mockRejectedValue(new Error("403"));
    await processBatchRow("row-1", deps());
    expect(h.rows.get("row-1").lastError).toMatch(/^batch_collect_failed:/);
    expect(h.rows.get("row-1").failedTicks).toBe(2);
  });

  it("a hold is settled BEFORE the row is marked done (the sweep must never see a done row with a hold that should be converted)", async () => {
    endedAtLastLook();
    h.rows.get("row-1").failedTicks = MAX_FAILED_TICKS - 1;
    let stateAtConvert = "";
    h.convert.mockImplementation(async () => { stateAtConvert = h.rows.get("row-1").state; return { applied: true, micros: 9 }; });
    await processBatchRow("row-1", deps());
    expect(stateAtConvert).not.toBe("done");
    expect(h.rows.get("row-1").state).toBe("done");
  });

  for (const reason of ["managedDisabled", "devBuild", "noCredential", "providerChanged"]) {
    it(`our own configuration refusing (${reason}) is NOT a failed tick: the row waits, the failure count stays 0`, async () => {
      h.settle.mockResolvedValue({ ok: false, reason });
      expect(await processBatchRow("row-1", deps())).toBe("configBlocked");
      expect(h.rows.get("row-1")).toMatchObject({ failedTicks: 0, state: "waiting" });
      expect(h.convert).not.toHaveBeenCalled();
      expect(h.release).not.toHaveBeenCalled();
    });
  }

  it("a settlement lookup failure still counts like an unreachable provider", async () => {
    h.settle.mockResolvedValue({ ok: false, reason: "lookupFailed" });
    expect(await processBatchRow("row-1", deps())).toBe("failedTick");
    expect(h.rows.get("row-1").failedTicks).toBe(1);
  });

  it("back-off: 5, 10, 20, then 30 minutes", () => {
    expect([0, 1, 2, 3, 4, 9].map(failedTickBackoffMs)).toEqual([0, 5, 10, 20, 30, 30].map((m) => m * 60_000));
  });

  it("the TICK does not even SELECT a row inside its back-off window, and takes it once the window is over -- decided on the timestamps the select saw", async () => {
    h.retrieve.mockResolvedValue({ providerStatus: "in_progress", ended: false });
    putRow({ failedTicks: 2, updatedAt: new Date(now.getTime() - 4 * 60_000) });
    expect(await pollBatchesOnce(deps())).toMatchObject({ rows: 0, outcomes: {} });
    expect(h.retrieve).not.toHaveBeenCalled();
    putRow({ failedTicks: 2, updatedAt: new Date(now.getTime() - 11 * 60_000) });
    expect((await pollBatchesOnce(deps())).outcomes).toEqual({ waiting: 1 });
  });

  it("STARVATION: more than a tick's worth of failing rows (which sort first, being oldest) do not keep a healthy row from being taken", async () => {
    h.retrieve.mockResolvedValue({ providerStatus: "in_progress", ended: false });
    for (let i = 0; i < MAX_ROWS_PER_TICK + 5; i++) {
      h.rows.set(`bad-${i}`, { ...h.rows.get("row-1"), id: `bad-${i}`, taskId: `bad-task-${i}`, failedTicks: 3, updatedAt: new Date(now.getTime() - (60 - i) * 1000) });
    }
    h.rows.set("healthy", { ...h.rows.get("row-1"), id: "healthy", taskId: "task-h", failedTicks: 0, updatedAt: new Date(now.getTime() - 1000) });
    h.tasks.set("task-h", { id: "task-h", shop: SHOP, status: "waiting_batch" });
    h.rows.delete("row-1");
    const stats = await pollBatchesOnce(deps());
    expect(stats.outcomes).toEqual({ waiting: 1 });
    expect(h.retrieve).toHaveBeenCalledTimes(1);
  });
});

describe("a BYO shop whose key is gone", () => {
  it("fails the Task as ai_key_missing (the batch runs out at the provider), nothing is fetched", async () => {
    putRow({ source: "byo", reservationState: "none" });
    h.settle.mockResolvedValue({ ok: false, reason: "ai_key_missing" });
    expect(await processBatchRow("row-1", deps())).toBe("keyMissing");
    expect(h.tasks.get("task-1")).toMatchObject({ status: "failed", error: "ai_key_missing" });
    expect(h.results).not.toHaveBeenCalled();
  });
});

describe("orphan rows (the Task is terminal or gone)", () => {
  it("a terminal Task: the batch is cancelled, the counts are READ -- a result exists, so the hold is booked pro rata, not released", async () => {
    putTask("failed");
    expect(await processBatchRow("row-1", deps())).toBe("orphan");
    expect(h.cancel).toHaveBeenCalledWith("msgbatch_1");
    expect(h.retrieve).toHaveBeenCalled();
    expect(h.convert).toHaveBeenCalledWith("row-1", { bookMicros: expect.any(Number) });
    expect(h.release).not.toHaveBeenCalled();
    expect(h.rows.get("row-1").state).toBe("done");
    expect(h.results).not.toHaveBeenCalled();
  });

  it("the provider PROVES nothing ran (ended, nothing succeeded): then, and only then, the hold goes back", async () => {
    putTask("failed");
    h.retrieve.mockResolvedValue({ providerStatus: "ended", ended: true, requestCounts: { total: 1, processing: 0, succeeded: 0, errored: 0, expired: 0, canceled: 1 } });
    expect(await processBatchRow("row-1", deps())).toBe("orphan");
    expect(h.release).toHaveBeenCalledWith("row-1");
    expect(h.convert).not.toHaveBeenCalled();
  });

  it("a confirmed cancel is not proof: the batch is still canceling, so nothing is settled yet and the row stays open", async () => {
    putTask("failed");
    h.retrieve.mockResolvedValue({ providerStatus: "canceling", ended: false, requestCounts: { total: 1, processing: 1, succeeded: 0, errored: 0, expired: 0, canceled: 0 } });
    expect(await processBatchRow("row-1", deps())).toBe("orphan");
    expect(h.release).not.toHaveBeenCalled();
    expect(h.convert).not.toHaveBeenCalled();
    expect(h.rows.get("row-1").state).toBe("waiting");
    // the cancel is not repeated on the next tick
    expect(h.rows.get("row-1").cancelRequestedAt).toEqual(expect.any(Date));
    await processBatchRow("row-1", deps());
    expect(h.cancel).toHaveBeenCalledTimes(1);
  });

  it("a Task that no longer exists and a provider that cannot be read: the row stays open for the absolute end (converted there)", async () => {
    h.tasks.clear();
    h.cancel.mockRejectedValue(new Error("down"));
    h.retrieve.mockRejectedValue(new Error("down"));
    expect(await processBatchRow("row-1", deps())).toBe("orphan");
    expect(h.convert).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
    expect(h.rows.get("row-1").state).toBe("waiting");
  });

  it("works for a blocked shop: the orphan logic does not need Shopify", async () => {
    putTask("failed");
    const d = deps({ adminFor: async () => { throw new Error("connection blocked"); } });
    expect(await processBatchRow("row-1", d)).toBe("orphan");
    expect(h.cancel).toHaveBeenCalled();
  });

  it("only rows THIS database knows are ever touched: the tick selects from its own table", async () => {
    // a foreign provider batch has no row; nothing in the tick lists provider batches
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "..", "..", "app/services/bulk-editor/translate-batch-poll.server.ts"), "utf8");
    expect(src).not.toMatch(/\.list\(/);
  });
});

describe("a create of unknown outcome (create_unknown)", () => {
  const unknownRow = (over: Record<string, unknown> = {}) =>
    putRow({ state: "create_unknown", batchIds: [], idPrefix: "ttask-1_p", intentAt: new Date("2026-11-12T09:59:00Z"), ...over });

  it("searches the provider by the run's own id prefix and request count, and ADOPTS the batch it finds", async () => {
    unknownRow();
    h.find.mockResolvedValue({ found: true, batchId: "msgbatch_found", expiresAt: "2026-11-13T09:59:00Z" });
    expect(await processBatchRow("row-1", deps())).toBe("adopted");
    expect(h.find).toHaveBeenCalledWith({ idPrefix: "ttask-1_p", since: "2026-11-12T09:59:00.000Z", requestCount: 1 });
    expect(h.rows.get("row-1")).toMatchObject({ batchIds: ["msgbatch_found"], state: "waiting", failedTicks: 0 });
    expect(h.tasks.get("task-1").expiresAt).toEqual(new Date(Date.parse("2026-11-13T09:59:00Z") + 3 * 24 * 3600 * 1000));
    // nothing is collected, booked or settled in the same tick
    expect(h.results).not.toHaveBeenCalled();
    expect(h.convert).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
  });

  it("an adopt whose conditional update matched nothing (lease taken over meanwhile) bails for this tick: no Task expiry write", async () => {
    unknownRow();
    h.find.mockImplementation(async () => {
      h.rows.get("row-1").leaseToken = "someone-else";
      return { found: true, batchId: "msgbatch_found", expiresAt: "2026-11-13T09:59:00Z" };
    });
    expect(await processBatchRow("row-1", deps())).toBe("waiting");
    expect(h.tasks.get("task-1").expiresAt).toBeUndefined();
    expect(h.rows.get("row-1").batchIds).toEqual([]);
  });

  it("a create_unknown row that already NAMES a batch goes to that id: no provider search, state waiting", async () => {
    unknownRow({ batchIds: ["msgbatch_named"] });
    await processBatchRow("row-1", deps());
    expect(h.find).not.toHaveBeenCalled();
    expect(h.rows.get("row-1").state).not.toBe("create_unknown");
    expect(h.rows.get("row-1").batchIds).toEqual(["msgbatch_named"]);
  });

  it("an adopted batch of a Task the merchant cancelled meanwhile continues as cancel_requested", async () => {
    unknownRow();
    putTask("cancel_requested");
    h.find.mockResolvedValue({ found: true, batchId: "msgbatch_found", expiresAt: null });
    await processBatchRow("row-1", deps());
    expect(h.rows.get("row-1").state).toBe("cancel_requested");
  });

  it("nothing found (or only a running candidate): the row waits, the hold is kept -- released by nobody", async () => {
    unknownRow();
    for (const answer of [{ found: false, pending: false }, { found: false, pending: true }]) {
      h.find.mockResolvedValue(answer);
      expect(await processBatchRow("row-1", deps())).toBe("waiting");
    }
    expect(h.release).not.toHaveBeenCalled();
    expect(h.convert).not.toHaveBeenCalled();
    expect(h.rows.get("row-1").state).toBe("create_unknown");
  });

  it("our own configuration refusing is not a failed tick", async () => {
    unknownRow();
    h.settle.mockResolvedValue({ ok: false, reason: "managedDisabled" });
    expect(await processBatchRow("row-1", deps())).toBe("configBlocked");
    expect(h.rows.get("row-1").failedTicks).toBe(0);
  });

  it("a provider that fails the search counts as a failed tick; with the intent recorded there is NO give-up (the 48 h expiry is the hard end)", async () => {
    unknownRow({ failedTicks: MAX_FAILED_TICKS - 1 });
    h.find.mockRejectedValue(new Error("503"));
    expect(await processBatchRow("row-1", deps())).toBe("failedTick");
    expect(h.rows.get("row-1")).toMatchObject({ state: "create_unknown", failedTicks: MAX_FAILED_TICKS });
    expect(h.tasks.get("task-1").status).toBe("waiting_batch");
    expect(h.convert).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
  });

  it("an orphan row with no batch id also searches (so the next tick can cancel what it finds)", async () => {
    unknownRow();
    putTask("failed");
    h.find.mockResolvedValue({ found: true, batchId: "msgbatch_found", expiresAt: null });
    expect(await processBatchRow("row-1", deps())).toBe("adopted");
    expect(h.rows.get("row-1").state).toBe("cancel_requested");
  });
});

describe("shops the tick must not talk to", () => {
  it("a blocked / uninstalled shop is skipped with no provider call and no state change", async () => {
    const d = deps({ adminFor: async () => { throw new Error("connection blocked"); } });
    expect(await processBatchRow("row-1", d)).toBe("skippedShop");
    expect(h.retrieve).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.rows.get("row-1").state).toBe("waiting");
  });
});

describe("State M2: an exception in the write step is a failed tick (with back-off), not an uncounted error", () => {
  it("the collect run throwing counts a failed tick and sends the row back to waiting", async () => {
    const d = deps({ runCollect: vi.fn(async () => { throw new Error("db down"); }) });
    expect(await processBatchRow("row-1", d)).toBe("failedTick");
    expect(h.rows.get("row-1")).toMatchObject({ failedTicks: 1, state: "waiting" });
    expect(h.tasks.get("task-1").status).toBe("waiting_batch");
  });

  it("so does a failing step BEFORE the run (the SEO context)", async () => {
    h.aiServiceFor.mockImplementation(() => { throw new Error("nope"); }); // swallowed: live retries are a bonus
    const d = deps({ runCollect: vi.fn(async () => { throw new Error("scan failed"); }) });
    expect(await processBatchRow("row-1", d)).toBe("failedTick");
  });
});

describe("a collect that stays open is counted and given up on (batch_collect_failed)", () => {
  const staysOpen = () => deps({ runCollect: vi.fn(async () => ({ retries: 0 })) }); // leaves the Task open

  it("counts a failed tick below the limit and sends the row back to waiting", async () => {
    expect(await processBatchRow("row-1", staysOpen())).toBe("failedTick");
    expect(h.rows.get("row-1")).toMatchObject({ failedTicks: 1, state: "waiting" });
    expect(h.tasks.get("task-1").status).toBe("waiting_batch");
  });

  it(`after ${MAX_FAILED_TICKS} in a row: the hold is settled FIRST (pro rata, never released), then the Task fails with batch_collect_failed`, async () => {
    h.rows.get("row-1").failedTicks = MAX_FAILED_TICKS - 1;
    h.rows.get("row-1").lastError = "batch_collect_failed:batch_collect_failed"; // eleven earlier collects failed (the counter is kept)
    let stateAtConvert = "";
    h.convert.mockImplementation(async () => { stateAtConvert = h.rows.get("row-1").state; return { applied: true, micros: 9 }; });
    expect(await processBatchRow("row-1", staysOpen())).toBe("unreachable");
    expect(stateAtConvert).not.toBe("done");
    expect(h.convert).toHaveBeenCalledWith("row-1", { bookMicros: expect.any(Number) });
    expect(h.release).not.toHaveBeenCalled();
    expect(h.tasks.get("task-1")).toMatchObject({ status: "failed", error: "batch_collect_failed" });
    expect(h.rows.get("row-1").state).toBe("done");
  });
});

describe("an orphan row with no batch id and no standing consent never searches (the search reads result content)", () => {
  for (const [name, settings] of [["withdrawn", WITHDRAWN], ["notice outdated", OUTDATED]] as const) {
    it(`${name}: findIntentBatch is not called, nothing is settled, the row is left to the absolute end`, async () => {
      putRow({ state: "create_unknown", batchIds: [], idPrefix: "ttask-1_p", intentAt: new Date("2026-11-12T09:59:00Z") });
      putTask("failed");
      h.settings = settings;
      expect(await processBatchRow("row-1", deps())).toBe("orphan");
      expect(h.find).not.toHaveBeenCalled();
      expect(h.release).not.toHaveBeenCalled();
      expect(h.convert).not.toHaveBeenCalled();
      expect(h.rows.get("row-1").state).toBe("create_unknown");
    });
  }
});

describe("State M4: the collect keeps asking whether this tick still holds the lease", () => {
  it("is handed to the write; it answers true while the token is ours and false once another holder has taken the row", async () => {
    let askLease!: () => Promise<boolean>;
    const d = deps({
      runCollect: vi.fn(async (input: any) => {
        askLease = input.leaseHeld;
        expect(await input.leaseHeld()).toBe(true);
        // somebody else takes the row (our renew stalled): the next check -- after the throttle window -- says no
        h.rows.get("row-1").leaseToken = "someone-else";
        vi.useFakeTimers();
        vi.setSystemTime(new Date(Date.now() + 10_000));
        try {
          expect(await input.leaseHeld()).toBe(false);
          expect(await input.leaseHeld()).toBe(false); // and stays false
        } finally {
          vi.useRealTimers();
        }
        h.tasks.get(input.taskId).status = "waiting_batch";
        return { retries: 0 };
      }),
    });
    await processBatchRow("row-1", d);
    expect(askLease).toBeTypeOf("function");
  });
});

describe("a lease check that THROWS is not 'held'", () => {
  it("answers false (the write stops cleanly) instead of rejecting", async () => {
    let answer: boolean | undefined;
    const d = deps({
      runCollect: vi.fn(async (input: any) => {
        const spy = vi.spyOn((db as any).bulkTranslateBatch, "findUnique").mockRejectedValueOnce(new Error("db down"));
        try {
          answer = await input.leaseHeld();
        } finally {
          spy.mockRestore();
        }
        return { retries: 0 };
      }),
    });
    await processBatchRow("row-1", d);
    expect(answer).toBe(false);
  });
});

describe("the tick", () => {
  it("first closes what passed its absolute end and sweeps lost reservations, then handles the open rows", async () => {
    h.retrieve.mockResolvedValue({ providerStatus: "in_progress", ended: false });
    h.expire.mockResolvedValue({ expired: 2, failed: 0 });
    const stats = await pollBatchesOnce(deps());
    expect(h.expire).toHaveBeenCalledTimes(1);
    expect(h.sweep).toHaveBeenCalledTimes(1);
    expect(stats).toMatchObject({ expired: 2, rows: 1, outcomes: { waiting: 1 } });
  });

  it("never throws: a failing row does not stop the rest, a failing sweep does not stop the tick", async () => {
    putRow();
    h.rows.set("row-2", { ...h.rows.get("row-1"), id: "row-2", taskId: "task-2" });
    h.tasks.set("task-2", { id: "task-2", shop: SHOP, status: "waiting_batch" });
    h.settle.mockRejectedValueOnce(new Error("boom"));
    h.retrieve.mockResolvedValue({ providerStatus: "in_progress", ended: false });
    h.sweep.mockRejectedValue(new Error("sweep down"));
    await expect(pollBatchesOnce(deps())).resolves.toBeDefined();
  });

  it("a settled row is not selected", async () => {
    h.rows.get("row-1").state = "done";
    expect((await pollBatchesOnce(deps())).rows).toBe(0);
  });
});

/** The provider fails the tick's own read but shows the batch ended at the last look (the only state a give-up may stand on). */
const endedAtLastLook = () => {
  h.retrieve.mockRejectedValueOnce(new Error("503"));
  h.retrieve.mockResolvedValue({ providerStatus: "ended", ended: true });
};

describe("final hardening: give-up cancel, deferral, age guard, outdated-consent cancel", () => {
  const wantCancel = (over: Record<string, unknown> = {}) => {
    putTask("cancel_requested");
    putRow({ state: "cancel_requested", ...over });
  };

  describe("consentOutdated still attempts a wanted cancel", () => {
    it("success: cancel sent, cancelRequestedAt stamped, nothing fetched or written", async () => {
      h.settings = OUTDATED;
      wantCancel();
      const d = deps();
      expect(await processBatchRow("row-1", d)).toBe("consentOutdated");
      expect(h.cancel).toHaveBeenCalledTimes(1);
      expect(h.rows.get("row-1").cancelRequestedAt).toEqual(expect.any(Date));
      for (const fn of [h.results, h.booking, h.convert, h.release]) expect(fn).not.toHaveBeenCalled();
      expect(d.runCollect).not.toHaveBeenCalled();
    });
    it("failure: stays unconfirmed, still consentOutdated", async () => {
      h.settings = OUTDATED;
      wantCancel();
      h.cancel.mockRejectedValue(new Error("503"));
      expect(await processBatchRow("row-1", deps())).toBe("consentOutdated");
      expect(h.rows.get("row-1").cancelRequestedAt).toBeUndefined();
    });
    it("keyMissing", async () => {
      h.settings = OUTDATED;
      wantCancel({ source: "own" });
      h.settle.mockResolvedValue({ ok: false, reason: "ai_key_missing" });
      expect(await processBatchRow("row-1", deps())).toBe("keyMissing");
    });
    it("configBlocked", async () => {
      h.settings = OUTDATED;
      wantCancel();
      h.settle.mockResolvedValue({ ok: false, reason: "managedDisabled" });
      expect(await processBatchRow("row-1", deps())).toBe("configBlocked");
    });
  });

  describe("give-up deferred while a wanted cancel is unconfirmed", () => {
    it("batch not ended (retrieve fails): deferred, row stays open, hold untouched", async () => {
      wantCancel({ failedTicks: MAX_FAILED_TICKS - 1 });
      h.cancel.mockRejectedValue(new Error("503"));
      h.retrieve.mockRejectedValue(new Error("503"));
      expect(await processBatchRow("row-1", deps())).toBe("failedTick");
      expect(h.rows.get("row-1").state).toBe("cancel_requested");
      expect(h.convert).not.toHaveBeenCalled();
      expect(h.release).not.toHaveBeenCalled();
    });
    it("batch shown ended at the last look: given up", async () => {
      wantCancel({ failedTicks: MAX_FAILED_TICKS - 1 });
      h.cancel.mockRejectedValue(new Error("503"));
      h.retrieve.mockRejectedValueOnce(new Error("503"));
      expect(await processBatchRow("row-1", deps())).toBe("unreachable");
      expect(h.rows.get("row-1").state).toBe("done");
    });
    it("no transport (lookup failure): deferred", async () => {
      wantCancel({ failedTicks: MAX_FAILED_TICKS - 1 });
      h.settle.mockResolvedValue({ ok: false, reason: "lookup_failed" });
      expect(await processBatchRow("row-1", deps())).toBe("failedTick");
      expect(h.rows.get("row-1").state).toBe("cancel_requested");
      expect(h.convert).not.toHaveBeenCalled();
    });
    it("a wanted cancel plus a batch that never shows ended: no give-up, however many ticks", async () => {
      wantCancel({ failedTicks: MAX_FAILED_TICKS + 5 });
      h.retrieve.mockRejectedValue(new Error("503"));
      h.cancel.mockRejectedValue(new Error("503"));
      expect(await processBatchRow("row-1", deps())).toBe("failedTick");
      expect(h.rows.get("row-1").failedTicks).toBe(MAX_FAILED_TICKS + 6);
      expect(h.convert).not.toHaveBeenCalled();
    });
  });

  describe("ordinary give-up (tick 12) only for a batch that is provably ended", () => {
    it("running or unreadable batch: not given up, no cancel, counting goes on", async () => {
      putRow({ failedTicks: MAX_FAILED_TICKS - 1 });
      h.retrieve.mockRejectedValue(new Error("503"));
      expect(await processBatchRow("row-1", deps())).toBe("failedTick");
      expect(h.cancel).not.toHaveBeenCalled();
      expect(h.rows.get("row-1").state).toBe("waiting");
      expect(h.convert).not.toHaveBeenCalled();
    });
    it("provably ended at the last look: settled and closed without a cancel", async () => {
      putRow({ failedTicks: MAX_FAILED_TICKS - 1 });
      endedAtLastLook();
      expect(await processBatchRow("row-1", deps())).toBe("unreachable");
      expect(h.cancel).not.toHaveBeenCalled();
      expect(h.rows.get("row-1").state).toBe("done");
      expect(h.convert).toHaveBeenCalledWith("row-1");
    });
    it("no cancel before the 12th tick", async () => {
      putRow({ failedTicks: 3 });
      h.retrieve.mockRejectedValue(new Error("503"));
      await processBatchRow("row-1", deps());
      expect(h.cancel).not.toHaveBeenCalled();
    });
  });

  describe("age guard", () => {
    const old = new Date(now.getTime() - 49 * 3600 * 1000);
    it("a row past 48 h is neither collected nor written nor polled", async () => {
      putRow({ createdAt: old });
      const d = deps();
      expect(await processBatchRow("row-1", d)).toBe("waiting");
      for (const fn of [h.retrieve, h.results, h.booking, h.cancel]) expect(fn).not.toHaveBeenCalled();
      expect(d.runCollect).not.toHaveBeenCalled();
    });
    it("a wanted cancel is still attempted", async () => {
      wantCancel({ createdAt: old });
      expect(await processBatchRow("row-1", deps())).toBe("waiting");
      expect(h.cancel).toHaveBeenCalledTimes(1);
      expect(h.rows.get("row-1").cancelRequestedAt).toEqual(expect.any(Date));
      expect(h.results).not.toHaveBeenCalled();
    });
    it("a young row is unaffected", async () => {
      putRow({ createdAt: new Date(now.getTime() - 3600 * 1000) });
      expect(await processBatchRow("row-1", deps())).toBe("collected");
    });
  });
});
