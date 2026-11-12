/**
 * The retry ladder of one package (PLAN_BULK_TRANSLATE_BATCHING 3.1):
 * package -> halves (two levels) -> one entry on the single path -> failed.
 */
import { describe, it, expect } from "vitest";
import { runPackageLadder, type LadderDeps, type PackageCallResult } from "~/services/bulk-editor/translate-package-run.shared";
import {
  buildPackageItems,
  packageBudgetFor,
  planPackages,
  type PackageEntry,
  type TranslatePackage,
} from "~/services/bulk-editor/translate-packages.shared";

const mk = (n: number): TranslatePackage => {
  const entries: PackageEntry[] = Array.from({ length: n }, (_, i) => ({
    owner: `o${i}`,
    kind: "short",
    fieldKey: "title",
    source: `Text${String.fromCharCode(97 + i)}`,
    locales: ["fr", "es"],
  }));
  return planPackages(buildPackageItems(entries), packageBudgetFor({ modelMaxOutput: 32_000, bucketTpm: null })).packages[0];
};

/** A scripted model: answers every package item "<source>-<locale>" unless told to misbehave. */
function model(opts: { badSources?: Set<string>; truncateAbove?: number; singleFails?: Set<string> } = {}) {
  const calls: { size: number }[] = [];
  const singles: string[] = [];
  const deps: LadderDeps = {
    shouldStop: () => false,
    callPackage: async (pkg): Promise<PackageCallResult> => {
      calls.push({ size: pkg.items.length });
      if (opts.truncateAbove !== undefined && pkg.items.length > opts.truncateAbove) {
        return { answer: null, invalid: "truncated" };
      }
      const idOf = new Map(pkg.items.map((item, i) => [item.key, `k${i + 1}`]));
      const parsed: Record<string, Record<string, string>> = {};
      pkg.items.forEach((item, i) => {
        if (opts.badSources?.has(item.source)) return; // the model drops this id
        parsed[`k${i + 1}`] = Object.fromEntries(item.locales.map((l) => [l, `${item.source}-${l}`]));
      });
      return { answer: { parsed, idOf } };
    },
    callSingle: async (item) => {
      singles.push(item.source);
      if (opts.singleFails?.has(item.source)) return null;
      return Object.fromEntries(item.locales.map((l) => [l, `${item.source}-${l}`]));
    },
  };
  return { deps, calls, singles };
}

describe("runPackageLadder", () => {
  it("a clean answer is one request, no retries", async () => {
    const m = model();
    const { outcomes, stats } = await runPackageLadder(mk(4), m.deps);
    expect(stats).toEqual({ requests: 1, retries: 0 });
    expect([...outcomes.values()].every((o) => Object.keys(o.accepted).length === 2)).toBe(true);
  });

  it("a truncated package is retried as halves, then quarters; the leftovers are all delivered", async () => {
    const m = model({ truncateAbove: 2 });
    const { outcomes, stats } = await runPackageLadder(mk(8), m.deps);
    // 1 (8) + 2 (4,4) + 4 (2 each)
    expect(m.calls.map((c) => c.size)).toEqual([8, 4, 2, 2, 4, 2, 2]);
    expect(stats.requests).toBe(7);
    expect(stats.retries).toBe(6);
    expect(outcomes.size).toBe(8);
    for (const o of outcomes.values()) expect(Object.keys(o.accepted).sort()).toEqual(["es", "fr"]);
    expect(m.singles).toEqual([]);
  });

  it("an entry the model keeps dropping goes down to the single path, the rest is not repeated", async () => {
    const m = model({ badSources: new Set(["Textb"]) });
    const { outcomes } = await runPackageLadder(mk(4), m.deps);
    expect(m.singles).toEqual(["Textb"]);
    expect([...outcomes.values()].every((o) => Object.keys(o.accepted).length === 2)).toBe(true);
  });

  it("an entry the single path cannot deliver is FAILED per language -- never the source", async () => {
    const m = model({ badSources: new Set(["Textb"]), singleFails: new Set(["Textb"]) });
    const { outcomes } = await runPackageLadder(mk(3), m.deps);
    const failed = [...outcomes.values()].find((o) => o.item.source === "Textb")!;
    expect(failed.accepted).toEqual({});
    expect(failed.failed).toEqual({ fr: "unavailable", es: "unavailable" });
    for (const o of outcomes.values()) {
      for (const text of Object.values(o.accepted)) expect(text).not.toBe(o.item.source);
    }
  });

  it("a single-entry package that fails goes straight to the single path", async () => {
    const m = model({ badSources: new Set(["Texta"]) });
    await runPackageLadder(mk(1), m.deps);
    expect(m.calls).toHaveLength(1);
    expect(m.singles).toEqual(["Texta"]);
  });

  it("a partially rejected entry is retried for the MISSING language only", async () => {
    const seenLocales: string[][] = [];
    const deps: LadderDeps = {
      shouldStop: () => false,
      callPackage: async (pkg) => {
        seenLocales.push(pkg.items.map((i) => i.locales.join("+")));
        const idOf = new Map(pkg.items.map((item, i) => [item.key, `k${i + 1}`]));
        // First round: French only. Retry rounds: complete.
        const first = seenLocales.length === 1;
        const parsed: Record<string, Record<string, string>> = {};
        pkg.items.forEach((item, i) => {
          parsed[`k${i + 1}`] = Object.fromEntries(item.locales.filter((l) => !first || l === "fr").map((l) => [l, `${item.source}-${l}`]));
        });
        return { answer: { parsed, idOf } };
      },
      callSingle: async () => null,
    };
    const { outcomes } = await runPackageLadder(mk(2), deps);
    expect(seenLocales[0]).toEqual(["es+fr", "es+fr"]);
    expect(seenLocales[1]).toEqual(["es"]);
    expect([...outcomes.values()].every((o) => Object.keys(o.accepted).length === 2)).toBe(true);
  });

  it("a fatal error thrown by the call propagates (the caller stands down); nothing is invented", async () => {
    const deps: LadderDeps = {
      shouldStop: () => false,
      callPackage: async () => {
        throw new Error("managed_ai_refused:budget");
      },
      callSingle: async () => null,
    };
    await expect(runPackageLadder(mk(3), deps)).rejects.toThrow("managed_ai_refused");
  });

  it("stops spending once shouldStop says so; verified results of the answer in hand are kept", async () => {
    let stop = false;
    const m = model({ truncateAbove: 1 });
    const deps: LadderDeps = {
      ...m.deps,
      shouldStop: () => stop,
      callPackage: async (pkg) => {
        const r = await m.deps.callPackage(pkg);
        stop = true; // cancelled during the first request
        return r;
      },
    };
    const { outcomes, stats } = await runPackageLadder(mk(4), deps);
    expect(stats.requests).toBe(1);
    expect(outcomes.size).toBe(0); // the answer was invalid, and no retry was made
  });
});
