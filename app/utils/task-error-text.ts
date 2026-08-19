/**
 * `Task.error` holds a machine code for the task types that have no locale
 * context when they write it — the detached crawl handler and the stuck-task
 * reaper (task-recovery.service.js) both run outside a request. Those codes
 * must be translated at render time, never shown raw.
 *
 * Everything else keeps storing a human-readable message and passes through
 * untouched, so this is safe to apply to any task's error.
 */
/** `BlockSource` (crawl.service.ts) → its explanatory text in `seo.crawlPage`.
 *  Shared with the crawl page so both render the same attribution. */
export const BLOCK_SOURCE_TEXT_KEY: Record<string, string> = {
  cloudflare_challenge: "blockedByCloudflareChallenge",
  cloudflare_waf: "blockedByCloudflareWaf",
  cloudflare_unattributed: "blockedByCloudflareUnattributed",
  shopify_rate_limit: "blockedByShopifyRateLimit",
  shopify_security: "blockedByShopifySecurity",
  rate_limit: "blockedByRateLimit",
  unknown: "blockedByUnknown",
};

export function taskErrorText(raw: string | null | undefined, t: any): string | null {
  if (!raw) return null;

  const crawl = t?.seo?.crawlPage ?? {};
  // The crawl encodes attribution as `bot_blocked:<blocker>` — the code is
  // everything before the colon.
  switch (raw.split(":")[0]) {
    case "task_timed_out":
      return t?.tasks?.taskTimedOut || "Task timed out — no progress within the allowed time.";
    // Written by the orphan recovery (orphan-run-recovery.js) when the process
    // that owned a detached run is gone — a redeploy, an OOM kill. A different
    // code from `task_timed_out` on purpose: "we restarted under it" is
    // actionable ("start it again"), "it stopped reporting progress" invites the
    // merchant to look for a fault in their own shop.
    case "task_interrupted":
      return t?.tasks?.taskInterrupted || "Interrupted by a server restart. Please start it again.";
    case "bot_blocked": {
      const base = crawl.errorBotBlocked || null;
      // Without the attribution the merchant only sees "something blocked the
      // crawl" and is left guessing — which is what the generic text used to
      // do, badly, by pointing at a Cloudflare dashboard most shops don't have.
      const detailKey = BLOCK_SOURCE_TEXT_KEY[raw.split(":")[1] ?? ""];
      const detail = detailKey ? crawl[detailKey] : null;
      return base && detail ? `${base} ${detail}` : base;
    }
    case "storefront_password":
      return crawl.errorStorefrontPassword || null;
    case "invalid_domain":
    case "crawl_failed":
      return crawl.errorGeneric || null;
    // The snapshot half of the same event, as written to SeoCrawlSnapshot.error.
    case "interrupted":
      return crawl.errorInterrupted || null;
    default:
      return raw;
  }
}
