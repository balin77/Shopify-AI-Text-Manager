import { describe, it, expect } from "vitest";
import { taskErrorText } from "~/utils/task-error-text";
import { de } from "~/i18n/de";
import { en } from "~/i18n/en";
import { es } from "~/i18n/es";

/**
 * `Task.error` is written by code that has no merchant locale (the detached
 * crawl handler, the stuck-task reaper in task-recovery.service.js), so it
 * stores machine codes. These assert the codes never reach the UI raw.
 */
describe("taskErrorText", () => {
  it("translates the stuck-task reaper's timeout code in every locale", () => {
    for (const t of [de, en, es] as any[]) {
      const text = taskErrorText("task_timed_out", t);
      expect(text).toBe(t.tasks.taskTimedOut);
      expect(text).not.toContain("task_timed_out");
    }
  });

  it("translates the orphan recovery's interruption code in every locale", () => {
    for (const t of [de, en, es] as any[]) {
      // Written when the process that owned a detached run is gone (a redeploy).
      const task = taskErrorText("task_interrupted", t);
      expect(task).toBe(t.tasks.taskInterrupted);
      expect(task).not.toContain("task_interrupted");
      // The snapshot half of the same event, off SeoCrawlSnapshot.error.
      const snapshot = taskErrorText("interrupted", t);
      expect(snapshot).toBe(t.seo.crawlPage.errorInterrupted);
      expect(snapshot).not.toBe("interrupted");
    }
  });

  it("translates crawl failures", () => {
    const crawl = (de as any).seo.crawlPage;
    expect(taskErrorText("bot_blocked", de)).toBe(crawl.errorBotBlocked);
    expect(taskErrorText("storefront_password", de)).toBe(crawl.errorStorefrontPassword);
    expect(taskErrorText("crawl_failed", de)).toBe(crawl.errorGeneric);
  });

  it("appends the blocker attribution so the merchant isn't left guessing", () => {
    const crawl = (de as any).seo.crawlPage;
    const text = taskErrorText("bot_blocked:shopify_security", de)!;
    expect(text).toContain(crawl.errorBotBlocked);
    expect(text).toContain(crawl.blockedByShopifySecurity);
    // The old generic advice pointed every shop at a Cloudflare dashboard.
    expect(crawl.errorBotBlocked).not.toMatch(/Cloudflare/i);
  });

  it("falls back to the generic text when the blocker is unrecognised", () => {
    const crawl = (de as any).seo.crawlPage;
    expect(taskErrorText("bot_blocked:something_new", de)).toBe(crawl.errorBotBlocked);
  });

  it("passes through the human-readable messages other task types store", () => {
    const msg = "Shopify rejected 3 of 12 fields";
    expect(taskErrorText(msg, de)).toBe(msg);
  });

  it("returns null for an empty error rather than a placeholder", () => {
    expect(taskErrorText(null, de)).toBeNull();
    expect(taskErrorText(undefined, de)).toBeNull();
    expect(taskErrorText("", de)).toBeNull();
  });

  it("falls back to English when the translation table is missing", () => {
    expect(taskErrorText("task_timed_out", {})).toContain("timed out");
  });
});

/**
 * The counted codes the AI runners write (seo-bulk-meta, bulk-editor-translate,
 * seo-bulk-fix, keyword-distribution, seo-audit, alt-text, keyword-insert,
 * text-translation). Each one replaced a hardcoded ENGLISH sentence that was
 * rendered raw in the Tasks card and in the completion toast, so the assertions
 * below pin three things at once: it is translated in all three bundles, the
 * numbers really arrive, and no `{placeholder}` survives.
 */
describe("taskErrorText — the runners' counted codes", () => {
  const BUNDLES: [string, any][] = [
    ["en", en],
    ["de", de],
    ["es", es],
  ];

  /** code -> the arguments it is written with, and the numbers that must show. */
  const CASES: [string, string[]][] = [
    ["rows_failed:3", ["3"]],
    ["rows_failed:3:40", ["3", "40"]],
    ["items_failed:3:40", ["3", "40"]],
    ["images_failed:2:9", ["2", "9"]],
    ["fixes_failed:1:5", ["1", "5"]],
    ["alt_images_failed:4:12", ["4", "12"]],
    ["batches_all_failed:7", ["7"]],
    ["batches_failed:2:7", ["2", "7"]],
    ["locale_scans_failed:3", ["3"]],
    ["ai_empty_value", []],
    ["item_missing", []],
    ["webp_batch_not_started", []],
    ["slug_empty:pt-BR", ["pt-BR"]],
  ];

  for (const [name, t] of BUNDLES) {
    it(`renders every code in ${name} with its numbers and no leftover placeholder`, () => {
      for (const [code, expected] of CASES) {
        const text = taskErrorText(code, t)!;
        expect(text, code).toBeTruthy();
        // The code itself must never reach the merchant.
        expect(text, code).not.toContain(code.split(":")[0]);
        expect(text, code).not.toMatch(/[{}]/);
        for (const value of expected) expect(text, `${code} -> ${value}`).toContain(value);
      }
    });
  }

  it("carries the rejected-key note as a translated flag, never as appended English", () => {
    for (const [, t] of BUNDLES) {
      const note = t.tasks.taskErrors.invalidApiKey;
      expect(taskErrorText("items_failed:3:40:1", t)).toContain(note);
      expect(taskErrorText("images_failed:3:40:1", t)).toContain(note);
      expect(taskErrorText("fixes_failed:3:40:1", t)).toContain(note);
      expect(taskErrorText("batches_all_failed:7:1", t)).toContain(note);
      // Without the flag the note is absent — the run failed for other reasons.
      expect(taskErrorText("items_failed:3:40", t)).not.toContain(note);
    }
    // The English suffix that used to be glued on is gone from the German line.
    expect(taskErrorText("items_failed:3:40:1", de)).not.toContain("invalid AI API key");
  });

  it("keeps the alt-text runner's provider message, colons and all", () => {
    // The provider's own text is the LAST argument precisely because it can
    // contain colons; splitting on the first one would truncate it.
    const text = taskErrorText("alt_images_failed:2:5:AI service error: 429", de)!;
    expect(text).toContain("AI service error: 429");
    expect(text).toContain("2");
    expect(text).toContain("5");
  });

  it("falls back to a neutral sentence when a code's numbers cannot be read", () => {
    // Never a half-substituted template and never the raw code — a malformed
    // row is still a row the merchant has to be able to read.
    for (const raw of ["rows_failed:", "items_failed:3", "items_failed:x:y", "slug_empty:"]) {
      const text = taskErrorText(raw, de)!;
      expect(text, raw).toBe(de.tasks.taskErrors.someFailed);
      expect(text, raw).not.toMatch(/[{}]/);
    }
  });

  it("is total — a malformed code neither throws nor renders a placeholder", () => {
    for (const raw of ["rows_failed", "batches_failed:::", "alt_images_failed:1", ":::"]) {
      expect(() => taskErrorText(raw, de)).not.toThrow();
      const text = taskErrorText(raw, de);
      if (text) expect(text, raw).not.toMatch(/\{[a-z]+\}/i);
    }
  });

  it("still renders the ENGLISH sentences already stored by the old build", () => {
    // `Task.error` is a wire format: rows written before the codes existed sit
    // in merchants' databases until `expiresAt` (up to three days). They carry
    // no colon before their first word, so they miss every case and reach the
    // merchant through the pass-through exactly as they did.
    const stored = [
      "3 of 40 row(s) failed",
      "5 row(s) failed",
      "2 of 9 item(s) failed (invalid AI API key)",
      "4 of 12 images failed: AI service error: 429",
      "All 7 batch call(s) failed",
      "3 of 7 batch call(s) failed — their items received no votes",
      "All 3 locale scan(s) failed — see logs for details.",
      "AI returned an empty value",
      "Item no longer exists in the content cache",
    ];
    for (const raw of stored) expect(taskErrorText(raw, de)).toBe(raw);
  });

  it("passes a provider message with a colon through untouched", () => {
    // The pass-through is what keeps a real diagnosis readable; the codes must
    // not shadow it just because it happens to contain a colon.
    expect(taskErrorText("AI service error: 429", de)).toBe("AI service error: 429");
  });

  it("the module's English fallbacks say the same thing as the en bundle", () => {
    // `taskErrorText` carries an inline English fallback per code so a bundle
    // that predates a key still renders the INFORMATION. Two English wordings
    // for one code is how they drift apart until nobody knows which is live.
    for (const [code] of CASES) {
      expect(taskErrorText(code, {}), code).toBe(taskErrorText(code, en));
    }
    expect(taskErrorText("items_failed:3:40:1", {})).toBe(taskErrorText("items_failed:3:40:1", en));
  });

  it("the three bundles carry the same taskErrors keys", () => {
    // A key present in en and missing in de renders as the English fallback in
    // a German shop — the exact defect these codes exist to remove.
    const reference = Object.keys(en.tasks.taskErrors).sort();
    expect(reference.length).toBeGreaterThan(10);
    for (const [name, t] of BUNDLES) {
      expect(Object.keys(t.tasks.taskErrors).sort(), name).toEqual(reference);
      for (const [key, value] of Object.entries(t.tasks.taskErrors)) {
        expect(typeof value, `${name}.${key}`).toBe("string");
        expect(String(value).trim(), `${name}.${key}`).not.toBe("");
      }
    }
  });

  it("keeps the new Tasks-page and notification keys in all three bundles", () => {
    for (const [name, t] of BUNDLES) {
      expect(typeof t.tasks.statusOptions.partial, name).toBe("string");
      for (const key of [
        "notificationSuccess",
        "notificationWarning",
        "notificationCritical",
        "notificationInfo",
      ]) {
        expect(typeof t.tasks[key], `${name}.${key}`).toBe("string");
        expect(String(t.tasks[key]).trim(), `${name}.${key}`).not.toBe("");
      }
    }
  });
});
