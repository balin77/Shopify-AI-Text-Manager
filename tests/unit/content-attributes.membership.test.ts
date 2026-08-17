/**
 * PLAN_CONTENT_CREATION §Phase 3.1 — collection membership and the taxonomy id.
 *
 * Membership is the one attribute whose write is a DIFF rather than a value,
 * and it carries two rules that only look like details until they bite:
 *
 *   1. The BEFORE side is the CACHE. The action is reachable by POST, so a
 *      payload that names a collection id as "left" must not be able to remove
 *      a membership this editor never showed.
 *   2. A rule-based membership is never left. Its rule re-adds the product
 *      within seconds, and the merchant is left looking at a save that
 *      apparently did nothing — this app's named worst outcome.
 */

import { describe, it, expect } from "vitest";
import {
  diffCollectionMembership,
  parseCollectionIds,
  parseCategoryId,
} from "../../app/services/content-attributes.shared";

const gid = (n: number) => `gid://shopify/Collection/${n}`;

describe("diffCollectionMembership", () => {
  it("joins what is new and leaves what is gone", () => {
    const diff = diffCollectionMembership(
      [{ collectionId: gid(1), automated: false }, { collectionId: gid(2), automated: false }],
      [gid(1), gid(3)],
    );
    expect(diff.toJoin).toEqual([gid(3)]);
    expect(diff.toLeave).toEqual([gid(2)]);
    expect(diff.refusedAutomated).toEqual([]);
  });

  it("REFUSES to leave a rule-based membership, and says so", () => {
    // Unticking it would look like it worked; the rule would put the product
    // back. The picker locks the row, and this is the server-side twin,
    // because the action is reachable by POST.
    const diff = diffCollectionMembership([{ collectionId: gid(1), automated: true }], []);
    expect(diff.toLeave).toEqual([]);
    expect(diff.refusedAutomated).toEqual([gid(1)]);
  });

  it("still JOINS an automated collection when asked", () => {
    // Adding a product to a smart collection is a legitimate manual override
    // on Shopify's side; only removing it is the one the rule undoes.
    const diff = diffCollectionMembership([], [gid(9)]);
    expect(diff.toJoin).toEqual([gid(9)]);
  });

  it("emits nothing when the membership is unchanged", () => {
    const before = [{ collectionId: gid(1), automated: false }];
    const diff = diffCollectionMembership(before, [gid(1)]);
    expect(diff.toJoin).toEqual([]);
    expect(diff.toLeave).toEqual([]);
  });

  it("cannot be made to leave a membership the cache does not carry", () => {
    // `before` is the server's own state. An id that appears in neither list
    // is simply not part of this product's membership, and naming it changes
    // nothing in either direction.
    const diff = diffCollectionMembership([{ collectionId: gid(1), automated: false }], [gid(1), gid(1)]);
    expect(diff.toJoin).toEqual([]);
    expect(diff.toLeave).toEqual([]);
  });

  it("treats an empty selection as leaving every manual membership", () => {
    const diff = diffCollectionMembership(
      [
        { collectionId: gid(1), automated: false },
        { collectionId: gid(2), automated: true },
      ],
      [],
    );
    expect(diff.toLeave).toEqual([gid(1)]);
    expect(diff.refusedAutomated).toEqual([gid(2)]);
  });
});

describe("parseCollectionIds", () => {
  it("keeps only real collection GIDs", () => {
    // A stray token would become a `collectionsToJoin` entry and fail the
    // WHOLE mutation, taking the merchant's text edits with it.
    expect(parseCollectionIds(`${gid(1)}, not-a-gid, gid://shopify/Product/5`)).toEqual([gid(1)]);
  });

  it("trims and de-duplicates", () => {
    expect(parseCollectionIds(` ${gid(1)} , ${gid(1)} `)).toEqual([gid(1)]);
  });

  it("reads an empty string as an empty list", () => {
    expect(parseCollectionIds("")).toEqual([]);
  });
});

describe("parseCategoryId", () => {
  it("accepts a taxonomy GID", () => {
    expect(parseCategoryId("gid://shopify/TaxonomyCategory/aa-1-2")).toEqual({
      id: "gid://shopify/TaxonomyCategory/aa-1-2",
      valid: true,
    });
  });

  it("reads empty as a deliberate CLEAR, not as an error", () => {
    expect(parseCategoryId("  ")).toEqual({ id: null, valid: true });
  });

  it("REFUSES anything else rather than forwarding it", () => {
    // A wrong-typed ID fails at the GraphQL schema level, which comes back as
    // a top-level `errors` array with `data: null` and never reaches
    // `userErrors` — the save would read as a success while nothing was
    // written.
    expect(parseCategoryId("gid://shopify/Collection/1").valid).toBe(false);
    expect(parseCategoryId("Apparel > Shirts").valid).toBe(false);
  });
});
