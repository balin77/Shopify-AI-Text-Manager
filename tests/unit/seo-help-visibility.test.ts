import { describe, it, expect, beforeEach } from "vitest";
import { readSeoHelpHidden, writeSeoHelpHidden } from "~/utils/seo-help-visibility";

describe("seo-help-visibility", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to visible for an unknown help id", () => {
    expect(readSeoHelpHidden("keywords")).toBe(false);
  });

  it("round-trips the dismissed state", () => {
    writeSeoHelpHidden("keywords", true);
    expect(readSeoHelpHidden("keywords")).toBe(true);
  });

  it("scopes the state per help id", () => {
    writeSeoHelpHidden("crawl-onpage", true);
    expect(readSeoHelpHidden("crawl-onpage")).toBe(true);
    expect(readSeoHelpHidden("crawl-delivery")).toBe(false);
  });

  it("clears the entry when the box is reopened", () => {
    writeSeoHelpHidden("sitemap", true);
    writeSeoHelpHidden("sitemap", false);
    expect(readSeoHelpHidden("sitemap")).toBe(false);
    expect(localStorage.getItem("contentpilot_seo_help_hidden_sitemap")).toBeNull();
  });
});
