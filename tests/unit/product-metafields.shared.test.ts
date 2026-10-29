import { describe, it, expect } from "vitest";
import {
  formatListMetafieldLines,
  isMetafieldValueEditable,
  listValueSurvivesLines,
  metafieldDisplayValue,
  metafieldInputErrors,
  normalizeListEntry,
  parseListMetafieldLines,
  primaryMetafieldChange,
  splitClearedMetafieldSlots,
  storedListMetafieldValueProblem,
} from "~/services/product-metafields.shared";
import { formatListMetafieldValue, parseListMetafieldInput } from "~/services/bulk-editor/columns.shared";

const row = (id: string, key: string, value: string) => ({ id, namespace: "custom", key, value, type: "single_line_text_field" });

describe("splitClearedMetafieldSlots", () => {
  it("separates real metafields from cleared slots", () => {
    const { metafields, clearedMetafields } = splitClearedMetafieldSlots([row("1", "a", "x"), row("2", "b", "")]);
    expect(metafields.map((m) => m.id)).toEqual(["1"]);
    expect(clearedMetafields.map((m) => m.id)).toEqual(["2"]);
  });

  it("never shows a field twice: a slot beside a real row of the same key, or a second slot, is dropped", () => {
    const { metafields, clearedMetafields } = splitClearedMetafieldSlots([
      row("1", "a", ""),
      row("2", "a", "x"),
      row("3", "b", ""),
      row("4", "b", ""),
    ]);
    expect(metafields.map((m) => m.id)).toEqual(["2"]);
    expect(clearedMetafields.map((m) => m.id)).toEqual(["3"]);
  });
});

describe("the bulk editor's list conversion is unchanged by the refactor", () => {
  it("formats with ' | ' and parses on '|'", () => {
    expect(formatListMetafieldValue('["a","b"]')).toBe("a | b");
    expect(formatListMetafieldValue("not json")).toBe("not json");
    expect(parseListMetafieldInput("a | b")).toEqual({ ok: true, values: ["a", "b"] });
    expect(parseListMetafieldInput("a || b")).toEqual({ ok: false, error: "emptyValue" });
  });
});

describe("one entry per line", () => {
  const LIST = "list.single_line_text_field";

  it("formats the stored JSON one entry per line", () => {
    expect(formatListMetafieldLines('["Rot","Blau"]')).toBe("Rot\nBlau");
    expect(formatListMetafieldLines("")).toBe("");
  });

  it("parses lines into JSON, trimming entries and ignoring blank lines", () => {
    expect(parseListMetafieldLines(LIST, " Rot \n\nBlau\r\n")).toEqual({ ok: true, value: '["Rot","Blau"]' });
  });

  it("an empty text is a clear; spaces only are refused", () => {
    expect(parseListMetafieldLines(LIST, "")).toEqual({ ok: true, value: "" });
    expect(parseListMetafieldLines(LIST, " \n ")).toEqual({ ok: false, errors: [{ code: "blank", line: 0, entry: "" }] });
  });

  it("an entry with '|' survives (the grid would split it)", () => {
    expect(parseListMetafieldLines(LIST, "A | B")).toEqual({ ok: true, value: '["A | B"]' });
  });

  it("checks every line against the element type and names each failing line", () => {
    expect(parseListMetafieldLines("list.number_integer", "1\nzwei\n3\n4.5")).toEqual({
      ok: false,
      errors: [
        { code: "invalidInteger", line: 2, entry: "zwei" },
        { code: "invalidInteger", line: 4, entry: "4.5" },
      ],
    });
    expect(parseListMetafieldLines("list.number_integer", "1\n-2")).toEqual({ ok: true, value: "[1,-2]" });
  });

  it.each([
    ["number_decimal", "4,5", { ok: true, value: "4.5" }],
    ["number_decimal", "4.5.1", { ok: false, code: "invalidDecimal" }],
    ["date", "2026-02-28", { ok: true, value: "2026-02-28" }],
    ["date", "2026-02-30", { ok: false, code: "invalidDate" }],
    ["date_time", "2026-02-28T10:00:00Z", { ok: true, value: "2026-02-28T10:00:00Z" }],
    ["date_time", "morgen", { ok: false, code: "invalidDateTime" }],
    ["url", "https://example.com/a", { ok: true, value: "https://example.com/a" }],
    ["url", "javascript:alert(1)", { ok: false, code: "invalidUrl" }],
    ["url", "example.com", { ok: false, code: "invalidUrl" }],
    ["color", "#ff0000", { ok: true, value: "#ff0000" }],
    ["color", "red", { ok: false, code: "invalidColor" }],
    ["product_reference", "gid://shopify/Product/1", { ok: false, code: "unsupportedType" }],
  ])("%s %s", (type, entry, expected) => {
    expect(normalizeListEntry(type, entry)).toEqual(expected);
  });

  it("an unsupported element type refuses the whole field", () => {
    expect(parseListMetafieldLines("list.product_reference", "x")).toEqual({
      ok: false,
      errors: [{ code: "unsupportedType", line: 0, entry: "" }],
    });
  });
});

describe("which lists the card can edit", () => {
  it("only a value the line form carries back unchanged", () => {
    expect(listValueSurvivesLines('["a","b"]')).toBe(true);
    expect(listValueSurvivesLines("")).toBe(true);
    expect(listValueSurvivesLines('["a\\nb"]')).toBe(false);
    expect(listValueSurvivesLines("not json")).toBe(false);
    expect(isMetafieldValueEditable({ type: "list.single_line_text_field", value: "not json" })).toBe(false);
    expect(isMetafieldValueEditable({ type: "list.product_reference", value: '["gid://shopify/Product/1"]' })).toBe(false);
    expect(isMetafieldValueEditable({ type: "single_line_text_field", value: "x" })).toBe(true);
  });

  it("display value: lists one per line, everything else verbatim", () => {
    expect(metafieldDisplayValue({ type: "list.single_line_text_field", value: '["a","b"]' })).toBe("a\nb");
    expect(metafieldDisplayValue({ type: "single_line_text_field", value: '["a"]' })).toBe('["a"]');
    expect(metafieldDisplayValue({ type: "list.single_line_text_field", value: "broken" })).toBe("broken");
  });

  it("errors only for lists", () => {
    expect(metafieldInputErrors("single_line_text_field", "anything")).toEqual([]);
    expect(metafieldInputErrors("list.color", "#fff")).toEqual([{ code: "invalidColor", line: 1, entry: "#fff" }]);
  });
});

describe("primaryMetafieldChange", () => {
  const text = { type: "single_line_text_field", value: "Wolle" };
  const list = { type: "list.single_line_text_field", value: '["Rot","Blau"]' };

  it("text: unchanged / clear / blank / value", () => {
    expect(primaryMetafieldChange(text, "Wolle")).toEqual({ kind: "unchanged" });
    expect(primaryMetafieldChange(text, "")).toEqual({ kind: "value", value: "" });
    expect(primaryMetafieldChange(text, "  ")).toMatchObject({ kind: "refused", reason: "blank" });
    expect(primaryMetafieldChange(text, "Leinen")).toEqual({ kind: "value", value: "Leinen" });
  });

  it("a cleared slot with a typed value becomes a value", () => {
    expect(primaryMetafieldChange({ type: "single_line_text_field", value: "" }, "x")).toEqual({ kind: "value", value: "x" });
    expect(primaryMetafieldChange({ type: "single_line_text_field", value: "" }, "")).toEqual({ kind: "unchanged" });
  });

  it("list: compared by stored JSON, refused with the line errors", () => {
    expect(primaryMetafieldChange(list, "Rot\nBlau")).toEqual({ kind: "unchanged" });
    expect(primaryMetafieldChange(list, "Rot\nBlau\n")).toEqual({ kind: "unchanged" });
    expect(primaryMetafieldChange(list, "Rot")).toEqual({ kind: "value", value: '["Rot"]' });
    expect(primaryMetafieldChange(list, "")).toEqual({ kind: "value", value: "" });
    expect(primaryMetafieldChange({ type: "list.number_integer", value: "[1]" }, "eins")).toMatchObject({
      kind: "refused",
      reason: "listInvalid",
      errors: [{ code: "invalidInteger", line: 1, entry: "eins" }],
    });
  });
});

describe("storedListMetafieldValueProblem (the server's check)", () => {
  it.each([
    ["list.single_line_text_field", '["a","b"]', null],
    ["list.number_integer", "[1,2]", null],
    ["list.number_integer", '["x"]', "invalidInteger"],
    ["list.number_decimal", '["4,5"]', "invalidDecimal"],
    ["list.single_line_text_field", "[]", "emptyEntry"],
    ["list.single_line_text_field", '[" a"]', "emptyEntry"],
    ["list.single_line_text_field", "nope", "emptyEntry"],
    ["list.product_reference", '["gid://shopify/Product/1"]', "unsupportedType"],
  ])("%s %s → %s", (type, value, expected) => {
    expect(storedListMetafieldValueProblem(type, value)).toBe(expected);
  });
});
