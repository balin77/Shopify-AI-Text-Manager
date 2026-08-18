/**
 * The sales-channel half of the commerce panel.
 *
 * -- Why it is only half now -------------------------------------------------
 * This component used to render the channels AND every variant's prices, stock
 * and shipping settings. The variant half moved into the variants card, where
 * it belongs: it describes the same options that card is about, and a merchant
 * pricing "Weiss / 20cm" was reading it two cards away from the list that says
 * what "Weiss" is. What stayed here is the part that is a property of the
 * PRODUCT rather than of any variant.
 *
 * The state did not move with either half — it lives in `CommerceDataContext`,
 * because there is one live load, one set of pending edits and one
 * registration with the editor's save bar.
 *
 * -- §2.3, made visible ------------------------------------------------------
 * `status: ACTIVE` is not visibility. A product active but published to no
 * channel is invisible everywhere, and the Shopify admin does not say so on the
 * product page either. The channel list is the whole reason that trap has a
 * cure here.
 */

import { Badge, Banner, BlockStack, Box, Button, Checkbox, InlineStack, Spinner, Text } from "@shopify/polaris";
import { HelpTooltip } from "../HelpTooltip";
import { useCommerceData } from "../../contexts/CommerceDataContext";

export function CommerceField({ label }: { label: string }) {
  const commerce = useCommerceData();
  // No provider ⇒ not a product. Nothing to say.
  if (!commerce) return null;

  const { data, loadError, planBlocked, notices, setNotices, load, isPrimaryLocale, t, channelState, setChannelState, saving } =
    commerce;

  if (!isPrimaryLocale) {
    return (
      <BlockStack gap="200">
        <Text as="p" variant="bodyMd">{label}</Text>
        <Banner tone="info">
          <p>{(t.foreignLocale as string) || "Stock and sales channels exist once per product, not per language."}</p>
        </Banner>
      </BlockStack>
    );
  }

  if (planBlocked) {
    return (
      <BlockStack gap="200">
        <Text as="p" variant="bodyMd">{label}</Text>
        <Banner tone="info">
          <p>{(t.planRequired as string) || "Stock and sales channels are part of the Pro plan."}</p>
          {/* The one case where the bulk editor is still the answer: without
              this panel there is nowhere else to price a multi-variant
              product. */}
          <p>{(t.variantPricesHint as string) || "Prices of several variants are edited in the bulk editor."}</p>
        </Banner>
      </BlockStack>
    );
  }

  const publishedCount = data ? data.channels.filter((c) => channelState[c.publicationId]).length : 0;

  return (
    <BlockStack gap="300">
      <Text as="p" variant="bodyMd">{label}</Text>

      {loadError && (
        <Banner tone="warning">
          <BlockStack gap="200">
            <Text as="p">{loadError}</Text>
            <Box><Button onClick={() => load()}>{(t.retry as string) || "Try again"}</Button></Box>
          </BlockStack>
        </Banner>
      )}

      {!data && !loadError && <Spinner size="small" accessibilityLabel={(t.loading as string) || "Loading"} />}

      {/* The notices belong to whichever half produced them, and a save writes
          both — so they are rendered here, where the panel has always shown
          them, rather than duplicated into the variants card. */}
      {notices.length > 0 && (
        <Banner tone="warning" onDismiss={() => setNotices([])}>
          <BlockStack gap="100">
            {notices.map((notice, index) => (
              <Text as="p" key={index}>{notice}</Text>
            ))}
          </BlockStack>
        </Banner>
      )}

      {data && (
        <>
          {/* ── Sales channels ─────────────────────────────────────────── */}
          <BlockStack gap="200">
            <InlineStack gap="200" blockAlign="center">
              <Text as="h3" variant="headingSm">{(t.channelsHeading as string) || "Sales channels"}</Text>
              <HelpTooltip helpKey="commerceChannels" />
              {/* §2.3 — the trap this feature exists for. Not a subtle hint:
                  a product on no channel is invisible everywhere. */}
              {publishedCount === 0 && (
                <Badge tone="critical">{(t.noChannel as string) || "On no channel — invisible"}</Badge>
              )}
            </InlineStack>

            {data.channelsTruncated && (
              <Text as="p" variant="bodySm" tone="subdued">
                {(t.channelsTruncated as string) || "More channels exist than were loaded. Manage the rest in the Shopify admin."}
              </Text>
            )}

            {data.channels.length === 0 ? (
              <Text as="p" variant="bodySm" tone="subdued">
                {(t.noChannels as string) || "This shop has no sales channels installed."}
              </Text>
            ) : (
              /* Horizontal, wrapping. A shop has a handful of channels with
                 short names, and one full-width row each turned six words into
                 six lines. */
              <InlineStack gap="400" wrap>
              {data.channels.map((channel) => (
                <Checkbox
                  key={channel.publicationId}
                  label={channel.name || channel.publicationId}
                  checked={channelState[channel.publicationId] === true}
                  disabled={saving}
                  // A future publish date is NOT "live". Saying "scheduled"
                  // rather than showing it as published is what keeps a
                  // planned launch from looking like a mistake.
                  helpText={
                    channel.publishDate && !channel.isPublished
                      ? ((t.scheduled as string) || "Scheduled for {date}").replace(
                          "{date}",
                          new Date(channel.publishDate).toLocaleDateString(),
                        )
                      : undefined
                  }
                  onChange={(checked) =>
                    setChannelState((prev) => ({ ...prev, [channel.publicationId]: checked }))
                  }
                />
              ))}
              </InlineStack>
            )}
          </BlockStack>
        </>
      )}
    </BlockStack>
  );
}
