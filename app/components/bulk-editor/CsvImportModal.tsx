/**
 * Bulk editor — CSV import preview dialog (docs/plans/PLAN_BULK_EDITOR.md
 * §8.2 step 3): "X rows, Y cells change" plus the first 50 changes in clear
 * text (old → new), the reported unknown/ignored columns, the row-resolution
 * errors — and only the confirm button hands the diff to the normal save
 * pipeline. Nothing is written while this dialog is open.
 */

import { Modal, BlockStack, Text, Banner } from "@shopify/polaris";
import type { CsvImportPreview } from "../../services/bulk-editor/csv-import.server";
import type { CsvRowError } from "../../services/bulk-editor/csv.shared";

/** Cell values in the preview list are clipped — a 5.000-character body diff
 * must not blow up the dialog. */
const PREVIEW_VALUE_MAX = 80;
/** Row errors listed verbatim before collapsing into a "+N more" line. */
const ROW_ERRORS_SHOWN = 10;

function clip(value: string): string {
  return value.length > PREVIEW_VALUE_MAX ? `${value.slice(0, PREVIEW_VALUE_MAX)}…` : value;
}

export interface CsvImportModalStrings {
  title: string;
  summary: string; // {rows} {cells}
  noChanges: string;
  clearHint: string;
  unknownColumns: string;
  ignoredColumns: string;
  rowErrorsTitle: string; // {count}
  rowErrorMissingId: string; // {line}
  rowErrorUnknownId: string; // {line} {value}
  rowErrorUnknownHandle: string; // {line} {value}
  rowErrorAmbiguousHandle: string; // {line} {value}
  moreRowErrors: string; // {count}
  changesHeading: string; // {count}
  moreChanges: string; // {count}
  emptyValue: string;
  overBudget: string; // {calls} {max}
  apply: string;
  cancel: string;
}

interface CsvImportModalProps {
  open: boolean;
  preview: CsvImportPreview | null;
  /** Localized column heading (same resolver the grid uses). */
  columnLabel: (columnId: string) => string;
  /** True when the diff would blow the Shopify-call budget (Plan §10.1) —
   * the confirm button is disabled and the reason shown. */
  overBudget: boolean;
  maxCalls: number;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  strings: CsvImportModalStrings;
}

function rowErrorText(error: CsvRowError, s: CsvImportModalStrings): string {
  const template =
    error.kind === "missingId"
      ? s.rowErrorMissingId
      : error.kind === "unknownId"
        ? s.rowErrorUnknownId
        : error.kind === "unknownHandle"
          ? s.rowErrorUnknownHandle
          : s.rowErrorAmbiguousHandle;
  return template.replace("{line}", String(error.line)).replace("{value}", error.value);
}

export function CsvImportModal({
  open,
  preview,
  columnLabel,
  overBudget,
  maxCalls,
  busy,
  onConfirm,
  onCancel,
  strings: s,
}: CsvImportModalProps) {
  if (!preview) return null;
  const hasChanges = preview.cellsChanged > 0;
  const shownErrors = preview.rowErrors.slice(0, ROW_ERRORS_SHOWN);
  const hiddenErrorCount = preview.rowErrors.length - shownErrors.length;
  const hiddenChangeCount = preview.cellsChanged - preview.changes.length;

  const display = (value: string): string => (value === "" ? s.emptyValue : clip(value));

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={s.title}
      primaryAction={{
        content: s.apply,
        onAction: onConfirm,
        disabled: !hasChanges || overBudget || busy,
        loading: busy,
      }}
      secondaryActions={[{ content: s.cancel, onAction: onCancel, disabled: busy }]}
    >
      <Modal.Section>
        <BlockStack gap="300">
          {hasChanges ? (
            <Text as="p" variant="bodyMd" fontWeight="semibold">
              {s.summary
                .replace("{rows}", String(preview.rowsChanged))
                .replace("{cells}", String(preview.cellsChanged))}
            </Text>
          ) : (
            <Text as="p" variant="bodyMd">
              {s.noChanges}
            </Text>
          )}
          {hasChanges && (
            <Text as="p" variant="bodySm" tone="subdued">
              {s.clearHint}
            </Text>
          )}

          {overBudget && (
            <Banner tone="critical">
              {s.overBudget
                .replace("{calls}", String(preview.estimatedCalls))
                .replace("{max}", String(maxCalls))}
            </Banner>
          )}

          {preview.unknownColumns.length > 0 && (
            <Banner tone="warning">
              {s.unknownColumns} {preview.unknownColumns.join(", ")}
            </Banner>
          )}
          {preview.ignoredColumns.length > 0 && (
            <Banner tone="info">
              {s.ignoredColumns} {preview.ignoredColumns.join(", ")}
            </Banner>
          )}
          {preview.rowErrors.length > 0 && (
            <Banner tone="warning" title={s.rowErrorsTitle.replace("{count}", String(preview.rowErrors.length))}>
              <BlockStack gap="100">
                {shownErrors.map((error, i) => (
                  <Text as="p" variant="bodySm" key={`${error.line}-${i}`}>
                    {rowErrorText(error, s)}
                  </Text>
                ))}
                {hiddenErrorCount > 0 && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {s.moreRowErrors.replace("{count}", String(hiddenErrorCount))}
                  </Text>
                )}
              </BlockStack>
            </Banner>
          )}

          {preview.changes.length > 0 && (
            <BlockStack gap="150">
              <Text as="h3" variant="headingSm">
                {s.changesHeading.replace("{count}", String(preview.changes.length))}
              </Text>
              <div style={{ maxHeight: 320, overflowY: "auto" }}>
                <BlockStack gap="100">
                  {preview.changes.map((change, i) => (
                    <div key={`${change.rowId}-${change.columnId}-${i}`}>
                      <Text as="p" variant="bodySm">
                        <strong>{clip(change.rowLabel)}</strong> · {columnLabel(change.columnId)}
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {display(change.oldValue)} → {display(change.newValue)}
                      </Text>
                    </div>
                  ))}
                </BlockStack>
              </div>
              {hiddenChangeCount > 0 && (
                <Text as="p" variant="bodySm" tone="subdued">
                  {s.moreChanges.replace("{count}", String(hiddenChangeCount))}
                </Text>
              )}
            </BlockStack>
          )}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
