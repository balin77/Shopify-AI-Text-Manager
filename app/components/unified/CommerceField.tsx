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
 *
 * -- One heading row, and this field draws ALL of it -------------------------
 * The lists sit side by side wherever the card is wide enough, so their titles
 * belong on ONE line. The publishing subcard therefore draws no title of its
 * own (`ownsItsSectionTitle` in `UnifiedContentEditor`): a title one row above
 * the grid put "Vertriebskanäle" a line higher than "Regionen", which is the
 * misalignment this arrangement fixes — and printing it in BOTH places is how
 * the word came to stand twice before.
 *
 * So `label` is the section's title, not a field label: it carries the help
 * bubble and the §2.3 alarm, and it is the first column's heading.
 */

import { Badge, Banner, BlockStack, Box, Button, InlineStack, Spinner, Text } from "@shopify/polaris";
import { HelpTooltip } from "../HelpTooltip";
import { ToggleSwitch } from "../ToggleSwitch";
import { useCommerceData } from "../../contexts/CommerceDataContext";
import { groupPublications, type PublicationGroupId } from "../../services/commerce-sync.shared";
import type { CommerceChannelView } from "../../routes/api.product-commerce";

/** Every column title, so the row reads as one line of headings. */
function GroupHeading({ text, helpKey, children }: { text: string; helpKey?: string; children?: React.ReactNode }) {
  return (
    <InlineStack gap="200" blockAlign="center" wrap>
      <Text as="h3" variant="bodyMd" fontWeight="semibold">{text}</Text>
      {helpKey && <HelpTooltip helpKey={helpKey} />}
      {children}
    </InlineStack>
  );
}

export function CommerceField({ label }: { label: string }) {
  const commerce = useCommerceData();
  // No provider ⇒ not a product. Nothing to say.
  if (!commerce) return null;

  const {
    data, loadError, planBlocked, notices, setNotices, load, isPrimaryLocale, t,
    channelState, setChannelState, saving, salesChannelSummary,
  } = commerce;

  /**
   * The alarm and the "no channels installed" line are CLAIMS about the whole
   * shop, and a cut-off window cannot support either: the channel this product
   * is on may be one of the rows that did not arrive. With the window truncated
   * the panel shows the rows it has and says nothing beyond them — the
   * truncation line already tells the merchant why.
   */
  const complete = !!data && !data.channelsTruncated;

  /** The three lists, always in the admin's order. */
  const groups = data ? groupPublications(data.channels) : [];

  /**
   * The alarm counts SALES CHANNELS only — a product that sits in a market
   * catalog but on no channel is invisible exactly as if it sat nowhere, and
   * counting the market row would have hidden that.
   *
   * Comes from the context (`salesChannelSummary`) rather than being counted
   * here: the sidebar's completeness checklist asks the same question one
   * column over, and two counts of "how many channels" would eventually
   * disagree on which row is a channel.
   */
  const publishedChannelCount = salesChannelSummary?.publishedCount ?? 0;

  /**
   * The section's title. It is drawn in every branch below — a subcard that
   * shows only a banner still has to say what it is about, and the subcard
   * itself no longer prints a title.
   */
  const channelsHeading = (
    <GroupHeading text={label} helpKey="commerceChannels">
      {/* §2.3 — the trap this feature exists for. Not a subtle hint: a product
          on no channel is invisible everywhere. Silent when the window was cut
          off: that is a claim about the whole shop, and a partial answer cannot
          carry it. */}
      {isPrimaryLocale && !planBlocked && complete && publishedChannelCount === 0 && (
        <Badge tone="critical">{(t.noChannel as string) || "On no channel — invisible"}</Badge>
      )}
    </GroupHeading>
  );

  if (!isPrimaryLocale) {
    return (
      <BlockStack gap="300">
        {channelsHeading}
        <Banner tone="info">
          <p>{(t.foreignLocale as string) || "Stock and sales channels exist once per product, not per language."}</p>
        </Banner>
      </BlockStack>
    );
  }

  if (planBlocked) {
    return (
      <BlockStack gap="300">
        {channelsHeading}
        <Banner tone="info">
          <p>{(t.planRequired as string) || "Stock and sales channels are part of the Pro plan."}</p>
          {/* The one case where the bulk editor is still the answer: without
              this panel there is nowhere else to price a multi-variant product. */}
          <p>{(t.variantPricesHint as string) || "Prices of several variants are edited in the bulk editor."}</p>
        </Banner>
      </BlockStack>
    );
  }

  /**
   * The other two groups' explanations ride in a help bubble rather than as a
   * paragraph over the switches: regions and B2B catalogs answer "who may see
   * it", not "where is it sold", and merchants reliably read them as channels
   * — but two sentences of prose above a list of toggles is what pushed the
   * list itself off the screen. The bubble keeps the answer one click away for
   * whoever wants it and out of the way of whoever does not.
   */
  const GROUP_HEADING: Record<PublicationGroupId, React.ReactNode> = {
    channels: channelsHeading,
    market: <GroupHeading text={(t.marketsHeading as string) || "Regions"} helpKey="commerceRegions" />,
    companyLocation: <GroupHeading text={(t.b2bHeading as string) || "B2B catalogs"} helpKey="commerceB2b" />,
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
    const switchId = `channel-${channel.publicationId}`;

    return (
      <InlineStack key={channel.publicationId} gap="300" blockAlign="center" wrap={false}>
        <ToggleSwitch
          id={switchId}
          checked={channelState[channel.publicationId] === true}
          disabled={saving}
          // The date rides in the accessible NAME, not in a described-by:
          // `ToggleSwitch` wraps only its own pill, so the line beside it is an
          // unassociated sibling that a screen reader never reaches. The
          // Polaris `Checkbox` this replaced wired its `helpText` up by itself
          // — folding it into the label is what keeps a scheduled channel from
          // being announced as a plain "off", which is the very confusion the
          // line exists to prevent.
          ariaLabel={scheduled ? `${name} — ${scheduled}` : name}
          onChange={(checked) =>
            setChannelState((prev) => ({ ...prev, [channel.publicationId]: checked }))
          }
        />
        <BlockStack gap="050">
          {/* The name stays a click target. It is the widest thing in the row,
              the `Checkbox` label it replaced toggled from it, and a merchant
              who clicks it and sees nothing happen reads the row as broken. */}
          <label htmlFor={switchId} style={{ cursor: saving ? "not-allowed" : "pointer" }}>
            <Text as="span" variant="bodyMd">{name}</Text>
          </label>
          {scheduled && <Text as="p" variant="bodySm" tone="subdued">{scheduled}</Text>}
        </BlockStack>
      </InlineStack>
    );
  };

  return (
    <BlockStack gap="300">
      {/* Before the grid, because it belongs to the whole panel and not to one
          column: a load that failed produced no lists at all. */}
      {!data && (
        <BlockStack gap="300">
          {channelsHeading}
          {loadError ? (
            <Banner tone="warning">
              <BlockStack gap="200">
                <Text as="p">{loadError}</Text>
                <Box><Button onClick={() => load()}>{(t.retry as string) || "Try again"}</Button></Box>
              </BlockStack>
            </Banner>
          ) : (
            <Spinner size="small" accessibilityLabel={(t.loading as string) || "Loading"} />
          )}
        </BlockStack>
      )}

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

          {/* The lists sit SIDE BY SIDE wherever the card is wide enough — the
              same `auto-fit` grid the Details card uses for its short fields.
              Every column opens with its heading, so the titles line up across
              the row; that is why the section's own title is in here as the
              first column's heading rather than on a line above the grid.
              With one list (the ordinary shop) `auto-fit` collapses to a single
              full-width column, so nothing changes there. `start` alignment
              keeps a short list from stretching to the tallest one. */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
              gap: "1rem",
              alignItems: "start",
            }}
          >
            {groups.map((group) => (
              <BlockStack gap="300" key={group.id}>
                {GROUP_HEADING[group.id]}

                {/* Only the SALES CHANNEL group survives empty (groupPublications
                    drops the other two), so this line is always about channels. */}
                {group.rows.length === 0
                  ? complete && (
                      <Text as="p" variant="bodySm" tone="subdued">
                        {(t.noChannels as string) || "This shop has no sales channels installed."}
                      </Text>
                    )
                  : group.rows.map(renderChannel)}
              </BlockStack>
            ))}
          </div>
        </>
      )}
    </BlockStack>
  );
}
