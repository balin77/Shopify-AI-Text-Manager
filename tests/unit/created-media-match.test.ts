import { describe, it, expect } from "vitest";
import { filenameFits, filenameOfUrl, matchUploadsToCreatedMedia } from "~/services/created-media-match.shared";

const req = (name: string, dir = "1") => ({ resourceUrl: `https://staged/tmp/${dir}/${name}` });

describe("filenameFits", () => {
  it("exact stem, case-insensitive, jpeg = jpg", () => {
    expect(filenameFits("Hero.JPG", "hero.jpg")).toBe(true);
    expect(filenameFits("hero.jpeg", "hero.jpg")).toBe(true);
  });
  it("stem plus an appended suffix", () => {
    expect(filenameFits("hero.jpg", "hero_1a2b.jpg")).toBe(true);
    expect(filenameFits("hero.jpg", "hero_.jpg")).toBe(false);
    expect(filenameFits("hero.jpg", "heroine.jpg")).toBe(false);
  });
  it("a different extension never fits", () => {
    expect(filenameFits("hero.jpg", "hero.png")).toBe(false);
  });
  it("decodes and strips queries", () => {
    expect(filenameOfUrl("https://x/a%20b.JPG?v=1")).toBe("a b.jpg");
  });
});

describe("matchUploadsToCreatedMedia", () => {
  it("unique both ways maps; a refused upload (all created accounted for) is not uncertain", () => {
    const r = matchUploadsToCreatedMedia([req("a.jpg"), req("b.jpg")], [{ id: "m1", filename: "b.jpg" }]);
    expect(r.mapped).toEqual({ "https://staged/tmp/1/b.jpg": "m1" });
    expect(r.uncertain).toEqual([]);
  });
  it("the same stem twice is uncertain, not mapped", () => {
    const r = matchUploadsToCreatedMedia([req("a.jpg", "1"), req("a.jpg", "2")], [{ id: "m1", filename: "a.jpg" }]);
    expect(r.mapped).toEqual({});
    expect(r.uncertain).toHaveLength(2);
  });
  it("one upload fitting two created media is uncertain", () => {
    const r = matchUploadsToCreatedMedia([req("a.jpg")], [{ id: "m1", filename: "a.jpg" }, { id: "m2", filename: "a_x.jpg" }]);
    expect(r.mapped).toEqual({});
    expect(r.uncertain).toEqual(["https://staged/tmp/1/a.jpg"]);
  });
  it("a created medium without a filename cannot be tied: the unmapped uploads are uncertain", () => {
    const r = matchUploadsToCreatedMedia([req("a.jpg"), req("b.jpg")], [{ id: "m1", filename: null }]);
    expect(r.mapped).toEqual({});
    expect(r.uncertain).toHaveLength(2);
  });
});
