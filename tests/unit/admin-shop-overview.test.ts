// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/utils/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { calls, rawSql, state, GUARD, pick, shopName, names, grouped } = vi.hoisted(() => {
  const calls: string[] = [];
  const rawSql: string[] = [];
  const state = {
    shopCount: 1,
    // Shops that appear in no table but the webhook log.
    webhookOnly: [] as string[],
    timelineRows: 0,
  };
  // Every sensitive column of the fixtures carries this text; the mocks honour
  // `select`, so anything read without selecting it ends up in the payload.
  const GUARD = "GUARD-SECRET-VALUE";
  const pick = (rows: Record<string, unknown>[], args?: { select?: Record<string, boolean> }) =>
    rows.map((r) => (args?.select ? Object.fromEntries(Object.entries(r).filter(([k]) => args.select![k])) : r));
  const shopName = (i: number) => `shop-${String(i).padStart(3, "0")}.example.test`;
  const names = () => Array.from({ length: state.shopCount }, (_, i) => shopName(i));
  const grouped = (name: string) =>
    vi.fn(async () => {
      calls.push(name);
      return names().map((shop) => ({ shop, _count: { _all: 3 } }));
    });
  return { calls, rawSql, state, GUARD, pick, shopName, names, grouped };
});
const NOW_ISO = "2026-11-10T12:00:00.000Z";
vi.mock("~/db.server", () => ({
  db: {
    shopInstallState: {
      findMany: vi.fn(async (a) => {
        calls.push("install");
        return pick(
          names().map((shop) => ({
            shop,
            uninstalledAt: null,
            uninstallSource: null,
            reinstallEvidenceAt: null,
            connectionState: null,
            connectionStateSince: null,
            connectionStateReason: GUARD, // not a code: must not be echoed
            resyncRequiredSince: null,
            droppedWebhookCount: 0,
            lastWebhookAt: null,
            lastActivityAt: new Date("2026-11-09T10:00:00Z"),
            lastActivityApprox: false,
            lastActionAt: null,
            lastActionArea: null,
            lastAuthAt: null,
            lastApiOkAt: null,
            initialSyncCompletedAt: new Date("2026-01-01T00:00:00Z"),
            initialSyncError: GUARD,
          })),
          a,
        );
      }),
      findUnique: vi.fn(async (a) => {
        calls.push("install1");
        const shop = a.where.shop as string;
        return names().includes(shop)
          ? pick([{ shop, uninstalledAt: null, lastActivityAt: new Date("2026-11-09T10:00:00Z"), initialSyncCompletedAt: new Date("2026-01-01T00:00:00Z"), initialSyncError: GUARD, connectionStateReason: GUARD }], a)[0]
          : null;
      }),
    },
    aISettings: {
      findMany: vi.fn(async (a) => {
        calls.push("ai");
        return pick(names().map((shop) => ({ shop, subscriptionPlan: "pro", devForcedPlan: null, anthropicApiKey: GUARD })), a);
      }),
      findUnique: vi.fn(async (a) => {
        calls.push("ai1");
        const shop = a.where.shop as string;
        return names().includes(shop)
          ? pick([{ shop, subscriptionPlan: "pro", aiProcessingConsentAt: null, claudeApiKey: GUARD }], a)[0]
          : null;
      }),
    },
    product: { groupBy: grouped("product") },
    collection: { groupBy: grouped("collection") },
    article: { groupBy: grouped("article") },
    page: { groupBy: grouped("page") },
    task: {
      groupBy: grouped("task"),
      findMany: vi.fn(async (a) => {
        calls.push("tasks1");
        return pick(
          [{ type: "translation", status: "failed", startedAt: new Date("2026-11-09T09:00:00Z"), error: `boom shpat_abcdef0123456789 ${GUARD.length > 0 ? "x" : ""}`, prompt: GUARD, result: GUARD, resourceTitle: GUARD }],
          a,
        );
      }),
    },
    offlineTokenMigration: {
      findMany: vi.fn(async (a) => {
        calls.push("migration");
        return pick(
          names().map((shop) => ({ shop, status: "pending", attempts: 0, failureKind: null, failureKindSince: null, startedAt: new Date("2026-11-10T11:00:00Z"), encryptedOldToken: GUARD, tokenFingerprint: GUARD, lastError: GUARD })),
          a,
        );
      }),
      findUnique: vi.fn(async () => {
        calls.push("migration1");
        return null;
      }),
    },
    webhookLog: {
      groupBy: vi.fn(async (a: { where: { error?: unknown } }) => {
        calls.push(a.where.error ? "webhookFailed" : "webhookTotal");
        const shops = [...names(), ...state.webhookOnly];
        if (a.where.error) return state.webhookOnly.map((shop) => ({ shop, _count: { _all: 4 } }));
        return shops.map((shop) => ({ shop, _count: { _all: state.webhookOnly.includes(shop) ? 4 : 2 } }));
      }),
      count: vi.fn(async (a: { where: { shop: string } }) => {
        calls.push("webhookCount");
        return state.webhookOnly.includes(a.where.shop) || names().includes(a.where.shop) ? 5 : 0;
      }),
    },
    webhookRetry: { groupBy: grouped("retry") },
    imageOperationCounter: {
      findMany: vi.fn(async (a) => {
        calls.push("images");
        return pick(names().map((shop) => ({ shop, period: "2026-11", count: 7 })), a);
      }),
    },
    managedAiGlobalCounter: {
      findMany: vi.fn(async () => {
        calls.push("globalAi");
        return [{ costMicros: BigInt(1_500_000) }, { costMicros: BigInt(500_000) }];
      }),
    },
    shopUsageDay: {
      findMany: vi.fn(async () => {
        calls.push("usageDays");
        return [{ day: new Date("2026-11-09T00:00:00Z"), activeSlots: 4, actions: 2, tasksStarted: 1, tasksFailed: 0 }];
      }),
    },
    aiConsentEvent: {
      findMany: vi.fn(async () => {
        calls.push("consent");
        return Array.from({ length: state.timelineRows }, (_, i) => ({ granted: i % 2 === 0, createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)) }));
      }),
    },
    gdprAuditLog: {
      findMany: vi.fn(async (a: { where?: { shop: string }; select?: Record<string, boolean> }) => {
        calls.push(a.where ? "gdpr1" : "audit");
        return pick(
          [{ id: "g1", shop: shopName(0), requestType: "data_request", status: "completed", requestedAt: new Date("2026-11-01T00:00:00Z"), completedAt: new Date("2026-11-01T00:00:01Z"), customerEmail: "customer@example.test", dataExported: GUARD }],
          a,
        );
      }),
      findUnique: vi.fn(async () => ({ id: "g1", shop: shopName(0), customerEmail: "customer@example.test", error: null, dataExported: "{\"x\":1}", webhookId: "w" })),
    },
    $queryRaw: vi.fn(async (q: TemplateStringsArray, ...values: unknown[]) => {
      const sql = q.join("?");
      rawSql.push(sql);
      if (sql.includes('FROM "Session"')) {
        calls.push("rawSession");
        const only = sql.includes('WHERE "shop"') ? [String(values[0])] : names();
        return only.filter((shop) => names().includes(shop)).map((shop) => ({ shop, sessions: 1, offline: 1, tokenEmpty: false, hasRefresh: true, expires: new Date("2026-11-11T00:00:00Z"), refreshTokenExpires: new Date("2027-01-01T00:00:00Z") }));
      }
      if (sql.includes('"ShopUsageDay"')) {
        calls.push("rawUsage");
        return names().map((shop) => ({ shop, active7: 3, active30: 9, actions7: BigInt(12), actions30: BigInt(40), tasks7: BigInt(2), tasks30: BigInt(5), failed7: BigInt(0), failed30: BigInt(1) }));
      }
      if (sql.includes('"AiUsageCounter"')) {
        calls.push("rawAi");
        return names().map((shop) => ({ shop, costThis: BigInt(2_340_000), costLast: BigInt(100) }));
      }
      if (sql.includes("DISTINCT ON")) {
        calls.push("rawLastTask");
        return names().map((shop) => ({ shop, type: "translation", status: "completed", startedAt: new Date("2026-11-09T09:00:00Z") }));
      }
      if (sql.includes('"WebhookLog"')) {
        calls.push("rawHours");
        return [{ hour: new Date("2026-11-10T10:00:00Z"), failed: 3 }];
      }
      calls.push("rawStorage");
      return [{ bytes: BigInt(2 * 1024 * 1024) }];
    }),
  },
}));
vi.mock("~/services/gdpr.service", () => ({ redactShopData: vi.fn() }));

import * as route from "../../app/routes/admin";
import { sanitizeText, loadShopOverview } from "../../app/services/admin/shop-overview.server";
import { serializeAdminSession } from "../../app/utils/admin-auth.server";

const PW = "a-sufficiently-long-password";
const FETCH = { "Sec-Fetch-Dest": "empty" };
async function authed(url: string, extra: Record<string, string> = FETCH) {
  const c = (await serializeAdminSession()).split(";")[0];
  return new Request(`https://admin.test${url}`, { headers: { Cookie: c, ...extra } });
}
const run = (request: Request) => route.loader({ request, params: {}, context: {} } as never);
const statusOf = (res: unknown) => (res as { init?: { status?: number } }).init?.status ?? (res as Response).status;
const bodyOf = async (res: unknown) => (res as { data?: unknown }).data ?? (await (res as Response).json());

beforeEach(() => {
  process.env.ADMIN_PASSWORD = PW;
  process.env.SHOPIFY_API_SECRET = "api-secret";
  calls.length = 0;
  rawSql.length = 0;
  state.shopCount = 1;
  state.webhookOnly = [];
  state.timelineRows = 0;
});

type Body = { rows: Array<Record<string, any>>; header: any; audits: unknown[]; now: string };

describe("admin shop overview loader", () => {
  it("runs the same number of queries for 1 and 200 shops", async () => {
    state.shopCount = 1;
    await run(await authed("/admin"));
    const one = calls.length;
    calls.length = 0;
    state.shopCount = 200;
    const body = (await bodyOf(await run(await authed("/admin")))) as Body;
    expect(calls.length).toBe(one);
    expect(one).toBe(18); // 17 for the overview + the audit list
    expect(body.rows).toHaveLength(200);
  });

  it("builds row, status and usage figures and converts BigInt to Number", async () => {
    const body = (await bodyOf(await run(await authed("/admin")))) as Body;
    const r = body.rows[0];
    expect(r).toMatchObject({
      shop: shopName(0),
      plan: "pro",
      products: 3,
      hasSession: true,
      onlyInWebhookLog: false,
      activeDays7: 3,
      activeDays30: 9,
      actions7: 12,
      actions30: 40,
      tasks30: 5,
      tasksFailed30: 1,
      aiCostMicrosMonth: 2_340_000,
      imageOpsMonth: 7,
      webhooks24h: { total: 2, failed: 0 },
    });
    expect(r.status.color).toBe("green");
    expect(body.header.managedAiCostMicrosMonth).toBe(2_000_000);
    expect(() => JSON.stringify(body)).not.toThrow();
    expect(typeof body.now).toBe("string");
  });

  it("includes a shop that only appears in the webhook log, as red", async () => {
    state.webhookOnly = ["ghost.example.test"];
    const body = (await bodyOf(await run(await authed("/admin")))) as Body;
    const ghost = body.rows.find((r) => r.shop === "ghost.example.test")!;
    expect(ghost).toBeTruthy();
    expect(ghost.onlyInWebhookLog).toBe(true);
    expect(ghost.status.color).toBe("red");
    expect(ghost.hasSession).toBe(false);
    expect(ghost.webhooks24h).toEqual({ total: 4, failed: 4 });
  });

  it("leaks nothing sensitive and sends no customer data with the page", async () => {
    state.shopCount = 3;
    const body = await bodyOf(await run(await authed("/admin")));
    const text = JSON.stringify(body);
    expect(text).not.toContain(GUARD);
    expect(text).not.toMatch(/shp[a-z]{2}_/);
    expect(text).not.toContain("customer@example.test");
    expect(text).not.toMatch(/customerEmail|dataExported/);
    // The raw queries return aggregates of the session shape, never a token or e-mail column.
    const sessionSql = rawSql.find((s) => s.includes('FROM "Session"'))!;
    expect(sessionSql).not.toMatch(/"email"|"firstName"|"lastName"/);
    expect(sessionSql.match(/"accessToken"/g)).toHaveLength(1);
    expect(sessionSql).toContain(`"accessToken" = ''`);
    for (const sql of rawSql) expect(sql).not.toMatch(/"prompt"|"result"|"resourceTitle"|"payload"/);
  });

  it("serves the detail only on demand, behind the admin cookie, with no customer data", async () => {
    state.timelineRows = 150;
    const ok = (await bodyOf(await run(await authed(`/admin?detail=${shopName(0)}`)))) as { detail: any };
    expect(ok.detail.storageMB).toBe(2);
    expect(ok.detail.timeline.length).toBe(100);
    expect(ok.detail.usage).toHaveLength(1);
    expect(ok.detail.status.color).toBeDefined();
    const text = JSON.stringify(ok);
    expect(text).not.toContain(GUARD);
    expect(text).not.toMatch(/shp[a-z]{2}_/);
    expect(text).not.toContain("customer@example.test");
    // newest first
    const ats = ok.detail.timeline.map((e: { at: string }) => e.at);
    expect([...ats].sort().reverse()).toEqual(ats);

    calls.length = 0;
    const anon = (await run(new Request(`https://admin.test/admin?detail=${shopName(0)}`, { headers: FETCH }))) as Response;
    expect(statusOf(anon)).toBe(401);
    expect(calls).toEqual([]);

    const doc = (await run(await authed(`/admin?detail=${shopName(0)}`, { "Sec-Fetch-Dest": "document" }))) as Response;
    expect(statusOf(doc)).toBe(302);
    expect(doc.headers.get("Location")).toBe("/admin");
    expect(calls).toEqual([]);
  });

  it("answers 404 for a detail of a shop no source knows, and no longer has a storage door", async () => {
    const res = await run(await authed("/admin?detail=unknown.example.test"));
    expect(statusOf(res)).toBe(404);
    // ?storage= is gone: it is the plain page now.
    const old = (await bodyOf(await run(await authed(`/admin?storage=${shopName(0)}`)))) as Body;
    expect(old.rows).toBeDefined();
  });

  it("loads the customer e-mail and the export only through ?audit=<id>", async () => {
    const res = (await bodyOf(await run(await authed("/admin?audit=g1")))) as { detail: { customerEmail: string; dataExported: string } };
    expect(res.detail.customerEmail).toBe("customer@example.test");
    expect(res.detail.dataExported).toContain("x");
  });

  it("loadShopOverview takes its clock as an argument", async () => {
    const o = await loadShopOverview(new Date(NOW_ISO));
    expect(o.now).toBe(NOW_ISO);
  });
});

describe("sanitizeText", () => {
  it("masks token-, key- and address-shaped strings and cuts to 160 characters", () => {
    expect(sanitizeText("boom shpat_abcdef0123 end")).toBe("boom [maskiert] end");
    expect(sanitizeText("mail a.b@example.test now")).toBe("mail [maskiert] now");
    expect(sanitizeText("k " + "A1b2".repeat(10))).toBe("k [maskiert]");
    expect(sanitizeText("x".repeat(500)).length).toBeLessThanOrEqual(160);
    expect(sanitizeText(undefined)).toBe("");
  });
});
