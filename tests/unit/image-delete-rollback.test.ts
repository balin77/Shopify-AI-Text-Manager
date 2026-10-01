import { describe, it, expect } from "vitest";
import { captureRemoved, reinsertRemoved, deleteOutcome } from "~/components/image-manager/delete-rollback";

describe("delete rollback", () => {
  it("re-inserts removed entries at their positions in the current list", () => {
    const original = ["a", "b", "c", "d"];
    const removed = captureRemoved(original, v => v === "b" || v === "d");
    // meanwhile the merchant appended "e"
    expect(reinsertRemoved(["a", "c", "e"], removed)).toEqual(["a", "b", "c", "d", "e"]);
  });
  it("does not duplicate and clamps the index", () => {
    const removed = captureRemoved(["a", "b", "c"], v => v === "c");
    expect(reinsertRemoved(["a"], removed)).toEqual(["a", "c"]);
    expect(reinsertRemoved(["a", "c"], removed)).toEqual(["a", "c"]);
  });
  it("decides the outcome", () => {
    expect(deleteOutcome(false, null)).toBe("deleteFailed");
    expect(deleteOutcome(true, false)).toBe("clearFailed");
    expect(deleteOutcome(true, true)).toBe("ok");
    expect(deleteOutcome(true, null)).toBe("ok");
  });
});

import { removePendingNewMedia } from "~/components/image-manager/delete-rollback";
describe("removePendingNewMedia", () => {
  it("drops queued entries by previewUrl and keeps the rest", () => {
    const list = [{ previewUrl: "blob:a" }, { previewUrl: "blob:b" }, {}];
    expect(removePendingNewMedia(list, ["blob:a"])).toEqual([{ previewUrl: "blob:b" }, {}]);
  });
});
