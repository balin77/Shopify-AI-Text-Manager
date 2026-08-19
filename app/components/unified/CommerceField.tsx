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
 * -- The card STATES, the dialog CHANGES -------------------------------------
 * On a shop with markets and B2B catalogs the three lists are a page's worth
 * of checkboxes inside a card meant to be read at a glance. So the card is a
 * sentence — where the product is published, and the alarm when that is
 * nowhere — and `PublishingModal` behind "Manage" is where it is edited. The
 * dialog holds no state of its own: it writes the same `channelState`, and
 * the editor's one save bar writes that.
 */

import { useState } from "react";
import { Badge, Banner, BlockStack, Box, Button, InlineStack, Spinner, Text } from "@shopify/polaris";
import { HelpTooltip } from "../HelpTooltip";
import { useCommerceData } from "../../contexts/CommerceDataContext";
import { countsAsSalesChannel, groupPublications } from "../../services/commerce-sync.shared";
import { PublishingModal } from "./PublishingModal";

export function CommerceField({ label }: { label: string }) {
  const [manageOpen, setManageOpen] = useState(false);
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

  /** The three lists, always in the admin's order — shared with the dialog. */
  const groups = data ? groupPublications(data.channels) : [];

  /**
   * The card's sentence: which SALES CHANNELS the product is on right now.
   *
   * Read off `channelState`, not off the loaded rows, so an untick shows in
   * the summary before it is saved — the merchant is looking at what the save
   * bar is about to write, not at what Shopify last said.
   */
  const liveNames = (id: (typeof groups)[number]["id"]) =>
    (groups.find((group) => group.id === id)?.rows ?? [])
      .filter((channel) => channelState[channel.publicationId] === true)
      .map((channel) => channel.name || channel.publicationId);

  const publishedChannelNames = liveNames("channels");
  const publishedMarketCount = liveNames("market").length;
  const publishedB2bCount = liveNames("companyLocation").length;

  /**
   * Counts stay silent at zero: "0 Regionen" reads as a fault, not a state.
   *
   * These count CATALOGS, not markets — one region catalog can cover several
   * markets. That is also what Shopify's own dialog counts in its sidebar, so
   * the two agree. The strings are written "Regionen: 3" rather than
   * "3 Regionen" so that one of them does not need a second, singular form.
   */
  const scopeSummary = [
    publishedMarketCount > 0 &&
      ((t.marketCount as string) || "Regions: {count}").replace("{count}", String(publishedMarketCount)),
    publishedB2bCount > 0 &&
      ((t.b2bCount as string) || "B2B catalogs: {count}").replace("{count}", String(publishedB2bCount)),
  ]
    .filter(Boolean)
    .join(" · ");

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
        {channelsAreComplete && publishedCount === 0 && (
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

          {/* The state as a sentence. Naming the channels beats a count: "on 2
              channels" leaves the merchant to open the dialog to learn WHICH,
              which is the one question the card exists to answer. */}
          <Text as="p" variant="bodyMd">
            {publishedChannelNames.length > 0
              ? publishedChannelNames.join(", ")
              : channelsAreComplete
                ? ((t.noneSelected as string) || "Not published on any sales channel")
                : "—"}
          </Text>

          {scopeSummary && (
            <Text as="p" variant="bodySm" tone="subdued">{scopeSummary}</Text>
          )}

          <Box>
            <Button onClick={() => setManageOpen(true)} disabled={saving}>
              {(t.manage as string) || "Manage"}
            </Button>
          </Box>

        </>
      )}

      {/* OUTSIDE the `data &&` branch: `load()` starts by clearing `data`, so
          a save or a reload with the dialog open would unmount it — it would
          blink shut under the merchant's hands and drop focus. It renders the
          rows it has and comes back with the rest. */}
          <PublishingModal
        open={manageOpen}
        onClose={() => setManageOpen(false)}
        channels={data?.channels ?? []}
        truncated={data?.channelsTruncated === true}
        channelState={channelState}
        setChannelState={setChannelState}
        saving={saving}
        t={{
          title: (t.manageTitle as string) || "Manage publishing",
          done: (t.done as string) || "Done",
          headings: {
            channels: (t.channelsHeading as string) || "Sales channels",
            market: (t.marketsHeading as string) || "Regions",
            companyLocation: (t.b2bHeading as string) || "B2B catalogs",
          },
          // Regions and B2B catalogs answer "who may see it", not "where is
          // it sold" — merchants reliably read them as channels, which is
          // the whole reason they sit apart and carry a line each.
          hints: {
            market:
              (t.marketsHint as string) ||
              "Regions decide who may see the product, not where it is sold. Off means it is hidden in that region.",
            companyLocation:
              (t.b2bHint as string) || "B2B catalogs decide which business customers can see the product.",
          },
          scheduled: (t.scheduled as string) || "Scheduled for {date}",
          noChannels: (t.noChannels as string) || "This shop has no sales channels installed.",
          truncated:
            (t.channelsTruncated as string) ||
            "More channels exist than were loaded. Manage the rest in the Shopify admin.",
        }}
      />
    </BlockStack>
  );
}
