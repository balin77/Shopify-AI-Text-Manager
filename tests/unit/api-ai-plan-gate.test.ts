/**
 * /api/ai is directly POST-reachable, so it asks the PLAN for the posted
 * contentType (the same helper the page routes use) before any AI work.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const authenticate = { admin: vi.fn() };
vi.mock("~/shopify.server", () => ({ authenticate }));
vi.mock("../../app/shopify.server", () => ({ authenticate }));

const aISettings = { findUnique: vi.fn() };
const dbStub = { aISettings };
vi.mock("~/db.server", () => ({ db: dbStub, default: dbStub }));
vi.mock("../../app/db.server", () => ({ db: dbStub, default: dbStub }));

const refusalFor = vi.fn(async () => null);
vi.mock("~/utils/ai-refusal-response.server", () => ({
  aiRefusalFor: refusalFor,
  managedRefusalResponseFromError: () => null,
}));
const translateField = vi.fn(async () => ({ handled: true }));
vi.mock("../../app/routes/api-ai-handlers/text-translation.handler", () => ({
  handleTranslateField: translateField,
  handleTranslateFieldToAllLocales: vi.fn(),
}));

const distribute = vi.fn(async () => ({ handled: true }));
vi.mock("../../app/routes/api-ai-handlers/keyword-distribution.handler", () => ({
  handleDistributeKeywords: distribute,
}));

const { action } = await import("../../app/routes/api.ai");

function post(fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return { method: "POST", formData: async () => body } as unknown as Request;
}
async function run(fields: Record<string, string>) {
  const r = (await action({ request: post(fields), params: {}, context: {} } as never)) as {
    data?: Record<string, unknown>;
    init?: { status?: number };
    handled?: boolean;
  };
  return { status: r.init?.status ?? 200, body: r.data ?? r };
}

beforeEach(() => {
  translateField.mockClear();
  refusalFor.mockClear();
  authenticate.admin.mockResolvedValue({ admin: {}, session: { shop: "t.myshopify.com" } });
});

describe("api.ai content-type plan gate", () => {
  it.each(["templates", "metaobjects", "menus", "system"])("refuses %s for a Free shop with 403 and echoes the action", async (contentType) => {
    aISettings.findUnique.mockResolvedValue({ subscriptionPlan: "free" });
    const { status, body } = await run({ action: "translateField", contentType });
    expect(status).toBe(403);
    expect(body).toMatchObject({ success: false, error: "gated", actionType: "translateField" });
    expect(translateField).not.toHaveBeenCalled();
    expect(refusalFor).not.toHaveBeenCalled();
  });

  it("lets a plan with the content type through, echoing action and field to the AI pre-check", async () => {
    aISettings.findUnique.mockResolvedValue({ subscriptionPlan: "pro" });
    const { status } = await run({ action: "translateField", contentType: "templates", fieldType: "title" });
    expect(status).toBe(200);
    expect(translateField).toHaveBeenCalled();
    expect(refusalFor).toHaveBeenCalledWith(expect.anything(), "t.myshopify.com", { actionType: "translateField", fieldType: "title" });
  });

  it("does not gate a shop-level action", async () => {
    aISettings.findUnique.mockResolvedValue({ subscriptionPlan: "free" });
    const { status } = await run({ action: "unknownAction", contentType: "products" });
    expect(status).toBe(400);
  });
});

describe("api.ai gates by the real target, not the posted placeholder", () => {
  beforeEach(() => distribute.mockClear());

  it("refuses insertKeyword on a Page GID for a plan without pages, although contentType says products", async () => {
    aISettings.findUnique.mockResolvedValue({ subscriptionPlan: "free" });
    const { status, body } = await run({ action: "insertKeyword", contentType: "products", itemId: "gid://shopify/Page/1" });
    expect(status).toBe(403);
    expect(body).toMatchObject({ error: "gated", actionType: "insertKeyword" });
  });

  it("refuses seoBulkFix (single and fix-all) for article/page item types on a lower plan", async () => {
    aISettings.findUnique.mockResolvedValue({ subscriptionPlan: "free" });
    for (const itemType of ["article", "page"]) {
      for (const extra of [{} as Record<string, string>, { fixAllForItem: "true" }]) {
        const { status } = await run({ action: "seoBulkFix", contentType: "products", itemType, itemId: "x", ...extra });
        expect(status).toBe(403);
      }
    }
  });

  it("refuses distributeKeywords for a Page target on a lower plan and allows Product", async () => {
    aISettings.findUnique.mockResolvedValue({ subscriptionPlan: "free" });
    const refused = await run({ action: "distributeKeywords", contentType: "products", targetType: "Page" });
    expect(refused.status).toBe(403);
    expect(distribute).not.toHaveBeenCalled();
    const ok = await run({ action: "distributeKeywords", contentType: "products", targetType: "Product" });
    expect(ok.status).toBe(200);
    expect(distribute).toHaveBeenCalled();
  });

  it("allows a plan that includes the type", async () => {
    aISettings.findUnique.mockResolvedValue({ subscriptionPlan: "pro" });
    const { status } = await run({ action: "distributeKeywords", contentType: "products", targetType: "Article" });
    expect(status).toBe(200);
  });
});
