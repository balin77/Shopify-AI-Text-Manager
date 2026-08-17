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

/** Every leaf path of a translation object, e.g. "content.createModal.create". */
function leafKeys(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object") return prefix ? [prefix] : [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

const LANGS = { de, es } as const;

describe("i18n parity", () => {
  const english = new Set(leafKeys(en));

  for (const [name, dict] of Object.entries(LANGS)) {
    it(`${name} has every key English has`, () => {
      const keys = new Set(leafKeys(dict));
      const missing = [...english].filter((k) => !keys.has(k));
      expect(missing, `${name}.ts is missing ${missing.length} key(s)`).toEqual([]);
    });

    it(`${name} has no key English lacks`, () => {
      // The other direction matters too: a key only a translation has is one
      // no component reads, and it will never be updated when the English
      // wording changes.
      const extra = [...leafKeys(dict)].filter((k) => !english.has(k));
      expect(extra, `${name}.ts has ${extra.length} key(s) English does not`).toEqual([]);
    });

    it(`${name} is not blank where English says something`, () => {
      // `"" || "English"` yields the English fallback, so a blank translation
      // is not a blank screen — it is an untranslated one, which is precisely
      // the defect this file exists for. It is only a defect when English HAS
      // text there: some maps ("hints") use "" deliberately, in every language,
      // to mean "this code needs no hint".
      const value = (dict: unknown, path: string): unknown =>
        path.split(".").reduce<unknown>((acc, key) => (acc as Record<string, unknown>)?.[key], dict);
      const blanks = [...english].filter(
        (k) =>
          typeof value(en, k) === "string" &&
          (value(en, k) as string).trim() !== "" &&
          typeof value(dict, k) === "string" &&
          (value(dict, k) as string).trim() === "",
      );
      expect(blanks, `${name}.ts is blank where English is not`).toEqual([]);
    });

  }
});
