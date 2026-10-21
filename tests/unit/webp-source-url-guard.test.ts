/**
 * The WebP conversion downloads a url the CLIENT named. Before this guard the
 * worker fetched it with a plain, redirect-following `fetch`, so any
 * authenticated shop could make the server read an internal address
 * (`*.railway.internal`, localhost, a metadata endpoint) and get the answer
 * back as an uploaded "image" or in its task's error text.
 *
 * Pinned here: the allowlist itself, the worker refusing before the first
 * request, every redirect hop being re-checked (an allowlisted url must not be
 * able to bounce the worker anywhere), and the error text naming a host only.
 */
import { describe, it, expect, vi } from "vitest";
import {
  isAllowedWebpSourceUrl,
  webpSourceHostForMessage,
} from "../../app/config/webp-source-url.js";
import {
  DEFAULT_ADMIN_API_VERSION,
  SUPPORTED_ADMIN_API_VERSIONS,
  resolveAdminApiVersion,
  adminGraphqlUrl,
} from "../../app/config/admin-api-version.js";
import {
  DEFAULT_SHOPIFY_API_VERSION,
  SUPPORTED_SHOPIFY_API_VERSIONS,
  resolveApiVersionString,
} from "../../app/utils/api-version";

(globalThis as any).__db ??= {};
const { downloadImageAsBuffer } = await import("../../webp-processor.service.js");

const CDN = "https://cdn.shopify.com/s/files/1/0001/files/shirt.png?v=1";

function res(status: number, headers: Record<string, string> = {}, body = "img"): any {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  };
}

describe("isAllowedWebpSourceUrl", () => {
  it("accepts the Shopify CDN hosts over https", () => {
    expect(isAllowedWebpSourceUrl(CDN)).toBe(true);
    expect(isAllowedWebpSourceUrl("https://cdn.shopifycdn.net/s/files/x.jpg")).toBe(true);
    expect(isAllowedWebpSourceUrl("https://CDN.SHOPIFY.COM/s/files/x.jpg")).toBe(true);
  });

  it("refuses http, other schemes and non-strings", () => {
    expect(isAllowedWebpSourceUrl("http://cdn.shopify.com/s/files/x.jpg")).toBe(false);
    expect(isAllowedWebpSourceUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedWebpSourceUrl("data:image/png;base64,AAAA")).toBe(false);
    expect(isAllowedWebpSourceUrl(undefined)).toBe(false);
    expect(isAllowedWebpSourceUrl(42)).toBe(false);
    expect(isAllowedWebpSourceUrl("not a url")).toBe(false);
    expect(isAllowedWebpSourceUrl("https://cdn.shopify.com/" + "a".repeat(3000))).toBe(false);
  });

  it("refuses internal hosts, IP literals, look-alikes, userinfo and ports", () => {
    for (const url of [
      "https://localhost/x.png",
      "https://127.0.0.1/x.png",
      "https://169.254.169.254/latest/meta-data/",
      "https://[::1]/x.png",
      "https://postgres.railway.internal/x.png",
      "https://cdn.shopify.com.evil.example/x.png",
      "https://evil.cdn.shopify.com/x.png",
      "https://shop.myshopify.com/cdn/shop/files/x.png",
      "https://user:pw@cdn.shopify.com/x.png",
      "https://cdn.shopify.com:8443/x.png",
    ]) {
      expect(isAllowedWebpSourceUrl(url), url).toBe(false);
    }
  });

  it("names a host, never the url, for messages", () => {
    expect(webpSourceHostForMessage("http://internal.svc:8080/secret?token=1")).toBe("internal.svc");
    expect(webpSourceHostForMessage("nope")).toBe("(invalid url)");
  });
});

describe("downloadImageAsBuffer (worker)", () => {
  const noSleep = async () => {};

  it("downloads an allowlisted url without following redirects automatically", async () => {
    const fetchFn = vi.fn(async () => res(200));
    const buf = await downloadImageAsBuffer(CDN, { fetchFn, sleepFn: noSleep });
    expect(buf.toString()).toBe("img");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((fetchFn.mock.calls[0] as any[])[1].redirect).toBe("manual");
  });

  it("refuses an http url before any request, and does not retry", async () => {
    const fetchFn = vi.fn(async () => res(200));
    await expect(
      downloadImageAsBuffer("http://cdn.shopify.com/x.png", { fetchFn, sleepFn: noSleep }),
    ).rejects.toThrow(/not allowed/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refuses an internal host and keeps the url out of the message", async () => {
    const fetchFn = vi.fn(async () => res(200));
    const err = await downloadImageAsBuffer(
      "https://postgres.railway.internal/secret?token=abc",
      { fetchFn, sleepFn: noSleep },
    ).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("postgres.railway.internal");
    expect(err.message).not.toContain("token=abc");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refuses a redirect to another host without requesting it", async () => {
    const fetchFn = vi.fn(async (url: string) =>
      url === CDN ? res(302, { location: "http://169.254.169.254/latest/meta-data/" }) : res(200, {}, "secret"),
    );
    await expect(downloadImageAsBuffer(CDN, { fetchFn, sleepFn: noSleep })).rejects.toThrow(/not allowed/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("follows a redirect that stays on the CDN, relative location included", async () => {
    const fetchFn = vi.fn(async (url: string) =>
      url === CDN ? res(301, { location: "/s/files/1/0001/files/shirt-2.png" }) : res(200, {}, "moved"),
    );
    const buf = await downloadImageAsBuffer(CDN, { fetchFn, sleepFn: noSleep });
    expect(buf.toString()).toBe("moved");
    expect((fetchFn.mock.calls[1] as any[])[0]).toBe("https://cdn.shopify.com/s/files/1/0001/files/shirt-2.png");
  });

  it("stops after a bounded number of redirects", async () => {
    const fetchFn = vi.fn(async () => res(302, { location: CDN }));
    await expect(downloadImageAsBuffer(CDN, { fetchFn, sleepFn: noSleep })).rejects.toThrow(/redirects/);
    expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("does not put the response body or the url into a non-retryable HTTP failure", async () => {
    const fetchFn = vi.fn(async () => res(404, {}, "internal detail"));
    const err = await downloadImageAsBuffer(CDN, { fetchFn, sleepFn: noSleep }).catch(e => e);
    expect(err.message).toBe("Failed to download image: HTTP 404 from cdn.shopify.com");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("still retries a retryable status", async () => {
    let n = 0;
    const fetchFn = vi.fn(async () => (++n < 2 ? res(503) : res(200)));
    const buf = await downloadImageAsBuffer(CDN, { fetchFn, sleepFn: noSleep });
    expect(buf.toString()).toBe("img");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe("admin-api-version.js mirrors app/utils/api-version.ts", () => {
  it("has the same supported list and default", () => {
    expect([...SUPPORTED_ADMIN_API_VERSIONS]).toEqual([...SUPPORTED_SHOPIFY_API_VERSIONS]);
    expect(DEFAULT_ADMIN_API_VERSION).toBe(DEFAULT_SHOPIFY_API_VERSION);
  });

  it("resolves the same way", () => {
    for (const v of ["2026-07", " 2026-07 ", "UNSTABLE", "2025-04", "bogus", ""]) {
      expect(resolveAdminApiVersion(v), v).toBe(resolveApiVersionString(v));
    }
  });

  it("builds the admin url from the env version, never a hardcoded one", () => {
    const prev = process.env.SHOPIFY_API_VERSION;
    try {
      process.env.SHOPIFY_API_VERSION = "2026-07";
      expect(adminGraphqlUrl("x.myshopify.com")).toBe("https://x.myshopify.com/admin/api/2026-07/graphql.json");
    } finally {
      if (prev === undefined) delete process.env.SHOPIFY_API_VERSION;
      else process.env.SHOPIFY_API_VERSION = prev;
    }
  });
});
