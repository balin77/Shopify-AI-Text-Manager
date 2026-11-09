/**
 * products/collections webhooks: signature-only auth (the library and its token
 * refresh are never called), and the quiet path for a blocked shop.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";

const h = vi.hoisted(() => ({
  libAuth: vi.fn(async () => { throw new Error("library must not be called"); }),
  block: vi.fn<(shop: string) => Promise<any>>(async () => null),
  noteDropped: vi.fn(async () => undefined),
  seen: vi.fn(async () => undefined),
  createAdmin: vi.fn<(shop: string) => Promise<any>>(async () => ({ graphql: vi.fn() })),
  syncProduct: vi.fn(async () => undefined),
  deleteProduct: vi.fn(async () => undefined),
  syncCollection: vi.fn(async () => undefined),
  deleteCollection: vi.fn(async () => undefined),
  logCreate: vi.fn(async () => ({ id: "log1" })),
  logUpdate: vi.fn(async () => ({})),
  scheduleRetry: vi.fn(async () => undefined),
}));

vi.mock("~/shopify.server", async () => {
  await import("@shopify/shopify-api/adapters/web-api");
  const { shopifyApi, LogSeverity, ApiVersion } = await import("@shopify/shopify-api");
  const api = shopifyApi({
    apiKey: "k", apiSecretKey: "test-secret", apiVersion: ApiVersion.October25, scopes: ["read_products"],
    hostName: "app.example.com", hostScheme: "https", isEmbeddedApp: true, logger: { level: LogSeverity.Error },
  });
  return { validateWebhookRequest: (a: any) => api.webhooks.validate(a), authenticate: { webhook: h.libAuth } };
});
vi.mock("~/utils/logger.server", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("~/utils/shop-connection-state.server", async (orig) => ({
  ...(await orig<typeof import("~/utils/shop-connection-state.server")>()),
  getConnectionBlock: h.block,
  noteDroppedWebhook: h.noteDropped,
  recordWebhookSeen: h.seen,
}));
vi.mock("../../app/db.server", () => ({
  db: { webhookLog: { create: h.logCreate, update: h.logUpdate } },
}));
vi.mock("../../app/utils/admin-client.server", () => ({ createAdminClientFromShop: h.createAdmin }));
vi.mock("../../app/services/webhook-retry.service", () => ({ webhookRetryService: { scheduleRetry: h.scheduleRetry } }));
vi.mock("../../app/services/product-sync.service", () => ({
  ProductSyncService: class { syncProduct = h.syncProduct; deleteProduct = h.deleteProduct; },
}));
vi.mock("../../app/services/content-sync.service", () => ({
  ContentSyncService: class { syncCollection = h.syncCollection; deleteCollection = h.deleteCollection; },
}));
vi.mock("../../app/services/seo/index-now.service", () => ({
  getEnabledConfig: async () => null, enqueueResource: vi.fn(), shouldEnqueueProductChange: () => false,
}));

import { action as productsAction } from "~/routes/webhooks.products";
import { action as collectionsAction } from "~/routes/webhooks.collections";
import { logger } from "~/utils/logger.server";

const SHOP = "blocked.myshopify.com";
const sign = (body: string, secret = "test-secret") => createHmac("sha256", secret).update(body, "utf8").digest("base64");
function req(topic: string, secret = "test-secret") {
  const body = JSON.stringify({ id: 42 });
  return new Request("https://app.example.com/webhooks/x", {
    method: "POST",
    body,
    headers: {
      "x-shopify-hmac-sha256": sign(body, secret),
      "x-shopify-topic": topic,
      "x-shopify-shop-domain": SHOP,
      "x-shopify-api-version": "2025-10",
      "x-shopify-webhook-id": "w1",
      "content-type": "application/json",
    },
  });
}
// `data()` answers a DataWithResponseInit ({ init: { status } }), not a Response.
const run = async (a: any, r: Request): Promise<{ status: number }> => {
  const out = await a({ request: r, params: {}, context: {} } as never);
  return { status: out?.init?.status ?? out?.status };
};
// Background processing starts with dynamic imports (slow on the first run).
const flush = () => new Promise((r) => setTimeout(r, 300));
const BLOCK = { state: "needs_reauth", reason: "admin_api_401", since: new Date() };

beforeEach(() => {
  vi.clearAllMocks();
  h.block.mockResolvedValue(null);
});

describe.each([
  ["products", productsAction, "products", h.syncProduct, h.deleteProduct],
  ["collections", collectionsAction, "collections", h.syncCollection, h.deleteCollection],
] as const)("webhooks.%s", (_n, action, res, sync, del) => {
  it("valid signature: 200, processing runs, library never called", async () => {
    const r = await run(action, req(`${res}/update`));
    expect(r.status).toBe(200);
    await flush();
    expect(h.libAuth).not.toHaveBeenCalled();
    expect(h.seen).toHaveBeenCalledWith(SHOP, null);
    expect(h.createAdmin).toHaveBeenCalledWith(SHOP);
    expect(sync).toHaveBeenCalled();
    expect(h.logCreate).toHaveBeenCalled();
  });

  it("bad signature: 401 and nothing runs", async () => {
    await expect(run(action, req(`${res}/update`, "wrong"))).rejects.toMatchObject({ status: 401 });
    expect(h.logCreate).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it("blocked shop, update: 200, counted, no Admin call, no log row, no retry", async () => {
    h.block.mockResolvedValue(BLOCK);
    const r = await run(action, req(`${res}/update`));
    expect(r.status).toBe(200);
    await flush();
    expect(h.noteDropped).toHaveBeenCalledWith(SHOP);
    expect(h.createAdmin).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    expect(h.logCreate).not.toHaveBeenCalled();
    expect(h.scheduleRetry).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("blocked shop, delete: applied locally without an Admin client", async () => {
    h.block.mockResolvedValue(BLOCK);
    const r = await run(action, req(`${res}/delete`));
    expect(r.status).toBe(200);
    await flush();
    expect(del).toHaveBeenCalled();
    expect(h.createAdmin).not.toHaveBeenCalled();
    expect(h.noteDropped).not.toHaveBeenCalled();
    expect(h.logUpdate).toHaveBeenCalledWith({ where: { id: "log1" }, data: { processed: true } });
    expect(h.scheduleRetry).not.toHaveBeenCalled();
  });

  it("blocked while processing: counted quietly, no error row, no retry", async () => {
    h.createAdmin.mockRejectedValueOnce(
      Object.assign(new Error("Shopify 401: blocked"), { code: "SHOP_CONNECTION_BLOCKED" }),
    );
    const r = await run(action, req(`${res}/update`));
    expect(r.status).toBe(200);
    await flush();
    expect(h.noteDropped).toHaveBeenCalledWith(SHOP);
    expect(h.scheduleRetry).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(h.logUpdate).toHaveBeenCalledWith({ where: { id: "log1" }, data: { processed: true } });
  });
});
