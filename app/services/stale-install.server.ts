/**
 * Stale install state (PLAN_ADMIN_SHOP_OVERVIEW 2.7): shops whose access has been
 * dead for a long time and that show no sign of life, but were never marked
 * uninstalled because Shopify's app/uninstalled webhook never reached us.
 *
 * Marking is serious: `markShopUninstalled` leads, 30 days later, to the reaper
 * deleting the shop's data. So:
 *  - The normal way is the OPERATOR script (scripts/mark-stale-uninstalled.ts),
 *    which prints the evidence and marks only with an explicit --apply
 *    (`reviewStaleInstall` + `markShopUninstalled(..., { source: "operator" })`).
 *  - The AUTOMATIC way is a switch that is OFF by default: only the exact value
 *    STALE_INSTALL_AUTO_MARK=true turns it on. It marks a shop blocked for 90
 *    days (14 when Shopify says the shop is not found) with no webhook, visit,
 *    sign-in, API success or reinstall evidence since, and no usable token left;
 *    at most 5 shops per UTC day, at most hourly, and nothing at all when more
 *    than 10 are eligible at once; source "stale_auto".
 *  - Both re-read the facts right before marking; nothing is decided from a
 *    list that may be stale. A reinstall evidence in between wins.
 *
 * Never logs a token; evidence is dates, booleans and codes. Never throws out of
 * the automatic run.
 */

import { db } from "../db.server";
import { logger } from "../utils/logger.server";
import {
  deriveConnectionStatus,
  isPresumedUninstalled,
  isStaleAutoMarkCandidate,
  type ConnectionInstallFacts,
  type ConnectionMigrationFacts,
  type ConnectionSessionFacts,
  type ConnectionStatusResult,
} from "./shop-connection-status.shared";
import type { MarkRefusal, UninstallEvidence, UninstallReviewView } from "./admin/uninstall-review.shared";

/** Shops marked by one automatic run at most. */
export const STALE_AUTO_MARK_PER_RUN = 5;
/** Blocked shops read per automatic run (oldest block first). */
export const STALE_AUTO_MARK_CANDIDATES = 200;

/** Only the exact value "true" enables the automatic marking. */
export function staleAutoMarkEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.STALE_INSTALL_AUTO_MARK === "true";
}

export interface StaleInstallReview {
  shop: string;
  /** No ShopInstallState row: nothing to judge. */
  found: boolean;
  install: ConnectionInstallFacts | null;
  /** Offline sessions of the shop, and how many still hold a non-empty token. */
  sessions: { total: number; withToken: number; withRefreshToken: number };
  migration: { status: string; attempts: number } | null;
  status: ConnectionStatusResult | null;
  alreadyUninstalled: boolean;
  /** Blocked >= 30 days (7 for a 404) without any sign of life. */
  presumedUninstalled: boolean;
  /** Blocked >= 90 days (14 for a 404) without any sign of life. */
  autoMarkEligible: boolean;
}

/** Gather everything the operator needs to judge one shop. Reads only; never a token. */
export async function reviewStaleInstall(shop: string, now: Date = new Date()): Promise<StaleInstallReview> {
  const install = (await db.shopInstallState.findUnique({
    where: { shop },
    select: {
      uninstalledAt: true,
      uninstallSource: true,
      reinstallEvidenceAt: true,
      connectionState: true,
      connectionStateSince: true,
      connectionStateReason: true,
      resyncRequiredSince: true,
      droppedWebhookCount: true,
      lastWebhookAt: true,
      lastActivityAt: true,
      lastAuthAt: true,
      lastApiOkAt: true,
    },
  })) as ConnectionInstallFacts | null;
  const [total, withToken, withRefreshToken, migration] = await Promise.all([
    db.session.count({ where: { shop, isOnline: false } }),
    db.session.count({ where: { shop, isOnline: false, accessToken: { not: "" } } }),
    db.session.count({
      where: { shop, isOnline: false, AND: [{ refreshToken: { not: null } }, { refreshToken: { not: "" } }] },
    }),
    db.offlineTokenMigration.findUnique({ where: { shop }, select: { status: true, attempts: true } }),
  ]);
  const session: ConnectionSessionFacts | null =
    total > 0 ? { tokenEmpty: withToken === 0, hasRefreshToken: withRefreshToken > 0 } : null;
  const status = install
    ? deriveConnectionStatus({
        now,
        install,
        session,
        migration: migration as ConnectionMigrationFacts | null,
      })
    : null;
  return {
    shop,
    found: !!install,
    install,
    sessions: { total, withToken, withRefreshToken },
    migration: migration ?? null,
    status,
    alreadyUninstalled: !!install?.uninstalledAt,
    presumedUninstalled: isPresumedUninstalled(install, now),
    autoMarkEligible: isStaleAutoMarkCandidate(install, now),
  };
}

/**
 * THE evidence rule of the operator marking, shared by the script and the
 * /admin button. First refusal wins; null means "may be marked". A session that
 * still holds a token refuses unless `forceWithToken` (script only).
 */
export function judgeStaleMark(review: StaleInstallReview, opts: { forceWithToken?: boolean } = {}): MarkRefusal | null {
  if (!review.found) return "unknown_shop";
  if (review.alreadyUninstalled) return "already_uninstalled";
  if (!review.presumedUninstalled) return "no_evidence";
  if (review.sessions.withToken > 0 && !opts.forceWithToken) return "token_present";
  return null;
}

const isoOrNull = (d: unknown): string | null => {
  if (d === null || d === undefined) return null;
  const t = d instanceof Date ? d : new Date(d as string | number);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
};

/** The panel's view of a review: verdict plus evidence, no secret of any kind. */
export function uninstallReviewView(review: StaleInstallReview): UninstallReviewView {
  const refusal = judgeStaleMark(review);
  const i = review.install;
  return {
    shop: review.shop,
    eligible: refusal === null,
    refusal,
    evidence: i
      ? {
          connectionState: i.connectionState ?? null,
          connectionStateReason: i.connectionStateReason ?? null,
          connectionStateSince: isoOrNull(i.connectionStateSince),
          derivedStatus: review.status?.status ?? null,
          lastWebhookAt: isoOrNull(i.lastWebhookAt),
          lastApiOkAt: isoOrNull(i.lastApiOkAt),
          lastActivityAt: isoOrNull(i.lastActivityAt),
          lastAuthAt: isoOrNull(i.lastAuthAt),
          reinstallEvidenceAt: isoOrNull(i.reinstallEvidenceAt),
          sessionsTotal: review.sessions.total,
          hasToken: review.sessions.withToken > 0,
          hasRefreshToken: review.sessions.withRefreshToken > 0,
          migration: review.migration ? `${review.migration.status}, ${review.migration.attempts} Versuch(e)` : null,
        }
      : null,
  };
}

export type MarkStaleResult = { ok: true } | { ok: false; reason: MarkRefusal | "changed" | "error" };

/**
 * Mark ONE shop uninstalled (source "operator") after RE-READING the facts and
 * re-judging them: nothing a caller claimed counts. The write itself is
 * conditional on the reviewed block (`ifBlockedSince`). Logs one line without
 * any token. `via` only names the entrance in that line.
 */
export async function markStaleShopUninstalled(
  shop: string,
  opts: { forceWithToken?: boolean; via: "script" | "admin_ui"; now?: Date },
): Promise<MarkStaleResult> {
  const review = await reviewStaleInstall(shop, opts.now ?? new Date());
  const refusal = judgeStaleMark(review, { forceWithToken: opts.forceWithToken });
  if (refusal) return { ok: false, reason: refusal };
  const since = review.install?.connectionStateSince;
  // Never write unconditionally from this path: without the reviewed block start
  // there is nothing to condition on, so it is no evidence.
  if (!since) return { ok: false, reason: "no_evidence" };
  const { markShopUninstalled } = await import("./shop-uninstall.server");
  const failure: { reason?: "changed" | "error" } = {};
  const done = await markShopUninstalled(shop, { source: "operator", ifBlockedSince: new Date(since), failure });
  if (done === false) return { ok: false, reason: failure.reason ?? "changed" };
  logger.info(
    `[StaleInstall] OPERATOR_MARKED_UNINSTALLED shop=${shop} via=${opts.via} state=${review.install?.connectionState ?? "none"} ` +
      `reason=${review.install?.connectionStateReason ?? "unknown"} since=${isoOrNull(since) ?? "unknown"}`,
  );
  return { ok: true };
}

export interface AutoMarkResult {
  enabled: boolean;
  /** Skipped because the last run was less than an hour ago. */
  throttled: boolean;
  considered: number;
  eligible: number;
  /** More shops were eligible at once than MASS_ELIGIBLE_LIMIT: nothing was marked. */
  aborted: boolean;
  marked: string[];
}

/** The automatic run happens at most this often (it reviews up to 200 rows). */
export const STALE_AUTO_MARK_INTERVAL_MS = 60 * 60 * 1000;
/** Eligible at once above this is likely a systemic cause (a bug, an outage): mark nothing. */
export const STALE_AUTO_MARK_MASS_LIMIT = 10;

// Process-local state (one web instance, RAILWAY-SETUP): the daily cap is
// forgotten by a restart, which is why the per-run bound and the mass stop
// exist beside it.
let lastRunMs = 0;
let capDay = "";
let capCount = 0;

export function __resetStaleAutoMarkForTests(): void {
  lastRunMs = 0;
  capDay = "";
  capCount = 0;
}

/**
 * The optional automatic marking. A no-op unless STALE_INSTALL_AUTO_MARK is
 * exactly "true". At most hourly; at most 5 shops per UTC day (per process);
 * more than 10 eligible at once = one loud warning and nothing marked; oldest
 * block first, every candidate re-reviewed, and the mark itself conditional on
 * the reviewed state (markShopUninstalled `ifBlockedSince`).
 */
export async function autoMarkStaleInstalls(
  now: Date = new Date(),
  opts: { env?: Record<string, string | undefined>; limit?: number } = {},
): Promise<AutoMarkResult> {
  const result: AutoMarkResult = { enabled: false, throttled: false, considered: 0, eligible: 0, aborted: false, marked: [] };
  if (!staleAutoMarkEnabled(opts.env ?? process.env)) return result;
  result.enabled = true;
  if (lastRunMs && now.getTime() - lastRunMs < STALE_AUTO_MARK_INTERVAL_MS) {
    result.throttled = true;
    return result;
  }
  lastRunMs = now.getTime();
  const day = now.toISOString().slice(0, 10);
  if (capDay !== day) {
    capDay = day;
    capCount = 0;
  }
  const limit = Math.min(Math.max(0, Math.floor(opts.limit ?? STALE_AUTO_MARK_PER_RUN)), STALE_AUTO_MARK_PER_RUN - capCount);
  try {
    const rows = await db.shopInstallState.findMany({
      where: { uninstalledAt: null, connectionState: { not: null } },
      orderBy: { connectionStateSince: "asc" },
      take: STALE_AUTO_MARK_CANDIDATES,
      select: { shop: true },
    });
    const eligible: StaleInstallReview[] = [];
    for (const { shop } of rows) {
      result.considered++;
      try {
        // Fresh facts, not the list's: a webhook or sign-in may have landed since.
        const review = await reviewStaleInstall(shop, now);
        if (!review.autoMarkEligible || review.alreadyUninstalled) continue;
        // A token that still exists could be a live access: never mark over it.
        if (review.sessions.withToken > 0) continue;
        eligible.push(review);
      } catch (error) {
        logger.warn(`[StaleInstall] review of ${shop} failed: ${error instanceof Error ? error.name : "error"}`);
      }
    }
    result.eligible = eligible.length;
    if (eligible.length > STALE_AUTO_MARK_MASS_LIMIT) {
      result.aborted = true;
      logger.warn(
        `[StaleInstall] AUTO_MARK_ABORTED eligible=${eligible.length} limit=${STALE_AUTO_MARK_MASS_LIMIT} - ` +
          "that many at once points to a systemic cause (outage, bug); nothing was marked",
      );
      return result;
    }
    for (const review of eligible) {
      if (result.marked.length >= limit) break;
      const shop = review.shop;
      try {
        const since = review.install?.connectionStateSince;
        // Never an unconditional write: without a block start there is no claim to make.
        if (!since) continue;
        const { markShopUninstalled } = await import("./shop-uninstall.server");
        const done = await markShopUninstalled(shop, {
          source: "stale_auto",
          ifBlockedSince: new Date(since),
        });
        if (done === false) continue;
        result.marked.push(shop);
        capCount++;
        logger.warn(
          `[StaleInstall] AUTO_MARKED_UNINSTALLED shop=${shop} state=${review.install?.connectionState} ` +
            `reason=${review.install?.connectionStateReason ?? "unknown"} ` +
            `since=${since ? new Date(since).toISOString() : "unknown"}`,
        );
      } catch (error) {
        logger.warn(`[StaleInstall] auto-mark of ${shop} failed: ${error instanceof Error ? error.name : "error"}`);
      }
    }
  } catch (error) {
    logger.warn(`[StaleInstall] auto-mark run failed: ${error instanceof Error ? error.name : "error"}`);
  }
  return result;
}
