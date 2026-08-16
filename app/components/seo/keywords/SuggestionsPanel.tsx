/**
 * SuggestionsPanel — the review surface for pending AI distribution
 * suggestions, at the TOP of the Bibliothek tab.
 *
 * It used to live inside the group editor and only appeared while the exact
 * source group happened to be selected — a merchant who started a
 * distribution and clicked elsewhere could not find the result again, and the
 * per-row "accept / secondary only / reject" Selects hid the whole point:
 * that there is a batch of decisions waiting.
 *
 * The list is grouped into three BUCKETS — "Zu prüfen", "Übernommen",
 * "Verworfen" — and a decision moves the row from one to the next. That is the
 * point: a first attempt tinted the accepted row green in place, and since the
 * confident suggestions are pre-accepted, clicking ✓ on one of them changed
 * nothing at all and read as a dead button. Now every click visibly empties
 * the "Zu prüfen" bucket, and when it hits zero the batch is done.
 *
 * Three states, not two: a suggestion with no entry in `decisions` is PENDING,
 * not rejected. The Shell pre-accepts only the confident ones, so the rest
 * start in "Zu prüfen" where they are actually looked at. The apply payload is
 * unchanged — it only ever submits entries that are neither missing nor
 * "reject".
 *
 * The old third Select value ("nur als Secondary") is a checkbox on the
 * accepted row's own secondary line, where it reads as what it is: keep the
 * extra items, drop the primary.
 *
 * Presentational — decisions live in the Shell so the apply submit and the
 * loader's preview stay the single source of truth.
 */

import {
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Button,
  Banner,
  Checkbox,
  Tooltip,
  Divider,
  Box,
} from "@shopify/polaris";
import type { Dispatch, ReactElement, SetStateAction } from "react";
import type { FetcherWithComponents } from "react-router";
import type { Translation } from "../../../i18n/de";
import type { loader } from "../../../routes/app.seo.keywords";
import type { Route } from "../../../routes/+types/app.seo.keywords";

type LoaderData = Route.ComponentProps["loaderData"];
type KeywordsPageStrings = Translation["seo"]["keywordsPage"];
type Suggestion = NonNullable<LoaderData["distributionPreview"]>["suggestions"][number];

/**
 * Per-keyword decision. "accept" writes the primary plus the secondaries,
 * "secondaryOnly" writes just the secondaries, "reject" writes nothing — the
 * same three the apply stage has always understood. A keyword MISSING from
 * the map is undecided and, like a rejected one, writes nothing.
 */
export type Decision = "accept" | "secondaryOnly" | "reject";
export type DecisionMap = Record<string, Decision>;

export interface SuggestionsPanelProps {
  k: KeywordsPageStrings;
  preview: NonNullable<LoaderData["distributionPreview"]>;
  decisions: DecisionMap;
  setDecisions: Dispatch<SetStateAction<DecisionMap>>;
  demoteExisting: boolean;
  setDemoteExisting: (v: boolean) => void;
  applyDistribution: () => void;
  distFetcher: FetcherWithComponents<{
    success: boolean;
    taskId?: string;
    error?: string;
    code?: string;
  }>;
  runningDistribution: LoaderData["runningDistribution"];
}

export function SuggestionsPanel({
  k,
  preview,
  decisions,
  setDecisions,
  demoteExisting,
  setDemoteExisting,
  applyDistribution,
  distFetcher,
  runningDistribution,
}: SuggestionsPanelProps) {
  const titles = preview.itemTitles ?? {};

  /**
   * A suggestion with neither a primary nor any secondary has nothing to
   * apply. It is still listed (so the total matches what the AI looked at) but
   * counts as decided — there is no decision to make.
   */
  const isActionable = (s: Suggestion) => !!s.primaryItemId || s.secondaryItemIds.length > 0;

  const pending: Suggestion[] = [];
  const accepted: Suggestion[] = [];
  const rejected: Suggestion[] = [];
  for (const s of preview.suggestions) {
    const decision = decisions[s.keyword];
    if (!isActionable(s)) rejected.push(s);
    else if (!decision) pending.push(s);
    else if (decision === "reject") rejected.push(s);
    else accepted.push(s);
  }

  const setAll = (decision: Decision) =>
    setDecisions(() => {
      const next: DecisionMap = {};
      for (const s of preview.suggestions) {
        if (isActionable(s)) next[s.keyword] = decision;
      }
      return next;
    });

  const decide = (keyword: string, decision: Decision) =>
    setDecisions((prev) => ({ ...prev, [keyword]: decision }));

  /** Back to undecided — the row returns to "Zu prüfen". */
  const undecide = (keyword: string) =>
    setDecisions((prev) => {
      const next = { ...prev };
      delete next[keyword];
      return next;
    });

  const targetLabel = (s: Suggestion) =>
    s.primaryItemId ? titles[s.primaryItemId] || s.primaryItemId : k.distNoMatch;

  /** The full-size row of the "Zu prüfen" bucket: the decision is the point. */
  const renderPendingRow = (s: Suggestion) => (
    <div key={s.keyword} className="keyword-suggestion keyword-suggestion--pending">
      <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
        <InlineStack gap="200" blockAlign="center" wrap>
          <Text as="span" variant="bodyMd" fontWeight="semibold">
            {s.keyword}
          </Text>
          <Text as="span" variant="bodySm" tone="subdued">
            →
          </Text>
          <Text as="span" variant="bodySm" tone={s.primaryItemId ? undefined : "subdued"}>
            {targetLabel(s)}
          </Text>
          <Badge tone={s.confidence >= 0.6 ? "success" : undefined}>
            {`${Math.round(s.confidence * 100)}%`}
          </Badge>
          {s.secondaryItemIds.length > 0 && (
            <Text as="span" variant="bodySm" tone="subdued">
              {`+ ${k.suggestionsSecondaries.replace(
                "{count}",
                String(s.secondaryItemIds.length),
              )}`}
            </Text>
          )}
        </InlineStack>
        <InlineStack gap="150" blockAlign="center" wrap={false}>
          <Tooltip content={k.suggestionsAcceptHint} dismissOnMouseOut>
            <Button
              size="slim"
              variant="primary"
              onClick={() => decide(s.keyword, s.primaryItemId ? "accept" : "secondaryOnly")}
              accessibilityLabel={k.suggestionsAcceptHint}
            >
              {`✓ ${k.suggestionsAccept}`}
            </Button>
          </Tooltip>
          <Tooltip content={k.suggestionsRejectHint} dismissOnMouseOut>
            <Button
              size="slim"
              onClick={() => decide(s.keyword, "reject")}
              accessibilityLabel={k.suggestionsRejectHint}
            >
              {`✕ ${k.suggestionsReject}`}
            </Button>
          </Tooltip>
        </InlineStack>
      </InlineStack>
    </div>
  );

  /** Decided rows shrink to one line — they are a record, not a task. */
  const renderDecidedRow = (s: Suggestion, kind: "accepted" | "rejected") => {
    const actionable = isActionable(s);
    const decision = decisions[s.keyword];
    return (
      <div key={s.keyword} className={`keyword-suggestion keyword-suggestion--${kind}`}>
        <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
          <InlineStack gap="200" blockAlign="center" wrap>
            <Text as="span" variant="bodySm" tone={kind === "rejected" ? "subdued" : undefined}>
              <span
                style={{ textDecoration: kind === "rejected" ? "line-through" : undefined }}
              >
                {`${kind === "accepted" ? "✓" : "✕"} ${s.keyword}`}
              </span>
            </Text>
            <Text as="span" variant="bodySm" tone="subdued">
              {actionable ? `→ ${targetLabel(s)}` : `— ${k.suggestionsNothingToApply}`}
            </Text>
            {/* Only meaningful where BOTH halves exist: keep the extra items,
                drop the primary. */}
            {kind === "accepted" && s.primaryItemId && s.secondaryItemIds.length > 0 && (
              <Checkbox
                label={k.suggestionsSecondaryOnly}
                checked={decision === "secondaryOnly"}
                onChange={(checked) => decide(s.keyword, checked ? "secondaryOnly" : "accept")}
              />
            )}
          </InlineStack>
          {actionable && (
            <Button size="micro" variant="plain" onClick={() => undecide(s.keyword)}>
              {k.suggestionsUndo}
            </Button>
          )}
        </InlineStack>
      </div>
    );
  };

  const renderBucket = (
    title: string,
    rows: Suggestion[],
    render: (s: Suggestion) => ReactElement,
  ) =>
    rows.length === 0 ? null : (
      <BlockStack gap="150">
        <Text as="h4" variant="headingSm" tone="subdued">
          {title.replace("{count}", String(rows.length))}
        </Text>
        <BlockStack gap="100">{rows.map(render)}</BlockStack>
      </BlockStack>
    );

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
          <InlineStack gap="200" blockAlign="center" wrap>
            <Text as="h3" variant="headingMd">
              {`✨ ${k.suggestionsTitle.replace("{count}", String(preview.suggestions.length))}`}
            </Text>
            <Badge tone="attention">{k.suggestionsNew}</Badge>
          </InlineStack>
          <InlineStack gap="200" blockAlign="center" wrap>
            <Tooltip content={k.suggestionsAcceptAllHint} dismissOnMouseOut>
              <Button size="slim" onClick={() => setAll("accept")}>
                {`✓ ${k.suggestionsAcceptAll}`}
              </Button>
            </Tooltip>
            <Tooltip content={k.suggestionsRejectAllHint} dismissOnMouseOut>
              <Button size="slim" onClick={() => setAll("reject")}>
                {`✕ ${k.suggestionsRejectAll}`}
              </Button>
            </Tooltip>
          </InlineStack>
        </InlineStack>

        <Text as="p" variant="bodySm" tone="subdued">
          {k.suggestionsIntro.replace("{group}", preview.groupName)}
        </Text>

        {preview.failedBatches > 0 && (
          <Banner tone="warning">
            {k.distFailedBatches
              .replace("{failed}", String(preview.failedBatches))
              .replace("{total}", String(preview.batches))}
          </Banner>
        )}

        {/* The pending bucket empties as decisions are made; hitting zero is
            what tells the merchant the batch is reviewed. */}
        {pending.length === 0 && (
          <Banner tone="success">
            {k.suggestionsAllReviewed.replace("{count}", String(accepted.length))}
          </Banner>
        )}

        {renderBucket(k.suggestionsPending, pending, renderPendingRow)}
        {renderBucket(k.suggestionsAccepted, accepted, (s) => renderDecidedRow(s, "accepted"))}
        {renderBucket(k.suggestionsRejected, rejected, (s) => renderDecidedRow(s, "rejected"))}

        <Divider />

        <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
          <Text as="span" variant="bodySm" tone="subdued">
            {k.suggestionsCounter
              .replace("{accepted}", String(accepted.length))
              .replace("{total}", String(preview.suggestions.length))}
          </Text>
          <InlineStack gap="300" blockAlign="center" wrap>
            <Checkbox
              label={k.distDemoteExisting}
              checked={demoteExisting}
              onChange={setDemoteExisting}
            />
            <Button
              variant="primary"
              loading={distFetcher.state !== "idle"}
              disabled={!!runningDistribution || accepted.length === 0}
              onClick={applyDistribution}
            >
              {k.suggestionsApply.replace("{count}", String(accepted.length))}
            </Button>
          </InlineStack>
        </InlineStack>
        <Box paddingBlockStart="0">
          <Text as="span" variant="bodySm" tone="subdued">
            {k.suggestionsApplyHint}
          </Text>
        </Box>
      </BlockStack>
    </Card>
  );
}
