/**
 * The confirmation dialog of "add missing translations" (phase 1c): what it
 * shows for each estimate state, and that Cancel/Start do what they say.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import { TranslateConfirmModal, formatEstimateMoney, type ConfirmEstimateState } from "~/components/bulk-editor/TranslateConfirmModal";
import { de as deStrings } from "~/i18n/de";
import { en as enStrings } from "~/i18n/en";
import { es as esStrings } from "~/i18n/es";
import type { TranslateEstimate } from "~/services/bulk-editor/translate-estimate.shared";

const strings = (deStrings as any).bulkEditor.translateMissing.confirm;

const estimate = (over: Partial<TranslateEstimate> = {}): TranslateEstimate => ({
  units: 1234,
  requests: 56,
  inputTokens: 12_345,
  outputTokens: 23_456,
  costMicros: 1_500_000,
  pricedAtCeiling: false,
  packaged: false,
  source: "byo",
  skippedOverCap: 0,
  scanTruncated: false,
  ...over,
});

function mount(
  state: ConfirmEstimateState,
  handlers: { onCancel: () => void; onStart: () => void; mode?: "sync" | "batch"; onModeChange?: (m: "sync" | "batch") => void } = {
    onCancel: vi.fn(),
    onStart: vi.fn(),
  },
) {
  render(
    <AppProvider i18n={en}>
      <TranslateConfirmModal
        open
        state={state}
        locale="de"
        maxUnits={2000}
        strings={strings}
        mode={handlers.mode ?? "sync"}
        onModeChange={handlers.onModeChange ?? (() => undefined)}
        onCancel={handlers.onCancel}
        onStart={handlers.onStart}
      />
    </AppProvider>,
  );
  return handlers;
}

afterEach(cleanup);

const startDisabled = (): boolean => {
  const button = screen.getByRole("button", { name: "Jetzt starten" });
  return (button as HTMLButtonElement).disabled || button.getAttribute("aria-disabled") === "true";
};

describe("TranslateConfirmModal", () => {
  it("shows units, requests, tokens and the cost, numbers in the app locale", () => {
    mount({ status: "ready", estimate: estimate() });
    expect(screen.getByText(/1\.234 Übersetzungen/)).toBeTruthy();
    expect(screen.getByText(/ca\. 56 KI-Anfragen/)).toBeTruthy();
    // Rounded UP to the next hundred.
    expect(screen.getByText(/12\.400 Eingabe- und 23\.500 Ausgabe-Token/)).toBeTruthy();
    expect(screen.getByText(/Geschätzte Kosten: ca\. 1,50/)).toBeTruthy();
    // Own key: the provider bills.
    expect(screen.getByText(/Ihr KI-Anbieter/)).toBeTruthy();
  });

  it("starts through the Start button and cancels through Cancel", () => {
    const h = mount({ status: "ready", estimate: estimate() });
    fireEvent.click(screen.getByRole("button", { name: "Jetzt starten" }));
    expect(h.onStart).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(h.onCancel).toHaveBeenCalledTimes(1);
  });

  it("an unpriced provider reads 'nicht schätzbar' and a ceiling price reads 'bis zu'", () => {
    mount({ status: "ready", estimate: estimate({ costMicros: null }) });
    expect(screen.getByText(/nicht schätzbar/)).toBeTruthy();
    cleanup();
    mount({ status: "ready", estimate: estimate({ pricedAtCeiling: true }) });
    expect(screen.getByText(/bis zu/)).toBeTruthy();
  });

  it("managed: names the share of the remaining budget, and warns when it is exceeded but still allows Start", () => {
    mount({
      status: "ready",
      estimate: estimate({
        costMicros: 1_000_000,
        budget: { remainingMicros: 4_000_000, limitMicros: 10_000_000, wouldExceed: false },
      }),
    });
    expect(screen.getByText(/25 % Ihres verbleibenden KI-Budgets/)).toBeTruthy();
    cleanup();
    const h = mount({
      status: "ready",
      estimate: estimate({ budget: { remainingMicros: 100, limitMicros: 10_000_000, wouldExceed: true } }),
    });
    expect(screen.getByText(/über Ihrem verbleibenden KI-Budget/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Jetzt starten" }));
    expect(h.onStart).toHaveBeenCalled();
  });

  it("managed with a budget that could not be read: a neutral line, never 'your provider bills you'", () => {
    mount({ status: "ready", estimate: estimate({ source: "managed" }) });
    expect(screen.getByText(/KI-Budget konnte gerade nicht gelesen werden/)).toBeTruthy();
    expect(screen.queryByText(/Ihr KI-Anbieter/)).toBeNull();
  });

  it("nothing missing: says so and offers no Start", () => {
    mount({ status: "nothing" });
    expect(screen.getByText(/Es gibt nichts zu übersetzen/)).toBeTruthy();
    expect(startDisabled()).toBe(true);
  });

  it("names units left for the next run", () => {
    mount({ status: "ready", estimate: estimate({ skippedOverCap: 300 }) });
    expect(screen.getByText(/300 weitere Übersetzungen passen nicht/)).toBeTruthy();
  });

  it("loading: Start is disabled; failure: 'Schätzung nicht verfügbar' and Start stays allowed", () => {
    mount({ status: "loading" });
    expect(startDisabled()).toBe(true);
    cleanup();
    const h = mount({ status: "unavailable" });
    expect(screen.getByText(/Schätzung nicht verfügbar/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Jetzt starten" }));
    expect(h.onStart).toHaveBeenCalled();
  });

  it("a refusal (no key) shows the server's sentence and blocks Start", () => {
    mount({ status: "refused", message: "Please add your API key." });
    expect(screen.getByText(/Please add your API key\./)).toBeTruthy();
    expect(startDisabled()).toBe(true);
  });

  it("money below one cent shows the bound, never 0,00", () => {
    expect(formatEstimateMoney(3_000, "de").tiny).toBe(true);
    expect(formatEstimateMoney(3_000, "de").text).toContain("0,01");
    expect(formatEstimateMoney(2_500_000, "en").tiny).toBe(false);
  });

  it("all three languages carry the same confirm keys", () => {
    const keys = (o: any) => Object.keys(o.bulkEditor.translateMissing.confirm).sort();
    expect(keys(enStrings)).toEqual(keys(deStrings));
    expect(keys(esStrings)).toEqual(keys(deStrings));
  });
});

describe("the mode choice (Sofort / Günstiger, Ergebnis bis zu 24 Stunden)", () => {
  const withBatch = (over: Partial<NonNullable<TranslateEstimate["batch"]>> = {}) =>
    estimate({ batch: { requests: 9, inputTokens: 10_000, outputTokens: 20_000, costMicros: 800_000, pricedAtCeiling: false, ...over } });

  it("is NOT offered without a batch alternative in the estimate (other providers, a taster, a refused shop)", () => {
    mount({ status: "ready", estimate: estimate() });
    expect(screen.queryByText("Günstiger, Ergebnis bis zu 24 Stunden")).toBeNull();
    expect(screen.queryByText("Sofort")).toBeNull();
  });

  it("is a radio choice with 'Sofort' preselected and the owner-approved wording for the other option", () => {
    mount({ status: "ready", estimate: withBatch() });
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios).toHaveLength(2);
    expect(screen.getByText("Sofort")).toBeTruthy();
    expect(screen.getByText("Günstiger, Ergebnis bis zu 24 Stunden")).toBeTruthy();
    expect(radios[0].checked).toBe(true);
    expect(radios[1].checked).toBe(false);
  });

  it("shows BOTH prices: the live estimate and the cheaper batch one", () => {
    mount({ status: "ready", estimate: withBatch() });
    expect(screen.getByText(/Geschätzte Kosten: ca\. 1,50/)).toBeTruthy();
    expect(screen.getByText(/Im günstigeren Modus: ca\. 0,80/)).toBeTruthy();
  });

  it("choosing the cheaper mode reports it, and the start button then says so", () => {
    const onModeChange = vi.fn();
    mount({ status: "ready", estimate: withBatch() }, { onCancel: vi.fn(), onStart: vi.fn(), onModeChange });
    fireEvent.click(screen.getAllByRole("radio")[1]);
    expect(onModeChange).toHaveBeenCalledWith("batch");
    cleanup();
    mount({ status: "ready", estimate: withBatch() }, { onCancel: vi.fn(), onStart: vi.fn(), mode: "batch" });
    expect(screen.getByRole("button", { name: "Günstiger starten" })).toBeTruthy();
  });

  it("a batch that cannot reserve its worst case disables the start (the server would refuse it); 'Sofort' stays startable", () => {
    const blocked = withBatch({ reserveMicros: 9_000_000, wouldExceed: true });
    mount({ status: "ready", estimate: blocked }, { onCancel: vi.fn(), onStart: vi.fn(), mode: "batch" });
    expect(screen.getByText(/im Voraus reserviert/)).toBeTruthy();
    const button = screen.getByRole("button", { name: "Günstiger starten" });
    expect((button as HTMLButtonElement).disabled || button.getAttribute("aria-disabled") === "true").toBe(true);
    cleanup();
    mount({ status: "ready", estimate: blocked }, { onCancel: vi.fn(), onStart: vi.fn(), mode: "sync" });
    expect(startDisabled()).toBe(false);
  });

  it("a stale 'batch' mode without a batch alternative behaves as 'Sofort'", () => {
    mount({ status: "ready", estimate: estimate() }, { onCancel: vi.fn(), onStart: vi.fn(), mode: "batch" });
    expect(screen.getByRole("button", { name: "Jetzt starten" })).toBeTruthy();
  });
});

