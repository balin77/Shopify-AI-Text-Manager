/**
 * ActionTooltip — an explanatory tooltip that survives the control being
 * disabled.
 *
 * A plain Polaris `<Tooltip>` around a `<Button disabled>` never opens: browsers
 * don't dispatch pointer events for disabled form controls. That is exactly when
 * an explanation is most wanted ("why can't I click this?"), so this picks the
 * right rendering instead of making every call site branch:
 *
 *  - enabled  → plain Tooltip (normal cursor, no extra wrappers)
 *  - disabled → DisabledActionTooltip, which owns the pointer-events trick and
 *               the not-allowed cursor
 *
 * `content={undefined}` renders the children untouched, so a caller with no
 * string yet stays valid.
 */

import { Tooltip } from "@shopify/polaris";
import type { ReactNode } from "react";
import { DisabledActionTooltip } from "./DisabledActionTooltip";

interface ActionTooltipProps {
  /** What the action does. `undefined` → children render as-is. */
  content?: string;
  /** Mirrors the wrapped control's own `disabled` prop. */
  disabled?: boolean;
  children: ReactNode;
  preferredPosition?: "above" | "below" | "mostSpace";
}

export function ActionTooltip({
  content,
  disabled = false,
  children,
  preferredPosition = "above",
}: ActionTooltipProps) {
  if (!content) return <>{children}</>;

  if (disabled) {
    return (
      <DisabledActionTooltip hint={content} preferredPosition={preferredPosition}>
        {children}
      </DisabledActionTooltip>
    );
  }

  return (
    <Tooltip content={content} dismissOnMouseOut preferredPosition={preferredPosition}>
      {children}
    </Tooltip>
  );
}
