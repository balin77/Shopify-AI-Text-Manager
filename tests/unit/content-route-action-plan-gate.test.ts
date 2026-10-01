/**
 * The content pages' route actions ask the PLAN, not only the UI.
 *
 * `PlanAccessGate` hides a page the plan does not include, but every action is
 * directly POST-reachable: a Free shop could run `updateContent` /
 * `translateAll` on pages, articles, policies, metaobjects and theme groups.
 * `makeContentRouteAction` and `makeThemeContentRouteAction` carry the gate.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const authenticate = { admin: vi.fn() };
vi.mock("~/shopify.server", () => ({ authenticate }));
vi.mock("../../app/shopify.server", () => ({ authenticate }));

const aISettings = { findUnique: vi.fn() };
const aIInstructions = { findUnique: vi.fn(async () => null) };
const dbStub = { aISettings, aIInstructions };
vi.mock("~/db.server", () => ({ db: dbStub, default: dbStub }));
vi.mock("../../app/db.server", () => ({ db: dbStub, default: dbStub }));

const handleUnified = vi.fn(async () => ({ handled: true }));
vi.mock("~/actions/unified-content.actions", () => ({ handleUnifiedContentActions: handleUnified }));
vi.mock("../../app/actions/unified-content.actions", () => ({ handleUnifiedContentActions: handleUnified }));

vi.mock("~/services/theme-selection.server", () => ({
  listThemes: vi.fn(async () => []),
  resolveSelectedThemeId: vi.fn(async () => null),
}));

const { makeContentRouteAction } = await import("~/utils/content-route-action.server");
const { makeThemeContentRouteAction } = await import("~/utils/theme-content-domain.server");

const SHOP = "test.myshopify.com";
const CONFIG = { resourceType: "Page" } as never;

function post(fields: Record<string, string>) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return { method: "POST", formData: async () => body } as unknown as Request;
}

async function run(action: (a: never) => Promise<unknown>, fields: Record<string, string>) {
  const response = (await action({ request: post(fields), params: {}, context: {} } as never)) as {
    data?: Record<string, unknown>;
    init?: { status?: number };
    handled?: boolean;
  };
  return { status: response.init?.status ?? 200, body: response.data ?? response };
}

beforeEach(() => {
  handleUnified.mockClear();
  aISettings.findUnique.mockReset();
  authenticate.admin.mockResolvedValue({ admin: {}, session: { shop: SHOP } });
});

describe("makeContentRouteAction", () => {
  it("refuses with 403 and echoes the posted action when the plan lacks the content type", async () => {
    aISettings.findUnique.mockResolvedValue({ subscriptionPlan: "free" });
    const action = makeContentRouteAction({ config: CONFIG, planContentType: "articles" });
    const { status, body } = await run(action, { action: "translateAll", itemId: "gid://shopify/Article/1" });
    expect(status).toBe(403);
    expect(body).toEqual({ success: false, error: "gated", actionType: "translateAll" });
    expect(handleUnified).not.toHaveBeenCalled();
  });

  it("treats a shop without a settings row as free", async () => {
    aISettings.findUnique.mockResolvedValue(null);
    const action = makeContentRouteAction({ config: CONFIG, planContentType: "metaobjects" });
    expect((await run(action, { action: "updateContent" })).status).toBe(403);
  });

  it("hands over to the unified handler, with the one settings row, when the plan includes it", async () => {
    const settings = { subscriptionPlan: "pro" };
    aISettings.findUnique.mockResolvedValue(settings);
    const action = makeContentRouteAction({ config: CONFIG, planContentType: "articles" });
    await run(action, { action: "updateContent", itemId: "gid://shopify/Article/1" });
    expect(handleUnified).toHaveBeenCalledTimes(1);
    expect((handleUnified.mock.calls[0] as unknown as [{ aiSettings: unknown }])[0].aiSettings).toBe(settings);
    expect(aISettings.findUnique).toHaveBeenCalledTimes(1);
  });

  it("passes through when no content type is given", async () => {
    aISettings.findUnique.mockResolvedValue({ subscriptionPlan: "free" });
    await run(makeContentRouteAction({ config: CONFIG }), { action: "updateContent" });
    expect(handleUnified).toHaveBeenCalledTimes(1);
  });

  it("refuses an action outside allowedActions with 400 before reading any settings", async () => {
    const action = makeContentRouteAction({
      config: CONFIG,
      planContentType: "products",
      allowedActions: new Set(["translateSubResources"]),
    });
    const refused = await run(action, { action: "deleteContent" });
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({ success: false, error: "Unsupported action" });
    expect(aISettings.findUnique).not.toHaveBeenCalled();

    aISettings.findUnique.mockResolvedValue({ subscriptionPlan: "free" });
    await run(action, { action: "translateSubResources" });
    expect(handleUnified).toHaveBeenCalledTimes(1);
  });
});

describe("makeThemeContentRouteAction", () => {
  it("refuses a plan without the content type before touching any group", async () => {
    aISettings.findUnique.mockResolvedValue({ subscriptionPlan: "basic" });
    const action = makeThemeContentRouteAction("system", "system");
    const { status, body } = await run(action, { action: "translateAll", itemId: "group_x" });
    expect(status).toBe(403);
    expect(body).toEqual({ success: false, error: "gated", actionType: "translateAll" });
  });

  it("lets an entitled plan through to the handler dispatch", async () => {
    aISettings.findUnique.mockResolvedValue({ subscriptionPlan: "pro" });
    const action = makeThemeContentRouteAction("system", "system");
    // No itemId: the first check after the gate answers 400, proving it passed.
    const { status, body } = await run(action, { action: "translateAll" });
    expect(status).toBe(400);
    expect(body).toEqual({ success: false, error: "groupId is required" });
  });
});
