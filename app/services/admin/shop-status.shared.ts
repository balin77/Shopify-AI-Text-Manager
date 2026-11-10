/**
 * Traffic light of one shop on /admin (PLAN_ADMIN_SHOP_OVERVIEW 3.4).
 *
 * ONE pure function, `computeShopStatus(input, now)`: colour, token state and the
 * reasons (German, shown in the tooltip and the detail view). It reads no
 * database and no clock: `now` is the loader's, so server and browser agree.
 *
 * Client-safe: its only import is the sibling read model (itself import-free),
 * the table renders from this module in component scope.
 *
 * Rules, tried IN THIS ORDER (first colour that applies wins; all reasons of
 * that colour are listed):
 *  - grey:   uninstalled and no proof of being installed since (no webhook or call after the mark).
 *  - red:    uninstalled in the database but still alive; installed but presumed
 *            uninstalled / shop gone; an unusable access; 10+ webhook failures
 *            in 24 h AND 50 %+; a shop known only from the webhook log.
 *  - yellow: not opened for 14+ days; refresh token ends within 14 days; a token
 *            migration pending for 24 h+; an access not yet converted from
 *            2026-12-01; single webhook failures; initial sync not completed;
 *            no offline session although installed.
 *  - green:  everything else.
 *
 * Missing data is "unknown", never evidence of a problem, with ONE exception that
 * is stated: an installed shop with no "last opened" at all is yellow (we cannot
 * show it was opened within 14 days).
 */

import {
  deriveConnectionStatus,
  hasReinstallEvidenceAfterUninstall,
  type ConnectionInstallFacts,
  type ConnectionSessionFacts,
  type ConnectionStatus,
  type ConnectionStatusResult,
  type DateLike,
} from "../shop-connection-status.shared";

export type ShopStatusColor = "red" | "yellow" | "green" | "grey";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Yellow: not opened for this long. */
export const STALE_OPENED_AFTER_MS = 14 * DAY_MS;
/** Yellow: the refresh token ends within this window. */
export const REFRESH_EXPIRY_WARN_MS = 14 * DAY_MS;
/** Yellow: a token migration is pending for longer than this. */
export const MIGRATION_PENDING_WARN_MS = 24 * HOUR_MS;
/** Red: at least this many webhook failures in 24 h ... */
export const WEBHOOK_FAIL_RED_MIN = 10;
/** ... and at least this share of the webhooks of those 24 h. */
export const WEBHOOK_FAIL_RED_SHARE = 0.5;
/** Yellow for a token that does not expire yet (not converted) from this date (UTC). */
export const NON_EXPIRING_WARN_FROM = Date.UTC(2026, 11, 1);
/** Shopify stops accepting non-expiring offline tokens on this date (UTC): red from then. */
export const NON_EXPIRING_DEAD_FROM = Date.UTC(2027, 0, 1);

export interface ShopMigrationFacts {
  status: string;
  attempts: number;
  failureKind?: string | null;
  failureKindSince?: DateLike | null;
  startedAt?: DateLike | null;
}

export interface ShopStatusInput {
  shop: string;
  /** Only known from WebhookLog: no install row, no session, no settings. */
  onlyInWebhookLog: boolean;
  install: (ConnectionInstallFacts & { initialSyncCompletedAt?: DateLike | null }) | null;
  session: ConnectionSessionFacts | null;
  migration: ShopMigrationFacts | null;
  /** Webhooks of the last 24 h from WebhookLog. */
  webhooks24h: { total: number; failed: number };
}

export interface ShopStatus {
  color: ShopStatusColor;
  colorLabel: string;
  tokenStatus: ConnectionStatus;
  tokenLabel: string;
  /** German reasons of the winning colour (empty for a plain green). */
  reasons: string[];
  /** Latest of "last opened" and sign-in, epoch ms, null when unknown. */
  lastOpenedMs: number | null;
  connection: ConnectionStatusResult;
}

export const COLOR_LABELS: Record<ShopStatusColor, string> = {
  red: "Problem",
  yellow: "Beobachten",
  green: "In Ordnung",
  grey: "Inaktiv",
};

export const TOKEN_LABELS: Record<ConnectionStatus, string> = {
  uninstalled: "deinstalliert",
  shop_not_found: "Shop nicht gefunden",
  access_denied: "Zugang abgelehnt",
  needs_reauth: "muss sich neu anmelden",
  migration_gave_up: "Umstellung aufgegeben",
  failing_transiently: "Umstellung hakt",
  valid_expiring: "gültig (ablaufend)",
  valid_non_expiring: "gültig (nicht ablaufend)",
  no_session: "keine Session",
};

const BLOCK_REASON_TEXT: Record<string, string> = {
  invalid_subject_token: "Shopify hat den gespeicherten Zugang abgelehnt",
  admin_api_401: "Die Admin API antwortet mit 401",
  no_token: "Kein Zugang gespeichert",
  refresh_token_expired: "Das Refresh-Token ist abgelaufen",
  token_endpoint_403: "Shopify verweigert den Zugang (403)",
  token_endpoint_404: "Shopify kennt den Shop nicht mehr (404)",
};

function ts(d: DateLike | null | undefined): number | null {
  if (d === null || d === undefined) return null;
  const t = d instanceof Date ? d.getTime() : typeof d === "number" ? d : Date.parse(d);
  return Number.isFinite(t) ? t : null;
}

function days(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

function dayStamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Latest of two optional timestamps. */
function latest(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

function blockReasonText(reason: string | null): string {
  if (!reason) return "";
  if (BLOCK_REASON_TEXT[reason]) return `${BLOCK_REASON_TEXT[reason]} (${reason})`;
  // A reason is a CODE by contract. Anything that does not look like one is
  // never echoed into the page.
  return /^[a-z0-9_]{1,48}$/.test(reason) ? reason : "(unbekannter Grund)";
}

export function computeShopStatus(input: ShopStatusInput, now: DateLike): ShopStatus {
  const nowMs = ts(now) ?? 0;
  const { install, session, migration, webhooks24h } = input;

  const connection = deriveConnectionStatus({
    now,
    install,
    session,
    migration: migration
      ? {
          status: migration.status,
          attempts: migration.attempts,
          failureKind: migration.failureKind ?? null,
          failureKindSince: migration.failureKindSince ?? null,
        }
      : null,
  });

  const lastOpenedMs = latest(ts(install?.lastActivityAt), ts(install?.lastAuthAt));
  const uninstalledMs = ts(install?.uninstalledAt);
  const webhookTotal = webhooks24h.total;
  const webhookFailed = webhooks24h.failed;

  const base = (color: ShopStatusColor, reasons: string[]): ShopStatus => ({
    color,
    colorLabel: COLOR_LABELS[color],
    tokenStatus: connection.status,
    tokenLabel: TOKEN_LABELS[connection.status],
    reasons,
    lastOpenedMs,
    connection,
  });

  // ---- grey / red for an uninstall mark ----------------------------------
  if (uninstalledMs !== null) {
    // Webhooks of the last 24 h are NOT evidence: a shop uninstalled an hour ago
    // had them before the uninstall. Only a webhook clearly after the mark counts.
    const alive =
      hasReinstallEvidenceAfterUninstall(install) ||
      connection.webhooksAfterUninstall;
    if (!alive) {
      return base("grey", [`Deinstalliert am ${dayStamp(uninstalledMs)}, seither kein Beleg für eine Installation.`]);
    }
  }

  // ---- red ----------------------------------------------------------------
  const red: string[] = [];
  if (input.onlyInWebhookLog) {
    red.push("Der Shop kommt nur im Webhook-Protokoll vor: keine Installation, keine Session, keine Einstellungen.");
  }
  if (uninstalledMs !== null) {
    red.push(`Laut Datenbank am ${dayStamp(uninstalledMs)} deinstalliert, aber es kommen noch Webhooks oder es gibt Belege für eine Installation.`);
  } else {
    if (connection.status === "shop_not_found") {
      red.push(`Shopify kennt den Shop nicht mehr. ${blockReasonText(connection.reason)}`.trim());
    } else if (connection.status === "access_denied") {
      red.push(`Zugang abgelehnt. ${blockReasonText(connection.reason)}`.trim());
    } else if (connection.status === "needs_reauth") {
      red.push(`Der Händler muss die App öffnen oder neu installieren. ${blockReasonText(connection.reason)}`.trim());
    } else if (connection.status === "migration_gave_up") {
      red.push("Die Umstellung auf den ablaufenden Zugang wurde aufgegeben.");
    }
    if (
      connection.status === "valid_non_expiring" &&
      nowMs >= NON_EXPIRING_DEAD_FROM
    ) {
      red.push("Der nicht ablaufende Zugang wird von Shopify seit 2027-01-01 nicht mehr akzeptiert.");
    }
    if (connection.presumedUninstalled) {
      red.push("Vermutlich deinstalliert, Abgleich ausstehend.");
    }
  }
  if (webhookFailed >= WEBHOOK_FAIL_RED_MIN && webhookTotal > 0 && webhookFailed / webhookTotal >= WEBHOOK_FAIL_RED_SHARE) {
    red.push(`${webhookFailed} von ${webhookTotal} Webhooks der letzten 24 h sind fehlgeschlagen.`);
  }
  if (red.length > 0) return base("red", red);

  // ---- yellow -------------------------------------------------------------
  const yellow: string[] = [];
  if (lastOpenedMs === null) {
    yellow.push("Zuletzt geöffnet: unbekannt.");
  } else if (nowMs - lastOpenedMs > STALE_OPENED_AFTER_MS) {
    yellow.push(`Seit ${days(nowMs - lastOpenedMs)} Tagen nicht geöffnet.`);
  }
  const refreshEnd = ts(session?.refreshTokenExpires);
  if (session?.hasRefreshToken && refreshEnd !== null && refreshEnd > nowMs && refreshEnd - nowMs < REFRESH_EXPIRY_WARN_MS) {
    yellow.push(`Das Refresh-Token läuft in ${Math.max(1, days(refreshEnd - nowMs))} Tag(en) ab.`);
  }
  const migrationStart = ts(migration?.startedAt);
  if (
    migration &&
    migration.status !== "needs_reauth" &&
    (connection.status === "failing_transiently" ||
      (migration.status === "pending" && migrationStart !== null && nowMs - migrationStart > MIGRATION_PENDING_WARN_MS))
  ) {
    const since = ts(migration.failureKindSince) ?? migrationStart;
    yellow.push(
      since !== null && nowMs - since > MIGRATION_PENDING_WARN_MS
        ? `Die Umstellung des Zugangs hängt seit über ${Math.max(1, days(nowMs - since))} Tag(en).`
        : "Die Umstellung des Zugangs läuft noch.",
    );
  }
  if (connection.status === "valid_non_expiring" && nowMs >= NON_EXPIRING_WARN_FROM) {
    yellow.push("Der Zugang ist noch nicht auf ablaufende Tokens umgestellt (Frist 2027-01-01).");
  }
  if (webhookFailed > 0) {
    yellow.push(`${webhookFailed} Webhook-Fehler in den letzten 24 h.`);
  }
  if (connection.status === "no_session") {
    yellow.push("Keine Offline-Session gespeichert.");
  }
  if (install && ts(install.initialSyncCompletedAt) === null && connection.status !== "no_session") {
    yellow.push("Die Erstsynchronisation ist noch nicht abgeschlossen.");
  }
  if (yellow.length > 0) return base("yellow", yellow);

  return base("green", []);
}

const COLOR_RANK: Record<ShopStatusColor, number> = { red: 0, yellow: 1, green: 2, grey: 3 };

/**
 * Sort order of the table: red, yellow, green, grey; inside a colour the most
 * recently opened first (unknown last), then by shop name. Plain `<` on purpose:
 * `localeCompare` without a locale orders differently on server and browser.
 */
export function compareShopStatus(
  a: { shop: string; status: Pick<ShopStatus, "color" | "lastOpenedMs"> },
  b: { shop: string; status: Pick<ShopStatus, "color" | "lastOpenedMs"> },
): number {
  const byColor = COLOR_RANK[a.status.color] - COLOR_RANK[b.status.color];
  if (byColor !== 0) return byColor;
  const la = a.status.lastOpenedMs;
  const lb = b.status.lastOpenedMs;
  if (la !== lb) {
    if (la === null) return 1;
    if (lb === null) return -1;
    return lb - la;
  }
  return a.shop < b.shop ? -1 : a.shop > b.shop ? 1 : 0;
}
