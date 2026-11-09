/**
 * Read model of a shop's connection (PLAN_ADMIN_SHOP_OVERVIEW 2.1): ONE pure
 * function, `deriveConnectionStatus`, turns the facts we store (install state,
 * the offline session's SHAPE, the token-migration record) into a verdict.
 *
 * IMPORT-FREE on purpose, like the other `.shared.ts` leaves: the /admin
 * overview renders from it in component scope, and a single server import here
 * would drag a server module into the client bundle.
 *
 * Hard rules:
 *  - The FIRST applicable rule wins (order of CONNECTION_STATUS_ORDER).
 *  - Missing data is "unknown", never evidence: every input field may be null.
 *  - It never sees a token. The session summary carries booleans and dates only.
 */

export type ConnectionBlockState = "needs_reauth" | "access_denied" | "shop_not_found";

export type ConnectionStatus =
  | "uninstalled"
  | "shop_not_found"
  | "access_denied"
  | "needs_reauth"
  | "migration_gave_up"
  | "failing_transiently"
  | "valid_expiring"
  | "valid_non_expiring"
  | "no_session";

/** Order in which the rules are tried; the first match is the verdict. */
export const CONNECTION_STATUS_ORDER: readonly ConnectionStatus[] = [
  "uninstalled",
  "shop_not_found",
  "access_denied",
  "needs_reauth",
  "migration_gave_up",
  "failing_transiently",
  "valid_expiring",
  "valid_non_expiring",
  "no_session",
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Blocked this long, with no webhook and no visit since: "presumably uninstalled". */
export const PRESUMED_UNINSTALLED_AFTER_MS = 30 * DAY_MS;
/** The same, for a shop Shopify answers 404 for (the shop is gone, not just silent). */
export const PRESUMED_UNINSTALLED_AFTER_MS_NOT_FOUND = 7 * DAY_MS;

/**
 * Exchange attempts after which a token migration is given up on. Mirrors
 * MIGRATION_MAX_ATTEMPTS in offline-token-migration-store.server.ts (this file
 * cannot import it); a unit test pins the two together.
 */
export const MIGRATION_GAVE_UP_ATTEMPTS = 40;

/** A webhook this long after `uninstalledAt` is evidence the shop is still there. */
export const WEBHOOK_AFTER_UNINSTALL_GRACE_MS = 5 * 60 * 1000;

/** The ShopInstallState columns the verdict reads. All optional: absent = unknown. */
export interface ConnectionInstallFacts {
  uninstalledAt?: Date | null;
  uninstallSource?: string | null;
  reinstallEvidenceAt?: Date | null;
  connectionState?: string | null;
  connectionStateSince?: Date | null;
  connectionStateReason?: string | null;
  resyncRequiredSince?: Date | null;
  droppedWebhookCount?: number | null;
  lastWebhookAt?: Date | null;
  lastActivityAt?: Date | null;
  lastAuthAt?: Date | null;
}

/** The SHAPE of the offline session; never its token. `null` = no offline session row. */
export interface ConnectionSessionFacts {
  /** The stored access token is empty (cleared by a permanent refusal). */
  tokenEmpty: boolean;
  hasRefreshToken: boolean;
  /** Access token expiry; null for a non-expiring token. */
  expires?: Date | null;
  refreshTokenExpires?: Date | null;
}

/** The OfflineTokenMigration columns the verdict reads (never the encrypted token). */
export interface ConnectionMigrationFacts {
  status: string;
  attempts: number;
  failureKind?: string | null;
  failureKindSince?: Date | null;
}

export interface ConnectionStatusInput {
  now: Date;
  install: ConnectionInstallFacts | null;
  session: ConnectionSessionFacts | null;
  migration: ConnectionMigrationFacts | null;
}

export interface ConnectionStatusResult {
  status: ConnectionStatus;
  /** Machine code of why (a code, never a message); null when nothing is wrong. */
  reason: string | null;
  /** Since when the shop has been in this problem state, when known. */
  since: Date | null;
  /** Webhooks of this shop are accepted but not processed (connectionState is set). */
  webhooksPaused: boolean;
  droppedWebhookCount: number;
  resyncRequiredSince: Date | null;
  /** uninstalledAt is set although webhooks kept arriving after it (stale install state). */
  webhooksAfterUninstall: boolean;
  /** Blocked for long, with no webhook and no visit since the block began. */
  presumedUninstalled: boolean;
  /** Refresh-token expiry of an expiring session; for the "expires in < 14 days" warning. */
  refreshTokenExpires: Date | null;
}

function ts(d: Date | null | undefined): number | null {
  if (!(d instanceof Date)) return null;
  const t = d.getTime();
  return Number.isNaN(t) ? null : t;
}

function isBlockState(v: string | null | undefined): v is ConnectionBlockState {
  return v === "needs_reauth" || v === "access_denied" || v === "shop_not_found";
}

/** Has a webhook with a valid signature arrived clearly AFTER the shop was marked uninstalled? */
export function hasWebhookAfterUninstall(install: ConnectionInstallFacts | null): boolean {
  const un = ts(install?.uninstalledAt);
  const wh = ts(install?.lastWebhookAt);
  return un !== null && wh !== null && wh > un + WEBHOOK_AFTER_UNINSTALL_GRACE_MS;
}

/**
 * "Presumably uninstalled": the shop has been blocked for at least 30 days (7 for
 * a 404), and neither a webhook nor a visit/authentication has been seen since the
 * block began. A shop with no block, or one already marked uninstalled, is never
 * presumed. Without a block start there is no evidence, so the answer is false.
 */
export function isPresumedUninstalled(install: ConnectionInstallFacts | null, now: Date): boolean {
  if (!install || ts(install.uninstalledAt) !== null) return false;
  if (!isBlockState(install.connectionState)) return false;
  const since = ts(install.connectionStateSince);
  if (since === null) return false;
  const window =
    install.connectionState === "shop_not_found"
      ? PRESUMED_UNINSTALLED_AFTER_MS_NOT_FOUND
      : PRESUMED_UNINSTALLED_AFTER_MS;
  if (now.getTime() - since < window) return false;
  for (const seen of [install.lastWebhookAt, install.lastActivityAt, install.lastAuthAt]) {
    const t = ts(seen);
    if (t !== null && t >= since) return false;
  }
  return true;
}

export function deriveConnectionStatus(input: ConnectionStatusInput): ConnectionStatusResult {
  const { now, install, session, migration } = input;
  const nowMs = now.getTime();
  const state = isBlockState(install?.connectionState) ? install!.connectionState : null;
  const blockSince = install?.connectionStateSince ?? null;
  const blockReason = install?.connectionStateReason ?? null;

  const base = {
    webhooksPaused: state !== null,
    droppedWebhookCount: install?.droppedWebhookCount ?? 0,
    resyncRequiredSince: install?.resyncRequiredSince ?? null,
    webhooksAfterUninstall: hasWebhookAfterUninstall(install),
    presumedUninstalled: isPresumedUninstalled(install, now),
    refreshTokenExpires: session?.refreshTokenExpires ?? null,
  };
  const result = (
    status: ConnectionStatus,
    reason: string | null,
    since: Date | null,
  ): ConnectionStatusResult => ({ status, reason, since, ...base });

  if (ts(install?.uninstalledAt) !== null) {
    return result("uninstalled", install?.uninstallSource ? `uninstalled_${install.uninstallSource}` : "uninstalled", install!.uninstalledAt ?? null);
  }
  if (state === "shop_not_found") return result("shop_not_found", blockReason, blockSince);
  if (state === "access_denied") return result("access_denied", blockReason, blockSince);

  // needs_reauth: the recorded block, or the evidence in the session/migration
  // itself (an empty token, an expired refresh token, a refused migration) for a
  // shop the sweep has not recorded yet.
  if (state === "needs_reauth") return result("needs_reauth", blockReason, blockSince);
  if (session?.tokenEmpty) return result("needs_reauth", "no_token", null);
  const refreshExpiry = ts(session?.refreshTokenExpires);
  if (session?.hasRefreshToken && refreshExpiry !== null && refreshExpiry <= nowMs) {
    return result("needs_reauth", "refresh_token_expired", session.refreshTokenExpires ?? null);
  }
  if (migration?.status === "needs_reauth") {
    return result("needs_reauth", "invalid_subject_token", migration.failureKindSince ?? null);
  }

  if (migration?.status === "failed" && migration.attempts >= MIGRATION_GAVE_UP_ATTEMPTS) {
    return result("migration_gave_up", migration.failureKind ?? "migration_failed", migration.failureKindSince ?? null);
  }
  if (migration && (migration.status === "failed" || (migration.status === "pending" && migration.attempts > 0))) {
    return result("failing_transiently", migration.failureKind ?? "migration_failed", migration.failureKindSince ?? null);
  }

  if (session) {
    return session.hasRefreshToken
      ? result("valid_expiring", null, null)
      : result("valid_non_expiring", null, null);
  }
  return result("no_session", null, null);
}
