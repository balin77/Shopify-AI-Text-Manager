import { describe, it, expect } from "vitest";
import {
  dropGlobalStagedFor,
  overlayStampKey,
  pruneOverlayStamps,
  type OverlayStamps,
  type SubResourceOverlay,
} from "~/services/editor/sub-resource-overlay.shared";

const A = "gid://shopify/Metafield/1";
const B = "gid://shopify/Metafield/2";
const isGlobal = (k: string) => !k.includes("@@");

describe("dropGlobalStagedFor", () => {
  it("drops global entries only, sparing market layers and failed locales/resources", () => {
    const overlay: SubResourceOverlay = {
      en: { [A]: { value: "a" }, [B]: { value: "b" } },
      fr: { [A]: { value: "a-fr" } },
      "en@@gid://shopify/Market/5": { [A]: { value: "swiss" } },
    };
    const stamps: OverlayStamps = new Map([
      [overlayStampKey("en", A), 1],
      [overlayStampKey("en@@gid://shopify/Market/5", A), 1],
    ]);
    const touched = dropGlobalStagedFor(overlay, stamps, [A, B], {
      isGlobalLayerKey: isGlobal,
      failedLocales: ["fr"],
      failedResources: [B],
    });
    expect(touched).toBe(true);
    expect(overlay.en).toEqual({ [B]: { value: "b" } });
    expect(overlay.fr).toEqual({ [A]: { value: "a-fr" } });
    expect(overlay["en@@gid://shopify/Market/5"]).toEqual({ [A]: { value: "swiss" } });
    expect(stamps.has(overlayStampKey("en", A))).toBe(false);
    expect(stamps.has(overlayStampKey("en@@gid://shopify/Market/5", A))).toBe(true);
  });
});

describe("pruneOverlayStamps", () => {
  it("forgets stamps of entries the overlay no longer holds", () => {
    const overlay: SubResourceOverlay = { en: { [A]: { value: "a" } } };
    const stamps: OverlayStamps = new Map([
      [overlayStampKey("en", A), 1],
      [overlayStampKey("en", B), 1],
      [overlayStampKey("fr", A), 1],
    ]);
    pruneOverlayStamps(stamps, overlay);
    expect([...stamps.keys()]).toEqual([overlayStampKey("en", A)]);
  });
});
