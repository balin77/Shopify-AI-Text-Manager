import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";

const h = vi.hoisted(() => ({
  libAuth: vi.fn<(r: Request) => Promise<any>>(),
  sync: vi.fn(async () => "free"),
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
vi.mock("~/services/billing.server", () => ({ checkAndSyncSubscription: h.sync }));
vi.mock("~/utils/shop-connection-state.server", () => ({ recordWebhookSeen: vi.fn(async () => undefined) }));

import { action } from "~/routes/webhooks.subscription";
import { logger } from "~/utils/logger.server";

const SHOP = "s.myshopify.com";
function req(secret = "test-secret") {
  const body = JSON.stringify({ app_subscription: { admin_graphql_api_id: "x" } });
  return new Request("https://app.example.com/webhooks/subscription", {
    method: "POST",
    body,
    headers: {
      "x-shopify-hmac-sha256": createHmac("sha256", secret).update(body, "utf8").digest("base64"),
      "x-shopify-topic": "app_subscriptions/update",
      "x-shopify-shop-domain": SHOP,
      "x-shopify-api-version": "2025-10",
      "x-shopify-webhook-id": "w1",
      "content-type": "application/json",
    },
  });
}
const run = (r: Request) => action({ request: r, params: {}, context: {} } as never) as Promise<Response>;

beforeEach(() => vi.clearAllMocks());

describe("webhooks.subscription", () => {
  it("happy path: library admin is used and the subscription is synced", async () => {
    const admin = { graphql: vi.fn() };
    h.libAuth.mockImplementation(async (r) => {
      await r.text(); // the body must still be readable after our clone
      return { topic: "APP_SUBSCRIPTIONS_UPDATE", shop: SHOP, admin };
    });
    const r = await run(req());
    expect(r.status).toBe(200);
    expect(h.sync).toHaveBeenCalledWith(admin, SHOP);
  });

  it("refresh failure after a valid signature: 200 with a warn, nothing synced", async () => {
    h.libAuth.mockRejectedValue(new Error("refresh failed"));
    const r = await run(req());
    expect(r.status).toBe(200);
    expect(h.sync).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("sync deferred"), expect.objectContaining({ shop: SHOP }));
  });

  it("bad signature: 401, the library is never asked", async () => {
    await expect(run(req("wrong"))).rejects.toMatchObject({ status: 401 });
    expect(h.libAuth).not.toHaveBeenCalled();
    expect(h.sync).not.toHaveBeenCalled();
  });
});
