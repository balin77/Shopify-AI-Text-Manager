import { describe, it, expect, vi } from "vitest";
import { resolvePrimaryDomain, fetchPrimaryDomain } from "~/utils/shop-domain.server";

/**
 * The distinction these tests protect: a FAILED lookup must be reported as
 * null, never as the myshopify fallback. Callers that persist the result
 * (IndexNow's host) would otherwise overwrite a correct primary domain with
 * the redirecting one on any transient API error.
 */

const adminReturning = (body: unknown) => ({ graphql: vi.fn(async () => ({ json: async () => body })) });

describe("resolvePrimaryDomain", () => {
  it("returns the primary domain host", async () => {
    const admin = adminReturning({ data: { shop: { primaryDomain: { host: "shop.example" } } } });
    expect(await resolvePrimaryDomain(admin)).toBe("shop.example");
  });

  it("returns null on a throttled/partial HTTP-200 response with errors", async () => {
    const admin = adminReturning({
      errors: [{ message: "Throttled" }],
      data: { shop: null },
    });
    expect(await resolvePrimaryDomain(admin)).toBeNull();
  });

  it("returns null when the request throws", async () => {
    const admin = { graphql: vi.fn(async () => { throw new Error("network"); }) };
    expect(await resolvePrimaryDomain(admin)).toBeNull();
  });

  it("returns null when the shop has no primary domain in the payload", async () => {
    expect(await resolvePrimaryDomain(adminReturning({ data: { shop: {} } }))).toBeNull();
  });
});

describe("fetchPrimaryDomain", () => {
  it("applies the fallback for read-only callers", async () => {
    const admin = { graphql: vi.fn(async () => { throw new Error("network"); }) };
    expect(await fetchPrimaryDomain(admin, "s.myshopify.com")).toBe("s.myshopify.com");
  });
});
