/**
 * The reload polls the revalidator until it is idle again. React Router hands out
 * a NEW revalidator object per state change, so one captured at the click stays
 * "idle" for ever and the wait ended after its fallback whatever the loader did
 * (the card then re-read the OLD item). The button reads the LATEST one.
 */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import React from "react";

const startReload = vi.fn(async () => {});
vi.mock("~/hooks/useReloadingResources", () => ({
  startReload: (...args: unknown[]) => (startReload as any)(...args),
  useIsReloading: () => false,
}));
vi.mock("@shopify/polaris", () => ({
  Button: (props: any) => <button onClick={props.onClick} aria-label={props.accessibilityLabel} />,
  Tooltip: (props: any) => <>{props.children}</>,
}));
vi.mock("@shopify/polaris-icons", () => ({ RefreshIcon: {} }));

import { ReloadButton } from "~/components/ReloadButton";

describe("ReloadButton", () => {
  it("getState() follows the revalidator of the LATEST render, not the one at the click", () => {
    const first = { state: "idle" as const, revalidate: vi.fn() };
    const { getByRole, rerender } = render(
      <ReloadButton resourceId="gid://x/1" resourceType={"product" as any} locale="en" revalidator={first} />,
    );
    fireEvent.click(getByRole("button"));
    const opts = (startReload.mock.calls[0] as unknown[])[3] as { getState: () => string; revalidate: () => void };
    expect(opts.getState()).toBe("idle");

    const second = { state: "loading" as const, revalidate: vi.fn() };
    rerender(<ReloadButton resourceId="gid://x/1" resourceType={"product" as any} locale="en" revalidator={second} />);
    expect(opts.getState()).toBe("loading"); // the captured object would still say "idle"
    opts.revalidate();
    expect(second.revalidate).toHaveBeenCalledTimes(1);
    expect(first.revalidate).not.toHaveBeenCalled();
  });
});
