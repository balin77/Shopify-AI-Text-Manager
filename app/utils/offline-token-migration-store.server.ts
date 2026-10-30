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
import { decryptToken, encryptToken } from "./encryption.server";

export type MigrationStatus = "pending" | "migrated" | "needs_reauth" | "failed";

export interface MigrationRecord {
  shop: string;
  status: MigrationStatus;
  encryptedOldToken: string | null;
  attempts: number;
  lastError: string | null;
  startedAt: Date;
  completedAt: Date | null;
}

/** Shopify answers a repeat of the SAME exchange with the SAME pair for this long (changelog 2026-09-29). */
export const MIGRATION_RECOVERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

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
  const sameToken = existing ? decryptOldToken(existing) === oldToken : false;
  const encrypted = encryptToken(oldToken);
  if (!encrypted) throw new Error("[OfflineAdmin] Could not encrypt the old token for persistence");
  const now = new Date();
  await (await table()).upsert({
    where: { shop },
    create: { shop, encryptedOldToken: encrypted, status: "pending", startedAt: now },
    update: sameToken
      ? { encryptedOldToken: encrypted, status: "pending" }
      : { encryptedOldToken: encrypted, status: "pending", startedAt: now, attempts: 0, completedAt: null, lastError: null },
  });
}

/** The prompt retries ran out: keep the token, remember why. Retriable later. */
export async function markMigrationFailed(shop: string, message: string, attemptsMade: number): Promise<void> {
  await (await table()).update({
    where: { shop },
    data: { status: "failed", lastError: clip(message), attempts: { increment: attemptsMade } },
  });
}

/**
 * Shopify refused permanently. The old token is useless now, so it is erased
 * together with the status flip — there is nothing left to recover with.
 */
export async function markMigrationNeedsReauth(shop: string, message: string, attemptsMade: number): Promise<void> {
  await (await table()).upsert({
    where: { shop },
    create: { shop, status: "needs_reauth", lastError: clip(message), attempts: attemptsMade },
    update: {
      status: "needs_reauth",
      encryptedOldToken: null,
      lastError: clip(message),
      attempts: { increment: attemptsMade },
    },
  });
}

/** The new pair is stored: erase the old token (see the decision note in offline-admin.server.ts). */
export async function markMigrationMigrated(shop: string, attemptsMade: number): Promise<void> {
  await (await table()).updateMany({
    where: { shop },
    data: {
      status: "migrated",
      encryptedOldToken: null,
      lastError: null,
      completedAt: new Date(),
      attempts: { increment: attemptsMade },
    },
  });
}

/** Uninstall, redact, or a fresh token acquisition: the record (and its credential) goes. */
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
