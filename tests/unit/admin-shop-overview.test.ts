// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/utils/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { calls, state, names, pick, grouped, GUARD } = vi.hoisted(() => {
  const calls: string[] = [];
  const state = { shopCount: 1 };
  const names = () =>
    Array.from({ length: state.shopCount }, (_, i) => `shop-${String(i).padStart(3, "0")}.example.test`);
  // The fixture carries a guard string in every sensitive column; the mocks
  // honour `select`, so anything read without selecting it would show up.
  const GUARD = "GUARD-SECRET-VALUE";
  const pick = (rows: Record<string, unknown>[], args?: { select?: Record<string, boolean> }) =>
    rows.map((r) =>
      args?.select ? Object.fromEntries(Object.entries(r).filter(([k]) => args.select![k])) : r,
    );
  const grouped = (name: string) => async () => {
    calls.push(name);
    return names().map((shop) => ({ shop, _count: { _all: 3 } }));
  };
  return { calls, state, names, pick, grouped, GUARD };
});
const shopName = (i: number) => `shop-${String(i).padStart(3, "0")}.example.test`;

vi.mock("~/db.server", () => ({
  db: {
    session: {
      findMany: vi.fn(async (a) => {
        calls.push("session");
        return pick(
          names().map((shop) => ({ shop, accessToken: GUARD, refreshToken: GUARD, email: `${GUARD}@x.test` })),
          a,
        );
      }),
    },
    shopInstallState: {
      findMany: vi.fn(async (a) => {
        calls.push("install");
        return pick(
          names().map((shop) => ({
            shop,
            uninstalledAt: null,
            initialSyncCompletedAt: new Date("2026-01-01T00:00:00Z"),
            connectionStateReason: GUARD,
          })),
          a,
        );
      }),
    },
    aISettings: {
      findMany: vi.fn(async (a) => {
        calls.push("ai");
        return pick(
          names().map((shop) => ({ shop, subscriptionPlan: "pro", devForcedPlan: null, anthropicApiKey: GUARD })),
          a,
        );
      }),
    },
    product: { groupBy: vi.fn(grouped("product")) },
    collection: { groupBy: vi.fn(grouped("collection")) },
    article: { groupBy: vi.fn(grouped("article")) },
    page: { groupBy: vi.fn(grouped("page")) },
    task: { groupBy: vi.fn(grouped("task")) },
    gdprAuditLog: {
      findMany: vi.fn(async () => {
        calls.push("audit");
        return [];
      }),
      findUnique: vi.fn(),
    },
    $queryRaw: vi.fn(async () => {
      calls.push("raw");
      return [{ bytes: BigInt(2 * 1024 * 1024) }];
    }),
  },
}));
vi.mock("~/services/gdpr.service", () => ({ redactShopData: vi.fn() }));

import * as route from "../../app/routes/admin";
import { serializeAdminSession } from "../../app/utils/admin-auth.server";

const PW = "a-sufficiently-long-password";
const FETCH = { "Sec-Fetch-Dest": "empty" };
async function authed(url: string, extra: Record<string, string> = FETCH) {
  const c = (await serializeAdminSession()).split(";")[0];
  return new Request(`https://admin.test${url}`, { headers: { Cookie: c, ...extra } });
}
const run = (request: Request) => route.loader({ request, params: {}, context: {} } as never);
// data() results carry the payload on `.data`; plain Responses need json().
const statusOf = (res: unknown) =>
  (res as { init?: { status?: number } }).init?.status ?? (res as Response).status;
const bodyOf = async (res: unknown) =>
  (res as { data?: unknown }).data ?? (await (res as Response).json());

beforeEach(() => {
  process.env.ADMIN_PASSWORD = PW;
  process.env.SHOPIFY_API_SECRET = "api-secret";
  calls.length = 0;
});

describe("admin shop overview loader", () => {
  it("runs the same number of queries for 1 and 20 shops, none of them raw", async () => {
    state.shopCount = 1;
    await run(await authed("/admin"));
    const one = calls.length;
    calls.length = 0;
    state.shopCount = 20;
    const body = (await bodyOf(await run(await authed("/admin")))) as { rows: unknown[] };
    expect(calls.length).toBe(one);
    expect(one).toBe(9);
    expect(calls).not.toContain("raw");
    expect(body.rows).toHaveLength(20);
  });

  it("keeps the old row shape (minus storage) and leaks nothing sensitive", async () => {
    state.shopCount = 2;
    const body = (await bodyOf(await run(await authed("/admin")))) as {
      rows: Record<string, unknown>[];
    };
    expect(body.rows[0]).toEqual({
      shop: shopName(0),
      plan: "pro",
      devForcedPlan: null,
      products: 3,
      collections: 3,
      articles: 3,
      pages: 3,
      tasks: 3,
      hasSession: true,
      uninstalledAt: null,
      initialSyncCompletedAt: "2026-01-01T00:00:00.000Z",
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain(GUARD);
    expect(text).not.toMatch(/shp[a-z]{2}_/);
    expect(text.toLowerCase()).not.toMatch(/token|encrypted/);
  });

  it("serves storage only on demand, behind the admin cookie", async () => {
    state.shopCount = 1;
    const ok = (await bodyOf(await run(await authed(`/admin?storage=${shopName(0)}`)))) as {
      storage: { storageMB: number };
    };
    expect(ok.storage.storageMB).toBe(2);

    calls.length = 0;
    const anon = (await run(
      new Request(`https://admin.test/admin?storage=${shopName(0)}`, { headers: FETCH }),
    )) as Response;
    expect(statusOf(anon)).toBe(401);
    expect(calls).not.toContain("raw");

    const doc = (await run(
      await authed(`/admin?storage=${shopName(0)}`, { "Sec-Fetch-Dest": "document" }),
    )) as Response;
    expect(statusOf(doc)).toBe(302);
    expect(doc.headers.get("Location")).toBe("/admin");
    expect(calls).not.toContain("raw");
  });
});
