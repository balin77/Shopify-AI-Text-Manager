/**
 * LibraryTab — presentational half of the Keywords section (Phase 1 split of
 * app.seo.keywords.tsx). Renders the "Bibliothek" view: keyword groups, keyword
 * research, the selected group's detail (keywords, bulk actions, add, CSV
 * import, AI-distribution preview) and the distribution modal.
 *
 * PURE PRESENTATION. All state, fetchers, refs, effects and confirm-dialog
 * flows live in the Shell (SeoKeywords); this component only renders JSX and
 * calls the callbacks / fetchers it is handed. Behaviour is identical to the
 * pre-split route.
 */

import type { Dispatch, SetStateAction } from "react";
import {
  Card,
  BlockStack,
  InlineStack,
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

type LoaderData = SerializeFrom<typeof loader>;
type KeywordsPageStrings = Translation["seo"]["keywordsPage"];
type DecisionMap = Record<string, "accept" | "secondaryOnly" | "reject">;

const RESOURCE_TYPES: KeywordResourceType[] = ["Product", "Collection", "Article", "Page"];

export interface LibraryTabProps {
  k: KeywordsPageStrings;
  groups: LoaderData["groups"];
  groupDetail: LoaderData["groupDetail"];
  isPro: boolean;
  runningDistribution: LoaderData["runningDistribution"];
  distributionPreview: LoaderData["distributionPreview"];
  suggestTaskId: LoaderData["suggestTaskId"];
  researchAvailability: LoaderData["researchAvailability"];
  productTypes: LoaderData["productTypes"];
  itemCounts: LoaderData["itemCounts"];
  localeOptions: LoaderData["localeOptions"];
  localeSelectOptions: { label: string; value: string }[];
  priorityOptions: { label: string; value: string }[];
  intentLabel: (intent: string | null | undefined) => string | null;
  selectGroup: (groupId: string | null) => void;

  // Group create
  newGroupName: string;
  setNewGroupName: (v: string) => void;
  groupFetcher: FetcherWithComponents<ActionResult>;

  // Research
  seedInput: string;
  setSeedInput: (v: string) => void;
  seedHl: string;
  setSeedHl: (v: string) => void;
  hlOptions: { label: string; value: string }[];
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
  groupKeywordInput: string;
  setGroupKeywordInput: (v: string) => void;
  groupKeywordLocale: string;
  setGroupKeywordLocale: (v: string) => void;
  csvText: string;
  setCsvText: (v: string) => void;
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
  groupDetail,
  isPro,
  runningDistribution,
  distributionPreview,
  suggestTaskId,
  researchAvailability,
  productTypes,
  itemCounts,
  localeOptions,
  localeSelectOptions,
  priorityOptions,
  intentLabel,
  selectGroup,
  newGroupName,
  setNewGroupName,
  groupFetcher,
  seedInput,
  setSeedInput,
  seedHl,
  setSeedHl,
  hlOptions,
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
  groupKeywordInput,
  setGroupKeywordInput,
  groupKeywordLocale,
  setGroupKeywordLocale,
  csvText,
  setCsvText,
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
  const renderSuggestionGroup = (title: string, list: string[]) =>
    list.length === 0 ? null : (
      <BlockStack gap="150" key={title}>
        <Text as="h4" variant="headingSm">
          {title}
        </Text>
        <InlineStack gap="200" wrap>
          {list.map((s) => (
            <Checkbox key={s} label={s} checked={selectedSuggestions.has(s)} onChange={() => toggleSuggestion(s)} />
          ))}
        </InlineStack>
      </BlockStack>
    );

  return (
    <BlockStack gap="400">
      {/* ── Keyword groups (plan §5.1) ── */}
      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingMd">
            {k.groupsTitle || "Keyword groups"}
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            {k.groupsIntro ||
              "Groups are management containers: import keyword lists, then distribute them onto items with AI."}
          </Text>
          <InlineStack gap="200" blockAlign="end" wrap>
            <div style={{ flex: "1 1 240px", maxWidth: "360px" }}>
              <TextField
                label={k.groupNameLabel || "New group"}
                autoComplete="off"
                placeholder={k.groupNamePlaceholder || "e.g. Vases 2026"}
                value={newGroupName}
                onChange={setNewGroupName}
                maxLength={100}
              />
            </div>
            <Button
              loading={groupFetcher.state !== "idle"}
              disabled={!newGroupName.trim()}
              onClick={() => {
                groupFetcher.submit({ actionType: "createGroup", name: newGroupName }, { method: "post" });
                setNewGroupName("");
              }}
            >
              {k.groupCreate || "Create group"}
            </Button>
          </InlineStack>
          {groupFetcher.data && !groupFetcher.data.ok && groupFetcher.data.error === "duplicateName" && (
            <Banner tone="warning">{k.groupDuplicateName || "A group with this name already exists."}</Banner>
          )}
          {groupFetcher.data && !groupFetcher.data.ok && groupFetcher.data.error === "invalid" && (
            <Banner tone="critical">{k.errorGeneric}</Banner>
          )}
          {groups.length === 0 ? (
            <Text as="p" tone="subdued">
              {k.noGroups || "No groups yet."}
            </Text>
          ) : (
            <InlineStack gap="200" wrap>
              {groups.map((g) => (
                <Button
                  key={g.id}
                  pressed={groupDetail?.id === g.id}
                  onClick={() => selectGroup(groupDetail?.id === g.id ? null : g.id)}
                >
                  {`${g.name} (${g.keywordCount})`}
                </Button>
              ))}
            </InlineStack>
          )}
        </BlockStack>
      </Card>

      {/* ── Keyword research (plan §6) — free autocomplete suggestions ── */}
      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingMd">
            {k.researchTitle || "Keyword research"}
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            {k.researchIntro ||
              "Get free long-tail suggestions from Google Autocomplete for a seed keyword, then import them into a group."}
          </Text>
          {/* Integrated §6.1 spike verdict: the server probes reachability
              in the background; a blocked egress IP disables the panel. */}
          {researchAvailability.status === "blocked" && (
            <Banner tone="warning">
              {k.researchBlocked ||
                "Google is currently not answering suggestion requests from this server. Try again later."}
              {researchAvailability.checkedAt
                ? ` ${(k.researchCheckedAt || "Last checked: {time}").replace(
                    "{time}",
                    new Date(researchAvailability.checkedAt).toLocaleString(),
                  )}`
                : ""}
            </Banner>
          )}
          <InlineStack gap="200" blockAlign="end" wrap>
            <div style={{ flex: "1 1 220px", maxWidth: "340px" }}>
              <TextField
                label={k.researchSeedLabel || "Seed keyword"}
                autoComplete="off"
                placeholder={k.keywordPlaceholder}
                value={seedInput}
                onChange={setSeedInput}
              />
            </div>
            <div style={{ minWidth: "110px" }}>
              <Select label={k.researchLangLabel || "Language"} options={hlOptions} value={seedHl} onChange={setSeedHl} />
            </div>
            <Button
              loading={suggestFetcher.state !== "idle"}
              disabled={!seedInput.trim() || researchAvailability.status === "blocked"}
              onClick={() => runResearch(false)}
            >
              {k.researchButton || "Get suggestions"}
            </Button>
            {suggestFetcher.data?.ok && (
              <Button variant="plain" loading={suggestFetcher.state !== "idle"} onClick={() => runResearch(true)}>
                {k.researchMore || "Load alphabet expansion (a–z)"}
              </Button>
            )}
          </InlineStack>

          {suggestFetcher.state === "idle" && suggestFetcher.data && !suggestFetcher.data.ok && (
            <Banner tone={suggestFetcher.data.error === "invalid" ? "critical" : "warning"}>
              {suggestFetcher.data.error === "rateLimited"
                ? k.researchRateLimited || "Please wait a moment — at most 3 searches per minute."
                : suggestFetcher.data.error === "blocked"
                  ? k.researchBlocked ||
                    "Google is currently not answering suggestion requests from this server. Try again later."
                  : k.errorGeneric}
            </Banner>
          )}

          {suggestFetcher.state === "idle" && suggestFetcher.data?.ok && suggestFetcher.data.groups && (
            <BlockStack gap="300">
              {suggestFetcher.data.groups.direct.length === 0 &&
              suggestFetcher.data.groups.questions.length === 0 &&
              suggestFetcher.data.groups.alphabet.length === 0 ? (
                <Text as="p" tone="subdued">
                  {k.researchNoResults || "No suggestions found for this seed."}
                </Text>
              ) : (
                <>
                  {renderSuggestionGroup(k.researchDirect || "Direct suggestions", suggestFetcher.data.groups.direct)}
                  {renderSuggestionGroup(k.researchQuestions || "Questions", suggestFetcher.data.groups.questions)}
                  {renderSuggestionGroup(
                    k.researchAlphabet || "Alphabet expansion",
                    suggestFetcher.data.groups.alphabet,
                  )}
                  <InlineStack gap="200" blockAlign="end" wrap>
                    <div style={{ minWidth: "220px" }}>
                      <Select
                        label={k.researchImportGroup || "Import into group"}
                        options={[
                          { label: k.researchImportGroupNone || "Choose a group…", value: "" },
                          ...groups.map((g) => ({ label: g.name, value: g.id })),
                        ]}
                        value={importGroupId}
                        onChange={setImportGroupId}
                      />
                    </div>
                    <Button
                      variant="primary"
                      loading={groupFetcher.state !== "idle"}
                      disabled={!importGroupId || selectedSuggestions.size === 0}
                      onClick={importSelectedSuggestions}
                    >
                      {(k.researchImportButton || "Import {count} selected").replace(
                        "{count}",
                        String(selectedSuggestions.size),
                      )}
                    </Button>
                  </InlineStack>
                </>
              )}
            </BlockStack>
          )}
        </BlockStack>
      </Card>

      {/* ── Group detail: keywords, CSV import, AI distribution ── */}
      {groupDetail && (
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

            {/* Group keywords */}
            {groupDetail.keywords.length === 0 ? (
              <Text as="p" tone="subdued">
                {k.groupNoKeywords || "No keywords in this group yet — add one below or import a CSV."}
              </Text>
            ) : (
              <IndexTable
                itemCount={groupDetail.keywords.length}
                selectable={false}
                headings={[
                  { title: k.colKeyword },
                  { title: k.colLocale },
                  { title: k.colPriority || "Priority" },
                  { title: k.colAssignments || "Assignments" },
                  { title: "" },
                ]}
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
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" variant="bodySm">
                        {gk.assignmentCount}
                      </Text>
                    </IndexTable.Cell>
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
                  </IndexTable.Row>
                ))}
              </IndexTable>
            )}

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

            {/* Add single keyword to group */}
            <InlineStack gap="200" blockAlign="end" wrap>
              <div style={{ flex: "1 1 200px", maxWidth: "320px" }}>
                <TextField
                  label={k.groupAddKeywordLabel || "Add keyword"}
                  autoComplete="off"
                  placeholder={k.keywordPlaceholder}
                  value={groupKeywordInput}
                  onChange={setGroupKeywordInput}
                />
              </div>
              <div style={{ minWidth: "150px" }}>
                <Select
                  label={k.localeLabel}
                  options={localeSelectOptions}
                  value={groupKeywordLocale}
                  onChange={setGroupKeywordLocale}
                />
              </div>
              <Button
                loading={groupFetcher.state !== "idle"}
                disabled={!groupKeywordInput.trim()}
                onClick={() => {
                  if (!groupDetail) return;
                  groupFetcher.submit(
                    {
                      actionType: "addToGroup",
                      groupId: groupDetail.id,
                      keyword: groupKeywordInput,
                      locale: groupKeywordLocale,
                    },
                    { method: "post" },
                  );
                  setGroupKeywordInput("");
                }}
              >
                {k.groupAddKeyword || "Add"}
              </Button>
            </InlineStack>

            {/* CSV import (plan §5.3) */}
            <BlockStack gap="150">
              <TextField
                label={k.csvLabel || "CSV import (keyword[, priority][, intent][, locale])"}
                autoComplete="off"
                multiline={4}
                placeholder={k.csvPlaceholder || "keyword,priority\ngreen ceramic vase,1\nhandmade vase,2"}
                value={csvText}
                onChange={setCsvText}
                helpText={(k.csvHint || "Up to {max} rows per import.").replace("{max}", "2000")}
              />
              <InlineStack gap="200">
                <Button
                  loading={groupFetcher.state !== "idle"}
                  disabled={!csvText.trim()}
                  onClick={() => {
                    if (!groupDetail) return;
                    groupFetcher.submit(
                      { actionType: "importCsv", groupId: groupDetail.id, csv: csvText },
                      { method: "post" },
                    );
                    setCsvText("");
                  }}
                >
                  {k.csvImport || "Import CSV"}
                </Button>
              </InlineStack>
              {groupFetcher.data?.ok && groupFetcher.data.kind === "csvImported" && (
                <Banner tone={groupFetcher.data.csvErrors.length ? "warning" : "success"}>
                  <BlockStack gap="100">
                    <Text as="p" variant="bodyMd">
                      {(k.csvResult || "{added} imported, {existing} already in the group.")
                        .replace("{added}", String(groupFetcher.data.added))
                        .replace("{existing}", String(groupFetcher.data.alreadyInGroup))}
                    </Text>
                    {groupFetcher.data.csvErrors.map((e) => (
                      <Text key={`${e.row}:${e.keyword}`} as="p" variant="bodySm">
                        {(k.csvErrorRow || 'Row {row}: "{keyword}" — {error}')
                          .replace("{row}", String(e.row))
                          .replace("{keyword}", e.keyword)
                          .replace("{error}", k.csvErrors?.[e.error] ?? e.error)}
                      </Text>
                    ))}
                  </BlockStack>
                </Banner>
              )}
              {groupFetcher.data && !groupFetcher.data.ok && groupFetcher.data.error === "csvTooMany" && (
                <Banner tone="critical">
                  {(k.csvTooMany || "A single import is limited to {max} rows.").replace("{max}", "2000")}
                </Banner>
              )}
            </BlockStack>

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
                            {s.primaryItemId
                              ? titles[s.primaryItemId] || s.primaryItemId
                              : k.distNoMatch || "no match"}
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
                    disabled={
                      !!runningDistribution ||
                      !Object.values(decisions).some((d) => d !== "reject")
                    }
                    onClick={applyDistribution}
                  >
                    {k.distApply || "Apply accepted"}
                  </Button>
                </InlineStack>
              </BlockStack>
            )}
          </BlockStack>
        </Card>
      )}

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
