/**
 * Bulk editor — "Translate missing" modal (Plan §6.5): column + target
 * language + result mode (preview vs. translate-and-save). The actual work
 * runs as the detached `bulkEditorTranslate` task; this component only
 * collects the choice and raises `onStart`.
 */

import { useEffect, useState } from "react";
import { Modal, BlockStack, Select, ChoiceList, Text, Banner } from "@shopify/polaris";
import type { ColumnDescriptor } from "../../services/bulk-editor/columns.shared";

export type TranslateMissingMode = "preview" | "save";

interface TranslateMissingModalProps {
  open: boolean;
  onClose: () => void;
  /** AI-translatable columns of the current type (field columns only —
   * handle is deliberately excluded, see the route). */
  columns: ColumnDescriptor[];
  columnLabel: (column: ColumnDescriptor) => string;
  /** Published foreign locales. */
  locales: { locale: string; name: string }[];
  /** Preselected target — the grid's current foreign locale, if any. */
  defaultLocale: string;
  busy: boolean;
  onStart: (choice: { columnId: string; targetLocale: string; mode: TranslateMissingMode }) => void;
  strings: {
    title: string;
    intro: string;
    columnLabel: string;
    targetLocaleLabel: string;
    modeLabel: string;
    modePreview: string;
    modeSave: string;
    start: string;
    cancel: string;
    marketHint: string;
  };
}

export function TranslateMissingModal({
  open,
  onClose,
  columns,
  columnLabel,
  locales,
  defaultLocale,
  busy,
  onStart,
  strings,
}: TranslateMissingModalProps) {
  const [columnId, setColumnId] = useState<string>(columns[0]?.id ?? "");
  const [targetLocale, setTargetLocale] = useState<string>(defaultLocale || locales[0]?.locale || "");
  // Preview is the DEFAULT (Plan §6.5) — writing unreviewed AI text over 250
  // rows is the more expensive mistake.
  const [mode, setMode] = useState<TranslateMissingMode>("preview");

  // Re-seed the selection whenever the modal (re)opens for a possibly
  // different type/locale.
  useEffect(() => {
    if (!open) return;
    setColumnId((prev) => (columns.some((c) => c.id === prev) ? prev : columns[0]?.id ?? ""));
    setTargetLocale(defaultLocale || locales[0]?.locale || "");
    setMode("preview");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const canStart = !!columnId && !!targetLocale && !busy;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={strings.title}
      primaryAction={{
        content: strings.start,
        onAction: () => onStart({ columnId, targetLocale, mode }),
        disabled: !canStart,
        loading: busy,
      }}
      secondaryActions={[{ content: strings.cancel, onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          <Text as="p" variant="bodyMd">
            {strings.intro}
          </Text>
          <Select
            label={strings.columnLabel}
            options={columns.map((c) => ({ label: columnLabel(c), value: c.id }))}
            value={columnId}
            onChange={setColumnId}
          />
          <Select
            label={strings.targetLocaleLabel}
            options={locales.map((l) => ({ label: l.name, value: l.locale }))}
            value={targetLocale}
            onChange={setTargetLocale}
          />
          <ChoiceList
            title={strings.modeLabel}
            choices={[
              { label: strings.modePreview, value: "preview" },
              { label: strings.modeSave, value: "save" },
            ]}
            selected={[mode]}
            onChange={(selected) => setMode((selected[0] as TranslateMissingMode) ?? "preview")}
          />
          {/* §6.6: the AI path is GLOBAL-only — market-specific values stay a
              manual-typing feature until Phase 4b. */}
          <Banner tone="info">{strings.marketHint}</Banner>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
