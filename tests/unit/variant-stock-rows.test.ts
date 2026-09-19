/**
 * The stock table's aggregation, on its own.
 *
 * Three answers have to stay apart: a NUMBER (every member agrees), `null`
 * (nobody could read it — an em dash) and `"mixed"` (they know and disagree —
 * `≠`). Collapsing any two of them puts a figure in a row whose input writes
 * one quantity per variant, and a merchant reading that row as a total types
 * the number they want for the group into a field that gives it to each one.
 */

import { describe, it, expect } from "vitest";
import {
  buildStockRows,
  onHandFieldValue,
  totalCell,
  type StockMember,
} from "~/services/variant-stock-rows.shared";

/** One member, stocked at `l1` with 5 on hand unless told otherwise. Pass an
 *  empty list for a member that is not activated anywhere. */
function member(
  id: string,
  levels: Array<Partial<{ locationId: string; onHand: number | null }>> = [{}],
): StockMember {
  return {
    id,
    levelsTruncated: false,
    levels: levels.map((level) => ({
      locationId: level.locationId ?? "l1",
      locationName: "Schweiz",
      locationActive: true,
      onHand: level.onHand === undefined ? 5 : level.onHand,
      available: 4,
      committed: 1,
      unavailable: 0,
    })),
  };
}

describe("buildStockRows", () => {
  it("reports a number only where every member agrees", () => {
    const { rows } = buildStockRows([member("a"), member("b")], []);
    expect(rows[0].available).toBe(4);
    expect(rows[0].entries.map((e) => e.onHand)).toEqual([5, 5]);
    expect(onHandFieldValue(rows[0], {})).toBe("5");
  });

  it("reports a disagreement as `mixed`, not as a sum", () => {
    const { rows } = buildStockRows([member("a", [{ onHand: 5 }]), member("b", [{ onHand: 7 }])], []);
    // `available` is 4 on both fixtures, so only on hand differs.
    expect(rows[0].available).toBe(4);
    expect(onHandFieldValue(rows[0], {})).toBeNull();
  });

  it("calls a location MIXED when only some members are stocked there", () => {
    const { rows } = buildStockRows([member("a"), member("b", [])], []);
    expect(rows[0].stocked).toBe("mixed");
    // Every figure follows: a member that is not stocked here contributes no
    // number, and "we hold none" is a different claim from "we do not stock
    // this here".
    expect(rows[0].available).toBe("mixed");
    expect(onHandFieldValue(rows[0], {})).toBeNull();
  });

  it("offers the shop's other locations as rows the merchant can stock", () => {
    const { rows } = buildStockRows([member("a")], [
      { id: "l1", name: "Schweiz", isActive: true },
      { id: "l2", name: "Spanien", isActive: true },
    ]);
    expect(rows.map((r) => r.id)).toEqual(["l1", "l2"]);
    expect(rows[1].stocked).toBe(false);
    // Empty, never "0" — a pre-filled zero reads as "we hold none".
    expect(onHandFieldValue(rows[1], {})).toBe("");
  });

  it("suppresses them when ANY member's level window was cut off", () => {
    // The rows that came back are the first ten of more, so a location missing
    // from them is not evidence that it holds nothing — and an input there
    // would route into an activation that overwrites a real quantity with no
    // comparison.
    const truncated = { ...member("b"), levelsTruncated: true };
    const { rows, truncated: flag } = buildStockRows([member("a"), truncated], [
      { id: "l1", name: "Schweiz", isActive: true },
      { id: "l2", name: "Spanien", isActive: true },
    ]);
    expect(flag).toBe(true);
    expect(rows.map((r) => r.id)).toEqual(["l1"]);
  });

  it("leaves a CUT-OFF member out of a row it reports no level for", () => {
    // The same trap one level in: member b was cut off at ten locations, so its
    // silence about `l2` is not "unstocked" — and an edit key there would send
    // an ACTIVATION, which writes with no comparison at all.
    const truncated = { ...member("b", [{ locationId: "l1" }]), levelsTruncated: true };
    const { rows } = buildStockRows(
      [member("a", [{ locationId: "l1" }, { locationId: "l2", onHand: 3 }]), truncated],
      [],
    );
    const l2 = rows.find((r) => r.id === "l2")!;
    expect(l2.entries.map((e) => e.key)).toEqual(["a::l2"]);
    // …and it therefore reads as a's own row rather than as "half of them".
    expect(l2.stocked).toBe(true);
    expect(onHandFieldValue(l2, {})).toBe("3");
  });

  it("drops a row no member can speak for at all", () => {
    const a = { ...member("a", [{ locationId: "l1" }]), levelsTruncated: true };
    const b = { ...member("b", [{ locationId: "l2" }]), levelsTruncated: true };
    const { rows } = buildStockRows([a, b], []);
    // Each location is known to exactly one member, so each row keeps that one.
    expect(rows.map((r) => r.entries.map((e) => e.key))).toEqual([["a::l1"], ["b::l2"]]);
  });

  it("lets an EDIT decide the field, per member", () => {
    const { rows } = buildStockRows([member("a", [{ onHand: 5 }]), member("b", [{ onHand: 7 }])], []);
    // One member edited in a single scope and the other not: `≠`, rather than
    // whichever number happens to sort first.
    expect(onHandFieldValue(rows[0], { "a::l1": "9" })).toBeNull();
    expect(onHandFieldValue(rows[0], { "a::l1": "9", "b::l1": "9" })).toBe("9");
  });
});

describe("totalCell", () => {
  it("adds the cells it is given", () => {
    expect(totalCell([5, 0])).toBe(5);
  });

  it("is UNKNOWN as soon as one number could not be read", () => {
    expect(totalCell([5, null])).toBeNull();
  });

  it("is `mixed` as soon as one row disagrees — mixed outranks unknown", () => {
    // A sum of the rest under the word "Total" describes fewer locations than
    // the column above it.
    expect(totalCell([5, "mixed", null])).toBe("mixed");
  });

  it("substitutes nothing of its own", () => {
    // The "a location nobody stocks holds 0" rule is the CALLER's, and it is
    // true of three columns and false of the fourth: on hand, a not-stocked
    // row is where a merchant types the quantity that starts stocking it, and
    // a zero substituted in here would swallow their number.
    expect(totalCell([5, null])).toBeNull();
  });
});
