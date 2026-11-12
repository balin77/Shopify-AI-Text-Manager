/**
 * The guiding rule for a batch's hold (PLAN_BULK_TRANSLATE_BATCHING 16, coordinator
 * decision): once a batch MAY exist at the provider, the hold is never simply
 * released -- booked from evidence (pro rata from the request counts), converted
 * to the reserved upper bound when nothing can be read, released only when the
 * provider's status PROVES nothing was processed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ convert: vi.fn(), release: vi.fn() }));
vi.mock("~/services/ai/usage-meter.server", () => ({
  convertReservation: (...a: unknown[]) => h.convert(...a),
  releaseBudget: (...a: unknown[]) => h.release(...a),
}));
vi.mock("~/utils/logger.server", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { boundForRequests, requestBoundsMicros, settleHold, type HoldRow } from "~/services/bulk-editor/translate-batch-hold.server";
import { serializeManifest } from "~/services/bulk-editor/translate-batch.shared";
import { priceCall } from "~/config/ai-pricing";

const request = (n: number, maxTokens: number) => ({ customId: `tx_p${n}`, kind: "short", items: [], maxTokens, inputEstimate: 1000 });
const manifest = serializeManifest({
  v: 1, rowType: "product", moType: "", locales: ["fr"], primaryLocale: "de", units: 1, cells: [],
  requests: [request(0, 1000), request(1, 4000), request(2, 2000)],
  plan: { skippedChanged: 0, failures: [], mismatchesByKey: {}, notStarted: 0 },
  submittedAt: "2026-11-10T00:00:00Z",
});
const row = (over: Partial<HoldRow> = {}): HoldRow => ({
  id: "row-1", provider: "claude", model: "claude-haiku-4-5", source: "managed", reservationState: "held",
  batchIds: ["msgbatch_1"], manifest, ...over,
});
const status = (succeeded: number, ended = true) => ({
  providerStatus: ended ? "ended" : "in_progress", ended,
  requestCounts: { total: 3, processing: ended ? 0 : 3 - succeeded, succeeded, errored: ended ? 3 - succeeded : 0, expired: 0, canceled: 0 },
});
const transport = (impl: () => Promise<unknown>) => ({ retrieve: vi.fn(impl) }) as never;
const bound = (maxTokens: number) => priceCall("claude", "claude-haiku-4-5", 1000, maxTokens, { tier: "batch" }).costMicros;

beforeEach(() => {
  h.convert.mockReset();
  h.release.mockReset();
  h.convert.mockResolvedValue({ applied: true, micros: 7 });
  h.release.mockResolvedValue({ applied: true, micros: 7 });
});

describe("per-request upper bounds", () => {
  it("are priced at the batch tier from the SENT max_tokens, largest first; the bound for n requests never undercounts (the dearest n)", () => {
    const bounds = requestBoundsMicros(row())!;
    expect(bounds).toEqual([bound(4000), bound(2000), bound(1000)]);
    expect(boundForRequests(bounds, 1)).toBe(bound(4000));
    expect(boundForRequests(bounds, 2)).toBe(bound(4000) + bound(2000));
    expect(boundForRequests(bounds, 99)).toBe(bounds.reduce((n, v) => n + v, 0));
    expect(boundForRequests(bounds, 0)).toBe(0);
  });
  it("an unreadable manifest has no bounds", () => {
    expect(requestBoundsMicros(row({ manifest: "nope" }))).toBeNull();
  });
});

describe("settleHold", () => {
  it("an own-key row or a hold that is not held: nothing to do, nothing touched", async () => {
    expect(await settleHold(row({ source: "byo" }), null, { final: true })).toEqual({ kind: "none" });
    expect(await settleHold(row({ reservationState: "converted" }), null, { final: true })).toEqual({ kind: "none" });
    expect(h.convert).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
  });

  it("RELEASES only when the batch ended and nothing succeeded", async () => {
    const out = await settleHold(row(), transport(async () => status(0)), { final: false });
    expect(out).toEqual({ kind: "released" });
    expect(h.release).toHaveBeenCalledWith("row-1");
    expect(h.convert).not.toHaveBeenCalled();
  });

  it("books PRO RATA from the counts: succeeded x the dearest bounds, capped by the conversion at the hold", async () => {
    const out = await settleHold(row(), transport(async () => status(2)), { final: false });
    expect(out.kind).toBe("booked");
    expect(h.convert).toHaveBeenCalledWith("row-1", { bookMicros: bound(4000) + bound(2000) });
    expect(h.release).not.toHaveBeenCalled();
  });

  it("a batch still running proves nothing: pending, or the upper bound at the last look", async () => {
    const running = transport(async () => status(0, false));
    expect(await settleHold(row(), running, { final: false })).toEqual({ kind: "pending", reason: "notEnded" });
    expect(h.convert).not.toHaveBeenCalled();
    expect(await settleHold(row(), running, { final: true })).toMatchObject({ kind: "converted", reason: "notEnded" });
    expect(h.convert).toHaveBeenCalledWith("row-1");
    expect(h.release).not.toHaveBeenCalled();
  });

  it("unreadable (provider down) or no access (kill switch): pending, or the upper bound at the last look -- never a release", async () => {
    const down = transport(async () => {
      throw new Error("503");
    });
    expect(await settleHold(row(), down, { final: false })).toEqual({ kind: "pending", reason: "unreadable" });
    expect(await settleHold(row(), down, { final: true })).toMatchObject({ kind: "converted", reason: "unreadable" });
    expect(await settleHold(row(), null, { final: true })).toMatchObject({ kind: "converted", reason: "noAccess" });
    expect(h.release).not.toHaveBeenCalled();
  });

  it("an ended batch whose counts are missing is not proof either", async () => {
    const noCounts = transport(async () => ({ providerStatus: "ended", ended: true }));
    expect(await settleHold(row(), noCounts, { final: false })).toEqual({ kind: "pending", reason: "noCounts" });
    expect(await settleHold(row(), noCounts, { final: true })).toMatchObject({ kind: "converted", reason: "noCounts" });
  });

  it("a row with no batch id: the upper bound at the last look (its create may have been sent), pending before that", async () => {
    expect(await settleHold(row({ batchIds: [] }), null, { final: false })).toEqual({ kind: "pending", reason: "noBatchId" });
    expect(await settleHold(row({ batchIds: [] }), null, { final: true })).toMatchObject({ kind: "converted", reason: "noBatchId" });
    expect(h.release).not.toHaveBeenCalled();
  });

  it("succeeded requests but no readable manifest: the upper bound", async () => {
    expect(await settleHold(row({ manifest: "x" }), transport(async () => status(1)), { final: false })).toMatchObject({ kind: "converted", reason: "noManifest" });
  });

  it("a failed settlement is pending (the row stays open), not 'done'", async () => {
    h.release.mockResolvedValue({ applied: false, reason: "failed" });
    expect(await settleHold(row(), transport(async () => status(0)), { final: true })).toEqual({ kind: "pending", reason: "settleFailed" });
  });

  it("several batches: everything must have ended, the succeeded counts are summed", async () => {
    let n = 0;
    const t = transport(async () => (n++ === 0 ? status(1) : status(1, false)));
    expect(await settleHold(row({ batchIds: ["a", "b"] }), t, { final: false })).toEqual({ kind: "pending", reason: "notEnded" });
  });
});
