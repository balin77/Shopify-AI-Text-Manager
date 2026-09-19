import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * "Clear all translations for this language" must tell the save-response
 * handlers WHICH item it saved.
 *
 * `handleClearAllForLocaleConfirm` does not stage a draft — it submits the
 * deletion itself. Both response effects in `useUnifiedContentEditor` open with
 *
 *     const isSavedItemCurrent = savedItemIdRef.current === selectedItemIdRef.current;
 *     if (!isSavedItemCurrent) return;
 *
 * so a handler that sets `savedLocaleRef`/`isSavePendingRef` but leaves
 * `savedItemIdRef` at whatever the previous save left there (usually `null`,
 * which that guard itself writes back) has BOTH of them early-return:
 * `onSaveComplete` never runs, no "changes saved" box appears, and — the half
 * the merchant sees — the REVALIDATION at the tail of the second effect never
 * fires. The loader data then still carries the translations the server just
 * deleted, so the next time anything re-resolves the fields (an item switch,
 * which clears `deletedTranslationKeysRef`, or a locale switch) the cleared
 * values come straight back, and only a full page reload shows the truth.
 *
 * The same omission has been fixed twice before on other paths (see the
 * comment on `handleCopyFieldToAllLocales`), which is why this is pinned in
 * source rather than left to review.
 */

const SOURCE = readFileSync(
  join(process.cwd(), "app", "hooks", "useFieldHandlers.ts"),
  "utf8",
);

/** The body of one top-level `const <name> = (…) => { … }` handler. */
function handlerBody(name: string): string {
  const start = SOURCE.indexOf(`const ${name} = `);
  expect(start, `handler ${name} not found — was it renamed?`).toBeGreaterThan(-1);
  // Handlers are declared at column 0, so the next line starting with `};`
  // closes this one.
  const end = SOURCE.indexOf("\n};", start);
  expect(end, `end of ${name} not found`).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe("clear-all-for-locale save wiring", () => {
  const body = handlerBody("handleClearAllForLocaleConfirm");

  it("submits the deletion itself", () => {
    expect(body).toContain('action: "updateContent"');
    expect(body).toContain("safeSubmit(");
  });

  it("claims the item it is saving, before submitting", () => {
    const claim = body.indexOf("savedItemIdRef.current = selectedItemId");
    const submit = body.indexOf("safeSubmit(");
    expect(claim, "savedItemIdRef is not set — the response handlers will skip this save").toBeGreaterThan(-1);
    expect(claim).toBeLessThan(submit);
  });

  it("pins the locale and the market the save was submitted under", () => {
    expect(body).toContain("savedLocaleRef.current = currentLanguage");
    expect(body).toContain("savedMarketIdRef.current = selectedMarketId");
    expect(body).toContain("isSavePendingRef.current = true");
  });

  it("keeps the guard both effects read in one shape", () => {
    // If the guard is ever rewritten, this test is measuring the wrong thing.
    const editor = readFileSync(
      join(process.cwd(), "app", "hooks", "useUnifiedContentEditor.ts"),
      "utf8",
    );
    const guards = editor.match(
      /savedItemIdRef\.current === selectedItemIdRef\.current/g,
    );
    expect(guards?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

/**
 * The same rail, file-wide.
 *
 * Every site that announces a save by setting `isSavePendingRef` must also say
 * WHICH item it is saving, or the two response effects skip it. This has now
 * been fixed on four paths (clear-all-for-locale, the copy-to-all-locales
 * save, both translate auto-saves and the alt-text generate-all auto-save), so
 * the rule is pinned rather than re-reviewed.
 *
 * NOT in scope: `app/hooks/useEditorAltText.ts`, whose seven save sites carry
 * the same gap. That hook is not handed `savedItemIdRef` at all — closing it
 * means threading a new prop, which is a change of its own and is deliberately
 * left open rather than silently half-done here.
 */
describe("every save site claims its item", () => {
  const FILES = [
    "useFieldHandlers.ts",
    "useUnifiedContentEditor.ts",
    "useEditorAutoSave.ts",
  ];
  // A claim may sit a few lines up, behind the comment explaining it.
  const LOOKBACK = 15;

  for (const file of FILES) {
    it(`${file} sets savedItemIdRef before every isSavePendingRef`, () => {
      const lines = readFileSync(
        join(process.cwd(), "app", "hooks", file),
        "utf8",
      ).split("\n");

      const unclaimed: number[] = [];
      lines.forEach((line, i) => {
        if (!/isSavePendingRef\.current\s*=\s*true/.test(line)) return;
        const window = lines.slice(Math.max(0, i - LOOKBACK), i).join("\n");
        // A real claim only: `=` but not `===` (the guard both effects open
        // with) and not `= null` (the cleanup they end with) — both sit near
        // save sites, and either would satisfy a looser pattern while the
        // save stays unclaimed.
        const CLAIM = /savedItemIdRef\.current\s*=(?!=)\s*(?!null\b)\S/;
        if (!CLAIM.test(window)) unclaimed.push(i + 1);
      });

      expect(
        unclaimed,
        `${file}: save sites at line(s) ${unclaimed.join(", ")} do not set savedItemIdRef — ` +
          "the save-response effects will skip them (no onSaveComplete, no revalidation, no messages)",
      ).toEqual([]);
    });
  }
});
