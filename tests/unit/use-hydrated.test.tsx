/**
 * `useHydrated` is the whole defence against the hydration mismatch Sentry
 * recorded on master (React production error #418, followed by the phantom
 * "Invalid hook call" that root.tsx's try/catch reported as an app failure).
 *
 * The contract that matters is TIMING: the flag must still be `false` for the
 * FIRST client render, because that is the render React compares against the
 * server's HTML. A `typeof window` check would be true by then and mismatch
 * anyway — so the tests below are written to FAIL for that implementation,
 * not just for a missing flag.
 *
 * The production situation is reproduced literally: the server renders in one
 * time zone (Railway = UTC) and the browser is in another (the merchant was on
 * CEST). `withTimeZone` renders the server HTML under a different zone than
 * the one hydration then runs in.
 */
import { describe, it, expect, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { act, render } from "@testing-library/react";
import { useHydrated } from "~/hooks/useHydrated";
import { formatDateTime } from "~/utils/format";

const INSTANT = "2026-08-28T16:00:21.070Z";
/** Far enough from the test runner's zone that the rendered DAY differs too. */
const SERVER_TZ = "Pacific/Auckland";

function withTimeZone<T>(tz: string, fn: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

/** Every value this component renders, in order. `rendered[0]` is the render
 *  React compares against the server HTML — the one the contract is about. */
const rendered: string[] = [];

/** Mirrors the real call sites. */
function Probe() {
  const hydrated = useHydrated();
  const value = formatDateTime(INSTANT, hydrated);
  rendered.push(value);
  return <span>{value}</span>;
}

/** What the call sites did before the fix — the shape that produced #418. */
function BrokenProbe() {
  return <span>{new Date(INSTANT).toLocaleString()}</span>;
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
  it("renders a value the server can actually produce", () => {
    expect(renderToString(<Probe />)).toContain("2026-08-28 16:00 UTC");
  });

  it("is still false for the FIRST client render, then flips", () => {
    // The load-bearing assertion. A `typeof window` implementation would put
    // the browser-local string in rendered[0] and fail here.
    rendered.length = 0;
    const html = withTimeZone(SERVER_TZ, () => renderToString(<Probe />));
    const { container } = hydrate(<Probe />, html);

    expect(rendered[0]).toBe("2026-08-28 16:00 UTC");
    expect(rendered.at(-1)).toBe(new Date(INSTANT).toLocaleString());
    expect(container.textContent).toBe(new Date(INSTANT).toLocaleString());
  });

  it("hydrates HTML rendered in a foreign time zone without a recoverable error", () => {
    rendered.length = 0;
    const html = withTimeZone(SERVER_TZ, () => renderToString(<Probe />));
    const { onRecoverableError } = hydrate(<Probe />, html);

    expect(onRecoverableError).not.toHaveBeenCalled();
  });

  it("is true on the FIRST render of a component mounted after hydration", () => {
    // Most components mount through a client-side navigation, not hydration.
    // React uses getServerSnapshot only while hydrating, so those must start
    // at true — otherwise every timestamp paints its UTC form for one frame
    // before flipping, which is what the useState+useEffect form does.
    rendered.length = 0;
    render(<Probe />);

    expect(rendered[0]).toBe(new Date(INSTANT).toLocaleString());
    expect(rendered).toHaveLength(1);
  });

  it("and the unguarded shape, on the same HTML, does mismatch", () => {
    // The control: same procedure, fix removed. Proves the assertion above is
    // not passing for some unrelated reason, and reproduces the production
    // failure — server in one zone, browser in another.
    const html = withTimeZone(SERVER_TZ, () => renderToString(<BrokenProbe />));
    const { onRecoverableError } = hydrate(<BrokenProbe />, html);

    expect(onRecoverableError).toHaveBeenCalled();
  });
});
