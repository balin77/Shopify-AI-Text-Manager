/**
 * Freezing the scroll containers an overlay is anchored in, for as long as it
 * is open.
 *
 * WHY this exists at all is in the module comment of
 * [HelpTrigger.tsx](../components/HelpTrigger.tsx), which is its main caller —
 * short version: this app's pages scroll an INNER container, which Polaris
 * cannot see, so an open popover stays behind while its activator scrolls away.
 *
 * The DOM half lives here, apart from React, so the container selection is
 * unit-testable.
 */

const SCROLLS = /^(auto|scroll)$/;

/** Which axes of a container can scroll right now. */
interface ScrollAxes {
  x: boolean;
  y: boolean;
}

/**
 * Containers this lock must keep its hands off, no matter what they measure:
 *
 * - **Polaris' own scrollables.** `Scrollable.forNode` finds
 *   `[data-polaris-scrollable]` ancestors and re-measures the popover when they
 *   scroll, so the overlay follows its activator there and nothing is broken to
 *   fix. Locking one anyway would make a Polaris `Modal` unscrollable for as
 *   long as a help popover inside it is open (`AssignPanel` is exactly that).
 * - **The document scroller.** Polaris handles it the same way for popovers,
 *   and locks it itself for modals (`ScrollLock`); a second, competing document
 *   lock would only fight that one. `<html>`/`<body>` have to be named rather
 *   than measured away: [responsive.css](../styles/responsive.css) puts
 *   `overflow-x: hidden` on both below 768px, which makes their computed
 *   `overflow-y` `auto` — so on mobile they measure as scrollable containers.
 */
function isOffLimits(el: HTMLElement): boolean {
  return (
    el === document.documentElement ||
    el === document.body ||
    el.hasAttribute("data-polaris-scrollable")
  );
}

function scrollingAxes(el: HTMLElement): ScrollAxes | null {
  if (isOffLimits(el)) return null;
  const style = window.getComputedStyle(el);
  const y = SCROLLS.test(style.overflowY) && el.scrollHeight > el.clientHeight;
  const x = SCROLLS.test(style.overflowX) && el.scrollWidth > el.clientWidth;
  return x || y ? { x, y } : null;
}

/**
 * The scrollable ancestors of `node` — the only containers whose scrolling can
 * move `node`, and therefore the only ones that can detach an overlay from it.
 *
 * Selection is by MEASUREMENT, never by a hardcoded selector list: a container
 * that is not actually scrollable (`scrollHeight <= clientHeight`) is skipped,
 * so an overlay opened from a short, non-scrolling panel — the content editor
 * sidebar's SEO score tab — locks nothing. That is also why no route has to opt
 * in or out: new scroll containers are picked up on their own, and a panel that
 * grows past its box starts locking without an edit here.
 */
export function scrollableAncestorsOf(node: HTMLElement): HTMLElement[] {
  const containers: HTMLElement[] = [];
  for (let el = node.parentElement; el; el = el.parentElement) {
    if (scrollingAxes(el)) containers.push(el);
  }
  return containers;
}

interface ContainerLock {
  holders: number;
  overflowX: string;
  overflowY: string;
  scrollbarGutter: string;
}

/**
 * Ref-counted per container, so overlapping overlays (a help popover opened
 * inside an already-open one, sharing a scroll container) cannot have the first
 * one to close restore the LOCKED values as if they were the original ones.
 */
const containerLocks = new WeakMap<HTMLElement, ContainerLock>();

/**
 * A locked container no longer MEASURES as scrollable — that is the whole point
 * of the lock — so a second overlay walking the same ancestors would skip it
 * and the ref count could never leave 1. An already-locked ancestor is
 * therefore claimed on the strength of its existing lock, not on a fresh
 * measurement.
 */
function ancestorsToLock(anchor: HTMLElement): HTMLElement[] {
  const containers: HTMLElement[] = [];
  for (let el = anchor.parentElement; el; el = el.parentElement) {
    if (containerLocks.has(el) || scrollingAxes(el)) containers.push(el);
  }
  return containers;
}

/**
 * Lock every scrollable ancestor of `anchor`; the returned function releases
 * this holder's claim on each of them. Calling it twice is a no-op — a holder
 * cannot release a claim it no longer has, and by extension not someone else's.
 *
 * Only the axes that actually scroll are hidden. A vertical lock also sets
 * `scrollbar-gutter: stable`, because hiding the overflow removes a classic
 * scrollbar and the container would otherwise jump by its width the moment the
 * overlay opens — the same shift `html { scrollbar-gutter: stable }` already
 * prevents app-wide. A horizontal-only lock must NOT set it: there the gutter
 * would reserve inline space that was never there, which is the very jump it is
 * meant to prevent, only in the other direction.
 *
 * `overflow: hidden` keeps `scrollTop`/`scrollLeft`, so nothing moves on
 * release. Releasing writes back the INLINE values, so a container that carried
 * its own inline overflow keeps it.
 */
export function lockScrollContainers(anchor: HTMLElement): () => void {
  const locked = ancestorsToLock(anchor);

  for (const el of locked) {
    const existing = containerLocks.get(el);
    if (existing) {
      existing.holders += 1;
      continue;
    }
    const axes = scrollingAxes(el);
    if (!axes) continue;
    containerLocks.set(el, {
      holders: 1,
      overflowX: el.style.overflowX,
      overflowY: el.style.overflowY,
      scrollbarGutter: el.style.scrollbarGutter,
    });
    if (axes.x) el.style.overflowX = "hidden";
    if (axes.y) {
      el.style.overflowY = "hidden";
      el.style.scrollbarGutter = "stable";
    }
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const el of locked) {
      const lock = containerLocks.get(el);
      if (!lock) continue;
      lock.holders -= 1;
      if (lock.holders > 0) continue;
      containerLocks.delete(el);
      el.style.overflowX = lock.overflowX;
      el.style.overflowY = lock.overflowY;
      el.style.scrollbarGutter = lock.scrollbarGutter;
    }
  };
}
