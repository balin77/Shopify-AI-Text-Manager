/**
 * LibraryTab — presentational half of the Keywords section (Phase 1 split,
 * reworked in Phase 2 into the two-column "Bibliothek", plan §2.1).
 *
 * Layout, top to bottom: the pending AI suggestions (only when there are any),
 * the collapsible research panel, then a two-column grid — the group sidebar
 * ("Alle" / "Ohne Gruppe" pseudo-groups + real groups + create) on the left
 * and the group editor on the right. Under ~768px the grid collapses to a
 * single column (sidebar above editor).
 *
 * The editor shows, for a REAL group: rename/delete, the keyword table, bulk
 * priority and the distribution entry. For a PSEUDO group ("all"/"ungrouped"):
 * the keyword table with its group-membership actions dropped. Nothing
 * selected → a friendly prompt.
 *
 * Two interaction rules the whole tab follows:
 *  - Keyword actions are SELECTION-driven. Rows carry a checkbox and
 *    "Zuordnen" / "Verschieben" / "Entfernen" / "Löschen" sit in one bar above
 *    the table, so a merchant acts on many keywords at once instead of
 *    repeating the same click per row.
 *  - Keywords are edited IN PLACE. "+ Keyword" adds a row under an
 *    auto-generated name, already in edit mode; every name is a click away
 *    from being editable. The bulk paste box moved into a modal behind
 *    "Importieren" — one keyword is the normal case, a pasted list the
 *    exception.
 *
 * Every action button carries a Tooltip saying what it does, via
 * DisabledActionTooltip so the hint also shows while the button is disabled
 * (browsers swallow pointer events on disabled controls).
 *
 * PURE PRESENTATION apart from the selection and which cell is being edited.
 * All other state, fetchers, refs, effects and confirm-dialog flows live in
 * the Shell (SeoKeywords); this component only renders JSX and calls the
 * callbacks / fetchers it is handed.
 */

import { useEffect, useMemo, type Dispatch, type SetStateAction } from "react";
import {
  Card,
  BlockStack,
  InlineStack,
  InlineGrid,
  Text,
  Badge,
  Button,
  TextField,
  Select,
  Banner,
  IndexTable,
  Modal,
  // Checkbox is gone with the distribution preview's Selects — the decisions
  // live in SuggestionsPanel now.
  ProgressBar,
  Divider,
  Box,
  useIndexResourceState,
} from "@shopify/polaris";
import type { FetcherWithComponents } from "react-router";
import type { KeywordResourceType } from "../../../services/seo/keywords.service";
import { HelpTooltip } from "../../HelpTooltip";
import { DisabledActionTooltip } from "../../DisabledActionTooltip";
import type { Translation } from "../../../i18n/de";
import type { loader, ActionResult, KeywordSelection } from "../../../routes/app.seo.keywords";
import { GroupSidebar } from "./GroupSidebar";
import { KeywordImportModal } from "./KeywordImportModal";
import { EditableKeywordCell } from "./EditableKeywordCell";
import { ResearchPanel } from "./ResearchPanel";
import { AssignPanel } from "./AssignPanel";
import { SuggestionsPanel, type DecisionMap } from "./SuggestionsPanel";
import type { Route } from "../../../routes/+types/app.seo.keywords";
import "../../../styles/KeywordsPage.css";

type LoaderData = Route.ComponentProps["loaderData"];
type KeywordsPageStrings = Translation["seo"]["keywordsPage"];
type AssignKeyword = { keywordId: string; keyword: string };

/** Tone per priority so 1/2/3 reads at a glance instead of as a bare number. */
const PRIORITY_TONE: Record<number, "critical" | "warning" | undefined> = {
  1: "critical",
  2: "warning",
  3: undefined,
};

export interface LibraryTabProps {
  k: KeywordsPageStrings;
  groups: LoaderData["groups"];
  /** Every group of the shop across ALL languages — the move dialog's target
   *  group picker (`groups` only holds the active language's). */
  allGroups: LoaderData["allGroups"];
  allCount: number;
  ungroupedCount: number;
  groupDetail: LoaderData["groupDetail"];
  isPro: boolean;
  runningDistribution: LoaderData["runningDistribution"];
  distributionPreview: LoaderData["distributionPreview"];
  researchAvailability: LoaderData["researchAvailability"];
  productTypes: LoaderData["productTypes"];
  localeOptions: LoaderData["localeOptions"];
  priorityOptions: { label: string; value: string }[];
  intentLabel: (intent: string | null | undefined) => string | null;
  selectGroup: (groupId: string | null) => void;
  /** Active locale — new groups are created under it (§3.1). */
  activeLocale: string;

  // Group create (sidebar)
  newGroupName: string;
  setNewGroupName: (v: string) => void;
  groupFetcher: FetcherWithComponents<ActionResult>;

  // Research
  seedInput: string;
  setSeedInput: (v: string) => void;
  suggestFetcher: FetcherWithComponents<{
    ok: boolean;
    groups?: { direct: string[]; questions: string[]; alphabet: string[] };
    error?: "invalid" | "rateLimited" | "blocked";
  }>;
  runResearch: (expandAlphabet: boolean) => void;
  selectedSuggestions: Set<string>;
  toggleSuggestion: (s: string) => void;
  importGroupId: string;
  setImportGroupId: (v: string) => void;
  importSelectedSuggestions: () => void;

  // Group detail
  isRenaming: boolean;
  setIsRenaming: (v: boolean) => void;
  renameValue: string;
  setRenameValue: (v: string) => void;
  handleDeleteGroup: () => void;
  handleApplyBulkPriority: () => void;
  bulkPriority: string;
  setBulkPriority: (v: string) => void;
  priorityFetcher: FetcherWithComponents<ActionResult>;
  distFetcher: FetcherWithComponents<{
    success: boolean;
    taskId?: string;
    error?: string;
    code?: string;
  }>;
  decisions: DecisionMap;
  setDecisions: Dispatch<SetStateAction<DecisionMap>>;
  demoteExisting: boolean;
  setDemoteExisting: (v: boolean) => void;
  applyDistribution: () => void;

  // Assign panel (Phase 4b) — unified entry for both distribution modes.
  assignPanelOpen: boolean;
  assignPanelKeywords: AssignKeyword[];
  openAssignPanel: (keywords: AssignKeyword[]) => void;
  closeAssignPanel: () => void;
  assignFetcher: FetcherWithComponents<ActionResult>;
  startDistribution: (opts: {
    resourceIds: string[];
    keywordIds: string[];
    targetType: KeywordResourceType;
    maxSecondaries: string;
  }) => void;

  // Move the selected keywords to another group and/or language.
  moveModal: KeywordSelection | null;
  openMoveModal: (rows: KeywordSelection) => void;
  closeMoveModal: () => void;
  moveTargetLocale: string;
  setMoveTargetLocale: (v: string) => void;
  moveTargetGroupId: string;
  setMoveTargetGroupId: (v: string) => void;
  submitMove: () => void;
  moveFetcher: FetcherWithComponents<ActionResult>;
  /** Delete the keywords themselves (not just their group membership). */
  handleDeleteKeywords: (rows: KeywordSelection) => void;
  /** Drop the keywords out of the selected (real) group only. */
  handleRemoveKeywordsFromGroup: (rows: KeywordSelection) => void;

  // Inline editing of the keyword names. `editingKeywordId` lives in the Shell
  // because a freshly CREATED row has to open in edit mode, and only the Shell
  // sees the create action's answer.
  editingKeywordId: string | null;
  startEditKeyword: (keywordId: string) => void;
  cancelEditKeyword: () => void;
  commitEditKeyword: (keywordId: string, keyword: string) => void;
  /** Rejection text for the row currently being edited, if the server refused. */
  editKeywordError: string | null;
  handleCreateKeyword: () => void;
  keywordEditFetcher: FetcherWithComponents<ActionResult>;

  // Bulk paste, now behind a button instead of permanently on screen.
  importModalOpen: boolean;
  openImportModal: () => void;
  closeImportModal: () => void;
}

export function LibraryTab({
  k,
  groups,
  allGroups,
  allCount,
  ungroupedCount,
  groupDetail,
  isPro,
  runningDistribution,
  distributionPreview,
  researchAvailability,
  productTypes,
  localeOptions,
  priorityOptions,
  intentLabel,
  selectGroup,
  activeLocale,
  newGroupName,
  setNewGroupName,
  groupFetcher,
  seedInput,
  setSeedInput,
  suggestFetcher,
  runResearch,
  selectedSuggestions,
  toggleSuggestion,
  importGroupId,
  setImportGroupId,
  importSelectedSuggestions,
  isRenaming,
  setIsRenaming,
  renameValue,
  setRenameValue,
  handleDeleteGroup,
  handleApplyBulkPriority,
  bulkPriority,
  setBulkPriority,
  priorityFetcher,
  distFetcher,
  decisions,
  setDecisions,
  demoteExisting,
  setDemoteExisting,
  applyDistribution,
  assignPanelOpen,
  assignPanelKeywords,
  openAssignPanel,
  closeAssignPanel,
  assignFetcher,
  startDistribution,
  moveModal,
  openMoveModal,
  closeMoveModal,
  moveTargetLocale,
  setMoveTargetLocale,
  moveTargetGroupId,
  setMoveTargetGroupId,
  submitMove,
  moveFetcher,
  handleDeleteKeywords,
  handleRemoveKeywordsFromGroup,
  editingKeywordId,
  startEditKeyword,
  cancelEditKeyword,
  commitEditKeyword,
  editKeywordError,
  handleCreateKeyword,
  keywordEditFetcher,
  importModalOpen,
  openImportModal,
  closeImportModal,
}: LibraryTabProps) {
  const isPseudo = !!groupDetail?.pseudo;

  // Display name for a stored locale value ("" = primary, the SeoKeyword
  // convention) — the loader's localeOptions are the single source.
  const localeName = (locale: string) =>
    localeOptions.find((l) => l.locale === locale)?.name || locale || k.localePrimary;
  // Groups available as a move target: exactly the chosen language's, since a
  // group owns its language (§3.1) and cannot hold a foreign-language keyword.
  const moveGroupOptions = [
    { label: k.moveNoGroup || "No group", value: "" },
    ...allGroups.filter((g) => g.locale === moveTargetLocale).map((g) => ({ label: g.name, value: g.id })),
  ];
  const moveIsNoop =
    !!moveModal &&
    moveTargetLocale === (moveModal[0]?.locale ?? "") &&
    moveTargetGroupId === (groupDetail && !groupDetail.pseudo ? groupDetail.id : "");

  // Keyword-table selection — the single input every keyword action in the bar
  // above the table reads. Available in the pseudo views too: assigning,
  // moving and deleting are keyword-level operations that make just as much
  // sense from "Alle" / "Ohne Gruppe" as from a real group.
  const keywordRows = groupDetail?.keywords ?? [];
  const { selectedResources, allResourcesSelected, handleSelectionChange, clearSelection } =
    useIndexResourceState(keywordRows as unknown as { [key: string]: unknown }[], {
      resourceIDResolver: (r) => (r as unknown as { keywordId: string }).keywordId,
    });

  // Switching group/language swaps the whole row set, and a completed write
  // (delete, remove-from-group, import, …) rewrites it — either way a
  // carried-over selection would keep ticks and an "Alle"-header for rows that
  // are no longer there.
  const groupKey = `${groupDetail?.id ?? ""}::${groupDetail?.locale ?? ""}`;
  const groupWriteResult = groupFetcher.state === "idle" ? groupFetcher.data : undefined;
  useEffect(() => {
    clearSelection();
    // clearSelection is stable for a given row set; listing it would wipe the
    // selection on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupKey, groupWriteResult]);

  // The selected rows, resolved back against the rows actually on screen: a
  // bulk action revalidates the loader, and until the fresh rows arrive the
  // selection can still name keywords that were just deleted or moved away.
  const selectedRows: KeywordSelection = useMemo(
    () =>
      keywordRows
        .filter((r) => selectedResources.includes(r.keywordId))
        .map((r) => ({
          keywordId: r.keywordId,
          keyword: r.keyword,
          locale: r.locale,
          assignmentCount: r.assignmentCount,
        })),
    [keywordRows, selectedResources],
  );
  const selectedCount = selectedRows.length;
  const moveCount = moveModal?.length ?? 0;
  // One in-flight write at a time — group actions and the move share the
  // selection, and a second submit would race the first one's revalidation.
  const bulkBusy = groupFetcher.state !== "idle" || moveFetcher.state !== "idle";

  // Keywords in this group not yet assigned to any item — the "redistribute"
  // (§3.3) entry offers exactly these; disabled when none remain.
  const unassignedKeywords = keywordRows.filter((r) => r.assignmentCount === 0);

  const openAssignForSelection = () => {
    if (selectedCount === 0) return;
    openAssignPanel(selectedRows.map((r) => ({ keywordId: r.keywordId, keyword: r.keyword })));
  };
  /**
   * Legend for the Intention column. The stored values are English SEO jargon
   * ("commercial", "transactional") that a merchant has no way of decoding
   * from a bare badge — so whenever the visible rows actually carry one, the
   * table says what those words mean.
   */
  const intentLegend = useMemo(() => {
    const present = Array.from(
      new Set(keywordRows.map((r) => r.intent).filter((i): i is string => !!i)),
    );
    return present
      .map((intent) => `${intentLabel(intent) ?? intent} — ${k.intentExplain[intent] ?? ""}`)
      .filter((line) => line.trim().length > 0);
  }, [keywordRows, intentLabel, k.intentExplain]);

  const renderIntentLegend = () =>
    intentLegend.length === 0 ? null : (
      <Box paddingBlockStart="100">
        <BlockStack gap="050">
          <Text as="span" variant="bodySm" fontWeight="medium" tone="subdued">
            {k.intentLegendTitle}
          </Text>
          {intentLegend.map((line) => (
            <Text key={line} as="span" variant="bodySm" tone="subdued">
              {line}
            </Text>
          ))}
        </BlockStack>
      </Box>
    );

  const pseudoTitle =
    groupDetail?.pseudo === "all"
      ? k.groupAll || "All"
      : groupDetail?.pseudo === "ungrouped"
        ? k.groupUngrouped || "Ungrouped"
        : "";

  /**
   * The bar that replaced the per-row action buttons: everything a merchant
   * can do to keywords, applied to the checkbox selection in one go, plus the
   * two entries that create rows ("+ Keyword" and the paste import).
   *
   * Rendered directly above the table in both the real-group and pseudo views
   * — "Entfernen" and "Importieren" are the entries a pseudo view drops, since
   * a view has no membership to remove from or import into.
   *
   * Every button is wrapped in DisabledActionTooltip: it shows the hint on a
   * disabled control too, so "why can I not click this" is answered by hover
   * instead of by guessing.
   */
  /**
   * Why a selection action just did nothing. Without this a rejected bulk
   * request (most plausibly a selection past the server's per-request cap —
   * an import may add 2000 rows to one group) looked exactly like a dead
   * button.
   */
  const renderBulkError = () => {
    const failure = [groupFetcher, moveFetcher]
      .map((f) => (f.state === "idle" ? f.data : undefined))
      .find((d) => d && !d.ok);
    if (!failure || failure.ok) return null;
    if (failure.error === "tooManySelected") {
      return (
        <Banner tone="warning">
          {k.selectionTooMany.replace("{max}", String(failure.max))}
        </Banner>
      );
    }
    // duplicateName is the group-create field's own inline message; anything
    // else is a genuine failure of the action the merchant just triggered.
    if (failure.error === "duplicateName" || failure.error === "csvTooMany") return null;
    return <Banner tone="critical">{k.errorGeneric}</Banner>;
  };

  /** A move that reported success but carried nothing across. */
  const renderMoveResult = () => {
    const d = moveFetcher.state === "idle" ? moveFetcher.data : undefined;
    if (!d?.ok || d.kind !== "keywordsMoved" || d.failed === 0) return null;
    return (
      <Banner tone={d.moved === 0 ? "critical" : "warning"}>
        {k.moveFailedSome
          .replace("{failed}", String(d.failed))
          .replace("{moved}", String(d.moved))}
      </Banner>
    );
  };

  const renderSelectionBar = (readOnly: boolean) => {
    const nothingSelected = selectedCount === 0;
    const selectionHint = (active: string) => (nothingSelected ? k.selectionNeeded : active);

    return (
      <div
        className={`keyword-selection-bar${selectedCount > 0 ? " keyword-selection-bar--active" : ""}`}
      >
        <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
          <InlineStack gap="200" blockAlign="center" wrap>
            <Text as="span" variant="bodySm" tone={selectedCount > 0 ? undefined : "subdued"}>
              {selectedCount > 0
                ? k.selectionCount.replace("{count}", String(selectedCount))
                : k.selectionHint}
            </Text>
            {selectedCount > 0 && (
              <Button variant="plain" onClick={clearSelection}>
                {k.selectionClear}
              </Button>
            )}
          </InlineStack>

          <InlineStack gap="200" blockAlign="center" wrap>
            {/* Row-creating entries first — they need no selection. */}
            {!readOnly && (
              <>
                <DisabledActionTooltip hint={k.addKeywordHint} preferredPosition="below">
                  <Button size="slim" disabled={bulkBusy} onClick={handleCreateKeyword}>
                    {`＋ ${k.addKeyword}`}
                  </Button>
                </DisabledActionTooltip>
                <DisabledActionTooltip hint={k.importHint} preferredPosition="below">
                  <Button size="slim" variant="plain" onClick={openImportModal}>
                    {k.importButton}
                  </Button>
                </DisabledActionTooltip>
                <div style={{ height: "1.25rem" }}>
                  <Divider borderColor="border" />
                </div>
              </>
            )}

            <DisabledActionTooltip
              hint={selectionHint(k.assign.assignSelectionHint)}
              preferredPosition="below"
            >
              <Button
                size="slim"
                variant="primary"
                disabled={nothingSelected}
                onClick={openAssignForSelection}
              >
                {k.assign.assignSelection}
              </Button>
            </DisabledActionTooltip>

            {/* From a pseudo view there is no source group to leave, so a
                same-language move only ADDS the keywords to the chosen group —
                the dialog spells that out. */}
            <DisabledActionTooltip
              hint={selectionHint(k.moveKeywordHint)}
              preferredPosition="below"
            >
              <Button
                size="slim"
                disabled={nothingSelected || bulkBusy}
                onClick={() => openMoveModal(selectedRows)}
              >
                {k.moveKeyword}
              </Button>
            </DisabledActionTooltip>

            {/* Only out of THIS group — a keyword survives as long as it is
                assigned to an item or belongs to another group. */}
            {!readOnly && (
              <DisabledActionTooltip
                hint={selectionHint(k.groupRemoveKeywordHint)}
                preferredPosition="below"
              >
                <Button
                  size="slim"
                  disabled={nothingSelected || bulkBusy}
                  onClick={() => handleRemoveKeywordsFromGroup(selectedRows)}
                >
                  {k.groupRemoveKeyword}
                </Button>
              </DisabledActionTooltip>
            )}

            {/* Gone for good, including every item assignment. */}
            <DisabledActionTooltip
              hint={selectionHint(k.deleteKeywordHint)}
              preferredPosition="below"
            >
              <Button
                size="slim"
                tone="critical"
                disabled={nothingSelected || bulkBusy}
                onClick={() => handleDeleteKeywords(selectedRows)}
              >
                {k.delete}
              </Button>
            </DisabledActionTooltip>
          </InlineStack>
        </InlineStack>
      </div>
    );
  };

  // The keyword table. `readOnly` is about GROUP MEMBERSHIP, not about the
  // keywords: a pseudo view has no membership to edit (no priority Select, no
  // "Entfernen"), but its rows are still selectable, still editable in place
  // and still support every keyword-level action in the bar above.
  const renderKeywordTable = (readOnly: boolean) => {
    if (!groupDetail) return null;
    if (groupDetail.keywords.length === 0) {
      return (
        <Box padding="600">
          <BlockStack gap="200" inlineAlign="center">
            <Text as="p" variant="bodyMd" tone="subdued">
              {readOnly ? k.groupNoKeywordsReadonly : k.groupNoKeywords}
            </Text>
            {!readOnly && (
              <InlineStack gap="200" blockAlign="center">
                <Button variant="primary" disabled={bulkBusy} onClick={handleCreateKeyword}>
                  {`＋ ${k.addKeyword}`}
                </Button>
                <Button variant="plain" onClick={openImportModal}>
                  {k.importButton}
                </Button>
              </InlineStack>
            )}
          </BlockStack>
        </Box>
      );
    }
    const headings: { title: string }[] = [
      { title: k.colKeyword },
      { title: k.colIntent },
      { title: k.colLocale },
      { title: k.colPriority },
      { title: k.colAssignments },
    ];
    return (
      <IndexTable
        itemCount={groupDetail.keywords.length}
        selectable
        // selectedCount, not selectedResources.length: a write can retire rows
        // the selection still names, and the header must count what is on screen.
        selectedItemsCount={allResourcesSelected ? "All" : selectedCount}
        onSelectionChange={handleSelectionChange}
        headings={headings as [{ title: string }, ...{ title: string }[]]}
      >
        {groupDetail.keywords.map((gk, index) => {
          const editing = editingKeywordId === gk.keywordId;
          return (
            <IndexTable.Row
              id={gk.keywordId}
              key={gk.keywordId}
              position={index}
              selected={selectedResources.includes(gk.keywordId)}
            >
              <IndexTable.Cell>
                {/* The row click target is the checkbox; the name is its own
                    button, so a click on the text edits instead of selecting. */}
                <div
                  onClick={(event) => event.stopPropagation()}
                  onKeyUp={(event) => event.stopPropagation()}
                  role="presentation"
                >
                  <EditableKeywordCell
                    k={k}
                    keywordId={gk.keywordId}
                    keyword={gk.keyword}
                    editing={editing}
                    error={editing ? editKeywordError ?? undefined : undefined}
                    busy={keywordEditFetcher.state !== "idle"}
                    onStartEdit={() => startEditKeyword(gk.keywordId)}
                    onCancel={cancelEditKeyword}
                    onCommit={(next) => commitEditKeyword(gk.keywordId, next)}
                  />
                </div>
              </IndexTable.Cell>
              <IndexTable.Cell>
                {gk.intent ? (
                  <Badge>{intentLabel(gk.intent) ?? gk.intent}</Badge>
                ) : (
                  <Text as="span" variant="bodySm" tone="subdued">
                    —
                  </Text>
                )}
              </IndexTable.Cell>
              <IndexTable.Cell>
                <Text as="span" variant="bodySm" tone="subdued">
                  {localeName(gk.locale)}
                </Text>
              </IndexTable.Cell>
              <IndexTable.Cell>
                {readOnly ? (
                  <Badge tone={PRIORITY_TONE[gk.priority]}>
                    {priorityOptions.find((o) => o.value === String(gk.priority))?.label ??
                      String(gk.priority)}
                  </Badge>
                ) : (
                  <div
                    style={{ minWidth: "110px" }}
                    onClick={(event) => event.stopPropagation()}
                    onKeyUp={(event) => event.stopPropagation()}
                    role="presentation"
                  >
                    <Select
                      label={k.colPriority}
                      labelHidden
                      options={priorityOptions}
                      value={String(gk.priority)}
                      disabled={priorityFetcher.state !== "idle"}
                      onChange={(v) =>
                        priorityFetcher.submit(
                          { actionType: "setPriority", keywordId: gk.keywordId, priority: v },
                          { method: "post" },
                        )
                      }
                    />
                  </div>
                )}
              </IndexTable.Cell>
              <IndexTable.Cell>
                {gk.assignmentCount > 0 ? (
                  <Badge tone="success">{String(gk.assignmentCount)}</Badge>
                ) : (
                  <Text as="span" variant="bodySm" tone="subdued">
                    {k.assignmentsNone}
                  </Text>
                )}
              </IndexTable.Cell>
            </IndexTable.Row>
          );
        })}
      </IndexTable>
    );
  };

  // Right column: the group editor.
  const editor = !groupDetail ? (
    <Card>
      <Text as="p" tone="subdued">
        {k.libraryEmptyPrompt || "Select a group on the left, or “All” / “Ungrouped”, to see its keywords."}
      </Text>
    </Card>
  ) : isPseudo ? (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h3" variant="headingMd">
            {`${pseudoTitle} (${groupDetail.keywords.length})`}
          </Text>
          <HelpTooltip helpKey="keywordsDistribute" position="below" />
        </InlineStack>
        {groupDetail.keywords.length > 0 && renderSelectionBar(true)}
        {renderBulkError()}
        {renderKeywordTable(true)}
        {renderIntentLegend()}
      </BlockStack>
    </Card>
  ) : (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          {isRenaming ? (
            <InlineStack gap="200" blockAlign="end" wrap={false}>
              <TextField
                label={k.groupRenameLabel || "New name"}
                labelHidden
                autoComplete="off"
                value={renameValue}
                onChange={setRenameValue}
                maxLength={100}
              />
              <Button
                size="slim"
                loading={groupFetcher.state !== "idle"}
                disabled={!renameValue.trim()}
                onClick={() => {
                  if (!groupDetail) return;
                  groupFetcher.submit(
                    { actionType: "renameGroup", groupId: groupDetail.id, name: renameValue },
                    { method: "post" },
                  );
                  setIsRenaming(false);
                }}
              >
                {k.groupRenameSave || "Save"}
              </Button>
              <Button size="slim" variant="plain" onClick={() => setIsRenaming(false)}>
                {k.distModalCancel || "Cancel"}
              </Button>
            </InlineStack>
          ) : (
            <InlineStack gap="200" blockAlign="center">
              <Text as="h3" variant="headingMd">
                {groupDetail.name}
              </Text>
              <Button
                size="micro"
                variant="plain"
                onClick={() => {
                  setRenameValue(groupDetail?.name ?? "");
                  setIsRenaming(true);
                }}
              >
                {k.groupRename || "Rename"}
              </Button>
            </InlineStack>
          )}
          {/* Group-WIDE shortcuts: "all keywords" and "the unassigned ones",
              neither of which needs a selection. The primary action now lives
              in the selection bar above the table (k.assign.assignSelection),
              so these stay secondary. */}
          <InlineStack gap="200" blockAlign="center">
            <DisabledActionTooltip
              hint={
                groupDetail.keywords.length === 0
                  ? k.distributeEmptyHint
                  : runningDistribution
                    ? k.distributeRunningHint
                    : k.distributeButtonHint
              }
              preferredPosition="below"
            >
              <Button
                size="slim"
                disabled={!!runningDistribution || groupDetail.keywords.length === 0}
                onClick={() =>
                  openAssignPanel(
                    groupDetail.keywords.map((gk) => ({ keywordId: gk.keywordId, keyword: gk.keyword })),
                  )
                }
              >
                {k.distributeButton}
              </Button>
            </DisabledActionTooltip>
            <DisabledActionTooltip
              hint={
                unassignedKeywords.length === 0
                  ? k.assign.redistributeNone
                  : k.assign.redistributeHint.replace("{count}", String(unassignedKeywords.length))
              }
              preferredPosition="below"
            >
              <Button
                size="slim"
                disabled={!!runningDistribution || unassignedKeywords.length === 0}
                onClick={() =>
                  openAssignPanel(
                    unassignedKeywords.map((gk) => ({ keywordId: gk.keywordId, keyword: gk.keyword })),
                  )
                }
              >
                {k.assign.redistribute}
              </Button>
            </DisabledActionTooltip>
            <DisabledActionTooltip hint={k.groupDeleteHint} preferredPosition="below">
              <Button size="slim" tone="critical" variant="plain" onClick={handleDeleteGroup}>
                {k.groupDelete}
              </Button>
            </DisabledActionTooltip>
            <HelpTooltip helpKey="keywordsDistribute" position="below" />
          </InlineStack>
        </InlineStack>

        {/* The run's progress and its start errors live at the TOP of the tab,
            next to the suggestions they produce — not duplicated here. */}

        {/* Group keywords: the selection bar owns every keyword action, the
            table below is just the checkboxes and the row data. */}
        {groupDetail.keywords.length > 0 && renderSelectionBar(false)}
        {renderBulkError()}
        {renderKeywordTable(false)}
        {renderIntentLegend()}

        {/* Bulk priority (plan §5.1 group bulk actions) */}
        {groupDetail.keywords.length > 1 && (
          <>
            <Divider />
            <InlineStack gap="200" blockAlign="end" wrap>
              <div style={{ minWidth: "170px" }}>
                <Select
                  label={k.bulkPriorityLabel}
                  options={priorityOptions}
                  value={bulkPriority}
                  onChange={setBulkPriority}
                />
              </div>
              <DisabledActionTooltip hint={k.bulkPriorityHint} preferredPosition="above">
                <Button loading={groupFetcher.state !== "idle"} onClick={handleApplyBulkPriority}>
                  {k.bulkPriorityApply}
                </Button>
              </DisabledActionTooltip>
            </InlineStack>
          </>
        )}
      </BlockStack>
    </Card>
  );

  return (
    <BlockStack gap="400">
      {/* Pending AI suggestions come FIRST and only exist while there are
          any — an unreviewed batch is a decision waiting on the merchant, so
          it outranks the research panel and the group list. It is deliberately
          not scoped to the selected group (see the loader). */}
      {distributionPreview && (
        <SuggestionsPanel
          k={k}
          preview={distributionPreview}
          decisions={decisions}
          setDecisions={setDecisions}
          demoteExisting={demoteExisting}
          setDemoteExisting={setDemoteExisting}
          applyDistribution={applyDistribution}
          distFetcher={distFetcher}
          runningDistribution={runningDistribution}
        />
      )}

      {/* A run in flight replaces the suggestion list — same slot, so progress
          and result appear in the same place instead of in the group card. */}
      {runningDistribution && (
        <Card>
          <BlockStack gap="200">
            <Text as="p" variant="bodyMd">
              {(runningDistribution.fieldType === "apply"
                ? k.distApplyRunning
                : k.distSuggestRunning
              ).replace("{progress}", String(runningDistribution.progress ?? 0))}
            </Text>
            <ProgressBar progress={runningDistribution.progress ?? 0} size="small" />
          </BlockStack>
        </Card>
      )}
      {distFetcher.data && !distFetcher.data.success && (
        <Banner tone="critical">
          {distFetcher.data.code === "ALREADY_RUNNING"
            ? k.distAlreadyRunning
            : distFetcher.data.error || k.errorGeneric}
        </Banner>
      )}

      {/* Research (plan §2.1) — collapsible, language follows the navbar. */}
      <ResearchPanel
        k={k}
        researchAvailability={researchAvailability}
        groups={groups}
        allGroups={allGroups}
        localeOptions={localeOptions}
        seedInput={seedInput}
        setSeedInput={setSeedInput}
        suggestFetcher={suggestFetcher}
        runResearch={runResearch}
        selectedSuggestions={selectedSuggestions}
        toggleSuggestion={toggleSuggestion}
        importGroupId={importGroupId}
        setImportGroupId={setImportGroupId}
        importSelectedSuggestions={importSelectedSuggestions}
        groupFetcher={groupFetcher}
      />

      {/* Two-column: sidebar + editor. Collapses to one column under md. */}
      <InlineGrid columns={{ xs: 1, md: ["oneThird", "twoThirds"] }} gap="400">
        <GroupSidebar
          k={k}
          groups={groups}
          allCount={allCount}
          ungroupedCount={ungroupedCount}
          activeId={groupDetail?.id ?? null}
          selectGroup={selectGroup}
          activeLocale={activeLocale}
          newGroupName={newGroupName}
          setNewGroupName={setNewGroupName}
          groupFetcher={groupFetcher}
        />
        {editor}
      </InlineGrid>

      {/* Unified assign panel (Phase 4b): ItemPicker + manual/AI modes. */}
      <AssignPanel
        open={assignPanelOpen}
        onClose={closeAssignPanel}
        keywords={assignPanelKeywords}
        groupName={groupDetail?.name ?? pseudoTitle}
        locale={activeLocale || localeOptions[0]?.name || k.localePrimary}
        activeLocale={activeLocale}
        productTypes={productTypes.map((p) => ({ label: p, value: p }))}
        isPro={isPro}
        // The AI distribution runs against a real group row (the handler looks
        // it up by id). "Alle" / "Ohne Gruppe" are views with sentinel ids, so
        // only manual assignment is offered from them.
        aiAvailable={!!groupDetail && !groupDetail.pseudo}
        k={k}
        assignFetcher={assignFetcher}
        startDistribution={startDistribution}
        runningDistribution={runningDistribution}
      />

      {/* Bulk paste, behind the "Importieren" button instead of permanently on
          screen. Only a real group can be imported into (§3.1: the group owns
          the keywords' language). */}
      {groupDetail && !groupDetail.pseudo && (
        <KeywordImportModal
          k={k}
          open={importModalOpen}
          onClose={closeImportModal}
          groupId={groupDetail.id}
          groupFetcher={groupFetcher}
          priorityOptions={priorityOptions}
        />
      )}

      {/* Move the selected keywords to another group and/or language. A
          language change merges each keyword into the target language and
          carries its item assignments along — hence the warning below. */}
      <Modal
        open={!!moveModal}
        onClose={closeMoveModal}
        title={
          moveCount > 1
            ? k.moveModalTitleMany.replace("{count}", String(moveCount))
            : k.moveModalTitle || "Move keyword"
        }
        primaryAction={{
          content: k.moveModalConfirm || "Move",
          loading: moveFetcher.state !== "idle",
          disabled: moveIsNoop,
          onAction: submitMove,
        }}
        secondaryActions={[{ content: k.distModalCancel || "Cancel", onAction: closeMoveModal }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Text as="p" variant="bodyMd">
              {moveCount > 1
                ? k.moveModalBodyMany.replace("{count}", String(moveCount))
                : (k.moveModalBody || "Move “{keyword}” to another language or group.").replace(
                    "{keyword}",
                    moveModal?.[0]?.keyword ?? "",
                  )}
            </Text>
            {localeOptions.length > 1 && (
              <Select
                label={k.moveTargetLocale || "Language"}
                options={localeOptions.map((l) => ({
                  label: l.primary ? `${l.name} (${k.localePrimary})` : l.name || l.locale,
                  value: l.locale,
                }))}
                value={moveTargetLocale}
                onChange={(v) => {
                  setMoveTargetLocale(v);
                  // Groups belong to exactly one language — a group of the old
                  // language must not survive the switch as a target.
                  setMoveTargetGroupId("");
                }}
              />
            )}
            <Select
              label={k.moveTargetGroup || "Group"}
              options={moveGroupOptions}
              value={moveTargetGroupId}
              onChange={setMoveTargetGroupId}
              helpText={
                allGroups.some((g) => g.locale === moveTargetLocale)
                  ? undefined
                  : k.moveNoGroupsInLocale || "This language has no keyword groups yet."
              }
            />
            {moveModal && moveTargetLocale !== (moveModal[0]?.locale ?? "") && (
              <Banner tone="warning">
                {(
                  k.moveLocaleWarning ||
                  "The keyword and its item assignments move to {locale}. Assignments are dropped where the item already tracks this keyword there or has reached its keyword limit. Because a group belongs to exactly one language, the keyword loses ALL its current group memberships and ends up only in the group chosen above."
                ).replace("{locale}", localeName(moveTargetLocale))}
              </Banner>
            )}
            {moveFetcher.state === "idle" && moveFetcher.data && !moveFetcher.data.ok && (
              <Banner tone="critical">
                {moveFetcher.data.error === "tooManySelected"
                  ? k.selectionTooMany.replace("{max}", String(moveFetcher.data.max))
                  : k.errorGeneric}
              </Banner>
            )}
            {/* The server moves what it can and counts the rest — a move where
                nothing arrived keeps this dialog open (see the Shell) so the
                reason is visible instead of silently landing on an empty
                target group. */}
            {renderMoveResult()}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </BlockStack>
  );
}
