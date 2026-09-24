/**
 * Bulk editor — CSV import preview dialog (docs/plans/PLAN_BULK_EDITOR.md
 * §8.2 step 3): "X rows, Y cells change" plus the first 50 changes in clear
 * text (old → new), the reported unknown/ignored columns, the row-resolution
 * errors — and only the confirm button hands the diff to the normal save
 * pipeline. Nothing is written while this dialog is open.
 */

import { Modal, BlockStack, Text, Banner } from "@shopify/polaris";
import type {
  CsvImportDamagedCell,
  CsvImportPreview,
} from "../../services/bulk-editor/csv-import.server";
import type { CsvFileEncoding, CsvRowError } from "../../services/bulk-editor/csv.shared";

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
  rowErrorDuplicateRow: string; // {line} {value}
  target: string; // {target}
  encodingNotice: string;
  damagedTitle: string; // {count}
  damagedHint: string;
  damagedScientificNotation: string;
  damagedLeadingZerosLost: string;
  damagedCellLimitTruncated: string;
  moreRowErrors: string; // {count}
  changesHeading: string; // {count}
  moreChanges: string; // {count}
  emptyValue: string;
  overBudget: string; // {calls} {max}
  overCellLimit: string; // {cells} {max}
  apply: string;
  cancel: string;
}

interface CsvImportModalProps {
  open: boolean;
  preview: CsvImportPreview | null;
  /** Localized column heading (same resolver the grid uses). */
  columnLabel: (columnId: string) => string;
  /** The language/market layer the import writes into — the file itself
   * cannot be trusted to say, so the dialog does. */
  targetLabel: string;
  /** How the file was decoded; anything but UTF-8 is named. */
  encoding: CsvFileEncoding;
  /** True when the diff would blow the Shopify-call budget (Plan §10.1) —
   * the confirm button is disabled and the reason shown. */
  overBudget: boolean;
  maxCalls: number;
  /** True when the diff exceeds the per-save cell cap of the task path
   * (MAX_BULK_TASK_ITEMS, Finding 2) — same disable+reason treatment as the
   * call budget, BEFORE the server would 400 the confirmed import. */
  overCellLimit: boolean;
  maxCells: number;
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
          : error.kind === "ambiguousHandle"
            ? s.rowErrorAmbiguousHandle
            : s.rowErrorDuplicateRow;
  return template.replace("{line}", String(error.line)).replace("{value}", error.value);
}

function damageText(cell: CsvImportDamagedCell, s: CsvImportModalStrings): string {
  return cell.kind === "scientificNotation"
    ? s.damagedScientificNotation
    : cell.kind === "leadingZerosLost"
      ? s.damagedLeadingZerosLost
      : s.damagedCellLimitTruncated;
}

export function CsvImportModal({
  open,
  preview,
  columnLabel,
  targetLabel,
  encoding,
  overBudget,
  maxCalls,
  overCellLimit,
  maxCells,
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
  const shownDamaged = preview.damagedCells.slice(0, ROW_ERRORS_SHOWN);
  const hiddenDamagedCount = preview.damagedCells.length - shownDamaged.length;

  const display = (value: string): string => (value === "" ? s.emptyValue : clip(value));

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={s.title}
      primaryAction={{
        content: s.apply,
        onAction: onConfirm,
        disabled: !hasChanges || overBudget || overCellLimit || busy,
        loading: busy,
      }}
      secondaryActions={[{ content: s.cancel, onAction: onCancel, disabled: busy }]}
    >
      <Modal.Section>
        <BlockStack gap="300">
          <Text as="p" variant="bodyMd">
            {s.target.replace("{target}", targetLabel)}
          </Text>
          {encoding !== "utf8" && <Banner tone="warning">{s.encodingNotice}</Banner>}
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
          {overCellLimit && (
            <Banner tone="critical">
              {s.overCellLimit
                .replace("{cells}", String(preview.cellsChanged))
                .replace("{max}", String(maxCells))}
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

          {preview.damagedCells.length > 0 && (
            <Banner
              tone="warning"
              title={s.damagedTitle.replace("{count}", String(preview.damagedCells.length))}
            >
              <BlockStack gap="100">
                <Text as="p" variant="bodySm">
                  {s.damagedHint}
                </Text>
                {shownDamaged.map((cell, i) => (
                  <Text as="p" variant="bodySm" key={`${cell.rowId}-${cell.columnId}-${i}`}>
                    <strong>{clip(cell.rowLabel)}</strong> · {columnLabel(cell.columnId)}:{" "}
                    {display(cell.oldValue)} → {display(cell.newValue)} ({damageText(cell, s)})
                  </Text>
                ))}
                {hiddenDamagedCount > 0 && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {s.moreRowErrors.replace("{count}", String(hiddenDamagedCount))}
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
