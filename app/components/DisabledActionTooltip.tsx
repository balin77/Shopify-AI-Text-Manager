/**
 * DisabledActionTooltip — tooltip that also works on a DISABLED control.
 *
 * Browsers don't dispatch mouse events for disabled form controls, so wrapping a
 * `<Button disabled>` in a Polaris `<Tooltip>` alone shows nothing on hover. The
 * inner `pointer-events: none` span makes the disabled button transparent to the
 * pointer, so the hover lands on the Tooltip's own activator wrapper instead.
 *
 * Pass `hint={undefined}` to render the children untouched (no wrapper, no
 * tooltip) — that keeps call sites free of conditional JSX.
 *
 * The wrapper is `inline-block`, which is right for the buttons and icons this
 * mostly wraps and WRONG for a full-width row: a `ToggleRow` inside it lost its
 * `space-between`, so a disabled switch sat beside its label while every
 * enabled one beside it kept its switch at the right edge. `block` is that
 * case — the layout is the child's business again.
 */

import { Tooltip } from "@shopify/polaris";
import type { ReactNode } from "react";

interface DisabledActionTooltipProps {
  /** Why the action is disabled. `undefined` → children render as-is. */
  hint?: string;
  children: ReactNode;
  preferredPosition?: "above" | "below" | "mostSpace";
  /** The child lays itself out across the full width (a `ToggleRow`), so the
   *  wrapper must not shrink-wrap it. */
  block?: boolean;
  /** Polaris' tooltip z-index (400s) loses against this app's own layers —
   *  the fixed nav (1000) and the sticky bars around 999. Pass the same 1200
   *  the item list already uses when the tooltip has such a layer above it. */
  zIndexOverride?: number;
}

export function DisabledActionTooltip({
  hint,
  children,
  preferredPosition = "above",
  block = false,
  zIndexOverride,
}: DisabledActionTooltipProps) {
  if (!hint) return <>{children}</>;

  const display = block ? "block" : "inline-block";
  return (
    <Tooltip
      content={hint}
      dismissOnMouseOut
      preferredPosition={preferredPosition}
      zIndexOverride={zIndexOverride}
    >
      <span style={{ display, cursor: "not-allowed" }}>
        <span style={{ display, pointerEvents: "none" }}>{children}</span>
      </span>
    </Tooltip>
  );
}
