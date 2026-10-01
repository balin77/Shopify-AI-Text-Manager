import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "fs";
import path from "path";

/**
 * PLAN_TRANSLATION_WRITE_UNIFICATION Phase H: nobody outside an explicit
 * allowlist SENDS `translationsRegister` / `translationsRemove`.
 *
 * "Sends" is matched by what a file does, not by the bare word (the strings
 * appear in comments and docs across dozens of files):
 *   - a GraphQL document (a `#graphql` literal, or the first argument of a
 *     `graphql(` call) whose text contains `translationsRegister(` or
 *     `translationsRemove(`, or
 *   - an import of the TRANSLATE_CONTENT / TRANSLATE_CONTENT_VERIFIED /
 *     REMOVE_TRANSLATIONS constants from the mutation file.
 *
 * The write path is app/services/translations/verified-translations.server.ts
 * (registerAndVerify, removeAndVerify, removeAndVerifyAcrossLocales, ...). A
 * new writer belongs there; adding a line to the allowlist needs a reason.
 */

const SKIP_DIRS = new Set(["node_modules", ".git", "build", "dist", "coverage", ".react-router", ".claude"]);
const SOURCE_EXT = /\.(ts|tsx|js|mjs|cjs)$/;
const REPO_ROOT = path.resolve(__dirname, "../..");
const SCAN_ROOTS = ["app", "src", "scripts"];

const ALLOWLIST: Record<string, string> = {
  // ── The write path itself ────────────────────────────────────────────────
  "app/services/translations/verified-translations.server.ts":
    "THE module: echo-verified register/remove, digests, re-read on a gap.",
  "app/graphql/content.mutations.ts":
    "The GraphQL constant file that DEFINES the documents (TRANSLATE_CONTENT, TRANSLATE_CONTENT_VERIFIED, REMOVE_TRANSLATIONS).",

  // ── Documented exceptions ────────────────────────────────────────────────
  "app/utils/cookie-banner-availability.server.ts":
    "Writes through Shopify's UNSTABLE CookieBanner endpoint, whose empty echo is a documented exception " +
    "(plan: 'Deliberately NOT migrated'); the exception stays and stays commented in that module.",

  // ── Probes (measure the platform, write throwaway values and remove them) ─
  "app/routes/api.translation-probe.tsx": "Settings > Probes > Translation: measures register/read/remove on samples.",
  "app/routes/api.menu-translation-probe.tsx": "Probe: menu Link GID register/verify/remove cycle.",
  "app/routes/api.menu-write-probe.tsx": "Probe: measures menu write semantics on menus it creates and deletes.",
  "app/services/localized-media/theme-image-probe.server.ts":
    "Logic module of the theme-image probe (kind=themeImage on the translation probe route): " +
    "writes the sample's own image into an EMPTY slot and removes it again.",

  // ── Echo-verified registers of their own, on the SHARED echo matcher ─────
  // The plan (Phases B, F, G) moved these onto translation-echo.shared rather
  // than onto registerAndVerify, because each has a tiering or per-surface
  // shape the generic helper does not model. They stay allowlisted until
  // someone folds them into verified-translations.server.ts.
  "src/services/shopify-content.service.ts":
    "ShopifyContentService's tiered saves (updateContent, saveFieldsIndividually, savePerLocaleBatch, " +
    "per-locale chunks): echo-verified through the shared matcher, mirror only confirmed keys.",
  "app/actions/templates/templates-update.action.ts":
    "Theme foreign save (handleUpdateContent): its own echo check, moved onto the shared matcher in Phase F.",
  "app/routes/api-ai-handlers/seo-bulk-fix.handler.ts":
    "persistFieldForLocale / registerAltTranslation: own echo-verified registers on the shared matcher (Phase G).",
  "app/services/menu-translation-repair.server.ts":
    "Restores captured menu-item translations verbatim, one register per item with every (locale, market) " +
    "pair aliased in; echo-verified on the shared matcher (Phase G).",
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (SOURCE_EXT.test(entry.name)) out.push(full);
  }
  return out;
}

function rootFiles(): string[] {
  return readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter((e) => e.isFile() && SOURCE_EXT.test(e.name))
    .map((e) => path.join(REPO_ROOT, e.name));
}

/** Drop block and line comments (best effort; strings holding `//` such as
 *  URLs are only touched when they sit at the start of a comment-looking run). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

const MUTATION_CALL = /translations(Register|Remove)\s*\(/;
const CONSTANT_IMPORT =
  /import\s*(?:type\s*)?\{[^}]*\b(TRANSLATE_CONTENT(?:_VERIFIED)?|REMOVE_TRANSLATIONS)\b[^}]*\}\s*from/;

/** Text of every `#graphql` literal and every literal passed straight to `graphql(`. */
function documents(source: string): string[] {
  const docs: string[] = [];
  const take = (start: number, quote: string) => {
    let i = start + 1;
    let depth = 0;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === "\\") i++;
      else if (quote === "`" && c === "$" && source[i + 1] === "{") { depth++; i++; }
      else if (quote === "`" && c === "}" && depth > 0) depth--;
      else if (c === quote && depth === 0) break;
    }
    docs.push(source.slice(start + 1, i));
  };
  for (let at = source.indexOf("`#graphql"); at !== -1; at = source.indexOf("`#graphql", at + 1)) take(at, "`");
  const call = /\bgraphql\(\s*([`"'])/g;
  for (let m = call.exec(source); m; m = call.exec(source)) take(m.index + m[0].length - 1, m[1]);
  return docs;
}

function sends(source: string): string[] {
  const reasons: string[] = [];
  if (documents(source).some((d) => MUTATION_CALL.test(d))) reasons.push("sends a translations mutation document");
  // A document held in a plain constant and passed on by name (the cookie banner's shape).
  if (/mutation\s+\w*\s*(\([^)]*\))?\s*\{\s*translations(Register|Remove)\s*\(/.test(source)) {
    reasons.push("declares a translations mutation document");
  }
  if (CONSTANT_IMPORT.test(stripComments(source))) reasons.push("imports a translations mutation constant");
  return reasons;
}

const files = [...SCAN_ROOTS.flatMap((r) => sourceFiles(path.join(REPO_ROOT, r))), ...rootFiles()];
const rel = (f: string) => path.relative(REPO_ROOT, f).split(path.sep).join("/");

describe("translation write guard (PLAN_TRANSLATION_WRITE_UNIFICATION Phase H)", () => {
  it("scans a meaningful number of files", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("no file outside the allowlist sends translationsRegister / translationsRemove", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const name = rel(file);
      if (name in ALLOWLIST) continue;
      const reasons = sends(readFileSync(file, "utf8"));
      if (reasons.length) offenders.push(`${name}: ${reasons.join("; ")}`);
    }
    expect(
      offenders,
      "Route translation writes through app/services/translations/verified-translations.server.ts " +
        "(registerAndVerify / removeAndVerify / removeAndVerifyAcrossLocales), or justify an allowlist entry in this test.",
    ).toEqual([]);
  });

  it("every allowlist entry still sends one (a stale entry hides a future regression)", () => {
    const stale = Object.keys(ALLOWLIST).filter((name) => {
      const full = path.join(REPO_ROOT, name);
      try {
        return sends(readFileSync(full, "utf8")).length === 0;
      } catch {
        return true;
      }
    });
    expect(stale).toEqual([]);
  });

  it("the old bulk-editor re-exports are gone", () => {
    const source = readFileSync(path.join(REPO_ROOT, "app/services/bulk-editor/translations.server.ts"), "utf8");
    expect(source).not.toMatch(/from "\.\.\/translations\/verified-translations\.server"/);
  });
});

describe("no second field -> translation-key map", () => {
  // Best effort: an object-literal entry mapping a UI field to its Shopify key.
  const LITERALS = [
    /\bseoTitle\s*:\s*['"]meta_title['"]/,
    /\bmetaDescription\s*:\s*['"]meta_description['"]/,
    /\bdescription\s*:\s*['"]body_html['"]/,
    /\bproductType\s*:\s*['"]product_type['"]/,
  ];
  const HOME = "app/services/translations/translation-keys.shared.ts";

  it("only translation-keys.shared.ts declares those entries", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const name = rel(file);
      if (name === HOME) continue;
      const code = stripComments(readFileSync(file, "utf8"));
      if (LITERALS.some((re) => re.test(code))) offenders.push(name);
    }
    expect(
      offenders,
      "Import FIELD_TO_TRANSLATION_KEY / fieldTranslationKeyMap / TRANSLATION_KEY_TO_FIELD from " + HOME,
    ).toEqual([]);
  });
});
