import { describe, it, expect } from "vitest";
import { strongestTone } from "~/services/editor/info-tone.shared";

describe("strongestTone", () => {
  it("critical stays critical, a warning outranks a note", () => {
    expect(strongestTone(["info", "critical", "warning"])).toBe("critical");
    expect(strongestTone(["info", "warning"])).toBe("warning");
  });
  it("a plain success never raises the tone; nothing falls back", () => {
    expect(strongestTone(["info", "success"])).toBe("info");
    expect(strongestTone([])).toBe("info");
  });
});
