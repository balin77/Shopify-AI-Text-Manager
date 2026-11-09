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
 * Automatic marking as uninstalled (PLAN_ADMIN_SHOP_OVERVIEW 2.7, default OFF,
 * STALE_INSTALL_AUTO_MARK=true): a block this old with no sign of life. Much
 * longer than the "presumed" window on purpose: marking leads to deletion.
 */
export const AUTO_MARK_AFTER_MS = 90 * DAY_MS;
export const AUTO_MARK_AFTER_MS_NOT_FOUND = 14 * DAY_MS;

/**
 * Exchange attempts after which a token migration is given up on. Mirrors
 * MIGRATION_MAX_ATTEMPTS in offline-token-migration-store.server.ts (this file
 * cannot import it); a unit test pins the two together.
 */
export const MIGRATION_GAVE_UP_ATTEMPTS = 40;

/** A webhook this long after `uninstalledAt` is evidence the shop is still there. */
export const WEBHOOK_AFTER_UNINSTALL_GRACE_MS = 5 * 60 * 1000;

/**
 * A point in time as it arrives: a Date on the server, an ISO string (or epoch
 * ms) once loader data has been serialised to the client. Anything that does not
 * parse is "unknown" (null), never evidence.
 */
export type DateLike = Date | string | number;

/** The ShopInstallState columns the verdict reads. All optional: absent = unknown. */
export interface ConnectionInstallFacts {
  uninstalledAt?: DateLike | null;
  uninstallSource?: string | null;
  reinstallEvidenceAt?: DateLike | null;
  connectionState?: string | null;
  connectionStateSince?: DateLike | null;
  connectionStateReason?: string | null;
  resyncRequiredSince?: DateLike | null;
  droppedWebhookCount?: number | null;
  lastWebhookAt?: DateLike | null;
  lastActivityAt?: DateLike | null;
  lastAuthAt?: DateLike | null;
  /** Last successful Admin API call (probe); evidence for "installed". */
  lastApiOkAt?: DateLike | null;
}

/** The SHAPE of the offline session; never its token. `null` = no offline session row. */
export interface ConnectionSessionFacts {
  /** The stored access token is empty (cleared by a permanent refusal). */
  tokenEmpty: boolean;
  hasRefreshToken: boolean;
  /** Access token expiry; null for a non-expiring token. */
  expires?: DateLike | null;
  refreshTokenExpires?: DateLike | null;
}

/** The OfflineTokenMigration columns the verdict reads (never the encrypted token). */
export interface ConnectionMigrationFacts {
  status: string;
  attempts: number;
  failureKind?: string | null;
  failureKindSince?: DateLike | null;
}

export interface ConnectionStatusInput {
  /** Loader time; a Date or its serialised form. */
  now: DateLike;
  install: ConnectionInstallFacts | null;
  session: ConnectionSessionFacts | null;
  migration: ConnectionMigrationFacts | null;
}

export interface ConnectionStatusResult {
  status: ConnectionStatus;
  /** Machine code of why (a code, never a message); null when nothing is wrong. */
  reason: string | null;
  /** Since when the shop has been in this problem state, when known. */
  since: DateLike | null;
  /** Webhooks of this shop are accepted but not processed (connectionState is set). */
  webhooksPaused: boolean;
  droppedWebhookCount: number;
  resyncRequiredSince: DateLike | null;
  /** uninstalledAt is set although webhooks kept arriving after it (stale install state). */
  webhooksAfterUninstall: boolean;
  /** Blocked for long, with no webhook and no visit since the block began. */
  presumedUninstalled: boolean;
  /** Refresh-token expiry of an expiring session; for the "expires in < 14 days" warning. */
  refreshTokenExpires: DateLike | null;
}

function ts(d: DateLike | null | undefined): number | null {
  if (d === null || d === undefined) return null;
  const t = d instanceof Date ? d.getTime() : typeof d === "number" ? d : typeof d === "string" ? Date.parse(d) : NaN;
  return Number.isFinite(t) ? t : null;
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
 * Does the shop show proof of being installed AFTER it was marked uninstalled?
 * A stored `reinstallEvidenceAt` later than `uninstalledAt`, a signed webhook
 * clearly after it (`hasWebhookAfterUninstall`), or a successful Admin API call
 * clearly after it. The reaper never deletes such a shop (2.7).
 */
export function hasReinstallEvidenceAfterUninstall(install: ConnectionInstallFacts | null): boolean {
  const un = ts(install?.uninstalledAt);
  if (un === null) return false;
  const ev = ts(install?.reinstallEvidenceAt);
  if (ev !== null && ev > un) return true;
  if (hasWebhookAfterUninstall(install)) return true;
  const api = ts(install?.lastApiOkAt);
  return api !== null && api > un + WEBHOOK_AFTER_UNINSTALL_GRACE_MS;
}

/**
 * Blocked for at least `windowMs` (`notFoundWindowMs` for a 404), and no sign of
 * life (webhook, visit, sign-in, API success, reinstall evidence) since the
 * block began. A shop with no block, or one already marked uninstalled, never
 * qualifies; without a block start there is no evidence.
 */
function blockedWithoutLifeSince(
  install: ConnectionInstallFacts | null,
  now: DateLike,
  windowMs: number,
  notFoundWindowMs: number,
): boolean {
  const nowMs = ts(now);
  if (nowMs === null) return false;
  if (!install || ts(install.uninstalledAt) !== null) return false;
  if (!isBlockState(install.connectionState)) return false;
  const since = ts(install.connectionStateSince);
  if (since === null) return false;
  const window = install.connectionState === "shop_not_found" ? notFoundWindowMs : windowMs;
  if (nowMs - since < window) return false;
  for (const seen of [
    install.lastWebhookAt,
    install.lastActivityAt,
    install.lastAuthAt,
    install.lastApiOkAt,
    install.reinstallEvidenceAt,
  ]) {
    const t = ts(seen);
    if (t !== null && t >= since) return false;
  }
  return true;
}

/**
 * "Presumably uninstalled": blocked for at least 30 days (7 for a 404) with no
 * sign of life since. Purely a derived, read-only flag: nothing is deleted or
 * marked because of it.
 */
export function isPresumedUninstalled(install: ConnectionInstallFacts | null, now: DateLike): boolean {
  return blockedWithoutLifeSince(install, now, PRESUMED_UNINSTALLED_AFTER_MS, PRESUMED_UNINSTALLED_AFTER_MS_NOT_FOUND);
}

/** The same with the automatic-marking thresholds: 90 days (14 for a 404). */
export function isStaleAutoMarkCandidate(install: ConnectionInstallFacts | null, now: DateLike): boolean {
  return blockedWithoutLifeSince(install, now, AUTO_MARK_AFTER_MS, AUTO_MARK_AFTER_MS_NOT_FOUND);
}

export function deriveConnectionStatus(input: ConnectionStatusInput): ConnectionStatusResult {
  const { now, install, session, migration } = input;
  const nowMs = ts(now) ?? Date.now();
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
    since: DateLike | null,
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
