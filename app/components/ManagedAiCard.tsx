/**
 * Where the AI comes from — PLAN_MANAGED_AI_KEY §8, §8a.
 *
 * NO switch: which AI a shop uses is decided by its PLAN (`wantsManagedAi`,
 * the owner's decision 2026-10-01) — a plan with AI uses ours, otherwise the
 * merchant's own key, otherwise (once consented) the one-time taster. The
 * plan tab sells the variant; this card says which case applies, shows the
 * usage, holds the consent and the stored keys.
 *
 * The card renders by budget KIND, never by plan, because every sentence
 * about a period is false about a grant that does not come back.
 *
 * Rules here are structural rather than cosmetic:
 *
 * - **Consent is its own act, with its own button.** Never folded into a Save
 *   bar that also carries five other settings: a box that becomes consent
 *   when something else is saved is exactly the bundled consent the
 *   compliance audit refuses (§2 rule 1). It is the one control in this app
 *   that deliberately breaks the "a click is a draft until Save" rule, and it
 *   breaks it in the stricter direction — nothing is granted implicitly.
 * - **The stored keys survive**, and the merchant can still erase them.
 *   Hiding the tab without that would leave "uninstall the app" as the only
 *   way to remove a credential they gave us.
 */

import { useState } from "react";
import { useFetcher } from "react-router";
import {
  BlockStack,
  Banner,
  Button,
  Card,
  InlineStack,
  Link,
  ProgressBar,
  Text,
} from "@shopify/polaris";
import type { FetcherWithComponents } from "react-router";
import { AI_PROCESSING_CONSENT_VERSION } from "../services/ai/managed-ai.shared";

export interface ManagedAiBudget {
  usedMicros: number;
  limitMicros: number;
  /** ISO date this period's volume resets — `null` for the taster, which does not. */
  resetsOn: string | null;
  /** The figures could not be read. 0 % and "no warning" would both be lies. */
  readFailed?: boolean;
  /** Share of calls whose token counts were estimated, 0-1. */
  estimatedShare: number;
  /** A period budget that resets, or the one-time taster (§10). */
  kind: "period" | "taster";
  /** ISO date the taster was first spent against. */
  grantedAt: string | null;
}

export interface ManagedAiCardProps {
  /**
   * On managed AI right now. Decided by the PLAN (`wantsManagedAi`): an
   * AI-included subscription, or — without one and without a key of its own,
   * once consented — the one-time taster. Not switchable here.
   */
  onManaged: boolean;
  /** Shopify verified the shop BOUGHT the AI-included variant. */
  managedAiActive: boolean;
  /** This DEPLOYMENT can serve managed AI at all (§9.4's kill switch). */
  managedAiOffered?: boolean;
  /**
   * What the one-time taster is worth here, in AI actions — the unit the
   * merchant reads, and the only number the offer sentence carries.
   *
   * It comes from the ENVIRONMENT, not from the usage aggregate, so it is
   * available to a shop that has not switched anything on yet. Computing it
   * with the budget meant the acquisition sentence read "about  AI actions"
   * to exactly the population it exists for.
   */
  tasterActions?: number;
  /** The one-time grant is gone. Not an invitation any more. */
  tasterSpent?: boolean;
  consented: boolean;
  consentedAt?: string | null;
  consentVersion?: string | null;
  storedApiKeyCount: number;
  /**
   * A key is stored for the PREFERRED provider — the same question
   * `wantsManagedAi` asks. `storedApiKeyCount` counts every provider and
   * would call a shop "on its own key" while the resolver serves it the taster.
   */
  ownKeyStored?: boolean;
  budget?: ManagedAiBudget | null;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  fetcher: FetcherWithComponents<any>;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  t: any;
}

const pct = (used: number, limit: number) =>
  limit <= 0 ? 100 : Math.min(100, Math.round((used / limit) * 100));

const fill = (template: unknown, values: Record<string, string>): string => {
  let out = typeof template === "string" ? template : "";
  for (const [k, v] of Object.entries(values)) out = out.replace(`{${k}}`, v);
  return out;
};

export function ManagedAiCard({
  onManaged,
  managedAiActive,
  managedAiOffered = false,
  tasterActions = 0,
  tasterSpent = false,
  consented,
  consentedAt,
  consentVersion,
  storedApiKeyCount,
  ownKeyStored = false,
  budget,
  fetcher: pageFetcher,
  t,
}: ManagedAiCardProps) {
  // Its OWN fetcher, not the page's. `router.fetch` aborts whatever is in
  // flight on the same key, so a consent grant, a mode change or a key
  // deletion posted on the shared one dies silently the moment the AI tab's
  // save bar fires — and consent is the one post in this app that may not
  // quietly not happen. The page's fetcher is still accepted and ignored, so
  // the prop stays part of one bundle with the rest of the card's state.
  void pageFetcher;
  const fetcher = useFetcher<unknown>();
  const m = t?.settings?.managedAi ?? {};
  const [armedDelete, setArmedDelete] = useState(false);


  // What the server said about the last post. The card's posts are all
  // refusable — a consent against a changed text (409), a mode the deployment
  // cannot serve (403), a failed key deletion — and a refusal nobody sees
  // reads as "it worked" to the merchant who clicked.
  const lastResult =
    fetcher.state === "idle"
      ? (fetcher.data as { success?: boolean; error?: string; code?: string } | undefined)
      : undefined;
  // A refusal with a CODE is phrased from the bundle — the server's `error`
  // is English and this card ships in three languages.
  const lastError =
    lastResult && lastResult.success === false
      ? (lastResult.code === "consentTextChanged"
          ? m.consentTextChanged
          : lastResult.code === "managedAiNotAvailable"
            ? m.notAvailableNotice
            : undefined) ||
        lastResult.error ||
        ""
      : null;

  const busy = (action: string) =>
    fetcher.state !== "idle" && fetcher.formData?.get("actionType") === action;

  const post = (fields: Record<string, string>) => {
    const body = new FormData();
    for (const [k, v] of Object.entries(fields)) body.append(k, v);
    fetcher.submit(body, { method: "post" });
  };

  const onTaster = budget?.kind === "taster";
  const usedPct = budget ? pct(budget.usedMicros, budget.limitMicros) : 0;

  // Which AI this shop uses is decided by its PLAN — there is no switch here
  // (the owner's decision, 2026-10-01). The line says which case applies, and
  // the four cases must stay apart: collapsing them is how a merchant paying
  // the surcharge once read "your plan no longer includes AI".
  const hint = managedAiActive
    ? m.includedHint
    : !managedAiOffered
      ? m.notIncludedHint
      : !onManaged && ownKeyStored
        ? m.ownKeyHint
        : tasterSpent
          ? m.tasterExhausted
          : fill(m.tasterHint, { actions: String(tasterActions || "") });
  // Consent is the opt-in to the taster as well as the precondition of a
  // plan with AI, so it is asked wherever either can apply — and stays
  // visible once given, so it can be withdrawn.
  const showConsent =
    managedAiOffered && (managedAiActive || !ownKeyStored || consented);

  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingMd">
            {m.heading}
          </Text>

          {lastError !== null && (
            <Banner tone="critical">
              <Text as="p">{lastError || t?.common?.error || "Error"}</Text>
            </Banner>
          )}

          {/* Three different shops read this line: one that bought the AI, one
              that has not and is being offered the taster, and one whose
              deployment serves no managed AI at all. Telling the middle one
              "your plan does not include AI" and stopping there is what made
              the taster invisible to the population it exists for. */}
          <Text as="p" variant="bodySm" tone="subdued">
            {hint}
          </Text>

        </BlockStack>
      </Card>

      {/* Consent — only where it is needed, and never pre-set. */}
      {showConsent && (
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">
              {m.consentHeading}
            </Text>
            <Text as="p" variant="bodySm">
              {m.consentBody}
            </Text>
            <Link url="/privacy" target="_blank" removeUnderline>
              {m.privacyLink}
            </Link>

            {consented ? (
              <InlineStack gap="300" blockAlign="center">
                <Text as="p" variant="bodySm" tone="success">
                  {fill(m.consentGranted, {
                    date: consentedAt ? consentedAt.slice(0, 10) : "",
                    version: consentVersion ?? "",
                  })}
                </Text>
                <Button
                  variant="plain"
                  tone="critical"
                  loading={busy("saveAiProcessingConsent")}
                  onClick={() =>
                    post({ actionType: "saveAiProcessingConsent", consent: "false" })
                  }
                >
                  {m.consentWithdraw}
                </Button>
              </InlineStack>
            ) : (
              <BlockStack gap="200">
                <Banner tone="info">
                  <Text as="p">{m.consentRequired}</Text>
                </Banner>
                <Text as="p" variant="bodySm">
                  {m.consentLabel}
                </Text>
                <InlineStack>
                  <Button
                    variant="primary"
                    loading={busy("saveAiProcessingConsent")}
                    onClick={() =>
                      post({
                      actionType: "saveAiProcessingConsent",
                      consent: "true",
                      // The version the merchant is LOOKING at. A deploy
                      // between this render and the click would otherwise
                      // record agreement to text nobody read.
                      consentVersion: AI_PROCESSING_CONSENT_VERSION,
                    })
                    }
                  >
                    {m.consentSave}
                  </Button>
                </InlineStack>
              </BlockStack>
            )}
          </BlockStack>
        </Card>
      )}

      {/* Usage — the same shape as the image-operation quota it mirrors. */}
      {onManaged && budget && (
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">
              {onTaster ? m.tasterHeading : m.usageHeading}
            </Text>
            {budget.readFailed ? (
              // 0 % and "no warning" are both lies about a figure we could not
              // read, and the card would say them while every call refuses.
              <Banner tone="warning">
                <Text as="p">{m.usageUnavailable}</Text>
              </Banner>
            ) : (
              <ProgressBar
                progress={usedPct}
                tone={usedPct >= 100 ? "critical" : usedPct >= 80 ? "highlight" : "primary"}
              />
            )}
            {/* Every sentence in this card is chosen by KIND, not decorated
                with an extra line: a period budget "resets on the 14th" and a
                taster never does, so one wording cannot serve both without
                promising a reset that will not come. */}
            {!budget.readFailed && (
              <Text as="p" variant="bodySm">
                {fill(onTaster ? m.tasterUsed : m.usageUsed, { percent: String(usedPct) })}
              </Text>
            )}
            {onTaster
              ? budget.grantedAt && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {fill(m.tasterStarted, { date: budget.grantedAt.slice(0, 10) })}
                  </Text>
                )
              : budget.resetsOn && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {fill(m.usageResets, { date: budget.resetsOn.slice(0, 10) })}
                  </Text>
                )}
            {/* A warning BEFORE a wall: "your AI volume is used up" arriving
                with no notice, mid-catalogue, is the review nobody wants. */}
            {budget.readFailed ? null : usedPct >= 100 ? (
              <Banner tone="critical">
                <Text as="p">{onTaster ? m.tasterExhausted : m.usageExhausted}</Text>
              </Banner>
            ) : usedPct >= 80 ? (
              <Banner tone="warning">
                <Text as="p">
                  {fill(onTaster ? m.tasterWarning : m.usageWarning, {
                    percent: String(usedPct),
                  })}
                </Text>
              </Banner>
            ) : null}
            {/* Said only when it is non-trivial: every figure is partly
                estimated, and a permanent disclaimer teaches people to skip
                it. */}
            {budget.estimatedShare > 0.1 && (
              <Text as="p" variant="bodySm" tone="subdued">
                {m.usageEstimated}
              </Text>
            )}
          </BlockStack>
        </Card>
      )}

      {/* The stored keys, and the way to erase them. Rendered only where the
          key fields themselves are hidden — otherwise it would be a second,
          quieter copy of what the merchant is already looking at. The fields
          are hidden only under a plan with AI. */}
      {managedAiActive && (
        <Card>
          <BlockStack gap="300">
            <Text as="p" variant="bodySm">
              {storedApiKeyCount > 0
                ? fill(m.storedKeys, { count: String(storedApiKeyCount) })
                : m.storedKeysNone}
            </Text>
            {storedApiKeyCount > 0 && (
              <BlockStack gap="200">
                {/* Armed by a second BUTTON, never by window.confirm: that
                    dialog is chrome from outside the app and, in an embedded
                    app, shows the merchant the myshopify host. */}
                {armedDelete && (
                  <Text as="p" variant="bodySm" tone="critical">
                    {m.deleteKeysWarning}
                  </Text>
                )}
                <InlineStack gap="300" blockAlign="center">
                  {armedDelete ? (
                    <>
                      <Button
                        tone="critical"
                        variant="primary"
                        loading={busy("deleteAiKeys")}
                        onClick={() => {
                          post({ actionType: "deleteAiKeys" });
                          setArmedDelete(false);
                        }}
                      >
                        {m.deleteKeysConfirm}
                      </Button>
                      <Button variant="plain" onClick={() => setArmedDelete(false)}>
                        {t?.common?.cancel ?? "Cancel"}
                      </Button>
                    </>
                  ) : (
                    <Button onClick={() => setArmedDelete(true)}>{m.deleteKeys}</Button>
                  )}
                </InlineStack>
              </BlockStack>
            )}
          </BlockStack>
        </Card>
      )}
    </BlockStack>
  );
}
