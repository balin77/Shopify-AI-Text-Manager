/**
 * Unit Tests for app/services/theme-selection.server.ts
 *
 * Covers the resolution logic that keeps the read + write paths pointed at ONE
 * theme: stored selection wins when still present, otherwise MAIN, otherwise the
 * first theme. GET_THEMES + Prisma are mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks ---------------------------------------------------------------
const findUnique = vi.fn();
const upsert = vi.fn();

vi.mock("~/db.server", () => ({
  db: { aISettings: { findUnique: (...a: unknown[]) => findUnique(...a), upsert: (...a: unknown[]) => upsert(...a) } },
}));
vi.mock("~/utils/logger.server", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { resolveSelectedThemeId, pickMainThemeId, setSelectedThemeId, clearThemesCache } from "~/services/theme-selection.server";

const GID = (n: number) => `gid://shopify/OnlineStoreTheme/${n}`;

function adminReturning(themes: Array<{ id: string; name: string; role: string }>) {
  return {
    graphql: vi.fn().mockResolvedValue({
      json: async () => ({ data: { themes: { edges: themes.map((node) => ({ node })) } } }),
    }),
  };
}

const THEMES = [
  { id: GID(1), name: "Dawn", role: "MAIN" },
  { id: GID(2), name: "Horizon", role: "UNPUBLISHED" },
];

beforeEach(() => {
  findUnique.mockReset();
  upsert.mockReset();
  // resolveSelectedThemeId now memoises the theme list per shop; clear it so
  // each case sees its own adminReturning(...) instead of a prior test's cache.
  clearThemesCache("shop.myshopify.com");
});

describe("pickMainThemeId", () => {
  it("returns the MAIN theme", () => {
    expect(pickMainThemeId(THEMES)).toBe(GID(1));
  });
  it("falls back to the first theme when none is MAIN", () => {
    expect(pickMainThemeId([{ id: GID(9), name: "X", role: "DEVELOPMENT" }])).toBe(GID(9));
  });
  it("returns null for an empty list", () => {
    expect(pickMainThemeId([])).toBeNull();
  });
});

describe("resolveSelectedThemeId", () => {
  it("returns the stored selection when it still exists", async () => {
    findUnique.mockResolvedValue({ selectedThemeId: GID(2) });
    const admin = adminReturning(THEMES);
    expect(await resolveSelectedThemeId("shop.myshopify.com", admin)).toBe(GID(2));
  });

  it("falls back to MAIN when nothing is stored", async () => {
    findUnique.mockResolvedValue({ selectedThemeId: null });
    const admin = adminReturning(THEMES);
    expect(await resolveSelectedThemeId("shop.myshopify.com", admin)).toBe(GID(1));
  });

  it("falls back to MAIN when the stored theme no longer exists", async () => {
    findUnique.mockResolvedValue({ selectedThemeId: GID(999) });
    const admin = adminReturning(THEMES);
    expect(await resolveSelectedThemeId("shop.myshopify.com", admin)).toBe(GID(1));
  });

  it("returns null when the shop has no themes", async () => {
    findUnique.mockResolvedValue({ selectedThemeId: GID(2) });
    const admin = adminReturning([]);
    expect(await resolveSelectedThemeId("shop.myshopify.com", admin)).toBeNull();
  });

  it("reuses a pre-fetched theme list (no extra GET_THEMES)", async () => {
    findUnique.mockResolvedValue({ selectedThemeId: GID(2) });
    const admin = adminReturning(THEMES);
    const res = await resolveSelectedThemeId("shop.myshopify.com", admin, THEMES);
    expect(res).toBe(GID(2));
    expect(admin.graphql).not.toHaveBeenCalled();
  });
});

describe("setSelectedThemeId", () => {
  it("rejects a theme id that does not exist", async () => {
    const admin = adminReturning(THEMES);
    const res = await setSelectedThemeId("shop.myshopify.com", admin, GID(999));
    expect(res.ok).toBe(false);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("stores a valid theme id", async () => {
    const admin = adminReturning(THEMES);
    upsert.mockResolvedValue({});
    const res = await setSelectedThemeId("shop.myshopify.com", admin, GID(2));
    expect(res).toEqual({ ok: true, selectedThemeId: GID(2) });
    expect(upsert).toHaveBeenCalledOnce();
  });

  it("clears the selection when passed null (no theme lookup needed)", async () => {
    const admin = adminReturning(THEMES);
    upsert.mockResolvedValue({});
    const res = await setSelectedThemeId("shop.myshopify.com", admin, null);
    expect(res).toEqual({ ok: true, selectedThemeId: null });
    expect(admin.graphql).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledOnce();
  });
});
