import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every value printed into the structured-data JSON-LD islands goes through
 * `| json | replace: '<', '<'`. Whether Shopify's own `json` filter
 * escapes `<` is not measured, so the replace is the defence against a
 * merchant value containing "</script>" breaking out of the <script> element.
 *
 * Shopify's Liquid takes a quoted literal verbatim, while liquidjs (the
 * render-parity harness) decodes `<` back to `<` — so the bytes are
 * pinned statically here; a render test could not fail.
 */
const BS = String.fromCharCode(92); // a backslash, spelled so no tool decodes it away
const ESCAPED = `| json | replace: '<', '${BS}u003c' }}`;

const block = readFileSync(
  join(__dirname, "../../extensions/storefront/blocks/structured-data.liquid"),
  "utf8",
);

describe("structured-data.liquid: < escaping of JSON-LD values", () => {
  it("no value is printed with a bare `| json }}`", () => {
    expect(block).not.toMatch(/\|\s*json\s*\}\}/);
  });

  it("every `| json` output carries the byte-exact < escape", () => {
    const outputs = block.match(/\{\{[^}]*\|\s*json[^}]*\}\}/g) ?? [];
    expect(outputs.length).toBeGreaterThan(30);
    for (const o of outputs) expect(o.endsWith(ESCAPED)).toBe(true);
    expect(`${BS}u003c`).toHaveLength(6);
  });
});
