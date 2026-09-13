/**
 * root.tsx's ErrorBoundary renders on the SERVER, where `Sentry` — imported
 * from a `*.client.ts` module — is `undefined` (React Router stubs client
 * modules' exports in the server build). An unguarded `Sentry.captureException`
 * made the error page itself crash for every server-side error, which is what
 * Shopify's App Review run produced on 2026-09-13.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";

const holder = vi.hoisted(() => ({
  sentry: undefined as undefined | { captureException: ReturnType<typeof vi.fn> },
  routeError: undefined as unknown,
}));

vi.mock("~/utils/sentry.client", () => ({
  get Sentry() {
    return holder.sentry;
  },
}));

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return {
    ...actual,
    useRouteError: () => holder.routeError,
    // These read router context the test does not provide.
    Meta: () => null,
    Links: () => null,
    Scripts: () => null,
    ScrollRestoration: () => null,
  };
});

import { ErrorBoundary } from "~/root";

describe("root ErrorBoundary", () => {
  beforeEach(() => {
    holder.sentry = undefined;
    holder.routeError = new Error("boom");
  });

  it("renders the error page when Sentry is undefined, as it is in the server build", () => {
    let html = "";
    expect(() => {
      html = renderToString(<ErrorBoundary />);
    }).not.toThrow();
    expect(html).toContain("App Unavailable");
  });

  it("still reports a real error when the client SDK is present", () => {
    const captureException = vi.fn();
    holder.sentry = { captureException };

    renderToString(<ErrorBoundary />);

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(holder.routeError);
  });
});
