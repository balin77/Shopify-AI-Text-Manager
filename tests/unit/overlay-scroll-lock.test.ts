/**
 * The scroll lock behind every ❓ that opens an overlay
 * ([app/utils/overlay-scroll-lock.ts](../../app/utils/overlay-scroll-lock.ts)).
 *
 * The bug it exists for: this app scrolls an INNER container, which Polaris
 * cannot see, so an open popover stays put while its activator scrolls away.
 * The rules that must not regress are the ones a future edit would plausibly
 * break — that a NON-scrolling container is left alone (the SEO score tab),
 * that the containers Polaris DOES handle are left alone, that releasing
 * restores what was there instead of a hardcoded default, and that two
 * overlapping overlays cannot unlock each other.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { scrollableAncestorsOf, lockScrollContainers } from "../../app/utils/overlay-scroll-lock";

/** happy-dom has no layout, so scroll/client sizes have to be declared. */
function sized(
  el: HTMLElement,
  { scrollHeight = 0, clientHeight = 0, scrollWidth = 0, clientWidth = 0 },
) {
  for (const [prop, value] of Object.entries({ scrollHeight, clientHeight, scrollWidth, clientWidth })) {
    Object.defineProperty(el, prop, { value, configurable: true });
  }
}

let stylesheet: Map<HTMLElement, { overflowX?: string; overflowY?: string }>;

beforeEach(() => {
  stylesheet = new Map();
  // The INLINE style has to win, exactly as it does in a browser: the lock
  // works by writing inline `overflow: hidden`, so a spy that only ever answers
  // from the declared map would hide the fact that a locked container no longer
  // measures as scrollable — which is the whole reason the ref count claims an
  // already-locked ancestor instead of re-measuring it.
  vi.spyOn(window, "getComputedStyle").mockImplementation(((el: HTMLElement) => {
    const declared = stylesheet.get(el) ?? {};
    return {
      overflowX: el.style.overflowX || declared.overflowX || "visible",
      overflowY: el.style.overflowY || declared.overflowY || "visible",
    };
  }) as typeof window.getComputedStyle);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

/** frame > scroller > panel > trigger, with nothing scrolling yet. */
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

function scrollsVertically(el: HTMLElement) {
  stylesheet.set(el, { overflowY: "auto" });
  sized(el, { scrollHeight: 900, clientHeight: 400 });
}

describe("scrollableAncestorsOf", () => {
  it("picks an overflowing auto-overflow ancestor", () => {
    const { scroller, trigger } = buildTree();
    scrollsVertically(scroller);

    expect(scrollableAncestorsOf(trigger)).toEqual([scroller]);
  });

  it("skips a container that declares overflow but does not overflow", () => {
    // The SEO score tab: `overflow-y: auto`, content shorter than the box.
    // Nothing can scroll, so nothing may be locked.
    const { scroller, trigger } = buildTree();
    stylesheet.set(scroller, { overflowY: "auto" });
    sized(scroller, { scrollHeight: 300, clientHeight: 400 });

    expect(scrollableAncestorsOf(trigger)).toEqual([]);
  });

  it("skips an overflowing container that does not scroll", () => {
    const { scroller, trigger } = buildTree();
    stylesheet.set(scroller, { overflowY: "hidden" });
    sized(scroller, { scrollHeight: 900, clientHeight: 400 });

    expect(scrollableAncestorsOf(trigger)).toEqual([]);
  });

  it("picks a horizontally scrolling container too", () => {
    const { scroller, trigger } = buildTree();
    stylesheet.set(scroller, { overflowX: "scroll" });
    sized(scroller, { scrollWidth: 2000, clientWidth: 800 });

    expect(scrollableAncestorsOf(trigger)).toEqual([scroller]);
  });

  it("returns every scrolling ancestor, innermost first", () => {
    const { frame, scroller, trigger } = buildTree();
    scrollsVertically(scroller);
    scrollsVertically(frame);

    expect(scrollableAncestorsOf(trigger)).toEqual([scroller, frame]);
  });

  it("ignores the trigger's own overflow", () => {
    const { trigger } = buildTree();
    scrollsVertically(trigger);

    expect(scrollableAncestorsOf(trigger)).toEqual([]);
  });

  it("skips a Polaris scrollable — Polaris repositions the overlay itself", () => {
    // A Modal's body. Locking it would make the modal unscrollable for as long
    // as a help popover inside it is open.
    const { scroller, trigger } = buildTree();
    scroller.setAttribute("data-polaris-scrollable", "true");
    scrollsVertically(scroller);

    expect(scrollableAncestorsOf(trigger)).toEqual([]);
  });

  it("skips <html> and <body>, which Polaris' own ScrollLock owns", () => {
    // responsive.css puts `overflow-x: hidden` on both below 768px, which makes
    // their computed overflow-y `auto` — so they DO measure as scrollable and
    // have to be excluded by name.
    const { trigger } = buildTree();
    for (const el of [document.documentElement, document.body]) {
      scrollsVertically(el);
    }

    expect(scrollableAncestorsOf(trigger)).toEqual([]);
  });
});

describe("lockScrollContainers", () => {
  function verticalTree() {
    const tree = buildTree();
    scrollsVertically(tree.scroller);
    return tree;
  }

  it("hides the vertical overflow and reserves the scrollbar gutter", () => {
    const { scroller, trigger } = verticalTree();

    lockScrollContainers(trigger);

    expect(scroller.style.overflowY).toBe("hidden");
    // Without the gutter the container would jump by the scrollbar's width the
    // moment the overlay opens.
    expect(scroller.style.scrollbarGutter).toBe("stable");
    // The axis that never scrolled is left alone.
    expect(scroller.style.overflowX).toBe("");
  });

  it("locks only the horizontal axis, and without a gutter, for an x-only scroller", () => {
    // A vertical gutter here would reserve inline space that was never there —
    // the same jump, in the other direction.
    const { scroller, trigger } = buildTree();
    stylesheet.set(scroller, { overflowX: "auto" });
    sized(scroller, { scrollWidth: 2000, clientWidth: 800 });

    lockScrollContainers(trigger);

    expect(scroller.style.overflowX).toBe("hidden");
    expect(scroller.style.overflowY).toBe("");
    expect(scroller.style.scrollbarGutter).toBe("");
  });

  it("restores the inline values the container had, not a default", () => {
    const { scroller, trigger } = verticalTree();
    scroller.style.overflowY = "auto";
    scroller.style.scrollbarGutter = "both-edges";

    lockScrollContainers(trigger)();

    expect(scroller.style.overflowY).toBe("auto");
    expect(scroller.style.scrollbarGutter).toBe("both-edges");
  });

  it("keeps the lock until the last holder releases", () => {
    const { scroller, trigger } = verticalTree();

    const releaseFirst = lockScrollContainers(trigger);
    // The container now measures as unscrollable — the second holder has to be
    // granted on the strength of the existing lock, not a fresh measurement.
    const releaseSecond = lockScrollContainers(trigger);

    releaseFirst();
    expect(scroller.style.overflowY).toBe("hidden");

    releaseSecond();
    expect(scroller.style.overflowY).toBe("");
  });

  it("is idempotent per holder, so a double release cannot unlock someone else", () => {
    const { scroller, trigger } = verticalTree();

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
    stylesheet.set(scroller, { overflowY: "auto" });
    sized(scroller, { scrollHeight: 300, clientHeight: 400 });

    lockScrollContainers(trigger);

    expect(scroller.style.overflowY).toBe("");
    expect(scroller.style.scrollbarGutter).toBe("");
  });
});
