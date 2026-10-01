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

import { removePendingNewMedia, queuedResourceUrls, stripRefsFromGalleries } from "~/components/image-manager/delete-rollback";
describe("removePendingNewMedia", () => {
  it("drops queued entries by previewUrl and keeps the rest", () => {
    const list = [{ previewUrl: "blob:a" }, { previewUrl: "blob:b" }, {}];
    expect(removePendingNewMedia(list, ["blob:a"])).toEqual([{ previewUrl: "blob:b" }, {}]);
  });
});

describe("queued tile staging urls in variant galleries", () => {
  it("strips the removed queued tiles' resourceUrls from every gallery", () => {
    const queued = [
      { resourceUrl: "https://staged/a", previewUrl: "blob:a" },
      { resourceUrl: "https://staged/b", previewUrl: "blob:b" },
    ];
    const refs = queuedResourceUrls(queued, ["blob:a"]);
    expect(refs).toEqual(["https://staged/a"]);
    const g = { v1: ["gid://1", "https://staged/a"], v2: ["https://staged/b"] };
    const out = stripRefsFromGalleries(g, refs);
    expect(out.v1).toEqual(["gid://1"]);
    expect(out.v2).toBe(g.v2);
  });
});
