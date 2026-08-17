/**
 * The metric tile shared by the crawl and on-page reports
 * (PLAN_SEO_CRAWL_EXPANSION §3.7). Moved out of `app.seo.crawl.tsx` so both
 * tabs' tile grids stay one component.
 */

import type { CSSProperties } from "react";
import { Card, BlockStack, Text } from "@shopify/polaris";

/** `<button>` reset — same approach as the findings accordion in
 *  app.seo.performance.tsx, so a card can be a control without looking like
 *  a browser button. */
const TILE_BUTTON_STYLE: CSSProperties = {
  display: "block",
  width: "100%",
  padding: 0,
  border: "none",
  background: "none",
  textAlign: "left",
  cursor: "pointer",
  // <button> would otherwise fall back to the UA font, not Polaris's.
  font: "inherit",
  color: "inherit",
};

/**
 * A metric tile. With `onClick` it becomes the navigation control for its
 * section — `aria-pressed` rather than `role="tab"` on purpose: these are
 * toggle buttons in a grid, and claiming tab semantics would promise
 * arrow-key navigation that a grid of cards doesn't provide.
 */
export function Tile({
  label,
  value,
  hint,
  onClick,
  selected,
}: {
  label: string;
  value: string | number;
  hint?: string;
  onClick?: () => void;
  selected?: boolean;
}) {
  const card = (
    <Card background={selected ? "bg-surface-selected" : undefined}>
      <BlockStack gap="050">
        <Text as="span" variant="bodySm" tone="subdued">{label}</Text>
        <Text as="span" variant="headingLg">{String(value)}</Text>
        {hint && <Text as="span" variant="bodySm" tone="subdued">{hint}</Text>}
      </BlockStack>
    </Card>
  );

  if (!onClick) return card;

  return (
    <button type="button" onClick={onClick} aria-pressed={selected} style={TILE_BUTTON_STYLE}>
      {card}
    </button>
  );
}
