/**
 * Shopify's `{% schema %}` limits, enforced over the real extension blocks.
 *
 * This file exists because a deploy failed on a limit nothing in the repo
 * measured. `enable_product`'s `info` gained the double-activation warning
 * (PLAN_MARKUP_ACTIVATION §1.3) and crossed Shopify's 500-character cap, and
 * `enable_video` had crossed it earlier without anyone noticing:
 *
 *   bundle: [blocks/structured-data.liquid] Invalid tag 'schema':
 *     settings: with id="enable_product" info is too long (max 500 characters)
 *
 * The failure mode is what makes it worth a test. It is NOT a size problem the
 * Liquid budget check can see: `minify-liquid-blocks.mjs` measures the TOTAL
 * bytes of the extension, and 613 characters inside one JSON string are
 * invisible to it. It only surfaces at `shopify app deploy`, i.e. after the
 * work is done and while something is being released.
 *
 * The margin is thin by nature — an `info` is a sentence a person writes, and
 * the useful ones run long. `enable_video` currently sits at 499 of 500, so
 * "one more clause" is a live risk rather than a hypothetical.
 *
 * Parsing note: the schema body must be STRICT JSON. Shopify rejects trailing
 * commas and comments there, so `JSON.parse` failing is itself a finding and
 * is asserted rather than skipped.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BLOCKS_DIR = join(REPO_ROOT, "extensions", "storefront", "blocks");

/** Shopify's documented cap for a setting's `info` text. */
const MAX_INFO_CHARS = 500;

interface Setting {
  id?: string;
  type?: string;
  info?: unknown;
  label?: unknown;
}

function blockFiles(): string[] {
  return readdirSync(BLOCKS_DIR)
    .filter((name) => name.endsWith(".liquid"))
    .sort();
}

/** The `{% schema %}` body of a block, or null when it has none. */
function schemaOf(file: string): { settings?: Setting[]; name?: string } | null {
  const source = readFileSync(join(BLOCKS_DIR, file), "utf8");
  const match = source.match(/\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/);
  if (!match) return null;
  return JSON.parse(match[1]);
}

describe("theme app extension {% schema %} hygiene", () => {
  const files = blockFiles();

  it("finds the blocks at all, so a moved directory fails loudly", () => {
    // Without this, a renamed folder would turn every check below into a
    // vacuous pass over an empty list.
    expect(files.length).toBeGreaterThan(0);
  });

  it("parses every schema as strict JSON", () => {
    for (const file of files) {
      expect(() => schemaOf(file), `${file} has an unparseable {% schema %}`).not.toThrow();
    }
  });

  it(`keeps every setting's info under Shopify's ${MAX_INFO_CHARS}-character cap`, () => {
    const tooLong: string[] = [];

    for (const file of files) {
      const schema = schemaOf(file);
      for (const setting of schema?.settings ?? []) {
        if (typeof setting?.info !== "string") continue;
        if (setting.info.length > MAX_INFO_CHARS) {
          tooLong.push(`${file} → ${setting.id ?? setting.type ?? "?"}: ${setting.info.length} chars`);
        }
      }
    }

    // Named rather than counted: the deploy error lists the offending ids, and
    // a failing test that does the same is actionable without a second look.
    expect(tooLong, `info too long (max ${MAX_INFO_CHARS}):\n  ${tooLong.join("\n  ")}`).toEqual([]);
  });

  it("gives every setting that has an info an id to report it under", () => {
    // A paragraph-type setting legitimately has no id; anything with an `info`
    // is a real control, and an unnamed one cannot be found from a deploy error.
    for (const file of files) {
      const schema = schemaOf(file);
      for (const setting of schema?.settings ?? []) {
        if (typeof setting?.info !== "string") continue;
        if (setting.type === "paragraph" || setting.type === "header") continue;
        expect(setting.id, `${file} has an info on a setting without an id`).toBeTruthy();
      }
    }
  });
});
