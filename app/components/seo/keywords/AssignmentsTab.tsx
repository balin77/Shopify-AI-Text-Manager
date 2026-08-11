/**
 * AssignmentsTab — presentational half of the Keywords section ("Zuordnungen").
 * Phase 5 rewrite: the flat tracked-keywords IndexTable becomes an item-grouped,
 * expandable list scoped to the active language (§2.3).
 *
 * Language is the top dimension: only rows whose `locale === activeLocale` are
 * shown. Cannibalization conflicts render as a single warning header (no card).
 * A type mini-navbar (Produkte / Collections / Seiten / Blogartikel) plus a
 * text / intent / score filter row narrow the list. Each item is a collapsible
 * header (title · type, primary on-page Score, GSC ⌀) revealing its keyword
 * rows (primary first) with presence badges, density, GSC position and per-row
 * actions, plus an inline "+ Keyword" control that assigns under the active
 * locale through the SAME saveFetcher submit path the old add-form used — so the
 * Shell's primaryExists-swap and cannibalization confirm dialogs keep working.
 *
 * PURE PRESENTATION for cross-cutting state: all fetchers, refs, confirm-dialog
 * flows and the submit helper live in the Shell (SeoKeywords). Only view-local
 * state (active type, filters, which items are expanded, the inline add fields)
 * lives here.
 */

import { useEffect, useMemo, useState } from "react";
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
} from "@shopify/polaris";
import type { FetcherWithComponents } from "react-router";
import { scoreTone } from "../../../utils/seo-score";
import { HelpTooltip } from "../../HelpTooltip";
import { SubNavBar, type SubNavBarItem } from "../../nav/SubNavBar";
import type {
  KeywordResourceType,
  KeywordRole,
  DensityBand,
} from "../../../services/seo/keywords.service";
import type { Translation } from "../../../i18n/de";
import type { loader, ActionResult } from "../../../routes/app.seo.keywords";
import type { Route } from "../../../routes/+types/app.seo.keywords";

type LoaderData = Route.ComponentProps["loaderData"];
type KeywordsPageStrings = Translation["seo"]["keywordsPage"];
type KeywordRow = LoaderData["keywords"][number];

const DENSITY_TONE: Record<DensityBand, "success" | "warning" | "critical" | undefined> = {
  ok: "success",
  low: "warning",
  high: "critical",
  none: undefined,
};

/** Type mini-navbar order (§2.3): Produkte / Collections / Seiten / Blogartikel. */
const TYPE_ORDER: KeywordResourceType[] = ["Product", "Collection", "Page", "Article"];

/** Presence badge order: T · H1 · Meta · SEO · Body (matches the old table). */
const PRESENCE_KEYS = ["title", "h1", "metaDescription", "seoTitle", "body"] as const;

/** New keyword the inline add starts as — items in this list already carry a
 * primary, so secondary is the low-surprise default (the Shell's primaryExists
 * swap dialog still catches a deliberate primary). */
const DEFAULT_ADD_ROLE: KeywordRole = "secondary";

export interface AddKeywordArgs {
  resourceType: KeywordResourceType;
  resourceId: string;
  keyword: string;
  role: KeywordRole;
}

export interface AssignmentsTabProps {
  k: KeywordsPageStrings;
  /** Active language — rows are scoped to it and inline adds assign under it. */
  activeLocale: string;
  conflicts: LoaderData["conflicts"];
  keywords: LoaderData["keywords"];
  isPro: boolean;
  unclassifiedCount: number;
  intentLabel: (intent: string | null | undefined) => string | null;

  saveFetcher: FetcherWithComponents<ActionResult>;
  rowFetcher: FetcherWithComponents<ActionResult>;
  intentFetcher: FetcherWithComponents<{
    success: boolean;
    classified?: number;
    remaining?: number;
    error?: string;
  }>;
  pendingRowId: string | null;

  /** Per-item inline add — locale is fixed to activeLocale by the Shell. */
  handleAddKeyword: (args: AddKeywordArgs) => void;
  handleMakePrimary: (row: { id: string }) => void;
  handleDeleteKeyword: (row: { id: string; keyword: string }) => void;
  openInEditor: (row: { resourceType: string; resourceId: string }) => void;
}

interface ItemGroup {
  resourceId: string;
  resourceType: KeywordResourceType;
  itemTitle: string;
  itemMissing: boolean;
  rows: KeywordRow[];
  primaryScore: number | null;
  gscAvg: number | null;
}

/** Compact score readout: number + tone-tinted bar (reuses scoreTone). */
function ScoreBar({ score }: { score: number }) {
  const tone = scoreTone(score);
  const color = tone === "success" ? "#008060" : tone === "warning" ? "#b98900" : "#d72c0d";
  const pct = Math.max(0, Math.min(100, score));
  return (
    <InlineStack gap="150" blockAlign="center" wrap={false}>
      <Text as="span" variant="bodySm" fontWeight="semibold">
        {String(score)}
      </Text>
      <div
        style={{
          width: "64px",
          height: "6px",
          background: "#e1e3e5",
          borderRadius: "3px",
          overflow: "hidden",
        }}
      >
        <div style={{ width: `${pct}%`, height: "100%", background: color }} />
      </div>
    </InlineStack>
  );
}

/** Inline "+ Keyword" control under an expanded item. Holds its own draft
 * state; clears on a successful save. Submits through the Shell's saveFetcher
 * path so the primaryExists / cannibalization confirm dialogs still apply. */
function InlineAddKeyword({
  k,
  group,
  saveFetcher,
  onAdd,
}: {
  k: KeywordsPageStrings;
  group: ItemGroup;
  saveFetcher: FetcherWithComponents<ActionResult>;
  onAdd: (args: AddKeywordArgs) => void;
}) {
  const [kw, setKw] = useState("");
  const [role, setRole] = useState<KeywordRole>(DEFAULT_ADD_ROLE);

  // Clear the draft once a save lands. saveFetcher is shared across every
  // mounted inline form, so all of them clear on any success — harmless, since
  // the others are empty anyway.
  useEffect(() => {
    if (saveFetcher.state === "idle" && saveFetcher.data?.ok && saveFetcher.data.kind === "saved") {
      setKw("");
    }
  }, [saveFetcher.state, saveFetcher.data]);

  const submit = () => {
    const trimmed = kw.trim();
    if (!trimmed) return;
    onAdd({
      resourceType: group.resourceType,
      resourceId: group.resourceId,
      keyword: trimmed,
      role,
    });
  };

  return (
    <InlineStack gap="200" blockAlign="end" wrap>
      <div style={{ flex: "1 1 220px", minWidth: "180px" }}>
        <TextField
          label={k.addKeywordInline}
          labelHidden
          autoComplete="off"
          placeholder={k.addKeywordInlinePlaceholder}
          value={kw}
          onChange={setKw}
        />
      </div>
      <div style={{ minWidth: "150px" }}>
        <Select
          label={k.roleLabel || "Role"}
          labelHidden
          options={[
            { label: k.role?.primary || "Primary", value: "primary" },
            { label: k.role?.secondary || "Secondary", value: "secondary" },
          ]}
          value={role}
          onChange={(v) => setRole(v as KeywordRole)}
        />
      </div>
      <Button
        disabled={!kw.trim()}
        loading={saveFetcher.state !== "idle"}
        onClick={submit}
      >
        {k.addKeywordInline}
      </Button>
    </InlineStack>
  );
}

export function AssignmentsTab({
  k,
  activeLocale,
  conflicts,
  keywords,
  isPro,
  unclassifiedCount,
  intentLabel,
  saveFetcher,
  rowFetcher,
  intentFetcher,
  pendingRowId,
  handleAddKeyword,
  handleMakePrimary,
  handleDeleteKeyword,
  openInEditor,
}: AssignmentsTabProps) {
  const [activeType, setActiveType] = useState<KeywordResourceType>("Product");
  const [textFilter, setTextFilter] = useState("");
  const [intentFilter, setIntentFilter] = useState("all");
  const [scoreFilter, setScoreFilter] = useState("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Conflicts scoped to the active language — language is the top dimension.
  const localeConflicts = useMemo(
    () => conflicts.filter((c) => c.locale === activeLocale),
    [conflicts, activeLocale],
  );

  // Group the (locale + type)-matching rows by item, then apply the item-level
  // filters. Rows already arrive sorted (item → role primary-first → keyword),
  // so insertion order gives title-sorted groups with primary rows on top.
  const groups = useMemo<ItemGroup[]>(() => {
    const byId = new Map<string, ItemGroup>();
    for (const row of keywords) {
      if (row.locale !== activeLocale) continue;
      if (row.resourceType !== activeType) continue;
      let g = byId.get(row.resourceId);
      if (!g) {
        g = {
          resourceId: row.resourceId,
          resourceType: row.resourceType as KeywordResourceType,
          itemTitle: row.itemTitle,
          itemMissing: row.itemMissing,
          rows: [],
          primaryScore: null,
          gscAvg: null,
        };
        byId.set(row.resourceId, g);
      }
      g.rows.push(row);
    }

    let list = Array.from(byId.values());
    for (const g of list) {
      const primary = g.rows.find((r) => r.role === "primary");
      g.primaryScore = primary?.score ?? null;
      const gscVals = g.rows
        .map((r) => r.gscPosition)
        .filter((v): v is number => v != null);
      g.gscAvg = gscVals.length ? gscVals.reduce((a, b) => a + b, 0) / gscVals.length : null;
    }

    const q = textFilter.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (g) =>
          (g.itemTitle || g.resourceId).toLowerCase().includes(q) ||
          g.rows.some((r) => r.keyword.toLowerCase().includes(q)),
      );
    }
    if (intentFilter === "none") {
      list = list.filter((g) => g.rows.some((r) => !r.intent));
    } else if (intentFilter !== "all") {
      list = list.filter((g) => g.rows.some((r) => r.intent === intentFilter));
    }
    if (scoreFilter === "under50") {
      list = list.filter((g) => g.primaryScore != null && g.primaryScore < 50);
    } else if (scoreFilter === "under80") {
      list = list.filter((g) => g.primaryScore != null && g.primaryScore < 80);
    }
    return list;
  }, [keywords, activeLocale, activeType, textFilter, intentFilter, scoreFilter]);

  const typeNavItems: SubNavBarItem[] = TYPE_ORDER.map((rt) => ({
    id: rt,
    label: k.types[rt],
  }));

  return (
    <BlockStack gap="400">
      {/* Conflicts as a single warning header (§2.3, replaces the old card). */}
      {localeConflicts.length > 0 && (
        <Banner
          tone="warning"
          title={`${localeConflicts.length} ${k.conflictsTitle || "Keyword conflicts"}`}
        >
          <BlockStack gap="100">
            {localeConflicts.map((c) => (
              <Text
                key={`${c.keyword}:${c.resourceType}:${c.locale}`}
                as="p"
                variant="bodySm"
              >
                {(k.conflictItem || '"{keyword}" is primary on {count} {type} items: {items}')
                  .replace("{keyword}", c.keyword)
                  .replace("{count}", String(c.itemTitles.length))
                  .replace("{type}", k.types[c.resourceType as KeywordResourceType] || c.resourceType)
                  .replace("{items}", c.itemTitles.join(", "))}
              </Text>
            ))}
          </BlockStack>
        </Banner>
      )}

      {/* Type mini-navbar (§2.3). */}
      <SubNavBar
        ariaLabel={k.listTitle}
        items={typeNavItems}
        activeId={activeType}
        onSelect={(item) => setActiveType(item.id as KeywordResourceType)}
      />

      <Card>
        <BlockStack gap="300">
          {/* Help icon (far right) explaining how assignments work. */}
          <InlineStack align="end">
            <HelpTooltip helpKey="keywordsAssignments" position="below" />
          </InlineStack>
          {/* Filters row. */}
          <InlineStack align="space-between" blockAlign="end" wrap>
            <InlineStack gap="200" blockAlign="end" wrap>
              <div style={{ minWidth: "200px" }}>
                <TextField
                  label={k.assignFilterPlaceholder}
                  labelHidden
                  autoComplete="off"
                  placeholder={k.assignFilterPlaceholder}
                  value={textFilter}
                  onChange={setTextFilter}
                  clearButton
                  onClearButtonClick={() => setTextFilter("")}
                />
              </div>
              <div style={{ minWidth: "170px" }}>
                <Select
                  label={k.intentFilterLabel || "Intent"}
                  labelHidden
                  options={[
                    { label: k.intentFilterAll || "All intents", value: "all" },
                    { label: k.intentFilterNone || "Unclassified", value: "none" },
                    ...(["informational", "commercial", "transactional", "navigational"] as const).map(
                      (i) => ({ label: intentLabel(i) ?? i, value: i }),
                    ),
                  ]}
                  value={intentFilter}
                  onChange={setIntentFilter}
                />
              </div>
              <div style={{ minWidth: "150px" }}>
                <Select
                  label={k.scoreFilterLabel || "Score"}
                  labelHidden
                  options={[
                    { label: k.scoreFilterAll || "All scores", value: "all" },
                    { label: k.scoreFilterUnder50 || "< 50", value: "under50" },
                    { label: k.scoreFilterUnder80 || "< 80", value: "under80" },
                  ]}
                  value={scoreFilter}
                  onChange={setScoreFilter}
                />
              </div>
            </InlineStack>
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

          {intentFetcher.state === "idle" && intentFetcher.data?.success && (
            <Banner tone="success">
              {(k.classifyDone || "{count} keyword(s) classified, {remaining} remaining.")
                .replace("{count}", String(intentFetcher.data.classified ?? 0))
                .replace("{remaining}", String(intentFetcher.data.remaining ?? 0))}
            </Banner>
          )}
          {rowFetcher.data && !rowFetcher.data.ok && (
            <Banner tone="critical">{k.errorGeneric}</Banner>
          )}
          {saveFetcher.data && !saveFetcher.data.ok && saveFetcher.data.error === "tooMany" && (
            <Banner tone="warning">
              {k.tooManyKeywords ||
                "This item already tracks the maximum number of keywords for this language."}
            </Banner>
          )}

          {groups.length === 0 ? (
            <Text as="p" tone="subdued">
              {k.noKeywords}
            </Text>
          ) : (
            <BlockStack gap="0">
              {groups.map((g, index) => {
                const isOpen = expanded.has(g.resourceId);
                return (
                  <div
                    key={g.resourceId}
                    style={{
                      borderTop: index === 0 ? undefined : "1px solid #e1e3e5",
                      paddingTop: index === 0 ? undefined : "0.5rem",
                    }}
                  >
                    {/* Collapsible header row. */}
                    <button
                      type="button"
                      onClick={() => toggleExpanded(g.resourceId)}
                      aria-expanded={isOpen}
                      aria-label={(isOpen ? k.collapseItem : k.expandItem).replace(
                        "{item}",
                        g.itemMissing ? k.itemMissing : g.itemTitle || g.resourceId,
                      )}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "0.75rem",
                        padding: "0.5rem 0.25rem",
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                        textAlign: "left",
                      }}
                    >
                      <InlineStack gap="200" blockAlign="center" wrap={false}>
                        <span
                          aria-hidden="true"
                          style={{ width: "1rem", display: "inline-block", color: "#616161" }}
                        >
                          {isOpen ? "▾" : "▸"}
                        </span>
                        <div style={{ maxWidth: "320px" }}>
                          <Text as="span" variant="bodyMd" fontWeight="semibold" truncate>
                            {g.itemMissing ? k.itemMissing : g.itemTitle || g.resourceId}
                          </Text>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {" · "}
                            {k.types[g.resourceType] || g.resourceType}
                          </Text>
                        </div>
                      </InlineStack>
                      <InlineStack gap="400" blockAlign="center" wrap={false}>
                        <InlineStack gap="150" blockAlign="center" wrap={false}>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {k.colScore}
                          </Text>
                          {g.primaryScore == null ? (
                            <Text as="span" variant="bodySm" tone="subdued">
                              –
                            </Text>
                          ) : (
                            <ScoreBar score={g.primaryScore} />
                          )}
                        </InlineStack>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {k.gscAvg} {g.gscAvg == null ? "–" : g.gscAvg.toFixed(1)}
                        </Text>
                      </InlineStack>
                    </button>

                    {/* Expanded detail: keyword rows + inline add. */}
                    {isOpen && (
                      <BlockStack gap="200">
                        <div style={{ paddingLeft: "1.25rem", paddingBottom: "0.5rem" }}>
                          <BlockStack gap="200">
                            {g.rows.map((row) => (
                              <InlineStack
                                key={row.id}
                                gap="300"
                                blockAlign="center"
                                align="space-between"
                                wrap
                              >
                                <InlineStack gap="200" blockAlign="center" wrap>
                                  <Text as="span" variant="bodyMd">
                                    <span aria-hidden="true">
                                      {row.role === "primary" ? "★ " : ""}
                                    </span>
                                    {row.keyword}
                                  </Text>
                                  {row.intent && (
                                    <Badge>{intentLabel(row.intent) ?? row.intent}</Badge>
                                  )}
                                  <InlineStack gap="100" wrap>
                                    {PRESENCE_KEYS.map((key) => (
                                      <Badge
                                        key={key}
                                        tone={row.presence[key] ? "success" : undefined}
                                      >
                                        {k.presence[key]}
                                      </Badge>
                                    ))}
                                  </InlineStack>
                                  <Badge tone={DENSITY_TONE[row.densityBand as DensityBand]}>
                                    {`${k.density[row.densityBand as DensityBand]} (${row.densityPct}%)`}
                                  </Badge>
                                  <Text
                                    as="span"
                                    variant="bodySm"
                                    tone={row.gscPosition == null ? "subdued" : undefined}
                                  >
                                    {k.gscAvg}{" "}
                                    {row.gscPosition == null ? "–" : row.gscPosition.toFixed(1)}
                                  </Text>
                                </InlineStack>
                                <InlineStack gap="200" blockAlign="center" wrap={false}>
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
                              </InlineStack>
                            ))}
                            <InlineAddKeyword
                              k={k}
                              group={g}
                              saveFetcher={saveFetcher}
                              onAdd={handleAddKeyword}
                            />
                          </BlockStack>
                        </div>
                      </BlockStack>
                    )}
                  </div>
                );
              })}
            </BlockStack>
          )}
          <Text as="p" variant="bodySm" tone="subdued">
            {k.gscHint}
          </Text>
        </BlockStack>
      </Card>
    </BlockStack>
  );
}
