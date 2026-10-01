/**
 * PLAN_CONTENT_CREATION §7 (Phase 1) — create de-duplication.
 *
 * The plan is explicit that a disabled submit button is NOT enough: it covers
 * a double-click and nothing else, while a client-side timeout or a reload
 * mid-flight both produce a second POST with the button freshly enabled. The
 * result is a duplicate object in the shop, and this app has no content delete
 * to remove one with (§0.1) — so the retry has to be recognised server-side.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  claimCreateRequest,
  previousCreateResult,
  recordCreateResult,
  releaseCreateRequest,
  __resetCreateIdempotency,
} from "~/utils/create-idempotency.server";

const SHOP = "a.myshopify.com";
const OTHER = "b.myshopify.com";

beforeEach(() => __resetCreateIdempotency());

describe("claimCreateRequest", () => {
  it("lets the first attempt through and refuses the retry", () => {
    expect(claimCreateRequest(SHOP, "req-1")).toBe(true);
    expect(claimCreateRequest(SHOP, "req-1")).toBe(false);
  });

  it("scopes the claim per shop", () => {
    // The key is shared memory across tenants; a collision would make one
    // merchant's create silently answer another's.
    expect(claimCreateRequest(SHOP, "req-1")).toBe(true);
    expect(claimCreateRequest(OTHER, "req-1")).toBe(true);
  });

  it("does not dedupe when no request id was supplied", () => {
    // Nothing to compare against. Refusing here would break any caller that
    // does not mint an id, which is worse than not deduping.
    expect(claimCreateRequest(SHOP, "")).toBe(true);
    expect(claimCreateRequest(SHOP, "")).toBe(true);
  });

  it("treats different ids as different creates", () => {
    expect(claimCreateRequest(SHOP, "req-1")).toBe(true);
    expect(claimCreateRequest(SHOP, "req-2")).toBe(true);
  });
});

describe("the retry's answer", () => {
  it("returns the FIRST result verbatim once it finished", () => {
    claimCreateRequest(SHOP, "req-1");
    const first = { actionType: "createContent", success: true, id: "gid://shopify/Product/1" };
    recordCreateResult(SHOP, "req-1", first);

    expect(claimCreateRequest(SHOP, "req-1")).toBe(false);
    expect(previousCreateResult(SHOP, "req-1")).toEqual(first);
  });

  it("has NO result while the first attempt is still running", () => {
    // The honest answer to a retry then is "already in progress" — not a
    // fresh create, and not an error either, because the object is very
    // likely about to exist.
    claimCreateRequest(SHOP, "req-1");
    expect(previousCreateResult(SHOP, "req-1")).toBeUndefined();
  });

  it("does not leak a result across shops", () => {
    claimCreateRequest(SHOP, "req-1");
    recordCreateResult(SHOP, "req-1", { id: "gid://shopify/Product/1" });
    expect(previousCreateResult(OTHER, "req-1")).toBeUndefined();
  });
});

describe("releaseCreateRequest", () => {
  it("lets a genuinely failed create be retried", () => {
    // A claim that outlives its failure would answer every retry with
    // "already in progress" and strand the merchant.
    claimCreateRequest(SHOP, "req-1");
    releaseCreateRequest(SHOP, "req-1");
    expect(claimCreateRequest(SHOP, "req-1")).toBe(true);
  });

  it("is a no-op without an id", () => {
    expect(() => releaseCreateRequest(SHOP, "")).not.toThrow();
  });
});
