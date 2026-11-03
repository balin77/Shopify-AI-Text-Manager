import { describe, it, expect } from "vitest";
import { forgetOwnedKeys, recordConfirmedValues, pruneOwnership } from "~/services/editor/primary-overlay-ownership.shared";

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
  it("gives back a value confirmed AFTER the request was pressed", () => {
    const s = base();
    recordConfirmedValues(s.confirmed, "A", { title: "old-confirmed" }, new Set(), 9);
    forgetOwnedKeys({ ...s, itemId: "A", sentKeys: ["title"], token: T2, pressSeq: 5 });
    expect(s.cacheByItem.A.title).toBe("old-confirmed");
  });
  it("ignores a confirmation from BEFORE the press (it is no part of this chain)", () => {
    const s = base();
    recordConfirmedValues(s.confirmed, "A", { title: "stale" }, new Set(), 3);
    forgetOwnedKeys({ ...s, itemId: "A", sentKeys: ["title"], token: T2, pressSeq: 5 });
    expect(s.cacheByItem.A.title).toBeUndefined();
  });
  it("leaves a key another request owns", () => {
    const s = base();
    forgetOwnedKeys({ ...s, itemId: "A", sentKeys: ["title"], token: T1, pressSeq: 1 });
    expect(s.cacheByItem.A.title).toBe("new");
  });
  it("does not record unconfirmed fields, and prune forgets the item", () => {
    const s = base();
    recordConfirmedValues(s.confirmed, "A", { title: "x", handle: "y" }, new Set(["handle"]), 4);
    expect(Object.keys(s.confirmed.A)).toEqual(["title"]);
    pruneOwnership(s.owners, s.confirmed, "A");
    expect(s.owners.A).toBeUndefined();
    expect(s.confirmed.A).toBeUndefined();
  });
});
