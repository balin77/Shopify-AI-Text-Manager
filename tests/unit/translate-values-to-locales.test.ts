import { describe, it, expect, vi } from "vitest";
import { AIService } from "../../src/services/ai.service";

/**
 * `translateBatchValuesToLocales` — the value-shaped half of the batching.
 *
 * It exists because a metafield, an option value, a metaobject field and a
 * storefront string were the last paths translating ONE LANGUAGE PER REQUEST:
 * `translateBatchValues` takes a single `toLang`, so a product with sixty
 * metafields on an eight-language shop paid eight requests where the same edit
 * to its title paid one.
 */
function makeService(answer: (prompt: string) => unknown) {
  // Built off the PROTOTYPE rather than through the constructor: the real one
  // instantiates the provider SDK, and the Anthropic client refuses to start in
  // a jsdom test environment. Nothing under test needs a provider — `askAI` is
  // the single seam every prompt goes through, so replacing it exercises the
  // prompt construction, the chunk planning and the index mapping for real.
  const service = Object.create(AIService.prototype) as AIService;
  const ask = vi.fn(async (prompt: string) => JSON.stringify(answer(prompt)));
  (service as unknown as { askAI: typeof ask }).askAI = ask;
  return { service, ask };
}

/** The shape the prompt asks for: {locale: [v1, v2, …]}. */
const echoShape = (values: string[], locales: string[]) =>
  Object.fromEntries(locales.map((l) => [l, values.map((v) => `[${l}] ${v}`)]));

describe("AIService.translateBatchValuesToLocales", () => {
  it("answers every language in ONE request when they fit", async () => {
    const values = ["Blau", "Rot", "Grün"];
    const locales = ["en", "es", "fr", "it"];
    const { service, ask } = makeService(() => echoShape(values, locales));

    const result = await service.translateBatchValuesToLocales(values, "de", locales, "swatches");

    expect(ask).toHaveBeenCalledTimes(1);
    expect(result.it).toEqual(["[it] Blau", "[it] Rot", "[it] Grün"]);
  });

  it("keeps two identical values apart instead of merging them", async () => {
    // Mapped back by INDEX, never by value: two option values may legitimately
    // hold the same text, and a value-keyed map would collapse them into one
    // write.
    const values = ["Blau", "Blau"];
    const { service } = makeService(() => ({ en: ["Blue", "Navy"], es: ["Azul", "Marino"] }));

    const result = await service.translateBatchValuesToLocales(values, "de", ["en", "es"], "options");

    expect(result.en).toEqual(["Blue", "Navy"]);
    expect(result.es).toEqual(["Azul", "Marino"]);
  });

  it("refuses an answer whose length drifted, rather than shifting the mapping", async () => {
    // A short answer re-points every later value at the wrong resource — silent
    // corruption, not a missing translation.
    const { service } = makeService(() => ({ en: ["only one"], es: ["a", "b"] }));

    await expect(
      service.translateBatchValuesToLocales(["a", "b"], "de", ["en", "es"], "options"),
    ).rejects.toThrow(/expected 2/);
  });

  it("splits across requests when the languages multiply past the budget", async () => {
    const long = "Ein ziemlich langer Metafeld-Wert. ".repeat(300); // ~10k chars
    const locales = ["en", "es", "fr", "it", "nl", "pt"];
    const { service, ask } = makeService((prompt) => {
      // Answer exactly the locales this chunk asked for.
      const asked = locales.filter((l) => prompt.includes(`(${l})`));
      return echoShape([long], asked);
    });

    const result = await service.translateBatchValuesToLocales([long], "de", locales, "metafields");

    expect(ask.mock.calls.length).toBeGreaterThan(1);
    for (const locale of locales) expect(result[locale][0]).toBe(`[${locale}] ${long}`);
  });

  it("leaves a failed chunk's own entries EMPTY without shifting the rest", async () => {
    // Every caller reads "" as not-translated and falls back to its own answer.
    // Compacting instead would re-point the surviving values at wrong resources.
    // Each value is long enough to force its own chunk and STARTS with its own
    // marker, so the mock can answer exactly the slice it was handed.
    const values = Array.from({ length: 4 }, (_, i) => `M${i}: ` + "Wert ".repeat(2000));
    const locales = ["en", "es"];
    let call = 0;
    const { service } = makeService((prompt) => {
      call++;
      if (call === 1) return { nonsense: true };
      const asked = locales.filter((l) => prompt.includes(`(${l})`));
      const mine = values.filter((v) => prompt.includes(v.slice(0, 4)));
      return echoShape(mine, asked);
    });

    const result = await service.translateBatchValuesToLocales(values, "de", locales, "metafields");

    for (const locale of locales) expect(result[locale]).toHaveLength(values.length);
    const all = locales.flatMap((l) => result[l]);
    expect(all.some((v) => v === "")).toBe(true);
    expect(all.some((v) => v !== "")).toBe(true);
  });

  it("carries the merchant instructions into the prompt", async () => {
    const { service, ask } = makeService(() => echoShape(["Blau"], ["en", "es"]));

    await service.translateBatchValuesToLocales(["Blau"], "de", ["en", "es"], "options", {
      instructions: "Keep brand names in English.",
    });

    expect(ask.mock.calls[0][0]).toContain("Keep brand names in English.");
  });

  it("delegates a single language to the older method, prompt and all", async () => {
    // Several callers still depend on that prompt's exact behaviour; delegating
    // rather than re-deriving keeps the two from drifting.
    const { service, ask } = makeService(() => ["Blue"]);

    const result = await service.translateBatchValuesToLocales(["Blau"], "de", ["en"], "options");

    expect(result).toEqual({ en: ["Blue"] });
    expect(ask.mock.calls[0][0]).toContain("Respond in JSON format:");
  });
});
