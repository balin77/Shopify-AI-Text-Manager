import { describe, it, expect } from "vitest";
import {
  MARKETING_DEFAULT_LOCALE,
  documentLanguageForPath,
  isMarketingLocale,
  isMarketingPath,
  localizedPath,
  preferredLocaleFromHeader,
  classifyMarketingLocaleParam,
  stripMarketingLocalePrefix,
} from "../../app/services/marketing-locale.shared";

describe("classifyMarketingLocaleParam", () => {
  it("treats a missing segment as the default locale", () => {
    expect(classifyMarketingLocaleParam(undefined)).toEqual({
      kind: "locale",
      locale: MARKETING_DEFAULT_LOCALE,
    });
  });

  it("accepts a prefixed locale", () => {
    expect(classifyMarketingLocaleParam("de")).toEqual({ kind: "locale", locale: "de" });
    expect(classifyMarketingLocaleParam("es")).toEqual({ kind: "locale", locale: "es" });
  });

  it("sends the DEFAULT locale spelled out to a redirect, not to a 200", () => {
    // `/en/features` is the same page as `/features`. Serving it would be a
    // duplicate — and `isMarketingPath` reads the prefix rule, so it answers
    // false for `/en/...`, which would put App Bridge on a public page.
    expect(classifyMarketingLocaleParam(MARKETING_DEFAULT_LOCALE)).toEqual({ kind: "default" });
    expect(isMarketingPath(`/${MARKETING_DEFAULT_LOCALE}/features`)).toBe(false);
  });

  it("REFUSES an unknown segment", () => {
    // The `($lang)` route segment matches any single path segment, so `/foobar`
    // reaches the index route. Answering "unknown" is what turns that into a
    // 404 instead of the landing page served at an unbounded set of URLs.
    expect(classifyMarketingLocaleParam("foobar")).toEqual({ kind: "unknown" });
    expect(classifyMarketingLocaleParam("EN")).toEqual({ kind: "unknown" });
    expect(classifyMarketingLocaleParam("")).toEqual({ kind: "unknown" });
  });
});

describe("localizedPath", () => {
  it("leaves the default locale unprefixed", () => {
    expect(localizedPath("en", "/")).toBe("/");
    expect(localizedPath("en", "/features")).toBe("/features");
  });

  it("prefixes every other locale", () => {
    expect(localizedPath("de", "/")).toBe("/de");
    expect(localizedPath("de", "/features")).toBe("/de/features");
    expect(localizedPath("es", "/videos")).toBe("/es/videos");
  });

  it("round-trips with the stripper", () => {
    for (const locale of ["en", "de", "es"] as const) {
      for (const path of ["/", "/features", "/videos"]) {
        const built = localizedPath(locale, path);
        const back = stripMarketingLocalePrefix(built);
        expect(back.locale).toBe(locale);
        expect(back.rest).toBe(path);
      }
    }
  });
});

describe("stripMarketingLocalePrefix", () => {
  it("does not strip a path segment that merely starts with two letters", () => {
    expect(stripMarketingLocalePrefix("/design").rest).toBe("/design");
    expect(stripMarketingLocalePrefix("/de-luxe").rest).toBe("/de-luxe");
  });

  it("ignores the default locale as a prefix", () => {
    // `/en/features` is not a URL this site serves; the default locale is bare.
    expect(stripMarketingLocalePrefix("/en/features").rest).toBe("/en/features");
  });
});

describe("isMarketingPath", () => {
  it("recognises every public page in every locale", () => {
    for (const path of ["/", "/features", "/videos", "/roadmap", "/privacy", "/terms"]) {
      expect(isMarketingPath(path)).toBe(true);
    }
    expect(isMarketingPath("/de")).toBe(true);
    expect(isMarketingPath("/es/videos")).toBe(true);
    expect(isMarketingPath("/de/features/")).toBe(true);
  });

  it("does NOT claim the embedded app or its endpoints", () => {
    // This predicate decides whether App Bridge is rendered. A false positive
    // here would take App Bridge off an embedded page and break the admin.
    for (const path of ["/app", "/app/products", "/admin", "/api/ai", "/webhooks/products", "/auth/login", "/health"]) {
      expect(isMarketingPath(path)).toBe(false);
    }
  });
});

describe("documentLanguageForPath", () => {
  it("reads the locale off the URL", () => {
    expect(documentLanguageForPath("/")).toBe("en");
    expect(documentLanguageForPath("/features")).toBe("en");
    expect(documentLanguageForPath("/de/videos")).toBe("de");
    expect(documentLanguageForPath("/es")).toBe("es");
  });
});

describe("preferredLocaleFromHeader", () => {
  it("picks the highest-quality known language", () => {
    expect(preferredLocaleFromHeader("fr-CH,fr;q=0.9,de;q=0.8,en;q=0.7")).toBe("de");
    expect(preferredLocaleFromHeader("de-CH")).toBe("de");
  });

  it("answers null when nothing matches", () => {
    expect(preferredLocaleFromHeader("fr,it;q=0.8")).toBeNull();
    expect(preferredLocaleFromHeader(null)).toBeNull();
  });
});

describe("isMarketingLocale", () => {
  it("narrows only the three shipped locales", () => {
    expect(isMarketingLocale("en")).toBe(true);
    expect(isMarketingLocale("fr")).toBe(false);
    expect(isMarketingLocale(undefined)).toBe(false);
  });
});

describe("requireMarketingLocale", () => {
  it("redirects the default locale's spelled-out URL to the bare one, keeping the query", async () => {
    const { requireMarketingLocale } = await import("../../app/utils/marketing-route.server");
    let thrown: unknown;
    try {
      requireMarketingLocale(MARKETING_DEFAULT_LOCALE, "/features", "?ref=x");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Response);
    const response = thrown as Response;
    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe("/features?ref=x");
  });

  it("404s an unknown segment", async () => {
    const { requireMarketingLocale } = await import("../../app/utils/marketing-route.server");
    let thrown: unknown;
    try {
      requireMarketingLocale("foobar", "/");
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Response).status).toBe(404);
  });

  it("hands back a prefixed locale unchanged", async () => {
    const { requireMarketingLocale } = await import("../../app/utils/marketing-route.server");
    expect(requireMarketingLocale("de", "/videos")).toBe("de");
    expect(requireMarketingLocale(undefined, "/videos")).toBe(MARKETING_DEFAULT_LOCALE);
  });
});
