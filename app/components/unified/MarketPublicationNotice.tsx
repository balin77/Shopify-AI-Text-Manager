/**
 * "This product is not in that market's catalog."
 *
 * The market selector lets a merchant translate the same locale differently
 * per market. What it cannot show is whether the product is IN that market —
 * a market catalog decides who may see it, and a product missing from one is
 * unreachable there. Translating into such a market is work nobody can ever
 * read, and nothing on the screen said so.
 *
 * ── Deliberately one-directional ────────────────────────────────────────────
 * It warns and is otherwise SILENT. No green "published in this market" note:
 * the normal case is by far the common one, and a confirmation on every market
 * switch would be noise that trains merchants to ignore the line that matters.
 *
 * ── Silent whenever the answer is not certain ───────────────────────────────
 * A failed read, a truncated window, a market no catalog scopes, and a market
 * whose launch is merely SCHEDULED all end in the same place: render nothing.
 * A market that no catalog scopes is genuinely unrestricted, a scheduled one
 * has already had the thing done that this banner would ask for, and the rest
 * is "we do not know" — which must never be shown as "not published". A missed
 * warning, never a wrong one.
 */

import { useEffect, useRef, useState } from "react";
import { Banner, Text } from "@shopify/polaris";
import type { ProductMarketPublicationsView } from "../../routes/api.product-market-publications";

interface MarketPublicationNoticeProps {
  /** "" ⇒ not a product (or nothing selected). Publications are a product thing. */
  productId: string;
  /** "" ⇒ the global scope is selected; there is no market to be missing from. */
  selectedMarketId: string;
  /** Shown in the warning, so the merchant reads a name and not a GID. */
  marketName: string;
  /** `{market}` is replaced with `marketName`. */
  notPublishedText: string;
}

export function MarketPublicationNotice({
  productId,
  selectedMarketId,
  marketName,
  notPublishedText,
}: MarketPublicationNoticeProps) {
  /**
   * The answer, TAGGED with the product it describes.
   *
   * Clearing it in the effect is not enough: an effect runs after paint, so
   * the first render after a product switch would evaluate the previous
   * product's markets against the new product — and paint a "not in this
   * market" warning for one frame on a product that is in it. The tag is
   * compared at render, where the mismatch is visible before anything is
   * drawn.
   */
  const [view, setView] = useState<{ productId: string; data: ProductMarketPublicationsView } | null>(null);
  /**
   * Bumped per load, so an answer for the product the merchant just navigated
   * away from lands nowhere. The same guard the commerce panel keeps, for the
   * same reason: the id in flight and the id on screen are two different things.
   */
  const loadToken = useRef(0);

  /**
   * Keyed on the PRODUCT and on WHETHER a market is selected — never on WHICH
   * one. One read answers every market, so switching between two markets must
   * re-render but not re-fetch; `selectedMarketId` is read at render time
   * below instead.
   */
  const marketSelected = !!selectedMarketId;
  useEffect(() => {
    setView(null);
    if (!productId || !marketSelected) return;
    const token = ++loadToken.current;
    fetch(`/api/product-market-publications?productId=${encodeURIComponent(productId)}`)
      .then((r) => r.json())
      .then((body) => {
        if (token !== loadToken.current) return;
        if (!body?.success) return;
        setView({
          productId,
          data: {
            scopedMarketIds: body.scopedMarketIds ?? [],
            publishedMarketIds: body.publishedMarketIds ?? [],
            scheduledMarketIds: body.scheduledMarketIds ?? [],
            truncated: body.truncated === true,
          },
        });
      })
      .catch(() => undefined);
    return () => { loadToken.current += 1; };
  }, [productId, marketSelected]);

  if (!selectedMarketId || !view || view.productId !== productId) return null;
  const { scopedMarketIds, publishedMarketIds, scheduledMarketIds, truncated } = view.data;
  if (truncated) return null;
  // Not scoped by any catalog ⇒ unrestricted, nothing to say.
  if (!scopedMarketIds.includes(selectedMarketId)) return null;
  if (publishedMarketIds.includes(selectedMarketId)) return null;
  // A launch with a future date is not a mistake to report — the merchant has
  // already done the thing this banner would ask them to do.
  if (scheduledMarketIds.includes(selectedMarketId)) return null;

  // The spacing belongs to the banner, not to the slot: the caller cannot know
  // whether anything will render, and an empty wrapper with a margin opens a
  // gap under the language bar on every market that is perfectly fine.
  return (
    <div style={{ marginTop: "1rem" }}>
      <Banner tone="warning">
        <Text as="p">{notPublishedText.replace("{market}", marketName)}</Text>
      </Banner>
    </div>
  );
}
