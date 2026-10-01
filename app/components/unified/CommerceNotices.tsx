/**
 * What a commerce save had to say, under the card that said it.
 *
 * ONE component for both halves of the panel rather than a banner written out
 * twice: the two cards are far apart on the page (the stock table sits under
 * the product's options, the channel list in the Details aside), and a merchant
 * only ever reads the one they were working in. The defect this exists for was
 * exactly that distance — every notice was rendered in the channel half, so a
 * refused stock write left the save bar up with its explanation in a card about
 * something else. From the stock table it looked like the app had quietly done
 * nothing.
 *
 * Dismissing drops this surface's lines and leaves the other half's alone: they
 * are separate answers to separate writes, and clearing a warning nobody has
 * read is the same loss of information one level down.
 */

import { Banner, BlockStack, Text } from "@shopify/polaris";
import type { CommerceNotice, CommerceNoticeSurface } from "../../contexts/CommerceDataContext";

export function CommerceNotices({
  surface,
  notices,
  setNotices,
}: {
  surface: CommerceNoticeSurface;
  notices: CommerceNotice[];
  setNotices: (notices: CommerceNotice[]) => void;
}) {
  const mine = notices.filter((notice) => notice.surface === surface);
  if (mine.length === 0) return null;

  const dismiss = () => setNotices(notices.filter((notice) => notice.surface !== surface));

  // Two banners, never one: a warning ("the quantity was not written") and a
  // confirmation ("saved") are opposite answers, and a single tone for both
  // makes one of them a lie. The warning leads — it is the half that still
  // needs the merchant.
  const warnings = mine.filter((notice) => notice.tone === "warning");
  const confirmations = mine.filter((notice) => notice.tone === "success");

  return (
    <BlockStack gap="200">
      {warnings.length > 0 && (
        <Banner tone="warning" onDismiss={dismiss}>
          <BlockStack gap="100">
            {warnings.map((notice, index) => (
              <Text as="p" key={index}>{notice.text}</Text>
            ))}
          </BlockStack>
        </Banner>
      )}
      {confirmations.length > 0 && (
        <Banner tone="success" onDismiss={dismiss}>
          <BlockStack gap="100">
            {confirmations.map((notice, index) => (
              <Text as="p" key={index}>{notice.text}</Text>
            ))}
          </BlockStack>
        </Banner>
      )}
    </BlockStack>
  );
}
