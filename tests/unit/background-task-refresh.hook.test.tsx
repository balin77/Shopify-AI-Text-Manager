/**
 * The WATCH itself, rendered — not the pure classifier beside it.
 *
 * `background-task-refresh.test.ts` covers `classifyWatchedTasks`, which is a
 * pure function and was never where the defects were: five of
 * the commits that shipped this hook were bugs in the part the pure test cannot
 * reach — the deadline surviving an effect restart, the poll actually stopping,
 * the chunking, the hand-off to a task named by a finished one. So each test
 * here pins one of those, through a real render.
 *
 * The rule none of them may break: THIS HOOK ONLY READS. It is handed a
 * callback that refreshes a display; there is no autosave in this app, and a
 * test that let one in would be the last thing to notice.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  useBackgroundTaskRefresh,
  MAX_TASK_STATUS_IDS,
} from "~/hooks/useBackgroundTaskRefresh";

const POLL_MS = 5_000;
/** `MAX_SILENT_WATCH_MS` in the shared module. */
const SILENCE_MS = 5 * 60_000;

/** One queued answer per `/api/task-status` call, in order; the last one repeats. */
let answers: Array<Record<string, unknown>> = [];
let calls: string[] = [];

function mockFetch() {
  return vi.fn(async (url: string) => {
    calls.push(String(url));
    const body = answers.length > 1 ? answers.shift()! : (answers[0] ?? { statuses: {} });
    return { ok: true, json: async () => body } as unknown as Response;
  });
}

/** Let the poll fire once and its promise chain settle. */
async function poll(times = 1) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      vi.advanceTimersByTime(POLL_MS);
      // The tick awaits fetch and json() — two microtask turns before it
      // classifies, so advancing the clock alone would assert on nothing.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  answers = [{ statuses: {} }];
  calls = [];
  global.fetch = mockFetch() as unknown as typeof fetch;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useBackgroundTaskRefresh (rendered)", () => {
  it("reports a settled id ONCE, even while the poll keeps running for another", async () => {
    // The shape that matters: a caller that does NOT drop the finished id,
    // while a second id keeps the poll alive. Reporting `a` on every one of
    // those polls is a revalidation loop — the grid reloading every five
    // seconds for a task that ended minutes ago.
    answers = [{ statuses: { a: "completed", b: "running" } }];
    const onUpdate = vi.fn();
    renderHook(() => useBackgroundTaskRefresh(["a", "b"], onUpdate));

    await poll(4);

    expect(calls.length).toBe(4); // `b` keeps it asking…
    expect(onUpdate).toHaveBeenCalledTimes(1); // …and `a` is told once.
    expect(onUpdate.mock.calls[0][0]).toEqual({ settled: ["a"], follow: [] });
  });

  it("stops polling once everything it watches is finished", async () => {
    answers = [{ statuses: { a: "completed" } }];
    const onUpdate = vi.fn();
    renderHook(() => useBackgroundTaskRefresh(["a"], onUpdate));

    await poll();
    const after = calls.length;
    await poll(3);

    // Nothing left to ask about: the timer was not re-armed.
    expect(calls.length).toBe(after);
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("settles NOTHING on a poll the server refused", async () => {
    global.fetch = vi.fn(async (url: string) => {
      calls.push(String(url));
      return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const onUpdate = vi.fn();
    renderHook(() => useBackgroundTaskRefresh(["a"], onUpdate));

    await poll(2);

    // A 500 says nothing about the task. Reading it as finished would refresh
    // the grid before a single translation is written.
    expect(onUpdate).not.toHaveBeenCalled();
    expect(calls.length).toBe(2);
  });

  it("keeps a per-id DEADLINE across an effect restart", async () => {
    // The watched set grows with every save, which restarts the effect. A
    // deadline belonging to the WATCH was restarted by each of them, so an id
    // that had been silent for minutes started over and was never given up on.
    answers = [{ statuses: {} }];
    const onUpdate = vi.fn();
    const { rerender } = renderHook(
      ({ ids }: { ids: string[] }) => useBackgroundTaskRefresh(ids, onUpdate),
      { initialProps: { ids: ["a"] } },
    );

    await poll();
    // Most of the silence bound passes, then a second save adds an id.
    await act(async () => {
      vi.advanceTimersByTime(SILENCE_MS - POLL_MS * 2);
    });
    rerender({ ids: ["a", "b"] });
    await poll(2);

    // `a` ran out ITS clock and is reported; `b` is young and is not.
    const settled = onUpdate.mock.calls.flatMap((call) => (call[0] as { settled: string[] }).settled);
    expect(settled).toContain("a");
    expect(settled).not.toContain("b");
  });

  it("does NOT give up on a silent id while another run of the shop is alive", async () => {
    // The queue is shared with the sync-side reconciliation: our run can be
    // chained behind a webhook's and have no row at all. `othersAlive` is the
    // only evidence of that, and without it the watch ends before the run
    // starts — the empty cell this hook exists to remove.
    answers = [{ statuses: { a: "missing" }, othersAlive: true }];
    const onUpdate = vi.fn();
    renderHook(() => useBackgroundTaskRefresh(["a"], onUpdate));

    await poll();
    await act(async () => {
      vi.advanceTimersByTime(SILENCE_MS);
    });
    await poll(2);

    expect(onUpdate).not.toHaveBeenCalled();

    // …and once nothing else is running, the deadline does what it is for.
    answers = [{ statuses: { a: "missing" } }];
    await act(async () => {
      vi.advanceTimersByTime(SILENCE_MS);
    });
    await poll(2);
    expect(onUpdate).toHaveBeenCalledWith({ settled: ["a"], follow: [] });
  });

  it("CHUNKS the poll at the loader's own cap", async () => {
    const ids = Array.from({ length: MAX_TASK_STATUS_IDS + 3 }, (_, i) => `id-${i}`);
    renderHook(() => useBackgroundTaskRefresh(ids, vi.fn()));

    await poll();

    // Two calls, and no id is left out: a surplus id would come back with no
    // status and read as "still working" until its deadline.
    expect(calls.length).toBe(2);
    const asked = calls.flatMap((url) => decodeURIComponent(url.split("ids=")[1]).split(","));
    expect(new Set(asked).size).toBe(ids.length);
  });

  it("hands over the ids a finished task NAMES, and reports them separately", async () => {
    // A large bulk save runs inside a task of its own; the repairs it starts
    // are further rows that only that task's result names.
    answers = [
      { statuses: { parent: "completed" }, follow: ["child"] },
      { statuses: { child: "running" } },
    ];
    const onUpdate = vi.fn();
    const { rerender } = renderHook(
      ({ ids }: { ids: string[] }) => useBackgroundTaskRefresh(ids, onUpdate),
      { initialProps: { ids: ["parent"] } },
    );

    await poll();
    expect(onUpdate).toHaveBeenCalledWith({ settled: ["parent"], follow: ["child"] });

    // The caller drops the parent and picks up the child — the real wiring.
    rerender({ ids: ["child"] });
    answers = [{ statuses: { child: "completed" } }];
    await poll();
    expect(onUpdate).toHaveBeenLastCalledWith({ settled: ["child"], follow: [] });
  });

  it("stops asking the moment it unmounts", async () => {
    answers = [{ statuses: { a: "running" } }];
    const { unmount } = renderHook(() => useBackgroundTaskRefresh(["a"], vi.fn()));

    await poll();
    const after = calls.length;
    unmount();
    await poll(3);

    expect(calls.length).toBe(after);
  });

  it("never polls for an empty watch", async () => {
    renderHook(() => useBackgroundTaskRefresh([], vi.fn()));
    await poll(3);
    expect(calls).toEqual([]);
  });
});
