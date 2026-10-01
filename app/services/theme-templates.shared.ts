/**
 * Which theme templates a resource can be rendered with.
 *
 * Shopify's own admin offers the theme template as a DROPDOWN, because the
 * value is not free text: it is the middle segment of a file that has to exist
 * in the published theme. `templates/product.gift-card.liquid` is offered as
 * "gift-card"; a suffix nobody ever created renders the product with the
 * DEFAULT template and no error anywhere, which is the whole reason typing it
 * by hand was the wrong control.
 *
 * This module is the pure half — the naming rule and nothing else — so the
 * parsing can be tested without a theme, and so the route and the client agree
 * on what a suffix is.
 */

/** The resources whose template list this app can offer. */
export type ThemeTemplateResource = "product" | "collection" | "page" | "article" | "blog";

const RESOURCES = new Set<string>(["product", "collection", "page", "article", "blog"]);

export function isThemeTemplateResource(value: string): value is ThemeTemplateResource {
  return RESOURCES.has(value);
}

/**
 * The editor's content type → the template file's first segment.
 *
 * The blog tab carries two resources on one page, and they template
 * separately: `templates/blog.<suffix>` renders the article LIST, while
 * `templates/article.<suffix>` renders one post. Handing an article the blog's
 * list would offer suffixes that render nothing.
 */
export function templateResourceFor(
  contentType: string,
  opts?: { isBlogContainer?: boolean },
): ThemeTemplateResource | null {
  switch (contentType) {
    case "products":
      return "product";
    case "collections":
      return "collection";
    case "pages":
      return "page";
    case "blogs":
      return opts?.isBlogContainer ? "blog" : "article";
    default:
      return null;
  }
}

/** The two shapes a template file comes in. A section-group JSON is one too. */
const TEMPLATE_EXTENSIONS = [".liquid", ".json"];

/**
 * The filename patterns worth asking Shopify for.
 *
 * `OnlineStoreTheme.files(filenames:)` takes glob patterns, and asking for the
 * ~6 files that can matter beats paging a theme's several hundred. It is not
 * TRUSTED, though: the route falls back to an unfiltered sweep when this comes
 * back empty, because "the pattern is unsupported" and "this theme has no
 * custom templates" are the same answer here, and the second one is common.
 */
export function themeTemplateGlobs(resource: ThemeTemplateResource): string[] {
  return TEMPLATE_EXTENSIONS.map((ext) => `templates/${resource}.*${ext}`);
}

/**
 * The suffixes hidden in a list of theme filenames.
 *
 * `templates/product.gift-card.liquid` → `gift-card`. Four things are dropped
 * on purpose:
 *
 *  - the DEFAULT template (`templates/product.liquid`), which is the empty
 *    suffix and is offered by the control itself rather than found here — the
 *    file may not even exist in a theme that renders products from a section
 *    group,
 *  - anything in a SUBFOLDER (`templates/customers/account.liquid`): the
 *    segment before the dot has to be the resource itself,
 *  - a neighbouring resource whose name merely starts the same way — `blog`
 *    against `blog.liquid` is exact, so `article` never matches it,
 *  - duplicates, because a theme may carry `product.wide.liquid` AND
 *    `product.wide.json` while Shopify stores one suffix.
 *
 * Sorted, so the dropdown does not reshuffle itself between two loads of the
 * same theme.
 */
export function themeTemplateSuffixes(filenames: string[], resource: string): string[] {
  const found = new Set<string>();

  for (const raw of filenames) {
    if (typeof raw !== "string") continue;
    const name = raw.trim();
    if (!name.startsWith("templates/")) continue;

    const file = name.slice("templates/".length);
    // A subfolder is somebody else's template (`customers/`, `metaobject/`).
    if (file.includes("/")) continue;

    const ext = TEMPLATE_EXTENSIONS.find((e) => file.endsWith(e));
    if (!ext) continue;

    const base = file.slice(0, -ext.length);
    if (!base.startsWith(`${resource}.`)) continue;

    const suffix = base.slice(resource.length + 1);
    // `templates/product..liquid` and the default template both land here.
    if (!suffix) continue;
    found.add(suffix);
  }

  return [...found].sort((a, b) => a.localeCompare(b));
}
