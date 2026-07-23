/**
 * Bulk editor — toolbar row under the type selector (docs/plans/
 * PLAN_BULK_EDITOR.md §2/§3.3): server-side search (title + handle),
 * multi-select filters, page-size picker and the client-side "only changed"
 * toggle. All server-backed state lives in the URL — this component only
 * raises intents; the route navigates.
 */

import { useEffect, useState } from "react";
import { Button, Checkbox, ChoiceList, InlineStack, Popover, Select, TextField } from "@shopify/polaris";
import {
  BULK_PAGE_SIZES,
  type BulkFilterId,
} from "../../services/bulk-editor/columns.shared";

interface FilterBarProps {
  search: string;
  onSearchCommit: (value: string) => void;
  filters: BulkFilterId[];
  onFiltersChange: (filters: BulkFilterId[]) => void;
  /** The missingTranslation filter needs a concrete locale — hidden until the
   * locale selector lands (Phase 4) unless the URL already carries one. */
  showTranslationFilter: boolean;
  /** Which filter vocabulary the type speaks (Phase 3/5): "content" = SEO +
   * translation filters; "variant" = the price/SKU data filters;
   * "translationOnly" = policy/metaobject rows, which have no SEO columns. */
  filterSet: "content" | "variant" | "translationOnly";
  pageSize: number;
  onPageSizeChange: (size: number) => void;
  onlyChanged: boolean;
  onOnlyChangedChange: (value: boolean) => void;
  strings: {
    searchPlaceholder: string;
    searchLabel: string;
    filtersLabel: string;
    filterMissingSeoTitle: string;
    filterMissingSeoDescription: string;
    filterMissingTranslation: string;
    filterMissingSku: string;
    filterMissingPrice: string;
    filterCompareAtNotAbovePrice: string;
    pageSizeLabel: string;
    onlyChangedLabel: string;
  };
}

export function FilterBar({
  search,
  onSearchCommit,
  filters,
  onFiltersChange,
  showTranslationFilter,
  filterSet,
  pageSize,
  onPageSizeChange,
  onlyChanged,
  onOnlyChangedChange,
  strings,
}: FilterBarProps) {
  const [popoverActive, setPopoverActive] = useState(false);
  // Local draft so typing doesn't navigate per keystroke; committed after a
  // short debounce (server-side search, §3.3) and re-synced when the URL
  // changes from elsewhere (pagination reset, type switch).
  const [draft, setDraft] = useState(search);
  useEffect(() => setDraft(search), [search]);
  useEffect(() => {
    if (draft === search) return;
    const timer = setTimeout(() => onSearchCommit(draft), 400);
    return () => clearTimeout(timer);
    // Only re-arm on draft changes — search/onSearchCommit identity churn
    // must not re-trigger a commit of an unchanged draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const translationChoice = showTranslationFilter
    ? [{ label: strings.filterMissingTranslation, value: "missingTranslation" }]
    : [];
  const filterChoices =
    filterSet === "variant"
      ? [
          { label: strings.filterMissingSku, value: "missingSku" },
          { label: strings.filterMissingPrice, value: "missingPrice" },
          { label: strings.filterCompareAtNotAbovePrice, value: "compareAtNotAbovePrice" },
        ]
      : filterSet === "translationOnly"
        ? translationChoice
        : [
            { label: strings.filterMissingSeoTitle, value: "missingSeoTitle" },
            { label: strings.filterMissingSeoDescription, value: "missingSeoDescription" },
            ...translationChoice,
          ];

  const filterButtonLabel =
    filters.length > 0 ? `${strings.filtersLabel} (${filters.length})` : strings.filtersLabel;
  // Policy/metaobject rows in the primary language have no applicable filters
  // at all — hide the empty popover button instead of showing a dead control.
  const showFilterButton = filterChoices.length > 0;

  return (
    <InlineStack gap="200" blockAlign="end" wrap>
      <div style={{ minWidth: "220px", flex: "1 1 220px", maxWidth: "360px" }}>
        <TextField
          label={strings.searchLabel}
          labelHidden
          placeholder={strings.searchPlaceholder}
          value={draft}
          onChange={setDraft}
          clearButton
          onClearButtonClick={() => setDraft("")}
          autoComplete="off"
        />
      </div>
      {showFilterButton && (
        <Popover
          active={popoverActive}
          onClose={() => setPopoverActive(false)}
          activator={
            <Button disclosure pressed={filters.length > 0} onClick={() => setPopoverActive((v) => !v)}>
              {filterButtonLabel}
            </Button>
          }
        >
          <div style={{ padding: "12px 16px" }}>
            <ChoiceList
              allowMultiple
              title={strings.filtersLabel}
              titleHidden
              choices={filterChoices}
              selected={filters}
              onChange={(selected) => onFiltersChange(selected as BulkFilterId[])}
            />
          </div>
        </Popover>
      )}
      <div style={{ width: "110px" }}>
        <Select
          label={strings.pageSizeLabel}
          labelHidden
          options={BULK_PAGE_SIZES.map((s) => ({ label: `${s}`, value: String(s) }))}
          value={String(pageSize)}
          onChange={(v) => onPageSizeChange(parseInt(v, 10))}
        />
      </div>
      <Checkbox label={strings.onlyChangedLabel} checked={onlyChanged} onChange={onOnlyChangedChange} />
    </InlineStack>
  );
}
