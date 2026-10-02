/**
 * The JSON door for the editors' "copy to all languages" saves.
 *
 * They used to post to the PAGE route, whose answer to a plain POST is the
 * rendered HTML document: a full page render per locale, and an answer that
 * could not be read, so a failed save was reported as "copied".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const { productsAction } = vi.hoisted(() => ({
  productsAction: vi.fn(async (_args: { request: Request }) => ({ success: true })),
}));
vi.mock("~/routes/app.products", () => ({ action: productsAction }));
const warn = vi.hoisted(() => vi.fn());
vi.mock("~/utils/logger.server", () => ({
  logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { action } from "~/routes/api.content-editor-action";
import {
  CONTENT_EDITOR_ACTION_PAGES,
  contentEditorActionPage,
  postContentEditorSave,
} from "~/services/editor/content-action-endpoint.shared";

function post(fields: Record<string, string>, headers: Record<string, string> = { Authorization: "Bearer token" }) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  const request = new Request("https://app.test/api/content-editor-action", {
    method: "POST",
    body: fd,
    headers,
  });
  return action({ request, params: {}, context: {} } as never);
}

beforeEach(() => {
  productsAction.mockClear();
  warn.mockClear();
});

describe("api.content-editor-action — auth bounce from the page action", () => {
  const bouncePage = () =>
    new Response("<script></script>", { status: 200, headers: { "content-type": "text/html;charset=utf-8" } });
  const thrown = (p: Promise<unknown>) => p.then(() => { throw new Error("did not throw"); }, (e) => e);

  it("turns the page action's bounce page into the /api 401 + retry header, judged on the ORIGINAL request", async () => {
    productsAction.mockImplementationOnce(async () => { throw bouncePage(); });
    const err = await thrown(post({ action: "updateContent", _page: "/app/products" }, {}));
    expect(err).toBeInstanceOf(Response);
    expect((err as Response).status).toBe(401);
    expect((err as Response).headers.get("X-Shopify-Retry-Invalid-Session-Request")).toBe("1");
    expect(await (err as Response).json()).toMatchObject({ code: "sessionExpired" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({ pathname: "/api/content-editor-action" });
  });

  it("re-throws everything else unchanged: a bounce for a request WITH a token, a redirect, a plain error", async () => {
    const page = bouncePage();
    productsAction.mockImplementationOnce(async () => { throw page; });
    expect(await thrown(post({ action: "updateContent", _page: "/app/products" }))).toBe(page);

    const redirect = new Response(null, { status: 302, headers: { location: "/auth/login" } });
    productsAction.mockImplementationOnce(async () => { throw redirect; });
    expect(await thrown(post({ action: "updateContent", _page: "/app/products" }, {}))).toBe(redirect);

    const boom = new Error("boom");
    productsAction.mockImplementationOnce(async () => { throw boom; });
    expect(await thrown(post({ action: "updateContent", _page: "/app/products" }, {}))).toBe(boom);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("api.content-editor-action", () => {
  it("runs the page's OWN action on the page's URL, with the session header and a clean body", async () => {
    await post({ action: "updateContent", _page: "/app/products?market=x", itemId: "gid://shopify/Product/1", title: "A" });

    expect(productsAction).toHaveBeenCalledTimes(1);
    const request = productsAction.mock.calls[0][0].request;
    expect(request.url).toBe("https://app.test/app/products?market=x");
    expect(request.headers.get("authorization")).toBe("Bearer token");
    // Re-encoded body: the old multipart boundary must not survive.
    const fd = await request.formData();
    expect(fd.get("title")).toBe("A");
    expect(fd.get("_page")).toBeNull();
  });

  it("refuses any action but updateContent", async () => {
    const response = (await post({ action: "deleteContent", _page: "/app/products" })) as { init?: { status?: number } };
    expect(productsAction).not.toHaveBeenCalled();
    expect(response.init?.status).toBe(400);
  });

  it.each(["translateSubResources", "translateSubResourceToAllLocales", "saveSubResourceTranslations"])(
    "lets the product page's sub-resource action %s through to the products action",
    async (name) => {
      await post({ action: name, _page: "/app/products" });
      expect(productsAction).toHaveBeenCalledTimes(1);
      const fd = await productsAction.mock.calls[0][0].request.formData();
      expect(fd.get("action")).toBe(name);
    },
  );

  it("does not offer the sub-resource actions on any other page", async () => {
    const response = (await post({ action: "translateSubResources", _page: "/app/pages" })) as { init?: { status?: number } };
    expect(response.init?.status).toBe(400);
    expect(productsAction).not.toHaveBeenCalled();
  });

  it("refuses a page it does not list, and a foreign origin", async () => {
    for (const page of ["/app/settings", "https://evil.test/app/products", ""]) {
      const response = (await post({ action: "updateContent", _page: page })) as { init?: { status?: number } };
      expect(response.init?.status).toBe(400);
    }
    expect(productsAction).not.toHaveBeenCalled();
  });

  it("lists only pages that exist and export an action", () => {
    for (const page of CONTENT_EDITOR_ACTION_PAGES) {
      const file = resolve(__dirname, "../../app/routes", `${page.slice(1).replace(/\//g, ".")}.tsx`);
      expect(existsSync(file), file).toBe(true);
      expect(readFileSync(file, "utf8")).toMatch(/export (const|async function) action\b/);
    }
  });

  it("names every listed page in the route's import map", () => {
    const route = readFileSync(resolve(__dirname, "../../app/routes/api.content-editor-action.tsx"), "utf8");
    for (const page of CONTENT_EDITOR_ACTION_PAGES) {
      expect(route).toContain(`"${page}": () => import("./${page.slice(1).replace(/\//g, ".")}")`);
    }
  });
});

describe("postContentEditorSave", () => {
  const fetchSpy = vi.fn();
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("normalises a trailing slash", () => {
    expect(contentEditorActionPage("/app/products/")).toBe("/app/products");
    expect(contentEditorActionPage("/app/settings")).toBeNull();
  });

  it("reads the JSON answer: success, refusal and a failed request", async () => {
    const loc = { pathname: "/app/pages", search: "" };
    // Real Responses: the door now goes through appFetch, which reads the
    // headers to tell an auth bounce from the route's answer.
    const jsonResponse = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    fetchSpy.mockResolvedValueOnce(jsonResponse({ success: true }));
    expect(await postContentEditorSave(new FormData(), loc)).toBe(true);
    fetchSpy.mockResolvedValueOnce(jsonResponse({ success: false, error: "x" }));
    expect(await postContentEditorSave(new FormData(), loc)).toBe(false);
    fetchSpy.mockResolvedValueOnce(jsonResponse({}, 500));
    expect(await postContentEditorSave(new FormData(), loc)).toBe(false);
    // An auth bounce that survives the retry is a failed save, not a success.
    const bounce = () => new Response("<script></script>", { status: 200, headers: { "content-type": "text/html;charset=utf-8" } });
    fetchSpy.mockResolvedValueOnce(bounce()).mockResolvedValueOnce(bounce());
    expect(await postContentEditorSave(new FormData(), loc)).toBe(false);
    fetchSpy.mockRejectedValueOnce(new Error("offline"));
    expect(await postContentEditorSave(new FormData(), loc)).toBe(false);
    expect(fetchSpy.mock.calls[0][0]).toBe("/api/content-editor-action");
  });

  it("says 'unknown', never 'failed', for a page it does not list", async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true, text: async () => "<html>" });
    expect(await postContentEditorSave(new FormData(), { pathname: "/app/elsewhere", search: "" })).toBeNull();
    expect(fetchSpy.mock.calls[0][0]).toBe("/app/elsewhere");
  });
});
