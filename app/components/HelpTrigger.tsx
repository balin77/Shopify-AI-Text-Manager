/**
 * The ❓-in-a-circle affordance, defined ONCE.
 *
 * Every help icon in the app — the field/tab help ([HelpTooltip.tsx](HelpTooltip.tsx)),
 * the SEO sections' banner toggle ([seo/SeoHelpBanner.tsx](seo/SeoHelpBanner.tsx)),
 * the image manager's doc toggles
 * ([image-manager/BulkImageUploadPanel.tsx](image-manager/BulkImageUploadPanel.tsx))
 * and the direct-translations setting rows — renders `HelpTriggerButton` from
 * here. Four hand-rolled copies of the same `<button className="help-tooltip-trigger">`
 * had already drifted apart in `marginLeft` and `aria-label`; more importantly
 * the ones that open an OVERLAY need the scroll lock below, and a copy is a
 * copy that forgets it.
 *
 * ## Why an overlay needs the scroll lock
 *
 * The pages that carry these icons mostly do not scroll the DOCUMENT. A page
 * built on the `.app-page-content` frame is a fixed-height box whose single
 * child scrolls internally (see [responsive.css](../styles/responsive.css)),
 * and the content editor scrolls its field area and its right-hand sidebar the
 * same way.
 *
 * Polaris positions a `Popover` against its activator and re-measures on scroll
 * of the containers it can FIND — `Scrollable.forNode`, i.e. Polaris'
 * `[data-polaris-scrollable]` ancestors, falling back to the document. Our
 * scroll containers are neither, so scrolling one moves the ❓ while the open
 * panel stays where it was: it "flies" across the screen, detached from the
 * icon it belongs to. A Polaris `Modal` is `position: fixed` and does not fly,
 * but its own `ScrollLock` only sets `overflow: hidden` on `document.body` —
 * which locks nothing here — so the page keeps scrolling behind it.
 *
 * `useOverlayScrollLock` therefore freezes the trigger's own scrollable
 * ancestors for as long as the overlay is open. It picks them by MEASUREMENT,
 * never by a hardcoded selector list: a container that cannot actually scroll
 * (`scrollHeight <= clientHeight`) is skipped, so a ❓ in a short, non-scrolling
 * tab — the editor sidebar's SEO score tab — locks nothing and the page behaves
 * exactly as before. That is also why no route has to opt in or out: new scroll
 * containers are picked up, and a tab that grows past its box starts locking on
 * its own. The containers Polaris DOES handle (`[data-polaris-scrollable]`, the
 * document) are excluded by name — see
 * [overlay-scroll-lock.ts](../utils/overlay-scroll-lock.ts) for that list and
 * for how a container is locked without a layout shift.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { Icon, Popover } from "@shopify/polaris";
import { QuestionCircleIcon } from "@shopify/polaris-icons";
import { lockScrollContainers } from "../utils/overlay-scroll-lock";
import "../styles/HelpTooltip.css";

/**
 * Freeze every scroll container above `anchorRef` while `active`.
 *
 * Exported for any overlay opened from something other than a ❓ — the rule is
 * about overlays, not about help. The DOM half (which containers, and how they
 * are locked without a layout shift) lives in
 * [overlay-scroll-lock.ts](../utils/overlay-scroll-lock.ts).
 */
export function useOverlayScrollLock(
  active: boolean,
  anchorRef: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!active) return;
    const anchor = anchorRef.current;
    if (!anchor) return;
    return lockScrollContainers(anchor);
  }, [active, anchorRef]);
}

export interface HelpTriggerButtonProps {
  /** Accessible name — the title of whatever the icon reveals. */
  label: string;
  onClick: () => void;
  /** Only for callers whose surrounding layout already provides the gap. */
  style?: CSSProperties;
  buttonRef?: RefObject<HTMLButtonElement | null>;
}

/**
 * The bare ❓ button. Use this directly when the icon reveals INLINE content (a
 * `Collapsible`, a `Banner`) — there is no overlay to keep in place, so there
 * is nothing to lock. For an overlay use `HelpPopover`, which owns the lock.
 */
export function HelpTriggerButton({ label, onClick, style, buttonRef }: HelpTriggerButtonProps) {
  return (
    <button
      ref={buttonRef}
      className="help-tooltip-trigger"
      type="button"
      style={style}
      aria-label={label}
      onClick={onClick}
    >
      <Icon source={QuestionCircleIcon} tone="interactive" />
    </button>
  );
}

export interface HelpPopoverProps {
  label: string;
  preferredPosition?: "above" | "below";
  triggerStyle?: CSSProperties;
  /**
   * Keep the scroll locked even though the popover itself is closed — for a
   * caller that hands off to a second overlay of its own (`HelpTooltip`'s
   * "Mehr erfahren" modal opens as the popover closes, and the page must stay
   * frozen across the handover).
   */
  keepScrollLocked?: boolean;
  /** Popover body; as a function it receives a `close` callback. */
  children: ReactNode | ((close: () => void) => ReactNode);
}

/** ❓ + the overlay it opens + the scroll lock that keeps the overlay in place. */
export function HelpPopover({
  label,
  preferredPosition = "above",
  triggerStyle,
  keepScrollLocked = false,
  children,
}: HelpPopoverProps) {
  const [active, setActive] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setActive(false), []);
  const toggle = useCallback(() => setActive((open) => !open), []);

  useOverlayScrollLock(active || keepScrollLocked, triggerRef);

  return (
    <Popover
      active={active}
      activator={
        <HelpTriggerButton
          label={label}
          onClick={toggle}
          style={triggerStyle}
          buttonRef={triggerRef}
        />
      }
      onClose={close}
      preferredPosition={preferredPosition}
      sectioned
    >
      <div className="help-tooltip-content">
        {typeof children === "function" ? children(close) : children}
      </div>
    </Popover>
  );
}
