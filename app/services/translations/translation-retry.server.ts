/**
 * The retry list for automatic translations.
 *
 * Two kinds of work used to end with nothing but a log line and a Task row:
 *
 *  - a FIRST translation the merchant's optional daily limit refused
 *    (`AISettings.autoTranslateDailyLimit`, stale-translation-sync.server.ts),
 *    which otherwise waited for the resource's next change event — for a
 *    product that could be a price edit weeks later, or never;
 *  - an automatic run that FAILED (a provider error, a bad key, a write Shopify
 *    did not echo), whose filled locales then stayed empty until the text
 *    changed again.
 *
 * Both now land here: ONE row per (shop, resource) carrying the (key, locale)
 * pairs still owed. The nightly drift sweep works through the pending rows
 * (`processTranslationRetries`), re-reads the resource from Shopify, and hands
 * whatever is still missing or outdated to the SAME repair every other entrance
 * uses — this module decides nothing about translating, it only remembers.
 *
 * Three rules:
 *
 *  - AT MOST TWO RETRIES (`MAX_RETRY_ATTEMPTS`). A retry that runs and fails
 *    counts; a retry the daily limit postpones does NOT — that is the limit
 *    doing its job, not the translation failing, and counting it would drop
 *    work the merchant asked for because of a cap the merchant set. After the
 *    second failed retry the row stays, as `exhausted`, and the settings card
 *    shows it: work that is given up on is REPORTED, never deleted silently.
 *  - A new failure of the same resource resets the count. It describes a newer
 *    text, and the two attempts belong to that text.
 *  - Content surfaces only (Product, Collection, Page, Article, Blog,
 *    ShopPolicy — the resource's own `translatableResource`). The other
 *    surfaces the repair covers (metafields, option values, alt texts, theme
 *    content, menus, metaobject fields) carry a mirror, a lock and a prompt
 *    shape that are not serialisable into a row; a failure there keeps its old
 *    behaviour (the Task row, and the next change event). Stated, not hidden.
 */

import { logger } from "../../utils/logger.server";

export const MAX_RETRY_ATTEMPTS = 2;

/**
 * Rows retried per shop per sweep — every retry can start an AI run. It scales
 * with the merchant's own daily limit (so a backlog their limit refused drains
 * at the pace they chose, not at ours), within a hard ceiling.
 */
export function retriesPerSweep(dailyLimit: number | null): number {
  return Math.min(200, Math.max(25, dailyLimit ?? 25));
}

/**
 * What `lastError` holds: a CODE, rendered in the merchant's language by the
 * settings card (`t.settings.autoTranslateRetryErrors`). A raw provider or
 * Prisma message is for the log, never for a three-language UI.
 */
export const RETRY_ERROR_CODES = ["not_delivered", "could_not_start", "unreadable", "run_failed"] as const;
export type RetryErrorCode = (typeof RETRY_ERROR_CODES)[number];

/** A row left `running` longer than this belongs to a run whose process died
 *  (a redeploy) and is picked up again. */
const RUNNING_STALE_MS = 2 * 60 * 60 * 1000;

/** The resource types a retry can reproduce on its own. */
export const RETRYABLE_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  "Product",
  "Collection",
  "Page",
  "Article",
  "Blog",
  "ShopPolicy",
]);

export type RetryReason = "limit" | "failed";

export interface RetryPair {
  key: string;
  locale: string;
}

type Db = typeof import("../../db.server").db;

async function dbOf(dbClient?: Db | null): Promise<Db> {
  return dbClient ?? (await import("../../db.server")).db;
}

/** The stored JSON as pairs; anything malformed is dropped. */
export function retryPairsOf(value: unknown): RetryPair[] {
  if (!Array.isArray(value)) return [];
  const out: RetryPair[] = [];
  for (const item of value) {
    if (
      item &&
      typeof item === "object" &&
      typeof (item as RetryPair).key === "string" &&
      typeof (item as RetryPair).locale === "string"
    ) {
      out.push({ key: (item as RetryPair).key, locale: (item as RetryPair).locale });
    }
  }
  return out;
}

/** Union of two pair lists, order kept, duplicates dropped. */
export function mergeRetryPairs(a: readonly RetryPair[], b: readonly RetryPair[]): RetryPair[] {
  const seen = new Set<string>();
  const out: RetryPair[] = [];
  for (const pair of [...a, ...b]) {
    const id = `${pair.locale}\u0000${pair.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(pair);
  }
  return out;
}

/**
 * Put work on the list — from a normal run that failed, or from a refusal of
 * the daily limit. Merges into an existing row (the pairs are united), and
 * RESETS the attempt count: this is a new failure of a newer text. Never
 * throws: it runs after work that has already happened or already failed.
 */
export async function enqueueTranslationRetry(
  entry: {
    shop: string;
    resourceId: string;
    resourceType: string;
    contentKind: string;
    resourceTitle?: string;
    pairs: readonly RetryPair[];
    reason: RetryReason;
    /** A CODE (see `RETRY_ERROR_CODES`), never a raw message. */
    error?: RetryErrorCode;
  },
  dbClient?: Db | null,
): Promise<void> {
  if (!RETRYABLE_RESOURCE_TYPES.has(entry.resourceType) || entry.pairs.length === 0) return;
  try {
    const db = await dbOf(dbClient);
    const existing = await db.autoTranslateRetry.findUnique({
      where: { shop_resourceId: { shop: entry.shop, resourceId: entry.resourceId } },
      select: { pairs: true, status: true, attempts: true, reason: true },
    });
    const pairs = mergeRetryPairs(existing ? retryPairsOf(existing.pairs) : [], entry.pairs);
    const running = existing?.status === "running";
    // The count is RESET only by a new FAILURE of a row nobody is working on:
    // that is a newer text, and the two attempts belong to it. A limit refusal
    // is not a failure — resetting there let a row that keeps failing for a
    // real reason (a bad key) dodge `exhausted` forever. And a RUNNING row's
    // count belongs to its running retry; the new pairs get their own count
    // when that retry settles (`settleTranslationRetry`, "new work").
    const resetCount = entry.reason === "failed" && !running;
    const data = {
      resourceType: entry.resourceType,
      contentKind: entry.contentKind,
      resourceTitle: entry.resourceTitle ?? null,
      pairs: pairs as unknown as object,
      // "failed" outranks "limit": a row that failed once still owes a real attempt.
      reason: existing?.reason === "failed" && entry.reason === "limit" ? "failed" : entry.reason,
      ...(resetCount ? { attempts: 0 } : {}),
      // A running row stays running — its retry settles it; flipping it to
      // pending here would start a second one. An exhausted row with NEW work
      // becomes pending again.
      status: running ? "running" : resetCount || existing?.status !== "exhausted" ? "pending" : "exhausted",
      ...(entry.error ? { lastError: entry.error } : {}),
    };
    await db.autoTranslateRetry.upsert({
      where: { shop_resourceId: { shop: entry.shop, resourceId: entry.resourceId } },
      create: { shop: entry.shop, resourceId: entry.resourceId, ...data, attempts: 0 },
      update: data,
    });
  } catch (error: unknown) {
    logger.warn("[TranslationRetry] Could not record a retry", {
      context: "TranslationRetry",
      shop: entry.shop,
      resourceId: entry.resourceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * A NORMAL run delivered these pairs: they are owed nothing any more. Without
 * this an exhausted row stayed listed as "failed for good" after a later change
 * event had translated it after all. A RUNNING row is left to its retry, which
 * re-reads Shopify and settles against the truth. Never throws.
 */
export async function removeDeliveredRetryPairs(
  shop: string,
  resourceId: string,
  delivered: readonly RetryPair[],
  dbClient?: Db | null,
): Promise<void> {
  if (delivered.length === 0) return;
  try {
    const db = await dbOf(dbClient);
    const row = await db.autoTranslateRetry.findUnique({
      where: { shop_resourceId: { shop, resourceId } },
      select: { id: true, pairs: true, status: true },
    });
    if (!row || row.status === "running") return;
    const left = subtractRetryPairs(retryPairsOf(row.pairs), delivered);
    if (left.length === retryPairsOf(row.pairs).length) return;
    if (left.length === 0) await db.autoTranslateRetry.delete({ where: { id: row.id } });
    else await db.autoTranslateRetry.update({ where: { id: row.id }, data: { pairs: left as unknown as object } });
  } catch (error: unknown) {
    logger.warn("[TranslationRetry] Could not clear delivered retries", {
      context: "TranslationRetry",
      shop,
      resourceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** `a` without the pairs in `b`. */
export function subtractRetryPairs(a: readonly RetryPair[], b: readonly RetryPair[]): RetryPair[] {
  const drop = new Set(b.map((pair) => `${pair.locale}\u0000${pair.key}`));
  return a.filter((pair) => !drop.has(`${pair.locale}\u0000${pair.key}`));
}

/**
 * How a RETRY run ended, settled as a DIFFERENCE against what the row holds
 * NOW — never by overwriting it. Between the start of a retry and its end, a
 * normal run of the same resource may have put new pairs on this very row
 * (`enqueueTranslationRetry` merges into a running row); writing the retry's
 * leftovers over the stored list, or deleting the row because the retry itself
 * delivered everything, lost that work silently.
 *
 *  - `handed` is what this retry set out to deliver, `remaining` what it could
 *    not. The row keeps: (stored − handed) ∪ remaining.
 *  - Stored pairs this retry was never handed are NEW work: they get a fresh
 *    count (attempts 0, pending) instead of inheriting this retry's.
 *  - Nothing left ⇒ the row goes. Otherwise pending, or `exhausted` once the
 *    attempts are used up.
 *  - `postponed`: the retry did not really run (the daily limit, the switch is
 *    off, a run or a merchant save is in the way). The attempt the processor
 *    counted is given back, the pairs stay as they are.
 *
 * One interactive transaction, so two settles cannot interleave.
 */
export async function settleTranslationRetry(
  retryId: string,
  outcome: {
    handed: readonly RetryPair[];
    remaining: readonly RetryPair[];
    error?: RetryErrorCode;
    postponed?: boolean;
    /** Set the row's reason while postponing (only the daily limit does). */
    postponedBy?: RetryReason;
  },
  dbClient?: Db | null,
): Promise<void> {
  try {
    const db = await dbOf(dbClient);
    await db.$transaction(async (tx) => {
      const row = await tx.autoTranslateRetry.findUnique({
        where: { id: retryId },
        select: { attempts: true, pairs: true },
      });
      if (!row) return;
      const stored = retryPairsOf(row.pairs);
      if (outcome.postponed) {
        await tx.autoTranslateRetry.update({
          where: { id: retryId },
          data: {
            attempts: Math.max(0, row.attempts - 1),
            status: "pending",
            startedAt: null,
            ...(outcome.postponedBy ? { reason: outcome.postponedBy } : {}),
          },
        });
        return;
      }
      const newWork = subtractRetryPairs(stored, outcome.handed);
      const left = mergeRetryPairs(newWork, outcome.remaining);
      if (left.length === 0) {
        await tx.autoTranslateRetry.delete({ where: { id: retryId } });
        return;
      }
      const attempts = newWork.length > 0 ? 0 : row.attempts;
      await tx.autoTranslateRetry.update({
        where: { id: retryId },
        data: {
          pairs: left as unknown as object,
          attempts,
          status: newWork.length === 0 && attempts >= MAX_RETRY_ATTEMPTS ? "exhausted" : "pending",
          startedAt: null,
          ...(outcome.error ? { lastError: outcome.error } : {}),
        },
      });
    });
  } catch (error: unknown) {
    logger.warn("[TranslationRetry] Could not settle a retry", {
      context: "TranslationRetry",
      retryId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface RetrySummary {
  /** Rows waiting for their next attempt (or running one now). */
  pending: number;
  /** Rows whose two retries are used up — shown, never dropped silently. */
  exhausted: number;
  /** The exhausted rows themselves, newest first, for the settings card. */
  exhaustedItems: Array<{ resourceType: string; resourceTitle: string | null; resourceId: string; lastError: string | null }>;
  /* `lastError` is a RetryErrorCode (or null). */
}

export async function loadRetrySummary(shop: string, dbClient?: Db | null): Promise<RetrySummary> {
  try {
    const db = await dbOf(dbClient);
    const [pending, exhaustedRows] = await Promise.all([
      db.autoTranslateRetry.count({ where: { shop, status: { in: ["pending", "running"] } } }),
      db.autoTranslateRetry.findMany({
        where: { shop, status: "exhausted" },
        select: { resourceType: true, resourceTitle: true, resourceId: true, lastError: true },
        orderBy: { updatedAt: "desc" },
        take: 20,
      }),
    ]);
    const exhausted =
      exhaustedRows.length < 20
        ? exhaustedRows.length
        : await db.autoTranslateRetry.count({ where: { shop, status: "exhausted" } });
    return { pending, exhausted, exhaustedItems: exhaustedRows };
  } catch {
    return { pending: 0, exhausted: 0, exhaustedItems: [] };
  }
}

/**
 * Work through one shop's pending rows — called from the nightly drift sweep,
 * i.e. only for shops with the auto-translation switched on and entitled.
 * Each row is marked `running` with its attempt counted BEFORE the retry
 * starts, so a crash mid-run still counts as an attempt (and a row stuck in
 * `running` past RUNNING_STALE_MS is picked up again).
 */
export async function processTranslationRetries(
  params: {
    shop: string;
    client: import("../sync-types").ShopifyGraphQLClient;
    foreignLocales: readonly string[];
    /** The merchant's daily limit — paces the batch (`retriesPerSweep`). */
    dailyLimit?: number | null;
    /** Test seam. */
    retry?: typeof import("./stale-translation-sync.server").retryAutoTranslation;
  },
  dbClient?: Db | null,
): Promise<{ started: number; settled: number; postponed: number }> {
  const stats = { started: 0, settled: 0, postponed: 0 };
  const db = await dbOf(dbClient);
  const staleRunning = new Date(Date.now() - RUNNING_STALE_MS);
  const rows = await db.autoTranslateRetry.findMany({
    where: {
      shop: params.shop,
      OR: [
        { status: "pending" },
        // `startedAt`, never `updatedAt`: every enqueue on a running row bumps
        // the latter, so a row whose runner died would never look stale.
        { status: "running", OR: [{ startedAt: null }, { startedAt: { lt: staleRunning } }] },
      ],
    },
    orderBy: { updatedAt: "asc" },
    take: retriesPerSweep(params.dailyLimit ?? null),
  });
  if (rows.length === 0) return stats;
  const retry = params.retry ?? (await import("./stale-translation-sync.server")).retryAutoTranslation;
  const published = new Set(params.foreignLocales);

  for (const row of rows) {
    // A locale the shop no longer publishes is owed nothing.
    const pairs = retryPairsOf(row.pairs).filter((pair) => published.has(pair.locale));
    if (pairs.length === 0) {
      await db.autoTranslateRetry.delete({ where: { id: row.id } }).catch(() => undefined);
      stats.settled++;
      continue;
    }
    await db.autoTranslateRetry.update({
      where: { id: row.id },
      data: { status: "running", attempts: { increment: 1 }, startedAt: new Date() },
    });
    try {
      const outcome = await retry({
        client: params.client,
        shop: params.shop,
        retryId: row.id,
        resourceId: row.resourceId,
        resourceType: row.resourceType,
        contentKind: row.contentKind as "product" | "collection" | "blog" | "page",
        reason: row.reason === "limit" ? "limit" : "failed",
        ...(row.resourceTitle ? { resourceTitle: row.resourceTitle } : {}),
        pairs,
      });
      if (outcome === "started") stats.started++;
      else if (outcome === "postponed") stats.postponed++;
      else stats.settled++;
    } catch (error: unknown) {
      // The retry could not even look at the resource: that attempt failed.
      logger.warn("[TranslationRetry] Retry could not read the resource", {
        context: "TranslationRetry",
        shop: params.shop,
        resourceId: row.resourceId,
        error: error instanceof Error ? error.message : String(error),
      });
      await settleTranslationRetry(row.id, { handed: pairs, remaining: pairs, error: "unreadable" }, db);
    }
  }
  return stats;
}
