/**
 * The options & metafields card's OWN validation refusals (empty option name,
 * blank option value, a new option with only blank values, a blank pending row,
 * a blank metafield) used to show a red message and return nothing, so the
 * page's other saves (gallery, alt texts, content) still ran and their green
 * "saved" replaced the red message. The press now answers "refused", exactly
 * like "waiting", and the callers stop on it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, renderHook } from "@testing-library/react";

const fetcher = { state: "idle", data: undefined, submit: vi.fn(), load: vi.fn(), Form: () => null };
vi.mock("react-router", () => ({ useFetcher: () => fetcher }));
vi.mock("../../app/utils/app-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/utils/app-fetch")>()),
  appFetch: (input: string, init?: RequestInit) => (init === undefined ? fetch(input) : fetch(input, init)),
}));

import { useProductSubResources } from "~/hooks/useProductSubResources";
import { installSaves } from "../helpers/sub-resource-save-harness";

const OPTION = "gid://shopify/ProductOption/1";
const VALUE = "gid://shopify/ProductOptionValue/1";
const META = "gid://shopify/Metafield/1";
const item = {
  id: "gid://shopify/Product/1",
  title: "Shirt",
  options: [{ id: OPTION, name: "Colour", position: 1, values: [{ id: VALUE, name: "Red" }] }],
  metafields: [{ id: META, namespace: "custom", key: "note", type: "single_line_text_field", value: "hello" }],
} as never;

const showInfoBox = vi.fn();
let saves: ReturnType<typeof installSaves>;

function setup() {
  return renderHook(() =>
    useProductSubResources({
      selectedItem: item,
      currentLanguage: "de",
      primaryLocale: "de",
      showInfoBox,
      strings: {},
    } as never),
  );
}

beforeEach(() => {
  saves = installSaves();
  showInfoBox.mockClear();
});

async function press(result: ReturnType<typeof setup>["result"]) {
  let answer: unknown;
  act(() => {
    answer = result.current.handlers.saveSubResources();
  });
  await saves.flush();
  return answer;
}

describe("saveSubResources returns 'refused' for its own validation", () => {
  it("empty option name", async () => {
    const { result } = setup();
    act(() => result.current.handlers.handlePrimaryOptionNameChange(OPTION, "   "));
    expect(await press(result)).toBe("refused");
    expect(saves.sent).toHaveLength(0);
    expect(showInfoBox).toHaveBeenCalledWith(expect.any(String), "critical");
  });

  it("blank value of an existing option", async () => {
    const { result } = setup();
    act(() => result.current.handlers.handlePrimaryOptionValueChange(OPTION, VALUE, ""));
    expect(await press(result)).toBe("refused");
    expect(saves.sent).toHaveLength(0);
    expect(showInfoBox).toHaveBeenCalledWith(expect.any(String), "critical");
  });

  it("new option whose values are all blank", async () => {
    const { result } = setup();
    act(() => result.current.handlers.handleCreateOption("Size", [""]));
    expect(await press(result)).toBe("refused");
    expect(saves.sent).toHaveLength(0);
  });

  it("pending row cleared to blank", async () => {
    const { result } = setup();
    act(() => result.current.handlers.handleAddOptionValue(OPTION, "Green"));
    act(() => result.current.handlers.handleEditPendingValue(OPTION, 0, "  "));
    expect(await press(result)).toBe("refused");
    expect(saves.sent).toHaveLength(0);
  });

  it("metafield of spaces only", async () => {
    const { result } = setup();
    act(() => result.current.handlers.handlePrimaryMetafieldChange(META, "   "));
    expect(await press(result)).toBe("refused");
    expect(saves.sent).toHaveLength(0);
    expect(showInfoBox).toHaveBeenCalledWith(expect.any(String), "critical");
  });

  it("a valid edit is still sent and does not answer 'refused'", async () => {
    const { result } = setup();
    act(() => result.current.handlers.handlePrimaryOptionNameChange(OPTION, "Couleur"));
    expect(await press(result)).toBeUndefined();
    expect(saves.sent).toHaveLength(1);
  });
});

describe("callers stop the whole page save on 'refused', like on 'waiting'", () => {
  const read = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");

  it("the editor's Save button does not run the other saves", () => {
    const src = read("app/components/UnifiedContentEditor.tsx");
    expect(src).toMatch(/subResult === "waiting" \|\| subResult === "refused"/);
  });

  it("the products page wrapper (gallery + alt saves) does not run them either", () => {
    const src = read("app/routes/app.products.tsx");
    expect(src).toMatch(/subResult === "waiting" \|\| subResult === "refused"/);
  });
});
