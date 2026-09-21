/**
 * The published theme's template suffixes for one resource family.
 *
 * Two surfaces need the same answer: the single editor's `ThemeTemplateField`
 * (one item at a time) and the bulk editor's `field.templateSuffix` column
 * (a page of them). ONE lookup for both, for the reason this repo keeps saying:
 * two copies of a fetch come to disagree about the failure case, and the
 * failure case is the load-bearing half — a list that came back empty because
 * the query was throttled must NOT render as a dropdown whose next save clears
 * a working value.
 */

import { useEffect, useState } from "react";
import type { ThemeTemplateResource } from "~/services/theme-templates.shared";
import type { ThemeTemplatesResponse } from "~/routes/api.theme-templates";

export type ThemeTemplatesLoaded = { ok: true; suffixes: string[] } | { ok: false };

/**
 * One request per resource for the life of the page.
 *
 * The list belongs to the SHOP's published theme, not to the item, so clicking
 * through twenty products would otherwise fire twenty identical queries — the
 * same rule the taxonomy value picker follows. A FAILED result is dropped from
 * the map, so a network blip does not turn into a text box that stays for the
 * rest of the session.
 */
const inFlight = new Map<string, Promise<ThemeTemplatesLoaded>>();

export function loadThemeTemplateSuffixes(
  resource: ThemeTemplateResource,
): Promise<ThemeTemplatesLoaded> {
  const cached = inFlight.get(resource);
  if (cached) return cached;

  const request = fetch(`/api/theme-templates?resource=${encodeURIComponent(resource)}`)
    .then((r) => r.json() as Promise<ThemeTemplatesResponse>)
    .then((data): ThemeTemplatesLoaded =>
      data?.success ? { ok: true, suffixes: data.suffixes ?? [] } : { ok: false },
    )
    .catch((): ThemeTemplatesLoaded => ({ ok: false }));

  inFlight.set(resource, request);
  void request.then((result) => {
    if (!result.ok) inFlight.delete(resource);
  });
  return request;
}

/**
 * `null` until the lookup answers. A caller must keep those two apart from
 * `{ ok: true, suffixes: [] }` ("this theme has only the default template")
 * and from `{ ok: false }` ("we could not ask") — the same three-valued rule as
 * `attributesSyncedAt` and `getCachedShopLocales`.
 *
 * `resource` may be null for a row type that has no templates at all (a policy,
 * a metaobject), which simply never asks.
 */
export function useThemeTemplateSuffixes(
  resource: ThemeTemplateResource | null,
): ThemeTemplatesLoaded | null {
  const [loaded, setLoaded] = useState<ThemeTemplatesLoaded | null>(null);

  useEffect(() => {
    if (!resource) {
      setLoaded(null);
      return;
    }
    let cancelled = false;
    // Clear while the NEW resource is in flight: keeping the previous family's
    // list would offer a product's templates on a page row.
    setLoaded(null);
    void loadThemeTemplateSuffixes(resource).then((result) => {
      if (!cancelled) setLoaded(result);
    });
    return () => {
      cancelled = true;
    };
  }, [resource]);

  return loaded;
}
