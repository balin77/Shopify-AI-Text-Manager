/**
 * The ONE shape the detached re-translation's Task ids travel in.
 *
 * Eight call sites hand them over and five surfaces read them back, so the
 * value of this module is that none of them gets to spell it differently.
 */

import { describe, it, expect } from "vitest";
import {
  collectRetranslationTaskIds,
  readRetranslationTaskIds,
  RETRANSLATION_TASK_IDS_FIELD,
} from "~/services/translations/retranslation-tasks.shared";
import { MAX_TASK_STATUS_IDS } from "~/services/tasks/task-watch.shared";

describe("collectRetranslationTaskIds", () => {
  it("folds ids and lists of ids into one deduplicated list", () => {
    // A product save starts up to three runs from three different places.
    expect(collectRetranslationTaskIds("a", ["b", "c"], undefined, null, "a")).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("drops what is not an id, rather than putting it on the wire", () => {
    expect(collectRetranslationTaskIds("", "   ", undefined, null)).toEqual([]);
    expect(collectRetranslationTaskIds(" spaced ")).toEqual(["spaced"]);
  });

  it("is bounded by the poll route's own cap, not by the caller", () => {
    const many = Array.from({ length: MAX_TASK_STATUS_IDS + 10 }, (_, i) => `t${i}`);
    expect(collectRetranslationTaskIds(many)).toHaveLength(MAX_TASK_STATUS_IDS);
  });
});

describe("readRetranslationTaskIds", () => {
  it("reads the field off a save response", () => {
    expect(readRetranslationTaskIds({ [RETRANSLATION_TASK_IDS_FIELD]: ["t1"] })).toEqual(["t1"]);
  });

  it("answers EMPTY for anything it cannot read — never a poll", () => {
    // `fetcher.data` is undefined for most of a page's life, and every surface
    // answers a different shape. An unreadable answer must mean "started
    // nothing", because that is the only reading that costs nothing.
    for (const value of [undefined, null, 0, "x", {}, { retranslationTaskIds: "t1" }, []]) {
      expect(readRetranslationTaskIds(value)).toEqual([]);
    }
  });
});
