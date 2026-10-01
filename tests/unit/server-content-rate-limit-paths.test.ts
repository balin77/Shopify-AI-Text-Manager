/**
 * server.js is CommonJS and cannot import the TS list of content editor pages,
 * so its content rate limiter uses a CJS copy. This keeps the two from
 * drifting and pins the matching behaviour.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { CONTENT_EDITOR_ACTION_PAGES } from "~/services/editor/content-action-endpoint.shared";

const req = createRequire(import.meta.url);
const { CONTENT_PAGE_PATHS, isContentPagePath } = req("../../app/middleware/content-page-paths.cjs") as {
  CONTENT_PAGE_PATHS: string[];
  isContentPagePath: (p: string) => boolean;
};
const serverJs = readFileSync(resolve(__dirname, "../../server.js"), "utf8");

describe("content rate limit paths", () => {
  it.each([...CONTENT_EDITOR_ACTION_PAGES, "/app/menus", "/app/bulk"])("covers %s", (page) => {
    expect(CONTENT_PAGE_PATHS).toContain(page);
  });

  it("matches the single-fetch and nested forms", () => {
    expect(isContentPagePath("/app/products")).toBe(true);
    expect(isContentPagePath("/app/products.data")).toBe(true);
    expect(isContentPagePath("/app/products/")).toBe(true);
    expect(isContentPagePath("/app/bulk/translate")).toBe(true);
  });

  it("does not match near-misses", () => {
    expect(isContentPagePath("/app/blogs")).toBe(false);
    expect(isContentPagePath("/app/productsx")).toBe(false);
    expect(isContentPagePath("/api/ai")).toBe(false);
  });

  it("server.js uses the module and no includes() matching", () => {
    expect(serverJs).toContain("content-page-paths.cjs");
    expect(serverJs).not.toMatch(/req\.path\.includes\('\/app\//);
  });
});
