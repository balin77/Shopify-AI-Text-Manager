/**
 * Client-safe half of the /admin shop overview (PLAN_ADMIN_SHOP_OVERVIEW 3.3-3.5):
 * the row shape the loader sends, and the pure filter / sort / format helpers
 * the table runs in component scope.
 *
 * Imports only the (itself import-free) status module. Nothing here reads a
 * clock: relative ages are computed against the LOADER's `now`, so the server
 * render and the hydrating client produce the same text. Sorting uses `<`,
 * never `localeCompare` without a locale.
 */

import {
  compareShopStatus,
  NON_EXPIRING_DEAD_FROM,
  type ShopStatusColor,
} from "./shop-status.shared";
import type { ConnectionStatus } from "../shop-connection-status.shared";

export interface OverviewStatus {
  color: ShopStatusColor;
  colorLabel: string;
  tokenStatus: ConnectionStatus;
  tokenLabel: string;
  reasons: string[];
  lastOpenedMs: number | null;
}

export interface WebhookCounts {
  total: number;
  failed: number;
}

export interface ShopRow {
  shop: string;
  plan: string;
  devForcedPlan: string | null;
  products: number;
  collections: number;
  articles: number;
  pages: number;
  tasks: number;
  hasSession: boolean;
  uninstalledAt: string | null;
  initialSyncCompletedAt: string | null;
  /** Known only from the webhook log: no install row, no session, no settings. */
  onlyInWebhookLog: boolean;
  status: OverviewStatus;
  /** ISO instant of "last opened" (latest of visit and sign-in), or null = unknown. */
  lastOpenedAt: string | null;
  /** The visit time is the one-off backfill from the old session column: approximate. */
  lastOpenedApprox: boolean;
  lastActionAt: string | null;
  lastActionArea: string | null;
  /** Days with at least one active 5-minute window, last 7 / 30 UTC days. */
  activeDays7: number;
  activeDays30: number;
  actions7: number;
  actions30: number;
  tasks7: number;
  tasks30: number;
  tasksFailed7: number;
  tasksFailed30: number;
  /** What the AI cost us this / last calendar month (micro-euro). Approximate: see the loader. */
  aiCostMicrosMonth: number;
  aiCostMicrosLastMonth: number;
  imageOpsMonth: number;
  imageOpsLastMonth: number;
  webhooks24h: WebhookCounts;
  webhooksPaused: boolean;
  droppedWebhooks: number;
  retriesPending: number;
  lastTask: { type: string; status: string; at: string } | null;
}

export interface OverviewHeader {
  webhooks24h: WebhookCounts;
  /** Managed-AI spend of the current calendar month over both pools (micro-euro). */
  managedAiCostMicrosMonth: number;
}

export interface AuditRow {
  id: string;
  shop: string;
  requestType: string;
  status: string;
  requestedAt: string;
  completedAt: string;
}

export interface TimelineEntry {
  at: string;
  kind: string;
  text: string;
}

export interface UsageDayView {
  day: string;
  activeSlots: number;
  actions: number;
  tasksStarted: number;
  tasksFailed: number;
}

/** Everything the detail view shows; loaded per shop on click. No customer data. */
export interface ShopDetail {
  shop: string;
  now: string;
  status: OverviewStatus;
  storageMB: number;
  facts: Array<{ label: string; value: string }>;
  usage: UsageDayView[];
  timeline: TimelineEntry[];
}

// Loaded only on click (GET /admin?audit=<id>), never with the page: it holds
// the customer e-mail and the full data_request export (R5-G1: the export must
// stay retrievable so the request can be fulfilled).
export interface AuditDetail {
  id: string;
  shop: string;
  customerEmail: string | null;
  error: string | null;
  dataExported: string | null;
  webhookId: string | null;
}

// ---- filtering and sorting (client side, no loader re-run) ---------------

export interface ShopFilters {
  query: string;
  color: ShopStatusColor | null;
  onlyInstalled: boolean;
  onlyPaid: boolean;
  onlyTokenProblem: boolean;
}

export const NO_FILTERS: ShopFilters = {
  query: "",
  color: null,
  onlyInstalled: false,
  onlyPaid: false,
  onlyTokenProblem: false,
};

const PROBLEM_TOKEN: ReadonlySet<ConnectionStatus> = new Set([
  "shop_not_found",
  "access_denied",
  "needs_reauth",
  "migration_gave_up",
  "failing_transiently",
]);

/** Shopify stops accepting non-expiring offline tokens on this date (UTC); mirrors the red rule of the status module. */

export const isTokenProblem = (row: Pick<ShopRow, "status">, nowMs: number): boolean =>
  PROBLEM_TOKEN.has(row.status.tokenStatus) ||
  (row.status.tokenStatus === "valid_non_expiring" && nowMs >= NON_EXPIRING_DEAD_FROM);
export const isInstalledRow = (row: Pick<ShopRow, "uninstalledAt" | "onlyInWebhookLog">): boolean =>
  row.uninstalledAt === null && !row.onlyInWebhookLog;
export const isPaidPlan = (plan: string): boolean => plan === "basic" || plan === "pro" || plan === "max";

export function filterRows(rows: ShopRow[], f: ShopFilters, nowMs: number): ShopRow[] {
  const q = f.query.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (q === "" || r.shop.toLowerCase().includes(q)) &&
      (f.color === null || r.status.color === f.color) &&
      (!f.onlyInstalled || isInstalledRow(r)) &&
      (!f.onlyPaid || isPaidPlan(r.plan)) &&
      (!f.onlyTokenProblem || isTokenProblem(r, nowMs)),
  );
}

export type SortKey =
  | "status"
  | "shop"
  | "lastOpened"
  | "activeDays30"
  | "actions30"
  | "tasks30"
  | "ai"
  | "images"
  | "webhooks"
  | "plan"
  | "content";
export type SortDir = "asc" | "desc";

const numericKey: Partial<Record<SortKey, (r: ShopRow) => number>> = {
  activeDays30: (r) => r.activeDays30,
  actions30: (r) => r.actions30,
  tasks30: (r) => r.tasks30,
  ai: (r) => r.aiCostMicrosMonth,
  images: (r) => r.imageOpsMonth,
  webhooks: (r) => r.webhooks24h.total,
  content: (r) => r.products + r.collections + r.articles + r.pages,
};

/** Returns a new array. "status" is the plan's own order (red, yellow, green, grey, then most recently opened). */
export function sortRows(rows: ShopRow[], key: SortKey, dir: SortDir): ShopRow[] {
  const sign = dir === "asc" ? 1 : -1;
  const byShop = (a: ShopRow, b: ShopRow) => (a.shop < b.shop ? -1 : a.shop > b.shop ? 1 : 0);
  const out = [...rows];
  out.sort((a, b) => {
    if (key === "status") return sign * compareShopStatus(a, b);
    if (key === "shop") return sign * byShop(a, b);
    if (key === "plan") {
      return a.plan === b.plan ? byShop(a, b) : sign * (a.plan < b.plan ? -1 : 1);
    }
    if (key === "lastOpened") {
      const la = a.status.lastOpenedMs;
      const lb = b.status.lastOpenedMs;
      if (la === lb) return byShop(a, b);
      // Unknown always last, whatever the direction.
      if (la === null) return 1;
      if (lb === null) return -1;
      return sign * (la - lb);
    }
    const num = numericKey[key]!;
    const d = num(a) - num(b);
    return d === 0 ? byShop(a, b) : sign * d;
  });
  return out;
}

export function countByColor(rows: ShopRow[]): Record<ShopStatusColor, number> {
  const c: Record<ShopStatusColor, number> = { red: 0, yellow: 0, green: 0, grey: 0 };
  for (const r of rows) c[r.status.color] += 1;
  return c;
}

// ---- deterministic formatting (same string on server and client) ---------

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "vor 3 Tagen" against the loader's now. Never reads the clock. */
export function relativeAge(thenMs: number | null, nowMs: number): string {
  if (thenMs === null) return "unbekannt";
  const d = nowMs - thenMs;
  if (d < 0) return "gerade eben";
  if (d < MIN) return "gerade eben";
  if (d < HOUR) return `vor ${Math.floor(d / MIN)} Min.`;
  if (d < DAY) return `vor ${Math.floor(d / HOUR)} Std.`;
  const days = Math.floor(d / DAY);
  return days === 1 ? "vor 1 Tag" : `vor ${days} Tagen`;
}

/** UTC stamp "2026-11-09 10:30" - the same on both sides. */
export function utcStamp(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

/** Micro-euro as "1,23 €" (two decimals, comma): fixed format, no Intl. */
export function formatMicros(micros: number): string {
  const cents = Math.round(micros / 10_000);
  const whole = Math.floor(cents / 100);
  const frac = String(cents % 100).padStart(2, "0");
  return `${whole},${frac} €`;
}
