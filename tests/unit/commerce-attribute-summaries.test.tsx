/**
 * The two answers the commerce panel lends to the sidebar's attribute
 * checklist: how many SALES CHANNELS a product is on, and what it costs.
 *
 * Both used to render as a grey "?" forever, because the checklist is built
 * from the editor's cached item and neither number lives there. They are
 * derived in `CommerceDataContext` rather than in either reader, so the
 * channels field's "on no channel — invisible" badge and the checklist's
 * channel row can never disagree about which publication counts as a channel.
 *
 * What this file pins is precisely the part a second copy would get wrong:
 * markets and B2B catalogs are NOT channels, a pending untick moves the answer
 * before the save, and "nothing loaded" stays `null` instead of collapsing to
 * the `0` that raises the alarm.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { CommerceDataProvider, useCommerceData } from "~/contexts/CommerceDataContext";

const PRODUCT = "gid://shopify/Product/1";

const channel = (id: string, catalogType: string, isPublished: boolean) => ({
  publicationId: `gid://shopify/Publication/${id}`,
  name: id,
  catalogType,
  isPublished,
  publishDate: null,
});

const variant = (id: string, price: string | null) => ({
  id: `gid://shopify/ProductVariant/${id}`,
  gid: `gid://shopify/ProductVariant/${id}`,
  title: id,
  sku: null,
  barcode: null,
  inventoryPolicy: "DENY",
  price,
  compareAtPrice: null,
  unitQuantityValue: null,
  unitQuantityUnit: null,
  unitReferenceValue: null,
  unitReferenceUnit: null,
  showUnitPrice: null,
  inventoryItemId: null,
  inventoryTracked: null,
  cost: null,
  taxable: null,
  requiresShipping: null,
  weight: null,
  weightUnit: null,
  harmonizedSystemCode: null,
  countryCodeOfOrigin: null,
  levels: [],
  levelsTruncated: false,
  imageUrl: null,
  imageAlt: null,
  selectedOptions: [],
});

/** Prints the two summaries so the assertions read like the sidebar does. */
function Probe() {
  const commerce = useCommerceData();
  const channels = commerce?.salesChannelSummary;
  const price = commerce?.priceSummary;
  return (
    <>
      <div data-testid="channels">{channels ? `${channels.publishedCount}/${channels.truncated}` : "null"}</div>
      <div data-testid="price">{price ? price.display || "(none)" : "null"}</div>
    </>
  );
}

function ui(isPrimaryLocale = true) {
  return (
    <CommerceDataProvider productId={PRODUCT} isPrimaryLocale={isPrimaryLocale} t={{}}>
      <Probe />
    </CommerceDataProvider>
  );
}

function respondWith(body: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, ...body }) })),
  );
}

beforeEach(() => {
  respondWith({
    variants: [],
    variantsTruncated: false,
    channels: [],
    channelsTruncated: false,
    catalogsKnown: true,
    shopLocations: [],
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("salesChannelSummary", () => {
  it("counts sales channels and ignores markets and B2B catalogs", async () => {
    // A product in a market catalog but on no channel is invisible exactly as
    // if it sat nowhere — counting the market row would hide that.
    respondWith({
      variants: [],
      variantsTruncated: false,
      channels: [
        channel("online", "app", true),
        channel("pos", "app", false),
        channel("de", "market", true),
        channel("acme", "companyLocation", true),
      ],
      channelsTruncated: false,
      catalogsKnown: true,
      shopLocations: [],
    });
    render(ui());
    await waitFor(() => expect(screen.getByTestId("channels").textContent).toBe("1/false"));
  });

  it("counts an UNKNOWN catalog as a channel", async () => {
    // The conservative direction: the badge is an alarm, and raising it for a
    // product that is in fact on the online store is worse than staying quiet.
    respondWith({
      variants: [],
      variantsTruncated: false,
      channels: [channel("mystery", "", true)],
      channelsTruncated: false,
      catalogsKnown: true,
      shopLocations: [],
    });
    render(ui());
    await waitFor(() => expect(screen.getByTestId("channels").textContent).toBe("1/false"));
  });

  it("carries the truncation flag, so a zero can be refused downstream", async () => {
    respondWith({
      variants: [],
      variantsTruncated: false,
      channels: [],
      channelsTruncated: true,
      catalogsKnown: true,
      shopLocations: [],
    });
    render(ui());
    await waitFor(() => expect(screen.getByTestId("channels").textContent).toBe("0/true"));
  });

  it("stays null in a foreign locale, where the panel never asks", async () => {
    // `0` is the "invisible everywhere" alarm. Reporting it for a panel that
    // did not look would raise that alarm about nothing.
    render(ui(false));
    await waitFor(() => expect(screen.getByTestId("channels").textContent).toBe("null"));
  });
});

describe("priceSummary", () => {
  it("shows one variant's price as itself", async () => {
    respondWith({
      variants: [variant("1", "19.99")],
      variantsTruncated: false,
      channels: [],
      channelsTruncated: false,
      catalogsKnown: true,
      shopLocations: [],
    });
    render(ui());
    await waitFor(() => expect(screen.getByTestId("price").textContent).toBe("19.99"));
  });

  it("spans several variants as a range", async () => {
    respondWith({
      variants: [variant("1", "19.99"), variant("2", "5.00"), variant("3", "19.99")],
      variantsTruncated: false,
      channels: [],
      channelsTruncated: false,
      catalogsKnown: true,
      shopLocations: [],
    });
    render(ui());
    await waitFor(() => expect(screen.getByTestId("price").textContent).toBe("5.00–19.99"));
  });

  it("reports an empty display when no variant carries a price", async () => {
    // A LOADED panel that found nothing is a real finding; the checklist paints
    // it red. That is what separates it from the `null` above.
    respondWith({
      variants: [variant("1", null)],
      variantsTruncated: false,
      channels: [],
      channelsTruncated: false,
      catalogsKnown: true,
      shopLocations: [],
    });
    render(ui());
    await waitFor(() => expect(screen.getByTestId("price").textContent).toBe("(none)"));
  });
});
