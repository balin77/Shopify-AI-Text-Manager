// @vitest-environment node
/**
 * An `/api/*` fetch that reaches `authenticate.admin` without a session token
 * must not be answered with Shopify's App Bridge bounce page (200, HTML) —
 * that is what the editor's improve-with-AI button showed the merchant as
 * "Server returned 200: Expected JSON but got text/html;charset=utf-8"
 * (2026-10-02). It becomes a 401 JSON carrying the retry header instead.
 *
 * The bounce response is produced by the LIBRARY's own `renderAppBridge`, so a
 * library upgrade that changes its shape fails here instead of silently
 * slipping past the converter again.
 */
import path from "path";
import { pathToFileURL } from "url";
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

const warn = vi.hoisted(() => vi.fn());
vi.mock("~/utils/logger.server", () => ({
  logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { apiAuthBounceRejection } from "~/utils/api-auth-bounce.server";

let libraryBouncePage: (request: Request) => Response;

beforeAll(async () => {
  const file = path.resolve(
    "node_modules/@shopify/shopify-app-react-router/dist/esm/server/authenticate/admin/helpers/render-app-bridge.mjs",
  );
  const mod = (await import(pathToFileURL(file).href)) as {
    renderAppBridge: (params: unknown, request: Request) => never;
  };
  libraryBouncePage = (request) => {
    try {
      mod.renderAppBridge(
        {
          api: { utils: { sanitizeShop: () => null } },
          config: { apiKey: "test-key", appUrl: "https://app.example.com", distribution: "app_store" },
        },
        request,
      );
    } catch (thrown) {
      return thrown as Response;
    }
    throw new Error("renderAppBridge did not throw");
  };
});

beforeEach(() => warn.mockReset());

function apiFetch(pathname = "/api/ai", headers: Record<string, string> = {}): Request {
  return new Request(`https://app.example.com${pathname}`, {
    method: "POST",
    headers: { accept: "application/json", "sec-fetch-mode": "cors", ...headers },
  });
}

describe("apiAuthBounceRejection", () => {
  it("the library's bounce page is the 200 HTML the merchant saw", () => {
    const bounce = libraryBouncePage(apiFetch());
    expect(bounce.status).toBe(200);
    expect(bounce.headers.get("content-type")).toBe("text/html;charset=utf-8");
  });

  it("turns the bounce page for an /api fetch into a 401 JSON with the retry header", async () => {
    const request = apiFetch();
    const out = apiAuthBounceRejection(libraryBouncePage(request), request);
    expect(out).not.toBeNull();
    expect(out!.status).toBe(401);
    expect(out!.headers.get("X-Shopify-Retry-Invalid-Session-Request")).toBe("1");
    expect(out!.headers.get("content-type")).toContain("application/json");
    expect(await out!.json()).toEqual({ success: false, error: "sessionExpired", code: "sessionExpired" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({ pathname: "/api/ai", bounce: "bouncePage" });
  });

  it("also converts the 302 to the session-token bounce path", () => {
    const request = apiFetch("/api/ai");
    const redirect = new Response(null, { status: 302, headers: { Location: "/auth/session-token?shop=x" } });
    expect(apiAuthBounceRejection(redirect, request)?.status).toBe(401);
  });

  it("leaves a navigation alone — there the bounce page is what makes it work", () => {
    const nav = apiFetch("/api/export", { "sec-fetch-mode": "navigate" });
    expect(apiAuthBounceRejection(libraryBouncePage(nav), nav)).toBeNull();
    const htmlAccept = apiFetch("/api/export", { accept: "text/html,application/xhtml+xml", "sec-fetch-mode": "" });
    expect(apiAuthBounceRejection(libraryBouncePage(htmlAccept), htmlAccept)).toBeNull();
  });

  it("leaves page routes, token-carrying requests and other responses alone", () => {
    const page = apiFetch("/app/products");
    expect(apiAuthBounceRejection(libraryBouncePage(page), page)).toBeNull();

    const withToken = apiFetch("/api/ai", { authorization: "Bearer abc" });
    expect(apiAuthBounceRejection(libraryBouncePage(withToken), withToken)).toBeNull();

    const request = apiFetch();
    const oauth = new Response(null, { status: 302, headers: { Location: "/auth/login" } });
    expect(apiAuthBounceRejection(oauth, request)).toBeNull();
    expect(apiAuthBounceRejection(new Response(null, { status: 410 }), request)).toBeNull();
    expect(apiAuthBounceRejection(new TypeError("boom"), request)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});
