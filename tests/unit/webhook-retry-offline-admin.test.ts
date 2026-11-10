import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const { create, del, deleteMany, update } = vi.hoisted(() => ({
  create: vi.fn(),
  del: vi.fn(),
  deleteMany: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../../app/db.server", () => ({
  db: { webhookRetry: { create, delete: del, deleteMany, update, findMany: vi.fn().mockResolvedValue([]) } },
}));
vi.mock("../../app/utils/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { noteDropped } = vi.hoisted(() => ({ noteDropped: vi.fn(async () => undefined) }));
vi.mock("../../app/utils/shop-connection-state.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/utils/shop-connection-state.server")>()),
  noteDroppedWebhook: noteDropped,
}));

import { OfflineAdminUnavailableError } from "../../app/utils/offline-admin.server";
import { ShopConnectionBlockedError } from "../../app/utils/shop-connection-state.server";
import { logger } from "../../app/utils/logger.server";
import { webhookRetryService } from "../../app/services/webhook-retry.service";

// Same shape as OfflineAdminUnavailableError, built by hand: the service must
// recognise it by `code`, not by class.
function unavailable(reason: string, permanent = reason === "no_token"): Error {
  return Object.assign(new Error("Offline session for example.myshopify.com has no access token"), {
    code: "OFFLINE_ADMIN_UNAVAILABLE",
    reason,
    permanent,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue({ id: "r1", nextRetry: new Date() });
  deleteMany.mockResolvedValue({ count: 3 });
});

afterAll(() => webhookRetryService.stop());

describe("webhook retry: unavailable offline admin is treated like a 401", () => {
  it("schedules no retry row for a no_token error", async () => {
    await webhookRetryService.scheduleRetry("a.myshopify.com", "PRODUCTS_UPDATE", { productId: "1" }, unavailable("no_token"));
    expect(create).not.toHaveBeenCalled();
  });

  it("owes a catch-up when scheduling is skipped for an auth-dead error", async () => {
    await webhookRetryService.scheduleRetry("a.myshopify.com", "PRODUCTS_UPDATE", {}, unavailable("no_token"));
    expect(noteDropped).toHaveBeenCalledWith("a.myshopify.com");
  });

  it("owes a catch-up when the shop's queue is dropped for an auth-dead error", async () => {
    webhookRetryService.registerHandler("TEST_TOPIC_NOTE", async () => {
      throw unavailable("no_token");
    });
    await (webhookRetryService as any).processRetry({
      id: "rn", shop: "a.myshopify.com", topic: "TEST_TOPIC_NOTE", payload: "{}",
      attempt: 0, maxAttempts: 5, nextRetry: new Date(), lastError: null,
    });
    expect(noteDropped).toHaveBeenCalledWith("a.myshopify.com");
  });

  it("schedules no retry row for a terminal refresh failure (permanent flag)", async () => {
    await webhookRetryService.scheduleRetry("a.myshopify.com", "PRODUCTS_UPDATE", { productId: "1" }, unavailable("refresh_failed", true));
    expect(create).not.toHaveBeenCalled();
  });

  it("still schedules a retry for a transient refresh_failed (e.g. a database blip)", async () => {
    await webhookRetryService.scheduleRetry("a.myshopify.com", "PRODUCTS_UPDATE", { productId: "1" }, unavailable("refresh_failed", false));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not purge the shop's queue for a transient refresh_failed", async () => {
    webhookRetryService.registerHandler("TEST_TOPIC3", async () => {
      throw unavailable("refresh_failed", false);
    });
    await (webhookRetryService as any).processRetry({
      id: "r3", shop: "a.myshopify.com", topic: "TEST_TOPIC3", payload: "{}",
      attempt: 0, maxAttempts: 5, nextRetry: new Date(), lastError: null,
    });
    expect(deleteMany).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("works with the real error class: transient refresh_failed retries, terminal ones do not", async () => {
    const transient = new OfflineAdminUnavailableError("a.myshopify.com", "refresh_failed", "refresh failed: HTTP 500");
    const terminal = new OfflineAdminUnavailableError("a.myshopify.com", "refresh_failed", "expired, no refresh token", true);
    const noToken = new OfflineAdminUnavailableError("a.myshopify.com", "no_token", "no token");
    await webhookRetryService.scheduleRetry("a.myshopify.com", "PRODUCTS_UPDATE", {}, transient);
    expect(create).toHaveBeenCalledTimes(1);
    await webhookRetryService.scheduleRetry("a.myshopify.com", "PRODUCTS_UPDATE", {}, terminal);
    await webhookRetryService.scheduleRetry("a.myshopify.com", "PRODUCTS_UPDATE", {}, noToken);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not apply the 401 text patterns to an offline-admin error (shop domain like shop-401)", async () => {
    const err = new OfflineAdminUnavailableError(
      "shop-401.myshopify.com",
      "refresh_failed",
      "Offline token for shop-401.myshopify.com could not be refreshed: HTTP 500",
    );
    await webhookRetryService.scheduleRetry("shop-401.myshopify.com", "PRODUCTS_UPDATE", {}, err);
    expect(create).toHaveBeenCalledTimes(1);
    webhookRetryService.registerHandler("TEST_TOPIC4", async () => {
      throw err;
    });
    await (webhookRetryService as any).processRetry({
      id: "r4", shop: "shop-401.myshopify.com", topic: "TEST_TOPIC4", payload: "{}",
      attempt: 0, maxAttempts: 5, nextRetry: new Date(), lastError: null,
    });
    expect(deleteMany).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("still schedules a retry for a plain non-auth error", async () => {
    await webhookRetryService.scheduleRetry("a.myshopify.com", "PRODUCTS_UPDATE", { productId: "1" }, new Error("socket hang up"));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("deletes the shop's existing retry rows on the next attempt", async () => {
    webhookRetryService.registerHandler("TEST_TOPIC", async () => {
      throw unavailable("no_token");
    });
    const row = {
      id: "r1", shop: "a.myshopify.com", topic: "TEST_TOPIC", payload: "{}",
      attempt: 0, maxAttempts: 5, nextRetry: new Date(), lastError: null,
    };
    await (webhookRetryService as any).processRetry(row);
    expect(deleteMany).toHaveBeenCalledWith({ where: { shop: "a.myshopify.com" } });
    expect(update).not.toHaveBeenCalled();
  });

  it("reschedules (no purge) for a plain non-auth error on retry", async () => {
    webhookRetryService.registerHandler("TEST_TOPIC2", async () => {
      throw new Error("socket hang up");
    });
    const row = {
      id: "r2", shop: "a.myshopify.com", topic: "TEST_TOPIC2", payload: "{}",
      attempt: 0, maxAttempts: 5, nextRetry: new Date(), lastError: null,
    };
    await (webhookRetryService as any).processRetry(row);
    expect(deleteMany).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe("webhook retry: a blocked shop connection is a quiet skip", () => {
  const blocked = () =>
    new ShopConnectionBlockedError("a.myshopify.com", { state: "needs_reauth", since: null, reason: "admin_api_401" });

  it("schedules no retry row and logs nothing above debug", async () => {
    await webhookRetryService.scheduleRetry("a.myshopify.com", "PRODUCTS_UPDATE", { productId: "1" }, blocked());
    expect(create).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(noteDropped).toHaveBeenCalledWith("a.myshopify.com"); // a catch-up is owed
  });

  it("deletes the shop's existing rows on the next attempt, without a warn or error line", async () => {
    webhookRetryService.registerHandler("TEST_BLOCKED", async () => {
      throw blocked();
    });
    await (webhookRetryService as any).processRetry({
      id: "r9", shop: "a.myshopify.com", topic: "TEST_BLOCKED", payload: "{}",
      attempt: 0, maxAttempts: 5, nextRetry: new Date(), lastError: null,
    });
    expect(deleteMany).toHaveBeenCalledWith({ where: { shop: "a.myshopify.com" } });
    expect(update).not.toHaveBeenCalled();
    expect(noteDropped).toHaveBeenCalledWith("a.myshopify.com");
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
