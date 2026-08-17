/**
 * The indexability verdict — ONE copy (PLAN_SEO_CRAWL_EXPANSION §3.1).
 *
 * Lives in its own client-safe module because two very different consumers
 * need it: `onpage.service.ts` (which imports `crawl.service` and is therefore
 * server-only) and `crawl-diff.ts` (which the crawl report renders in
 * component scope). `crawl-diff` used to carry a hand-copied duplicate of
 * these fifteen lines — and the copy is exactly what let one parsing bug ship
 * to both. The rule is subtle enough that it must exist once.
 */

export type IndexabilityVerdict =
  /** Nothing stops it from being indexed. */
  | "indexable"
  /** `noindex`/`none` in the meta tag OR the X-Robots-Tag header. */
  | "noindex"
  /** Indexable, but its links are not followed. */
  | "nofollow_only"
  /** The snapshot never looked (old row, or a page with no body). NOT "fine". */
  | "unknown";

export interface IndexabilityInput {
  metaRobots: string;
  xRobotsTag: string;
  indexabilityKnown: boolean;
  statusCode: number;
}

/**
 * Robots directives that carry a VALUE after a colon. Google documents all
 * four, and themes/SEO apps emit them routinely.
 *
 * They are the reason a token cannot simply be "everything after the colon":
 * `max-image-preview:none` would reduce to the bare word `none`, which is
 * shorthand for `noindex, nofollow` — turning a perfectly indexable page into
 * the report's loudest possible finding (top of the dashboard, critical banner
 * on the on-page tab, `targetNoindex` on every page canonicalising to it).
 */
const VALUE_DIRECTIVES = new Set([
  "max-snippet",
  "max-image-preview",
  "max-video-preview",
  "unavailable_after",
]);

/**
 * Splits a robots directive string into bare directive tokens.
 *
 * Both sources are comma-separated lists. `X-Robots-Tag` may additionally
 * address a specific crawler (`googlebot: noindex, nosnippet`), and repeated
 * headers arrive comma-joined from `Headers.get()`, so a token can carry a
 * `<user-agent>:` prefix. The prefix is dropped rather than parsed: a
 * `noindex` aimed at Googlebot is exactly the finding this report exists for,
 * so narrowing by user-agent would hide the most valuable case.
 *
 * A `key:value` DIRECTIVE keeps its key as the token instead — see
 * VALUE_DIRECTIVES for why that distinction is not cosmetic.
 */
export function robotsTokens(raw: string): string[] {
  return (raw || "")
    .split(",")
    .map((part) => {
      const trimmed = part.trim();
      const colon = trimmed.indexOf(":");
      if (colon < 0) return trimmed.toLowerCase();
      const left = trimmed.slice(0, colon).trim().toLowerCase();
      // `max-image-preview:none` — the KEY is the directive; its value says
      // nothing about indexing.
      if (VALUE_DIRECTIVES.has(left)) return left;
      // Anything else before a colon is a user-agent selector.
      return trimmed.slice(colon + 1).trim().toLowerCase();
    })
    .filter(Boolean);
}

/**
 * The page's indexability, derived — never stored (§1.1): the raw strings are
 * persisted so this rule can be corrected without a re-crawl.
 *
 * `none` is shorthand for `noindex, nofollow`, so it counts as both.
 */
export function deriveIndexability(row: IndexabilityInput): IndexabilityVerdict {
  // The flag, not the emptiness of the strings, is the discriminator: "" means
  // "no directive served" OR "row written before the columns existed", and
  // those are indistinguishable (§1.1).
  if (!row.indexabilityKnown) return "unknown";
  // Defensive: a non-2xx page never had a body parsed, so there is nothing to
  // judge even if the flag somehow says otherwise.
  if (row.statusCode < 200 || row.statusCode >= 300) return "unknown";

  const tokens = [...robotsTokens(row.metaRobots), ...robotsTokens(row.xRobotsTag)];
  if (tokens.some((t) => t === "noindex" || t === "none")) return "noindex";
  if (tokens.some((t) => t === "nofollow")) return "nofollow_only";
  return "indexable";
}
