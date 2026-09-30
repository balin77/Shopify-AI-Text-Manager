import { describe, expect, it } from "vitest";
import {
  GUIDE_CATEGORIES,
  GUIDE_TOPIC_ORDER,
  GUIDE_VIDEOS,
  guideCategoryOf,
  isGuideTopicId,
} from "../../app/config/marketing-guide";
import { MARKETING_LOCALES } from "../../app/services/marketing-locale.shared";
import { getGuideCopy } from "../../app/i18n/marketing/guide";

describe("marketing guide structure", () => {
  it("lists every topic exactly once", () => {
    // A topic in two categories would render twice on the index and make
    // prev/next walk in a circle.
    expect(new Set(GUIDE_TOPIC_ORDER).size).toBe(GUIDE_TOPIC_ORDER.length);
  });

  it("uses slugs that are safe as a URL segment", () => {
    for (const topic of GUIDE_TOPIC_ORDER) {
      expect(topic).toMatch(/^[a-z0-9-]+$/);
    }
    for (const category of GUIDE_CATEGORIES) {
      expect(category.id).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("gives every topic a video slot and a category", () => {
    for (const topic of GUIDE_TOPIC_ORDER) {
      expect(topic in GUIDE_VIDEOS).toBe(true);
      const category = GUIDE_CATEGORIES.find((c) => c.id === guideCategoryOf(topic));
      expect((category?.topics as readonly string[] | undefined)?.includes(topic)).toBe(true);
    }
  });

  it("refuses unknown slugs", () => {
    expect(isGuideTopicId("glossary")).toBe(true);
    expect(isGuideTopicId("nope")).toBe(false);
    expect(isGuideTopicId(undefined)).toBe(false);
  });
});

describe("marketing guide copy", () => {
  it("has a title, a summary and at least one non-empty section per topic in every language", () => {
    for (const locale of MARKETING_LOCALES) {
      const guide = getGuideCopy(locale);
      for (const topic of GUIDE_TOPIC_ORDER) {
        const copy = guide.topics[topic];
        expect(copy.title.trim(), `${locale}/${topic}`).not.toBe("");
        expect(copy.summary.trim(), `${locale}/${topic}`).not.toBe("");
        expect(copy.sections.length, `${locale}/${topic}`).toBeGreaterThan(0);
        for (const section of copy.sections) {
          const content =
            section.paragraphs.length + (section.list?.length ?? 0) + (section.steps?.length ?? 0);
          expect(content, `${locale}/${topic}/${section.heading}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("keeps section headings unique within a topic (they are React keys)", () => {
    for (const locale of MARKETING_LOCALES) {
      const guide = getGuideCopy(locale);
      for (const topic of GUIDE_TOPIC_ORDER) {
        const headings = guide.topics[topic].sections.map((s) => s.heading);
        expect(new Set(headings).size, `${locale}/${topic}`).toBe(headings.length);
      }
    }
  });
});
