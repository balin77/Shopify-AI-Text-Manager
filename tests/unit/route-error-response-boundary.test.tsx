/**
 * app.tsx's ErrorBoundary must recognise a thrown route response by SHAPE.
 * Shopify's `boundary.error` recognises it by `constructor.name`, which the
 * client bundle minifies (`ErrorResponseImpl` → `Ge`), so in the browser it
 * re-threw every thrown Response and the page fell through to root.tsx's
 * boundary — a different tree from the one the server rendered.
 *
 * `routeErrorResponseBoundary` is the WHOLE rendering tail of that boundary
 * (app.tsx only returns it), so these tests also pin the order: structural
 * check first, `boundary.error` only for what is not a route response.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import { render } from "@testing-library/react";
import { UNSAFE_ErrorResponseImpl } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

const holder = vi.hoisted(() => ({
  sentry: undefined as undefined | { captureException: ReturnType<typeof vi.fn> },
}));
vi.mock("~/utils/sentry.client", () => ({
  get Sentry() {
    return holder.sentry;
  },
}));

import {
  reportRouteErrorResponse,
  routeErrorResponseBoundary,
  useReportRouteErrorResponse,
} from "~/utils/route-error-response-boundary";

/** The same object the client bundle builds, under its minified class name. */
class Ge {
  status: number;
  statusText: string;
  internal: boolean;
  data: unknown;
  constructor(status: number, statusText: string, data: unknown, internal = false) {
    this.status = status;
    this.statusText = statusText || "";
    this.internal = internal;
    this.data = data;
  }
}

function withSentry() {
  const captureException = vi.fn();
  holder.sentry = { captureException };
  return captureException;
}

describe("routeErrorResponseBoundary", () => {
  it("recognises a route response whose class name was minified away", () => {
    const html = renderToString(routeErrorResponseBoundary(new Ge(400, "Bad Request", "Invalid host parameter")));
    expect(html).toBe("<div>Invalid host parameter</div>");
  });

  it("renders exactly what the library renders where the library does recognise it", () => {
    const unminified = new UNSAFE_ErrorResponseImpl(400, "Bad Request", "Invalid host parameter");

    expect(renderToString(routeErrorResponseBoundary(unminified))).toBe(
      renderToString(boundary.error(unminified)),
    );
  });

  it("falls back to the library's placeholder text for an empty body", () => {
    expect(renderToString(routeErrorResponseBoundary(new Ge(404, "Not Found", "")))).toBe(
      "<div>Handling response</div>",
    );
  });

  it("hands anything that is not a route response to boundary.error, which re-throws it", () => {
    const error = new Error("boom");
    expect(() => routeErrorResponseBoundary(error)).toThrow(error);
  });

  it("control: the library itself re-throws the minified shape", () => {
    expect(() => boundary.error(new Ge(400, "Bad Request", "Invalid host parameter"))).toThrow();
  });
});

describe("reportRouteErrorResponse", () => {
  beforeEach(() => {
    holder.sentry = undefined;
  });

  it("reports a 5xx as an Error that names the status, and never a 4xx", () => {
    const captureException = withSentry();

    reportRouteErrorResponse(new Ge(500, "Internal Server Error", "Failed to load settings"));
    reportRouteErrorResponse(new Ge(400, "Bad Request", "Invalid host parameter"));

    expect(captureException).toHaveBeenCalledTimes(1);
    const reported = captureException.mock.calls[0][0];
    expect(reported).toBeInstanceOf(Error);
    expect(reported.message).toBe("Route error 500 Internal Server Error: Failed to load settings");
  });

  it("ignores anything that is not a route response", () => {
    const captureException = withSentry();
    reportRouteErrorResponse(new Error("boom"));
    expect(captureException).not.toHaveBeenCalled();
  });

  it("is a no-op where Sentry is undefined, as it is in the server build", () => {
    expect(() => reportRouteErrorResponse(new Ge(500, "Internal Server Error", "x"))).not.toThrow();
  });
});

describe("useReportRouteErrorResponse", () => {
  function Probe({ error }: { error: unknown }) {
    useReportRouteErrorResponse(error);
    return null;
  }

  beforeEach(() => {
    holder.sentry = undefined;
  });

  it("reports once per error, however often the boundary re-renders", () => {
    const captureException = withSentry();
    const error = new Ge(500, "Internal Server Error", "Failed to load settings");

    const { rerender } = render(<Probe error={error} />);
    rerender(<Probe error={error} />);
    rerender(<Probe error={error} />);

    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("reports again for a DIFFERENT error", () => {
    const captureException = withSentry();

    const { rerender } = render(<Probe error={new Ge(500, "Internal Server Error", "a")} />);
    rerender(<Probe error={new Ge(503, "Service Unavailable", "b")} />);

    expect(captureException).toHaveBeenCalledTimes(2);
  });

  it("does not report during a server render", () => {
    const captureException = withSentry();
    renderToString(<Probe error={new Ge(500, "Internal Server Error", "x")} />);
    expect(captureException).not.toHaveBeenCalled();
  });
});
