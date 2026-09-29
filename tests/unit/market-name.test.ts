import { describe, it, expect } from "vitest";
import { localizedMarketName } from "~/utils/market-name";

describe("localizedMarketName", () => {
  it("localizes Shopify's standard region names into the app language", () => {
    expect(localizedMarketName("Switzerland", "de")).toBe("Schweiz");
    expect(localizedMarketName("European Union", "de")).toBe("Europäische Union");
    expect(localizedMarketName("Schweiz", "en")).toBe("Switzerland");
    expect(localizedMarketName("Spanien", "es")).toBe("España");
  });

  it("leaves a name the merchant chose alone", () => {
    expect(localizedMarketName("DACH-Raum", "de")).toBe("DACH-Raum");
    expect(localizedMarketName("Wholesale", "de")).toBe("Wholesale");
  });
});
