/**
 * Page level: a real router, a real component with a router fetcher and typed
 * input, an ErrorBoundary that would replace the page. A refused fetcher GET
 * and a refused fetcher POST must leave the page and the typed text standing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import {
  createMemoryRouter,
  RouterProvider,
  useFetcher,
  UNSAFE_getTurboStreamSingleFetchDataStrategy as getSingleFetchDataStrategy,
} from "react-router";

import { createRateLimitFetch, resetRateLimitState, RATE_LIMIT_MARKER_HEADER } from "~/utils/rate-limit-retry";
import { encodeTurboStreamValue } from "~/utils/turbo-stream-lite";

const realFetch = globalThis.fetch;
let sent: string[];

const refusal = () =>
  new Response('{"error":"Too many requests, please try again later","retryAfter":30}', {
    status: 429,
    headers: { "Content-Type": "application/json", "Retry-After": "2", [RATE_LIMIT_MARKER_HEADER]: "api-read" },
  });

function Page() {
  const fetcher = useFetcher({ key: "k" });
  const [typed, setTyped] = useState("");
  return (
    <div>
      <input data-testid="typed" value={typed} onChange={(e) => setTyped(e.target.value)} />
      <button onClick={() => fetcher.load("/api/things?x=1")}>load</button>
      <button onClick={() => fetcher.submit({ a: "1" }, { method: "POST", action: "/api/things" })}>save</button>
      <span data-testid="state">{fetcher.state}</span>
      <span data-testid="data">{JSON.stringify(fetcher.data ?? null)}</span>
    </div>
  );
}

function mount(alwaysRefuse: boolean) {
  let n = 0;
  const inner = vi.fn(async () => {
    sent.push("x");
    if (alwaysRefuse || ++n === 1) return refusal();
    return new Response(encodeTurboStreamValue({ "routes/api.things": { data: { success: true, rows: [1] } } }), {
      headers: { "X-Remix-Response": "yes" },
    });
  });
  globalThis.fetch = createRateLimitFetch(inner as any, { random: () => 0 });
  const manifest = { routes: { root: { hasLoader: false }, "routes/api.things": { hasLoader: true } } } as any;
  const loader = (id: string) => (_a: unknown, sf?: () => Promise<unknown>) => (sf && manifest.routes[id].hasLoader ? sf() : Promise.resolve(null));
  const action = (_a: unknown, sf?: () => Promise<unknown>) => (sf ? sf() : Promise.resolve(null));
  let router: ReturnType<typeof createMemoryRouter>;
  router = createMemoryRouter(
    [
      {
        id: "root",
        path: "/",
        Component: Page,
        ErrorBoundary: () => <div data-testid="boundary">BOUNDARY</div>,
        loader: loader("root") as any,
        children: [{ id: "routes/api.things", path: "api/things", loader: loader("routes/api.things") as any, action: action as any }],
      },
    ],
    {
      initialEntries: ["/"],
      hydrationData: { loaderData: { root: {} } },
      dataStrategy: getSingleFetchDataStrategy(() => router, manifest, {} as any, true, "/", false) as any,
    },
  );
  render(<RouterProvider router={router} />);
  return { router, inner };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
async function run(ms: number) {
  await act(async () => {
    for (let t = 0; t < ms; t += 500) {
      await vi.advanceTimersByTimeAsync(Math.min(500, ms - t));
      for (let i = 0; i < 4; i++) await settle();
    }
    for (let i = 0; i < 10; i++) await settle();
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  sent = [];
  resetRateLimitState();
});
afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
});

describe("a page with a router fetcher and typed input", () => {
  it("fetcher GET refused for good: the page, the typed text and a failed result stay; no ErrorBoundary", async () => {
    mount(true);
    fireEvent.change(screen.getByTestId("typed"), { target: { value: "unsaved headline" } });
    fireEvent.click(screen.getByText("load"));
    await run(40_000);
    expect(screen.queryByTestId("boundary")).toBeNull();
    expect((screen.getByTestId("typed") as HTMLInputElement).value).toBe("unsaved headline");
    expect(screen.getByTestId("data").textContent).toContain('"rateLimited":true');
    expect(screen.getByTestId("state").textContent).toBe("idle");
  });

  it("fetcher POST refused for good: same", async () => {
    mount(true);
    fireEvent.change(screen.getByTestId("typed"), { target: { value: "unsaved headline" } });
    fireEvent.click(screen.getByText("save"));
    await run(40_000);
    expect(screen.queryByTestId("boundary")).toBeNull();
    expect((screen.getByTestId("typed") as HTMLInputElement).value).toBe("unsaved headline");
    expect(screen.getByTestId("data").textContent).toContain('"success":false');
  });

  it("fetcher GET refused once: the retry delivers the real data", async () => {
    mount(false);
    fireEvent.click(screen.getByText("load"));
    await run(5000);
    expect(screen.queryByTestId("boundary")).toBeNull();
    expect(screen.getByTestId("data").textContent).toBe('{"success":true,"rows":[1]}');
  });
});
