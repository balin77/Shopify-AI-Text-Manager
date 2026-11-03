/** The calm notice: existing message strip, merchant language, quiet for short waits, not repeated. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";

const showInfoBox = vi.fn();
vi.mock("~/contexts/InfoBoxContext", () => ({ useInfoBox: () => ({ showInfoBox }) }));
vi.mock("~/contexts/I18nContext", () => ({
  useI18n: () => ({ t: { common: { rateLimitWaiting: "WAITING", rateLimitGaveUp: "GAVE UP" } } }),
}));

import { RateLimitNotice } from "~/components/RateLimitNotice";
import { createRateLimitFetch, resetRateLimitState, RATE_LIMIT_MARKER_HEADER } from "~/utils/rate-limit-retry";

const realFetch = globalThis.fetch;
beforeEach(() => {
  vi.useFakeTimers();
  showInfoBox.mockReset();
  resetRateLimitState();
});
afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
});

const refusal = (retryAfter: number) =>
  new Response("{}", { status: 429, headers: { "Retry-After": String(retryAfter), [RATE_LIMIT_MARKER_HEADER]: "api" } });

describe("RateLimitNotice", () => {
  it("says it once for a real wait, in the merchant's text, with a dedupe key; and again when giving up", async () => {
    render(<RateLimitNotice />);
    globalThis.fetch = createRateLimitFetch((async () => refusal(5)) as any, { random: () => 0 });
    const p = globalThis.fetch("/api/x");
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    await p;
    expect(showInfoBox).toHaveBeenCalledWith("WAITING", "info", undefined, "rate-limit");
    expect(showInfoBox).toHaveBeenCalledWith("GAVE UP", "warning", undefined, "rate-limit");
    expect(showInfoBox.mock.calls.filter((c) => c[0] === "WAITING")).toHaveLength(1);
  });

  it("stays silent for a wait too short to notice", async () => {
    render(<RateLimitNotice />);
    let n = 0;
    globalThis.fetch = createRateLimitFetch((async () => (++n === 1 ? refusal(1) : new Response("{}", { status: 200 }))) as any, { random: () => 0 });
    const p = globalThis.fetch("/api/x");
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    await p;
    expect(showInfoBox).not.toHaveBeenCalled();
  });
});
