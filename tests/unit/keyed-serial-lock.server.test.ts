import { describe, it, expect, vi, afterEach } from "vitest";
import { withSerialLock, __lockKeysForTests } from "~/utils/keyed-serial-lock.server";

afterEach(() => vi.useRealTimers());

describe("withSerialLock", () => {
  it("runs the holders of one key one at a time, in call order", async () => {
    const order: string[] = [];
    const gate: Array<() => void> = [];
    const hold = (name: string) =>
      withSerialLock("k", async () => {
        order.push(`${name}:start`);
        await new Promise<void>((r) => gate.push(r));
        order.push(`${name}:end`);
        return name;
      });
    const a = hold("A");
    const b = hold("B");
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["A:start"]); // B waits
    gate[0]();
    expect(await a).toBe("A");
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["A:start", "A:end", "B:start"]);
    gate[1]();
    expect(await b).toBe("B");
    expect(__lockKeysForTests()).toEqual([]); // nothing leaks
  });

  it("different keys do not wait for each other", async () => {
    let releaseA!: () => void;
    const a = withSerialLock("a", () => new Promise<void>((r) => (releaseA = r)));
    const b = await withSerialLock("b", async () => "b done");
    expect(b).toBe("b done");
    await Promise.resolve();
    releaseA();
    await a;
  });

  it("a holder that throws still releases the next one", async () => {
    const a = withSerialLock("k", async () => {
      throw new Error("boom");
    });
    const b = withSerialLock("k", async () => "ok");
    await expect(a).rejects.toThrow("boom");
    expect(await b).toBe("ok");
  });

  it("the wait is BOUNDED: a hung holder does not block the next one for good", async () => {
    vi.useFakeTimers();
    void withSerialLock("k", () => new Promise<void>(() => {})); // never finishes
    const second = withSerialLock("k", async () => "went ahead", { maxWaitMs: 1000 });
    await vi.advanceTimersByTimeAsync(1001);
    expect(await second).toBe("went ahead");
  });
});
