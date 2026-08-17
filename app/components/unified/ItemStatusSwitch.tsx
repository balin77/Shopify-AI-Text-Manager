/**
 * The "is this item visible in the shop?" switch, in the editor's action bar.
 *
 * It sits next to Translate All rather than among the fields because it is the
 * question merchants open the editor to answer, and because Delete and
 * Duplicate now live there too: one row for what happens to the ITEM, the
 * fields below for what it SAYS.
 *
 * ── Why it is not just a checkbox ───────────────────────────────────────────
 * Three things make this control less trivial than it looks, and each of them
 * is a way the naive version lies to the merchant:
 *
 *   1. A product has FOUR statuses, not two. UNLISTED (reachable by direct
 *      link, hidden from listings) and ARCHIVED are real states in real
 *      catalogues. A two-state switch would render both as "not active" and
 *      then, on the first click, overwrite them — so the switch LOCKS on
 *      those two and names the state instead.
 *   2. `isPublished` defaults to TRUE in the schema on a row an older sync
 *      wrote, so on an un-synced item it is not data. `known` is the
 *      discriminator: unknown renders as unknown and offers a reload, never as
 *      a confident "visible".
 *   3. ACTIVE is not the same as VISIBLE. A product on no sales channel is
 *      invisible everywhere and Shopify's own admin does not say so on the
 *      product page either — which is why the hint under "Active" mentions the
 *      channel rather than promising a live page.
 *
 * The switch writes through the SAME value map as the field it replaced, so
 * the change lands in the ordinary save (and the ordinary save bar) rather
 * than firing a write of its own.
 */

import { Badge, Button, InlineStack, Text, Tooltip } from "@shopify/polaris";

/** The four values Shopify's ProductStatus can hold. */
const TOGGLEABLE_STATUSES = new Set(["ACTIVE", "DRAFT"]);

export interface ItemStatusSwitchTexts {
  active?: string;
  activeHint?: string;
  draftHint?: string;
  published?: string;
  publishedHint?: string;
  unpublishedHint?: string;
  unknown?: string;
  archivedHint?: string;
  reload?: string;
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
  onReload?: () => void;
  /** Reason the control is disabled, shown as a tooltip. */
  disabledHint?: string;
  t: ItemStatusSwitchTexts;
}

export function ItemStatusSwitch({
  kind,
  value,
  onChange,
  disabled,
  known = true,
  onReload,
  disabledHint,
  t,
}: ItemStatusSwitchProps) {
  // Unknown is its own state. Rendering the schema default as an answer is the
  // trap `attributesSyncedAt` exists to close, and here it would show a hidden
  // page as visible.
  if (!known) {
    return (
      <InlineStack gap="200" blockAlign="center">
        <Badge tone="attention">{t.unknown || "Status not loaded"}</Badge>
        {onReload && (
          <Button size="slim" onClick={onReload}>
            {t.reload || "Reload"}
          </Button>
        )}
      </InlineStack>
    );
  }

  if (kind === "status") {
    const status = (value || "").toUpperCase();
    // UNLISTED / ARCHIVED: shown, named, and NOT toggled. A switch that turned
    // an unlisted product into a draft on one click would be a data loss the
    // merchant never asked for.
    if (!TOGGLEABLE_STATUSES.has(status)) {
      return (
        <Tooltip content={t.archivedHint || "Change this in the Shopify admin."}>
          <Badge tone="info">{status || "—"}</Badge>
        </Tooltip>
      );
    }
    const isActive = status === "ACTIVE";
    return (
      <Switch
        label={t.active || "Active"}
        hint={isActive ? t.activeHint : t.draftHint}
        checked={isActive}
        disabled={disabled}
        disabledHint={disabledHint}
        onChange={(next) => onChange(next ? "ACTIVE" : "DRAFT")}
      />
    );
  }

  // `isPublished` is stored as a string in the editor's flat value map, and
  // anything other than an explicit "false" reads as true — the same rule the
  // attribute field applied, because the column defaults to true on both sides.
  const isPublished = value !== "false";
  return (
    <Switch
      label={t.published || "Visible"}
      hint={isPublished ? t.publishedHint : t.unpublishedHint}
      checked={isPublished}
      disabled={disabled}
      disabledHint={disabledHint}
      onChange={(next) => onChange(next ? "true" : "false")}
    />
  );
}

/**
 * Polaris has no inline switch that reads well in a button row, so this is a
 * pressed-state Button plus the state in words.
 *
 * A pressed Button rather than a Checkbox on purpose: the row it lives in is a
 * row of buttons, and a lone checkbox among them reads as a setting for the
 * buttons rather than a state of the item. The hint carries the meaning —
 * "Active" alone is exactly the word merchants over-read.
 */
function Switch({
  label,
  hint,
  checked,
  disabled,
  disabledHint,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  disabledHint?: string;
  onChange: (next: boolean) => void;
}) {
  const button = (
    <Button
      size="slim"
      pressed={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      accessibilityLabel={label}
    >
      {label}
    </Button>
  );
  return (
    <InlineStack gap="200" blockAlign="center">
      {/* A disabled control dispatches no pointer events, so the tooltip has to
          wrap something that does — the same reason DisabledActionTooltip
          exists for the AI actions. */}
      {disabled && disabledHint ? (
        <Tooltip content={disabledHint}>
          <span>{button}</span>
        </Tooltip>
      ) : (
        button
      )}
      {hint && (
        <Text as="span" variant="bodySm" tone="subdued">
          {hint}
        </Text>
      )}
    </InlineStack>
  );
}
