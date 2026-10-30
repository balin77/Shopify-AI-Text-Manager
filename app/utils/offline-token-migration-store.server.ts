/**
 * Durable record of one shop's non-expiring -> expiring offline token migration
 * (model `OfflineTokenMigration`, see its comment in schema.prisma).
 *
 * WHY it exists: Shopify revokes the old token the moment the exchange
 * succeeds, and gives it back only as long as we can PRESENT that same old token
 * again (repeat of the exchange within 7 days returns the same pair). If the
 * process crashes between the exchange and the session store, the store fails,
 * or the library overwrites the stored session with `accessToken: undefined`
 * after a 401 on the revoked token, the old token would be gone from every
 * place we keep it. This table keeps it — ENCRYPTED with the same AES-256-GCM
 * helper that protects session tokens (`encryptToken`) — until the new pair is
 * stored.
 *
 * Every function here is best used inside the migration's try/catch: they throw
 * on a database error, because a migration that cannot make itself recoverable
 * must not start (maybeMigrateToExpiringToken treats the throw as a failed
 * attempt). They never log a token and never put one into `lastError`.
 *
 * `db` is imported lazily: offline-admin.server.ts (and with it the scheduler and
 * the task runners) must stay importable in a unit test without a database. The
 * encryption helpers read ENCRYPTION_KEY only when called.
 */

import { logger } from "./logger.server";
import { createHash } from "node:crypto";
import { decryptToken, encryptToken } from "./encryption.server";

export type MigrationStatus = "pending" | "needs_reauth" | "failed";

export interface MigrationRecord {
  shop: string;
  status: MigrationStatus;
  encryptedOldToken: string | null;
  /** First 16 hex chars of SHA-256 of the old token; null on rows written before it existed. */
  tokenFingerprint: string | null;
  attempts: number;
  lastError: string | null;
  startedAt: Date;
  completedAt: Date | null;
  updatedAt: Date;
}

/**
 * Shopify answers a repeat of the SAME exchange with the SAME pair for this long
 * (changelog 2026-09-29). We measure it from OUR first attempt with that token
 * (`startedAt`), not from the moment Shopify actually performed the exchange —
 * which can only be later, so the window we allow is the conservative one.
 */
export const MIGRATION_RECOVERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Base of the persisted retry backoff after a run of prompt retries ran out; doubles per failed run. */
export const PERSISTED_BACKOFF_BASE_MS = 10 * 60 * 1000;
export const PERSISTED_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;
/**
 * Exchange attempts after which a shop is given up on: status stays `failed`,
 * but nothing retries it automatically any more (see `isTerminal`). Ops reset:
 * the SQL in RAILWAY-SETUP.md. With 4 attempts per run and the doubling backoff
 * this is ~10 runs, i.e. a little over 3 days of trying.
 */
export const MIGRATION_MAX_ATTEMPTS = 40;

/** Failed runs so far (a run = `attemptsPerRun` exchange attempts). */
function failedRuns(attempts: number, attemptsPerRun: number): number {
  return Math.max(1, Math.ceil(attempts / Math.max(1, attemptsPerRun)));
}

/** How long a `failed` record waits (counted from its `updatedAt`) before the next run. Survives restarts. */
export function persistedBackoffMs(attempts: number, attemptsPerRun: number): number {
  return Math.min(PERSISTED_BACKOFF_BASE_MS * 2 ** (failedRuns(attempts, attemptsPerRun) - 1), PERSISTED_BACKOFF_MAX_MS);
}

export function isTerminal(record: MigrationRecord): boolean {
  return record.status === "failed" && record.attempts >= MIGRATION_MAX_ATTEMPTS;
}

/** Epoch ms before which a `failed` record must not be retried (Infinity when terminal). */
export function retryNotBefore(record: MigrationRecord, attemptsPerRun: number): number {
  if (record.status !== "failed") return 0;
  if (isTerminal(record)) return Infinity;
  return (record.updatedAt ?? record.startedAt).getTime() + persistedBackoffMs(record.attempts, attemptsPerRun);
}

/** A short fingerprint of a token — enough to tell two tokens apart, useless as a credential. */
export function fingerprintToken(token: string): string {
  return createHash("sha256").update(token.trim()).digest("hex").slice(0, 16);
}

/**
 * Does the shop's stored session token (still ENCRYPTED, as read from the table)
 * differ from the token `fingerprint` was taken of? `false` when it cannot be
 * told (no fingerprint, undecryptable): a row is only ever released on evidence.
 */
export function storedTokenDiffers(fingerprint: string | null | undefined, storedSessionToken: string): boolean {
  if (!fingerprint || !storedSessionToken) return false;
  try {
    const plain = decryptToken(storedSessionToken);
    return !!plain && fingerprintToken(plain) !== fingerprint;
  } catch {
    return false;
  }
}

export interface BlockingRecord {
  shop: string;
  tokenFingerprint: string | null;
}

const LIGHT_SELECT = { shop: true, status: true, attempts: true, updatedAt: true, startedAt: true, tokenFingerprint: true } as const;

/**
 * Records that keep a shop out of the automatic migration right now:
 * `needs_reauth`, and `failed` ones that are terminal or inside their persisted
 * backoff. Selects no ciphertext.
 */
export async function listBlockingRecords(now: number, attemptsPerRun: number): Promise<BlockingRecord[]> {
  const rows = (await (await table()).findMany({
    where: { status: { in: ["needs_reauth", "failed"] } },
    select: LIGHT_SELECT,
  })) as MigrationRecord[];
  return rows
    .filter((r) => r.status === "needs_reauth" || retryNotBefore(r, attemptsPerRun) > now)
    .map((r) => ({ shop: r.shop, tokenFingerprint: r.tokenFingerprint ?? null }));
}

/**
 * Re-arm ONE migration run for a given-up record: attempts back to cap-1 and the
 * persisted backoff cleared (`updatedAt` far in the past), status `failed`. The
 * run that follows either migrates or fails 4 more attempts and is terminal
 * again. Only the 403 deadline heal calls this (see healIfMigrationCannotRun).
 */
export async function rearmTerminal(shop: string): Promise<void> {
  await (await table()).updateMany({
    where: { shop },
    data: { status: "failed", attempts: MIGRATION_MAX_ATTEMPTS - 1, updatedAt: new Date(0) },
  });
}

/**
 * Shops whose record (pending/failed) still holds a ciphertext although the
 * recovery window is over — the ciphertext can only matter for a session that
 * LOST its token, which needs the window.
 */
export async function listPastWindowTokenShops(
  now: number,
  limit = 200,
  after?: { startedAt: Date; shop: string } | null,
): Promise<Array<{ shop: string; startedAt: Date }>> {
  // Oldest first, and paged by `after` (the last startedAt the caller saw): the
  // rows whose session still holds the token are kept and would otherwise be
  // re-read at the head of the list on every tick, starving the ones behind them.
  // Composite cursor (startedAt, shop): rows sharing a startedAt across a page
  // boundary are all visited.
  const rows = (await (await table()).findMany({
    where: {
      status: { in: ["pending", "failed"] },
      encryptedOldToken: { not: null },
      startedAt: { lt: new Date(now - MIGRATION_RECOVERY_WINDOW_MS) },
      ...(after
        ? { OR: [{ startedAt: { gt: after.startedAt } }, { startedAt: after.startedAt, shop: { gt: after.shop } }] }
        : {}),
    },
    select: { shop: true, startedAt: true },
    orderBy: [{ startedAt: "asc" }, { shop: "asc" }],
    take: limit,
  })) as Array<{ shop: string; startedAt: Date }>;
  return rows;
}

/**
 * Is `shop` marked uninstalled (ShopInstallState.uninstalledAt, stamped by the
 * app/uninstalled webhook, cleared by afterAuth)? A failing lookup answers
 * `false`: the check is an extra guard on top of the session re-read, and a
 * database that cannot answer this will fail the surrounding writes anyway.
 */
export async function isShopUninstalled(shop: string): Promise<boolean> {
  try {
    const { db } = await import("../db.server");
    const row = await db.shopInstallState.findUnique({ where: { shop }, select: { uninstalledAt: true } });
    return !!row?.uninstalledAt;
  } catch {
    return false;
  }
}

/**
 * Erase only the ciphertext (a given-up record): the fingerprint stays, so the
 * stale-record check still works. A reset of such a row can only retry while the
 * shop's session still holds the token (see RAILWAY-SETUP.md).
 */
export async function eraseOldToken(shop: string): Promise<void> {
  await (await table()).updateMany({ where: { shop }, data: { encryptedOldToken: null } });
}

const MAX_ERROR_LENGTH = 300;

function clip(message: string): string {
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}…` : message;
}

async function table() {
  const { db } = await import("../db.server");
  return db.offlineTokenMigration;
}

export async function getMigrationRecord(shop: string): Promise<MigrationRecord | null> {
  const row = await (await table()).findUnique({ where: { shop } });
  return row ? ({ ...row, status: row.status as MigrationStatus } as MigrationRecord) : null;
}

/**
 * The persisted old token, decrypted — only while a recovery is still possible
 * (status pending/failed, token present, inside the 7-day window). `null`
 * otherwise, also when the ciphertext cannot be decrypted (key rotated): that is
 * logged WITHOUT any value and treated as "no recoverable token".
 */
export function recoverableOldToken(record: MigrationRecord | null, now = Date.now()): string | null {
  if (!record || !record.encryptedOldToken) return null;
  if (record.status !== "pending" && record.status !== "failed") return null;
  if (now - record.startedAt.getTime() >= MIGRATION_RECOVERY_WINDOW_MS) return null;
  return decryptOldToken(record);
}

export function decryptOldToken(record: MigrationRecord): string | null {
  if (!record.encryptedOldToken) return null;
  try {
    return decryptToken(record.encryptedOldToken);
  } catch {
    logger.warn("[OfflineAdmin] Persisted old token of a migration could not be decrypted", { shop: record.shop });
    return null;
  }
}

/**
 * Persist `oldToken` BEFORE the exchange. If a record already holds the SAME
 * token the original `startedAt` is kept — the 7-day recovery window runs from
 * the first attempt with that token, not from every retry. A different token
 * (reinstall, re-auth) starts a new window and a new attempt count.
 */
export async function persistOldToken(shop: string, oldToken: string, existing: MigrationRecord | null): Promise<void> {
  const fingerprint = fingerprintToken(oldToken);
  const sameToken = existing ? existing.tokenFingerprint === fingerprint || decryptOldToken(existing) === oldToken : false;
  const encrypted = encryptToken(oldToken);
  if (!encrypted) throw new Error("[OfflineAdmin] Could not encrypt the old token for persistence");
  const now = new Date();
  await (await table()).upsert({
    where: { shop },
    create: { shop, encryptedOldToken: encrypted, tokenFingerprint: fingerprint, status: "pending", startedAt: now },
    update: sameToken
      ? { encryptedOldToken: encrypted, tokenFingerprint: fingerprint, status: "pending" }
      : {
          encryptedOldToken: encrypted,
          tokenFingerprint: fingerprint,
          status: "pending",
          startedAt: now,
          attempts: 0,
          completedAt: null,
          lastError: null,
        },
  });
}

/** The prompt retries ran out: keep the token, remember why. Retriable later. */
export async function markMigrationFailed(shop: string, message: string, attemptsMade: number): Promise<void> {
  // updateMany, never upsert: a record deleted meanwhile (uninstall, re-auth)
  // must not be re-created, least of all with a credential in it.
  // Restricted to pending/failed: a `needs_reauth` verdict (set while this run
  // was out, or by another path) must never be overwritten by a transient failure.
  await (await table()).updateMany({
    // attempts < cap: a record that is already terminal is never counted further.
    where: { shop, status: { in: ["pending", "failed"] }, attempts: { lt: MIGRATION_MAX_ATTEMPTS } },
    data: { status: "failed", lastError: clip(message), attempts: { increment: attemptsMade } },
  });
}

/**
 * Shopify refused permanently. The old token is useless now, so it is erased
 * together with the status flip — there is nothing left to recover with.
 */
export async function markMigrationNeedsReauth(shop: string, message: string, attemptsMade: number): Promise<void> {
  await (await table()).updateMany({
    where: { shop },
    data: {
      status: "needs_reauth",
      encryptedOldToken: null,
      lastError: clip(message),
      attempts: { increment: attemptsMade },
    },
  });
}

/**
 * The migration succeeded (pair stored), or the shop is gone, or a fresh token
 * was acquired: the record (and its credential) goes. Nothing needs a "migrated"
 * row afterwards, so there is none.
 */
export async function deleteMigrationRecord(shop: string): Promise<void> {
  await (await table()).deleteMany({ where: { shop } });
}

/**
 * Shops the sweep must leave alone (needs_reauth) and shops whose migration is
 * retriable (pending/failed inside the window, token still present) — one query
 * each, for the shops of one sweep candidate list.
 */
export async function listMigrationShopsByStatus(
  statuses: MigrationStatus[],
  options: { withTokenSince?: Date } = {},
): Promise<string[]> {
  const rows = await (await table()).findMany({
    where: {
      status: { in: statuses },
      ...(options.withTokenSince
        ? { encryptedOldToken: { not: null }, startedAt: { gt: options.withTokenSince } }
        : {}),
    },
    select: { shop: true },
  });
  return rows.map((r: { shop: string }) => r.shop);
}
