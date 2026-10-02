import { describe, it, expect, vi, beforeEach } from "vitest";
import { appEmbedActiveInSettingsData } from "../../app/services/localized-media/embed-status.shared";

const BANNER = "/*\n * ------------------------------------------------------------\n * IMPORTANT: The contents of this file are auto-generated.\n * ------------------------------------------------------------\n */\n";

function settings(blocks: unknown): string {
  return BANNER + JSON.stringify({ current: { logo: "x", blocks } });
}

const OURS = "shopify://apps/contentpilot-ai/blocks/localized-media/0f1e2d3c-1111-2222-3333-444455556666";

describe("appEmbedActiveInSettingsData", () => {
  it("is true for an enabled entry of the block", () => {
    expect(appEmbedActiveInSettingsData(settings({ "123": { type: OURS, disabled: false, settings: {} } }))).toBe(true);
  });

  it("is true when `disabled` is absent", () => {
    expect(appEmbedActiveInSettingsData(settings({ "123": { type: OURS, settings: {} } }))).toBe(true);
  });

  it("is false for a disabled entry", () => {
    expect(appEmbedActiveInSettingsData(settings({ "123": { type: OURS, disabled: true } }))).toBe(false);
  });

  it("is true when one of two entries is enabled", () => {
    expect(
      appEmbedActiveInSettingsData(settings({ a: { type: OURS, disabled: true }, b: { type: OURS.replace("0f1e", "aaaa") } })),
    ).toBe(true);
  });

  it("is false when only other embeds are present", () => {
    expect(
      appEmbedActiveInSettingsData(settings({ a: { type: "shopify://apps/contentpilot-ai/blocks/json-ld/abc" }, b: { type: "shopify://apps/other/blocks/localized-media-x/abc" } })),
    ).toBe(false);
  });

  it("is false when the theme has no app embeds at all", () => {
    expect(appEmbedActiveInSettingsData(BANNER + JSON.stringify({ current: { logo: "x" } }))).toBe(false);
  });

  it("matches by handle only: another app's block of the same handle counts (stated limit)", () => {
    expect(appEmbedActiveInSettingsData(settings({ a: { type: "shopify://apps/someone-else/blocks/localized-media/abc" } }))).toBe(true);
  });

  it("parses a file without the banner", () => {
    expect(appEmbedActiveInSettingsData(JSON.stringify({ current: { blocks: { a: { type: OURS } } } }))).toBe(true);
  });

  it("is null (unknown) for a missing, empty or unparseable file", () => {
    expect(appEmbedActiveInSettingsData(null)).toBeNull();
    expect(appEmbedActiveInSettingsData(undefined)).toBeNull();
    expect(appEmbedActiveInSettingsData("  ")).toBeNull();
    expect(appEmbedActiveInSettingsData(BANNER + "{ not json")).toBeNull();
  });

  it("is null for a shape it cannot read", () => {
    expect(appEmbedActiveInSettingsData(JSON.stringify({ current: "Default" }))).toBeNull();
    expect(appEmbedActiveInSettingsData(JSON.stringify({ presets: {} }))).toBeNull();
    expect(appEmbedActiveInSettingsData(JSON.stringify({ current: { blocks: "x" } }))).toBeNull();
    expect(appEmbedActiveInSettingsData(JSON.stringify({ current: { blocks: [] } }))).toBeNull();
  });
});

const themeMocks = vi.hoisted(() => ({
  getMainThemeId: vi.fn(),
  readThemeFile: vi.fn(),
}));
vi.mock("../../app/services/seo/aeo.service", () => themeMocks);

describe("getLocalizedMediaEmbedActive", () => {
  beforeEach(async () => {
    themeMocks.getMainThemeId.mockReset();
    themeMocks.readThemeFile.mockReset();
    const { clearLocalizedMediaEmbedCache } = await import("../../app/services/localized-media/embed-status.server");
    clearLocalizedMediaEmbedCache();
  });

  it("reads the main theme once and caches a known answer per shop", async () => {
    const { getLocalizedMediaEmbedActive } = await import("../../app/services/localized-media/embed-status.server");
    themeMocks.getMainThemeId.mockResolvedValue("gid://shopify/OnlineStoreTheme/1");
    themeMocks.readThemeFile.mockResolvedValue(settings({ a: { type: OURS } }));
    expect(await getLocalizedMediaEmbedActive({} as never, "a.myshopify.com")).toBe(true);
    expect(await getLocalizedMediaEmbedActive({} as never, "a.myshopify.com")).toBe(true);
    expect(themeMocks.readThemeFile).toHaveBeenCalledTimes(1);
    expect(themeMocks.readThemeFile).toHaveBeenCalledWith({}, "gid://shopify/OnlineStoreTheme/1", "config/settings_data.json");
  });

  it("is null without a main theme and on a throw, and does not cache unknown", async () => {
    const { getLocalizedMediaEmbedActive } = await import("../../app/services/localized-media/embed-status.server");
    themeMocks.getMainThemeId.mockResolvedValueOnce(null);
    expect(await getLocalizedMediaEmbedActive({} as never, "b.myshopify.com")).toBeNull();
    themeMocks.getMainThemeId.mockRejectedValueOnce(new Error("throttled"));
    expect(await getLocalizedMediaEmbedActive({} as never, "b.myshopify.com")).toBeNull();
    themeMocks.getMainThemeId.mockResolvedValueOnce("t");
    themeMocks.readThemeFile.mockResolvedValueOnce(settings({ a: { type: OURS, disabled: true } }));
    expect(await getLocalizedMediaEmbedActive({} as never, "b.myshopify.com")).toBe(false);
  });
});
