/**
 * server.js is CommonJS and cannot import the TS list of content editor pages,
 * so it carries a copy for its content rate limiter. This keeps the two from
 * drifting: a page that posts form data but is missing there is throttled by
 * nothing but the general budget (or by nothing at all).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONTENT_EDITOR_ACTION_PAGES } from "~/services/editor/content-action-endpoint.shared";

const serverJs = readFileSync(resolve(__dirname, "../../server.js"), "utf8");
const block = serverJs.slice(
  serverJs.indexOf("const CONTENT_PAGE_PATHS = ["),
  serverJs.indexOf("function isContentPagePath"),
);

describe("server.js content rate limit paths", () => {
  it("has the list block", () => {
    expect(block.length).toBeGreaterThan(0);
  });

  it.each([...CONTENT_EDITOR_ACTION_PAGES, "/app/menus", "/app/bulk"])("covers %s", (page) => {
    expect(block).toContain(`'${page}'`);
  });

  it("does not match with includes()", () => {
    const limiter = serverJs.slice(serverJs.indexOf("isContentPagePath(req.path)") - 400);
    expect(limiter).not.toMatch(/req\.path\.includes\('\/app\//);
  });
});
