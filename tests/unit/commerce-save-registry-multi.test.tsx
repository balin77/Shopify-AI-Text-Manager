/**
 * The save bar's registry holds SEVERAL writers (the stock panel and the
 * per-language media drafts). A single slot let the second registrant replace
 * the first one's registration, dropping its unsaved edits from Save/Discard.
 */
import { describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { act, render } from "@testing-library/react";
import { useCommerceSaveRegistry, useRegisterCommerceSave, type CommerceSaveApi } from "~/contexts/CommerceSaveContext";

let registry: ReturnType<typeof useCommerceSaveRegistry>;

function Writer({ id, api }: { id?: string; api: CommerceSaveApi }) {
  const register = useRegisterCommerceSave(id);
  useEffect(() => {
    register(api);
    return () => register(null);
  }, [register, api]);
  return null;
}

function Harness({ children }: { children: React.ReactNode }) {
  registry = useCommerceSaveRegistry();
  return <registry.Provider value={registry.value}>{children}</registry.Provider>;
}

const mk = (over: Partial<CommerceSaveApi> = {}): CommerceSaveApi => ({
  hasChanges: false,
  saving: false,
  save: vi.fn(async () => undefined),
  discard: vi.fn(),
  ...over,
});

describe("commerce save registry with several writers", () => {
  it("reports changes while any writer has them, and saves and discards all of them", async () => {
    const stock = mk({ hasChanges: true });
    const media = mk({ hasChanges: true });
    render(<Harness><Writer api={stock} /><Writer id="localizedMedia" api={media} /></Harness>);
    expect(registry.hasChanges).toBe(true);
    await act(async () => { await registry.save(); });
    expect(stock.save).toHaveBeenCalledTimes(1);
    expect(media.save).toHaveBeenCalledTimes(1);
    act(() => registry.discard());
    expect(stock.discard).toHaveBeenCalledTimes(1);
    expect(media.discard).toHaveBeenCalledTimes(1);
  });

  it("one writer clearing does not clear the other's changes", () => {
    const stock = mk({ hasChanges: true });
    const media = mk({ hasChanges: false });
    render(<Harness><Writer api={stock} /><Writer id="localizedMedia" api={media} /></Harness>);
    expect(registry.hasChanges).toBe(true);
  });

  it("reports saving while either writer is busy", () => {
    render(<Harness><Writer api={mk()} /><Writer id="localizedMedia" api={mk({ saving: true })} /></Harness>);
    expect(registry.saving).toBe(true);
  });

  it("unregistering one leaves the other registered", () => {
    const stock = mk({ hasChanges: true });
    const { rerender } = render(<Harness><Writer api={stock} /><Writer id="localizedMedia" api={mk({ hasChanges: true })} /></Harness>);
    rerender(<Harness><Writer api={stock} /></Harness>);
    expect(registry.hasChanges).toBe(true);
    rerender(<Harness>{null}</Harness>);
    expect(registry.hasChanges).toBe(false);
  });
});
