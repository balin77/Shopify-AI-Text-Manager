import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("product sync retires library alt rows only for cleanly read layers (wiring)", () => {
  it("the alt rewrite transaction deletes MediaImage library rows scoped to succeededAltLayers", () => {
    const src = readFileSync("app/services/product-sync.service.ts", "utf8");
    const at = src.indexOf("tx.contentTranslation.deleteMany");
    expect(at).toBeGreaterThan(0);
    const win = src.slice(at - 200, at + 500);
    expect(win).toContain("succeededAltLayers.length > 0");
    expect(win).toContain('resourceType: "MediaImage"');
    expect(win).toContain("marketId: { in: succeededAltLayers }");
  });

  it("the single-product write retires them per cleanly read layer (failed global locales and failed markets keep theirs)", () => {
    const src = readFileSync("app/services/product-sync.service.ts", "utf8");
    const marker = src.indexOf("const libraryMediaIds");
    expect(marker).toBeGreaterThan(0);
    const win = src.slice(marker, marker + 1400);
    expect(win).toContain("altFetchedLayers.includes(\"\")");
    expect(win).toContain("locale: { notIn: [...altFailedGlobal] }");
    expect(win).toContain("marketId: { in: marketLayers }");
    expect(win).toContain('resourceType: "MediaImage"');
    expect(win).toContain("createdImages.map");
  });
});
