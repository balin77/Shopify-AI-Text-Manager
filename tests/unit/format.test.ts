import { describe, it, expect } from "vitest";
import { formatNumber, formatDateTime, formatDate, formatTime } from "~/utils/format";

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

describe("formatNumber options", () => {
  it("passes Intl options through", () => {
    expect(formatNumber(1.2345, "en", { maximumFractionDigits: 1 })).toBe("1.2");
    expect(formatNumber(1234.5, "de", { maximumFractionDigits: 0 })).toBe("1.235");
  });

  it("still falls back to a plain string on a bad tag, options and all", () => {
    expect(formatNumber(1000, "", { maximumFractionDigits: 0 })).toBe("1000");
  });
});

describe("timestamp helpers (hydration safety)", () => {
  const ISO = "2026-08-28T16:00:21.070Z";

  it("renders a deterministic UTC stamp before hydration", () => {
    // This is THE invariant: the value must not depend on the ambient time
    // zone, or the server's HTML and the first client render disagree and
    // React 18 reports a hydration mismatch (production error #418).
    expect(formatDateTime(ISO, false)).toBe("2026-08-28 16:00 UTC");
    expect(formatDate(ISO, false)).toBe("2026-08-28");
    expect(formatTime(ISO, false)).toBe("16:00 UTC");
  });

  it("uses the same UTC stamp whatever the process time zone is", () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = "Europe/Berlin";
      const berlin = formatDateTime(ISO, false);
      process.env.TZ = "Pacific/Auckland";
      const auckland = formatDateTime(ISO, false);
      expect(berlin).toBe(auckland);
      expect(berlin).toBe("2026-08-28 16:00 UTC");
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it("pads single-digit date parts", () => {
    expect(formatDateTime("2026-01-02T03:04:05.000Z", false)).toBe("2026-01-02 03:04 UTC");
  });

  it("switches to the local rendering once hydrated", () => {
    // Not asserting the exact string (it is locale/zone dependent by design),
    // only that it stopped being the deterministic UTC form.
    expect(formatDateTime(ISO, true)).not.toBe(formatDateTime(ISO, false));
    expect(formatDateTime(ISO, true)).toBe(new Date(ISO).toLocaleString());
    expect(formatDate(ISO, true)).toBe(new Date(ISO).toLocaleDateString());
    expect(formatTime(ISO, true)).toBe(new Date(ISO).toLocaleTimeString());
  });

  it("accepts Date and epoch inputs", () => {
    expect(formatDateTime(new Date(ISO), false)).toBe("2026-08-28 16:00 UTC");
    expect(formatDateTime(Date.parse(ISO), false)).toBe("2026-08-28 16:00 UTC");
  });

  it("returns the fallback for missing or unparseable values", () => {
    for (const bad of [null, undefined, "", "not-a-date"]) {
      expect(formatDateTime(bad, false)).toBe("");
      expect(formatDateTime(bad, true)).toBe("");
      expect(formatDate(bad, false)).toBe("");
      expect(formatTime(bad, true)).toBe("");
    }
    expect(formatDateTime("not-a-date", true, "—")).toBe("—");
  });

  it("never renders 'Invalid Date'", () => {
    expect(formatDateTime("nonsense", true)).not.toContain("Invalid");
  });
});
