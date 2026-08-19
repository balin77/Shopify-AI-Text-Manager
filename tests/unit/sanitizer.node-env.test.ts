// @vitest-environment node
/**
 * Unit tests — HTML sanitization ON THE SERVER.
 *
 * The environment docblock above is the whole point of this file. The suite's
 * default environment is happy-dom, which puts `Element`, `Node` & friends on
 * globalThis — so a sanitizer bug that depends on those globals being ABSENT
 * cannot reproduce there. Production is Node: isomorphic-dompurify works
 * through jsdom, and jsdom does not export its DOM constructors as globals.
 *
 * That gap shipped: an `instanceof Element` guard inside an afterSanitizeAttributes
 * hook threw `ReferenceError: Element is not defined` for ANY input containing a
 * single tag, so every settings save carrying HTML (the AI format examples) 500ed
 * in production while the whole unit suite stayed green.
 *
 * Anything added to app/utils/sanitizer.ts belongs here, not in a DOM-environment
 * test.
 */

import { describe, it, expect } from "vitest";
import {
  sanitizeHTML,
  sanitizeFormatExample,
  stripHTML,
  escapeHTML,
} from "../../app/utils/sanitizer";

describe("server environment", () => {
  it("has no DOM constructors on globalThis — the condition production runs under", () => {
    expect(typeof (globalThis as Record<string, unknown>).Element).toBe("undefined");
  });
});

describe("sanitizeHTML", () => {
  it("sanitizes markup without throwing (the ReferenceError regression)", () => {
    expect(sanitizeHTML("<p>Produktbeschreibung</p>")).toBe("<p>Produktbeschreibung</p>");
  });

  it("survives every tag the AI format examples actually contain", () => {
    const html =
      '<h2>Titel</h2><p><strong>fett</strong> und <em>kursiv</em></p>' +
      '<ul><li>eins</li><li>zwei</li></ul><a href="https://example.com">Link</a>' +
      '<img src="https://cdn.example.com/a.png" alt="a">';
    const out = sanitizeHTML(html);
    expect(out).toContain("<h2>Titel</h2>");
    expect(out).toContain("<li>zwei</li>");
    expect(out).toContain('href="https://example.com"');
  });

  it("still strips a script tag", () => {
    expect(sanitizeHTML('<p>ok</p><script>alert(1)</script>')).toBe("<p>ok</p>");
  });

  it("returns '' for empty input without touching DOMPurify", () => {
    expect(sanitizeHTML("")).toBe("");
  });
});

describe("the afterSanitizeAttributes hooks still do their job", () => {
  it("forces rel=noopener noreferrer on a targeted link", () => {
    const out = sanitizeHTML('<a href="https://example.com" target="_blank">x</a>');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it("defuses a Liquid placeholder in src", () => {
    const out = sanitizeHTML(`<img src="{{ 'no-image.png' | shopify_asset_url }}" alt="a">`);
    // `src` no longer sends the browser after a Liquid string...
    expect(out).toMatch(/\ssrc="data:image\/gif;base64,/);
    // ...while the original is KEPT in the data attribute on purpose.
    expect(out).toContain("data-liquid-src=\"{{ 'no-image.png' | shopify_asset_url }}\"");
  });

  it("defuses a Liquid placeholder in href", () => {
    const out = sanitizeHTML(`<a href="{% if x %}/a{% endif %}">x</a>`);
    expect(out).toContain('href="#"');
    expect(out).toContain("data-liquid-href");
  });
});

describe("the other exported sanitizers run server-side too", () => {
  it("sanitizeFormatExample keeps table markup", () => {
    const out = sanitizeFormatExample("<table><tbody><tr><td>a</td></tr></tbody></table>");
    expect(out).toContain("<td>a</td>");
  });

  it("stripHTML returns plain text", () => {
    expect(stripHTML("<p>Hallo <strong>Welt</strong></p>")).toBe("Hallo Welt");
  });

  it("escapeHTML needs no DOM at all", () => {
    expect(escapeHTML('<a href="x">')).toBe("&lt;a href=&quot;x&quot;&gt;");
  });
});
