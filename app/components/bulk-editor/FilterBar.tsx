/**
 * Bulk editor — toolbar row under the type selector (docs/plans/
 * PLAN_BULK_EDITOR.md §2/§3.3): server-side search (title + handle),
 * multi-select filters, page-size picker and the client-side "only changed"
 * toggle. All server-backed state lives in the URL — this component only
 * raises intents; the route navigates.
 */

import { useEffect, useState } from "react";
import { Button, ChoiceList, InlineStack, Popover, Select, TextField } from "@shopify/polaris";
import {
  BULK_PAGE_SIZES,
  FILTER_IDS_BY_SET,
  type BulkFilterId,
  type BulkFilterSet,
} from "../../services/bulk-editor/columns.shared";

/** Synthetic ChoiceList value for the client-side "only changed" toggle —
 * kept out of BulkFilterId (which is the server-filter vocabulary). */
const CHANGED_FILTER_ID = "__changed";

interface FilterBarProps {
  search: string;
  onSearchCommit: (value: string) => void;
  filters: BulkFilterId[];
  onFiltersChange: (filters: BulkFilterId[]) => void;
  /** The missingTranslation filter needs a concrete locale — hidden until the
   * locale selector lands (Phase 4) unless the URL already carries one. */
  showTranslationFilter: boolean;
  /** Which filter vocabulary the type speaks (Phase 3/5) — the id source is
   * the shared FILTER_IDS_BY_SET (columns.shared.ts), which the route also
   * uses to prune stale filter ids on a type switch (Finding 13). */
  filterSet: BulkFilterSet;
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
    filterMissingAltText: string;
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

  const filterLabels: Record<BulkFilterId, string> = {
    missingSeoTitle: strings.filterMissingSeoTitle,
    missingSeoDescription: strings.filterMissingSeoDescription,
    missingTranslation: strings.filterMissingTranslation,
    missingSku: strings.filterMissingSku,
    missingPrice: strings.filterMissingPrice,
    compareAtNotAbovePrice: strings.filterCompareAtNotAbovePrice,
    missingAltText: strings.filterMissingAltText,
  };
  // ONE id source per set (FILTER_IDS_BY_SET, Finding 13); the translation
  // filter additionally needs a selected foreign locale to mean anything.
  const serverChoices = FILTER_IDS_BY_SET[filterSet]
    .filter((id) => id !== "missingTranslation" || showTranslationFilter)
    .map((id) => ({ label: filterLabels[id], value: id }));
  // "Nur geänderte" lives in the SAME popover as the server filters (one place
  // for every filter), but it stays a CLIENT toggle — it filters the loaded
  // page, never navigates. It is universally applicable, so the popover shows
  // even for types with no server filters (policy/metaobject primary).
  const filterChoices = [
    { label: strings.onlyChangedLabel, value: CHANGED_FILTER_ID },
    ...serverChoices,
  ];
  const selectedFilterValues = [...(onlyChanged ? [CHANGED_FILTER_ID] : []), ...filters];
  const activeCount = filters.length + (onlyChanged ? 1 : 0);

  const filterButtonLabel =
    activeCount > 0 ? `${strings.filtersLabel} (${activeCount})` : strings.filtersLabel;
  const showFilterButton = true;

  // Split one ChoiceList change back into its client + server halves, and only
  // fire each handler when ITS half actually changed — toggling "nur geänderte"
  // must not re-navigate/reset the page, and vice versa.
  const handleChoiceChange = (selected: string[]) => {
    const wantChanged = selected.includes(CHANGED_FILTER_ID);
    if (wantChanged !== onlyChanged) onOnlyChangedChange(wantChanged);
    const nextServer = selected.filter((id) => id !== CHANGED_FILTER_ID) as BulkFilterId[];
    const serverChanged =
      nextServer.length !== filters.length || nextServer.some((id) => !filters.includes(id));
    if (serverChanged) onFiltersChange(nextServer);
  };

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
            <Button disclosure pressed={activeCount > 0} onClick={() => setPopoverActive((v) => !v)}>
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
              selected={selectedFilterValues}
              onChange={handleChoiceChange}
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
    </InlineStack>
  );
}
