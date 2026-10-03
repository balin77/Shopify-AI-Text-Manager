import { describe, it, expect } from "vitest";
import { carryNotes, strongestTone } from "~/services/editor/info-tone.shared";

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

describe("carryNotes (accept-and-translate step 2 keeps step 1's notes)", () => {
  const ok = { text: "Title translated to 2 language(s)", tone: "success" as const };
  it("appends a redirect note; a success note does not raise the tone", () => {
    const out = carryNotes(ok, [{ text: "Redirect /a to /b created.", tone: "success" }]);
    expect(out.text).toBe("Title translated to 2 language(s) Redirect /a to /b created.");
    expect(out.tone).toBe("success");
  });
  it("a failed redirect stays critical, a warning outranks a note", () => {
    expect(carryNotes(ok, [{ text: "Redirect failed.", tone: "critical" }, { text: "Not confirmed: Title.", tone: "warning" }]).tone).toBe("critical");
    expect(carryNotes(ok, [{ text: "Not confirmed: Title.", tone: "warning" }]).tone).toBe("warning");
  });
  it("keeps a base warning and drops empty or already-said notes", () => {
    const base = { text: "Partly done. Redirect failed.", tone: "warning" as const };
    expect(carryNotes(base, [{ text: "", tone: "warning" }, { text: "Redirect failed.", tone: "critical" }])).toBe(base);
  });
});

describe("accept-and-translate wiring", () => {
  it("every step-2 message of the primary flow goes through carryNotes", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("app/hooks/useUnifiedContentEditor.ts", "utf8");
    const start = src.indexOf("const sayStep2 =");
    const end = src.indexOf("Don't revalidate here", start);
    expect(start).toBeGreaterThan(0);
    const seg = src.slice(start, end);
    expect(seg).toContain("carryNotes(");
    // after the helper's own definition no step-2 path may show a bare message
    expect(seg.slice(seg.indexOf("};") + 2)).not.toMatch(/\bshowInfoBox\(/);
  });
});
