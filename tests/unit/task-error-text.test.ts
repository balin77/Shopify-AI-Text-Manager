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
