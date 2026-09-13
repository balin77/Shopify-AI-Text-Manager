// @vitest-environment node
/**
 * A `host` query parameter that makes @shopify/shopify-api's `sanitizeHost`
 * THROW (instead of returning null) must end as a 400, not a 500 — Shopify's
 * App Review sent exactly these values (2026-09-13) and every one of them was a
 * 500 plus three Sentry events.
 *
 * Node environment on purpose: `atob` and `URL` are what the library runs on
 * in production, and the agreement test below compares against the library's
 * REAL `sanitizeHost`, so a library upgrade that changes its pattern or decoder
 * fails here instead of drifting silently.
 */
import path from "path";
import { pathToFileURL } from "url";
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

const warn = vi.hoisted(() => vi.fn());
vi.mock("~/utils/logger.server", () => ({
  logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  hostParamRejection,
  isUnparseableHostParam,
} from "~/utils/shopify-host-param.server";

/** The genuine value Shopify sends: base64 of `admin.shopify.com/store/<shop>`. */
const REAL_HOST =
  "YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvYXBwLXJldmlldy1iMTE3NGM4OC1yOTgyNTgtYTAtcHJpbWFyeQ";
/** The legacy shape: base64 of `<shop>.myshopify.com/admin`, unpadded. */
const LEGACY_HOST = Buffer.from("probe.myshopify.com/admin").toString("base64").replace(/=+$/, "");
/** From the App Review run: passes the base64 pattern, decodes to no hostname. */
const REVIEW_HOST = "9993237716999999999";
/** Length % 4 === 1: `atob` itself refuses it before `new URL` is reached. */
const UNDECODABLE_HOST = "99932377169999999";

const SAMPLES = [REAL_HOST, LEGACY_HOST, REVIEW_HOST, UNDECODABLE_HOST, "null", "", "admin.shopify.com", "a b"];

type SanitizeHostFactory = (config: object) => (host: string) => string | null;
let librarySanitizeHost: (host: string) => string | null;

beforeAll(async () => {
  const modulePath = path.resolve(
    process.cwd(),
    "node_modules/@shopify/shopify-api/dist/esm/lib/utils/shop-validator.mjs",
  );
  const mod = (await import(pathToFileURL(modulePath).href)) as { sanitizeHost: SanitizeHostFactory };
  librarySanitizeHost = mod.sanitizeHost({});
});

function requestWithHost(host: string | null): Request {
  const url = new URL("https://app.example.com/app/products?embedded=1&shop=x.myshopify.com");
  if (host !== null) url.searchParams.set("host", host);
  return new Request(url);
}

describe("isUnparseableHostParam", () => {
  it("agrees with the library's real sanitizeHost on which values THROW", () => {
    for (const host of SAMPLES) {
      let libraryThrows = false;
      try {
        librarySanitizeHost(host);
      } catch {
        libraryThrows = true;
      }
      expect({ host, flagged: isUnparseableHostParam(host) }).toEqual({ host, flagged: libraryThrows });
    }
  });

  it("flags both App Review shapes and lets real hosts through", () => {
    expect(isUnparseableHostParam(REVIEW_HOST)).toBe(true);
    expect(isUnparseableHostParam(UNDECODABLE_HOST)).toBe(true);
    expect(isUnparseableHostParam(REAL_HOST)).toBe(false);
    expect(isUnparseableHostParam(LEGACY_HOST)).toBe(false);
    expect(isUnparseableHostParam(null)).toBe(false);
  });
});

describe("hostParamRejection", () => {
  beforeEach(() => warn.mockClear());

  it("turns the library's crash on a tampered host into a logged 400", () => {
    const rejection = hostParamRejection(new TypeError("Invalid URL"), requestWithHost(REVIEW_HOST));

    expect(rejection).toBeInstanceOf(Response);
    expect(rejection?.status).toBe(400);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("never touches a thrown Response — that is the auth handshake", () => {
    const handshake = new Response(null, { status: 410 });
    expect(hostParamRejection(handshake, requestWithHost(REVIEW_HOST))).toBeNull();
  });

  it("leaves any other failure alone when the host is fine or absent", () => {
    const dbError = new Error("Can't reach database server");
    expect(hostParamRejection(dbError, requestWithHost(REAL_HOST))).toBeNull();
    expect(hostParamRejection(dbError, requestWithHost(null))).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});
