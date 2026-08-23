/**
 * `Task.error` holds a machine code for the task types that have no locale
 * context when they write it — the detached crawl handler, the stuck-task
 * reaper (task-recovery.service.js) and every runner in
 * `app/routes/api-ai-handlers/`, which finishes long after the request that
 * started it. Those codes must be translated at render time, never shown raw.
 *
 * Everything else keeps storing a human-readable message and passes through
 * untouched, so this is safe to apply to any task's error.
 *
 * ── The wire format ──────────────────────────────────────────────────────
 *
 * `<code>[:<arg>[:<arg>…]]`, colon-separated, and it is a WIRE FORMAT: rows
 * written by an older build sit in merchants' databases until `expiresAt`
 * (up to three days), so a code may never be renamed or have its argument
 * order changed — the old row would render as its own machine string. The
 * same rule is what protects the ENGLISH sentences those runners used to
 * store: none of them contains a colon before its first word, so they miss
 * every case below and reach the merchant through the pass-through exactly
 * as they do today.
 *
 * Numbers are arguments and are substituted into the translated sentence at
 * render time. A recognised code whose numeric arguments cannot be read falls
 * back to a neutral sentence — never to a half-substituted template, and never
 * to the raw code.
 *
 * The " (invalid AI API key)" note the bulk runners used to glue onto their
 * English sentence is a FLAG argument (`1`), so it is translated with the rest
 * instead of being English appended to German.
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

/**
 * English fallbacks for the counted codes, used when the bundle does not carry
 * the key (an older language file, a partial `t` in a test). Same shape as the
 * `t?.tasks?.x || "…"` fallbacks the crawl codes above already use — the point
 * is that a missing translation costs the merchant the language, never the
 * information.
 */
const FALLBACK: Record<string, string> = {
  rowsFailed: "{count} row(s) could not be saved.",
  rowsFailedOfTotal: "{count} of {total} row(s) could not be saved.",
  itemsFailed: "{count} of {total} item(s) failed.",
  imagesFailed: "{count} of {total} image(s) failed.",
  fixesFailed: "{count} of {total} fix(es) failed.",
  altImagesFailed: "{count} of {total} image(s) failed.",
  batchesAllFailed: "Every AI batch call failed ({total} in total).",
  batchesFailed: "{count} of {total} AI batch call(s) failed — the entries in them received no keyword suggestions.",
  localeScansFailed: "Every language scan failed ({total} in total) — see the logs for details.",
  aiEmptyValue: "The AI returned an empty value.",
  itemMissing: "This entry no longer exists in the content cache — reload it and try again.",
  webpBatchNotStarted: "The image conversion could not be started. No image was changed — please try again.",
  slugEmpty: "The translated URL slug for {language} came out empty and was not saved.",
  invalidApiKey: "(the AI API key was rejected)",
  someFailed: "Some entries could not be processed — open the task for details.",
};

function phrase(t: any, key: string): string {
  const value = t?.tasks?.taskErrors?.[key];
  if (typeof value === "string" && value.trim() !== "") return value;
  // A key that is in neither table would hand `fill()` an `undefined` and
  // throw inside a render — the neutral sentence is the floor.
  return FALLBACK[key] ?? FALLBACK.someFailed;
}

/** Substitutes every `{name}` occurrence. Never leaves a placeholder behind
 *  for a value it was given, and never throws on one it was not. */
function fill(template: string, vars: Record<string, string | number>): string {
  let out = template;
  for (const [name, value] of Object.entries(vars)) {
    out = out.split(`{${name}}`).join(String(value));
  }
  return out;
}

/** A count argument is a plain non-negative integer or it is unusable — a
 *  `parseInt` would happily read "3 of 40 row(s)" as 3. */
function count(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!/^\d{1,9}$/.test(trimmed)) return null;
  return Number(trimmed);
}

/** The rejected-key note rides on the same line rather than in a second
 *  sentence: it is the REASON the count is what it is. */
function withApiKeyNote(text: string, flagged: boolean, t: any): string {
  return flagged ? `${text} ${phrase(t, "invalidApiKey")}` : text;
}

export function taskErrorText(raw: string | null | undefined, t: any): string | null {
  if (!raw) return null;

  const crawl = t?.seo?.crawlPage ?? {};
  // The crawl encodes attribution as `bot_blocked:<blocker>` — the code is
  // everything before the colon, and the counted codes below read their
  // arguments out of the same split.
  const parts = raw.split(":");
  const neutral = () => phrase(t, "someFailed");

  switch (parts[0]) {
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
      const detailKey = BLOCK_SOURCE_TEXT_KEY[parts[1] ?? ""];
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

    // ── Counted partial failures (the bulk runners) ──────────────────────
    //
    // `rows_failed` carries a total where the runner knows one and only the
    // count where it does not (the bulk translate run counts saved UNITS, not
    // rows, so `saved + failed` would not be the number of rows).
    case "rows_failed": {
      const failed = count(parts[1]);
      if (failed === null) return neutral();
      const total = count(parts[2]);
      return total === null
        ? fill(phrase(t, "rowsFailed"), { count: failed })
        : fill(phrase(t, "rowsFailedOfTotal"), { count: failed, total });
    }
    // The three SEO bulk-fix runners. Same shape, different noun — a merchant
    // reading "3 of 40 failed" on the alt-text run wants to know it is images.
    case "items_failed":
    case "images_failed":
    case "fixes_failed": {
      const failed = count(parts[1]);
      const total = count(parts[2]);
      if (failed === null || total === null) return neutral();
      const key =
        parts[0] === "items_failed"
          ? "itemsFailed"
          : parts[0] === "images_failed"
            ? "imagesFailed"
            : "fixesFailed";
      return withApiKeyNote(fill(phrase(t, key), { count: failed, total }), parts[3] === "1", t);
    }
    // The alt-text generator's own count. Its third argument is not a flag but
    // the last provider message, which is free text and may itself contain
    // colons — so everything past the second argument is the detail.
    case "alt_images_failed": {
      const failed = count(parts[1]);
      const total = count(parts[2]);
      if (failed === null || total === null) return neutral();
      const text = fill(phrase(t, "altImagesFailed"), { count: failed, total });
      const detail = parts.slice(3).join(":").trim();
      return detail ? `${text} ${detail}` : text;
    }
    case "batches_all_failed": {
      const total = count(parts[1]);
      if (total === null) return neutral();
      return withApiKeyNote(fill(phrase(t, "batchesAllFailed"), { total }), parts[2] === "1", t);
    }
    case "batches_failed": {
      const failed = count(parts[1]);
      const total = count(parts[2]);
      if (failed === null || total === null) return neutral();
      return fill(phrase(t, "batchesFailed"), { count: failed, total });
    }
    case "locale_scans_failed": {
      const total = count(parts[1]);
      if (total === null) return neutral();
      return fill(phrase(t, "localeScansFailed"), { total });
    }

    // ── Single-cause failures ────────────────────────────────────────────
    case "ai_empty_value":
      return phrase(t, "aiEmptyValue");
    case "item_missing":
      return phrase(t, "itemMissing");
    // A WebP conversion run whose per-image work items were never written (the
    // batch has an aggregate row and nothing under it). Its own code rather
    // than a counted one: no image was attempted, so "0 of 20 failed" would
    // describe twenty conversions that never started.
    case "webp_batch_not_started":
      return phrase(t, "webpBatchNotStarted");
    case "slug_empty": {
      // The locale code is the only thing the runner knows; a name would need a
      // shop lookup this module has no business doing.
      const locale = (parts[1] ?? "").trim();
      if (!locale) return neutral();
      return fill(phrase(t, "slugEmpty"), { language: locale });
    }

    default:
      return raw;
  }
}
