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
      adminGraphUrl: null,
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
    const link = screen.getByRole("link", { name: /Im Diagramm anzeigen/ });
    expect(link.getAttribute("href")).toBe("https://admin.shopify.com/store/shop/markets/graph?market_id=1");
    expect(link.getAttribute("target")).toBe("_blank");
    // One link: the draft market has no graph URL, and no currency line.
    expect(screen.getAllByRole("link", { name: /Im Diagramm anzeigen/ })).toHaveLength(1);
    expect(screen.getAllByText(/Währung:/)).toHaveLength(1);
  });
});
