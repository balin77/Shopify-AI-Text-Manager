/**
 * proxy.collect-strings is reachable by any storefront visitor through the app
 * proxy, so its body is capped before it is parsed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const authenticate = { public: { appProxy: vi.fn() } };
vi.mock("~/shopify.server", () => ({ authenticate }));
vi.mock("../../app/shopify.server", () => ({ authenticate }));

const recordCandidates = vi.fn(async (_db: unknown, _shop: string, items: unknown[]) => items.length);
vi.mock("../../app/services/direct-translation.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    recordCandidates,
    isDirectTranslationsAvailable: vi.fn(async () => true),
    getSettings: vi.fn(async () => ({ collect: true, filterByLanguage: false })),
  };
});
const dbStub = {};
vi.mock("~/db.server", () => ({ db: dbStub, default: dbStub }));
vi.mock("../../app/db.server", () => ({ db: dbStub, default: dbStub }));

const { action, MAX_COLLECT_STRINGS_BODY_BYTES } = await import("../../app/routes/proxy.collect-strings");
const { collectStringsRateLimiter, MAX_CANDIDATES_PER_REQUEST } = await import(
  "../../app/services/direct-translation.server"
);

const SHOP = "test.myshopify.com";

async function run(body: string) {
  const request = new Request("https://app.example/apps/contentpilot/collect-strings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const response = await action({ request, params: {}, context: {} } as never);
  const envelope = response as unknown as { data: Record<string, unknown>; init?: { status?: number } };
  return { status: envelope.init?.status ?? 200, body: envelope.data };
}

beforeEach(() => {
  vi.clearAllMocks();
  collectStringsRateLimiter.reset();
  authenticate.public.appProxy.mockResolvedValue({ session: { shop: SHOP } });
});

describe("proxy.collect-strings body cap", () => {
  it("fits the largest legitimate payload: every candidate at 1500 four-byte characters", async () => {
    const text = "Ä".repeat(10) + "😀".repeat(745); // 1500 UTF-16 units, mostly 4 UTF-8 bytes
    const items = Array.from({ length: MAX_CANDIDATES_PER_REQUEST }, () => ({ text }));
    const payload = JSON.stringify({ items, locale: "de" });
    expect(new TextEncoder().encode(payload).byteLength).toBeLessThanOrEqual(MAX_COLLECT_STRINGS_BODY_BYTES);
    const { status } = await run(payload);
    expect(status).toBe(200);
    expect(recordCandidates).toHaveBeenCalledTimes(1);
  });

  it("refuses a declared oversize body before authenticating", async () => {
    // happy-dom's Request drops a caller-set Content-Length (a forbidden
    // header), so the declared length rides on a minimal stand-in.
    const request = {
      method: "POST",
      url: "https://app.example/apps/contentpilot/collect-strings",
      headers: new Headers({ "Content-Length": String(MAX_COLLECT_STRINGS_BODY_BYTES + 1) }),
      body: null,
    } as unknown as Request;
    const response = await action({ request, params: {}, context: {} } as never);
    expect((response as unknown as { init?: { status?: number } }).init?.status).toBe(413);
    expect(authenticate.public.appProxy).not.toHaveBeenCalled();
  });

  it("refuses an oversize body whose length is not declared, and records nothing", async () => {
    const big = JSON.stringify({ items: [{ text: "a".repeat(MAX_COLLECT_STRINGS_BODY_BYTES) }] });
    const { status, body } = await run(big);
    expect(status).toBe(413);
    expect(body.error).toBe("Body too large");
    expect(recordCandidates).not.toHaveBeenCalled();
  });

  it("answers 400 for a body that is not a JSON object", async () => {
    expect((await run("not json")).status).toBe(400);
    expect((await run("null")).status).toBe(400);
  });
});
