/**
 * AssignmentsTab — presentational half of the Keywords section (Phase 1 split
 * of app.seo.keywords.tsx). Renders the "Zuordnungen" view: cannibalization
 * conflicts, the add-keyword form, and the tracked-keywords IndexTable.
 *
 * PURE PRESENTATION. All state, fetchers, refs, effects and confirm-dialog
 * flows live in the Shell (SeoKeywords); this component only renders JSX and
 * calls the callbacks / fetchers it is handed. Behaviour is identical to the
 * pre-split route.
 */

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
  Autocomplete,
} from "@shopify/polaris";
import type { FetcherWithComponents } from "@remix-run/react";
import { scoreTone } from "../../../utils/seo-score";
import type {
  KeywordResourceType,
  KeywordRole,
  DensityBand,
} from "../../../services/seo/keywords.service";
import type { Translation } from "../../../i18n/de";
import type { SerializeFrom } from "@remix-run/node";
import type { loader, ActionResult } from "../../../routes/app.seo.keywords";

type LoaderData = SerializeFrom<typeof loader>;
type KeywordsPageStrings = Translation["seo"]["keywordsPage"];

const DENSITY_TONE: Record<DensityBand, "success" | "warning" | "critical" | undefined> = {
  ok: "success",
  low: "warning",
  high: "critical",
  none: undefined,
};

export interface AssignmentsTabProps {
  k: KeywordsPageStrings;
  conflicts: LoaderData["conflicts"];
  isPro: boolean;
  unclassifiedCount: number;

  // Add-keyword form
  typeOptions: { label: string; value: string }[];
  type: KeywordResourceType;
  setType: (t: KeywordResourceType) => void;
  itemId: string;
  setItemId: (id: string) => void;
  itemInputValue: string;
  setItemInputValue: (v: string) => void;
  itemOptions: { label: string; value: string }[];
  filteredItemOptions: { label: string; value: string }[];
  keyword: string;
  setKeywordInput: (v: string) => void;
  locale: string;
  setLocale: (v: string) => void;
  localeSelectOptions: { label: string; value: string }[];
  role: KeywordRole;
  setRole: (r: KeywordRole) => void;
  canSave: boolean;
  handleSubmitKeyword: () => void;
  itemsCount: number;
  pickerCap: number;
  saveFetcher: FetcherWithComponents<ActionResult>;

  // Tracked keywords
  intentFilter: string;
  setIntentFilter: (v: string) => void;
  intentLabel: (intent: string | null | undefined) => string | null;
  filteredKeywords: LoaderData["keywords"];
  priorityOptions: { label: string; value: string }[];
  rowFetcher: FetcherWithComponents<ActionResult>;
  priorityFetcher: FetcherWithComponents<ActionResult>;
  intentFetcher: FetcherWithComponents<{
    success: boolean;
    classified?: number;
    remaining?: number;
    error?: string;
  }>;
  pendingRowId: string | null;
  handleMakePrimary: (row: { id: string }) => void;
  handleDeleteKeyword: (row: { id: string; keyword: string }) => void;
  openInEditor: (row: { resourceType: string; resourceId: string }) => void;
}

export function AssignmentsTab({
  k,
  conflicts,
  isPro,
  unclassifiedCount,
  typeOptions,
  type,
  setType,
  itemId,
  setItemId,
  itemInputValue,
  setItemInputValue,
  itemOptions,
  filteredItemOptions,
  keyword,
  setKeywordInput,
  locale,
  setLocale,
  localeSelectOptions,
  role,
  setRole,
  canSave,
  handleSubmitKeyword,
  itemsCount,
  pickerCap,
  saveFetcher,
  intentFilter,
  setIntentFilter,
  intentLabel,
  filteredKeywords,
  priorityOptions,
  rowFetcher,
  priorityFetcher,
  intentFetcher,
  pendingRowId,
  handleMakePrimary,
  handleDeleteKeyword,
  openInEditor,
}: AssignmentsTabProps) {
  return (
    <BlockStack gap="400">
      {/* Cannibalization conflicts (plan §7.1) */}
      {conflicts.length > 0 && (
        <Card>
          <BlockStack gap="200">
            <Text as="h3" variant="headingMd">
              {k.conflictsTitle || "Keyword conflicts"}
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              {k.conflictsIntro ||
                "The same primary keyword on several items of the same type makes them compete against each other in Google."}
            </Text>
            {conflicts.map((c) => (
              <Banner key={`${c.keyword}:${c.resourceType}:${c.locale}`} tone="warning">
                <Text as="p" variant="bodyMd">
                  {(k.conflictItem || '"{keyword}" is primary on {count} {type} items: {items}')
                    .replace("{keyword}", c.keyword)
                    .replace("{count}", String(c.itemTitles.length))
                    .replace("{type}", k.types[c.resourceType as KeywordResourceType] || c.resourceType)
                    .replace("{items}", c.itemTitles.join(", "))}
                </Text>
              </Banner>
            ))}
          </BlockStack>
        </Card>
      )}

      {/* Add keyword */}
      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingMd">
            {k.addTitle}
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            {k.intro}
          </Text>
          <InlineStack gap="200" blockAlign="end" wrap>
            <div style={{ minWidth: "140px" }}>
              <Select
                label={k.typeLabel}
                options={typeOptions}
                value={type}
                onChange={(v) => {
                  setType(v as KeywordResourceType);
                  setItemId("");
                  setItemInputValue("");
                }}
              />
            </div>
            <div style={{ flex: "1 1 240px" }}>
              <Autocomplete
                options={filteredItemOptions}
                selected={itemId ? [itemId] : []}
                onSelect={(selected) => {
                  const id = selected[0] ?? "";
                  setItemId(id);
                  const match = itemOptions.find((o) => o.value === id);
                  setItemInputValue(match ? match.label : "");
                }}
                textField={
                  <Autocomplete.TextField
                    label={k.itemLabel}
                    autoComplete="off"
                    placeholder={k.selectItem}
                    value={itemInputValue}
                    onChange={(value) => {
                      setItemInputValue(value);
                      // Typing invalidates the previously selected id until a
                      // new option is chosen from the (re-filtered) list.
                      if (itemId) setItemId("");
                    }}
                  />
                }
              />
            </div>
            <div style={{ flex: "1 1 200px" }}>
              <TextField
                label={k.keywordLabel}
                autoComplete="off"
                placeholder={k.keywordPlaceholder}
                value={keyword}
                onChange={setKeywordInput}
              />
            </div>
            <div style={{ minWidth: "160px" }}>
              <Select
                label={k.localeLabel}
                options={localeSelectOptions}
                value={locale}
                onChange={setLocale}
              />
            </div>
            <div style={{ minWidth: "150px" }}>
              <Select
                label={k.roleLabel || "Role"}
                options={[
                  { label: k.role?.primary || "Primary", value: "primary" },
                  { label: k.role?.secondary || "Secondary", value: "secondary" },
                ]}
                value={role}
                onChange={(v) => setRole(v as KeywordRole)}
              />
            </div>
            <Button
              variant="primary"
              disabled={!canSave}
              loading={saveFetcher.state !== "idle"}
              onClick={handleSubmitKeyword}
            >
              {k.addButton}
            </Button>
          </InlineStack>
          {saveFetcher.data && !saveFetcher.data.ok && saveFetcher.data.error === "tooMany" && (
            <Banner tone="warning">
              {k.tooManyKeywords ||
                "This item already tracks the maximum number of keywords for this locale."}
            </Banner>
          )}
          {itemsCount >= pickerCap && (
            <Text as="p" variant="bodySm" tone="subdued">
              {k.pickerCapped.replace("{cap}", String(pickerCap))}
            </Text>
          )}
        </BlockStack>
      </Card>

      {/* Tracked keywords */}
      <Card>
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="end" wrap>
            <Text as="h3" variant="headingMd">
              {k.listTitle}
            </Text>
            <InlineStack gap="200" blockAlign="end" wrap>
              <div style={{ minWidth: "170px" }}>
                <Select
                  label={k.intentFilterLabel || "Intent"}
                  options={[
                    { label: k.intentFilterAll || "All intents", value: "all" },
                    { label: k.intentFilterNone || "Unclassified", value: "none" },
                    ...(["informational", "commercial", "transactional", "navigational"] as const).map((i) => ({
                      label: intentLabel(i) ?? i,
                      value: i,
                    })),
                  ]}
                  value={intentFilter}
                  onChange={setIntentFilter}
                />
              </div>
              {isPro && unclassifiedCount > 0 && (
                <Button
                  loading={intentFetcher.state !== "idle"}
                  onClick={() =>
                    intentFetcher.submit(
                      { action: "classifyKeywordIntents", contentType: "products" },
                      { method: "post", action: "/api/ai" },
                    )
                  }
                >
                  {(k.classifyButton || "Classify intent ({count} open)").replace(
                    "{count}",
                    String(unclassifiedCount),
                  )}
                </Button>
              )}
            </InlineStack>
          </InlineStack>
          {intentFetcher.state === "idle" && intentFetcher.data?.success && (
            <Banner tone="success">
              {(k.classifyDone || "{count} keyword(s) classified, {remaining} remaining.")
                .replace("{count}", String(intentFetcher.data.classified ?? 0))
                .replace("{remaining}", String(intentFetcher.data.remaining ?? 0))}
            </Banner>
          )}
          {rowFetcher.data && !rowFetcher.data.ok && <Banner tone="critical">{k.errorGeneric}</Banner>}

          {filteredKeywords.length === 0 ? (
            <Text as="p" tone="subdued">
              {k.noKeywords}
            </Text>
          ) : (
            <BlockStack gap="200">
              <IndexTable
                itemCount={filteredKeywords.length}
                selectable={false}
                headings={[
                  { title: k.colItem },
                  { title: k.colKeyword },
                  { title: k.colRole || "Role" },
                  { title: k.colLocale },
                  { title: k.colPriority || "Priority" },
                  { title: k.colScore },
                  { title: k.colDensity },
                  { title: k.colPresence },
                  { title: k.colGscPosition },
                  { title: "" },
                ]}
              >
                {filteredKeywords.map((row, index) => (
                  <IndexTable.Row id={row.id} key={row.id} position={index}>
                    <IndexTable.Cell>
                      <div style={{ maxWidth: "240px" }}>
                        <Text as="span" variant="bodyMd" truncate>
                          {row.itemMissing ? k.itemMissing : row.itemTitle || row.resourceId}
                        </Text>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {" "}
                          {k.types[row.resourceType as KeywordResourceType] || row.resourceType}
                        </Text>
                      </div>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <InlineStack gap="100" blockAlign="center" wrap={false}>
                        <Text as="span" variant="bodyMd">{row.keyword}</Text>
                        {row.intent && <Badge>{intentLabel(row.intent) ?? row.intent}</Badge>}
                      </InlineStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Badge tone={row.role === "primary" ? "info" : undefined}>
                        {row.role === "primary"
                          ? k.role?.primary || "Primary"
                          : k.role?.secondary || "Secondary"}
                      </Badge>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Badge>{row.localeDisplay || "–"}</Badge>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <div style={{ minWidth: "110px" }}>
                        <Select
                          label={k.colPriority || "Priority"}
                          labelHidden
                          options={priorityOptions}
                          value={String(row.priority)}
                          disabled={priorityFetcher.state !== "idle"}
                          onChange={(v) =>
                            priorityFetcher.submit(
                              { actionType: "setPriority", keywordId: row.keywordId, priority: v },
                              { method: "post" },
                            )
                          }
                        />
                      </div>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {row.score == null ? (
                        // Secondaries carry no 0-100 score — it is
                        // presence-weighted for ONE target keyword and would
                        // dilute across several (§3.1).
                        <Text as="span" variant="bodyMd" tone="subdued">
                          –
                        </Text>
                      ) : (
                        <Badge tone={scoreTone(row.score) as any}>{String(row.score)}</Badge>
                      )}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Badge tone={DENSITY_TONE[row.densityBand as DensityBand]}>
                        {`${k.density[row.densityBand as DensityBand]} (${row.densityPct}%)`}
                      </Badge>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <InlineStack gap="100" wrap>
                        {(["title", "h1", "metaDescription", "seoTitle", "body"] as const).map((key) => (
                          <Badge key={key} tone={row.presence[key] ? "success" : undefined}>
                            {k.presence[key]}
                          </Badge>
                        ))}
                      </InlineStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" variant="bodyMd" tone={row.gscPosition == null ? "subdued" : undefined}>
                        {row.gscPosition == null ? "–" : row.gscPosition.toFixed(1)}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <InlineStack gap="200" align="end" wrap={false}>
                        <Button
                          variant="plain"
                          onClick={() => openInEditor(row)}
                          disabled={row.itemMissing}
                        >
                          {k.openInEditor}
                        </Button>
                        {row.role === "secondary" && (
                          <Button
                            variant="plain"
                            loading={rowFetcher.state !== "idle" && pendingRowId === row.id}
                            disabled={rowFetcher.state !== "idle" && pendingRowId !== row.id}
                            onClick={() => handleMakePrimary(row)}
                          >
                            {k.makePrimary || "Make primary"}
                          </Button>
                        )}
                        <Button
                          variant="plain"
                          tone="critical"
                          loading={rowFetcher.state !== "idle" && pendingRowId === row.id}
                          disabled={rowFetcher.state !== "idle" && pendingRowId !== row.id}
                          onClick={() => handleDeleteKeyword(row)}
                        >
                          {k.delete}
                        </Button>
                      </InlineStack>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
              <Text as="p" variant="bodySm" tone="subdued">
                {k.gscHint}
              </Text>
            </BlockStack>
          )}
        </BlockStack>
      </Card>
    </BlockStack>
  );
}
