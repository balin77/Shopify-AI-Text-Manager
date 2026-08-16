import { describe, it, expect, vi } from "vitest";

// The Search Console route pulls in Shopify auth + Prisma + logger at module
// load. `ownEntry` is pure and touches none of them, so the server-only deps
// are stubbed just enough for the module to import cleanly (same pattern as
// seo-item-picker.test.ts).
vi.mock("../../app/shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
vi.mock("../../app/db.server", () => ({ db: {} }));
vi.mock("../../app/utils/logger.server", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { ownEntry } from "../../app/routes/app.seo.search-console";

/**
 * Search queries are arbitrary merchant-facing text and several real words
 * collide with Object.prototype members. Before this guard, a shop whose GSC
 * data contained the query "constructor" (Spanish for builder) crashed the
 * whole Search Console page: the map lookup returned the inherited function,
 * `?? []` never fired, and spreading it threw.
 */
describe("ownEntry — query-keyed map lookups", () => {
  it("returns own properties unchanged", () => {
    expect(ownEntry({ "blue shoes": ["", "fr"] }, "blue shoes")).toEqual(["", "fr"]);
  });

  it("returns undefined for a missing key", () => {
    expect(ownEntry({ a: 1 }, "b")).toBeUndefined();
  });

  it("does NOT resolve inherited Object.prototype members", () => {
    const map: Record<string, string[]> = {};
    for (const key of ["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"]) {
      expect(ownEntry(map, key)).toBeUndefined();
      // The unguarded form is exactly what used to blow up downstream.
      expect(() => [...(ownEntry(map, key) ?? [])]).not.toThrow();
    }
  });

  it("still returns an OWN property that shadows a prototype member", () => {
    const map: Record<string, string[]> = { constructor: ["fr"] };
    expect(ownEntry(map, "constructor")).toEqual(["fr"]);
  });
});
