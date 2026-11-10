// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  verified: { shop: "a.myshopify.com", topic: "app/uninstalled", webhookId: "w", payload: {} } as Record<string, unknown>,
  lastAuthAt: null as Date | null,
  findFails: false,
  mark: vi.fn(async (..._a: unknown[]) => true),
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));
vi.mock("~/utils/webhook-auth.server", () => ({ verifyWebhookRequest: async () => h.verified }));
vi.mock("~/db.server", () => ({
  db: {
    shopInstallState: {
      findUnique: async () => {
        if (h.findFails) throw new Error("db down");
        return h.lastAuthAt ? { lastAuthAt: h.lastAuthAt } : null;
      },
    },
  },
}));
vi.mock("~/services/shop-uninstall.server", () => ({ markShopUninstalled: (...a: unknown[]) => h.mark(...a) }));
vi.mock("~/utils/logger.server", () => ({ logger: { warn: h.warn, info: h.info, error: h.error, debug: vi.fn() } }));

import { action } from "~/routes/webhooks.app-uninstalled";
import { isStaleUninstall, isUninstallTopic, payloadMatchesShop } from "~/services/uninstall-webhook-guard.shared";

const call = (headers: Record<string, string> = {}) =>
  action({ request: new Request("https://x/webhooks", { method: "POST", headers }) } as never) as Promise<Response>;

beforeEach(() => {
  h.mark.mockClear();
  h.warn.mockClear();
  h.info.mockClear();
  h.error.mockClear();
  h.lastAuthAt = null;
  h.findFails = false;
  h.verified = { shop: "a.myshopify.com", topic: "app/uninstalled", webhookId: "w", payload: { myshopify_domain: "a.myshopify.com" } };
});

describe("guard helpers", () => {
  it("normalises the topic", () => {
    expect(isUninstallTopic("app/uninstalled")).toBe(true);
    expect(isUninstallTopic("APP_UNINSTALLED")).toBe(true);
    expect(isUninstallTopic("shop/redact")).toBe(false);
    expect(isUninstallTopic(undefined)).toBe(false);
  });
  it("matches payload shop, domain only as fallback", () => {
    expect(payloadMatchesShop({ myshopify_domain: "A.myshopify.com" }, "a.myshopify.com")).toBe(true);
    expect(payloadMatchesShop({ myshopify_domain: "b.myshopify.com", domain: "a.myshopify.com" }, "a.myshopify.com")).toBe(false);
    expect(payloadMatchesShop({ domain: "a.myshopify.com" }, "a.myshopify.com")).toBe(true);
    expect(payloadMatchesShop({}, "a.myshopify.com")).toBe(false);
  });
  it("stale only when the header is valid and older than the sign-in", () => {
    const auth = new Date("2026-11-01T10:00:00Z");
    expect(isStaleUninstall("2026-11-01T09:00:00Z", auth)).toBe(true);
    expect(isStaleUninstall("2026-11-01T11:00:00Z", auth)).toBe(false);
    expect(isStaleUninstall(null, auth)).toBe(false);
    expect(isStaleUninstall("garbage", auth)).toBe(false);
    expect(isStaleUninstall("2026-11-01T09:00:00Z", null)).toBe(false);
    // within the 5 s clock-skew margin: not stale
    expect(isStaleUninstall("2026-11-01T09:59:56Z", auth)).toBe(false);
    expect(isStaleUninstall("2026-11-01T09:59:54Z", auth)).toBe(true);
  });
});

describe("app/uninstalled route", () => {
  it("marks the shop on a matching delivery", async () => {
    expect((await call()).status).toBe(200);
    expect(h.mark).toHaveBeenCalledWith("a.myshopify.com", { source: "webhook" });
  });
  it("answers 200 and touches nothing for a wrong topic", async () => {
    h.verified.topic = "products/update";
    expect((await call()).status).toBe(200);
    expect(h.mark).not.toHaveBeenCalled();
    expect(h.error).toHaveBeenCalled();
  });
  it("answers 200 and touches nothing when the payload names another shop", async () => {
    h.verified.payload = { myshopify_domain: "victim.myshopify.com" };
    expect((await call()).status).toBe(200);
    expect(h.mark).not.toHaveBeenCalled();
    expect(h.error).toHaveBeenCalled();
  });
  it("skips a delivery older than the last sign-in with one info line", async () => {
    h.lastAuthAt = new Date("2026-11-01T10:00:00Z");
    expect((await call({ "x-shopify-triggered-at": "2026-11-01T09:00:00Z" })).status).toBe(200);
    expect(h.mark).not.toHaveBeenCalled();
    expect(h.info).toHaveBeenCalledTimes(1);
  });
  it("honours the verified triggeredAt and the Events-style header name", async () => {
    h.lastAuthAt = new Date("2026-11-01T10:00:00Z");
    h.verified.triggeredAt = "2026-11-01T09:00:00Z";
    await call();
    expect(h.mark).not.toHaveBeenCalled();
    delete h.verified.triggeredAt;
    await call({ "shopify-triggered-at": "2026-11-01T09:00:00Z" });
    expect(h.mark).not.toHaveBeenCalled();
  });
  it("logs a topic or shop mismatch at error level", async () => {
    h.verified.topic = "products/update";
    await call();
    expect(h.error).toHaveBeenCalled();
  });
  it("keeps current behaviour for a newer, missing or invalid header and a failed read", async () => {
    h.lastAuthAt = new Date("2026-11-01T10:00:00Z");
    await call({ "x-shopify-triggered-at": "2026-11-01T11:00:00Z" });
    await call();
    await call({ "x-shopify-triggered-at": "nope" });
    h.findFails = true;
    await call({ "x-shopify-triggered-at": "2026-11-01T09:00:00Z" });
    expect(h.mark).toHaveBeenCalledTimes(4);
  });
});
