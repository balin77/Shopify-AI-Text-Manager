/**
 * Bulk editor — the candidate tree of the "translate missing" page.
 *
 * One expandable row per item (product, collection, …) with a checkbox, and
 * under it one checkbox per MISSING field with the languages it is missing in.
 * Ticking the item ticks every field below it (setItemSelected) — the parent
 * state is always DERIVED from its children, never stored, so the two can't
 * drift apart.
 *
 * Presentation only: the selection lives in the page (URL-independent client
 * state), the pagination in the URL.
 */

import { useState } from "react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Checkbox,
  Divider,
  InlineStack,
  Text,
  Tooltip,
} from "@shopify/polaris";
import { ChevronDownIcon, ChevronRightIcon } from "@shopify/polaris-icons";
import {
  isPairSelected,
  itemSelectionState,
  type MissingItem,
  type TranslateSelection,
  type TriState,
} from "../../services/bulk-editor/translate-missing.shared";

export interface MissingTranslationListProps {
  items: MissingItem[];
  /** Languages currently switched on — fields missing only in switched-off
   * languages are hidden (they would not be part of the run). */
  activeLocales: string[];
  selection: TranslateSelection;
  headerState: TriState;
  onToggleAll: (selected: boolean) => void;
  onToggleItem: (item: MissingItem, selected: boolean) => void;
  onTogglePair: (rowId: string, columnId: string, selected: boolean) => void;
  columnLabel: (columnId: string) => string;
  localeLabel: (locale: string) => string;
  /** Columns that get a warning marker (URL handles change storefront URLs). */
  warnColumnIds: string[];
  strings: {
    selectAll: string;
    itemSummary: string;
    warnHandle: string;
    expand: string;
    collapse: string;
  };
}

export function MissingTranslationList({
  items,
  activeLocales,
  selection,
  headerState,
  onToggleAll,
  onToggleItem,
  onTogglePair,
  columnLabel,
  localeLabel,
  warnColumnIds,
  strings,
}: MissingTranslationListProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpanded = (rowId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  };

  return (
    <BlockStack gap="200">
      <Box paddingBlockEnd="100">
        <Checkbox
          label={strings.selectAll}
          checked={headerState === "indeterminate" ? "indeterminate" : headerState === "checked"}
          onChange={(checked) => onToggleAll(checked)}
        />
      </Box>
      <Divider />
      {items.map((item) => {
        // Fields whose missing languages are all switched off don't belong to
        // this run — hiding them keeps the counts and the tree consistent.
        const columns = item.columns.filter((c) => c.locales.some((l) => activeLocales.includes(l)));
        if (columns.length === 0) return null;
        const state = itemSelectionState(selection, item, activeLocales);
        const isOpen = expanded.has(item.rowId);
        const units = columns.reduce(
          (sum, c) => sum + c.locales.filter((l) => activeLocales.includes(l)).length,
          0,
        );

        return (
          <Box key={item.rowId} paddingBlockEnd="100">
            <BlockStack gap="100">
              <InlineStack gap="200" blockAlign="center" wrap={false}>
                <Checkbox
                  label={item.title}
                  labelHidden
                  checked={state === "indeterminate" ? "indeterminate" : state === "checked"}
                  onChange={(checked) => onToggleItem(item, checked)}
                />
                <Button
                  variant="tertiary"
                  icon={isOpen ? ChevronDownIcon : ChevronRightIcon}
                  accessibilityLabel={isOpen ? strings.collapse : strings.expand}
                  onClick={() => toggleExpanded(item.rowId)}
                />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <Text as="span" variant="bodyMd" truncate>
                    {item.title}
                  </Text>
                  {item.subtitle && (
                    <Text as="p" variant="bodySm" tone="subdued" truncate>
                      {item.subtitle}
                    </Text>
                  )}
                </div>
                <Text as="span" variant="bodySm" tone="subdued">
                  {strings.itemSummary
                    .replace("{fields}", String(columns.length))
                    .replace("{units}", String(units))}
                </Text>
              </InlineStack>

              {isOpen && (
                <Box paddingInlineStart="800">
                  <BlockStack gap="100">
                    {columns.map((column) => {
                      const locales = column.locales.filter((l) => activeLocales.includes(l));
                      const label = columnLabel(column.columnId);
                      const warn = warnColumnIds.includes(column.columnId);
                      return (
                        <InlineStack key={column.columnId} gap="200" blockAlign="center" wrap>
                          <Checkbox
                            label={label}
                            checked={isPairSelected(selection, item.rowId, column.columnId)}
                            onChange={(checked) => onTogglePair(item.rowId, column.columnId, checked)}
                          />
                          {warn && (
                            <Tooltip content={strings.warnHandle} dismissOnMouseOut>
                              <Text as="span" variant="bodySm" tone="caution">
                                ⚠
                              </Text>
                            </Tooltip>
                          )}
                          {locales.map((locale) => (
                            <Badge key={locale}>{localeLabel(locale)}</Badge>
                          ))}
                        </InlineStack>
                      );
                    })}
                  </BlockStack>
                </Box>
              )}
            </BlockStack>
          </Box>
        );
      })}
    </BlockStack>
  );
}
