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
 * `catalogType` (`groupPublications`) — and an UNKNOWN one stays with the
 * sales channels, which is where it has always rendered.
 *
 * -- Everything in the card, on pill toggles ---------------------------------
 * The three lists lived behind a "Manage" dialog for one release. It bought
 * nothing: the same controls, one click further away, and a dialog that has to
 * survive reloads and re-explain its own headings. They are back in the card,
 * on the `ToggleSwitch` rows this app uses for a setting of this kind
 * everywhere else — a publication is on or off, which is what a switch says
 * and what a checkbox in a wrapping row did not.
 */

import { Badge, Banner, BlockStack, Box, Button, InlineStack, Spinner, Text } from "@shopify/polaris";
import { HelpTooltip } from "../HelpTooltip";
import { ToggleSwitch } from "../ToggleSwitch";
import { useCommerceData } from "../../contexts/CommerceDataContext";
import { groupPublications, type PublicationGroupId } from "../../services/commerce-sync.shared";
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
   * The alarm and the "no channels installed" line are CLAIMS about the whole
   * shop, and a cut-off window cannot support either: the channel this product
   * is on may be one of the rows that did not arrive. With the window
   * truncated the panel shows the rows it has and says nothing beyond them —
   * the truncation line above already tells the merchant why.
   */
  const channelsAreComplete = !!data && !data.channelsTruncated;

  /** The three lists, always in the admin's order. */
  const groups = data ? groupPublications(data.channels) : [];

  /**
   * The alarm counts SALES CHANNELS only — a product that sits in a market
   * catalog but on no channel is invisible exactly as if it sat nowhere, and
   * counting the market row would have hidden that. Taken from the grouped
   * list so there is one rule for which row is a channel, and read off
   * `channelState` rather than off the loaded rows: an untick has to raise the
   * alarm before the save, because the merchant is looking at what the save
   * bar is about to write.
   */
  const publishedChannelCount = (groups.find((group) => group.id === "channels")?.rows ?? []).filter(
    (channel) => channelState[channel.publicationId] === true,
  ).length;

  /**
   * `heading` is OPTIONAL, and the sales-channel group deliberately has none:
   * the field's own label already says "Sales channels", and a heading under
   * it said the same thing twice. The other two groups need theirs — nothing
   * else on the card names them.
   */
  const GROUP_TEXT: Record<PublicationGroupId, { heading?: string; hint?: string }> = {
    channels: {},
    // Regions and B2B catalogs answer "who may see it", not "where is it
    // sold" — merchants reliably read them as channels, which is the whole
    // reason they sit apart and carry a line each.
    market: {
      heading: (t.marketsHeading as string) || "Regions",
      hint:
        (t.marketsHint as string) ||
        "Regions decide who may see the product, not where it is sold. Off means it is hidden in that region.",
    },
    companyLocation: {
      heading: (t.b2bHeading as string) || "B2B catalogs",
      hint: (t.b2bHint as string) || "B2B catalogs decide which business customers can see the product.",
    },
  };

  /**
   * One publication, as the pill-toggle row this app uses for a setting of
   * this kind everywhere else. A publication is on or off, which is what a
   * switch states — and it reads as a state rather than as a form field, which
   * a checkbox in a wrapping row did not.
   */
  const renderChannel = (channel: CommerceChannelView) => {
    const name = channel.name || channel.publicationId;
    // A future publish date is NOT "live". Saying "scheduled" rather than
    // showing it as published is what keeps a planned launch from looking
    // like a mistake.
    const scheduled =
      channel.publishDate && !channel.isPublished
        ? ((t.scheduled as string) || "Scheduled for {date}").replace(
            "{date}",
            new Date(channel.publishDate).toLocaleDateString(),
          )
        : null;

    return (
      <InlineStack key={channel.publicationId} gap="300" blockAlign="center" wrap={false}>
        <ToggleSwitch
          checked={channelState[channel.publicationId] === true}
          disabled={saving}
          ariaLabel={name}
          onChange={(checked) =>
            setChannelState((prev) => ({ ...prev, [channel.publicationId]: checked }))
          }
        />
        <BlockStack gap="050">
          <Text as="p" variant="bodyMd">{name}</Text>
          {scheduled && <Text as="p" variant="bodySm" tone="subdued">{scheduled}</Text>}
        </BlockStack>
      </InlineStack>
    );
  };

  return (
    <BlockStack gap="300">
      {/* ONE header row. The field's own label already says "sales channels";
          a second heading under it said it twice, and the alarm belongs beside
          the name it is about. */}
      <InlineStack gap="200" blockAlign="center" wrap>
        <Text as="p" variant="bodyMd">{label}</Text>
        <HelpTooltip helpKey="commerceChannels" />
        {/* §2.3 — the trap this feature exists for. Not a subtle hint: a
            product on no channel is invisible everywhere. Silent when the
            window was cut off: that is a claim about the whole shop, and a
            partial answer cannot carry it. */}
        {channelsAreComplete && publishedChannelCount === 0 && (
          <Badge tone="critical">{(t.noChannel as string) || "On no channel — invisible"}</Badge>
        )}
      </InlineStack>

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

          {data.catalogsKnown === false && (
            <Text as="p" variant="bodySm" tone="subdued">
              {(t.catalogsUnknown as string) ||
                "Regions and B2B catalogs could not be read, so they are not listed here — manage them in your Shopify admin."}
            </Text>
          )}

          {groups.map((group) => (
            <BlockStack gap="300" key={group.id}>
              {GROUP_TEXT[group.id].heading && (
                <Text as="h3" variant="headingSm">{GROUP_TEXT[group.id].heading}</Text>
              )}

              {GROUP_TEXT[group.id].hint && (
                <Text as="p" variant="bodySm" tone="subdued">{GROUP_TEXT[group.id].hint}</Text>
              )}

              {/* Only the SALES CHANNEL group survives empty (groupPublications
                  drops the other two), so this line is always about channels. */}
              {group.rows.length === 0
                ? channelsAreComplete && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      {(t.noChannels as string) || "This shop has no sales channels installed."}
                    </Text>
                  )
                : group.rows.map(renderChannel)}
            </BlockStack>
          ))}
        </>
      )}
    </BlockStack>
  );
}
