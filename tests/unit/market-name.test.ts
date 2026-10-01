import { describe, it, expect } from "vitest";
import { countryOptions, localizedMarketName } from "~/utils/market-name";

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

describe("countryOptions", () => {
  it("lists every country once — a retired alias code never doubles a name", () => {
    const list = countryOptions("de");
    const names = list.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    const codes = list.map((c) => c.code);
    for (const kept of ["GB", "DE", "RU", "RS", "MM", "FR", "CW"]) expect(codes).toContain(kept);
    for (const retired of ["UK", "DD", "SU", "YU", "CS", "BU", "FX", "AN", "ZR"]) expect(codes).not.toContain(retired);
  });
});
