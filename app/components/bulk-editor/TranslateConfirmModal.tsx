/**
 * Confirmation dialog of the "add missing translations" page: shows what the
 * run is expected to cost BEFORE anything is spent (PLAN_BULK_TRANSLATE_BATCHING
 * 3.4). Polaris Modal with a Cancel and a Start button -- never window.confirm.
 *
 * The estimate comes from the handler's `estimateOnly` mode and is only
 * DISPLAYED here. Numbers go through formatNumber with the app locale (the
 * server and the browser must render the same text), and money is always
 * labelled as an estimate ("ca."/"about"). Phase 2's mode choice ("sofort" /
 * "guenstiger, bis zu 24 Stunden") is deliberately NOT here yet.
 */

import { Banner, BlockStack, Modal, Text } from "@shopify/polaris";
import { formatNumber } from "../../utils/format";
import type { TranslateEstimate } from "../../services/bulk-editor/translate-estimate.shared";

export type ConfirmEstimateState =
  | { status: "loading" }
  | { status: "ready"; estimate: TranslateEstimate }
  /** The shop may not run AI (no key, plan ...): the server's own sentence. */
  | { status: "refused"; message: string }
  /** The estimate could not be made; starting stays allowed. */
  | { status: "unavailable" };

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
  budgetShare: string;
  budgetExceeds: string;
  overCap: string;
  unavailable: string;
  refusedPrefix: string;
  cancel: string;
  start: string;
}

interface Props {
  open: boolean;
  state: ConfirmEstimateState;
  locale: string;
  maxUnits: number;
  strings: TranslateConfirmStrings;
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

export function TranslateConfirmModal({ open, state, locale, maxUnits, strings, onCancel, onStart }: Props) {
  const startable = state.status === "ready" || state.status === "unavailable";
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
      primaryAction={{ content: strings.start, onAction: onStart, disabled: !startable }}
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
              ) : (
                !estimate.budget && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {strings.byokNote}
                  </Text>
                )
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
