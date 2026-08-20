/**
 * Freezing the scroll containers an overlay is anchored in, for as long as it
 * is open.
 *
 * WHY this exists at all is in the module comment of
 * [HelpTrigger.tsx](../components/HelpTrigger.tsx), which is its main caller —
 * short version: this app's pages scroll an INNER container, not the document,
 * and neither Polaris' popover repositioning (`Scrollable.forNode`, which only
 * knows `[data-polaris-scrollable]` ancestors and otherwise falls back to the
 * document) nor `Modal`'s own `ScrollLock` (`document.body`) can see one. So an
 * open popover stays behind while its activator scrolls away.
 *
 * The DOM half lives here, apart from React, so the container selection is
 * unit-testable.
 */

const SCROLLS = /^(auto|scroll)$/;

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
 *
 * The document scroller is deliberately NOT included. On the plain (non
 * `.app-page-content`) routes it is what scrolls, but Polaris already handles
 * it on both counts — its popover follows the activator on document scroll, and
 * `Modal` locks the document through `ScrollLock`. A second, competing document
 * lock would only fight it.
 */
export function scrollableAncestorsOf(node: HTMLElement): HTMLElement[] {
  const containers: HTMLElement[] = [];
  for (let el = node.parentElement; el; el = el.parentElement) {
    const style = window.getComputedStyle(el);
    const scrollsY = SCROLLS.test(style.overflowY) && el.scrollHeight > el.clientHeight;
    const scrollsX = SCROLLS.test(style.overflowX) && el.scrollWidth > el.clientWidth;
    if (scrollsY || scrollsX) containers.push(el);
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
 * inside an already-open modal shares that modal's scroll container) cannot
 * have the first one to close restore the LOCKED values as if they were the
 * original ones.
 */
const containerLocks = new WeakMap<HTMLElement, ContainerLock>();

/**
 * Lock every scrollable ancestor of `anchor`; the returned function releases
 * this holder's claim on each of them.
 *
 * The lock is `overflow: hidden` PLUS `scrollbar-gutter: stable`: hiding the
 * overflow removes a classic scrollbar, and without the reserved gutter every
 * locked container would jump by the scrollbar's width the moment the overlay
 * opens — the same shift `html { scrollbar-gutter: stable }` already prevents
 * app-wide. `overflow: hidden` keeps `scrollTop`, so nothing moves on release.
 * Releasing writes back the INLINE values, so a container that carried its own
 * inline overflow keeps it.
 */
export function lockScrollContainers(anchor: HTMLElement): () => void {
  const locked = scrollableAncestorsOf(anchor);

  for (const el of locked) {
    const existing = containerLocks.get(el);
    if (existing) {
      existing.holders += 1;
      continue;
    }
    containerLocks.set(el, {
      holders: 1,
      overflowX: el.style.overflowX,
      overflowY: el.style.overflowY,
      scrollbarGutter: el.style.scrollbarGutter,
    });
    el.style.overflowX = "hidden";
    el.style.overflowY = "hidden";
    el.style.scrollbarGutter = "stable";
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
