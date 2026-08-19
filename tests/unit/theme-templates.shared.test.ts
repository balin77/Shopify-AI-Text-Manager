import { describe, it, expect } from "vitest";
import {
  isThemeTemplateResource,
  templateResourceFor,
  themeTemplateGlobs,
  themeTemplateSuffixes,
} from "../../app/services/theme-templates.shared";

describe("templateResourceFor", () => {
  it("maps each content type to its template family", () => {
    expect(templateResourceFor("products")).toBe("product");
    expect(templateResourceFor("collections")).toBe("collection");
    expect(templateResourceFor("pages")).toBe("page");
  });

  it("splits the blog tab's two resources", () => {
    // `templates/blog.*` renders the article LIST, `templates/article.*` one
    // post. Handing either the other's list offers suffixes that render
    // nothing.
    expect(templateResourceFor("blogs", { isBlogContainer: true })).toBe("blog");
    expect(templateResourceFor("blogs", { isBlogContainer: false })).toBe("article");
    expect(templateResourceFor("blogs")).toBe("article");
  });

  it("answers null for a type with no theme templates", () => {
    // Policies, metaobjects, theme content: no `templateSuffix` at all. The
    // renderer falls back to the plain control rather than to an empty
    // dropdown.
    expect(templateResourceFor("policies")).toBeNull();
    expect(templateResourceFor("metaobjects")).toBeNull();
    expect(templateResourceFor("")).toBeNull();
  });

  it("guards the route's own parameter", () => {
    expect(isThemeTemplateResource("product")).toBe(true);
    expect(isThemeTemplateResource("products")).toBe(false);
    expect(isThemeTemplateResource("../../secrets")).toBe(false);
  });
});

describe("themeTemplateGlobs", () => {
  it("asks for both file shapes of one resource", () => {
    expect(themeTemplateGlobs("product")).toEqual([
      "templates/product.*.liquid",
      "templates/product.*.json",
    ]);
  });
});

describe("themeTemplateSuffixes", () => {
  it("reads the suffix out of both file shapes", () => {
    expect(
      themeTemplateSuffixes(
        ["templates/product.gift-card.liquid", "templates/product.wide.json"],
        "product",
      ),
    ).toEqual(["gift-card", "wide"]);
  });

  it("drops the default template", () => {
    // The empty suffix is the control's own first option, and the file may not
    // even exist in a theme that renders products from a section group.
    expect(themeTemplateSuffixes(["templates/product.liquid", "templates/product.json"], "product")).toEqual([]);
  });

  it("de-duplicates a suffix that exists as both .liquid and .json", () => {
    // Shopify stores ONE suffix; two files with the same one are one option.
    expect(
      themeTemplateSuffixes(["templates/product.wide.liquid", "templates/product.wide.json"], "product"),
    ).toEqual(["wide"]);
  });

  it("ignores every file that is not this resource's template", () => {
    expect(
      themeTemplateSuffixes(
        [
          "templates/collection.grid.liquid", // another resource
          "templates/customers/account.liquid", // a subfolder
          "sections/product-form.liquid", // not a template at all
          "templates/product.wide.css", // not a template shape
          "templates/productive.thing.liquid", // merely starts the same way
          "templates/product.custom.liquid",
        ],
        "product",
      ),
    ).toEqual(["custom"]);
  });

  it("keeps `blog` and `article` apart", () => {
    // The prefix is matched with its dot, so one never swallows the other.
    const files = ["templates/blog.news.liquid", "templates/article.long-read.liquid"];
    expect(themeTemplateSuffixes(files, "blog")).toEqual(["news"]);
    expect(themeTemplateSuffixes(files, "article")).toEqual(["long-read"]);
  });

  it("sorts, so the dropdown does not reshuffle between two loads", () => {
    expect(
      themeTemplateSuffixes(
        ["templates/page.zebra.liquid", "templates/page.about.liquid", "templates/page.contact.json"],
        "page",
      ),
    ).toEqual(["about", "contact", "zebra"]);
  });

  it("survives a response that is not a list of strings", () => {
    // A partial GraphQL answer can carry nulls; a picker that throws on one
    // takes the whole Details card down with it.
    expect(themeTemplateSuffixes([null as never, undefined as never, ""], "product")).toEqual([]);
  });
});
