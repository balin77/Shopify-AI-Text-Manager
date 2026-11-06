/**
 * The internal-links start handler looks up the shop's primary locale for the
 * synonym prompt. `getCachedShopLocales` re-throws a 401 `Response` so the
 * request can re-authenticate: that Response must reach /api/ai (which
 * re-throws it) rather than becoming a generic 500, while any OTHER failure of
 * the lookup falls back to "" and the run still starts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getCachedShopLocales = vi.fn();
vi.mock("~/utils/shop-locales-cache.server", () => ({ getCachedShopLocales }));
const runInternalLinkSuggestions = vi.fn(async (_shop: string, _deps: { primaryLocale: string }) => ({
  created: 0,
  updated: 0,
  sourcesScanned: 0,
}));
vi.mock("~/services/seo/internal-links.service", () => ({
  runInternalLinkSuggestions,
  HEARTBEAT_EVERY_SOURCES: 10,
}));
vi.mock("../../app/routes/api-ai-handlers/shared", () => ({
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  createAIService: () => ({ generateSynonymsBatch: vi.fn() }),
}));

const { handleSeoInternalLinks } = await import("../../app/routes/api-ai-handlers/seo-internal-links.handler");

function ctx() {
  const db = {
    task: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: "task-1" })),
      update: vi.fn(async () => ({})),
    },
  };
  return {
    session: { shop: "t.myshopify.com" },
    admin: {},
    db,
    settings: { subscriptionPlan: "pro" },
  } as never;
}

beforeEach(() => {
  getCachedShopLocales.mockReset();
  runInternalLinkSuggestions.mockClear();
});

describe("handleSeoInternalLinks locale lookup", () => {
  it("re-throws a Response from the lookup and starts no task", async () => {
    const reauth = new Response(null, { status: 401, headers: { "X-Shopify-Retry-Invalid-Session-Request": "1" } });
    getCachedShopLocales.mockRejectedValue(reauth);
    const c = ctx() as unknown as { db: { task: { create: ReturnType<typeof vi.fn> } } };
    await expect(handleSeoInternalLinks(c as never)).rejects.toBe(reauth);
    expect(c.db.task.create).not.toHaveBeenCalled();
  });

  it("falls back to an empty primary locale on any other failure", async () => {
    getCachedShopLocales.mockRejectedValue(new Error("boom"));
    const r = (await handleSeoInternalLinks(ctx())) as unknown as { data: { success: boolean } };
    expect(r.data.success).toBe(true);
    await vi.waitFor(() => expect(runInternalLinkSuggestions).toHaveBeenCalled());
    expect(runInternalLinkSuggestions.mock.calls[0][1].primaryLocale).toBe("");
  });

  it("passes the primary locale through when the lookup answers", async () => {
    getCachedShopLocales.mockResolvedValue([{ locale: "de", primary: true, published: true }]);
    await handleSeoInternalLinks(ctx());
    await vi.waitFor(() => expect(runInternalLinkSuggestions).toHaveBeenCalled());
    expect(runInternalLinkSuggestions.mock.calls[0][1].primaryLocale).toBe("de");
  });
});
