/**
 * PLAN_ADMIN_SHOP_OVERVIEW 2.5: what a 403 from Shopify is, and that it never
 * blocks a shop. Ops alerts run through the REAL ops-alert module with a stubbed
 * fetch, so "at most once per hour" is asserted where it is enforced.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from "~/utils/logger.server";
import { resetOpsAlertThrottle } from "~/services/ops-alert.server";
import {
  FORBIDDEN_WINDOW_MS,
  IP_ALLOWLIST_ALERT_INTERVAL_MS,
  IP_ALLOWLIST_LOG_INTERVAL_MS,
  IP_ALLOWLIST_PAUSE_MS,
  __resetForbiddenForTests,
  classifyForbidden,
  isIpAllowlistPaused,
  noteApiSuccess,
  reportForbidden,
} from "~/utils/shopify-forbidden.server";

const MIN = 60_000;
const forbidden = (msg = "Forbidden") => Object.assign(new Error(msg), { response: { code: 403 } });
const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-09T10:00:00Z"));
  __resetForbiddenForTests();
  resetOpsAlertThrottle();
  vi.mocked(logger.error).mockClear();
  fetchMock.mockReset().mockResolvedValue({ ok: true, status: 204 });
  vi.stubGlobal("fetch", fetchMock);
  process.env.ALERT_WEBHOOK_URL = "https://alerts.example.invalid/hook";
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.ALERT_WEBHOOK_URL;
});

describe("classifyForbidden", () => {
  it("is null for anything that is not a 403", async () => {
    expect(await classifyForbidden("a.myshopify.com", new Error("boom"))).toBeNull();
    expect(await classifyForbidden("a.myshopify.com", { response: { code: 401 } })).toBeNull();
    expect(await classifyForbidden("a.myshopify.com", new Response("{}", { status: 500 }))).toBeNull();
    expect(await classifyForbidden("a.myshopify.com", undefined)).toBeNull();
  });

  it("recognises the non-expiring deadline answer (error and Response)", async () => {
    const text = "Non-expiring access tokens are no longer accepted for the Admin API.";
    expect(await classifyForbidden("a.myshopify.com", forbidden(text))).toBe("non_expiring_rejected");
    expect(await classifyForbidden("a.myshopify.com", new Response(JSON.stringify({ errors: text }), { status: 403 }))).toBe(
      "non_expiring_rejected",
    );
  });

  it("the deadline answer is not an outage signal: it never feeds the several-shops rule", async () => {
    const text = "Non-expiring access tokens are no longer accepted for the Admin API.";
    await classifyForbidden("a.myshopify.com", forbidden(text));
    await classifyForbidden("b.myshopify.com", forbidden(text));
    expect(await classifyForbidden("c.myshopify.com", forbidden("Forbidden"))).toBe("shop_specific");
  });

  it("names the IP allowlist when the text does", async () => {
    expect(await classifyForbidden("a.myshopify.com", forbidden("Access denied: the IP address is not on the allowlist"))).toBe("ip_allowlist");
    expect(await classifyForbidden("a.myshopify.com", new Response(JSON.stringify({ errors: "IP is not in the app's allowlist" }), { status: 403 }))).toBe(
      "ip_allowlist",
    );
  });

  it("a scope 403 or a plain 403 of one shop is shop_specific", async () => {
    expect(await classifyForbidden("a.myshopify.com", forbidden("Access denied for productUpdate field. Required access: write_products"))).toBe("shop_specific");
    expect(await classifyForbidden("a.myshopify.com", forbidden())).toBe("shop_specific");
    // the same shop failing again is still ONE shop
    expect(await classifyForbidden("a.myshopify.com", forbidden())).toBe("shop_specific");
  });

  it("several shops with a 403 and no success elsewhere: ip_allowlist_suspected", async () => {
    expect(await classifyForbidden("a.myshopify.com", forbidden())).toBe("shop_specific");
    expect(await classifyForbidden("b.myshopify.com", forbidden())).toBe("ip_allowlist_suspected");
    expect(await classifyForbidden("a.myshopify.com", forbidden())).toBe("ip_allowlist_suspected");
  });

  it("another shop that succeeded inside the window makes it shop_specific", async () => {
    noteApiSuccess("c.myshopify.com");
    await classifyForbidden("a.myshopify.com", forbidden());
    expect(await classifyForbidden("b.myshopify.com", forbidden())).toBe("shop_specific");
  });

  it("a success of a shop that itself got a 403 proves nothing", async () => {
    noteApiSuccess("a.myshopify.com");
    await classifyForbidden("a.myshopify.com", forbidden());
    expect(await classifyForbidden("b.myshopify.com", forbidden())).toBe("ip_allowlist_suspected");
  });

  it("a success older than the window, or a 403 older than the window, does not count", async () => {
    noteApiSuccess("c.myshopify.com");
    await classifyForbidden("a.myshopify.com", forbidden());
    vi.advanceTimersByTime(FORBIDDEN_WINDOW_MS + MIN);
    // the old success is gone: b and the (renewed) a suspect it
    expect(await classifyForbidden("a.myshopify.com", forbidden())).toBe("shop_specific"); // a's earlier 403 aged out
    expect(await classifyForbidden("b.myshopify.com", forbidden())).toBe("ip_allowlist_suspected");
  });
});

describe("reportForbidden", () => {
  it("shop_specific and the deadline answer do nothing: no line, no alert, no pause", () => {
    reportForbidden("a.myshopify.com", "shop_specific");
    reportForbidden("a.myshopify.com", "non_expiring_rejected");
    expect(logger.error).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isIpAllowlistPaused()).toBe(false);
  });

  it("logs IP_ALLOWLIST_403 at most every 5 minutes and points at the CLAUDE.md note", () => {
    reportForbidden("a.myshopify.com", "ip_allowlist");
    reportForbidden("b.myshopify.com", "ip_allowlist_suspected");
    expect(logger.error).toHaveBeenCalledTimes(1);
    const line = String(vi.mocked(logger.error).mock.calls[0][0]);
    expect(line).toContain("IP_ALLOWLIST_403");
    expect(line).toContain("CLAUDE.md");
    vi.advanceTimersByTime(IP_ALLOWLIST_LOG_INTERVAL_MS + 1000);
    reportForbidden("c.myshopify.com", "ip_allowlist_suspected");
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it("alerts ops at most once an hour", async () => {
    reportForbidden("a.myshopify.com", "ip_allowlist");
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(IP_ALLOWLIST_ALERT_INTERVAL_MS - 2 * MIN);
    reportForbidden("b.myshopify.com", "ip_allowlist_suspected");
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3 * MIN);
    reportForbidden("c.myshopify.com", "ip_allowlist_suspected");
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not name any IP address in the alert", async () => {
    reportForbidden("a.myshopify.com", "ip_allowlist");
    await vi.advanceTimersByTimeAsync(1);
    const body = String(fetchMock.mock.calls[0][1].body);
    expect(body).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
  });

  it("sets a 30-minute global pause that repeats extend and that then ends", () => {
    reportForbidden("a.myshopify.com", "ip_allowlist_suspected");
    expect(isIpAllowlistPaused()).toBe(true);
    vi.advanceTimersByTime(IP_ALLOWLIST_PAUSE_MS - MIN);
    expect(isIpAllowlistPaused()).toBe(true);
    reportForbidden("b.myshopify.com", "ip_allowlist_suspected"); // extends
    vi.advanceTimersByTime(IP_ALLOWLIST_PAUSE_MS - MIN);
    expect(isIpAllowlistPaused()).toBe(true);
    vi.advanceTimersByTime(2 * MIN);
    expect(isIpAllowlistPaused()).toBe(false);
  });
});
