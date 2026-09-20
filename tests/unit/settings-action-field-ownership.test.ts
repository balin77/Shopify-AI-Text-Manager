import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

/**
 * A field is written by the action that OWNS it, or not at all.
 *
 * The bug this pins: `seoTitleSuffixEnabled` / `seoTitleSuffix` are edited in
 * the SEO tab and saved by its own narrow `saveSeoSettings` action — but the
 * AI tab's save (`actionType: "saveSettings"`) lands in the settings action's
 * unnamed `else` CATCH-ALL, which used to write those two columns as well.
 * The AI tab's payload does not carry them, so Zod supplied its own defaults
 * (`.optional().default(false)` and `undefined || null`) and every save in the
 * AI tab silently cleared a suffix the merchant had configured elsewhere.
 *
 * This is a SOURCE test rather than a behavioural one on purpose: the property
 * is structural ("which branch may write which column"), the route pulls in
 * Polaris, Prisma and the Shopify session to import, and the repo already uses
 * this shape for a structural rule (graphql-document-hygiene.test.ts).
 */

const ROUTE = path.join(process.cwd(), "app/routes/app.settings.tsx");
const source = readFileSync(ROUTE, "utf-8");

/** Source of one `actionType === "<name>"` branch, up to the next branch. */
function branchSource(name: string): string {
  const start = source.indexOf(`actionType === "${name}"`);
  expect(start, `no branch for actionType "${name}"`).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const end = rest.indexOf('actionType === "');
  return end === -1 ? rest : rest.slice(0, end);
}

/** Everything after the LAST named branch — the unnamed `else` catch-all. */
function catchAllSource(): string {
  const lastNamed = source.lastIndexOf('actionType === "');
  const rest = source.slice(lastNamed);
  const elseStart = rest.indexOf("} else {");
  expect(elseStart, "no unnamed else branch found").toBeGreaterThan(-1);
  return rest.slice(elseStart);
}

describe("settings action — field ownership", () => {
  it("the SEO branch owns the title suffix", () => {
    const seo = branchSource("saveSeoSettings");
    expect(seo).toContain("seoTitleSuffixEnabled");
    expect(seo).toContain("seoTitleSuffix");
  });

  it("the catch-all (AI tab) never writes the SEO title suffix", () => {
    const catchAll = catchAllSource();
    // Comments may name the columns; assignments may not.
    const assignments = catchAll
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .filter((line) => /seoTitleSuffix(Enabled)?\s*:/.test(line));
    expect(assignments).toEqual([]);
  });

  it("the AI tab does not submit SEO suffix fields either", () => {
    const tab = readFileSync(
      path.join(process.cwd(), "app/components/SettingsAITab.tsx"),
      "utf-8",
    );
    expect(tab).not.toContain("seoTitleSuffix");
  });
});
