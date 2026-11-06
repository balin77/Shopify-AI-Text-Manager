/**
 * The theme-editor capture panel of the direct-translation embed speaks the
 * preview's language (`request.locale.iso_code`, the config's `locale`), with
 * English as the fallback.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SOURCE = readFileSync(resolve(__dirname, "../../extensions/storefront/assets/direct-translation.js"), "utf8");

async function boot(locale: string, available: boolean): Promise<string> {
  document.body.innerHTML =
    '<script type="application/json" id="contentpilot-dt-config">' +
    JSON.stringify({ locale, primaryLocale: "de", captureTool: true }) +
    "</script><p>Hallo</p>";
  (window as unknown as { Shopify: unknown }).Shopify = { designMode: true };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ available, version: 1, entries: {} }), {
      headers: { "Content-Type": "application/json" },
    })),
  );
  new Function(SOURCE)();
  await vi.waitFor(() => {
    expect(
      document.getElementById(available ? "contentpilot-capture-panel" : "contentpilot-plan-gate"),
    ).not.toBeNull();
  });
  return (document.getElementById(available ? "contentpilot-capture-panel" : "contentpilot-plan-gate") as HTMLElement)
    .textContent ?? "";
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.getElementById("contentpilot-capture-panel")?.remove();
  document.getElementById("contentpilot-plan-gate")?.remove();
  document.body.innerHTML = "";
});

describe("direct-translation capture panel language", () => {
  it("speaks German on a German preview", async () => {
    const text = await boot("de", true);
    expect(text).toContain("Direktübersetzungen");
    expect(text).toContain("Erfassungsmodus öffnen");
  });

  it("speaks Spanish on a regional Spanish preview", async () => {
    const text = await boot("es-MX", true);
    expect(text).toContain("Traducciones directas");
    expect(text).toContain("Abrir modo captura");
  });

  it("falls back to English for any other language", async () => {
    const text = await boot("fr", true);
    expect(text).toContain("Direct translations");
    expect(text).toContain("Open capture mode");
  });

  it("phrases the plan notice in the preview's language too", async () => {
    const text = await boot("es", false);
    expect(text).toContain("plan Max");
  });
});
