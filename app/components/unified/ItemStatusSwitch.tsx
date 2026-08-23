/**
 * The control that decides whether an item is visible in the shop, in the
 * editor's action bar.
 *
 * It sits next to Translate All rather than among the fields because it is the
 * question merchants open the editor to answer, and because Delete and
 * Duplicate now live there too: one row for what happens to the ITEM, the
 * fields below for what it SAYS.
 *
 * ── Why it is a Select and not a toggle ─────────────────────────────────────
 * A product has FOUR statuses. UNLISTED (reachable by direct link, hidden from
 * listings) and ARCHIVED are real states in real catalogues, so a two-state
 * switch has to do something with them — and every option is bad: render them
 * as "not active" and the first click silently overwrites a state nobody asked
 * to change; lock the control and the merchant can neither enter nor leave
 * those states from the product page at all. The first cut of this shipped the
 * lock, which quietly removed "archive a product" from the single editor. A
 * Select has none of that problem and is no bigger on screen.
 *
 * `isPublished` (pages, articles) genuinely is two-valued, so that half is a
 * two-option Select for consistency of shape rather than a third widget.
 *
 * ── Two things the control must not do ──────────────────────────────────────
 *   1. `isPublished` defaults to TRUE in the schema, so on a row an older sync
 *      wrote it is not data. `known` is the discriminator: unknown renders as
 *      unknown, never as a confident "visible". (A product's `status` is NOT
 *      part of that attribute block — it is non-null and predates it — so it is
 *      trustworthy on every row.)
 *   2. ACTIVE is not the same as VISIBLE. A product on no sales channel is
 *      invisible everywhere and Shopify's own admin does not say so on the
 *      product page either — which is why the "Active" hint mentions the
 *      channel rather than promising a live page. It rides in the control's
 *      TOOLTIP: as a line of text in the row it pushed Duplicate/Delete around
 *      every time the value changed.
 *
 * It writes through the SAME value map as the field it replaced, so the change
 * lands in the ordinary save (and the ordinary save bar) rather than firing a
 * write of its own.
 */

import { Select, Text, Tooltip } from "@shopify/polaris";
import { DisabledActionTooltip } from "../DisabledActionTooltip";

/** Shopify's ProductStatus, in the order the admin lists them. */
const PRODUCT_STATUSES = ["ACTIVE", "DRAFT", "UNLISTED", "ARCHIVED"] as const;

/**
 * The action bar sits UNDER the language bar, so a tooltip opening upwards
 * lands on top of it — and Polaris' own tooltip layer (the 400s) loses against
 * this app's layers (fixed nav 1000, sticky bars 999). 1200 is the number the
 * item list already uses for exactly this; keep the two in step.
 */
const TOOLTIP_Z_INDEX = 1200;

export interface ItemStatusSwitchTexts {
  active?: string;
  activeHint?: string;
  draftHint?: string;
  unlistedHint?: string;
  archivedHint?: string;
  published?: string;
  publishedHint?: string;
  unpublishedHint?: string;
  hidden?: string;
  unknown?: string;
  statusLabel?: string;
}

export interface ItemStatusSwitchProps {
  /** "status" (four values) or "published" (a plain boolean). */
  kind: "status" | "published";
  /** The current value as the editor holds it: a status enum, or "true"/"false". */
  value: string;
  onChange: (value: string) => void;
  /** False in a foreign locale — visibility exists once per item. */
  disabled?: boolean;
  /**
   * Has the attribute block ever been fetched for this item? `false` ⇒ the
   * value below is a migration default, not an answer.
   */
  known?: boolean;
  /** Reason the control is disabled, shown as a tooltip. */
  disabledHint?: string;
  /** Shopify ENUM → the merchant's word, keyed "status.ACTIVE". */
  optionLabels?: Record<string, string>;
  t: ItemStatusSwitchTexts;
}

export function ItemStatusSwitch({
  kind,
  value,
  onChange,
  disabled,
  known = true,
  disabledHint,
  optionLabels,
  t,
}: ItemStatusSwitchProps) {
  // Unknown is its own state. Rendering the schema default as an answer is the
  // trap `attributesSyncedAt` exists to close, and here it would show a hidden
  // page as visible. The action bar's own reload button is the way out, which
  // is why this offers no second one.
  if (!known) {
    return (
      <Text as="span" variant="bodySm" tone="subdued">
        {t.unknown || "Status not loaded — reload this item to change it."}
      </Text>
    );
  }

  const control =
    kind === "status" ? (
      <div style={{ minWidth: "160px" }}>
        <Select
          label={t.statusLabel || t.active || "Status"}
          labelHidden
          options={PRODUCT_STATUSES.map((status) => ({
            value: status,
            // A raw `UNLISTED` is not a word in any of the three languages
            // this app ships in.
            label: optionLabels?.[`status.${status}`] ?? status,
          }))}
          value={PRODUCT_STATUSES.includes((value || "").toUpperCase() as never) ? value.toUpperCase() : "DRAFT"}
          onChange={onChange}
          disabled={disabled}
        />
      </div>
    ) : (
      <div style={{ minWidth: "140px" }}>
        <Select
          label={t.published || "Visible"}
          labelHidden
          options={[
            { value: "true", label: t.published || "Visible" },
            { value: "false", label: t.hidden || "Hidden" },
          ]}
          // Anything other than an explicit "false" reads as on, matching the
          // column default (`isPublished` defaults to true on both sides).
          value={value === "false" ? "false" : "true"}
          onChange={onChange}
          disabled={disabled}
        />
      </div>
    );

  // The sentence belongs to the control, not beside it: spelled out in the row
  // it was a line of prose between the Select and Duplicate/Delete, and it
  // changes with the value, so the row resized on every switch. In a foreign
  // locale the control is disabled and the tooltip says WHY instead — that
  // reason outranks the state, which the merchant can read off the Select.
  const stateHint = hintFor(kind, value, t);
  const hint = disabled ? disabledHint ?? stateHint : stateHint;
  if (!hint) return control;

  // A disabled control dispatches no pointer events, so a bare Tooltip around
  // it never opens — that is the whole reason DisabledActionTooltip exists.
  // An ENABLED one must NOT go through it: its wrapper sets
  // `pointer-events: none` on the child, which would make the Select unusable.
  return disabled ? (
    <DisabledActionTooltip hint={hint} zIndexOverride={TOOLTIP_Z_INDEX}>
      {control}
    </DisabledActionTooltip>
  ) : (
    // `activatorWrapper="div"`: the control IS a div, and Polaris' default
    // `span` wrapper would nest it in an inline element.
    <Tooltip
      content={hint}
      dismissOnMouseOut
      preferredPosition="above"
      zIndexOverride={TOOLTIP_Z_INDEX}
      activatorWrapper="div"
    >
      {control}
    </Tooltip>
  );
}

/** The sentence in the control's tooltip. Each state gets its OWN, because the
 *  whole point of the line is that "Active" and "visible" are not the same
 *  claim. */
function hintFor(kind: "status" | "published", value: string, t: ItemStatusSwitchTexts): string {
  if (kind === "published") {
    return (value === "false" ? t.unpublishedHint : t.publishedHint) ?? "";
  }
  switch ((value || "").toUpperCase()) {
    case "ACTIVE":   return t.activeHint ?? "";
    case "UNLISTED": return t.unlistedHint ?? "";
    case "ARCHIVED": return t.archivedHint ?? "";
    default:         return t.draftHint ?? "";
  }
}
