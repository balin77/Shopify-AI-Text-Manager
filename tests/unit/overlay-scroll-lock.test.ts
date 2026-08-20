/**
 * The scroll lock behind every ❓ that opens an overlay
 * ([app/utils/overlay-scroll-lock.ts](../../app/utils/overlay-scroll-lock.ts)).
 *
 * The bug it exists for: this app scrolls an INNER container, which Polaris
 * cannot see, so an open popover stays put while its activator scrolls away.
 * The rules that must not regress are the ones a future edit would plausibly
 * break — that a NON-scrolling container is left alone (the SEO score tab),
 * that releasing restores what was there instead of a hardcoded default, and
 * that two overlaps do not let the first release unlock for both.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { scrollableAncestorsOf, lockScrollContainers } from "../../app/utils/overlay-scroll-lock";

/** happy-dom has no layout, so scroll/client sizes have to be declared. */
function sized(el: HTMLElement, { scrollHeight = 0, clientHeight = 0, scrollWidth = 0, clientWidth = 0 }) {
  for (const [prop, value] of Object.entries({ scrollHeight, clientHeight, scrollWidth, clientWidth })) {
    Object.defineProperty(el, prop, { value, configurable: true });
  }
}

let computed: Map<HTMLElement, { overflowX?: string; overflowY?: string }>;

beforeEach(() => {
  computed = new Map();
  vi.spyOn(window, "getComputedStyle").mockImplementation(((el: HTMLElement) => {
    const declared = computed.get(el) ?? {};
    return { overflowX: declared.overflowX ?? "visible", overflowY: declared.overflowY ?? "visible" };
  }) as typeof window.getComputedStyle);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

/** frame > scroller > panel > trigger, with only `scroller` set up to scroll. */
function buildTree() {
  const frame = document.createElement("div");
  const scroller = document.createElement("div");
  const panel = document.createElement("div");
  const trigger = document.createElement("button");
  frame.appendChild(scroller);
  scroller.appendChild(panel);
  panel.appendChild(trigger);
  document.body.appendChild(frame);
  for (const el of [frame, scroller, panel, trigger]) sized(el, {});
  return { frame, scroller, panel, trigger };
}

describe("scrollableAncestorsOf", () => {
  it("picks an overflowing auto-overflow ancestor", () => {
    const { scroller, trigger } = buildTree();
    computed.set(scroller, { overflowY: "auto" });
    sized(scroller, { scrollHeight: 900, clientHeight: 400 });

    expect(scrollableAncestorsOf(trigger)).toEqual([scroller]);
  });

  it("skips a container that declares overflow but does not overflow", () => {
    // The SEO score tab: `overflow-y: auto`, content shorter than the box.
    // Nothing can scroll, so nothing may be locked.
    const { scroller, trigger } = buildTree();
    computed.set(scroller, { overflowY: "auto" });
    sized(scroller, { scrollHeight: 300, clientHeight: 400 });

    expect(scrollableAncestorsOf(trigger)).toEqual([]);
  });

  it("skips an overflowing container that does not scroll", () => {
    const { scroller, trigger } = buildTree();
    computed.set(scroller, { overflowY: "hidden" });
    sized(scroller, { scrollHeight: 900, clientHeight: 400 });

    expect(scrollableAncestorsOf(trigger)).toEqual([]);
  });

  it("picks a horizontally scrolling container too (the bulk grid)", () => {
    const { scroller, trigger } = buildTree();
    computed.set(scroller, { overflowX: "scroll" });
    sized(scroller, { scrollWidth: 2000, clientWidth: 800 });

    expect(scrollableAncestorsOf(trigger)).toEqual([scroller]);
  });

  it("returns every scrolling ancestor, innermost first", () => {
    const { frame, scroller, trigger } = buildTree();
    computed.set(scroller, { overflowY: "auto" });
    sized(scroller, { scrollHeight: 900, clientHeight: 400 });
    computed.set(frame, { overflowY: "auto" });
    sized(frame, { scrollHeight: 1200, clientHeight: 600 });

    expect(scrollableAncestorsOf(trigger)).toEqual([scroller, frame]);
  });

  it("ignores the trigger's own overflow", () => {
    const { trigger } = buildTree();
    computed.set(trigger, { overflowY: "auto" });
    sized(trigger, { scrollHeight: 900, clientHeight: 400 });

    expect(scrollableAncestorsOf(trigger)).toEqual([]);
  });
});

describe("lockScrollContainers", () => {
  function scrollingTree() {
    const tree = buildTree();
    computed.set(tree.scroller, { overflowY: "auto" });
    sized(tree.scroller, { scrollHeight: 900, clientHeight: 400 });
    return tree;
  }

  it("hides the overflow and reserves the scrollbar gutter", () => {
    const { scroller, trigger } = scrollingTree();

    lockScrollContainers(trigger);

    expect(scroller.style.overflowY).toBe("hidden");
    expect(scroller.style.overflowX).toBe("hidden");
    // Without the gutter the container would jump by the scrollbar's width the
    // moment the overlay opens.
    expect(scroller.style.scrollbarGutter).toBe("stable");
  });

  it("restores the inline values the container had, not a default", () => {
    const { scroller, trigger } = scrollingTree();
    scroller.style.overflowY = "auto";
    scroller.style.scrollbarGutter = "both-edges";

    lockScrollContainers(trigger)();

    expect(scroller.style.overflowY).toBe("auto");
    expect(scroller.style.scrollbarGutter).toBe("both-edges");
    expect(scroller.style.overflowX).toBe("");
  });

  it("keeps the lock until the last holder releases", () => {
    const { scroller, trigger } = scrollingTree();

    const releaseFirst = lockScrollContainers(trigger);
    const releaseSecond = lockScrollContainers(trigger);

    releaseFirst();
    expect(scroller.style.overflowY).toBe("hidden");

    releaseSecond();
    expect(scroller.style.overflowY).toBe("");
  });

  it("is idempotent per holder, so a double release cannot unlock someone else", () => {
    const { scroller, trigger } = scrollingTree();

    const releaseFirst = lockScrollContainers(trigger);
    const releaseSecond = lockScrollContainers(trigger);

    releaseFirst();
    releaseFirst();
    expect(scroller.style.overflowY).toBe("hidden");

    releaseSecond();
    expect(scroller.style.overflowY).toBe("");
  });

  it("locks nothing when no ancestor scrolls", () => {
    const { scroller, trigger } = buildTree();
    computed.set(scroller, { overflowY: "auto" });
    sized(scroller, { scrollHeight: 300, clientHeight: 400 });

    lockScrollContainers(trigger);

    expect(scroller.style.overflowY).toBe("");
    expect(scroller.style.scrollbarGutter).toBe("");
  });
});
