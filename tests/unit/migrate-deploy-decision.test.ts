import { describe, expect, it } from "vitest";
import { assessSchema, decideAfterMigrateDeploy, isDbPushFallbackAllowed, isTransientDbError, retryDelayMs } from "../../scripts/migrate-deploy-decision.js";

describe("decideAfterMigrateDeploy", () => {
  it("continues on success, flag irrelevant", () => {
    expect(decideAfterMigrateDeploy(true, {}).action).toBe("continue");
    expect(decideAfterMigrateDeploy(true, { ALLOW_DB_PUSH_FALLBACK: "true" }).action).toBe("continue");
  });
  it("aborts on failure without flag (no db push)", () => {
    const d = decideAfterMigrateDeploy(false, {});
    expect(d.action).toBe("abort");
    expect(d.message).toContain("MIGRATE_DEPLOY_FAILED");
  });
  it("only the exact string true enables the fallback", () => {
    for (const v of ["1", "TRUE", "yes", "", "false", " true"]) {
      expect(decideAfterMigrateDeploy(false, { ALLOW_DB_PUSH_FALLBACK: v }).action).toBe("abort");
      expect(isDbPushFallbackAllowed({ ALLOW_DB_PUSH_FALLBACK: v })).toBe(false);
    }
  });
  it("falls back to db push with the flag", () => {
    expect(decideAfterMigrateDeploy(false, { ALLOW_DB_PUSH_FALLBACK: "true" }).action).toBe("db-push-fallback");
  });
});

const ok = (n: string) => ({ migration_name: n, finished_at: new Date(), rolled_back_at: null });
const failed = (n: string) => ({ migration_name: n, finished_at: null, rolled_back_at: null });

describe("schema-current continuation", () => {
  const local = ["a", "b"];
  it("continues when all local migrations are applied and the failed one is newer", () => {
    const d = decideAfterMigrateDeploy(false, {}, { localMigrations: local, dbRows: [ok("a"), ok("b"), failed("c")] });
    expect(d.action).toBe("continue-schema-current");
    expect(d.message).toContain("MIGRATE_DEPLOY_FAILED_BUT_SCHEMA_CURRENT");
    expect(d.message).toContain("c");
  });
  it("aborts when a local migration is failed or missing", () => {
    expect(decideAfterMigrateDeploy(false, {}, { localMigrations: local, dbRows: [ok("a"), failed("b")] }).action).toBe("abort");
    expect(decideAfterMigrateDeploy(false, {}, { localMigrations: local, dbRows: [ok("a")] }).action).toBe("abort");
  });
  it("a rolled-back local migration counts as not applied", () => {
    const rb = { migration_name: "b", finished_at: new Date(), rolled_back_at: new Date() };
    expect(assessSchema(local, [ok("a"), rb]).missing).toEqual(["b"]);
  });
  it("aborts when the state could not be read", () => {
    expect(decideAfterMigrateDeploy(false, {}, null).action).toBe("abort");
  });
});

describe("transient DB errors", () => {
  it("classifies connection-not-ready output", () => {
    for (const o of ["Error: P1001: Can't reach database server", "P1002 timed out", "connect ECONNREFUSED 10.0.0.1:5432"]) {
      expect(isTransientDbError(o)).toBe(true);
    }
  });
  it("does not retry real migration failures", () => {
    for (const o of ["P3009 migrate found failed migrations", "P3018 syntax error", "", undefined]) {
      expect(isTransientDbError(o)).toBe(false);
    }
  });
  it("backs off and caps", () => {
    expect(retryDelayMs(1)).toBe(5000);
    expect(retryDelayMs(2)).toBe(10000);
    expect(retryDelayMs(10)).toBe(30000);
  });
});
