import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `?locale=` belongs to Shopify.
 *
 * App Bridge appends the merchant's ADMIN UI language under that name to every
 * embedded request, `resolveMerchantLocale` ([app/utils/locale.server.ts]) renders
 * the app from it, and `useAppNavigation` copies every param onto every in-app
 * navigation. So a page of this app that READS `locale` as its own content
 * language opens in whatever language the admin is displayed in, and one that
 * WRITES it there re-renders the whole admin UI in the language the merchant
 * picked for an audit or a grid — and it sticks for the session.
 *
 * Both halves shipped and were fixed by giving each surface its own name
 * (`contentLocale`, `auditLocale`, `gridLocale`). This test is the rail: any
 * page route that reaches for the shared name again fails here rather than in a
 * merchant's admin, where the symptom ("my app is suddenly English") points
 * nowhere near the cause.
 *
 * Scope: PAGE routes only — a file with a default export renders inside the app
 * shell, so its URL is the browser's URL. A resource route (loader/action only,
 * reached by `fetcher.load`) never becomes `window.location`, so its own params
 * cannot collide with anything.
 */

const ROUTES_DIR = join(process.cwd(), "app", "routes");

// Reads the param under any quoting style, incl. `new URL(...).searchParams`.
const READS_LOCALE = /searchParams\s*\.\s*get\(\s*["'`]locale["'`]\s*\)/;
// ANY `.set("locale", …)`, whatever the receiver is called: the writer that
// shipped this bug was `next.set("locale", locale)` on a local
// `URLSearchParams`, so a rule anchored on the word "searchParams" would have
// watched it go by. No page route needs that call today — one that legitimately
// does (a FormData field, say) is rare enough to earn an explicit exemption
// here rather than a hole in the rail.
const WRITES_LOCALE = /\.\s*set\(\s*["'`]locale["'`]\s*,/;
// `new URLSearchParams({ locale })` / `{ locale: value }` inside a navigation.
const NAVIGATES_WITH_LOCALE = /handleNavigate\([^)]*\blocale\b\s*[:,]/;

function pageRoutes(): Array<{ file: string; source: string }> {
  return readdirSync(ROUTES_DIR)
    .filter((f) => f.startsWith("app.") && f.endsWith(".tsx"))
    .map((file) => ({ file, source: readFileSync(join(ROUTES_DIR, file), "utf8") }))
    .filter(({ source }) => /export default/.test(source));
}

describe("locale param ownership", () => {
  it("finds the page routes it is supposed to guard", () => {
    // A rename or a moved directory must not turn this rail into a no-op that
    // passes because it inspected nothing.
    const files = pageRoutes().map((r) => r.file);
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain("app.bulk.tsx");
    expect(files).toContain("app.seo._index.tsx");
    expect(files).toContain("app.products.tsx");
  });

  it("no page route reads ?locale= as its own state", () => {
    const offenders = pageRoutes()
      .filter(({ source }) => READS_LOCALE.test(source))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("no page route writes ?locale= into the browser URL", () => {
    const offenders = pageRoutes()
      .filter(({ source }) => WRITES_LOCALE.test(source) || NAVIGATES_WITH_LOCALE.test(source))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});
