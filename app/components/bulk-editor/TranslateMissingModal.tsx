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
  /** Phase 4b: the grid's selected market (name + the locale it is bound to),
   * or null when the grid is global. The AI translation writes market-specific
   * values only when the chosen target locale matches that market's locale. */
  market: { name: string; locale: string } | null;
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
    /** Shown when the run writes GLOBAL (all-markets) translations. */
    marketHintGlobal: string;
    /** Shown when the run writes for a specific market; "{market}" is filled. */
    marketHintMarket: string;
  };
}

export function TranslateMissingModal({
  open,
  onClose,
  columns,
  columnLabel,
  locales,
  defaultLocale,
  market,
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

  // Market-specific writes happen only when the chosen target locale is the
  // one the grid's market is bound to; otherwise the run is global.
  const marketApplies = !!market && targetLocale === market.locale;

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
          {/* Phase 4b: the AI path is market-aware — it writes for the grid's
              market when the target locale matches it, otherwise globally. */}
          <Banner tone="info">
            {marketApplies
              ? strings.marketHintMarket.replace("{market}", market!.name)
              : strings.marketHintGlobal}
          </Banner>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
