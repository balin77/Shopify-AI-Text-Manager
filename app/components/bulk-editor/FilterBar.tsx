/**
 * Bulk editor — toolbar row under the type selector (docs/plans/
 * PLAN_BULK_EDITOR.md §2/§3.3): server-side search (title + handle),
 * multi-select filters, page-size picker and the client-side "only changed"
 * toggle. All server-backed state lives in the URL — this component only
 * raises intents; the route navigates.
 */

import { useEffect, useState } from "react";
import { BlockStack, Button, ChoiceList, InlineStack, Popover, Select, Text, TextField } from "@shopify/polaris";
import {
  ATTRIBUTE_GATED_FILTER_IDS,
  BULK_PAGE_SIZES,
  COLLECTION_KIND_FILTER_IDS,
  STATUS_FILTER_IDS,
  VISIBILITY_FILTER_IDS,
  type BulkFilterId,
} from "../../services/bulk-editor/columns.shared";

/** Synthetic ChoiceList value for the client-side "only changed" toggle —
 * kept out of BulkFilterId (which is the server-filter vocabulary). */
const CHANGED_FILTER_ID = "__changed";

/** The popover's sections, in render order. `ids: null` = "every offered id
 * no other section claims" (the independent flags). */
type FilterSectionKey = "status" | "visibility" | "collectionKind" | "general";
const GROUPED_SECTIONS: { key: Exclude<FilterSectionKey, "general">; ids: BulkFilterId[] }[] = [
  { key: "status", ids: STATUS_FILTER_IDS },
  { key: "visibility", ids: VISIBILITY_FILTER_IDS },
  { key: "collectionKind", ids: COLLECTION_KIND_FILTER_IDS },
];
const GROUPED_IDS = new Set(GROUPED_SECTIONS.flatMap((g) => g.ids));

interface FilterBarProps {
  search: string;
  onSearchCommit: (value: string) => void;
  filters: BulkFilterId[];
  onFiltersChange: (filters: BulkFilterId[]) => void;
  /** The missingTranslation filter needs a concrete locale — hidden until the
   * locale selector lands (Phase 4) unless the URL already carries one. */
  showTranslationFilter: boolean;
  /** The ids this row type speaks — `filterIdsForType` (columns.shared.ts),
   * the same source the route prunes stale ids against on a type switch and
   * the loader validates against. */
  filterIds: BulkFilterId[];
  pageSize: number;
  onPageSizeChange: (size: number) => void;
  onlyChanged: boolean;
  onOnlyChangedChange: (value: boolean) => void;
  strings: {
    searchPlaceholder: string;
    searchLabel: string;
    filtersLabel: string;
    filterLabels: Record<BulkFilterId, string>;
    sectionTitles: Record<FilterSectionKey, string>;
    /** Shown under the list whenever an attribute-gated filter is offered. */
    attributeFilterHint: string;
    clearAll: string;
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
  filterIds,
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

  // The translation filter additionally needs a selected foreign locale to
  // mean anything.
  const offered = filterIds.filter((id) => id !== "missingTranslation" || showTranslationFilter);
  const choicesFor = (ids: BulkFilterId[]) =>
    ids.filter((id) => offered.includes(id)).map((id) => ({ label: strings.filterLabels[id], value: id }));

  // "Nur geänderte" lives in the SAME popover as the server filters (one place
  // for every filter), but it stays a CLIENT toggle — it filters the loaded
  // page, never navigates. It is universally applicable, so the popover shows
  // even for types with no server filters (policy/metaobject primary).
  const generalChoices = [
    { label: strings.onlyChangedLabel, value: CHANGED_FILTER_ID },
    ...choicesFor(offered.filter((id) => !GROUPED_IDS.has(id))),
  ];
  const generalSelected = [
    ...(onlyChanged ? [CHANGED_FILTER_ID] : []),
    ...filters.filter((id) => !GROUPED_IDS.has(id)),
  ];
  const groupedSections = GROUPED_SECTIONS.map((g) => ({ ...g, choices: choicesFor(g.ids) })).filter(
    (g) => g.choices.length > 0,
  );
  const showAttributeHint = offered.some((id) => ATTRIBUTE_GATED_FILTER_IDS.includes(id));

  const activeCount = filters.length + (onlyChanged ? 1 : 0);
  const filterButtonLabel =
    activeCount > 0 ? `${strings.filtersLabel} (${activeCount})` : strings.filtersLabel;
  // The button must not change width when a count appears or grows — that
  // shifted the page-size picker beside it on every click. A twin button
  // carrying the widest label this type can ever show ("Filter (88)" at the
  // most digits the count can reach) sits INVISIBLY in the same grid cell, so
  // the cell is sized for it from the start and the real button fills it.
  // (Polaris' Button takes text only, so the reservation cannot live inside
  // it.) Tabular digits make every count of that length as wide as "88".
  const maxCount = filterIds.length + 1; // every offered filter + "only changed"
  const reservedLabel = `${strings.filtersLabel} (${"8".repeat(String(maxCount).length)})`;

  const commitServer = (nextServer: BulkFilterId[]) => {
    const serverChanged =
      nextServer.length !== filters.length || nextServer.some((id) => !filters.includes(id));
    if (serverChanged) onFiltersChange(nextServer);
  };

  // Split the general list back into its client + server halves, and only
  // fire each handler when ITS half actually changed — toggling "nur geänderte"
  // must not re-navigate/reset the page, and vice versa.
  const handleGeneralChange = (selected: string[]) => {
    const wantChanged = selected.includes(CHANGED_FILTER_ID);
    if (wantChanged !== onlyChanged) onOnlyChangedChange(wantChanged);
    const flags = selected.filter((id) => id !== CHANGED_FILTER_ID) as BulkFilterId[];
    commitServer([...filters.filter((id) => GROUPED_IDS.has(id)), ...flags]);
  };
  const handleGroupChange = (groupIds: BulkFilterId[]) => (selected: string[]) => {
    commitServer([...filters.filter((id) => !groupIds.includes(id)), ...(selected as BulkFilterId[])]);
  };
  const handleClearAll = () => {
    if (onlyChanged) onOnlyChangedChange(false);
    commitServer([]);
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
      <Popover
        active={popoverActive}
        onClose={() => setPopoverActive(false)}
        activator={
          <div style={{ display: "inline-grid", fontVariantNumeric: "tabular-nums" }}>
            <div style={{ gridArea: "1 / 1", display: "grid" }}>
              <Button disclosure fullWidth pressed={activeCount > 0} onClick={() => setPopoverActive((v) => !v)}>
                {filterButtonLabel}
              </Button>
            </div>
            {/* Width reservation only: never visible, never focusable
                (visibility: hidden takes it out of the tab order and the
                accessibility tree). */}
            <div aria-hidden="true" style={{ gridArea: "1 / 1", visibility: "hidden" }}>
              <Button disclosure>{reservedLabel}</Button>
            </div>
          </div>
        }
      >
        <div style={{ padding: "12px 16px", maxWidth: "340px" }}>
          <BlockStack gap="400">
            {groupedSections.map((g) => (
              <ChoiceList
                key={g.key}
                allowMultiple
                title={strings.sectionTitles[g.key]}
                choices={g.choices}
                selected={filters.filter((id) => g.ids.includes(id))}
                onChange={handleGroupChange(g.ids)}
              />
            ))}
            <ChoiceList
              allowMultiple
              title={strings.sectionTitles.general}
              titleHidden={groupedSections.length === 0}
              choices={generalChoices}
              selected={generalSelected}
              onChange={handleGeneralChange}
            />
            {showAttributeHint && (
              <Text as="p" variant="bodySm" tone="subdued">
                {strings.attributeFilterHint}
              </Text>
            )}
            {activeCount > 0 && (
              <InlineStack align="end">
                <Button variant="plain" onClick={handleClearAll}>
                  {strings.clearAll}
                </Button>
              </InlineStack>
            )}
          </BlockStack>
        </div>
      </Popover>
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
