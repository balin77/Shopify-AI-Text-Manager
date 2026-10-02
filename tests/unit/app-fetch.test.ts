/**
 * The client half of the "Expected JSON but got text/html" fix: `appFetch`
 * sends the App Bridge session token itself, retries an auth bounce once with
 * a fresh one, and turns a bounce it cannot get past into `sessionExpired` —
 * never raw HTML / "Expected JSON" text in the merchant's InfoBox.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  appFetch,
  appFetchJson,
  classifyAuthResponse,
  isAuthBounce,
  isReauthorizeRequiredError,
  isSessionExpiredError,
  ReauthorizeRequiredError,
  SessionExpiredError,
} from "~/utils/app-fetch";
import { translateErrorMessage } from "~/utils/editor-error-messages";
import { de } from "~/i18n/de";

const bouncePage = () =>
  new Response("<script data-api-key=\"k\" src=\"x\"></script>", {
    status: 200,
    headers: { "content-type": "text/html;charset=utf-8" },
  });
const retry401 = () =>
  new Response(JSON.stringify({ success: false, error: "sessionExpired" }), {
    status: 401,
    headers: { "content-type": "application/json", "X-Shopify-Retry-Invalid-Session-Request": "1" },
  });
const ok = (body: unknown = { success: true }) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;
let tokens: string[];

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  tokens = ["tok-1", "tok-2", "tok-3"];
  (window as unknown as { shopify: unknown }).shopify = {
    idToken: vi.fn(async () => tokens.shift()),
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as { shopify?: unknown }).shopify;
});

function sentAuth(call: number): string | null {
  const init = fetchMock.mock.calls[call][1] as RequestInit;
  return new Headers(init.headers).get("Authorization");
}

describe("isAuthBounce / classifyAuthResponse", () => {
  it("retries only the three shapes answered before route code: retry header, 200 HTML, redirected HTML", () => {
    expect(isAuthBounce(bouncePage())).toBe(true);
    expect(isAuthBounce(retry401())).toBe(true);
    const redirected = new Response("<html></html>", { status: 403, headers: { "content-type": "text/html" } });
    Object.defineProperty(redirected, "redirected", { value: true });
    expect(isAuthBounce(redirected)).toBe(true);
  });

  it("a 401 without the retry header is 'expired' (not retryable), one with a reauthorize URL is 'reauthorize'", () => {
    const bare = new Response(null, { status: 401 });
    expect(isAuthBounce(bare)).toBe(false);
    expect(classifyAuthResponse(bare)).toBe("expired");
    const reauth = new Response(null, {
      status: 401,
      headers: { "X-Shopify-API-Request-Failure-Reauthorize-Url": "https://admin.shopify.com/charges/1" },
    });
    expect(isAuthBounce(reauth)).toBe(false);
    expect(classifyAuthResponse(reauth)).toBe("reauthorize");
  });

  it("never mistakes a route's own JSON 401 (INVALID_AI_KEY) or an error page for a bounce", () => {
    const invalidKey = new Response(JSON.stringify({ success: false, code: "INVALID_AI_KEY" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
    expect(isAuthBounce(invalidKey)).toBe(false);
    expect(isAuthBounce(new Response("<h1>Bad gateway</h1>", { status: 502, headers: { "content-type": "text/html" } }))).toBe(false);
    expect(isAuthBounce(ok())).toBe(false);
  });
});

describe("appFetch", () => {
  it("sends the App Bridge session token and Accept: application/json", async () => {
    fetchMock.mockResolvedValueOnce(ok());
    const res = await appFetch("/api/ai", { method: "POST", body: new FormData() });
    expect(res.status).toBe(200);
    expect(sentAuth(0)).toBe("Bearer tok-1");
    expect(new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers).get("Accept")).toBe("application/json");
  });

  it("retries a bounce page once with a FRESH token and returns the route's answer", async () => {
    fetchMock.mockResolvedValueOnce(bouncePage()).mockResolvedValueOnce(ok({ success: true, generatedContent: "x" }));
    const { data } = await appFetchJson("/api/ai", { method: "POST", body: new FormData() });
    expect(data).toEqual({ success: true, generatedContent: "x" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentAuth(1)).toBe("Bearer tok-2");
  });

  it("throws sessionExpired when the bounce survives the retry — no raw HTML text", async () => {
    fetchMock.mockResolvedValueOnce(bouncePage()).mockResolvedValueOnce(retry401());
    const err = await appFetchJson("/api/ai", { method: "POST", body: new FormData() }).catch((e) => e);
    expect(err).toBeInstanceOf(SessionExpiredError);
    expect(isSessionExpiredError(err)).toBe(true);
    expect(err.message).not.toMatch(/Expected JSON/);
    expect(translateErrorMessage(err.message, de as never)).toBe(de.errors.sessionExpired);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("still works without App Bridge (no token) and reports the bounce as sessionExpired", async () => {
    delete (window as unknown as { shopify?: unknown }).shopify;
    fetchMock.mockResolvedValue(bouncePage());
    await expect(appFetch("/api/ai", { method: "POST" })).rejects.toBeInstanceOf(SessionExpiredError);
    expect(sentAuth(0)).toBeNull();
  });

  it("passes a route's JSON 401 through untouched", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, code: "INVALID_AI_KEY" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    const { response, data } = await appFetchJson<{ code: string }>("/api/ai", { method: "POST" });
    expect(response.status).toBe(401);
    expect(data.code).toBe("INVALID_AI_KEY");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a caller's own Authorization header and does not retry with another", async () => {
    fetchMock.mockResolvedValueOnce(bouncePage());
    await expect(
      appFetch("/api/ai", { method: "POST", headers: { Authorization: "Bearer mine" } }),
    ).rejects.toBeInstanceOf(SessionExpiredError);
    expect(sentAuth(0)).toBe("Bearer mine");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a 401 WITHOUT the retry header throws sessionExpired at once — no resend, a write may have started", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    const err = await appFetch("/api/ai", { method: "POST", body: new FormData() }).catch((e) => e);
    expect(err).toBeInstanceOf(SessionExpiredError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a 401 with a reauthorize URL surfaces as reauthorizeRequired, not as an expired session", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 401,
        headers: { "X-Shopify-API-Request-Failure-Reauthorize-Url": "https://admin.shopify.com/charges/1" },
      }),
    );
    const err = await appFetchJson("/api/ai", { method: "POST" }).catch((e) => e);
    expect(err).toBeInstanceOf(ReauthorizeRequiredError);
    expect(isReauthorizeRequiredError(err)).toBe(true);
    expect(isSessionExpiredError(err)).toBe(false);
    expect(err.url).toBe("https://admin.shopify.com/charges/1");
    expect(translateErrorMessage(err.message, de as never)).toBe(de.errors.reauthorizeRequired);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries at most once, and asks for the second token on a shorter deadline", async () => {
    vi.useFakeTimers();
    try {
      const idToken = vi
        .fn()
        .mockResolvedValueOnce("tok-1")
        .mockImplementationOnce(() => new Promise(() => {})); // never answers
      (window as unknown as { shopify: unknown }).shopify = { idToken };
      fetchMock.mockResolvedValue(bouncePage());
      const pending = appFetch("/api/ai", { method: "POST" }).catch((e) => e);
      await vi.advanceTimersByTimeAsync(2_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2);
      const err = await pending;
      expect(err).toBeInstanceOf(SessionExpiredError);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sentAuth(1)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a non-JSON answer that is not a bounce keeps the status, not the body", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<h1>502</h1>", { status: 502, headers: { "content-type": "text/html" } }));
    await expect(appFetchJson("/api/ai", { method: "POST" })).rejects.toThrow(/Server returned 502/);
  });
});
