import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";

const navigate = vi.fn();
vi.mock("react-router", () => ({ useNavigate: () => navigate }));

import { useAppNavigation } from "~/hooks/useAppNavigation";

function withSearch(search: string) {
  Object.defineProperty(window, "location", {
    value: { ...window.location, search },
    writable: true,
    configurable: true,
  });
}

function navigatedParams(): URLSearchParams {
  const target = navigate.mock.calls.at(-1)?.[0] as string;
  return new URLSearchParams(target.split("?")[1] ?? "");
}

describe("useAppNavigation — one-shot params", () => {
  beforeEach(() => {
    navigate.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps carrying Shopify's session params, including its own ?locale=", () => {
    // `locale` is the merchant's ADMIN UI language. The app renders itself in
    // it, so dropping it would send a German merchant back to English on every
    // click.
    withSearch("?shop=x.myshopify.com&host=abc&embedded=1&locale=de");
    const { result } = renderHook(() => useAppNavigation());

    result.current.handleNavigate("/app/products");

    const params = navigatedParams();
    expect(params.get("shop")).toBe("x.myshopify.com");
    expect(params.get("host")).toBe("abc");
    expect(params.get("embedded")).toBe("1");
    expect(params.get("locale")).toBe("de");
  });

  it("does NOT inherit contentLocale from the current URL", () => {
    // Otherwise one deep link out of the SEO dashboard decides the language of
    // every editor opened for the rest of the session — outranking the one the
    // merchant switches to afterwards.
    withSearch("?shop=x.myshopify.com&contentLocale=fr");
    const { result } = renderHook(() => useAppNavigation());

    result.current.handleNavigate("/app/collections");

    const params = navigatedParams();
    expect(params.get("contentLocale")).toBeNull();
    expect(params.get("shop")).toBe("x.myshopify.com");
  });

  it("still sets contentLocale when THIS navigation asks for it", () => {
    withSearch("?shop=x.myshopify.com&contentLocale=fr");
    const { result } = renderHook(() => useAppNavigation());

    result.current.handleNavigate("/app/products", {
      searchParams: new URLSearchParams({ select: "gid://shopify/Product/1", contentLocale: "es" }),
    });

    const params = navigatedParams();
    expect(params.get("contentLocale")).toBe("es");
    expect(params.get("select")).toBe("gid://shopify/Product/1");
  });
});
