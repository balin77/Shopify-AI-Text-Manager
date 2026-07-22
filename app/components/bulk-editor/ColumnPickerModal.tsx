/**
 * Bulk editor — column picker modal (docs/plans/PLAN_BULK_EDITOR.md §2/§10.2).
 *
 * Lets the merchant choose which columns render, persisted per type by the
 * route. Enforces MAX_VISIBLE_COLUMNS (20): once the limit is reached, every
 * unchecked column is disabled and a hint explains why — the 21st column is
 * refused instead of silently degrading the grid.
 */

import { BlockStack, Banner, Checkbox, Modal, Text } from "@shopify/polaris";
import {
  MAX_VISIBLE_COLUMNS,
  type ColumnDescriptor,
} from "../../services/bulk-editor/columns.shared";

interface ColumnPickerModalProps {
  open: boolean;
  onClose: () => void;
  /** All columns of the current type, canonical order. The image column is
   * not toggleable (it is the row's editor affordance) and is excluded. */
  allColumns: ColumnDescriptor[];
  visibleColumnIds: string[];
  onToggle: (columnId: string) => void;
  onReset: () => void;
  columnLabel: (column: ColumnDescriptor) => string;
  strings: {
    title: string;
    intro: string;
    done: string;
    reset: string;
    /** Shown when MAX_VISIBLE_COLUMNS is reached; {max} placeholder. */
    limitHint: string;
  };
}

export function ColumnPickerModal({
  open,
  onClose,
  allColumns,
  visibleColumnIds,
  onToggle,
  onReset,
  columnLabel,
  strings,
}: ColumnPickerModalProps) {
  const visible = new Set(visibleColumnIds);
  // The forced image column counts against the browser-load budget too.
  const visibleCount = visibleColumnIds.length;
  const atLimit = visibleCount >= MAX_VISIBLE_COLUMNS;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={strings.title}
      primaryAction={{ content: strings.done, onAction: onClose }}
      secondaryActions={[{ content: strings.reset, onAction: onReset }]}
    >
      <Modal.Section>
        <BlockStack gap="200">
          <Text as="p" tone="subdued">
            {strings.intro}
          </Text>
          {atLimit && (
            <Banner tone="warning">
              {strings.limitHint.replace("{max}", String(MAX_VISIBLE_COLUMNS))}
            </Banner>
          )}
          <BlockStack gap="100">
            {/* Image column is always the leftmost edit affordance (thumbnail
                + hover overlay to open the editor), so it's not toggleable —
                otherwise pages would lose their editor hook. */}
            {allColumns
              .filter((c) => c.id !== "image")
              .map((col) => {
                const checked = visible.has(col.id);
                return (
                  <Checkbox
                    key={col.id}
                    label={columnLabel(col)}
                    checked={checked}
                    // Refuse the (MAX+1)th column: unchecked boxes lock once
                    // the limit is reached (§10.2).
                    disabled={!checked && atLimit}
                    onChange={() => onToggle(col.id)}
                  />
                );
              })}
          </BlockStack>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
