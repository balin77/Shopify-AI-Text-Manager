import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "fs";
import path from "path";

/**
 * Every GraphQL document in this repo is a `#graphql` template literal whose
 * text is sent verbatim to Shopify. Two things must never end up in one:
 *
 * - a `#` COMMENT. Prose written between the backticks travels over the wire.
 *   A three-line comment added to the blog loader's `getBlogs` query took the
 *   whole page down with `syntax error, unexpected invalid token ("\") at
 *   [11, 3]` — line 11 was the last line of that comment. The document parsed
 *   fine under graphql-js and under graphql-c_parser (the parser whose error
 *   format Shopify emits), so the mangling happens somewhere on Shopify's
 *   ingest path and cannot be reproduced locally. Explanations belong in a JS
 *   comment next to the template, where they cost nothing on the wire.
 *
 * - a NON-ASCII character. Every comment this repo ever put inside a document
 *   carried one (`§`, `—`), so that is the other half of the same suspicion.
 *   Search values with accents belong in `variables`, never inline.
 */

const SKIP_DIRS = new Set(["node_modules", ".git", "build", "dist", "coverage", ".react-router"]);
const SOURCE_EXT = /\.(ts|tsx|js|mjs)$/;
const REPO_ROOT = path.resolve(__dirname, "../..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (SOURCE_EXT.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Slice out every `#graphql` template literal. Walks the literal by hand
 * instead of using one regex: these documents interpolate shared selection
 * constants, and a `${...}` may itself hold a nested template — a lazy
 * `` /`#graphql[\s\S]*?`/ `` would stop at the first inner backtick and hide
 * everything after it.
 */
function graphqlDocuments(source: string): { line: number; text: string }[] {
  const docs: { line: number; text: string }[] = [];
  const marker = "`#graphql";
  for (let at = source.indexOf(marker); at !== -1; at = source.indexOf(marker, at + 1)) {
    let i = at + 1;
    let depth = 0;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === "\\") i++;
      else if (c === "$" && source[i + 1] === "{") { depth++; i++; }
      else if (c === "}" && depth > 0) depth--;
      else if (c === "`" && depth === 0) break;
    }
    docs.push({
      line: source.slice(0, at).split("\n").length,
      text: source.slice(at + 1, i),
    });
  }
  return docs;
}

describe("GraphQL documents", () => {
  const files = sourceFiles(REPO_ROOT);

  it("finds the documents it is meant to guard", () => {
    const count = files.reduce((n, f) => n + graphqlDocuments(readFileSync(f, "utf8")).length, 0);
    expect(count).toBeGreaterThan(100);
  });

  it("carry no `#` comments — the text is sent to Shopify verbatim", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const doc of graphqlDocuments(readFileSync(file, "utf8"))) {
        doc.text.split("\n").forEach((text, i) => {
          // Line 0 is the `#graphql` editor hint itself, which every document has.
          if (i > 0 && /^\s*#/.test(text)) {
            offenders.push(`${path.relative(REPO_ROOT, file)}:${doc.line + i} ${text.trim()}`);
          }
        });
      }
    }
    expect(offenders).toEqual([]);
  });

  it("carry no non-ASCII characters", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const doc of graphqlDocuments(readFileSync(file, "utf8"))) {
        doc.text.split("\n").forEach((text, i) => {
          const found = [...text].filter((c) => c.charCodeAt(0) > 126);
          if (found.length > 0) {
            offenders.push(
              `${path.relative(REPO_ROOT, file)}:${doc.line + i} ${JSON.stringify(found.join(""))}`,
            );
          }
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
