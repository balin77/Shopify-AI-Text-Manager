import { describe, it, expect, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

vi.mock("~/contexts/InfoBoxContext", () => ({ useInfoBox: () => ({ showInfoBox: () => {} }) }));

import { useLocalizedMedia } from "~/components/localized-images/useLocalizedMedia";

const MEDIA = "gid://shopify/MediaImage/1";

describe("a picked replacement (draft) is shown on the tile", () => {
  it("tileOf answers the draft's picture at once, marked as unsaved, and nothing in the primary language", async () => {
    (globalThis as any).fetch = vi.fn(async () => ({
      status: 200,
      json: async () => ({ ok: true, entries: [], media: [{ id: MEDIA, kind: "image", url: "https://cdn.shopify.com/a.jpg", alt: null, key: "a.jpg", poster: "", stamp: "" }] }),
    }));
    const shopLocales = [{ locale: "de", primary: true }, { locale: "fr" }] as any;
    const { result, rerender } = renderHook(
      (p: { lang: string }) => useLocalizedMedia({ productId: "p1", shopLocales, markets: [], currentLanguage: p.lang, selectedMarketId: "", enabled: true }),
      { initialProps: { lang: "fr" } },
    );
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.tileOf(MEDIA)).toBeNull();

    act(() => {
      result.current.draftFile(MEDIA, "image", "gid://shopify/MediaImage/9", "https://cdn.shopify.com/n.jpg", "n.jpg", {
        locale: result.current.rawLocale,
        marketId: result.current.marketId,
        productId: result.current.productId,
      });
    });
    const tile = result.current.tileOf(MEDIA);
    expect(tile?.src).toBe("https://cdn.shopify.com/n.jpg");
    expect(tile?.draft).toBe(true);

    rerender({ lang: "de" });
    expect(result.current.tileOf(MEDIA)).toBeNull();
  });
});
