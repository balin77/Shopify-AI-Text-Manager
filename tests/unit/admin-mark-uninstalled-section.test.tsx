/** The detail view's "Als deinstalliert markieren": gating, evidence, typed confirmation. */
import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { MarkUninstalledSection } from "~/components/admin/MarkUninstalledSection";
import type { UninstallReviewView } from "~/services/admin/uninstall-review.shared";

const SHOP = "demo-shop.myshopify.com";
const evidence = {
  connectionState: "needs_reauth", connectionStateReason: "no_token", connectionStateSince: "2026-10-01T00:00:00.000Z",
  derivedStatus: "needs_reauth", lastWebhookAt: "2026-09-01T00:00:00.000Z", lastApiOkAt: null, lastActivityAt: null,
  lastAuthAt: null, reinstallEvidenceAt: null, sessionsTotal: 1, hasToken: false, hasRefreshToken: false, migration: null,
};
function mount(view: UninstallReviewView) {
  const Stub = createRoutesStub([{ path: "/", Component: () => <MarkUninstalledSection review={view} /> }]);
  return render(<Stub initialEntries={["/"]} />);
}

describe("MarkUninstalledSection", () => {
  it("disables the button and says why when not eligible", async () => {
    mount({ shop: SHOP, eligible: false, refusal: "token_present", evidence });
    expect(await screen.findByText(/--force-with-token/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /markieren/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the evidence on click and enables submit only for the exact domain", async () => {
    mount({ shop: SHOP, eligible: true, refusal: null, evidence });
    fireEvent.click(await screen.findByRole("button", { name: /markieren…/ }));
    expect(screen.getByText(/Letzter Webhook/)).toBeTruthy();
    expect(screen.getByText(/30 Tage/)).toBeTruthy();
    const submit = screen.getByRole("button", { name: "Endgültig markieren" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    const input = screen.getByPlaceholderText(SHOP);
    fireEvent.change(input, { target: { value: "demo-shop" } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(input, { target: { value: SHOP } });
    expect(submit.disabled).toBe(false);
  });
});
