/**
 * proxy.direct-add is reachable by any storefront visitor through the app
 * proxy. It must refuse every write that does not carry a valid capture token
 * for the proxied shop, and bound what a token holder can send.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const authenticate = { public: { appProxy: vi.fn() } };
vi.mock("~/shopify.server", () => ({ authenticate }));
vi.mock("../../app/shopify.server", () => ({ authenticate }));

const directTranslationItem = {
  upsert: vi.fn(async (args: { create: { sourceText: string } }) => ({
    id: "item1",
    sourceText: args.create.sourceText,
    translations: [],
  })),
  findUnique: vi.fn(async () => null),
  findFirst: vi.fn(async () => ({ id: "item1" })),
  count: vi.fn(async () => 0),
};
const directTranslation = { upsert: vi.fn(async () => ({})) };
const directTranslationSettings = { upsert: vi.fn(async () => ({})), findUnique: vi.fn(async () => null) };
const aISettings = { findUnique: vi.fn(async () => ({ subscriptionPlan: "max" })) };
const dbStub = { directTranslationItem, directTranslation, directTranslationSettings, directTranslationCandidate: {}, aISettings };
vi.mock("~/db.server", () => ({ db: dbStub, default: dbStub }));
vi.mock("../../app/db.server", () => ({ db: dbStub, default: dbStub }));

const translateItemsIntoAllLocales = vi.fn(async () => undefined);
vi.mock("../../app/services/direct-translation-ai.server", () => ({ translateItemsIntoAllLocales }));

const { action } = await import("../../app/routes/proxy.direct-add");
const { mintCaptureToken } = await import("../../app/services/direct-capture-token.server");
const { MAX_DIRECT_ADD_BODY_BYTES } = await import("../../app/routes/proxy.direct-add");
const { directAddRateLimiter, MAX_ITEMS_PER_SHOP } = await import("../../app/services/direct-translation.server");

const SHOP = "test.myshopify.com";

async function run(body: unknown) {
  const request = new Request("https://app.example/apps/contentpilot/direct-add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const response = await action({ request, params: {}, context: {} } as never);
  const envelope = response as unknown as { data: Record<string, unknown>; init?: { status?: number } };
  return { status: envelope.init?.status ?? 200, body: envelope.data };
}

beforeEach(() => {
  vi.clearAllMocks();
  directAddRateLimiter.reset();
  authenticate.public.appProxy.mockResolvedValue({ session: { shop: SHOP }, admin: {} });
  aISettings.findUnique.mockResolvedValue({ subscriptionPlan: "max" });
  directTranslationItem.findUnique.mockResolvedValue(null);
  directTranslationItem.count.mockResolvedValue(0);
});

describe("proxy.direct-add", () => {
  it("refuses a request without a capture token and writes nothing", async () => {
    const res = await run({ sourceText: "Hello", translateAll: true });
    expect(res.status).toBe(403);
    expect(directTranslationItem.upsert).not.toHaveBeenCalled();
    expect(translateItemsIntoAllLocales).not.toHaveBeenCalled();
  });

  it("refuses a token minted for another shop", async () => {
    const res = await run({ sourceText: "Hello", captureToken: mintCaptureToken("other.myshopify.com") });
    expect(res.status).toBe(403);
    expect(directTranslationItem.upsert).not.toHaveBeenCalled();
  });

  it("refuses an explicit translation without a token", async () => {
    const res = await run({ sourceText: "Hello", locale: "de", targetText: "Hallo" });
    expect(res.status).toBe(403);
    expect(directTranslation.upsert).not.toHaveBeenCalled();
  });

  it("adds the item with a valid token", async () => {
    const res = await run({ sourceText: "  Hello   world ", captureToken: mintCaptureToken(SHOP), translateAll: true });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(directTranslationItem.upsert).toHaveBeenCalledTimes(1);
    expect(translateItemsIntoAllLocales).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-boolean translateAll", async () => {
    const res = await run({ sourceText: "Hello", captureToken: mintCaptureToken(SHOP), translateAll: "yes" });
    expect(res.status).toBe(400);
    expect(directTranslationItem.upsert).not.toHaveBeenCalled();
  });

  it("caps the source and target length", async () => {
    const token = mintCaptureToken(SHOP);
    expect((await run({ sourceText: "a".repeat(1501), captureToken: token })).status).toBe(400);
    expect(
      (await run({ sourceText: "Hello", captureToken: token, locale: "de", targetText: "x".repeat(5001) })).status,
    ).toBe(400);
    expect(directTranslationItem.upsert).not.toHaveBeenCalled();
  });

  it("refuses a new item past the per-shop cap", async () => {
    directTranslationItem.count.mockResolvedValue(MAX_ITEMS_PER_SHOP);
    const res = await run({ sourceText: "Hello", captureToken: mintCaptureToken(SHOP) });
    expect(res.status).toBe(409);
    expect(directTranslationItem.upsert).not.toHaveBeenCalled();
  });

  it("rate-limits per shop for token-carrying requests", async () => {
    const token = mintCaptureToken(SHOP);
    let limited = 0;
    for (let i = 0; i < 40; i++) {
      const res = await run({ sourceText: "Hello", captureToken: token });
      if (res.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });

  it("anonymous token-less requests cannot drain the merchant's bucket", async () => {
    for (let i = 0; i < 200; i++) {
      expect((await run({ sourceText: "Hello" })).status).toBe(403);
    }
    const res = await run({ sourceText: "Hello", captureToken: mintCaptureToken(SHOP) });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe("proxy.direct-add body cap", () => {
  async function runRequest(request: Request) {
    const response = await action({ request, params: {}, context: {} } as never);
    const envelope = response as unknown as {
      data: Record<string, unknown>;
      init?: { status?: number; headers?: HeadersInit };
    };
    return {
      status: envelope.init?.status ?? 200,
      body: envelope.data,
      headers: new Headers(envelope.init?.headers),
    };
  }

  it("refuses a declared oversize body with 413 before authenticating", async () => {
    // happy-dom's Request drops a caller-set Content-Length (a forbidden
    // header), so the declared length rides on a minimal stand-in.
    const request = {
      method: "POST",
      url: "https://app.example/apps/contentpilot/direct-add",
      headers: new Headers({
        "Content-Type": "application/json",
        "Content-Length": String(MAX_DIRECT_ADD_BODY_BYTES + 1),
      }),
      body: null,
    } as unknown as Request;
    const res = await runRequest(request);
    expect(res.status).toBe(413);
    expect(authenticate.public.appProxy).not.toHaveBeenCalled();
    expect(directTranslationItem.upsert).not.toHaveBeenCalled();
  });

  it("refuses an oversize streamed body without a Content-Length and stops reading", async () => {
    let pulled = 0;
    let cancelled = false;
    const chunk = new TextEncoder().encode("a".repeat(4096));
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled > 1000) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("https://app.example/apps/contentpilot/direct-add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(request.headers.get("content-length")).toBeNull();
    const res = await runRequest(request);
    expect(res.status).toBe(413);
    expect(res.headers.get("Connection")).toBe("close");
    // Stopped soon after the cap, never drained the whole 4 MB.
    expect(pulled).toBeLessThan(MAX_DIRECT_ADD_BODY_BYTES / 4096 + 5);
    // Released, not cancelled: cancelling the production body stream destroys
    // the socket and the 413 would never reach the client.
    expect(cancelled).toBe(false);
    expect(stream.locked).toBe(false);
    expect(directTranslationItem.upsert).not.toHaveBeenCalled();
  });

  it("accepts a legitimate maximum-size CJK translation", async () => {
    const res = await run({
      sourceText: "Hello",
      captureToken: mintCaptureToken(SHOP),
      locale: "ja",
      targetText: "\u3042".repeat(5000),
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe("proxy.collect-strings rate limit", () => {
  it("answers 200 with nothing recorded once the shop's bucket is drained", async () => {
    const { action: collect } = await import("../../app/routes/proxy.collect-strings");
    const { collectStringsRateLimiter } = await import("../../app/services/direct-translation.server");
    collectStringsRateLimiter.reset();
    for (let i = 0; i < 120; i++) collectStringsRateLimiter.allow(SHOP);
    aISettings.findUnique.mockClear();
    const request = new Request("https://app.example/apps/contentpilot/collect-strings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ text: "Hello" }] }),
    });
    const response = await collect({ request, params: {}, context: {} } as never);
    const envelope = response as unknown as { data: Record<string, unknown>; init?: { status?: number } };
    expect(envelope.data).toEqual({ ok: true, recorded: 0 });
    expect(aISettings.findUnique).not.toHaveBeenCalled();
  });
});
