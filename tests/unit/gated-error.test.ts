import { describe, expect, it } from "vitest";
import { gatedAwareError, skippedGatedNote } from "../../app/utils/gated-error.shared";
import { planTypeOfGid, AUDIT_ITEM_TYPE_TO_PLAN_TYPE } from "../../app/utils/ai-target-plan";
import { TYPE_TO_CONTENT_TYPE } from "../../app/services/seo/audit.service";

describe("gatedAwareError", () => {
  it("maps the raw gate code to the upgrade sentence", () => {
    expect(gatedAwareError("gated", "Upgrade erforderlich", "x")).toBe("Upgrade erforderlich");
  });
  it("keeps other errors and the fallback", () => {
    expect(gatedAwareError("boom", "u", "x")).toBe("boom");
    expect(gatedAwareError(undefined, "u", "fallback")).toBe("fallback");
  });
});

describe("skippedGatedNote", () => {
  it("renders the count, or nothing", () => {
    expect(skippedGatedNote([{}, {}], "{count} skipped")).toBe("2 skipped");
    expect(skippedGatedNote([], "{count} skipped")).toBeNull();
    expect(skippedGatedNote(undefined, "{count} skipped")).toBeNull();
  });
});

describe("plan type maps", () => {
  it("share one audit map and know both page GID spellings", () => {
    expect(TYPE_TO_CONTENT_TYPE).toBe(AUDIT_ITEM_TYPE_TO_PLAN_TYPE);
    expect(planTypeOfGid("gid://shopify/OnlineStorePage/1")).toBe("pages");
    expect(planTypeOfGid("gid://shopify/Page/1")).toBe("pages");
  });
});
