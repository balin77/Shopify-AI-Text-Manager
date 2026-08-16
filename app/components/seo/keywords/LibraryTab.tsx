/**
 * LibraryTab — presentational half of the Keywords section (Phase 1 split,
 * reworked in Phase 2 into the two-column "Bibliothek", plan §2.1).
 *
 * Layout: the collapsible research panel on top, then a two-column grid — the
 * group sidebar ("Alle" / "Ohne Gruppe" pseudo-groups + real groups + create)
 * on the left and the group editor on the right. Under ~768px the grid
 * collapses to a single column (sidebar above editor).
 *
 * The editor shows, for a REAL group: rename/delete, the ONE bulk-paste box
 * (KeywordPaste), the editable keyword table, bulk priority and the
 * distribution entry + preview. For a PSEUDO group ("all"/"ungrouped"): just
 * the read-only keyword table. Nothing selected → a friendly prompt.
 *
 * PURE PRESENTATION. All state, fetchers, refs, effects and confirm-dialog
 * flows live in the Shell (SeoKeywords); this component only renders JSX and
 * calls the callbacks / fetchers it is handed.
 */

import type { Dispatch, SetStateAction } from "react";
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
  Checkbox,
  Modal,
  ProgressBar,
  useIndexResourceState,
} from "@shopify/polaris";
import type { FetcherWithComponents } from "react-router";
import type { KeywordResourceType } from "../../../services/seo/keywords.service";
import { HelpTooltip } from "../../HelpTooltip";
import type { Translation } from "../../../i18n/de";
import type { loader, ActionResult } from "../../../routes/app.seo.keywords";
import { GroupSidebar } from "./GroupSidebar";
import { KeywordPaste } from "./KeywordPaste";
import { ResearchPanel } from "./ResearchPanel";
import { AssignPanel } from "./AssignPanel";
import type { Route } from "../../../routes/+types/app.seo.keywords";

type LoaderData = Route.ComponentProps["loaderData"];
type KeywordsPageStrings = Translation["seo"]["keywordsPage"];
type DecisionMap = Record<string, "accept" | "secondaryOnly" | "reject">;
type AssignKeyword = { keywordId: string; keyword: string };

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
    targetType: KeywordResourceType;
    maxSecondaries: string;
  }) => void;

  // Move a keyword to another group and/or language.
  moveModal: { keywordId: string; keyword: string; locale: string } | null;
  openMoveModal: (row: { keywordId: string; keyword: string; locale: string }) => void;
  closeMoveModal: () => void;
  moveTargetLocale: string;
  setMoveTargetLocale: (v: string) => void;
  moveTargetGroupId: string;
  setMoveTargetGroupId: (v: string) => void;
  submitMove: () => void;
  moveFetcher: FetcherWithComponents<ActionResult>;
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
    moveTargetLocale === moveModal.locale &&
    moveTargetGroupId === (groupDetail && !groupDetail.pseudo ? groupDetail.id : "");

  // Group-keyword table selection (real groups only) drives the "Auswahl
  // zuordnen" bulk action. Transient view state — the selected ids map back to
  // the group's keyword rows when the assign panel opens.
  const keywordRows = groupDetail?.keywords ?? [];
  const { selectedResources, allResourcesSelected, handleSelectionChange } = useIndexResourceState(
    keywordRows as unknown as { [key: string]: unknown }[],
    { resourceIDResolver: (r) => (r as unknown as { keywordId: string }).keywordId },
  );

  // Keywords in this group not yet assigned to any item — the "redistribute"
  // (§3.3) entry offers exactly these; disabled when none remain.
  const unassignedKeywords = keywordRows.filter((r) => r.assignmentCount === 0);

  const openAssignForSelection = () => {
    const subset = keywordRows
      .filter((r) => selectedResources.includes(r.keywordId))
      .map((r) => ({ keywordId: r.keywordId, keyword: r.keyword }));
    if (subset.length > 0) openAssignPanel(subset);
  };
  const pseudoTitle =
    groupDetail?.pseudo === "all"
      ? k.groupAll || "All"
      : groupDetail?.pseudo === "ungrouped"
        ? k.groupUngrouped || "Ungrouped"
        : "";

  // The keyword table — editable for a real group (priority Select + remove),
  // read-only for the pseudo groups (priority badge, no actions).
  const renderKeywordTable = (readOnly: boolean) => {
    if (!groupDetail) return null;
    if (groupDetail.keywords.length === 0) {
      return (
        <Text as="p" tone="subdued">
          {readOnly
            ? k.groupNoKeywordsReadonly || "No keywords for this language yet."
            : k.groupNoKeywords || "No keywords in this group yet — paste some above."}
        </Text>
      );
    }
    const headings: { title: string }[] = [
      { title: k.colKeyword },
      { title: k.colLocale },
      { title: k.colPriority || "Priority" },
      { title: k.colAssignments || "Assignments" },
      // Move is offered in the pseudo views too — "Ohne Gruppe" is exactly
      // where a keyword tracked under the wrong language tends to sit.
      { title: "" },
    ];
    return (
      <IndexTable
        itemCount={groupDetail.keywords.length}
        selectable={!readOnly}
        selectedItemsCount={readOnly ? undefined : allResourcesSelected ? "All" : selectedResources.length}
        onSelectionChange={readOnly ? undefined : handleSelectionChange}
        promotedBulkActions={
          readOnly ? undefined : [{ content: k.assign.assignSelection, onAction: openAssignForSelection }]
        }
        headings={headings as [{ title: string }, ...{ title: string }[]]}
      >
        {groupDetail.keywords.map((gk, index) => (
          <IndexTable.Row
            id={gk.keywordId}
            key={gk.keywordId}
            position={index}
            selected={!readOnly && selectedResources.includes(gk.keywordId)}
          >
            <IndexTable.Cell>
              <InlineStack gap="100" blockAlign="center" wrap={false}>
                <Text as="span" variant="bodyMd">
                  {gk.keyword}
                </Text>
                {gk.intent && <Badge>{intentLabel(gk.intent) ?? gk.intent}</Badge>}
              </InlineStack>
            </IndexTable.Cell>
            <IndexTable.Cell>
              <Badge>{localeName(gk.locale)}</Badge>
            </IndexTable.Cell>
            <IndexTable.Cell>
              {readOnly ? (
                <Text as="span" variant="bodySm">
                  {priorityOptions.find((o) => o.value === String(gk.priority))?.label ?? String(gk.priority)}
                </Text>
              ) : (
                <div style={{ minWidth: "110px" }}>
                  <Select
                    label={k.colPriority || "Priority"}
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
              <Text as="span" variant="bodySm">
                {gk.assignmentCount}
              </Text>
            </IndexTable.Cell>
            <IndexTable.Cell>
              <InlineStack gap="200" blockAlign="center" wrap={false}>
                <Button
                  variant="plain"
                  disabled={moveFetcher.state !== "idle"}
                  onClick={() =>
                    openMoveModal({ keywordId: gk.keywordId, keyword: gk.keyword, locale: gk.locale })
                  }
                >
                  {/* From a pseudo view there is no source group to leave, so
                      the same-language case ADDS the keyword to a group — the
                      label says so rather than promising a move. */}
                  {readOnly ? k.assignToGroup || "Assign" : k.moveKeyword || "Move"}
                </Button>
                {!readOnly && (
                  <Button
                    variant="plain"
                    tone="critical"
                    disabled={groupFetcher.state !== "idle"}
                    onClick={() =>
                      groupDetail &&
                      groupFetcher.submit(
                        {
                          actionType: "removeFromGroup",
                          groupId: groupDetail.id,
                          keywordId: gk.keywordId,
                        },
                        { method: "post" },
                      )
                    }
                  >
                    {k.groupRemoveKeyword || "Remove"}
                  </Button>
                )}
              </InlineStack>
            </IndexTable.Cell>
          </IndexTable.Row>
        ))}
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
        <Text as="h3" variant="headingMd">
          {`${pseudoTitle} (${groupDetail.keywords.length})`}
        </Text>
        {renderKeywordTable(true)}
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
          <InlineStack gap="200">
            <Button
              variant="primary"
              disabled={!!runningDistribution || groupDetail.keywords.length === 0}
              onClick={() =>
                openAssignPanel(
                  groupDetail.keywords.map((gk) => ({ keywordId: gk.keywordId, keyword: gk.keyword })),
                )
              }
            >
              {k.distributeButton || "Distribute onto items"}
            </Button>
            <Button
              disabled={!!runningDistribution || unassignedKeywords.length === 0}
              onClick={() =>
                openAssignPanel(
                  unassignedKeywords.map((gk) => ({ keywordId: gk.keywordId, keyword: gk.keyword })),
                )
              }
            >
              {k.assign.redistribute}
            </Button>
            <Button tone="critical" variant="plain" onClick={handleDeleteGroup}>
              {k.groupDelete || "Delete group"}
            </Button>
            <HelpTooltip helpKey="keywordsDistribute" position="below" />
          </InlineStack>
        </InlineStack>
        {unassignedKeywords.length === 0 && groupDetail.keywords.length > 0 && (
          <Text as="p" variant="bodySm" tone="subdued">
            {k.assign.redistributeNone}
          </Text>
        )}

        {/* Running distribution progress */}
        {runningDistribution && (
          <Banner tone="info">
            <BlockStack gap="150">
              <Text as="p" variant="bodyMd">
                {(runningDistribution.fieldType === "apply"
                  ? k.distApplyRunning || "Applying accepted assignments… ({progress}%)"
                  : k.distSuggestRunning || "AI distribution is running… ({progress}%)"
                ).replace("{progress}", String(runningDistribution.progress ?? 0))}
              </Text>
              <ProgressBar progress={runningDistribution.progress ?? 0} size="small" />
            </BlockStack>
          </Banner>
        )}
        {distFetcher.data && !distFetcher.data.success && (
          <Banner tone="critical">
            {distFetcher.data.code === "ALREADY_RUNNING"
              ? k.distAlreadyRunning || "A distribution is already running — check the Tasks tab."
              : distFetcher.data.error || k.errorGeneric}
          </Banner>
        )}

        {/* ONE bulk-paste box — replaces the old CSV field + single-add field */}
        <KeywordPaste k={k} groupId={groupDetail.id} groupFetcher={groupFetcher} priorityOptions={priorityOptions} />

        {/* Group keywords */}
        {renderKeywordTable(false)}

        {/* Bulk priority (plan §5.1 group bulk actions) */}
        {groupDetail.keywords.length > 1 && (
          <InlineStack gap="200" blockAlign="end" wrap>
            <div style={{ minWidth: "150px" }}>
              <Select
                label={k.bulkPriorityLabel || "Set priority for ALL"}
                options={priorityOptions}
                value={bulkPriority}
                onChange={setBulkPriority}
              />
            </div>
            <Button loading={groupFetcher.state !== "idle"} onClick={handleApplyBulkPriority}>
              {k.bulkPriorityApply || "Apply to all"}
            </Button>
          </InlineStack>
        )}

        {/* Distribution preview (plan §5.4 step 4 — never auto-applied) */}
        {distributionPreview && (
          <BlockStack gap="200">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h4" variant="headingSm">
                {k.distPreviewTitle || "Distribution suggestions"}
              </Text>
              <Button
                variant="plain"
                onClick={() => {
                  const next: DecisionMap = {};
                  for (const s of distributionPreview?.suggestions ?? []) {
                    next[s.keyword] = s.primaryItemId ? "accept" : "reject";
                  }
                  setDecisions(next);
                }}
              >
                {k.distAcceptAll || "Accept all"}
              </Button>
            </InlineStack>
            {distributionPreview.failedBatches > 0 && (
              <Banner tone="warning">
                {(k.distFailedBatches ||
                  "{failed} of {total} AI calls failed — their items received no suggestions.")
                  .replace("{failed}", String(distributionPreview.failedBatches))
                  .replace("{total}", String(distributionPreview.batches))}
              </Banner>
            )}
            <IndexTable
              itemCount={distributionPreview.suggestions.length}
              selectable={false}
              headings={[
                { title: k.distColDecision || "Decision" },
                { title: k.colKeyword },
                { title: k.distColPrimary || "Primary suggestion" },
                { title: k.distColSecondaries || "Secondaries" },
                { title: k.distColConfidence || "Confidence" },
              ]}
            >
              {distributionPreview.suggestions.map((s, index) => {
                const titles = distributionPreview?.itemTitles ?? {};
                return (
                  <IndexTable.Row id={s.keyword} key={s.keyword} position={index}>
                    <IndexTable.Cell>
                      <div style={{ minWidth: "140px" }}>
                        <Select
                          label={k.distColDecision || "Decision"}
                          labelHidden
                          disabled={!s.primaryItemId && s.secondaryItemIds.length === 0}
                          options={[
                            { label: k.distDecisionAccept || "Accept", value: "accept" },
                            { label: k.distDecisionSecondary || "As secondary only", value: "secondaryOnly" },
                            { label: k.distDecisionReject || "Reject", value: "reject" },
                          ]}
                          value={decisions[s.keyword] ?? "reject"}
                          onChange={(v) =>
                            setDecisions((prev) => ({
                              ...prev,
                              [s.keyword]: v as "accept" | "secondaryOnly" | "reject",
                            }))
                          }
                        />
                      </div>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" variant="bodyMd">
                        {s.keyword}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" variant="bodySm" tone={s.primaryItemId ? undefined : "subdued"}>
                        {s.primaryItemId ? titles[s.primaryItemId] || s.primaryItemId : k.distNoMatch || "no match"}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {s.secondaryItemIds.map((id) => titles[id] || id).join(", ") || "–"}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Badge tone={s.confidence >= 0.6 ? "success" : undefined}>
                        {`${Math.round(s.confidence * 100)}%`}
                      </Badge>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                );
              })}
            </IndexTable>
            <InlineStack gap="300" blockAlign="center" wrap>
              <Checkbox
                label={k.distDemoteExisting || "Replace existing primary keywords (demote them to secondary)"}
                checked={demoteExisting}
                onChange={setDemoteExisting}
              />
              <Button
                variant="primary"
                loading={distFetcher.state !== "idle"}
                disabled={!!runningDistribution || !Object.values(decisions).some((d) => d !== "reject")}
                onClick={applyDistribution}
              >
                {k.distApply || "Apply accepted"}
              </Button>
            </InlineStack>
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );

  return (
    <BlockStack gap="400">
      {/* Research on top (plan §2.1) — collapsible, language follows the navbar. */}
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
        k={k}
        assignFetcher={assignFetcher}
        startDistribution={startDistribution}
        runningDistribution={runningDistribution}
      />

      {/* Move a keyword to another group and/or language. A language change
          merges the keyword into the target language and carries its item
          assignments along — hence the warning below. */}
      <Modal
        open={!!moveModal}
        onClose={closeMoveModal}
        title={k.moveModalTitle || "Move keyword"}
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
              {(k.moveModalBody || "Move “{keyword}” to another language or group.").replace(
                "{keyword}",
                moveModal?.keyword ?? "",
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
            {moveModal && moveTargetLocale !== moveModal.locale && (
              <Banner tone="warning">
                {(
                  k.moveLocaleWarning ||
                  "The keyword and its item assignments move to {locale}. Assignments are dropped where the item already tracks this keyword there or has reached its keyword limit."
                ).replace("{locale}", localeName(moveTargetLocale))}
              </Banner>
            )}
            {moveFetcher.state === "idle" && moveFetcher.data && !moveFetcher.data.ok && (
              <Banner tone="critical">{k.errorGeneric}</Banner>
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </BlockStack>
  );
}
