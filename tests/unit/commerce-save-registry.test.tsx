/**
 * The panel, the registry and the provider TOGETHER.
 *
 * `commerce-field.render.test.tsx` renders the panel on its own, where
 * `useRegisterCommerceSave()` resolves to a no-op — so it cannot see anything
 * about the registration. That gap let a render loop ship: the editor passes
 * the panel a freshly built `t` object on every render, the panel's `save`
 * callback depends on `t`, the registration effect depends on `save`, and the
 * registry called `setState` for every new identity. Select a product and the
 * editor re-rendered until React gave up.
 *
 * The rule this file pins is therefore not "the registry works" but "wiring the
 * three together SETTLES" — the property that was actually violated.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useEffect, useState } from "react";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import { CommerceField } from "~/components/unified/CommerceField";
import { useCommerceSaveRegistry } from "~/contexts/CommerceSaveContext";

let renders = 0;

/** Mimics the editor: registry here, provider around it, and — the part that
 *  mattered — a `t` bag rebuilt inline on every render. */
function Editor() {
  const commerceSave = useCommerceSaveRegistry();
  const [, force] = useState(0);
  renders += 1;
  useEffect(() => {
    // A parent that re-renders for its own reasons, exactly once. Without the
    // loop this settles; with it, it never does.
    if (renders === 1) force(1);
  }, []);
  return (
    <commerceSave.Provider value={commerceSave.value}>
      <span data-testid="dirty">{String(commerceSave.hasChanges)}</span>
      <CommerceField
        productId="gid://shopify/Product/1"
        label="Stock"
        isPrimaryLocale
        t={{ warnings: {}, enumLabels: {} }}
      />
    </commerceSave.Provider>
  );
}

beforeEach(() => {
  renders = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        variants: [],
        variantsTruncated: false,
        channels: [],
        channelsTruncated: false,
        shopLocations: [],
      }),
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CommerceField + save registry", () => {
  it("settles instead of re-rendering forever", async () => {
    render(<AppProvider i18n={en}><Editor /></AppProvider>);

    await waitFor(() => expect(screen.getByTestId("dirty")).toBeTruthy());
    // Generous on purpose: the loop produced hundreds before React threw, so
    // any honest number separates the two cases.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(renders).toBeLessThan(15);
  });

  it("reports a clean panel as not dirty", async () => {
    render(<AppProvider i18n={en}><Editor /></AppProvider>);
    await waitFor(() => expect(screen.getByTestId("dirty").textContent).toBe("false"));
  });
});
