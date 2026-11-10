/**
 * The /admin shop table: pure filter / sort / format helpers, the interaction
 * of the header area, and the hydration contract (same HTML from a server in one
 * time zone and a browser in another; nothing in the table reads the clock).
 */
import { describe, it, expect, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { ShopOverviewTable } from "~/components/admin/ShopOverviewTable";
import {
  NO_FILTERS,
  countByColor,
  filterRows,
  formatMicros,
  relativeAge,
  sortRows,
  utcStamp,
  type ShopRow,
} from "~/services/admin/shop-overview.shared";
import { computeShopStatus } from "~/services/admin/shop-status.shared";

const NOW = "2026-11-10T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const ago = (d: number) => new Date(NOW_MS - d * 86_400_000);

function row(shop: string, over: Partial<ShopRow> = {}, statusIn: Parameters<typeof computeShopStatus>[0] | null = null): ShopRow {
  const status = computeShopStatus(
    statusIn ?? {
      shop,
      onlyInWebhookLog: false,
      install: { lastActivityAt: ago(1), initialSyncCompletedAt: ago(30) },
      session: { tokenEmpty: false, hasRefreshToken: true, expires: ago(-1), refreshTokenExpires: ago(-60) },
      migration: null,
      webhooks24h: { total: 0, failed: 0 },
    },
    NOW,
  );
  return {
    shop,
    plan: "free",
    devForcedPlan: null,
    products: 1,
    collections: 0,
    articles: 0,
    pages: 0,
    tasks: 0,
    hasSession: true,
    uninstalledAt: null,
    initialSyncCompletedAt: ago(30).toISOString(),
    onlyInWebhookLog: false,
    status: {
      color: status.color,
      colorLabel: status.colorLabel,
      tokenStatus: status.tokenStatus,
      tokenLabel: status.tokenLabel,
      reasons: status.reasons,
      lastOpenedMs: status.lastOpenedMs,
    },
    lastOpenedAt: status.lastOpenedMs === null ? null : new Date(status.lastOpenedMs).toISOString(),
    lastOpenedApprox: false,
    lastActionAt: null,
    lastActionArea: null,
    activeDays7: 2,
    activeDays30: 8,
    actions7: 3,
    actions30: 9,
    tasks7: 1,
    tasks30: 4,
    tasksFailed7: 0,
    tasksFailed30: 0,
    aiCostMicrosMonth: 1_230_000,
    aiCostMicrosLastMonth: 0,
    imageOpsMonth: 0,
    imageOpsLastMonth: 0,
    webhooks24h: { total: 0, failed: 0 },
    webhooksPaused: false,
    droppedWebhooks: 0,
    retriesPending: 0,
    lastTask: null,
    ...over,
  };
}

const reauth = (shop: string) =>
  row(shop, {}, {
    shop,
    onlyInWebhookLog: false,
    install: { lastActivityAt: ago(2), connectionState: "needs_reauth", connectionStateSince: ago(3), initialSyncCompletedAt: ago(30) },
    session: null,
    migration: null,
    webhooks24h: { total: 0, failed: 0 },
  });

const ROWS = [
  row("b.example.test", { plan: "pro" }),
  reauth("a.example.test"),
  row("c.example.test", { uninstalledAt: ago(5).toISOString() }, {
    shop: "c.example.test",
    onlyInWebhookLog: false,
    install: { uninstalledAt: ago(5), lastActivityAt: ago(6) },
    session: null,
    migration: null,
    webhooks24h: { total: 0, failed: 0 },
  }),
  row("d.example.test", { activeDays30: 20 }),
];
const HEADER = { webhooks24h: { total: 12, failed: 2 }, managedAiCostMicrosMonth: 4_560_000 };

describe("filter, sort and format helpers", () => {
  it("filters by search, colour and the three switches", () => {
    expect(filterRows(ROWS, { ...NO_FILTERS, query: " A.EXAMPLE " }, NOW_MS).map((r) => r.shop)).toEqual(["a.example.test"]);
    expect(filterRows(ROWS, { ...NO_FILTERS, color: "red" }, NOW_MS).map((r) => r.shop)).toEqual(["a.example.test"]);
    expect(filterRows(ROWS, { ...NO_FILTERS, onlyInstalled: true }, NOW_MS).map((r) => r.shop)).not.toContain("c.example.test");
    expect(filterRows(ROWS, { ...NO_FILTERS, onlyPaid: true }, NOW_MS).map((r) => r.shop)).toEqual(["b.example.test"]);
    expect(filterRows(ROWS, { ...NO_FILTERS, onlyTokenProblem: true }, NOW_MS).map((r) => r.shop)).toEqual(["a.example.test"]);
  });

  it("token-problem filter also catches a non-expiring token from 2027-01-01", () => {
    const r = row("n.example.test", { status: { ...ROWS[0].status, tokenStatus: "valid_non_expiring" } });
    const f = { ...NO_FILTERS, onlyTokenProblem: true };
    expect(filterRows([r], f, Date.UTC(2026, 11, 31))).toHaveLength(0);
    expect(filterRows([r], f, Date.UTC(2027, 0, 1))).toHaveLength(1);
  });

  it("counts per colour", () => {
    expect(countByColor(ROWS)).toEqual({ red: 1, yellow: 0, green: 2, grey: 1 });
  });

  it("sorts by status (red first), by figures descending and keeps unknown 'last opened' last", () => {
    expect(sortRows(ROWS, "status", "asc")[0].shop).toBe("a.example.test");
    expect(sortRows(ROWS, "activeDays30", "desc")[0].shop).toBe("d.example.test");
    const withUnknown = [...ROWS, row("e.example.test", { status: { ...ROWS[0].status, lastOpenedMs: null } })];
    expect(sortRows(withUnknown, "lastOpened", "asc").at(-1)!.shop).toBe("e.example.test");
    expect(sortRows(withUnknown, "lastOpened", "desc").at(-1)!.shop).toBe("e.example.test");
    expect(ROWS.map((r) => r.shop)).toEqual(["b.example.test", "a.example.test", "c.example.test", "d.example.test"]);
  });

  it("formats deterministically against the loader's now", () => {
    expect(relativeAge(NOW_MS - 3 * 86_400_000, NOW_MS)).toBe("vor 3 Tagen");
    expect(relativeAge(NOW_MS - 5 * 3_600_000, NOW_MS)).toBe("vor 5 Std.");
    expect(relativeAge(null, NOW_MS)).toBe("unbekannt");
    expect(utcStamp("2026-11-09T10:30:59Z")).toBe("2026-11-09 10:30 UTC");
    expect(formatMicros(1_234_567)).toBe("1,23 €");
    expect(formatMicros(5_000)).toBe("0,01 €");
  });
});

const Stub = createRoutesStub([
  { path: "/", Component: () => <ShopOverviewTable rows={ROWS} header={HEADER} now={NOW} /> },
]);

describe("ShopOverviewTable", () => {
  it("shows the header area, a word with every status dot and approximate labels", () => {
    render(<Stub />);
    expect(screen.getByText(/Problem:/)).toBeTruthy();
    expect(screen.getByText(/Managed AI im Monat \(ungefähr\)/)).toBeTruthy();
    expect(screen.getByText("4,56 €")).toBeTruthy();
    expect(screen.getAllByText("Problem").length).toBeGreaterThan(0);
    expect(screen.getByText("KI im Monat (ungefähr)")).toBeTruthy();
  });

  it("a colour counter filters, and the switches are switches, not plain checkboxes", () => {
    render(<Stub />);
    expect(screen.getByText("4 von 4 Shop(s)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Problem/ }));
    expect(screen.getByText("1 von 4 Shop(s)")).toBeTruthy();
    expect(screen.getAllByRole("switch")).toHaveLength(3);
    fireEvent.click(screen.getByLabelText("Nur bezahlt"));
    expect(screen.getByText("Kein Shop passt zu den Filtern.")).toBeTruthy();
  });

  it("renders the same HTML on a server in one time zone and a browser in another", () => {
    const prev = process.env.TZ;
    const effective = Intl.DateTimeFormat().resolvedOptions().timeZone;
    process.env.TZ = "Pacific/Auckland";
    let serverHtml: string;
    try {
      serverHtml = renderToString(<Stub />);
    } finally {
      process.env.TZ = prev ?? effective;
    }
    const container = document.createElement("div");
    container.innerHTML = serverHtml;
    document.body.appendChild(container);
    const onRecoverableError = vi.fn();
    const before = container.innerHTML;
    act(() => {
      hydrateRoot(container, <Stub />, { onRecoverableError });
    });
    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(container.innerHTML).toBe(before);
  });
});
