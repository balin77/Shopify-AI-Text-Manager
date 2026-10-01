/**
 * A selectable "step" tile — the shared layout for SEO sections whose parts are
 * SEQUENTIAL rather than a pair of equal cards.
 *
 * First used by the AEO section (robots.txt decides *whether* a crawler may
 * read the store, llms.txt only helps it understand what it read) and reused by
 * the structured-data section (markup has to reach the page before its data
 * quality means anything). Rendering such a pair as two equal cards hides the
 * dependency and usually puts the optional half first.
 *
 * The `<button>` is the grid item, so it carries the height and the two tiles
 * line up when one has more text than the other. `aria-pressed`, not
 * `role="tab"`: these are toggle buttons in a grid and claiming tab semantics
 * would promise arrow-key navigation a grid of cards doesn't provide.
 */
import type { ReactNode } from "react";
import { Box, BlockStack, InlineStack, Text } from "@shopify/polaris";

export function StepTile({
  selected,
  onSelect,
  kicker,
  title,
  body,
  badge,
  accent,
}: {
  selected: boolean;
  onSelect: () => void;
  /** Short "Schritt 1 · …" line above the title. */
  kicker: string;
  title: string;
  body: string;
  /** Status badge for this step — its own verdict, at a glance. */
  badge: ReactNode;
  /**
   * Subtle tint that pairs the tile with the step's badge in the section
   * intro. OPTIONAL: the AEO and crawl sections share this component and keep
   * the plain surface, so leaving it off must change nothing.
   *
   * It deliberately does NOT carry the selected state — the border does that.
   * Written as a MAP rather than a template string because Box's background
   * is a typed union: a computed `bg-surface-${x}` compiles to `string` and
   * would take a typo straight past the compiler into a silent no-op.
   */
  accent?: "info" | "caution" | "success";
}) {
  const ACCENT_BG = {
    info: "bg-surface-info",
    caution: "bg-surface-caution",
    success: "bg-surface-success",
  } as const;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      style={{
        display: "block",
        width: "100%",
        height: "100%",
        textAlign: "left",
        background: "none",
        border: "none",
        padding: 0,
        font: "inherit",
        cursor: "pointer",
      }}
    >
      <Box
        padding="400"
        borderWidth={selected ? "050" : "025"}
        borderColor={selected ? "border-emphasis" : "border"}
        borderRadius="200"
        background={accent ? ACCENT_BG[accent] : selected ? "bg-surface-secondary" : "bg-surface"}
        minHeight="100%"
      >
        <BlockStack gap="200">
          <InlineStack gap="200" blockAlign="center" wrap>
            <Text as="span" variant="bodySm" tone="subdued" fontWeight="medium">
              {kicker}
            </Text>
            {badge}
          </InlineStack>
          <Text as="h3" variant="headingMd">
            {title}
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            {body}
          </Text>
        </BlockStack>
      </Box>
    </button>
  );
}
