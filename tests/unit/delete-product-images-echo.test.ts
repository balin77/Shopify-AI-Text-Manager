/**
 * A media delete counts only as far as Shopify ECHOED it: empty userErrors with
 * a shorter deletedMediaIds list is a partial failure, and the answer says
 * which ids did not go (the client clears variant main images only on full success).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const graphql = vi.fn();
const authenticate = { admin: vi.fn() };
vi.mock("../../app/shopify.server", () => ({ authenticate }));
const dbStub = { product: { findUnique: vi.fn(async () => ({ id: "x" })) } };
vi.mock("../../app/db.server", () => ({ db: dbStub, default: dbStub }));
const cleanup = vi.fn(async () => ({ ok: true, removed: 0 }));
vi.mock("../../app/services/localized-media/localized-media.server", () => ({ removeEntriesForDeletedMedia: cleanup }));

const { action } = await import("../../app/routes/api.delete-product-images");

const P = "gid://shopify/Product/1";
const A = "gid://shopify/MediaImage/2";
const B = "gid://shopify/MediaImage/3";

async function run(mediaIds: string[]) {
  const request = { json: async () => ({ productId: P, mediaIds }) } as unknown as Request;
  const r = (await action({ request, params: {}, context: {} } as never)) as { data: Record<string, unknown>; init?: { status?: number } };
  return { status: r.init?.status ?? 200, body: r.data };
}

beforeEach(() => {
  graphql.mockReset();
  cleanup.mockClear();
  authenticate.admin.mockResolvedValue({ admin: { graphql }, session: { shop: "t.myshopify.com" } });
});

describe("api.delete-product-images", () => {
  it("is a success only when every requested id is echoed", async () => {
    graphql.mockResolvedValue({ json: async () => ({ data: { productDeleteMedia: { deletedMediaIds: [A, B], userErrors: [] } } }) });
    const { status, body } = await run([A, B]);
    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true, deletedMediaIds: [A, B] });
  });

  it("reports a partial echo as a failure naming the ids that did not go, and still cleans up the deleted one", async () => {
    graphql.mockResolvedValue({ json: async () => ({ data: { productDeleteMedia: { deletedMediaIds: [A], userErrors: [] } } }) });
    const { status, body } = await run([A, B]);
    expect(status).toBe(422);
    expect(body).toMatchObject({ success: false, deletedMediaIds: [A], failedMediaIds: [B] });
    expect(cleanup).toHaveBeenCalledWith(expect.objectContaining({ mediaIds: [A] }));
  });

  it("an empty echo with no userErrors is a failure", async () => {
    graphql.mockResolvedValue({ json: async () => ({ data: { productDeleteMedia: { deletedMediaIds: [], userErrors: [] } } }) });
    const { status, body } = await run([A]);
    expect(status).toBe(422);
    expect(body).toMatchObject({ success: false, failedMediaIds: [A] });
  });
});
