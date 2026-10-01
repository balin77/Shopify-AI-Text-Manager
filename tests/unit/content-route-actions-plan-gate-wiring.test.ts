/**
 * Wiring guard: EVERY content route's exported `action` asks the plan.
 *
 * content-route-action-plan-gate.test.ts proves the two factories gate. This
 * one imports the real route modules, so a page that is added, re-wired to a
 * hand-written action, or built with the wrong content type is caught: a Free
 * shop must get 403 for each content type Free lacks, and the types Free has
 * (products, collections, onlineStoreExtras) must get past the gate. These
 * actions are directly POST-reachable (also through /api/content-editor-action).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CONTENT_EDITOR_ACTION_PAGES } from "../../app/services/editor/content-action-endpoint.shared";

const authenticate = { admin: vi.fn() };
vi.mock("~/shopify.server", () => ({ authenticate }));
vi.mock("../../app/shopify.server", () => ({ authenticate }));

const aISettings = { findUnique: vi.fn() };
const aIInstructions = { findUnique: vi.fn(async () => null) };
// themeContent: past the gate the theme routes look their group up; none found is a plain 4xx.
const dbStub = { aISettings, aIInstructions, themeContent: { findMany: vi.fn(async () => []) } };
vi.mock("~/db.server", () => ({ db: dbStub, default: dbStub }));
vi.mock("../../app/db.server", () => ({ db: dbStub, default: dbStub }));

const handleUnified = vi.fn(async () => ({ handled: true }));
vi.mock("~/actions/unified-content.actions", () => ({ handleUnifiedContentActions: handleUnified }));
vi.mock("../../app/actions/unified-content.actions", () => ({ handleUnifiedContentActions: handleUnified }));

vi.mock("~/services/theme-selection.server", () => ({
  listThemes: vi.fn(async () => []),
  resolveSelectedThemeId: vi.fn(async () => null),
}));

const SHOP = "test.myshopify.com";

/** Route module -> whether a FREE shop may run its actions. */
const ROUTES: Array<{ route: string; freeAllowed: boolean }> = [
  { route: "app.products", freeAllowed: true },
  { route: "app.collections", freeAllowed: true },
  { route: "app.pages", freeAllowed: false },
  { route: "app.blog", freeAllowed: false },
  { route: "app.policies", freeAllowed: false },
  { route: "app.metaobjects", freeAllowed: false },
  { route: "app.cookie-banner", freeAllowed: true },
  { route: "app.templates", freeAllowed: false },
  { route: "app.system", freeAllowed: false },
  { route: "app.delivery", freeAllowed: false },
  { route: "app.selling-plans", freeAllowed: false },
  { route: "app.online-store-extras", freeAllowed: true },
  { route: "app.shop-metadata", freeAllowed: true },
  { route: "app.theme-app-embeds", freeAllowed: false },
  { route: "app.theme-section-groups", freeAllowed: false },
  { route: "app.theme-settings", freeAllowed: false },
  { route: "app.theme-standard", freeAllowed: false },
  { route: "app.theme-static-sections", freeAllowed: false },
];

async function runRoute(route: string, action: string) {
  const mod = (await import(`../../app/routes/${route}.tsx`)) as {
    action: (args: never) => Promise<unknown>;
  };
  const body = new FormData();
  body.set("action", action);
  body.set("itemId", "group_x");
  body.set("locale", "fr");
  body.set("primaryLocale", "de");
  const request = new Request(`https://app.test/${route}`, { method: "POST", body });
  const response = (await mod.action({ request, params: {}, context: {} } as never)) as {
    data?: Record<string, unknown>;
    init?: { status?: number };
  };
  return { status: response?.init?.status ?? 200, body: response?.data };
}

beforeEach(() => {
  handleUnified.mockClear();
  aISettings.findUnique.mockReset();
  authenticate.admin.mockResolvedValue({
    admin: { graphql: vi.fn(async () => ({ json: async () => ({ data: {} }) })) },
    session: { shop: SHOP, accessToken: "t" },
  });
});

// The first test pays the import of the whole products route.
vi.setConfig({ testTimeout: 30_000 });

describe("every content route action is plan-gated", () => {
  it("ROUTES covers every page of CONTENT_EDITOR_ACTION_PAGES", () => {
    const covered = new Set(ROUTES.map((r) => `/${r.route.replace(/^app\./, "app/")}`));
    const missing = CONTENT_EDITOR_ACTION_PAGES.filter((page) => !covered.has(page));
    expect(missing).toEqual([]);
  });

  for (const { route, freeAllowed } of ROUTES) {
    it(`${route}: a Free shop is ${freeAllowed ? "let past the gate" : "refused with 403"}`, async () => {
      aISettings.findUnique.mockResolvedValue({ subscriptionPlan: "free" });
      const { status, body } = await runRoute(route, "updateContent");
      if (freeAllowed) {
        expect(body).not.toEqual(expect.objectContaining({ error: "gated" }));
        expect(status).not.toBe(403);
      } else {
        expect(status).toBe(403);
        expect(body).toEqual({ success: false, error: "gated", actionType: "updateContent" });
        expect(handleUnified).not.toHaveBeenCalled();
      }
    });

    it(`${route}: a Max shop is never refused by the gate`, async () => {
      aISettings.findUnique.mockResolvedValue({ subscriptionPlan: "max" });
      const { body } = await runRoute(route, "updateContent");
      expect(body).not.toEqual(expect.objectContaining({ error: "gated" }));
    });
  }
});
