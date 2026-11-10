import { describe, expect, it } from "vitest";
import { decideAfterMigrateDeploy, isDbPushFallbackAllowed } from "../../scripts/migrate-deploy-decision.js";

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
