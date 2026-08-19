/**
 * Freezes everything BEHIND an open overlay, and only that.
 *
 * Why it exists: a Polaris `Popover` is portalled to the document and
 * positioned once against its activator. It re-measures on scrolls it can see
 * — but the pages of this app do not scroll the DOCUMENT. `.app-page-content`
 * is a non-scrolling frame whose single child scrolls internally
 * ([responsive.css](../styles/responsive.css)), and that child is a plain div,
 * not a Polaris `<Scrollable>`, so `PositionedOverlay` never learns about it.
 * The activator then slides away under a popover that stays exactly where it
 * was opened — the "the dropdown flies off" report on the category picker.
 *
 * Two ways to fix that: teach the overlay to follow, or stop the movement.
 * Stopping it is the better one for a picker whose whole job is a list you
 * read: a popover that chases a scrolling row is still a moving target.
 *
 * ── Why events and not `overflow: hidden` ───────────────────────────────────
 * The usual lock (set `overflow: hidden` on the scroll container) would work,
 * but those containers carry `scrollbar-gutter: stable`, and the gutter is only
 * reserved while the box actually scrolls — hiding the overflow gives the
 * layout back the scrollbar's width, so the page jumps sideways the moment the
 * popover opens and jumps back when it closes. Cancelling the scroll EVENT
 * leaves every box exactly as it is.
 *
 * ── Why the allowance is the scrolling element, not the whole panel ─────────
 * The overlay's own list has to keep scrolling, so events inside it pass. It is
 * the list that is allowed and not the panel around it: a wheel over the search
 * box at the top of a panel would otherwise chain straight through to the page
 * behind it, which is the exact movement this hook exists to stop. The allowed
 * element should additionally carry `overscroll-behavior: contain`, or reaching
 * ITS end chains to the page for the same reason.
 *
 * Keyboard scrolling (space, PageDown, arrows) is deliberately not touched:
 * those act on the focused element, and while an overlay is open the focus is
 * inside it.
 */

import { useEffect, type RefObject } from "react";

export function useScrollLock(
  active: boolean,
  /** The one element that may still scroll — normally the overlay's list. */
  allowWithin?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!active || typeof window === "undefined") return;

    const blockOutside = (event: Event) => {
      const allowed = allowWithin?.current;
      // `instanceof Node` and not a cast: an event dispatched straight at the
      // window has the WINDOW as its target, and `contains()` rejects anything
      // that is not a node — the check has to answer "outside", not throw.
      const target = event.target;
      if (allowed && target instanceof Node && allowed.contains(target)) return;
      // Only possible because the listener is registered non-passively;
      // browsers ignore `preventDefault` on a passive wheel/touchmove listener.
      if (event.cancelable) event.preventDefault();
    };

    // Capture phase, so the event is cancelled before it reaches whichever
    // container would have scrolled on it.
    const options: AddEventListenerOptions = { passive: false, capture: true };
    window.addEventListener("wheel", blockOutside, options);
    window.addEventListener("touchmove", blockOutside, options);
    return () => {
      window.removeEventListener("wheel", blockOutside, options);
      window.removeEventListener("touchmove", blockOutside, options);
    };
  }, [active, allowWithin]);
}
