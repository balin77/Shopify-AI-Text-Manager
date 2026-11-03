import { describe, it, expect } from "vitest";
import { forgetOwnedKeys, recordConfirmedValues, pruneOwners } from "~/services/editor/primary-overlay-ownership.shared";

const T1 = { id: 1 };
const T2 = { id: 2 };
const base = () => ({
  cacheByItem: { A: { title: "new", handle: "h" } } as Record<string, Record<string, string>>,
  owners: { A: { title: T2, handle: T2 } } as Record<string, Record<string, unknown>>,
  confirmed: {} as Record<string, Record<string, { value: string; seq: number }>>,
});

describe("forgetOwnedKeys", () => {
  it("deletes what the failing request owns when nothing was confirmed", () => {
    const s = base();
    forgetOwnedKeys({ ...s, itemId: "A", sentKeys: ["title"], token: T2, pressSeq: 5 });
    expect(s.cacheByItem.A).toEqual({ handle: "h" });
  });
  it("gives back the value an earlier request confirmed, whenever that was (the confirmation lives as long as the overlay)", () => {
    const s = base();
    recordConfirmedValues(s.confirmed, "A", { title: "old-confirmed" }, new Set(), 1);
    forgetOwnedKeys({ ...s, itemId: "A", sentKeys: ["title"], token: T2, pressSeq: 5 });
    expect(s.cacheByItem.A.title).toBe("old-confirmed");
  });
  it("leaves a key another request owns", () => {
    const s = base();
    forgetOwnedKeys({ ...s, itemId: "A", sentKeys: ["title"], token: T1, pressSeq: 1 });
    expect(s.cacheByItem.A.title).toBe("new");
  });
  it("does not record unconfirmed fields, and prune forgets the owners of the item", () => {
    const s = base();
    recordConfirmedValues(s.confirmed, "A", { title: "x", handle: "y" }, new Set(["handle"]), 4);
    expect(Object.keys(s.confirmed.A)).toEqual(["title"]);
    pruneOwners(s.owners, "A");
    expect(s.owners.A).toBeUndefined();
    expect(s.confirmed.A).toBeDefined();
  });
});
