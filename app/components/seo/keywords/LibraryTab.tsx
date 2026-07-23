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
  Modal,
  Checkbox,
  ProgressBar,
} from "@shopify/polaris";
import type { FetcherWithComponents } from "@remix-run/react";
import type { SerializeFrom } from "@remix-run/node";
import type { KeywordResourceType } from "../../../services/seo/keywords.service";
import type { Translation } from "../../../i18n/de";
import type { loader, ActionResult } from "../../../routes/app.seo.keywords";
import { GroupSidebar } from "./GroupSidebar";
import { KeywordPaste } from "./KeywordPaste";
import { ResearchPanel } from "./ResearchPanel";

type LoaderData = SerializeFrom<typeof loader>;
type KeywordsPageStrings = Translation["seo"]["keywordsPage"];
type DecisionMap = Record<string, "accept" | "secondaryOnly" | "reject">;

const RESOURCE_TYPES: KeywordResourceType[] = ["Product", "Collection", "Article", "Page"];

export interface LibraryTabProps {
  k: KeywordsPageStrings;
  groups: LoaderData["groups"];
  allCount: number;
  ungroupedCount: number;
  groupDetail: LoaderData["groupDetail"];
  isPro: boolean;
  runningDistribution: LoaderData["runningDistribution"];
  distributionPreview: LoaderData["distributionPreview"];
  researchAvailability: LoaderData["researchAvailability"];
  productTypes: LoaderData["productTypes"];
  itemCounts: LoaderData["itemCounts"];
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
  setShowDistModal: (v: boolean) => void;
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

  // Distribution modal
  showDistModal: boolean;
  startDistribution: () => void;
  distTargetType: KeywordResourceType;
  setDistTargetType: (t: KeywordResourceType) => void;
  distMaxSecondaries: string;
  setDistMaxSecondaries: (v: string) => void;
  distFilterProductType: string;
  setDistFilterProductType: (v: string) => void;
  distCost: { batches: number; usd: number } | null;
}

export function LibraryTab({
  k,
  groups,
  allCount,
  ungroupedCount,
  groupDetail,
  isPro,
  runningDistribution,
  distributionPreview,
  researchAvailability,
  productTypes,
  itemCounts,
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
  setShowDistModal,
  distFetcher,
  decisions,
  setDecisions,
  demoteExisting,
  setDemoteExisting,
  applyDistribution,
  showDistModal,
  startDistribution,
  distTargetType,
  setDistTargetType,
  distMaxSecondaries,
  setDistMaxSecondaries,
  distFilterProductType,
  setDistFilterProductType,
  distCost,
}: LibraryTabProps) {
  const isPseudo = !!groupDetail?.pseudo;
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
    ];
    if (!readOnly) headings.push({ title: "" });
    return (
      <IndexTable
        itemCount={groupDetail.keywords.length}
        selectable={false}
        headings={headings as [{ title: string }, ...{ title: string }[]]}
      >
        {groupDetail.keywords.map((gk, index) => (
          <IndexTable.Row id={gk.keywordId} key={gk.keywordId} position={index}>
            <IndexTable.Cell>
              <InlineStack gap="100" blockAlign="center" wrap={false}>
                <Text as="span" variant="bodyMd">
                  {gk.keyword}
                </Text>
                {gk.intent && <Badge>{intentLabel(gk.intent) ?? gk.intent}</Badge>}
              </InlineStack>
            </IndexTable.Cell>
            <IndexTable.Cell>
              <Badge>{gk.locale || localeOptions[0]?.name || "–"}</Badge>
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
            {!readOnly && (
              <IndexTable.Cell>
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
              </IndexTable.Cell>
            )}
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
              disabled={!isPro || !!runningDistribution || groupDetail.keywords.length === 0}
              onClick={() => setShowDistModal(true)}
            >
              {k.distributeButton || "Distribute onto items"}
            </Button>
            <Button tone="critical" variant="plain" onClick={handleDeleteGroup}>
              {k.groupDelete || "Delete group"}
            </Button>
          </InlineStack>
        </InlineStack>
        {!isPro && (
          <Text as="p" variant="bodySm" tone="subdued">
            {k.distributeProHint || "AI distribution requires the Pro plan."}
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

      {/* Distribution modal (plan §5.4): target + rules + cost preview */}
      <Modal
        open={showDistModal}
        onClose={() => setShowDistModal(false)}
        title={k.distModalTitle || "Distribute keywords onto items"}
        primaryAction={{
          content: k.distModalStart || "Start distribution",
          loading: distFetcher.state !== "idle",
          onAction: startDistribution,
        }}
        secondaryActions={[{ content: k.distModalCancel || "Cancel", onAction: () => setShowDistModal(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Select
              label={k.distModalTarget || "Target type"}
              options={RESOURCE_TYPES.map((rt) => ({
                label: `${k.types[rt]} (${itemCounts[rt] ?? 0})`,
                value: rt,
              }))}
              value={distTargetType}
              onChange={(v) => setDistTargetType(v as KeywordResourceType)}
            />
            <Select
              label={k.distModalMaxSecondaries || "Max secondaries per item"}
              options={["0", "1", "2", "3", "4"].map((v) => ({ label: v, value: v }))}
              value={distMaxSecondaries}
              onChange={setDistMaxSecondaries}
            />
            {distTargetType === "Product" && productTypes.length > 0 && (
              <Select
                label={k.distModalFilterType || "Filter: product type"}
                options={[
                  { label: k.distModalFilterAll || "All", value: "" },
                  ...productTypes.map((p) => ({ label: p, value: p })),
                ]}
                value={distFilterProductType}
                onChange={setDistFilterProductType}
                helpText={
                  productTypes.length >= 100
                    ? k.distModalFilterCapped || "Only the first 100 product types are listed."
                    : undefined
                }
              />
            )}
            {distTargetType === "Product" && distFilterProductType && (
              <Text as="p" variant="bodySm" tone="subdued">
                {k.distModalFilterHint ||
                  "The cost estimate below assumes ALL items of this type — with a filter the actual cost is lower."}
              </Text>
            )}
            {distCost && (
              <Text as="p" variant="bodySm" tone={distCost.batches > 30 ? "caution" : "subdued"}>
                {(k.distCostPreview || "~{batches} AI call(s), estimated ~${usd}.")
                  .replace("{batches}", String(distCost.batches))
                  .replace("{usd}", distCost.usd.toFixed(2))}
              </Text>
            )}
            <Text as="p" variant="bodySm" tone="subdued">
              {k.distModalHint ||
                "Nothing is assigned automatically — you review every suggestion before it is applied."}
            </Text>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </BlockStack>
  );
}
