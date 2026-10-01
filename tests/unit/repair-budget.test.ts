import { describe, it, expect } from "vitest";
import { createRepairBudget } from "../../app/services/translations/repair-budget.server";

describe("createRepairBudget", () => {
  it("grants up to the cap and refuses (and records) the rest", () => {
    const b = createRepairBudget(2);
    expect(b.take("content", "a")).toBe(true);
    expect(b.take("content", "b")).toBe(true);
    expect(b.take("content", "c")).toBe(false);
    expect([...b.overflowOwners]).toEqual(["c"]);
  });

  it("asking twice for the SAME group costs nothing and never flips the answer", () => {
    const b = createRepairBudget(1);
    expect(b.take("content", "a")).toBe(true);
    expect(b.take("content", "a")).toBe(true);
    expect(b.take("content", "b")).toBe(false);
    expect(b.take("content", "b")).toBe(false);
    expect(b.overflowOwners.size).toBe(1);
  });

  it("a different surface of the same row is its own group; a variant (medium) too", () => {
    const b = createRepairBudget(3);
    expect(b.take("content", "p")).toBe(true);
    expect(b.take("featuredAlt", "p")).toBe(true);
    expect(b.take("productAlt", "p", "m1")).toBe(true);
    expect(b.take("productAlt", "p", "m2")).toBe(false);
  });

  it("a zero budget refuses everything", () => {
    expect(createRepairBudget(0).take("content", "a")).toBe(false);
  });
});
