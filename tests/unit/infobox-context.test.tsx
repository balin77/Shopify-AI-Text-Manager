/**
 * The message bell's state machine.
 *
 * The rule the whole context turns on: the HISTORY is the record, the TOAST is
 * the glance. Every test here pins one half of a defect where those two were
 * conflated — a message that was never shown was also never recorded, and the
 * merchant read the silence as success.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { InfoBoxProvider, useInfoBox } from "~/contexts/InfoBoxContext";

const wrapper = ({ children }: { children: ReactNode }) => (
  <InfoBoxProvider>{children}</InfoBoxProvider>
);

const setup = () => renderHook(() => useInfoBox(), { wrapper });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("InfoBoxContext — the history always records", () => {
  it("keeps a repeat of a dismissed message in the history", () => {
    const { result } = setup();

    act(() => result.current.showInfoBox("Save failed", "critical"));
    act(() => result.current.hideInfoBox());
    // The same failure happens again while the dismissal is still in force.
    act(() => result.current.showInfoBox("Save failed", "critical"));

    // The toast may be suppressed; the RECORD may not be. The old code
    // returned before writing history, so the second failure vanished
    // entirely — no row, no badge — and read as success.
    expect(result.current.messageHistory).toHaveLength(2);
    expect(result.current.unreadCount).toBe(2);
  });

  it("suppresses only the toast of a just-dismissed message", () => {
    const { result } = setup();

    act(() => result.current.showInfoBox("Save failed", "critical"));
    act(() => result.current.hideInfoBox());
    act(() => result.current.showInfoBox("Save failed", "critical"));

    // `hideInfoBox` used to add the key and then immediately clear the whole
    // set from `processQueue`, so the documented 30s suppression never
    // survived its own turn.
    expect(result.current.infoBox).toBeNull();
  });

  it("releases the suppression after its timeout", () => {
    const { result } = setup();

    act(() => result.current.showInfoBox("Save failed", "critical"));
    act(() => result.current.hideInfoBox());
    act(() => void vi.advanceTimersByTime(30_001));
    act(() => result.current.showInfoBox("Save failed", "critical"));

    expect(result.current.infoBox?.message).toBe("Save failed");
  });
});

describe("InfoBoxContext — a dedupeKey names a condition, not an event", () => {
  it("collapses repeats of the same condition into one row", () => {
    const { result } = setup();

    // `app.tsx` re-runs its API-key effect on every loader revalidation, i.e.
    // after every action anywhere in the app.
    for (let i = 0; i < 5; i++) {
      act(() => result.current.showInfoBox("No API key", "warning", undefined, "missing-api-key:any"));
    }

    expect(result.current.messageHistory).toHaveLength(1);
    expect(result.current.unreadCount).toBe(1);
  });

  it("does not raise a second toast for a repeat", () => {
    const { result } = setup();

    act(() => result.current.showInfoBox("No API key", "warning", undefined, "missing-api-key:any"));
    act(() => result.current.hideInfoBox());
    act(() => result.current.showInfoBox("No API key", "warning", undefined, "missing-api-key:any"));

    expect(result.current.infoBox).toBeNull();
  });

  it("does not light the badge again once the repeat has been read", () => {
    const { result } = setup();

    act(() => result.current.showInfoBox("No API key", "warning", undefined, "missing-api-key:any"));
    act(() => result.current.markAllRead());
    expect(result.current.unreadCount).toBe(0);

    // Rebuilding the row as unread on every repeat meant a shop with no API
    // key could never clear its bell: the badge returned to 1 after every
    // loader revalidation, i.e. after every action anywhere in the app.
    act(() => result.current.showInfoBox("No API key", "warning", undefined, "missing-api-key:any"));

    expect(result.current.unreadCount).toBe(0);
  });

  it("leaves the state untouched for an identical repeat", () => {
    const { result } = setup();

    act(() => result.current.showInfoBox("No API key", "warning", undefined, "missing-api-key:any"));
    const rows = result.current.messageHistory;

    act(() => result.current.showInfoBox("No API key", "warning", undefined, "missing-api-key:any"));

    // Same array identity ⇒ same context value ⇒ no re-render of the tree
    // below the provider.
    expect(result.current.messageHistory).toBe(rows);
  });

  it("refreshes a reworded condition in place rather than adding a row", () => {
    const { result } = setup();

    act(() => result.current.showInfoBox("No Claude key", "warning", undefined, "missing-api-key:preferred"));
    act(() => result.current.markAllRead());
    const [before] = result.current.messageHistory;

    act(() => result.current.showInfoBox("No OpenAI key", "warning", undefined, "missing-api-key:preferred"));

    // One condition, one row, same position — but a new id, because an id
    // names one message EVENT and this is a new one. That it also goes UNREAD
    // again is the point of the test below; only an identical repeat is
    // silent.
    const [after] = result.current.messageHistory;
    expect(result.current.messageHistory).toHaveLength(1);
    expect(after.message).toBe("No OpenAI key");
    expect(after.id).not.toBe(before.id);
  });

  it("replaces its own standing toast instead of queueing behind it", () => {
    const { result } = setup();

    act(() => result.current.showInfoBox("No Claude key", "warning", undefined, "missing-api-key:preferred"));
    expect(result.current.infoBox?.message).toBe("No Claude key");

    // Not dismissed first: the superseded wording is still on screen. Queued,
    // the strip would keep naming the old provider for the full 15s dwell and
    // then repeat the new wording behind it.
    act(() => result.current.showInfoBox("No OpenAI key", "warning", undefined, "missing-api-key:preferred"));

    expect(result.current.infoBox?.message).toBe("No OpenAI key");
    expect(result.current.infoBox?.id).toBe(result.current.messageHistory[0].id);

    act(() => void vi.advanceTimersByTime(15_001));
    expect(result.current.infoBox).toBeNull();
  });

  it("announces a reworded condition", () => {
    const { result } = setup();

    act(() => result.current.showInfoBox("No Claude key", "warning", undefined, "missing-api-key:preferred"));
    act(() => result.current.hideInfoBox());
    act(() => result.current.markAllRead());

    // The merchant switches to a second provider that also has no key: the
    // condition genuinely changed, so it has to reach them somewhere. Keeping
    // the row silently up to date surfaced it nowhere at all — no badge, no
    // toast, and the strip still showing the old provider's name.
    act(() => result.current.showInfoBox("No OpenAI key", "warning", undefined, "missing-api-key:preferred"));

    expect(result.current.infoBox?.message).toBe("No OpenAI key");
    expect(result.current.unreadCount).toBe(1);
  });

  it("keeps messages without a key as separate events", () => {
    const { result } = setup();

    act(() => result.current.showInfoBox("Saved", "success"));
    act(() => result.current.showInfoBox("Saved", "success"));

    expect(result.current.messageHistory).toHaveLength(2);
  });

  it("gives two identical messages in one tick distinct ids", () => {
    const { result } = setup();

    // The task-completion loop in MainNavigation emits several messages
    // synchronously; ids built from `Date.now()` collided and produced
    // duplicate React keys.
    act(() => {
      result.current.showInfoBox("Task completed", "success");
      result.current.showInfoBox("Task completed", "success");
    });

    const [a, b] = result.current.messageHistory;
    expect(a.id).not.toBe(b.id);
  });
});

describe("InfoBoxContext — messages emitted in one tick", () => {
  it("queues them instead of overwriting each other", () => {
    const { result } = setup();

    // `app.settings.tsx` reports one message per corrupted provider key in a
    // synchronous loop. `infoBoxRef` used to be assigned during RENDER, so
    // every call in the tick read `null`, took the "nothing is showing"
    // branch and replaced the previous toast — only the last provider was
    // ever displayed.
    act(() => {
      result.current.showInfoBox("Key A broken", "critical");
      result.current.showInfoBox("Key B broken", "critical");
      result.current.showInfoBox("Key C broken", "critical");
    });

    expect(result.current.infoBox?.message).toBe("Key A broken");

    act(() => void vi.advanceTimersByTime(15_001));
    expect(result.current.infoBox?.message).toBe("Key B broken");

    act(() => void vi.advanceTimersByTime(15_001));
    expect(result.current.infoBox?.message).toBe("Key C broken");
  });
});

describe("InfoBoxContext — a standing message must not block the rest", () => {
  it("auto-hides a critical toast so the queue drains", () => {
    const { result } = setup();

    act(() => result.current.showInfoBox("No API key", "warning"));
    act(() => result.current.showInfoBox("Save failed", "critical"));

    // A warning used to stand forever, and everything behind it queued: on a
    // shop without an API key no save error was ever displayed again.
    expect(result.current.infoBox?.message).toBe("No API key");
    act(() => void vi.advanceTimersByTime(15_001));
    expect(result.current.infoBox?.message).toBe("Save failed");
  });

  it("caps the history", () => {
    const { result } = setup();

    act(() => {
      for (let i = 0; i < 60; i++) result.current.showInfoBox(`Message ${i}`, "info");
    });

    expect(result.current.messageHistory).toHaveLength(50);
    expect(result.current.messageHistory[0].message).toBe("Message 59");
  });
});

describe("InfoBoxContext — the unread count is derived from the rows", () => {
  it("clears on markAllRead", () => {
    const { result } = setup();

    act(() => result.current.showInfoBox("Saved", "success"));
    expect(result.current.unreadCount).toBe(1);

    act(() => result.current.markAllRead());
    expect(result.current.unreadCount).toBe(0);
    expect(result.current.messageHistory).toHaveLength(1);
  });

  it("does not swallow an unread message when older ones are resolved", () => {
    const { result } = setup();

    act(() => {
      result.current.showInfoBox("Key A broken", "critical", undefined, "corrupted:a");
      result.current.showInfoBox("Key B broken", "critical", undefined, "corrupted:b");
    });
    act(() => result.current.markAllRead());
    act(() => result.current.showInfoBox("Save failed", "critical"));

    expect(result.current.unreadCount).toBe(1);

    // Resolving the two READ warnings used to subtract 2 from a counter that
    // stood at 1, clamping the genuinely unread message's badge to zero.
    act(() => result.current.dismissByKey("corrupted"));

    expect(result.current.messageHistory).toHaveLength(1);
    expect(result.current.unreadCount).toBe(1);
  });
});

describe("InfoBoxContext — clear all means all", () => {
  it("drops the standing toast and the queue with the history", () => {
    const { result } = setup();

    act(() => result.current.showInfoBox("No API key", "warning"));
    act(() => result.current.showInfoBox("Queued behind it", "critical"));

    act(() => result.current.clearHistory());

    expect(result.current.messageHistory).toHaveLength(0);
    expect(result.current.unreadCount).toBe(0);
    // The panel used to read "No messages" directly under a visible banner,
    // and the queue kept popping up messages the list no longer knew about.
    expect(result.current.infoBox).toBeNull();

    act(() => void vi.advanceTimersByTime(60_000));
    expect(result.current.infoBox).toBeNull();
  });
});

describe("InfoBoxContext — sync progress", () => {
  it("keeps the same object when nothing changed", () => {
    const { result } = setup();

    const first = { phase: "products", percent: 40, error: null, stats: { products: 12 } };
    act(() => result.current.setSyncProgress(first));
    const stored = result.current.syncProgress;

    // `InitialSyncBanner` polls every 4s with a fresh object; without this
    // bail-out the context value changed on every tick and re-rendered the
    // whole outlet tree.
    act(() => result.current.setSyncProgress({ phase: "products", percent: 40, error: null, stats: { products: 12 } }));
    expect(result.current.syncProgress).toBe(stored);

    act(() => result.current.setSyncProgress({ phase: "products", percent: 41, error: null, stats: { products: 12 } }));
    expect(result.current.syncProgress).not.toBe(stored);
  });
});
