/**
 * `useHydrated` is the whole defence against the hydration mismatch Sentry
 * recorded on master (React production error #418, followed by the phantom
 * "Invalid hook call" that root.tsx's try/catch reported).
 *
 * The contract that matters is TIMING: the flag must still be `false` for the
 * first client render, because that is the render React compares against the
 * server's HTML. So the test hydrates real server output and asserts React
 * never reaches `onRecoverableError` — which is exactly the signal that fired
 * in production.
 */
import { describe, it, expect, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { act } from "@testing-library/react";
import { useHydrated } from "~/hooks/useHydrated";
import { formatDateTime } from "~/utils/format";

const INSTANT = "2026-08-28T16:00:21.070Z";

/** Mirrors the real call sites: a timestamp whose local rendering only appears
 *  once the client has mounted. */
function Probe() {
  const hydrated = useHydrated();
  return <span data-testid="v">{formatDateTime(INSTANT, hydrated)}</span>;
}

/** What the old code did — the shape that produced #418. */
function BrokenProbe() {
  return <span data-testid="v">{new Date(INSTANT).toLocaleString()}</span>;
}

function hydrate(node: React.ReactElement, serverHtml: string) {
  const container = document.createElement("div");
  container.innerHTML = serverHtml;
  document.body.appendChild(container);
  const onRecoverableError = vi.fn();
  act(() => {
    hydrateRoot(container, node, { onRecoverableError });
  });
  return { container, onRecoverableError };
}

describe("useHydrated", () => {
  it("renders the deterministic value on the server", () => {
    expect(renderToString(<Probe />)).toContain("2026-08-28 16:00 UTC");
  });

  it("hydrates server output without a recoverable error", () => {
    const html = renderToString(<Probe />);
    const { container, onRecoverableError } = hydrate(<Probe />, html);

    expect(onRecoverableError).not.toHaveBeenCalled();
    // …and after the effect the merchant sees their local time.
    expect(container.textContent).toBe(new Date(INSTANT).toLocaleString());
  });

  it("proves the guard is what fixes it: the unguarded shape does mismatch", () => {
    // Server HTML from a machine in a DIFFERENT time zone than the "browser"
    // running this test. Simulated by handing hydration a value the client
    // cannot reproduce — the exact production situation (Railway = UTC,
    // merchant = CEST).
    const foreignHtml = '<span data-testid="v">28.8.2026, 99:99:99</span>';
    const { onRecoverableError } = hydrate(<BrokenProbe />, foreignHtml);

    expect(onRecoverableError).toHaveBeenCalled();
  });
});
