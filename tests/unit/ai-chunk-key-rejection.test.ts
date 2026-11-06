// @vitest-environment node
/**
 * When EVERY chunk of a chunked AI run fails, the run throws one of the chunk
 * errors — and a rejected AI key must win over whichever chunk happened to
 * fail first (the workers run concurrently). Callers abort their loops only on
 * `isProviderKeyRejection`, so a parse error thrown ahead of the key rejection
 * would send them into a per-locale fallback that fails for every locale.
 */
import { describe, it, expect, vi } from "vitest";
import { AIService, InvalidAIKeyError, isProviderKeyRejection } from "../../src/services/ai.service";

describe("chunked value translation: all chunks failed", () => {
  it("throws the key rejection, not the first error", async () => {
    const svc = new AIService("claude", { claudeApiKey: "k" });
    let call = 0;
    vi.spyOn(svc as any, "translateValuesToLocaleChunk").mockImplementation(async () => {
      call++;
      if (call === 1) throw new Error("AI batch translation did not return a JSON array");
      throw new InvalidAIKeyError("401 invalid api key");
    });
    // 41 values > VALUE_BATCH_MAX_ITEMS (40) ⇒ two value groups ⇒ two chunks.
    const values = Array.from({ length: 41 }, (_, i) => `v${i}`);
    const err = await svc.translateBatchValuesToLocales(values, "de", ["en", "fr"], "ctx").catch((e) => e);
    expect(call).toBeGreaterThanOrEqual(2);
    expect(isProviderKeyRejection(err)).toBe(true);
  });

  it("throws the first error when no chunk was a key rejection", async () => {
    const svc = new AIService("claude", { claudeApiKey: "k" });
    vi.spyOn(svc as any, "translateValuesToLocaleChunk").mockRejectedValue(new Error("401 Unauthorized from CDN"));
    const values = Array.from({ length: 41 }, (_, i) => `v${i}`);
    const err = await svc.translateBatchValuesToLocales(values, "de", ["en", "fr"], "ctx").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isProviderKeyRejection(err)).toBe(false);
  });
});
