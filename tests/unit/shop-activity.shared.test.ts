import { describe, it, expect } from "vitest";
import { isActionMethod, isPollingPath, pathArea, slotOf, utcDay, ACTIVITY_SLOT_MS } from "../../app/services/shop-activity.shared";

describe("isPollingPath", () => {
  it.each([
    "/api/running-tasks-count",
    "/api/recently-completed-tasks",
    "/api/task-status",
    "/api/task-status.data",
    "/api/sync-status",
    "/api/billing/status",
  ])("%s is polling", (p) => expect(isPollingPath(p)).toBe(true));

  it.each(["/app/products", "/api/task-statuses", "/api/ai", "/app/tasks"])("%s is not", (p) =>
    expect(isPollingPath(p)).toBe(false),
  );
});

describe("isActionMethod", () => {
  it("only GET/HEAD/OPTIONS are not actions", () => {
    expect(["GET", "get", "HEAD", "OPTIONS"].some(isActionMethod)).toBe(false);
    expect(["POST", "PUT", "PATCH", "DELETE"].every(isActionMethod)).toBe(true);
  });
});

describe("pathArea encoded ids", () => {
  it("drops an encoded GID segment and decodes the rest", () => {
    expect(pathArea("/app/products/gid%3A%2F%2Fshopify%2FProduct%2F1")).toBe("app.products");
    expect(pathArea("/app/%E0%A4%A")).toBe("app");
  });
});

describe("pathArea", () => {
  it("keeps the path area only", () => {
    expect(pathArea("/app/products")).toBe("app.products");
    expect(pathArea("/app/products.data")).toBe("app.products");
    expect(pathArea("/api/ai/generate")).toBe("api.ai.generate");
  });
  it("drops id-like segments, caps the depth and never carries a query or hash", () => {
    expect(pathArea("/app/products/123456")).toBe("app.products");
    expect(pathArea("/app/a/b/c/d/e")).toBe("app.a.b");
    expect(pathArea("/app/products?token=secret#x")).toBe("app.products");
    expect(pathArea("/")).toBe("root");
  });
});

describe("slots and days", () => {
  it("slots are 5-minute UTC windows", () => {
    expect(slotOf(0)).toBe(0);
    expect(slotOf(ACTIVITY_SLOT_MS - 1)).toBe(0);
    expect(slotOf(ACTIVITY_SLOT_MS)).toBe(1);
  });
  it("utcDay is 00:00 UTC of the UTC day", () => {
    expect(utcDay(Date.parse("2026-11-09T23:59:59Z")).toISOString()).toBe("2026-11-09T00:00:00.000Z");
  });
});
