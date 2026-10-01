import { describe, it, expect } from "vitest";
import {
  hasPendingSubResourceChanges,
  withoutIds,
  unconfirmedPurgeOf,
  type SubResourcePendingState,
} from "../../app/services/editor/sub-resource-pending.shared";

const empty = (): SubResourcePendingState => ({
  dirtyOptionIds: new Set(),
  dirtyOptionValueIds: new Set(),
  dirtyMetafieldIds: new Set(),
  primaryOptionEdits: {},
  primaryMetafieldEdits: {},
  optionValuesToAdd: {},
  optionLinkedValuesToAdd: {},
  optionValuesToDelete: {},
  optionsToCreate: [],
  optionsToDelete: [],
  optionOrder: null,
  optionValueOrder: {},
});

describe("hasPendingSubResourceChanges", () => {
  it("is false for an empty state", () => {
    expect(hasPendingSubResourceChanges(empty())).toBe(false);
  });
  it("is false when lists exist but are empty", () => {
    expect(
      hasPendingSubResourceChanges({ ...empty(), optionValuesToAdd: { a: [] }, optionValuesToDelete: { a: [] } }),
    ).toBe(false);
  });
  it.each([
    ["dirty option", { dirtyOptionIds: new Set(["o"]) }],
    ["dirty value", { dirtyOptionValueIds: new Set(["v"]) }],
    ["dirty metafield", { dirtyMetafieldIds: new Set(["m"]) }],
    ["primary option edit", { primaryOptionEdits: { o: {} } }],
    ["primary metafield edit", { primaryMetafieldEdits: { m: "x" } }],
    ["added value", { optionValuesToAdd: { o: ["x"] } }],
    ["linked value", { optionLinkedValuesToAdd: { o: [{}] } }],
    ["deleted value", { optionValuesToDelete: { o: ["v"] } }],
    ["created option", { optionsToCreate: [{}] }],
    ["deleted option", { optionsToDelete: ["o"] }],
    ["reorder", { optionOrder: ["a", "b"] }],
    ["value reorder", { optionValueOrder: { o: ["a"] } }],
  ] as const)("is true for a pending %s", (_n, patch) => {
    expect(hasPendingSubResourceChanges({ ...empty(), ...(patch as object) })).toBe(true);
  });
});

describe("withoutIds", () => {
  it("removes only the named ids and does not mutate", () => {
    const s = new Set(["a", "b"]);
    const r = withoutIds(s, ["a"]);
    expect([...r]).toEqual(["b"]);
    expect(s.size).toBe(2);
  });
});

describe("unconfirmedPurgeOf", () => {
  it("reads the warning and ids defensively", () => {
    expect(unconfirmedPurgeOf(null)).toEqual({ unconfirmed: false, resourceIds: [] });
    expect(unconfirmedPurgeOf({})).toEqual({ unconfirmed: false, resourceIds: [] });
    expect(unconfirmedPurgeOf({ warnings: ["translationPurgeUnconfirmed"] })).toEqual({
      unconfirmed: true,
      resourceIds: [],
    });
    expect(unconfirmedPurgeOf({ warnings: "x", unconfirmedPurge: ["r1", 3] })).toEqual({
      unconfirmed: true,
      resourceIds: ["r1"],
    });
  });
});
