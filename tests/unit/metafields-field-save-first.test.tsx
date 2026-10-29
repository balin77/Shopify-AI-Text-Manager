/**
 * The options & metafields card's PRIMARY 🌍 on a metafield translates the
 * SAVED value into every language. With an unsaved edit of that field the
 * button is disabled with `t.common.saveFirstSource` (CLAUDE.md: a button
 * whose SOURCE is an unsaved primary value is disabled until it is saved), and
 * the hook refuses it as a backstop.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, render, cleanup, renderHook, screen } from "@testing-library/react";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";

const fetcher = { state: "idle", data: undefined, submit: vi.fn(), load: vi.fn(), Form: () => null };
vi.mock("react-router", () => ({ useFetcher: () => fetcher }));
vi.mock("../../app/utils/app-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/utils/app-fetch")>()),
  appFetch: (input: string, init?: RequestInit) => (init === undefined ? fetch(input) : fetch(input, init)),
}));

import { MetafieldsField } from "~/components/unified/MetafieldsField";
import * as subResourcesModule from "~/hooks/useProductSubResources";
import { clearAllForResource } from "~/hooks/useAIOperationsStore";
import { isPrimaryMetafieldUnsaved } from "~/services/product-metafields.shared";

const ITEM = "gid://shopify/Product/7";
const MF = "gid://shopify/Metafield/9";
const mf = { id: MF, namespace: "custom", key: "material", value: "Baumwolle", type: "single_line_text_field" };
const SAVE_FIRST = "Erst speichern";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("isPrimaryMetafieldUnsaved", () => {
  it("no edit, or an edit equal to the saved value, is not unsaved", () => {
    expect(isPrimaryMetafieldUnsaved(mf, undefined)).toBe(false);
    expect(isPrimaryMetafieldUnsaved(mf, "Baumwolle")).toBe(false);
  });
  it("a changed, emptied or refused (spaces only) edit is unsaved", () => {
    expect(isPrimaryMetafieldUnsaved(mf, "Leinen")).toBe(true);
    expect(isPrimaryMetafieldUnsaved(mf, "")).toBe(true);
    expect(isPrimaryMetafieldUnsaved(mf, "  ")).toBe(true);
  });
  it("a list retyped with the same entries is not unsaved", () => {
    const list = { ...mf, type: "list.single_line_text_field", value: '["a","b"]' };
    expect(isPrimaryMetafieldUnsaved(list, "a\nb")).toBe(false);
    expect(isPrimaryMetafieldUnsaved(list, "a\nc")).toBe(true);
  });
});

describe("MetafieldsField primary translate button", () => {
  const renderField = (primaryValues: Record<string, string>) =>
    render(
      <AppProvider i18n={en}>
        <MetafieldsField
          metafields={[mf]}
          isPrimaryLocale
          currentLanguage="de"
          translations={{}}
          onTranslate={vi.fn()}
          onMetafieldChange={vi.fn()}
          onPrimaryMetafieldChange={vi.fn()}
          primaryValues={primaryValues}
          t={{ translateButton: "Übersetzen", saveFirstSource: SAVE_FIRST }}
        />
      </AppProvider>,
    );
  const button = () => screen.getByRole("button", { name: /Übersetzen/ }) as HTMLButtonElement;
  // Polaris marks a disabled button with the attribute AND aria-disabled.
  const isDisabled = () => button().disabled || button().getAttribute("aria-disabled") === "true";

  it("is enabled without an unsaved edit", () => {
    renderField({});
    expect(isDisabled()).toBe(false);
  });

  it("is DISABLED while the field holds an unsaved edit", () => {
    renderField({ [MF]: "Leinen" });
    expect(isDisabled()).toBe(true);
  });

  it("an edit typed back to the saved value enables it again", () => {
    renderField({ [MF]: "Baumwolle" });
    expect(isDisabled()).toBe(false);
  });
});

describe("useProductSubResources.translateMetafield on the primary locale", () => {
  const showInfoBox = vi.fn();
  beforeEach(() => {
    showInfoBox.mockClear();
    clearAllForResource(ITEM);
    (subResourcesModule as { __resetSubResourceSpinnerHolds?: () => void }).__resetSubResourceSpinnerHolds?.();
  });

  const setup = () =>
    renderHook(() =>
      subResourcesModule.useProductSubResources({
        selectedItem: { id: ITEM, title: "Shirt", options: [], metafields: [mf], subResourceTranslations: {} },
        currentLanguage: "de",
        primaryLocale: "de",
        enabledLanguages: ["de", "en"],
        showInfoBox,
        strings: { saveFirstSource: SAVE_FIRST },
      } as never),
    );

  it("translates the saved value to every language when the field is clean", async () => {
    const fetchMock = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = setup();
    act(() => result.current.handlers.translateMetafield(MF));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const form = (fetchMock.mock.calls[0] as unknown as [string, { body: FormData }])[1].body;
    expect(form.get("action")).toBe("translateSubResourceToAllLocales");
    expect(JSON.parse(String(form.get("sourceData")))[0]).toMatchObject({ resourceId: MF, value: "Baumwolle" });
  });

  it("REFUSES (backstop) while the field holds an unsaved edit, and sends nothing", () => {
    const fetchMock = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = setup();
    act(() => result.current.handlers.handlePrimaryMetafieldChange(MF, "Leinen"));
    act(() => result.current.handlers.translateMetafield(MF));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(showInfoBox).toHaveBeenCalledWith(SAVE_FIRST, "warning");
  });
});
