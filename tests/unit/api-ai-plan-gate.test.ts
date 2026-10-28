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
const captureServerError = vi.fn();
vi.mock("~/utils/sentry.server", () => ({ captureServerError }));
vi.mock("../../app/utils/sentry.server", () => ({ captureServerError }));

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
const { InvalidAIKeyError, ManagedAiRefusedError, MissingAIKeyError } = await import(
  "../../src/services/ai.service"
);

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
  captureServerError.mockClear();
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

  it("re-throws a Response a handler threw instead of answering a generic 500", async () => {
    aISettings.findUnique.mockResolvedValue({ subscriptionPlan: "pro" });
    const reauth = new Response(null, { status: 401, headers: { "X-Shopify-Retry-Invalid-Session-Request": "1" } });
    translateField.mockRejectedValueOnce(reauth);
    await expect(run({ action: "translateField", contentType: "templates", fieldType: "title" })).rejects.toBe(reauth);
    expect(captureServerError).not.toHaveBeenCalled();
  });

  it("still answers a generic 500 for a non-Response failure", async () => {
    aISettings.findUnique.mockResolvedValue({ subscriptionPlan: "pro" });
    translateField.mockRejectedValueOnce(new Error("boom"));
    const { status } = await run({ action: "translateField", contentType: "templates", fieldType: "title" });
    expect(status).toBe(500);
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

describe("api.ai catch: what a handler failure is answered with", () => {
  const fields = { action: "translateField", contentType: "templates", fieldType: "title" };
  beforeEach(() => {
    aISettings.findUnique.mockResolvedValue({ subscriptionPlan: "pro", appLanguage: "en" });
  });

  it("answers a provider key rejection with 401 INVALID_AI_KEY and does not report it", async () => {
    translateField.mockRejectedValueOnce(new InvalidAIKeyError("401 Incorrect API key provided"));
    const { status, body } = await run(fields);
    expect(status).toBe(401);
    expect(body).toMatchObject({ success: false, code: "INVALID_AI_KEY" });
    expect(captureServerError).not.toHaveBeenCalled();
  });

  it("does NOT read an unrelated '401 Unauthorized' (e.g. Shopify) as a bad AI key", async () => {
    translateField.mockRejectedValueOnce(new Error("GraphQL error: 401 Unauthorized"));
    const { status, body } = await run(fields);
    expect(status).toBe(500);
    expect(body).not.toMatchObject({ code: "INVALID_AI_KEY" });
    expect(captureServerError).toHaveBeenCalledTimes(1);
  });

  it("answers a mid-call managed refusal with its coded status", async () => {
    translateField.mockRejectedValueOnce(new ManagedAiRefusedError("consentMissing"));
    const { status, body } = await run(fields);
    expect(status).not.toBe(500);
    expect(body).toMatchObject({ success: false, code: "AI_CONSENT_REQUIRED" });
    expect(captureServerError).not.toHaveBeenCalled();
  });

  it("answers a MissingAIKeyError thrown mid-handler like the up-front no-key gate", async () => {
    translateField.mockRejectedValueOnce(new MissingAIKeyError("claude"));
    const { status, body } = await run(fields);
    expect(status).toBe(409);
    expect(body).toMatchObject({ success: false, code: "NO_AI_KEY" });
    expect(captureServerError).not.toHaveBeenCalled();
  });

  it("answers a generic crash with a JSON 500 and reports it to Sentry", async () => {
    const boom = new Error("boom");
    translateField.mockRejectedValueOnce(boom);
    const { status, body } = await run(fields);
    expect(status).toBe(500);
    expect(body).toMatchObject({ success: false });
    expect(captureServerError).toHaveBeenCalledWith(boom, {
      route: "/api/ai",
      actionType: "translateField",
      shop: "t.myshopify.com",
    });
  });
});
