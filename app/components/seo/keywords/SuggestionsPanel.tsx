/**
 * SuggestionsPanel — the review surface for pending AI distribution
 * suggestions, at the TOP of the Bibliothek tab.
 *
 * It used to live inside the group editor and only appeared while the exact
 * source group happened to be selected — a merchant who started a
 * distribution and clicked elsewhere could not find the result again, and the
 * per-row "accept / secondary only / reject" Selects hid the whole point:
 * that there is a batch of decisions waiting. So:
 *
 *  - it sits above everything else and announces itself (count in the title,
 *    "Neu" badge, accent border) whenever unapplied suggestions exist,
 *    whatever the sidebar shows;
 *  - a decision is ONE click on ✓ or ✕, and the row carries its state
 *    visually — accepted rows tint green, rejected ones grey out and strike
 *    through. Clicking the other icon changes the mind; nothing is applied
 *    until the merchant presses the apply button.
 *  - the old third Select value ("nur als Secondary") is now a checkbox on the
 *    accepted row's own secondary line, where it reads as what it is: keep the
 *    extra items, drop the primary.
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
  Box,
} from "@shopify/polaris";
import type { Dispatch, SetStateAction } from "react";
import type { FetcherWithComponents } from "react-router";
import type { Translation } from "../../../i18n/de";
import type { loader } from "../../../routes/app.seo.keywords";
import type { Route } from "../../../routes/+types/app.seo.keywords";

type LoaderData = Route.ComponentProps["loaderData"];
type KeywordsPageStrings = Translation["seo"]["keywordsPage"];

/**
 * Per-keyword decision. "accept" writes the primary plus the secondaries,
 * "secondaryOnly" writes just the secondaries, "reject" writes nothing — the
 * same three the apply stage has always understood.
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
  const decisionOf = (keyword: string): Decision => decisions[keyword] ?? "reject";

  // A suggestion with neither a primary nor any secondary has nothing to
  // apply — it is shown (so the count matches what the AI looked at) but
  // cannot be accepted.
  const isActionable = (s: (typeof preview.suggestions)[number]) =>
    !!s.primaryItemId || s.secondaryItemIds.length > 0;

  const acceptedCount = preview.suggestions.filter(
    (s) => isActionable(s) && decisionOf(s.keyword) !== "reject",
  ).length;

  const setAll = (decision: Decision) =>
    setDecisions(() => {
      const next: DecisionMap = {};
      for (const s of preview.suggestions) {
        next[s.keyword] = isActionable(s) ? decision : "reject";
      }
      return next;
    });

  const decide = (keyword: string, decision: Decision) =>
    setDecisions((prev) => ({ ...prev, [keyword]: decision }));

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

        <BlockStack gap="200">
          {preview.suggestions.map((s) => {
            const decision = decisionOf(s.keyword);
            const actionable = isActionable(s);
            const accepted = actionable && decision !== "reject";
            const secondaryTitles = s.secondaryItemIds.map((id) => titles[id] || id);

            return (
              <div
                key={s.keyword}
                style={{
                  borderRadius: "8px",
                  border: "1px solid var(--p-color-border-secondary, #e1e3e5)",
                  borderLeft: `4px solid ${
                    !actionable
                      ? "var(--p-color-border-disabled, #c9cccf)"
                      : accepted
                        ? "var(--p-color-border-success, #29845a)"
                        : "var(--p-color-border-disabled, #c9cccf)"
                  }`,
                  background: accepted
                    ? "var(--p-color-bg-surface-success, #f1f8f5)"
                    : "var(--p-color-bg-surface, transparent)",
                  opacity: actionable && !accepted ? 0.55 : 1,
                  padding: "0.625rem 0.75rem",
                  transition: "background 150ms ease, opacity 150ms ease",
                }}
              >
                <BlockStack gap="150">
                  <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
                    <InlineStack gap="200" blockAlign="center" wrap>
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        <span
                          style={{
                            textDecoration:
                              actionable && !accepted ? "line-through" : undefined,
                          }}
                        >
                          {s.keyword}
                        </span>
                      </Text>
                      <Text as="span" variant="bodySm" tone="subdued">
                        →
                      </Text>
                      <Text
                        as="span"
                        variant="bodySm"
                        tone={s.primaryItemId ? undefined : "subdued"}
                      >
                        {s.primaryItemId
                          ? titles[s.primaryItemId] || s.primaryItemId
                          : k.distNoMatch}
                      </Text>
                      <Badge tone={s.confidence >= 0.6 ? "success" : undefined}>
                        {`${Math.round(s.confidence * 100)}%`}
                      </Badge>
                    </InlineStack>

                    {actionable ? (
                      <InlineStack gap="100" blockAlign="center" wrap={false}>
                        <Tooltip content={k.suggestionsAcceptHint} dismissOnMouseOut>
                          <Button
                            size="slim"
                            variant={accepted ? "primary" : undefined}
                            onClick={() =>
                              decide(s.keyword, s.primaryItemId ? "accept" : "secondaryOnly")
                            }
                            accessibilityLabel={k.suggestionsAcceptHint}
                          >
                            ✓
                          </Button>
                        </Tooltip>
                        <Tooltip content={k.suggestionsRejectHint} dismissOnMouseOut>
                          <Button
                            size="slim"
                            tone={accepted ? undefined : "critical"}
                            variant={accepted ? undefined : "primary"}
                            onClick={() => decide(s.keyword, "reject")}
                            accessibilityLabel={k.suggestionsRejectHint}
                          >
                            ✕
                          </Button>
                        </Tooltip>
                      </InlineStack>
                    ) : (
                      <Text as="span" variant="bodySm" tone="subdued">
                        {k.suggestionsNothingToApply}
                      </Text>
                    )}
                  </InlineStack>

                  {/* The old "nur als Secondary" Select value, as what it
                      actually means: keep the extra items, drop the primary.
                      Only offered where both halves exist. */}
                  {accepted && secondaryTitles.length > 0 && (
                    <Box paddingInlineStart="400">
                      <InlineStack gap="200" blockAlign="center" wrap>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {`↳ ${k.suggestionsSecondaries.replace(
                            "{count}",
                            String(secondaryTitles.length),
                          )}: ${secondaryTitles.join(", ")}`}
                        </Text>
                        {s.primaryItemId && (
                          <Checkbox
                            label={k.suggestionsSecondaryOnly}
                            checked={decision === "secondaryOnly"}
                            onChange={(checked) =>
                              decide(s.keyword, checked ? "secondaryOnly" : "accept")
                            }
                          />
                        )}
                      </InlineStack>
                    </Box>
                  )}
                </BlockStack>
              </div>
            );
          })}
        </BlockStack>

        <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
          <Text as="span" variant="bodySm" tone="subdued">
            {k.suggestionsCounter
              .replace("{accepted}", String(acceptedCount))
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
              disabled={!!runningDistribution || acceptedCount === 0}
              onClick={applyDistribution}
            >
              {k.suggestionsApply.replace("{count}", String(acceptedCount))}
            </Button>
          </InlineStack>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}
