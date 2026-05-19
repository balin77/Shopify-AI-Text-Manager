import { describe, it, expect } from "vitest";
import { formatNumber } from "~/utils/format";

describe("formatNumber (R4-UX6)", () => {
  it("groups with comma for English", () => {
    expect(formatNumber(1000, "en")).toBe("1,000");
    expect(formatNumber(1234567, "en")).toBe("1,234,567");
  });

  it("groups with dot for German", () => {
    expect(formatNumber(1000, "de")).toBe("1.000");
    expect(formatNumber(1234567, "de")).toBe("1.234.567");
  });

  it("groups with dot for Spanish", () => {
    // es-ES uses '.' as the thousands separator for >= 10000; for exactly
    // 1000 Intl renders no separator ("1000"), which is the correct
    // locale behaviour — assert the >=10000 case to prove locale binding.
    expect(formatNumber(1234567, "es")).toBe("1.234.567");
  });

  it("does not throw on an unexpected locale tag", () => {
    expect(formatNumber(1000, "")).toBe(String(1000));
  });
});
