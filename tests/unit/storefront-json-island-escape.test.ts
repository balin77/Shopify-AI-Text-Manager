import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Every `| json` output printed inside a <script> element of the theme app
 * extension (JSON islands AND inline JS) must also replace `<` with its JSON
 * escape. Whether Shopify's own `json` filter escapes `<` is NOT measured, so
 * the project assumes it does not: a metafield/setting value carrying
 * "</script>" would otherwise close the element and inject markup. JSON.parse
 * and a JS string literal both turn the escape back into `<`.
 *
 * Static on purpose (see structured-data-json-escape.test.ts): Shopify's Liquid
 * takes the quoted literal verbatim, while liquidjs decodes it back to `<`, so
 * a render test could not fail.
 *
 * snippets/cp-vg-item.liquid is covered differently: it prints no <script>
 * itself, and escapes its WHOLE captured object once (pinned in
 * variant-gallery-embed-snippet.test.ts).
 */
const BS = String.fromCharCode(92);
const ESCAPES = [`replace: '<', '${BS}u003c'`, `replace: "<", "${BS}u003c"`];

const root = join(__dirname, "../../extensions/storefront");
const files = ["blocks", "snippets"].flatMap((dir) =>
  readdirSync(join(root, dir))
    .filter((f) => f.endsWith(".liquid"))
    .map((f) => `${dir}/${f}`),
);

function stripComments(src: string): string {
  return src
    .replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, "")
    .replace(/\{%-?\s*schema\s*-?%\}[\s\S]*?\{%-?\s*endschema\s*-?%\}/g, "");
}

function scriptBodies(src: string): string[] {
  const out: string[] = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

describe("storefront extension: `<` escaping inside <script> elements", () => {
  it("finds the known islands", () => {
    const withJson = files.filter((f) =>
      scriptBodies(stripComments(readFileSync(join(root, f), "utf8"))).some((b) => /\|\s*json\b/.test(b)),
    );
    for (const f of [
      "blocks/localized-media.liquid",
      "blocks/direct-translation.liquid",
      "blocks/web-vitals.liquid",
      "blocks/structured-data.liquid",
      "blocks/variant-gallery.liquid",
      "blocks/variant-gallery-embed.liquid",
    ]) {
      expect(withJson).toContain(f);
    }
  });

  for (const f of files) {
    it(`${f}: every \`| json\` output in a <script> carries the < escape`, () => {
      const src = stripComments(readFileSync(join(root, f), "utf8"));
      for (const body of scriptBodies(src)) {
        const outputs = body.match(/\{\{[^}]*\|\s*json\b[^}]*\}\}/g) ?? [];
        for (const o of outputs) {
          expect(ESCAPES.some((e) => o.includes(e)), `${f}: ${o}`).toBe(true);
        }
      }
    });
  }

  it("localized-media: the island's metafield entries are escaped", () => {
    const src = readFileSync(join(root, "blocks/localized-media.liquid"), "utf8");
    expect(src).toContain(`"e":{{ lm.e | json | replace: '<', '${BS}u003c' }}`);
    expect(src).not.toMatch(/json, which escapes it/);
  });
});
