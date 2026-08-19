/**
 * Which theme templates the published theme offers for one resource.
 *
 * The theme template used to be a free-text box, which is the wrong control for
 * a value that has to match a FILE: a suffix nobody created renders the
 * resource with the default template and reports nothing anywhere. Shopify's
 * own admin offers a dropdown, and this is what fills it.
 *
 * ── The published theme, never the selected one ─────────────────────────────
 * This app has a theme SELECTOR for theme content, where editing an unpublished
 * theme is the point. Not here: `templateSuffix` decides what the STOREFRONT
 * renders, and the storefront runs the MAIN theme. Offering another theme's
 * templates would offer suffixes that render nothing for every visitor.
 *
 * ── Two queries, because "no match" has two causes ──────────────────────────
 * The glob query (`templates/product.*.liquid`) is what this wants to ask, and
 * it is cheap. But an empty answer from it is ambiguous — a theme with no
 * custom templates and a pattern the API did not honour look identical — so an
 * empty result falls back to paging the file list and filtering here. The
 * fallback is the correctness guarantee; the glob is the shortcut.
 *
 * ── An empty list is not an answer ──────────────────────────────────────────
 * `success: false` when the lookup failed, so the control can tell "this theme
 * has only the default template" from "we could not ask". The same rule as
 * `getCachedShopLocales` and `attributesSyncedAt`: a failed lookup rendered as
 * an empty dropdown is a control whose next save clears a working value.
 */

import { data as json, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { logger } from "~/utils/logger.server";
import { GET_THEMES, GET_THEME_FILE_NAMES, GET_ALL_THEME_FILE_NAMES } from "~/graphql/content.queries";
import {
  isThemeTemplateResource,
  themeTemplateGlobs,
  themeTemplateSuffixes,
} from "~/services/theme-templates.shared";

/** A theme's whole file list, in pages. Dawn sits around 200; three is plenty. */
const FILE_PAGE_SIZE = 250;
const MAX_FILE_PAGES = 4;

export interface ThemeTemplatesResponse {
  success: boolean;
  /** Suffixes only — the empty "default" option is the control's own. */
  suffixes: string[];
  error?: string;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const resource = url.searchParams.get("resource") || "";

  if (!isThemeTemplateResource(resource)) {
    return json<ThemeTemplatesResponse>({ success: false, suffixes: [], error: "unknown-resource" }, { status: 400 });
  }

  try {
    const themesRes = await admin.graphql(GET_THEMES, { variables: { first: 50 } });
    const themesJson: any = await themesRes.json();
    const edges = themesJson?.data?.themes?.edges ?? [];
    // The published theme is role MAIN (OnlineStoreThemeRole has no PUBLISHED).
    const themeId: string | undefined = edges.find((e: any) => e?.node?.role === "MAIN")?.node?.id;
    if (!themeId) {
      // Not "no templates": a shop whose theme this app cannot see still has
      // one, and its suffix must stay editable.
      return json<ThemeTemplatesResponse>({ success: false, suffixes: [], error: "no-main-theme" });
    }

    const globRes = await admin.graphql(GET_THEME_FILE_NAMES, {
      variables: { themeId, filenames: themeTemplateGlobs(resource), first: FILE_PAGE_SIZE },
    });
    const globJson: any = await globRes.json();
    const globNames: string[] = (globJson?.data?.theme?.files?.nodes ?? []).map((n: any) => n?.filename);
    const fromGlob = themeTemplateSuffixes(globNames, resource);
    if (fromGlob.length > 0) {
      return json<ThemeTemplatesResponse>({ success: true, suffixes: fromGlob });
    }

    // Nothing matched. That is the common, correct answer for a stock theme —
    // but it is also what an unhonoured pattern looks like, so the file list is
    // swept once before the answer is reported as "only the default".
    const names: string[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_FILE_PAGES; page += 1) {
      const res = await admin.graphql(GET_ALL_THEME_FILE_NAMES, {
        variables: { themeId, first: FILE_PAGE_SIZE, after },
      });
      const body: any = await res.json();
      const files = body?.data?.theme?.files;
      if (!files) break;
      for (const node of files.nodes ?? []) {
        if (node?.filename) names.push(node.filename as string);
      }
      if (!files.pageInfo?.hasNextPage) break;
      after = files.pageInfo.endCursor ?? null;
      if (!after) break;
    }

    return json<ThemeTemplatesResponse>({ success: true, suffixes: themeTemplateSuffixes(names, resource) });
  } catch (error) {
    logger.error("[api.theme-templates] lookup failed", { resource, error });
    return json<ThemeTemplatesResponse>({ success: false, suffixes: [], error: "lookup-failed" });
  }
}
