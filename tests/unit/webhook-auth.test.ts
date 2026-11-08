/**
 * verifyWebhookRequest: signature-only verification. The validator is the
 * library's REAL one (a shopifyApi instance with a test secret), so the
 * security property - no valid HMAC, no processing - is actually exercised.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";

const h = vi.hoisted(() => ({ cleanup: vi.fn() }));

vi.mock("~/shopify.server", async () => {
  await import("@shopify/shopify-api/adapters/web-api");
  const { shopifyApi, LogSeverity, ApiVersion } = await import("@shopify/shopify-api");
  const api = shopifyApi({
    apiKey: "test-key",
    apiSecretKey: "test-secret",
    apiVersion: ApiVersion.October25,
    scopes: ["read_products"],
    hostName: "app.example.com",
    hostScheme: "https",
    isEmbeddedApp: true,
    logger: { level: LogSeverity.Error },
  });
  return { validateWebhookRequest: (args: any) => api.webhooks.validate(args) };
});
vi.mock("~/utils/logger.server", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("~/db.server", () => ({
  db: {
    session: { deleteMany: vi.fn(async () => { h.cleanup(); return { count: 1 }; }) },
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

import { verifyWebhookRequest } from "~/utils/webhook-auth.server";
import { action as uninstalled } from "~/routes/webhooks.app-uninstalled";

const BODY = JSON.stringify({ id: 1 });
const sign = (body: string, secret = "test-secret") => createHmac("sha256", secret).update(body, "utf8").digest("base64");

function req(opts: { body?: string; signedBody?: string; secret?: string; omit?: string[]; method?: string } = {}) {
  const body = opts.body ?? BODY;
  const headers: Record<string, string> = {
    "x-shopify-hmac-sha256": sign(opts.signedBody ?? body, opts.secret),
    "x-shopify-topic": "app/uninstalled",
    "x-shopify-shop-domain": "gone.myshopify.com",
    "x-shopify-api-version": "2025-10",
    "x-shopify-webhook-id": "w1",
    "content-type": "application/json",
  };
  for (const k of opts.omit ?? []) delete headers[k];
  const method = opts.method ?? "POST";
  return new Request("https://app.example.com/webhooks", { method, headers, body: method === "POST" ? body : undefined });
}

async function status(p: Promise<unknown>): Promise<number | "ok"> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof Response ? e.status : -1;
  }
}

beforeEach(() => vi.clearAllMocks());

describe("verifyWebhookRequest (real HMAC validation)", () => {
  it("accepts a correctly signed request and returns the validated data", async () => {
    const ctx = await verifyWebhookRequest(req());
    expect(ctx).toMatchObject({ shop: "gone.myshopify.com", webhookId: "w1", payload: { id: 1 } });
    expect(ctx.topic).toBeTruthy();
  });

  it("answers 401 when the body was changed by one byte", async () => {
    expect(await status(verifyWebhookRequest(req({ body: JSON.stringify({ id: 2 }), signedBody: BODY })))).toBe(401);
  });

  it("answers 401 for a signature made with the wrong secret", async () => {
    expect(await status(verifyWebhookRequest(req({ secret: "other-secret" })))).toBe(401);
  });

  it("answers 400 when required headers are missing", async () => {
    expect(await status(verifyWebhookRequest(req({ omit: ["x-shopify-topic"] })))).toBe(400);
    expect(await status(verifyWebhookRequest(req({ omit: ["x-shopify-shop-domain"] })))).toBe(400);
  });

  it("answers 405 for a non-POST request", async () => {
    expect(await status(verifyWebhookRequest(req({ method: "GET" })))).toBe(405);
  });
});

describe("app/uninstalled route", () => {
  it("runs the cleanup for a validly signed request without any session step", async () => {
    const res = (await uninstalled({ request: req() } as never)) as Response;
    expect(res.status).toBe(200);
    expect(h.cleanup).toHaveBeenCalled();
  });

  it("refuses an unsigned request with 401 and does no cleanup", async () => {
    expect(await status(uninstalled({ request: req({ secret: "other-secret" }) } as never) as Promise<unknown>)).toBe(401);
    expect(h.cleanup).not.toHaveBeenCalled();
  });
});
