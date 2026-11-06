/**
 * The internal-links preview modal renders the source resource's STORED HTML
 * (a product/collection descriptionHtml or a page/article body) before and
 * after the link insertion. That HTML was not authored by this app (Shopify
 * admin, other apps, importers), so it must be sanitized before it reaches
 * `dangerouslySetInnerHTML` — and the inserted link must survive that.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sanitizeHTML } from "../../app/utils/sanitizer";
import { insertLinkIntoHtml } from "../../app/services/seo/internal-links.service";

describe("internal-links preview sanitization", () => {
  it("routes both preview panes through sanitizeHTML", () => {
    const src = readFileSync(resolve(__dirname, "../../app/routes/app.seo.internal-links.tsx"), "utf8");
    const raw = src.match(/dangerouslySetInnerHTML=\{\{\s*__html:[^}]*\}\}/g) ?? [];
    expect(raw.length).toBeGreaterThanOrEqual(2);
    for (const use of raw) expect(use).toMatch(/__html:\s*sanitizeHTML\(/);
    expect(src).toMatch(/sanitizeHTML\(previewData\.before/);
    expect(src).toMatch(/sanitizeHTML\(previewData\.after/);
  });

  it("strips script and event handlers but keeps the inserted link", () => {
    const stored =
      '<p>Our Kumiko box <img src="x" onerror="alert(1)"><script>alert(2)</script></p>';
    const { html, inserted } = insertLinkIntoHtml(stored, "Kumiko box", "/products/kumiko-box");
    expect(inserted).toBe(true);
    const clean = sanitizeHTML(html);
    expect(clean).not.toMatch(/<script/i);
    expect(clean).not.toMatch(/onerror/i);
    expect(clean).toContain('<a href="/products/kumiko-box">Kumiko box</a>');
  });

  it("removes javascript: URLs from stored links", () => {
    const clean = sanitizeHTML('<p><a href="javascript:alert(1)">x</a></p>');
    expect(clean).not.toMatch(/javascript:/i);
  });
});
