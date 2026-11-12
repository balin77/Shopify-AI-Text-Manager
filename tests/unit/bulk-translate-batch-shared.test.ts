/**
 * The pure half of the Batch-API mode (translate-batch.shared.ts) and the poll
 * service shell: provider-id rules, content hashes, the manifest round trip
 * (which must never hold source text), the retry budget, and the service's
 * switch and re-entrancy guard.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  BATCH_CUSTOM_ID_PATTERN,
  batchCustomId,
  batchIdPrefix,
  hash64,
  itemSignature,
  parseManifest,
  retryBudgetFor,
  serializeManifest,
  sourceHash,
  type BatchManifest,
} from "~/services/bulk-editor/translate-batch.shared";

describe("custom ids", () => {
  it("carry the task id and satisfy the provider's documented rule (1-64 characters of [A-Za-z0-9_-])", () => {
    const prefix = batchIdPrefix("cm3abcdefghijklmnopqrstuv");
    const id = batchCustomId(prefix, 12345);
    expect(id).toBe("tcm3abcdefghijklmnopqrstuv_p12345");
    expect(id).toMatch(BATCH_CUSTOM_ID_PATTERN);
    expect(id.length).toBeLessThanOrEqual(64);
  });

  it("characters outside the pattern never reach the provider (stripped from the prefix)", () => {
    expect(batchIdPrefix("a b/c:d")).toBe("tabcd_p");
  });

  it("an id that would break the provider's rule is refused locally, not sent", () => {
    expect(() => batchCustomId("t" + "x".repeat(70) + "_p", 1)).toThrow(/out of the provider's range/);
  });
});

describe("hashes and signatures", () => {
  it("hash64 is deterministic, 16 hex characters and sensitive to every character", () => {
    expect(hash64("Schal")).toBe(hash64("Schal"));
    expect(hash64("Schal")).toMatch(/^[0-9a-f]{16}$/);
    expect(hash64("Schal")).not.toBe(hash64("Schaal"));
    expect(hash64("")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("an item signature is (kind, text): not the languages, not the instructions", () => {
    expect(itemSignature({ kind: "short", source: "Schal" })).toBe(itemSignature({ kind: "short", source: "Schal" }));
    expect(itemSignature({ kind: "short", source: "Schal" })).not.toBe(itemSignature({ kind: "long", source: "Schal" }));
    expect(itemSignature({ kind: "short", source: "Schal" })).not.toBe(itemSignature({ kind: "short", source: "Schal " }));
  });

  it("the source hash ignores line endings and surrounding whitespace (representation, not content)", () => {
    expect(sourceHash("a\r\nb ")).toBe(sourceHash("a\nb"));
    expect(sourceHash("a\nb")).not.toBe(sourceHash("a\nc"));
  });
});

describe("the manifest", () => {
  const manifest: BatchManifest = {
    v: 1,
    rowType: "product",
    moType: "",
    locales: ["fr"],
    primaryLocale: "de",
    units: 1,
    cells: [{ r: "gid://shopify/Product/1", c: "field.title", l: ["fr"], h: sourceHash("Schal"), e: { "gid://shopify/Product/1": "digest" } }],
    requests: [{ customId: "ttask_p0", kind: "short", items: [itemSignature({ kind: "short", source: "Schal" })], maxTokens: 500, inputEstimate: 100 }],
    plan: { skippedChanged: 0, failures: [], mismatchesByKey: {}, notStarted: 0 },
    submittedAt: "2026-11-12T00:00:00Z",
  };

  it("round-trips and holds NO source text", () => {
    const text = serializeManifest(manifest);
    expect(text).not.toContain("Schal");
    expect(parseManifest(text)).toEqual(manifest);
  });

  it("anything that is not a v1 manifest is null -- an unreadable run is never guessed", () => {
    for (const bad of [null, undefined, "", "not json", "{}", '{"v":2,"cells":[],"requests":[]}', '{"v":1,"cells":"x","requests":[]}']) {
      expect(parseManifest(bad as never)).toBeNull();
    }
  });
});

describe("the live-retry budget", () => {
  it("min(20, 10 % of the requests), never below one", () => {
    expect([1, 5, 10, 11, 100, 200, 5000].map(retryBudgetFor)).toEqual([1, 1, 1, 2, 10, 20, 20]);
  });
});

describe("BulkTranslateBatchPollService", () => {
  const pollOnce = vi.hoisted(() => vi.fn());
  vi.mock("~/services/bulk-editor/translate-batch-poll.server", () => ({ pollBatchesOnce: (...a: unknown[]) => pollOnce(...a) }));
  vi.mock("~/db.server", () => ({ db: {} }));
  vi.mock("~/utils/logger.server", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

  beforeEach(() => {
    pollOnce.mockReset();
    vi.resetModules();
  });
  afterEach(() => {
    delete process.env.BULK_TRANSLATE_BATCH_POLL_DISABLED;
  });

  it("a tick that is still running (a collect writes for minutes) is not started twice", async () => {
    let finish!: () => void;
    pollOnce.mockImplementation(() => new Promise((resolve) => { finish = () => resolve({ rows: 0, expired: 0, outcomes: {} }); }));
    const { BulkTranslateBatchPollService } = await import("~/services/bulk-editor/bulk-translate-batch-poll.service");
    const service = BulkTranslateBatchPollService.getInstance();
    const first = service.tick();
    await vi.waitFor(() => expect(pollOnce).toHaveBeenCalledTimes(1));
    expect(await service.tick()).toBeNull();
    expect(pollOnce).toHaveBeenCalledTimes(1);
    finish();
    await first;
    // and the guard is released afterwards
    pollOnce.mockResolvedValue({ rows: 0, expired: 0, outcomes: {} });
    expect(await service.tick()).not.toBeNull();
  });

  it("BULK_TRANSLATE_BATCH_POLL_DISABLED=true: start() does not tick", async () => {
    process.env.BULK_TRANSLATE_BATCH_POLL_DISABLED = "true";
    const { BulkTranslateBatchPollService } = await import("~/services/bulk-editor/bulk-translate-batch-poll.service");
    BulkTranslateBatchPollService.getInstance().start();
    expect(pollOnce).not.toHaveBeenCalled();
  });

  it("start() is idempotent and ticks once immediately; stop() ends it", async () => {
    pollOnce.mockResolvedValue({ rows: 0, expired: 0, outcomes: {} });
    const { BulkTranslateBatchPollService } = await import("~/services/bulk-editor/bulk-translate-batch-poll.service");
    const service = BulkTranslateBatchPollService.getInstance();
    service.start();
    service.start();
    await vi.waitFor(() => expect(pollOnce).toHaveBeenCalledTimes(1));
    service.stop();
  });

  it("is started at boot next to the other background sweeps", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "..", "..", "app/shopify.server.ts"), "utf8");
    expect(src).toMatch(/BulkTranslateBatchPollService\.getInstance\(\)\.start\(\)/);
  });
});
