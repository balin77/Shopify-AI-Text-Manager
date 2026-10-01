import { describe, it, expect } from "vitest";
import { translateErrorMessage } from "~/utils/editor-error-messages";

describe("translateErrorMessage plan refusal", () => {
  it("renders the gated code as the localized upgrade sentence", () => {
    const t = { content: { upgradeRequired: "Upgrade erforderlich" }, errors: {} } as never;
    expect(translateErrorMessage("gated", t)).toBe("Upgrade erforderlich");
  });
});
