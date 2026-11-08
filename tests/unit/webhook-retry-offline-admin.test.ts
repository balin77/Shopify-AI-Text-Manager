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

import { webhookRetryService } from "../../app/services/webhook-retry.service";

// Same shape as OfflineAdminUnavailableError, built by hand: the service must
// recognise it by `code`, not by class.
function unavailable(reason: string): Error {
  return Object.assign(new Error("Offline session for example.myshopify.com has no access token"), {
    code: "OFFLINE_ADMIN_UNAVAILABLE",
    reason,
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
