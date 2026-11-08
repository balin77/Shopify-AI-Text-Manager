/**
 * authenticateWebhookTolerant: a failed signature stays a refusal; a valid
 * signature whose session step throws (tokens revoked after uninstall) still
 * reaches the cleanup.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  authWebhook: vi.fn(),
  validate: vi.fn(),
  uninstallCleanup: vi.fn(),
}));

vi.mock("~/shopify.server", () => ({
  validateWebhookRequest: h.validate,
  authenticate: { webhook: h.authWebhook },
}));
vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("~/db.server", () => ({
  db: {
    session: { deleteMany: vi.fn(async () => { h.uninstallCleanup(); return { count: 1 }; }) },
    shopInstallState: { upsert: vi.fn(async () => ({})) },
    aISettings: { updateMany: vi.fn(async () => ({ count: 0 })) },
  },
}));
vi.mock("~/services/sync-scheduler.service", () => ({
  syncScheduler: { isShopActive: () => false, stopSyncForShop: vi.fn() },
}));
vi.mock("~/utils/offline-admin.server", () => ({
  invalidateOfflineAdmin: vi.fn(),
  forgetOfflineTokenMigration: vi.fn(async () => {}),
}));

import { authenticateWebhookTolerant } from "~/utils/webhook-auth.server";
import { action as uninstalled } from "~/routes/webhooks.app-uninstalled";

const req = (method = "POST") =>
  new Request("https://x/webhooks", { method, body: method === "POST" ? JSON.stringify({ id: 1 }) : undefined });

const validCheck = { valid: true, domain: "gone.myshopify.com", topic: "APP_UNINSTALLED", webhookId: "w1" };

beforeEach(() => vi.clearAllMocks());

describe("authenticateWebhookTolerant", () => {
  it("passes the library result through when everything works", async () => {
    h.authWebhook.mockResolvedValue({ shop: "a.myshopify.com", topic: "X", payload: { a: 1 }, webhookId: "w" });
    const ctx = await authenticateWebhookTolerant(req());
    expect(ctx).toMatchObject({ shop: "a.myshopify.com", tolerated: false });
    expect(h.validate).not.toHaveBeenCalled();
  });

  it("keeps a bad signature a 401 and never tolerates it", async () => {
    h.authWebhook.mockRejectedValue(new Response(undefined, { status: 401 }));
    h.validate.mockResolvedValue({ valid: false, reason: "invalid_hmac" });
    await expect(authenticateWebhookTolerant(req())).rejects.toMatchObject({ status: 401 });
  });

  it("refuses when the library errors but the independent check fails", async () => {
    h.authWebhook.mockRejectedValue(new Error("boom"));
    h.validate.mockResolvedValue({ valid: false, reason: "invalid_hmac" });
    await expect(authenticateWebhookTolerant(req())).rejects.toMatchObject({ status: 401 });
  });

  it("does not tolerate a non-POST request", async () => {
    h.authWebhook.mockRejectedValue(new Response(undefined, { status: 405 }));
    await expect(authenticateWebhookTolerant(req("GET"))).rejects.toMatchObject({ status: 405 });
    expect(h.validate).not.toHaveBeenCalled();
  });

  it("continues with the verified data when only the session step throws", async () => {
    h.authWebhook.mockRejectedValue(new Response("refresh failed", { status: 500 }));
    h.validate.mockResolvedValue(validCheck);
    const ctx = await authenticateWebhookTolerant(req());
    expect(ctx).toMatchObject({ shop: "gone.myshopify.com", topic: "APP_UNINSTALLED", payload: { id: 1 }, tolerated: true });
  });
});

describe("app/uninstalled with a failing session step", () => {
  it("runs the cleanup and answers 200", async () => {
    h.authWebhook.mockRejectedValue(new Error("token refresh failed"));
    h.validate.mockResolvedValue(validCheck);
    const res = (await uninstalled({ request: req() } as never)) as Response;
    expect(res.status).toBe(200);
    expect(h.uninstallCleanup).toHaveBeenCalled();
  });

  it("answers 401 and does no cleanup for a bad signature", async () => {
    h.authWebhook.mockRejectedValue(new Response(undefined, { status: 401 }));
    h.validate.mockResolvedValue({ valid: false, reason: "invalid_hmac" });
    await expect(uninstalled({ request: req() } as never)).rejects.toMatchObject({ status: 401 });
    expect(h.uninstallCleanup).not.toHaveBeenCalled();
  });
});
