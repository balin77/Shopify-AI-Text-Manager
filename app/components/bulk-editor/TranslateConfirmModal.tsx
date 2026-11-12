/**
 * Confirmation dialog of the "add missing translations" page: shows what the
 * run is expected to cost BEFORE anything is spent (PLAN_BULK_TRANSLATE_BATCHING
 * 3.4). Polaris Modal with a Cancel and a Start button -- never window.confirm.
 *
 * The estimate comes from the handler's `estimateOnly` mode and is only
 * DISPLAYED here. Numbers go through formatNumber with the app locale (the
 * server and the browser must render the same text), and money is always
 * labelled as an estimate ("ca."/"about").
 *
 * The MODE choice ("Sofort" / "Guenstiger, Ergebnis bis zu 24 Stunden") is a
 * radio choice between two ways to do ONE thing, shown only when the server's
 * estimate carries a `batch` alternative (its own answer to "may this shop use
 * the provider's batch mode"; the start re-checks it). "Sofort" is always the
 * preselected one: a merchant who does not read the dialog gets the behaviour
 * they had before.
 */

import { Banner, BlockStack, ChoiceList, Modal, Text } from "@shopify/polaris";
import { formatNumber } from "../../utils/format";
import type { TranslateEstimate } from "../../services/bulk-editor/translate-estimate.shared";

export type ConfirmEstimateState =
  | { status: "loading" }
  | { status: "ready"; estimate: TranslateEstimate }
  /** The shop may not run AI (no key, plan ...): the server's own sentence. */
  | { status: "refused"; message: string }
  /** The estimate could not be made; starting stays allowed. */
  | { status: "unavailable" }
  /** Nothing is missing in the current selection: there is nothing to start. */
  | { status: "nothing" };

export interface TranslateConfirmStrings {
  title: string;
  estimateLabel: string;
  loading: string;
  units: string;
  requests: string;
  tokens: string;
  cost: string;
  costCeiling: string;
  costUnknown: string;
  costTiny: string;
  byokNote: string;
  budgetUnavailable: string;
  nothing: string;
  budgetShare: string;
  budgetExceeds: string;
  overCap: string;
  unavailable: string;
  refusedPrefix: string;
  cancel: string;
  start: string;
  modeLabel: string;
  modeNow: string;
  modeNowHint: string;
  modeBatch: string;
  modeBatchHint: string;
  batchCost: string;
  batchCostCeiling: string;
  batchBudgetExceeds: string;
  startBatch: string;
}

export type TranslateRunMode = "sync" | "batch";

interface Props {
  open: boolean;
  state: ConfirmEstimateState;
  locale: string;
  maxUnits: number;
  strings: TranslateConfirmStrings;
  mode: TranslateRunMode;
  onModeChange: (mode: TranslateRunMode) => void;
  onCancel: () => void;
  onStart: () => void;
}

/** Tokens are shown rounded UP to the next hundred: "ca." and never lower. */
const roundTokens = (n: number): number => Math.ceil(n / 100) * 100;

export function formatEstimateMoney(micros: number, locale: string): { text: string; tiny: boolean } {
  const euro = micros / 1_000_000;
  const money = (v: number) => formatNumber(v, locale, { style: "currency", currency: "EUR" });
  // Below one cent the figure would read "0,00": show the bound instead.
  if (euro < 0.01) return { text: money(0.01), tiny: true };
  return { text: money(euro), tiny: false };
}

export function TranslateConfirmModal({
  open,
  state,
  locale,
  maxUnits,
  strings,
  mode,
  onModeChange,
  onCancel,
  onStart,
}: Props) {
  // The batch alternative exists only inside a ready estimate; a stale `mode` of "batch" without one means "sync".
  const batch = state.status === "ready" ? state.estimate.batch : undefined;
  const effectiveMode: TranslateRunMode = batch ? mode : "sync";
  // A batch that cannot reserve its worst case is refused at the start: the button says so by being disabled.
  const batchBlocked = effectiveMode === "batch" && batch?.wouldExceed === true;
  const startable = (state.status === "ready" || state.status === "unavailable") && !batchBlocked;
  const fill = (template: string, values: Record<string, string>) =>
    Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, value), template);
  const num = (n: number) => formatNumber(n, locale);

  const estimate = state.status === "ready" ? state.estimate : null;

  const costLine = (e: TranslateEstimate): string => {
    if (e.costMicros === null) return strings.costUnknown;
    const { text, tiny } = formatEstimateMoney(e.costMicros, locale);
    const value = tiny ? fill(strings.costTiny, { cost: text }) : text;
    return fill(e.pricedAtCeiling ? strings.costCeiling : strings.cost, { cost: value });
  };

  const budgetLine = (e: TranslateEstimate): { text: string; tone: "info" | "warning" } | null => {
    if (!e.budget || e.costMicros === null) return null;
    if (e.budget.wouldExceed) return { text: strings.budgetExceeds, tone: "warning" };
    const share =
      e.budget.remainingMicros > 0 ? Math.min(999, Math.ceil((e.costMicros / e.budget.remainingMicros) * 100)) : 0;
    return { text: fill(strings.budgetShare, { share: num(share) }), tone: "info" };
  };

  const budget = estimate ? budgetLine(estimate) : null;

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={strings.title}
      primaryAction={{
        content: effectiveMode === "batch" ? strings.startBatch : strings.start,
        onAction: onStart,
        disabled: !startable,
      }}
      secondaryActions={[{ content: strings.cancel, onAction: onCancel }]}
    >
      <Modal.Section>
        <BlockStack gap="300">
          {state.status === "loading" && (
            <Text as="p" tone="subdued">
              {strings.loading}
            </Text>
          )}
          {state.status === "refused" && (
            <Banner tone="critical">
              <Text as="p">
                {strings.refusedPrefix} {state.message}
              </Text>
            </Banner>
          )}
          {state.status === "unavailable" && <Banner tone="warning">{strings.unavailable}</Banner>}
          {state.status === "nothing" && <Text as="p">{strings.nothing}</Text>}
          {estimate && (
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">
                {strings.estimateLabel}
              </Text>
              <Text as="p">{fill(strings.units, { units: num(estimate.units) })}</Text>
              <Text as="p">{fill(strings.requests, { requests: num(estimate.requests) })}</Text>
              <Text as="p">
                {fill(strings.tokens, {
                  input: num(roundTokens(estimate.inputTokens)),
                  output: num(roundTokens(estimate.outputTokens)),
                })}
              </Text>
              <Text as="p" fontWeight="semibold">
                {costLine(estimate)}
              </Text>
              {budget ? (
                <Banner tone={budget.tone}>{budget.text}</Banner>
              ) : estimate.source === "byo" ? (
                <Text as="p" variant="bodySm" tone="subdued">
                  {strings.byokNote}
                </Text>
              ) : (
                // A managed shop is never told "your provider bills you": when its
                // budget could not be read (or the cost cannot be compared) the line
                // says so neutrally.
                !estimate.budget && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {strings.budgetUnavailable}
                  </Text>
                )
              )}
              {batch && (
                <BlockStack gap="200">
                  <ChoiceList
                    title={strings.modeLabel}
                    selected={[effectiveMode]}
                    onChange={(values) => onModeChange(values[0] === "batch" ? "batch" : "sync")}
                    choices={[
                      { label: strings.modeNow, value: "sync", helpText: strings.modeNowHint },
                      { label: strings.modeBatch, value: "batch", helpText: strings.modeBatchHint },
                    ]}
                  />
                  {batch.costMicros !== null && (
                    <Text as="p" fontWeight="semibold">
                      {(() => {
                        const { text, tiny } = formatEstimateMoney(batch.costMicros, locale);
                        const value = tiny ? fill(strings.costTiny, { cost: text }) : text;
                        return fill(batch.pricedAtCeiling ? strings.batchCostCeiling : strings.batchCost, { cost: value });
                      })()}
                    </Text>
                  )}
                  {batchBlocked && <Banner tone="warning">{strings.batchBudgetExceeds}</Banner>}
                </BlockStack>
              )}
              {estimate.skippedOverCap > 0 && (
                <Text as="p" variant="bodySm" tone="caution">
                  {fill(strings.overCap, { rest: num(estimate.skippedOverCap), max: num(maxUnits) })}
                </Text>
              )}
            </BlockStack>
          )}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
