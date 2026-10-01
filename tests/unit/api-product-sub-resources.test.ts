/**
 * The JSON door for the product editor's plain-`fetch` sub-resource requests.
 * It hands the request to the SAME handler the page route uses, and only for
 * the three actions the hook sends that way.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { handle } = vi.hoisted(() => ({ handle: vi.fn(async (_config: unknown) => ({ success: true })) }));

vi.mock("~/shopify.server", () => ({
  authenticate: { admin: vi.fn(async () => ({ admin: {}, session: { shop: "s.myshopify.com" } })) },
}));
vi.mock("~/actions/unified-content.actions", () => ({ handleUnifiedContentActions: handle }));
vi.mock("~/config/content-fields.config", () => ({ PRODUCTS_CONFIG: { resourceType: "Product" } }));
vi.mock("~/db.server", () => ({
  db: {
    aISettings: { findUnique: vi.fn(async () => null) },
    aIInstructions: { findUnique: vi.fn(async () => null) },
  },
}));

import { action } from "~/routes/api.product-sub-resources";

function post(actionName: string) {
  const fd = new FormData();
  fd.set("action", actionName);
  const request = new Request("https://app.test/api/product-sub-resources", { method: "POST", body: fd });
  return action({ request, params: {}, context: {} } as never);
}

beforeEach(() => handle.mockClear());

describe("api.product-sub-resources", () => {
  it.each(["translateSubResources", "translateSubResourceToAllLocales", "saveSubResourceTranslations"])(
    "passes %s to the unified handler with the product config",
    async (name) => {
      await post(name);
      expect(handle).toHaveBeenCalledTimes(1);
      expect((handle.mock.calls[0] as unknown as [{ contentConfig: unknown }])[0].contentConfig).toEqual({ resourceType: "Product" });
    },
  );

  it("refuses every other action rather than becoming a second door", async () => {
    const response = (await post("deleteContent")) as { init?: { status?: number } };
    expect(handle).not.toHaveBeenCalled();
    expect(response.init?.status).toBe(400);
  });
});
