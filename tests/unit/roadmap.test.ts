import { describe, it, expect } from "vitest";
import { ROADMAP, publicRoadmap } from "../../app/config/roadmap";

/**
 * The one roadmap file feeds the public website, so a defect here is a
 * defect on a page a merchant reads in three languages. These are the rules
 * the type system cannot state.
 */
describe("roadmap", () => {
  it("has unique ids (they are anchors on the website)", () => {
    const ids = ROADMAP.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every public entry real copy in all three languages", () => {
    for (const entry of publicRoadmap()) {
      for (const locale of ["en", "de", "es"] as const) {
        expect(entry.title[locale].trim().length, `${entry.id}.title.${locale}`).toBeGreaterThan(0);
        expect(entry.body[locale].trim().length, `${entry.id}.body.${locale}`).toBeGreaterThan(0);
      }
      // A body that is the same in two languages is a copy-paste that was
      // never translated.
      expect(entry.body.de, `${entry.id} de==en`).not.toBe(entry.body.en);
      expect(entry.body.es, `${entry.id} es==en`).not.toBe(entry.body.en);
    }
  });

  it("dates every public shipped entry, in ISO year-month at least", () => {
    for (const entry of publicRoadmap().filter((e) => e.status === "shipped")) {
      expect(entry.shippedOn, entry.id).toMatch(/^\d{4}-\d{2}(-\d{2})?$/);
    }
  });

  it("keeps dropped entries internal — the website has no section for them", () => {
    for (const entry of publicRoadmap()) {
      expect(entry.status, entry.id).not.toBe("dropped");
    }
  });

  it("keeps a reason on every dropped entry", () => {
    for (const entry of ROADMAP.filter((e) => e.status === "dropped")) {
      expect(entry.notes?.trim().length ?? 0, entry.id).toBeGreaterThan(20);
    }
  });
});
