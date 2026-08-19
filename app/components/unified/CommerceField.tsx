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
 *
 * -- Three lists, not one ----------------------------------------------------
 * Shopify answers three different questions with one mechanism: a publication
 * is a SALES CHANNEL (AppCatalog), a MARKET (MarketCatalog) or a B2B company
 * location (CompanyLocationCatalog). The admin's own publishing dialog splits
 * them; this panel used to show all three under "Sales channels", so a shop
 * with markets read its regions as channels it had never installed. Grouped by
 * `catalogType` here — and an UNKNOWN one stays with the sales channels, which
 * is where it has always rendered.
 */

import { Badge, Banner, BlockStack, Box, Button, Checkbox, InlineStack, Spinner, Text } from "@shopify/polaris";
import { HelpTooltip } from "../HelpTooltip";
import { useCommerceData } from "../../contexts/CommerceDataContext";
import { countsAsSalesChannel } from "../../services/commerce-sync.shared";
import type { CommerceChannelView } from "../../routes/api.product-commerce";

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

  /**
   * The alarm counts SALES CHANNELS only. A product that sits in a market
   * catalog but on no channel is invisible exactly as if it sat nowhere, and
   * counting the market row would have hidden that. An unknown catalog still
   * counts — see `countsAsSalesChannel`.
   */
  const publishedCount = data
    ? data.channels.filter((c) => countsAsSalesChannel(c.catalogType) && channelState[c.publicationId]).length
    : 0;
  /**
   * The alarm and the "no channels installed" line are CLAIMS about the whole
   * shop, and a cut-off window cannot support either: the channel this product
   * is on may be one of the rows that did not arrive. With the window
   * truncated the panel shows the rows it has and says nothing beyond them —
   * the truncation line above already tells the merchant why.
   */
  const channelsAreComplete = !!data && !data.channelsTruncated;

  /**
   * The three lists, in the admin's own order. Built by walking the loaded
   * channels ONCE per group rather than by bucketing into a map, so the order
   * Shopify returned survives inside each group.
   */
  const groupOf = (channel: CommerceChannelView) =>
    countsAsSalesChannel(channel.catalogType) ? "channels" : channel.catalogType;
  const groups = data
    ? ([
        ["channels", (t.channelsHeading as string) || "Sales channels"],
        ["market", (t.marketsHeading as string) || "Markets"],
        ["companyLocation", (t.b2bHeading as string) || "B2B catalogs"],
      ] as const)
        .map(([id, heading]) => ({
          id,
          heading,
          channels: data.channels.filter((c) => groupOf(c) === id),
        }))
        // The SALES CHANNEL list stays even when it is empty — that is the
        // state the "invisible" alarm exists for, and a shop whose only
        // publications are market catalogs would otherwise drop the alarm
        // together with the heading. The other two only appear if the shop
        // has them.
        .filter((group) => group.id === "channels" || group.channels.length > 0)
    : [];

  const renderChannel = (channel: CommerceChannelView) => (
    <Checkbox
      key={channel.publicationId}
      label={channel.name || channel.publicationId}
      checked={channelState[channel.publicationId] === true}
      disabled={saving}
      // A future publish date is NOT "live". Saying "scheduled" rather than
      // showing it as published is what keeps a planned launch from looking
      // like a mistake.
      helpText={
        channel.publishDate && !channel.isPublished
          ? ((t.scheduled as string) || "Scheduled for {date}").replace(
              "{date}",
              new Date(channel.publishDate).toLocaleDateString(),
            )
          : undefined
      }
      onChange={(checked) => setChannelState((prev) => ({ ...prev, [channel.publicationId]: checked }))}
    />
  );

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
          {data.channelsTruncated && (
            <Text as="p" variant="bodySm" tone="subdued">
              {(t.channelsTruncated as string) || "More channels exist than were loaded. Manage the rest in the Shopify admin."}
            </Text>
          )}

          {groups.map((group) => (
            <BlockStack gap="200" key={group.id}>
              <InlineStack gap="200" blockAlign="center">
                <Text as="h3" variant="headingSm">{group.heading}</Text>
                {/* The help and the alarm belong to the SALES CHANNEL list.
                    A product missing from a market catalog is a narrower
                    thing than being invisible everywhere, and saying
                    "invisible" over the region list would overstate it. */}
                {group.id === "channels" && <HelpTooltip helpKey="commerceChannels" />}
                {group.id === "channels" && channelsAreComplete && publishedCount === 0 && (
                  <Badge tone="critical">{(t.noChannel as string) || "On no channel — invisible"}</Badge>
                )}
              </InlineStack>

              {/* Regions and B2B catalogs answer "who may see it", not
                  "where is it sold" — merchants reliably read them as
                  channels, which is the whole reason they now sit apart. */}
              {group.id === "market" && (
                <Text as="p" variant="bodySm" tone="subdued">
                  {(t.marketsHint as string) ||
                    "Regions decide who can see the product, not where it is sold. Off means it is hidden in that region."}
                </Text>
              )}
              {group.id === "companyLocation" && (
                <Text as="p" variant="bodySm" tone="subdued">
                  {(t.b2bHint as string) || "B2B catalogs decide which business customers can see the product."}
                </Text>
              )}

              {group.channels.length === 0 ? (
                channelsAreComplete ? (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {(t.noChannels as string) || "This shop has no sales channels installed."}
                  </Text>
                ) : null
              ) : (
                /* Horizontal, wrapping. A shop has a handful of entries with
                   short names, and one full-width row each turned six words
                   into six lines. */
                <InlineStack gap="400" wrap>
                  {group.channels.map(renderChannel)}
                </InlineStack>
              )}
            </BlockStack>
          ))}
        </>
      )}
    </BlockStack>
  );
}
