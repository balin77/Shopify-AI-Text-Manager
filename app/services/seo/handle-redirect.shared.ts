/**
 * PLAN_CONTENT_CREATION §Phase 3.3 / §A1 — a handle change breaks the old URL.
 *
 * This app changes handles in three places — the single editor, the bulk
 * editor's `field.handle` column, and bulk-translate — and before §3.3 created
 * a redirect in NONE of them. Every one of those edits silently 404s whatever
 * linked to the old address: search results, the merchant's own newsletter,
 * other shops. Shopify's admin offers a checkbox for exactly this; going
 * through the API removed the checkbox and, with it, the redirect.
 *
 * The decision is pure and lives here so all the write paths can share it and
 * so the cases that must NOT redirect are testable. Those cases are the whole
 * reason this is not a one-liner:
 *
 *   - a BRAND-NEW object has no old URL. A redirect from a handle that never
 *     existed is at best noise in the merchant's redirect list and at worst a
 *     loop once they reuse that handle elsewhere.
 *   - an unchanged handle is not a change, and neither is one that differs
 *     only in case or surrounding whitespace — Shopify normalises both.
 *   - a redirect whose source and target are equal is a LOOP. Shopify would
 *     accept it; the crawler in this very app would then report it.
 *   - the merchant may not want one. It is offered, not imposed.
 *
 * ── The locale prefix, MEASURED ────────────────────────────────────────────
 * This module only ever redirects PRIMARY-locale handles, and for a long time
 * the stated reason was that the interaction between a path-based redirect and
 * a locale prefix was unknown. It is not unknown any more. Measured 2026-08 on
 * a live translating shop with [api.redirect-locale-probe.tsx]
 * (../../routes/api.redirect-locale-probe.tsx) — a throwaway redirect
 * `/<probe>` → `/<target>`, both sides distinctive so neither answer can be
 * confused with a normalisation:
 *
 *   `/<probe>`      → 301 → `/<target>`
 *   `/en/<probe>`   → 301 → `/en/<target>`      ← NOT `/<target>`
 *
 * So both halves of the question have an answer: a prefixed path DOES match the
 * redirect table, and the prefix is CARRIED onto the target. One UNPREFIXED row
 * therefore serves every locale, and a per-locale row would be redundant rather
 * than necessary — the opposite of what the pessimistic reading assumed.
 *
 * `decideTranslatedHandleRedirect` at the bottom of this file is what that
 * measurement bought: the foreign-locale half of the same feature, with its own
 * set of things that must NOT happen.
 */

/** The types whose storefront URL is derived from a handle. */
export type RedirectableResource = "product" | "collection" | "page" | "article" | "blog";

/**
 * The app's own resource names → the ones above. Blog CONTAINERS and articles
 * share a tab and are told apart by their GID, which is why this takes the id.
 * Types with no handle-derived storefront URL (policies, metaobjects, theme
 * content) map to null.
 */
export function redirectResourceFor(
  resourceType: string,
  itemId: string,
): RedirectableResource | null {
  // The blogs tab serves BOTH, and their URLs differ in shape.
  if (itemId.includes("/Blog/")) return resourceType === "Article" || resourceType === "Blog" ? "blog" : null;
  switch (resourceType) {
    case "Product":    return "product";
    case "Collection": return "collection";
    case "Page":       return "page";
    case "Article":    return "article";
    default:           return null;
  }
}

/**
 * Does this save want a redirect?
 *
 * Three inputs, in precedence order, because there are three legitimate
 * answers and collapsing them loses one: an explicit per-save choice (a future
 * per-edit checkbox — the wire format exists now so adding it needs no server
 * change), then the shop's stored preference, and only then the default.
 *
 * The default is ON: a stray redirect is untidy, a broken URL costs traffic.
 * `null`/`undefined` from the settings row means "shop row predates the
 * column", which must behave as on rather than as an opt-out nobody chose.
 */
export function resolveRedirectPreference(
  submitted: string | null | undefined,
  shopPreference: boolean | null | undefined,
): boolean {
  if (submitted === "true") return true;
  if (submitted === "false") return false;
  return shopPreference !== false;
}

export interface HandleRedirectRequest {
  resource: RedirectableResource;
  previousHandle: string | null | undefined;
  nextHandle: string | null | undefined;
  /** The merchant's checkbox. Off ⇒ nothing happens, by their choice. */
  wanted: boolean;
  /** True while creating — there is no old URL to preserve. */
  isNew?: boolean;
  /**
   * Was the OLD URL ever reachable? `false` ⇒ no redirect: a draft's address is
   * one no visitor bookmarked and no engine indexed, so a redirect from it is
   * clutter in the merchant's list and a loop waiting to happen the moment they
   * reuse the handle. `isNew` covers only the create path; this covers the far
   * commoner case of a draft that has existed for weeks.
   *
   * `null`/`undefined` means NOT KNOWN, and unknown proceeds. The two failure
   * directions are not symmetric: a redirect too many is one row a merchant can
   * delete, a redirect too few is traffic nobody notices losing. (IndexNow
   * resolves the same uncertainty the other way, and for the mirror-image
   * reason — there, acting on a guess would publish a draft's URL.)
   */
  previouslyLive?: boolean | null;
  /** Articles live under their blog: `/blogs/<blog>/<article>`. */
  blogHandle?: string | null;
}

/**
 * Was this object's storefront URL reachable, from what the cache holds?
 *
 * Deliberately per-type, because the four types answer it with different
 * columns — and two of them cannot answer it at all:
 *
 *   product     `status`. ACTIVE is live; UNLISTED is TOO — it is reachable by
 *               direct link, which is exactly the kind of URL someone has in a
 *               newsletter. DRAFT and ARCHIVED are not.
 *   page,       `isPublished` — but only once `attributesSyncedAt` is set. The
 *   article     column defaults to true, so on an older row it is not data.
 *   collection  Visibility lives in publications, which this app has no scope
 *               for. Unknown.
 *   blog        A blog index exists as soon as the blog does.
 */
export function wasEverLive(
  resource: RedirectableResource,
  state: { status?: string | null; isPublished?: boolean | null; attributesKnown?: boolean },
): boolean | null {
  switch (resource) {
    case "product": {
      const status = (state.status ?? "").trim().toUpperCase();
      if (!status) return null;
      return status === "ACTIVE" || status === "UNLISTED";
    }
    case "page":
    case "article":
      if (state.attributesKnown === false) return null;
      return state.isPublished ?? null;
    case "blog":
      return true;
    case "collection":
      return null;
  }
}

export type HandleRedirectDecision =
  | { redirect: true; fromPath: string; toPath: string }
  | {
      redirect: false;
      reason:
        | "notWanted"
        | "isNew"
        | "neverLive"
        | "unchanged"
        | "missingHandle"
        | "missingBlogHandle"
        | "wouldLoop"
        // ── foreign-locale only, see decideTranslatedHandleRedirect ──────────
        /** This locale had no translated handle before, so it was served under
         *  the PRIMARY one — an address that is still live. */
        | "notTranslatedBefore"
        /** A market override is not a shop-wide path. */
        | "marketScoped"
        /** The old translated handle is still somebody's live address. */
        | "pathStillLive"
        /** The resource's own primary handle could not be read, so the check
         *  that keeps a redirect OFF that handle cannot be made. */
        | "primaryHandleUnknown"
        /** An article under a blog whose OWN handle is translated: which
         *  spelling of the blog segment the storefront serves is unmeasured. */
        | "localeBlogHandleUnknown";
    };

/** Trim, strip surrounding slashes, lowercase — what Shopify does to a handle. */
export function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^\/+|\/+$/g, "").toLowerCase();
}

/** Storefront PATH (not URL) for a handle — redirects are path-based. */
export function storefrontPathFor(
  resource: RedirectableResource,
  handle: string,
  blogHandle?: string | null,
): string | null {
  const clean = handle.trim().replace(/^\/+|\/+$/g, "");
  if (!clean) return null;
  switch (resource) {
    case "product":    return `/products/${clean}`;
    case "collection": return `/collections/${clean}`;
    case "page":       return `/pages/${clean}`;
    // A blog's own index page. Its ARTICLES live one level below and each has
    // its own path, so this redirect does NOT cover them — Shopify's redirects
    // have no wildcards. `blogArticlesUncovered` says so rather than letting
    // the merchant assume otherwise; see the note code in the server half.
    case "blog":       return `/blogs/${clean}`;
    case "article": {
      const blog = (blogHandle ?? "").trim().replace(/^\/+|\/+$/g, "");
      // Without the blog handle the article's URL is not derivable, and a
      // guessed path is worse than none: it would redirect a URL that never
      // existed, and leave the real old one still broken.
      return blog ? `/blogs/${blog}/${clean}` : null;
    }
  }
}

export function decideHandleRedirect(request: HandleRedirectRequest): HandleRedirectDecision {
  if (!request.wanted) return { redirect: false, reason: "notWanted" };
  // A brand-new object has no old URL to preserve.
  if (request.isNew) return { redirect: false, reason: "isNew" };
  // Neither has one that was never reachable. Checked BEFORE the handles,
  // because it is a fact about the object rather than about the edit.
  if (request.previouslyLive === false) return { redirect: false, reason: "neverLive" };

  const previous = (request.previousHandle ?? "").trim();
  const next = (request.nextHandle ?? "").trim();
  if (!previous || !next) return { redirect: false, reason: "missingHandle" };

  // Compared the way the PATH is built — trimmed, unslashed, lowercased —
  // because that is what decides whether the URL actually differs. Comparing
  // the raw strings would call "/same/" → "same" a change and then refuse it
  // one step later as a loop: the same outcome, reported as the wrong reason.
  // Shopify normalises handles this way too.
  if (normalizeHandle(previous) === normalizeHandle(next)) return { redirect: false, reason: "unchanged" };

  const fromPath = storefrontPathFor(request.resource, previous, request.blogHandle);
  const toPath = storefrontPathFor(request.resource, next, request.blogHandle);
  if (!fromPath || !toPath) {
    return {
      redirect: false,
      reason: request.resource === "article" ? "missingBlogHandle" : "missingHandle",
    };
  }
  if (fromPath.toLowerCase() === toPath.toLowerCase()) return { redirect: false, reason: "wouldLoop" };

  return { redirect: true, fromPath, toPath };
}

// ── The foreign-locale half ──────────────────────────────────────────────────

export interface TranslatedHandleRedirectRequest {
  resource: RedirectableResource;
  /** `""` = global. Anything else is a market override — see below. */
  marketId: string;
  /** The handle translation this locale held BEFORE the write. */
  previousTranslatedHandle: string | null | undefined;
  /** The one it holds now. Empty ⇒ the merchant CLEARED it. */
  nextTranslatedHandle: string | null | undefined;
  /**
   * The resource's own PRIMARY handle. Two jobs: it is the address the locale
   * falls back to when the translation is cleared, and it is the one path this
   * decision must never redirect.
   */
  primaryHandle: string | null | undefined;
  /**
   * The SAME resource's handle translations in every OTHER locale. A redirect
   * row is unprefixed and therefore fires in all of them, so a path that is
   * another locale's live address is not available as a source.
   */
  otherLocaleHandles?: string[];
  /**
   * Does ANOTHER resource of the same type already answer the old handle as its
   * PRIMARY one? Resolved by the caller (it is a DB question). The primary
   * redirect path needs no such check — Shopify enforces primary-handle
   * uniqueness, so a renamed-away handle is free by construction. A TRANSLATED
   * handle has no such guarantee and can sit on a live product's own address.
   */
  previousHandleTakenElsewhere?: boolean;
  wanted: boolean;
  previouslyLive?: boolean | null;
  /** The blog's PRIMARY handle — the article path's first segment. */
  blogHandle?: string | null;
  /** Does the blog carry a handle translation in THIS locale? */
  blogHandleTranslatedInLocale?: boolean;
}

/**
 * Does a change to a TRANSLATED handle owe the old URL a redirect?
 *
 * Same feature as above, one locale over, and it exists because the measurement
 * at the top of this file says one unprefixed row covers every locale. That is
 * also what makes it delicate: the row this returns fires under EVERY prefix,
 * including locales that were not edited, so the source path has to be one that
 * nothing else answers. Five rules do that work, and each of them is a URL that
 * would otherwise break:
 *
 *  1. **No previous translation ⇒ nothing to redirect.** Before the first
 *     translation the locale served the object under its PRIMARY handle, and
 *     that address stays live afterwards (Shopify answers 200 for it behind a
 *     prefix and canonicalises to the translated URL). Nothing broke, so there
 *     is nothing to preserve — and acting anyway would put a redirect on the
 *     primary path, i.e. on the shop's most important live URL. This is also
 *     why bulk-translate produces no redirects at all: it only ever FILLS empty
 *     translations, which is exactly this case.
 *  2. **The old handle must not still be somebody's address.** If it equals the
 *     primary handle, another locale's translation of the same resource, or —
 *     via `previousHandleTakenElsewhere`, which the caller resolves — another
 *     resource's PRIMARY handle, the unprefixed row would hijack a live page.
 *     That last one has no counterpart on the primary path: Shopify enforces
 *     primary-handle uniqueness, so a renamed-away primary handle is free by
 *     construction, while nothing stops a TRANSLATED handle from being another
 *     product's live address. An unknown primary handle refuses outright, since
 *     the check cannot be made at all without it.
 *  3. **Market overrides are out.** A `marketId` translation is served to one
 *     market, while a redirect row is shop-wide; one cannot express the other.
 *  4. **A cleared translation redirects BACK to the primary handle**, which is
 *     what the locale falls back to serving. This is the case where the old URL
 *     genuinely dies, so it is the one that most needs the row.
 *  5. **Articles under a blog with a translated handle are skipped.** The path
 *     has two translatable segments and which spelling the storefront serves
 *     for the outer one is not measured. A guessed path is worse than none: it
 *     redirects a URL that never existed and leaves the real one broken. With
 *     no blog-handle translation there is only one possible spelling, so those
 *     articles ARE covered.
 *
 * Two residuals, stated rather than hidden:
 *
 *  - A collision with a different resource's TRANSLATED handle in some other
 *    locale is not checked. `ContentTranslation.value` has no index, so that
 *    check would be a per-row scan of the shop's translations on a path that
 *    renames hundreds of rows at a time. Its PRIMARY-handle sibling is checked
 *    (rule 2), because that one is a single lookup on the resource's own table.
 *  - Two locales that share a slug are decided by whoever writes last: rule 2
 *    only sees the other locale's row while it still exists, so clearing `fr`'s
 *    handle and THEN renaming `de`'s identical one repoints the row `fr` just
 *    created. Both rows are the same path, and one path can hold one redirect.
 */
export function decideTranslatedHandleRedirect(
  request: TranslatedHandleRedirectRequest,
): HandleRedirectDecision {
  if (!request.wanted) return { redirect: false, reason: "notWanted" };
  if (request.previouslyLive === false) return { redirect: false, reason: "neverLive" };
  if (request.marketId !== "") return { redirect: false, reason: "marketScoped" };

  const previous = normalizeHandle(request.previousTranslatedHandle ?? "");
  if (!previous) return { redirect: false, reason: "notTranslatedBefore" };

  const primary = normalizeHandle(request.primaryHandle ?? "");
  // Unknown primary handle ⇒ refuse. Rule 2's most important half is "the old
  // handle must not BE the primary one", and without the primary handle that
  // check silently passes — turning a cache miss or a throttled lookup into a
  // redirect on the shop's most important live URL. The primary path refuses
  // an unknown handle for the same reason; "unknown proceeds" applies to
  // whether an object was LIVE, never to what its address is.
  if (!primary) return { redirect: false, reason: "primaryHandleUnknown" };

  // Cleared ⇒ the locale is served under the primary handle again, so that is
  // where the dead translated URL should point.
  const next = normalizeHandle(request.nextTranslatedHandle ?? "") || primary;
  if (!next) return { redirect: false, reason: "missingHandle" };

  if (previous === next) return { redirect: false, reason: "unchanged" };

  // Rule 2. Checked AFTER "unchanged" so a no-op edit reports the reason it
  // actually had, and before the paths are built because it is a fact about the
  // handle rather than about the URL shape.
  const live = new Set([primary, ...(request.otherLocaleHandles ?? []).map(normalizeHandle)].filter(Boolean));
  if (live.has(previous) || request.previousHandleTakenElsewhere) {
    return { redirect: false, reason: "pathStillLive" };
  }

  if (request.resource === "article" && request.blogHandleTranslatedInLocale) {
    return { redirect: false, reason: "localeBlogHandleUnknown" };
  }

  const fromPath = storefrontPathFor(request.resource, previous, request.blogHandle);
  const toPath = storefrontPathFor(request.resource, next, request.blogHandle);
  if (!fromPath || !toPath) {
    return {
      redirect: false,
      reason: request.resource === "article" ? "missingBlogHandle" : "missingHandle",
    };
  }
  if (fromPath.toLowerCase() === toPath.toLowerCase()) return { redirect: false, reason: "wouldLoop" };

  return { redirect: true, fromPath, toPath };
}
