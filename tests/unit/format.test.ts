import { describe, it, expect } from "vitest";
import {
  formatNumber,
  formatDateTime,
  formatDate,
  formatTime,
  compareStrings,
  collatorFor,
} from "~/utils/format";

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

function withTimeZone<T>(tz: string, fn: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

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

  it("switches to the merchant's local rendering once hydrated", () => {
    // Auckland is +12, so this instant falls on the NEXT calendar day locally.
    // That is precisely what the server cannot know — so the pre-hydration
    // value must stay on the 28th while the hydrated one moves to the 29th.
    // Asserting the shift rather than restating the implementation: a helper
    // that simply returned the UTC form in both branches would pass a
    // `toBe(new Date(ISO).toLocaleString())` check and fail this one.
    withTimeZone("Pacific/Auckland", () => {
      // Self-check: if runtime TZ mutation ever stops working, fail loudly
      // here instead of letting the assertions below go vacuous.
      expect(new Date(ISO).getDate()).toBe(29);

      expect(formatDate(ISO, false)).toBe("2026-08-28");
      expect(formatDateTime(ISO, false)).toBe("2026-08-28 16:00 UTC");

      expect(formatDate(ISO, true)).toContain("29");
      expect(formatDateTime(ISO, true)).toContain("29");
      expect(formatTime(ISO, true)).not.toBe(formatTime(ISO, false));
    });
  });

  it("accepts Date and epoch inputs", () => {
    expect(formatDateTime(new Date(ISO), false)).toBe("2026-08-28 16:00 UTC");
    expect(formatDateTime(Date.parse(ISO), false)).toBe("2026-08-28 16:00 UTC");
  });

  it("returns the fallback for missing or unparseable values", () => {
    // Every helper against every branch — a bad value must not depend on
    // whether the client has mounted yet.
    for (const bad of [null, undefined, "", "not-a-date"]) {
      for (const fn of [formatDateTime, formatDate, formatTime]) {
        expect(fn(bad, false)).toBe("");
        expect(fn(bad, true)).toBe("");
        expect(fn(bad, false, "—")).toBe("—");
        expect(fn(bad, true, "—")).toBe("—");
      }
    }
  });

  it("never renders 'Invalid Date'", () => {
    expect(formatDateTime("nonsense", true)).not.toContain("Invalid");
  });
});

describe("compareStrings (collation binding)", () => {
  // The bug this exists for: `localeCompare()` with no locale uses the HOST
  // default, so a Swedish browser and an en-US server order the SAME list
  // differently — and when that list is server-rendered, the mismatch is
  // structural (React production error #418), not a text node.
  it("orders by the locale it is given, not by the host default", () => {
    const words = ["Zebra", "Äpfel", "Apfel"];

    const german = [...words].sort((a, b) => compareStrings(a, b, "de"));
    const swedish = [...words].sort((a, b) => compareStrings(a, b, "sv"));

    // German sorts Ä next to A; Swedish sorts it after Z. If the helper
    // ignored its locale argument these two would be identical.
    expect(german).toEqual(["Apfel", "Äpfel", "Zebra"]);
    expect(swedish).toEqual(["Apfel", "Zebra", "Äpfel"]);
  });

  it("is stable for one locale regardless of the ambient default", () => {
    // What the server and the client each do: same locale in, same order out.
    const words = ["Öl", "Ost", "Zug", "Ähre"];
    const first = [...words].sort((a, b) => compareStrings(a, b, "de"));
    const second = [...words].sort((a, b) => compareStrings(a, b, "de"));
    expect(first).toEqual(second);
  });

  it("falls back to a FIXED locale on a bad tag, never to the host default", () => {
    // "" would make Intl.Collator throw; falling back to the host default
    // would put the divergence straight back.
    expect(() => compareStrings("a", "b", "")).not.toThrow();
    expect(compareStrings("Äpfel", "Zebra", "")).toBe(compareStrings("Äpfel", "Zebra", "en"));
  });

  it("caches collators per locale", () => {
    expect(collatorFor("de")).toBe(collatorFor("de"));
    expect(collatorFor("de")).not.toBe(collatorFor("sv"));
  });
});
