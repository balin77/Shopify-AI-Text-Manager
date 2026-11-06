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
    expect(forgetOwnedKeys({ ...s, itemId: "A", sentKeys: ["title"], token: T2 })).toEqual(["title"]);
    expect(s.cacheByItem.A).toEqual({ handle: "h" });
  });
  it("gives back the value an earlier request confirmed (the confirmation lives as long as the overlay)", () => {
    const s = base();
    recordConfirmedValues(s.confirmed, "A", { title: "old-confirmed" }, new Set(), s.cacheByItem.A);
    forgetOwnedKeys({ ...s, itemId: "A", sentKeys: ["title"], token: T2 });
    expect(s.cacheByItem.A.title).toBe("old-confirmed");
  });
  it("leaves a key another request owns", () => {
    const s = base();
    forgetOwnedKeys({ ...s, itemId: "A", sentKeys: ["title"], token: T1 });
    expect(s.cacheByItem.A.title).toBe("new");
  });
  it("does not record unconfirmed fields, nor keys the overlay no longer holds; prune forgets the owners", () => {
    const s = base();
    recordConfirmedValues(s.confirmed, "A", { title: "x", handle: "y", gone: "z" }, new Set(["handle"]), s.cacheByItem.A);
    expect(Object.keys(s.confirmed.A)).toEqual(["title"]);
    recordConfirmedValues(s.confirmed, "B", { title: "x" }, new Set(), undefined);
    expect(s.confirmed.B).toBeUndefined();
    pruneOwners(s.owners, "A");
    expect(s.owners.A).toBeUndefined();
    expect(s.confirmed.A).toBeDefined();
  });
});

describe("recordConfirmedValues and passengers", () => {
  it("a passenger was not written: it is not recorded as confirmed; an announced key is, even if also listed", () => {
    const s = base();
    recordConfirmedValues(
      s.confirmed, "A",
      { title: "t", handle: "h", changedFields: JSON.stringify(["title"]), passengerFields: JSON.stringify(["handle", "title"]) },
      new Set(), s.cacheByItem.A,
    );
    expect(Object.keys(s.confirmed.A)).toEqual(["title"]);
  });
});
