/**
 * The three language files must hold the SAME keys.
 *
 * This app ships in German, English and Spanish, and every component reads its
 * text as `t.someKey || "English fallback"`. That pattern is deliberate — a
 * missing key must never render an empty box — but it has one failure mode
 * nothing else catches: a key added to `en.ts` alone is invisible in English,
 * which is the language the person adding it is looking at. German and Spanish
 * merchants silently get English.
 *
 * That is exactly how a whole feature's worth of UI came to be half-English,
 * so the check is a test rather than a habit.
 */

import { describe, it, expect } from "vitest";
import { en } from "~/i18n/en";
import { de } from "~/i18n/de";
import { es } from "~/i18n/es";

/**
 * Every leaf of a translation object, as a PATH ARRAY.
 *
 * An array and not a dotted string, because several keys contain dots
 * themselves (`enumLabels["status.DRAFT"]`). Joining and re-splitting those
 * produces a path that resolves to nothing — which silently excused the whole
 * enum vocabulary from the blank check the first time this file was written.
 */
function leafPaths(value: unknown, prefix: string[] = []): string[][] {
  if (value === null || typeof value !== "object") return prefix.length ? [prefix] : [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leafPaths(child, [...prefix, key]),
  );
}

/** Only for messages and set membership — never for lookups. */
const show = (path: string[]) => path.join(" → ");

function at(dict: unknown, path: string[]): unknown {
  return path.reduce<unknown>((acc, key) => (acc as Record<string, unknown> | undefined)?.[key], dict);
}

const LANGS = { de, es } as const;

describe("i18n parity", () => {
  const englishPaths = leafPaths(en);
  const english = new Set(englishPaths.map(show));

  for (const [name, dict] of Object.entries(LANGS)) {
    it(`${name} has every key English has`, () => {
      const keys = new Set(leafPaths(dict).map(show));
      const missing = [...english].filter((k) => !keys.has(k));
      expect(missing, `${name}.ts is missing ${missing.length} key(s)`).toEqual([]);
    });

    it(`${name} has no key English lacks`, () => {
      // The other direction matters too: a key only a translation has is one
      // no component reads, and it will never be updated when the English
      // wording changes.
      const extra = leafPaths(dict).map(show).filter((k) => !english.has(k));
      expect(extra, `${name}.ts has ${extra.length} key(s) English does not`).toEqual([]);
    });

    it(`${name} is not blank where English says something`, () => {
      // `"" || "English"` yields the English fallback, so a blank translation
      // is not a blank screen — it is an untranslated one, which is precisely
      // the defect this file exists for. It is only a defect when English HAS
      // text there: some maps ("hints") use "" deliberately, in every language,
      // to mean "this code needs no hint".
      const blanks = englishPaths
        .filter((path) => {
          const source = at(en, path);
          const target = at(dict, path);
          return (
            typeof source === "string" &&
            source.trim() !== "" &&
            typeof target === "string" &&
            target.trim() === ""
          );
        })
        .map(show);
      expect(blanks, `${name}.ts is blank where English is not`).toEqual([]);
    });

  }
});
