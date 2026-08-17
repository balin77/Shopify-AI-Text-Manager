/**
 * PLAN_CONTENT_CREATION Phase 4, step 6 — why the app now asks to see stock
 * and sales channels.
 *
 * ── Why this is scope, not polish ───────────────────────────────────────────
 * A scope change forces EVERY installed merchant through Shopify's re-consent
 * dialog. That dialog lists permissions and explains nothing, and a permission
 * request that arrives with no reason is what makes people decline — or
 * uninstall. The plan puts this notice in the phase for exactly that reason:
 * it is part of shipping the scopes, not a follow-up.
 *
 * ── What it says, and what it does not ──────────────────────────────────────
 * It names the three permissions, says what each one is FOR, and says plainly
 * that the app does not change stock on its own. It does not sell the feature:
 * a merchant reading a permission notice wants to know the cost, and the
 * feature tour belongs where the feature is.
 *
 * Dismissed per shop and remembered as a TIMESTAMP, so a future notice can be
 * told apart from this one without a second column.
 */

import { useCallback, useState } from "react";
import { Banner, BlockStack, List, Text } from "@shopify/polaris";

export interface CommerceScopeNoticeProps {
  /** False once the merchant dismissed it — the banner then renders nothing. */
  show: boolean;
  t: {
    title?: string;
    intro?: string;
    inventory?: string;
    locations?: string;
    publications?: string;
    reassurance?: string;
    dismiss?: string;
  };
}

export function CommerceScopeNotice({ show, t }: CommerceScopeNoticeProps) {
  // Optimistic locally so the banner disappears on click; the write is
  // fire-and-forget because a failed dismissal costs the merchant one more
  // dismissal, not data.
  const [hidden, setHidden] = useState(false);

  const dismiss = useCallback(() => {
    setHidden(true);
    void fetch("/api/commerce-notice", { method: "POST" }).catch(() => undefined);
  }, []);

  if (!show || hidden) return null;

  return (
    <Banner
      tone="info"
      title={t.title || "ContentPilot now asks to see stock and sales channels"}
      onDismiss={dismiss}
    >
      <BlockStack gap="200">
        <Text as="p">
          {t.intro ||
            "So you can manage a product completely here instead of switching to the Shopify admin, the app needs three more permissions:"}
        </Text>
        <List>
          <List.Item>
            {t.inventory || "Inventory — to show stock per location and let you correct it."}
          </List.Item>
          <List.Item>
            {t.locations || "Locations — stock is always per location, so the names have to come from somewhere."}
          </List.Item>
          <List.Item>
            {t.publications ||
              "Sales channels — an active product published to no channel is invisible, and nothing tells you today."}
          </List.Item>
        </List>
        <Text as="p" tone="subdued">
          {t.reassurance ||
            "The app never changes stock on its own. It only writes what you enter, and only after Shopify confirms the new number."}
        </Text>
      </BlockStack>
    </Banner>
  );
}
