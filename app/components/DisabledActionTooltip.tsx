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
 */

import { Tooltip } from "@shopify/polaris";
import type { ReactNode } from "react";

interface DisabledActionTooltipProps {
  /** Why the action is disabled. `undefined` → children render as-is. */
  hint?: string;
  children: ReactNode;
  preferredPosition?: "above" | "below" | "mostSpace";
}

export function DisabledActionTooltip({
  hint,
  children,
  preferredPosition = "above",
}: DisabledActionTooltipProps) {
  if (!hint) return <>{children}</>;

  return (
    <Tooltip content={hint} dismissOnMouseOut preferredPosition={preferredPosition}>
      <span style={{ display: "inline-block", cursor: "not-allowed" }}>
        <span style={{ display: "inline-block", pointerEvents: "none" }}>{children}</span>
      </span>
    </Tooltip>
  );
}
