/**
 * Bulk editor — price bulk actions (docs/plans/PLAN_BULK_EDITOR.md §5.6).
 *
 * Toolbar popover for the variant grid: price ± X % / ± X absolute / set to
 * X, compareAtPrice = current price, and rounding to ,00/,90/,95. The
 * actions NEVER write directly — the route fills the edit map with the
 * results, so the merchant previews them as ordinary dirty cells, can
 * correct, and saves through the normal diff pipeline (estimation, cell
 * errors and the task path all apply unchanged).
 */

import { useState } from "react";
import { BlockStack, Button, InlineStack, Popover, Select, TextField } from "@shopify/polaris";
import type { PriceAction, PriceActionId } from "../../services/bulk-editor/columns.shared";

export interface PriceActionsStrings {
  button: string;
  actionLabel: string;
  amountLabel: string;
  apply: string;
  actions: Record<PriceActionId, string>;
}

interface PriceActionsPopoverProps {
  disabled: boolean;
  strings: PriceActionsStrings;
  onApply: (action: PriceAction) => void;
}

const ACTION_ORDER: PriceActionId[] = [
  "percent",
  "absolute",
  "set",
  "compareAtFromPrice",
  "round00",
  "round90",
  "round95",
];

/** Actions that take a numeric amount. */
const NEEDS_AMOUNT = new Set<PriceActionId>(["percent", "absolute", "set"]);

export function PriceActionsPopover({ disabled, strings, onApply }: PriceActionsPopoverProps) {
  const [open, setOpen] = useState(false);
  const [actionId, setActionId] = useState<PriceActionId>("percent");
  const [amountDraft, setAmountDraft] = useState("");

  const needsAmount = NEEDS_AMOUNT.has(actionId);
  // Amount input: tolerate a decimal comma (German/Spanish keyboards).
  const amount = Number(amountDraft.trim().replace(",", "."));
  const amountValid =
    !needsAmount || (amountDraft.trim() !== "" && Number.isFinite(amount) && (actionId !== "set" || amount >= 0));

  const handleApply = () => {
    onApply({ id: actionId, ...(needsAmount ? { amount } : {}) });
    setOpen(false);
  };

  return (
    <Popover
      active={open}
      onClose={() => setOpen(false)}
      activator={
        <Button disclosure disabled={disabled} onClick={() => setOpen((v) => !v)}>
          {strings.button}
        </Button>
      }
    >
      <div style={{ padding: "12px 16px", minWidth: "260px" }}>
        <BlockStack gap="200">
          <Select
            label={strings.actionLabel}
            options={ACTION_ORDER.map((id) => ({ label: strings.actions[id], value: id }))}
            value={actionId}
            onChange={(v) => setActionId(v as PriceActionId)}
          />
          {needsAmount && (
            <TextField
              label={strings.amountLabel}
              value={amountDraft}
              onChange={setAmountDraft}
              autoComplete="off"
              inputMode="decimal"
            />
          )}
          <InlineStack align="end">
            <Button variant="primary" disabled={!amountValid} onClick={handleApply}>
              {strings.apply}
            </Button>
          </InlineStack>
        </BlockStack>
      </div>
    </Popover>
  );
}
