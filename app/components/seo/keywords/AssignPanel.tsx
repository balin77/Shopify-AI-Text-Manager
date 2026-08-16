/**
 * AssignPanel — the unified "Zuordnen" modal (PLAN_KEYWORDS_UI_REWORK.md §2.2,
 * Phase 4). ONE panel with BOTH distribution modes, reachable from the group
 * flows ("Ganze Gruppe verteilen", "Auswahl zuordnen", "Gruppe erneut
 * verteilen"). It replaces the old target-type-only distribution modal as the
 * entry point.
 *
 *  - manual mode (free): assign ALL passed keywords onto EVERY selected item
 *    via the `assignMany` route-action. A live dry-run (POST with dryRun=true)
 *    surfaces the per-item 5-keyword-limit skip report BEFORE the write.
 *  - AI mode (Pro-gated): hand the selected items to the existing keyword
 *    distribution (§3) — one primary + up to N secondaries per item — whose
 *    preview table in LibraryTab renders the result exactly as today.
 *
 * The <ItemPicker> (Phase 3) drives target selection; it reports each selected
 * item as `{ id, resourceType }` so the panel can build assignMany targets and
 * route the AI batch by type.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Modal,
  BlockStack,
  InlineStack,
  Text,
  Select,
  RadioButton,
  Checkbox,
  Banner,
} from "@shopify/polaris";
import type { FetcherWithComponents } from "react-router";
import type { Translation } from "../../../i18n/de";
import type { ActionResult } from "../../../routes/app.seo.keywords";
import type { KeywordResourceType, KeywordRole } from "../../../services/seo/keywords.service";
import { estimateDistributionCost } from "../../../services/seo/keyword-distribution.shared";
import { ItemPicker, type SelectedPickerItem } from "./ItemPicker";
import { HelpTooltip } from "../../HelpTooltip";

type KeywordsPageStrings = Translation["seo"]["keywordsPage"];

export interface AssignPanelProps {
  open: boolean;
  onClose: () => void;
  /** The keyword set to assign (already scoped to the active group/locale). */
  keywords: { keywordId: string; keyword: string }[];
  /** Group name for the header. */
  groupName: string;
  /** Display locale code/name for the header. */
  locale: string;
  /** Active locale ("" = primary) — drives the ItemPicker translated-title overlay. */
  activeLocale: string;
  productTypes: { label: string; value: string }[];
  isPro: boolean;
  /**
   * Whether the AI distribution can run for this keyword set at all. It is
   * driven by a real SeoKeywordGroup row, so the "Alle" / "Ohne Gruppe" views
   * — whose ids are sentinels, not group rows — offer manual mode only.
   */
  aiAvailable: boolean;
  k: KeywordsPageStrings;
  /** Shared assignMany fetcher (dry-run + real apply). */
  assignFetcher: FetcherWithComponents<ActionResult>;
  /** Kick off an AI distribution over the selected items (§3). */
  startDistribution: (opts: {
    resourceIds: string[];
    targetType: KeywordResourceType;
    maxSecondaries: string;
  }) => void;
  runningDistribution: { id: string } | null;
}

const MAX_SECONDARY_OPTIONS = ["0", "1", "2", "3", "4"];

export function AssignPanel({
  open,
  onClose,
  keywords,
  groupName,
  locale,
  activeLocale,
  productTypes,
  isPro,
  aiAvailable,
  k,
  assignFetcher,
  startDistribution,
  runningDistribution,
}: AssignPanelProps) {
  const canUseAi = isPro && aiAvailable;
  const [selected, setSelected] = useState<SelectedPickerItem[]>([]);
  const [mode, setMode] = useState<"ai" | "manual">(canUseAi ? "ai" : "manual");
  const [role, setRole] = useState<KeywordRole>("secondary");
  const [maxSecondaries, setMaxSecondaries] = useState("3");
  const [demoteExisting, setDemoteExisting] = useState(false);
  const [aiTargetType, setAiTargetType] = useState<KeywordResourceType>("Product");

  // Fresh state on every (re)open so a new assignment never inherits a stale
  // selection or a real result banner from the previous run.
  useEffect(() => {
    if (open) {
      setSelected([]);
      setMode(canUseAi ? "ai" : "manual");
      setRole("secondary");
      setMaxSecondaries("3");
      setDemoteExisting(false);
      lastSigRef.current = "";
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const keywordIds = useMemo(() => keywords.map((kw) => kw.keywordId), [keywords]);
  const targets = useMemo(
    () => selected.map((s) => ({ resourceType: s.resourceType, resourceId: s.id })),
    [selected],
  );

  // ── Live dry-run (manual mode) ──────────────────────────────────────────
  // Fired only when the manual inputs actually change (tracked by signature),
  // which also stops it re-firing after a real apply leaves the signature
  // untouched — the real result stays on screen.
  const dryRunSig =
    mode === "manual" && selected.length > 0 && keywords.length > 0
      ? `${role}|${demoteExisting}|${keywordIds.join(",")}|${selected.map((s) => s.id).join(",")}`
      : "";
  const lastSigRef = useRef<string>("");
  // Held so a real apply can cancel a still-pending dry-run — otherwise the
  // trailing dry-run submit would land on the shared fetcher AFTER the real
  // apply and overwrite its {applied} result with "would be rejected" counts
  // (and the Shell's revalidate-on-real-apply effect would never fire).
  const dryRunTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!dryRunSig || lastSigRef.current === dryRunSig) return;
    lastSigRef.current = dryRunSig;
    dryRunTimer.current = setTimeout(() => {
      dryRunTimer.current = null;
      assignFetcher.submit(
        {
          actionType: "assignMany",
          keywordIds: JSON.stringify(keywordIds),
          targets: JSON.stringify(targets),
          role,
          demoteExisting: demoteExisting ? "true" : "false",
          dryRun: "true",
        },
        { method: "post" },
      );
    }, 250);
    return () => {
      if (dryRunTimer.current) clearTimeout(dryRunTimer.current);
      dryRunTimer.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dryRunSig]);

  // ── AI target type: keep it pinned to a type that is actually selected ──
  const typesPresent = useMemo(() => {
    const s = new Set<KeywordResourceType>();
    for (const it of selected) s.add(it.resourceType);
    return Array.from(s);
  }, [selected]);
  useEffect(() => {
    if (typesPresent.length > 0 && !typesPresent.includes(aiTargetType)) {
      setAiTargetType(typesPresent[0]);
    }
  }, [typesPresent, aiTargetType]);
  const aiResourceIds = useMemo(
    () => selected.filter((s) => s.resourceType === aiTargetType).map((s) => s.id),
    [selected, aiTargetType],
  );
  const aiCost = useMemo(
    () => estimateDistributionCost(keywords.length, aiResourceIds.length),
    [keywords.length, aiResourceIds.length],
  );

  const typeLabel: Record<KeywordResourceType, string> = {
    Product: k.picker.typeProduct,
    Collection: k.picker.typeCollection,
    Article: k.picker.typeArticle,
    Page: k.picker.typePage,
  };

  const data = assignFetcher.data;
  const dryResult =
    data && data.ok && data.kind === "assigned" && data.dryRun ? data : null;
  const realResult =
    data && data.ok && data.kind === "assigned" && !data.dryRun ? data : null;

  const applyManual = () => {
    if (selected.length === 0 || keywords.length === 0) return;
    // Cancel any pending dry-run so it can't supersede this real apply on the
    // shared fetcher.
    if (dryRunTimer.current) {
      clearTimeout(dryRunTimer.current);
      dryRunTimer.current = null;
    }
    assignFetcher.submit(
      {
        actionType: "assignMany",
        keywordIds: JSON.stringify(keywordIds),
        targets: JSON.stringify(targets),
        role,
        demoteExisting: demoteExisting ? "true" : "false",
      },
      { method: "post" },
    );
  };

  const startAi = () => {
    if (!canUseAi || aiResourceIds.length === 0 || runningDistribution) return;
    startDistribution({ resourceIds: aiResourceIds, targetType: aiTargetType, maxSecondaries });
    onClose();
  };

  const confirmDisabled =
    mode === "ai"
      ? !canUseAi || aiResourceIds.length === 0 || !!runningDistribution
      : selected.length === 0 || keywords.length === 0;

  const title = k.assign.title
    .replace("{n}", String(keywords.length))
    .replace("{group}", groupName)
    .replace("{locale}", locale);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="large"
      primaryAction={{
        content: k.assign.confirm,
        disabled: confirmDisabled,
        loading: mode === "manual" && assignFetcher.state !== "idle",
        onAction: mode === "ai" ? startAi : applyManual,
      }}
      secondaryActions={[{ content: k.distModalCancel, onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          <ItemPicker
            selected={selected}
            onChange={setSelected}
            productTypes={productTypes}
            locale={activeLocale}
            labels={{
              typeProduct: k.picker.typeProduct,
              typeCollection: k.picker.typeCollection,
              typePage: k.picker.typePage,
              typeArticle: k.picker.typeArticle,
              filterPlaceholder: k.picker.filterPlaceholder,
              productTypeAll: k.picker.productTypeAll,
              countOf: k.picker.countOf,
              selectAllVisible: k.picker.selectAllVisible,
              selectedPrefix: k.picker.selectedPrefix,
              loadMore: k.picker.loadMore,
              empty: k.picker.empty,
              loading: k.picker.loading,
            }}
          />

          {/* Verteilmodus */}
          <BlockStack gap="200">
            <InlineStack gap="100" blockAlign="center">
              <Text as="h4" variant="headingSm">
                {k.assign.modeLabel}
              </Text>
              <HelpTooltip helpKey="keywordsAssignModal" position="below" />
            </InlineStack>
            <InlineStack gap="300" blockAlign="center" wrap={false}>
              <RadioButton
                label={k.assign.aiMode}
                checked={mode === "ai"}
                disabled={!canUseAi}
                id="assign-mode-ai"
                name="assign-mode"
                onChange={() => setMode("ai")}
                helpText={
                  !isPro ? k.distributeProHint : !aiAvailable ? k.assign.aiNeedsGroup : undefined
                }
              />
              {mode === "ai" && (
                <div style={{ minWidth: 80 }}>
                  <Select
                    label={k.distModalMaxSecondaries}
                    labelHidden
                    options={MAX_SECONDARY_OPTIONS.map((v) => ({ label: v, value: v }))}
                    value={maxSecondaries}
                    onChange={setMaxSecondaries}
                    disabled={!canUseAi}
                  />
                </div>
              )}
            </InlineStack>
            <RadioButton
              label={k.assign.manualMode}
              checked={mode === "manual"}
              id="assign-mode-manual"
              name="assign-mode"
              onChange={() => setMode("manual")}
            />
          </BlockStack>

          {/* Rolle (manual only) */}
          {mode === "manual" && (
            <BlockStack gap="150">
              <Text as="span" variant="bodySm" tone="subdued">
                {k.assign.roleLabel}
              </Text>
              <InlineStack gap="400">
                <RadioButton
                  label={k.role.primary}
                  checked={role === "primary"}
                  id="assign-role-primary"
                  name="assign-role"
                  onChange={() => setRole("primary")}
                />
                <RadioButton
                  label={k.role.secondary}
                  checked={role === "secondary"}
                  id="assign-role-secondary"
                  name="assign-role"
                  onChange={() => setRole("secondary")}
                />
              </InlineStack>
              <Checkbox
                label={k.distDemoteExisting}
                checked={demoteExisting}
                onChange={setDemoteExisting}
              />
            </BlockStack>
          )}

          {/* AI target type when the selection spans several types (§3). */}
          {mode === "ai" && typesPresent.length > 1 && (
            <Select
              label={k.assign.aiTargetTypeLabel}
              options={typesPresent.map((t) => ({ label: typeLabel[t], value: t }))}
              value={aiTargetType}
              onChange={(v) => setAiTargetType(v as KeywordResourceType)}
            />
          )}

          {/* Dry-run skip warning (manual) */}
          {mode === "manual" && selected.length > 0 && dryResult && dryResult.skipped.length > 0 && (
            <Banner tone="warning">
              {k.assign.dryRunWarning
                .replace("{keywords}", String(keywords.length))
                .replace("{items}", String(selected.length))
                .replace("{skipped}", String(dryResult.skipped.length))}
            </Banner>
          )}

          {/* Real apply result (manual) */}
          {mode === "manual" && selected.length > 0 && realResult && (
            <Banner tone={realResult.skipped.length > 0 ? "warning" : "success"}>
              {k.assign.result
                .replace("{applied}", String(realResult.applied))
                .replace("{skipped}", String(realResult.skipped.length))}
            </Banner>
          )}

          {/* AI cost preview */}
          {mode === "ai" && aiResourceIds.length > 0 && aiCost.batches > 0 && (
            <Text as="p" variant="bodySm" tone={aiCost.batches > 30 ? "caution" : "subdued"}>
              {k.distCostPreview
                .replace("{batches}", String(aiCost.batches))
                .replace("{usd}", aiCost.usd.toFixed(2))}
            </Text>
          )}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
