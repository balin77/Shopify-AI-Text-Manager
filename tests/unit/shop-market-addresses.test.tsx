/**
 * The market row's two informational parts: the base currency (Shopify's
 * name on the first render, the app language's once hydrated) and the link OUT
 * to Shopify admin's market graph, which opens in a new tab and is never
 * blocked by an open language draft — it changes nothing.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import { createRoutesStub } from "react-router";
import { InfoBoxProvider } from "~/contexts/InfoBoxContext";
import { ShopMarketAddresses, type MarketAddressesView } from "~/components/ShopMarketAddresses";
import { translations } from "~/i18n";

afterEach(cleanup);

const addresses: MarketAddressesView = {
  sharedUrl: "https://shop.example/",
  takenSuffixes: [],
  orphans: [],
  markets: [
    {
      marketId: "gid://shopify/Market/1",
      name: "Schweiz",
      status: "ACTIVE",
      primary: true,
      own: null,
      currency: { code: "CHF", name: "Swiss Franc" },
      adminGraphUrl: "https://admin.shopify.com/store/shop/markets/graph?market_id=1",
    },
    {
      marketId: "gid://shopify/Market/2",
      name: "USA",
      status: "DRAFT",
      primary: false,
      own: null,
      currency: null,
      adminGraphUrl: "https://admin.shopify.com/store/shop/markets/graph?market_id=2",
    },
  ],
};

function renderIt(blocked: boolean) {
  const s = (translations as any).de.settings.shopLanguages;
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <AppProvider i18n={en}>
          <InfoBoxProvider>
            <ShopMarketAddresses addresses={addresses} locales={[{ locale: "de", primary: true }]} appLocale="de" blocked={blocked} s={s} t={{}} />
          </InfoBoxProvider>
        </AppProvider>
      ),
    },
  ]);
  render(<Stub initialEntries={["/"]} />);
}

describe("ShopMarketAddresses — currency and graph link", () => {
  it("shows the currency and links to the market graph in a new tab, even with a draft open", () => {
    renderIt(true);
    expect(screen.getByText(/Währung: CHF · Schweizer Franken/)).toBeTruthy();
    const links = screen.getAllByRole("link", { name: "Im Diagramm anzeigen" });
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "https://admin.shopify.com/store/shop/markets/graph?market_id=1",
      "https://admin.shopify.com/store/shop/markets/graph?market_id=2",
    ]);
    expect(links.every((l) => l.getAttribute("target") === "_blank")).toBe(true);
    // An icon button: its words are the accessible name and the tooltip, not visible text.
    expect(links[1].textContent?.trim()).toBe("");
    // Last in the row — after "Löschen".
    const del = screen.getByRole("button", { name: "Markt löschen" });
    expect(del.compareDocumentPosition(links[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // No currency line where none was read.
    expect(screen.getAllByText(/Währung:/)).toHaveLength(1);
  });
});
