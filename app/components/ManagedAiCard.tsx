/**
 * Where the AI comes from — PLAN_MANAGED_AI_KEY §8, §8a.
 *
 * ONE choice, rendered from ONE state: the merchant's stored `aiKeySource`
 * and the Shopify-verified `managedAiActive`. The plan card sells the variant
 * (it is a price); this is where the merchant lives with it.
 *
 * Four rules here are structural rather than cosmetic:
 *
 * - **The way back is never hidden.** In managed mode the six key fields, the
 *   provider select and the model select are noise — none of them affects
 *   anything, and a screen of inert inputs invites a merchant to fill them in
 *   and wonder why nothing changes. What stays is the SWITCH, because "add
 *   your own key and continue immediately" has to be true from the cap
 *   message itself, not only after the mode has already changed.
 * - **Switching modes is a COLUMN, not a price.** It takes effect from the
 *   next call and touches no billing. Changing the PLAN is the separate,
 *   Shopify-routed action with a confirmation and proration; offering that as
 *   the one-click escape at a budget wall would be a lie.
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
import { ToggleRow } from "./ToggleRow";

export interface ManagedAiBudget {
  usedMicros: number;
  limitMicros: number;
  /** ISO date this period's volume resets. */
  resetsOn: string | null;
  /** Share of calls whose token counts were estimated, 0-1. */
  estimatedShare: number;
}

export interface ManagedAiCardProps {
  aiKeySource: "byo" | "managed";
  managedAiActive: boolean;
  consented: boolean;
  consentedAt?: string | null;
  consentVersion?: string | null;
  storedApiKeyCount: number;
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
  aiKeySource,
  managedAiActive,
  consented,
  consentedAt,
  consentVersion,
  storedApiKeyCount,
  budget,
  fetcher,
  t,
}: ManagedAiCardProps) {
  const m = t?.settings?.managedAi ?? {};
  const [armedDelete, setArmedDelete] = useState(false);

  const busy = (action: string) =>
    fetcher.state !== "idle" && fetcher.formData?.get("actionType") === action;

  const post = (fields: Record<string, string>) => {
    const body = new FormData();
    for (const [k, v] of Object.entries(fields)) body.append(k, v);
    fetcher.submit(body, { method: "post" });
  };

  const onManaged = aiKeySource === "managed" && managedAiActive;
  const usedPct = budget ? pct(budget.usedMicros, budget.limitMicros) : 0;

  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingMd">
            {m.heading}
          </Text>

          {/* The entitlement ended while the merchant's choice still says
              "managed". Their own key is being used again — the friendly
              fallback, and not something to discover by noticing a different
              writing style. */}
          {aiKeySource === "managed" && !managedAiActive && (
            <Banner tone="warning">
              <Text as="p">{m.entitlementEnded}</Text>
            </Banner>
          )}

          <ToggleRow
            label={m.useIncluded ?? ""}
            checked={onManaged}
            disabled={!managedAiActive || busy("saveAiSource")}
            onChange={(checked) =>
              post({ actionType: "saveAiSource", aiKeySource: checked ? "managed" : "byo" })
            }
          />

          <Text as="p" variant="bodySm" tone="subdued">
            {managedAiActive ? m.includedHint : m.notIncludedHint}
          </Text>
        </BlockStack>
      </Card>

      {/* Consent — only where it is needed, and never pre-set. */}
      {aiKeySource === "managed" && managedAiActive && (
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">
              {m.consentHeading}
            </Text>
            <Text as="p" variant="bodySm">
              {m.consentBody}
            </Text>
            <Link url="/app/privacy" removeUnderline>
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
                      post({ actionType: "saveAiProcessingConsent", consent: "true" })
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
              {m.usageHeading}
            </Text>
            <ProgressBar
              progress={usedPct}
              tone={usedPct >= 100 ? "critical" : usedPct >= 80 ? "highlight" : "primary"}
            />
            <Text as="p" variant="bodySm">
              {fill(m.usageUsed, { percent: String(usedPct) })}
            </Text>
            {budget.resetsOn && (
              <Text as="p" variant="bodySm" tone="subdued">
                {fill(m.usageResets, { date: budget.resetsOn.slice(0, 10) })}
              </Text>
            )}
            {/* A warning BEFORE a wall: "your AI volume is used up" arriving
                with no notice, mid-catalogue, is the review nobody wants. */}
            {usedPct >= 100 ? (
              <Banner tone="critical">
                <Text as="p">{m.usageExhausted}</Text>
              </Banner>
            ) : usedPct >= 80 ? (
              <Banner tone="warning">
                <Text as="p">{fill(m.usageWarning, { percent: String(usedPct) })}</Text>
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
          quieter copy of what the merchant is already looking at. */}
      {onManaged && (
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
