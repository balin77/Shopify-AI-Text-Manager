/**
 * server.js logged `morgan("tiny")`, i.e. the full URL — including the
 * `id_token` (session JWT) and `hmac` of every embedded-app launch. The access
 * log keeps path and parameter NAMES and redacts the values of the sensitive
 * ones (app/middleware/access-log.cjs).
 */
import { describe, it, expect } from "vitest";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";

const require = createRequire(import.meta.url);
const { redactUrl, ACCESS_LOG_FORMAT, safeUrlToken } = require("../../app/middleware/access-log.cjs");
const morgan = require("morgan");

describe("redactUrl", () => {
  it("redacts the credentials of an embedded-app launch and keeps the rest", () => {
    const url = "/app/products?embedded=1&hmac=abc123&host=YWRtaW4&id_token=eyJhbGciOi.eyJzdWIi.sig&shop=k.myshopify.com&session=s3&locale=de";
    expect(redactUrl(url)).toBe(
      "/app/products?embedded=1&hmac=[redacted]&host=YWRtaW4&id_token=[redacted]&shop=k.myshopify.com&session=[redacted]&locale=de",
    );
  });

  it("covers the OAuth callback params and is case- and encoding-insensitive", () => {
    expect(redactUrl("/auth/callback?code=xyz&state=nonce&signature=s&TOKEN=t&id%5Ftoken=j")).toBe(
      "/auth/callback?code=[redacted]&state=[redacted]&signature=[redacted]&TOKEN=[redacted]&id%5Ftoken=[redacted]",
    );
  });

  it("leaves a URL without a query alone and drops a fragment", () => {
    expect(redactUrl("/health")).toBe("/health");
    expect(redactUrl("/app#id_token=x")).toBe("/app");
  });

  it("does not throw on malformed input and does not touch similar names", () => {
    expect(redactUrl("/x?%E0%A4%A=1&id_token&codes=1&a=b=c")).toBe("/x?%E0%A4%A=1&id_token&codes=1&a=b=c");
    expect(redactUrl(undefined)).toBeUndefined();
  });
});

describe("the morgan line", () => {
  it("prints method, redacted URL, status and timing — and no credential", async () => {
    morgan.token("safe-url", safeUrlToken);
    const lines: string[] = [];
    const log = morgan(ACCESS_LOG_FORMAT, { stream: { write: (l: string) => lines.push(l) } });
    const server = http.createServer((req, res) => log(req, res, () => res.end("ok")));
    await new Promise<void>((r) => server.listen(0, r));
    try {
      const { port } = server.address() as AddressInfo;
      // node:http, not fetch: the suite's jsdom environment applies CORS to fetch.
      await new Promise<void>((resolve, reject) => {
        http
          .get(`http://127.0.0.1:${port}/app?shop=k.myshopify.com&id_token=SECRETJWT&hmac=SECRETHMAC`, (res) => {
            res.resume();
            res.on("end", resolve);
          })
          .on("error", reject);
      });
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      server.close();
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^GET \/app\?shop=k\.myshopify\.com&id_token=\[redacted\]&hmac=\[redacted\] 200 \S+ - [\d.]+ ms/);
    expect(lines[0]).not.toContain("SECRET");
  });
});
