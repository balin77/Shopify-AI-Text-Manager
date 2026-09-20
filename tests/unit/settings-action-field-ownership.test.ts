import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

/**
 * Two structural properties of the settings action, both of which were broken
 * and cost a merchant-visible setting.
 *
 * 1. A field is written by the action that OWNS it, or not at all.
 *    `seoTitleSuffixEnabled` / `seoTitleSuffix` are edited in the SEO tab and
 *    saved by `saveSeoSettings` — but the AI tab's save used to land in the
 *    action's unnamed `else` FALLBACK, which wrote those columns too. The AI
 *    tab's payload does not carry them, so Zod supplied its own defaults
 *    (`.optional().default(false)`, and `undefined || null`) and every save in
 *    the AI tab silently cleared a suffix configured elsewhere.
 *
 * 2. No branch that writes may be reachable by an UNKNOWN actionType. The
 *    credential branch was that fallback, and `encryptApiKey(undefined)`
 *    returns null exactly like `encryptApiKey("")` — so a request that merely
 *    omitted a field could clear a stored API key.
 *
 * Source tests on purpose: the properties are structural ("which branch may
 * write which column", "what does an unmatched request reach"), the route
 * cannot be imported without Polaris, Prisma and a Shopify session, and the
 * repo already uses this shape for a structural rule
 * (graphql-document-hygiene.test.ts).
 */

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf-8");
const source = read("app/routes/app.settings.tsx");
const aiTab = read("app/components/SettingsAITab.tsx");

/** Every actionType the route matches by name. */
function namedActions(): string[] {
  return [...source.matchAll(/actionType === "([^"]+)"/g)].map((m) => m[1]);
}

/**
 * Source of one named branch. BOUNDED at the next branch, the final `else`, or
 * the action's `catch` — whichever comes first. An unbounded slice would run to
 * EOF for the LAST branch and scan a third of the file (the React component),
 * which both false-fails on unrelated code and reads as a stronger guard than
 * it is.
 */
function branchSource(name: string): string {
  const start = source.indexOf(`actionType === "${name}"`);
  expect(start, `no branch for actionType "${name}"`).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const bounds = ['actionType === "', "\n    } else {", "\n  } catch (error"]
    .map((marker) => rest.indexOf(marker))
    .filter((i) => i > -1);
  return bounds.length ? rest.slice(0, Math.min(...bounds)) : rest;
}

/**
 * The action's final `else`. Anchored on the LAST named branch's own index
 * rather than `lastIndexOf('actionType === "')`, which would land in the React
 * component the moment anything there compares `fetcher.data.actionType` — a
 * pattern other settings tabs already use.
 */
function finalElse(): string {
  const last = namedActions().at(-1)!;
  const start = source.indexOf(`actionType === "${last}"`);
  const rest = source.slice(start);
  const elseStart = rest.indexOf("\n    } else {");
  expect(elseStart, "no final else branch found").toBeGreaterThan(-1);
  const body = rest.slice(elseStart);
  const catchStart = body.indexOf("} catch (error");
  return catchStart === -1 ? body : body.slice(0, catchStart);
}

/** Assignment lines (comments excluded) naming a field. */
function assignmentsTo(block: string, field: RegExp): string[] {
  return block
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .filter((line) => field.test(line));
}

describe("settings action — field ownership", () => {
  it("the SEO branch owns the title suffix", () => {
    const seo = branchSource("saveSeoSettings");
    expect(seo).toContain("seoTitleSuffixEnabled");
    expect(seo).toContain("seoTitleSuffix");
  });

  it("the credential branch never writes the SEO title suffix", () => {
    expect(
      assignmentsTo(branchSource("saveAiKeys"), /seoTitleSuffix(Enabled)?\s*:/),
    ).toEqual([]);
  });

  it("the AI tab does not submit SEO suffix fields either", () => {
    expect(aiTab).not.toContain("seoTitleSuffix");
  });
});

describe("AISettingsSchema — the fields it must not parse", () => {
  it("does not produce the SEO suffix columns at all", async () => {
    const { AISettingsSchema } = await import("~/utils/validation");
    const parsed = AISettingsSchema.parse({
      preferredProvider: "claude",
      appLanguage: "de",
    });
    // This is the assertion the source scan cannot make: while the schema
    // declared these with `.optional().default(false)`, ANY write built from
    // the parsed data — including a plain `...data` spread — reintroduced the
    // wipe without naming the field anywhere.
    expect(parsed).not.toHaveProperty("seoTitleSuffixEnabled");
    expect(parsed).not.toHaveProperty("seoTitleSuffix");
  });
});

describe("settings action — no unnamed write fallback", () => {
  it("the credential write is matched by NAME, not by falling through", () => {
    expect(namedActions()).toContain("saveAiKeys");
  });

  it("the final else writes nothing and refuses with 400", () => {
    const block = finalElse();
    expect(assignmentsTo(block, /\b(db|tx)\.\w+\.(upsert|update|create|delete)/)).toEqual([]);
    expect(block).toContain("status: 400");
  });

  it("the AI tab posts an actionType the route matches by name", () => {
    const posted = aiTab.match(/actionType: "([^"]+)"/)?.[1];
    expect(posted).toBeDefined();
    expect(namedActions()).toContain(posted!);
  });
});
