/**
 * PLAN_TASK_LIST_CLARITY §3.1 — the one module that names a task.
 *
 * Every case below is a defect this module exists to prevent, not a coverage
 * target:
 *
 *  - §B2: the alt-text paths create `bulkAIGeneration` while the i18n key is
 *    `bulkAiGeneration`. One letter, so every bulk alt-text task fell through
 *    to its raw identifier — and `MainNavigation`'s toast branch special-cased
 *    both spellings, which is how it stayed hidden.
 *  - §B1: nine task types had no label at all and the merchant read
 *    `imageWebpConversion` as a card heading. The fallback must HUMANISE, so a
 *    missing label costs polish rather than comprehension.
 *  - §B4: `resourceType` arrives capitalised (`"Product"`, app.seo.performance)
 *    and pluralised (`"products"`, api.translate-alt-text-template), and
 *    `seoBulkFix` stores a MACHINE string as its subject.
 *
 * The `t` bundles here are hand-built literals on purpose: the real bundle is
 * `any` throughout this codebase, and a test that imports it fails for reasons
 * that have nothing to do with this module.
 */

import { describe, it, expect } from "vitest";
import {
  taskTypeLabel,
  resourceTypeLabel,
  fieldTypeLabel,
  taskSubjectLabel,
} from "~/services/tasks/task-labels.shared";

/** Just the keys each case needs — never the whole bundle. */
const t = {
  tasks: {
    taskType: {
      bulkAiGeneration: "Bulk AI generation",
      seoCrawl: "Storefront crawl",
    },
    resourceType: {
      product: "Product",
      seo: "SEO",
    },
    fieldType: {
      altTextTemplate: "Alt-text template",
    },
    allAltTexts: "All alt-texts",
    imageAltText: "Alt-text for image {n}",
  },
  seo: {
    dashboard: {
      problems: {
        metaDescriptionMissing: "Meta description missing",
      },
    },
  },
};

/** The bundle shapes a component can really hand this module. */
const EMPTY_BUNDLES: any[] = [null, undefined, {}, { tasks: {} }];

describe("taskTypeLabel", () => {
  it("resolves both spellings of the bulk AI generation type from ONE key", () => {
    // §B2. The created type string is never renamed (running rows carry it,
    // and LONG_RUNNING_TASK_TYPES matches on it), so the alias lives here.
    expect(taskTypeLabel("bulkAiGeneration", t)).toBe("Bulk AI generation");
    expect(taskTypeLabel("bulkAIGeneration", t)).toBe("Bulk AI generation");
    expect(taskTypeLabel("bulkAIGeneration", t)).toBe(taskTypeLabel("bulkAiGeneration", t));
  });

  it("does not require a second i18n key for the alias spelling", () => {
    // The bundle carries only `bulkAiGeneration`; the alias must reach it.
    const oneKey = { tasks: { taskType: { bulkAiGeneration: "Bulk AI generation" } } };
    expect(taskTypeLabel("bulkAIGeneration", oneKey)).toBe("Bulk AI generation");
  });

  it("uses the labelled key when there is one", () => {
    expect(taskTypeLabel("seoCrawl", t)).toBe("Storefront crawl");
  });

  it("never returns an unknown identifier verbatim", () => {
    const label = taskTypeLabel("imageWebpConversionXyz", t);
    expect(label).not.toBe("imageWebpConversionXyz");
    expect(label).toBe("Image webp conversion xyz");
  });

  it("humanises camelCase, underscores, hyphens and acronym runs", () => {
    expect(taskTypeLabel("blogArticleRedirects", t)).toBe("Blog article redirects");
    expect(taskTypeLabel("image_webp_conversion", t)).toBe("Image webp conversion");
    expect(taskTypeLabel("image-webp-conversion", t)).toBe("Image webp conversion");
    // An acronym run is SPLIT at its boundary ("JSONLd" -> "JSON Ld") and the
    // whole phrase is then sentence-cased: only the first letter survives
    // capitalised, so a fallback cannot be mistaken for a real label.
    expect(taskTypeLabel("JSONLd", t)).toBe("Json ld");
    expect(taskTypeLabel("seoJSONLdAudit", t)).toBe("Seo json ld audit");
  });

  it("returns an empty string for a missing type rather than throwing", () => {
    expect(taskTypeLabel("", t)).toBe("");
    expect(taskTypeLabel(undefined as any, t)).toBe("");
    expect(taskTypeLabel(null as any, t)).toBe("");
  });

  it("still answers with no bundle at all", () => {
    for (const bundle of EMPTY_BUNDLES) {
      expect(taskTypeLabel("imageWebpConversion", bundle)).toBe("Image webp conversion");
      // With no bundle the alias has nothing to resolve TO, so the raw type
      // humanises — still never the identifier itself.
      expect(taskTypeLabel("bulkAIGeneration", bundle)).toBe("Bulk ai generation");
    }
  });
});

describe("resourceTypeLabel", () => {
  it("resolves the capitalised and plural spellings to the same label", () => {
    // §B4: "Product" from app.seo.performance.tsx, "products" from
    // api.translate-alt-text-template.tsx, "product" from everywhere else.
    expect(resourceTypeLabel("product", t)).toBe("Product");
    expect(resourceTypeLabel("Product", t)).toBe("Product");
    expect(resourceTypeLabel("products", t)).toBe("Product");
    expect(resourceTypeLabel("PRODUCTS", t)).toBe("Product");
  });

  it("resolves the other plural aliases", () => {
    const bundle = {
      tasks: { resourceType: { collection: "Collection", page: "Page", blog: "Blog" } },
    };
    expect(resourceTypeLabel("collections", bundle)).toBe("Collection");
    expect(resourceTypeLabel("pages", bundle)).toBe("Page");
    expect(resourceTypeLabel("blogs", bundle)).toBe("Blog");
    // An article is a blog post — the alias points at the blog label.
    expect(resourceTypeLabel("articles", bundle)).toBe("Blog");
  });

  it("labels the machine value `seo` that eight task types write", () => {
    expect(resourceTypeLabel("seo", t)).toBe("SEO");
  });

  it("returns null for an absent resource type, never an empty badge", () => {
    expect(resourceTypeLabel(null, t)).toBeNull();
    expect(resourceTypeLabel(undefined, t)).toBeNull();
    expect(resourceTypeLabel("", t)).toBeNull();
    expect(resourceTypeLabel("   ", t)).toBeNull();
  });

  it("humanises an unknown resource type instead of rendering it raw", () => {
    expect(resourceTypeLabel("templateTitles", t)).toBe("Template titles");
  });

  it("still answers with no bundle at all", () => {
    for (const bundle of EMPTY_BUNDLES) {
      expect(resourceTypeLabel("products", bundle)).toBe("Products");
      expect(resourceTypeLabel(null, bundle)).toBeNull();
    }
  });
});

describe("fieldTypeLabel", () => {
  it("step 1 — a labelled key wins", () => {
    expect(fieldTypeLabel("altTextTemplate", t)).toBe("Alt-text template");
  });

  it("step 2 — allAltTexts has its own entry outside the fieldType map", () => {
    expect(fieldTypeLabel("allAltTexts", t)).toBe("All alt-texts");
    // …and a bundle without it still says something readable.
    expect(fieldTypeLabel("allAltTexts", {})).toBe("all alt-texts");
  });

  it("step 3 — altText_<n> counts from 1, not from the stored index", () => {
    // The stored number is a zero-based image INDEX; merchants count images
    // from 1, so `altText_2` is the THIRD image.
    expect(fieldTypeLabel("altText_2", t)).toBe("Alt-text for image 3");
    expect(fieldTypeLabel("altText_0", t)).toBe("Alt-text for image 1");
    expect(fieldTypeLabel("altText_11", t)).toBe("Alt-text for image 12");
    // Without a template the off-by-one still holds.
    expect(fieldTypeLabel("altText_2", {})).toBe("Image 3 alt-text");
  });

  it("step 4 — a theme key routes through extractReadableName", () => {
    // Its own rule, not the humaniser: every word is capitalised and the
    // section prefix is stripped.
    expect(fieldTypeLabel("section.product.json.main_title", t)).toBe("Main Title");
    expect(fieldTypeLabel("section.product.json.main_title", t)).not.toBe("Main title");
  });

  it("step 4 — an unknown bare word humanises", () => {
    expect(fieldTypeLabel("sub-resources", t)).toBe("Sub resources");
    expect(fieldTypeLabel("direct-translations", t)).toBe("Direct translations");
    expect(fieldTypeLabel("autoTranslateExternalChange", t)).toBe("Auto translate external change");
    expect(fieldTypeLabel("altText", t)).toBe("Alt text");
  });

  it("returns null for an absent field type", () => {
    expect(fieldTypeLabel(null, t)).toBeNull();
    expect(fieldTypeLabel(undefined, t)).toBeNull();
    expect(fieldTypeLabel("", t)).toBeNull();
    expect(fieldTypeLabel("   ", t)).toBeNull();
  });

  it("still answers with no bundle at all", () => {
    for (const bundle of EMPTY_BUNDLES) {
      expect(fieldTypeLabel("allAltTexts", bundle)).toBe("all alt-texts");
      expect(fieldTypeLabel("altText_2", bundle)).toBe("Image 3 alt-text");
      expect(fieldTypeLabel("suggest", bundle)).toBe("Suggest");
      expect(fieldTypeLabel(null, bundle)).toBeNull();
    }
  });
});

describe("taskSubjectLabel", () => {
  it("decodes a seoBulkFix problem code through the dashboard's own labels", () => {
    expect(
      taskSubjectLabel({ type: "seoBulkFix", resourceTitle: "metaDescriptionMissing:fr" }, t),
    ).toBe("Meta description missing");
  });

  it("returns null for `fixAllForItem:…`, which carries no problem code", () => {
    expect(
      taskSubjectLabel({ type: "seoBulkFix", resourceTitle: "fixAllForItem:product:8123" }, t),
    ).toBeNull();
  });

  it("returns null — never the machine string — for an unlabelled code", () => {
    const subject = taskSubjectLabel(
      { type: "seoBulkFix", resourceTitle: "someUnknownProblem:de" },
      t,
    );
    expect(subject).toBeNull();
    expect(subject).not.toBe("someUnknownProblem:de");
    expect(subject).not.toBe("someUnknownProblem");
  });

  it("returns the resourceTitle for every other task type", () => {
    expect(taskSubjectLabel({ type: "aiGeneration", resourceTitle: "Kumiko box" }, t)).toBe(
      "Kumiko box",
    );
  });

  it("returns null for an empty or whitespace title, not an empty string", () => {
    expect(taskSubjectLabel({ type: "aiGeneration", resourceTitle: "" }, t)).toBeNull();
    expect(taskSubjectLabel({ type: "aiGeneration", resourceTitle: "   " }, t)).toBeNull();
    expect(taskSubjectLabel({ type: "aiGeneration", resourceTitle: null }, t)).toBeNull();
    expect(taskSubjectLabel({ type: "seoBulkFix", resourceTitle: "" }, t)).toBeNull();
    expect(taskSubjectLabel({ type: "seoBulkFix", resourceTitle: "   " }, t)).toBeNull();
  });

  it("still answers with no bundle at all", () => {
    for (const bundle of EMPTY_BUNDLES) {
      expect(
        taskSubjectLabel({ type: "seoBulkFix", resourceTitle: "metaDescriptionMissing:fr" }, bundle),
      ).toBeNull();
      expect(taskSubjectLabel({ type: "translation", resourceTitle: "Kumiko box" }, bundle)).toBe(
        "Kumiko box",
      );
    }
  });

  it("does not throw on a malformed task object", () => {
    expect(() => taskSubjectLabel(null as any, t)).not.toThrow();
    expect(taskSubjectLabel(null as any, t)).toBeNull();
    expect(taskSubjectLabel({} as any, t)).toBeNull();
  });
});
