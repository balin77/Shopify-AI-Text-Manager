/**
 * Answer Engine Optimization (SEO_TAB_IMPLEMENTATION_PLAN.md Phase 7 / Anhang D1).
 *
 * Two AI-search levers that need no Google approval:
 *  - **llms.txt**: a Markdown summary of the store for AI crawlers, written to
 *    the native `templates/llms.txt.liquid` theme file via Admin GraphQL
 *    (Shopify serves it at `/llms.txt`). Writing a *new* additive file is safe.
 *  - **robots.txt AI-crawler audit**: read-only check of the live robots.txt for
 *    AI bots that are blocked, classified rule by rule. Rewriting
 *    `robots.txt.liquid` is possible but treated as the footgun it is: it only
 *    ever *removes* merchant-selected Disallow rules, refuses to touch a file it
 *    didn't write, and re-fetches the live robots.txt afterwards to roll back a
 *    write that broke it (`applyRobotsRuleRemovals`).
 *
 * `buildLlmsTxt` and `auditRobotsTxt` are pure (unit-tested); theme reads/writes
 * use the existing GET_THEMES / GET_THEME_FILES / UPSERT_THEME_FILES ops and the
 * already-present `write_themes` scope. No new model, no new scope.
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { meetsPlan } from "../../utils/planUtils";
import type { Plan } from "../../config/plans";
import { GET_THEMES, GET_THEME_FILES } from "../../graphql/content.queries";
import { UPSERT_THEME_FILES, DELETE_THEME_FILES } from "../../graphql/content.mutations";

/**
 * AI crawler user-agents to audit in robots.txt (2026). Mix of training and
 * AI-search bots across the major providers.
 */
export const AI_CRAWLERS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "PerplexityBot",
  "Perplexity-User",
  "ClaudeBot",
  "Claude-SearchBot",
  "Claude-User",
  "Google-Extended",
  "Applebot-Extended",
  "Bytespider",
  "Amazonbot",
  "CCBot",
  "meta-externalagent",
];

export const LLMS_TEMPLATE_FILENAME = "templates/llms.txt.liquid";
export const ROBOTS_TEMPLATE_FILENAME = "templates/robots.txt.liquid";

// ── llms.txt ─────────────────────────────────────────────────────────────────

export interface LlmsTxtItem {
  title: string;
  handle: string;
  description?: string | null;
}

export interface LlmsTxtInput {
  shopName: string;
  /** Storefront base, e.g. "shop.myshopify.com" or "https://shop.com". */
  domain: string;
  description?: string | null;
  products: LlmsTxtItem[];
  collections: LlmsTxtItem[];
}

function baseUrl(domain: string): string {
  const d = (domain || "").trim().replace(/\/+$/, "");
  if (!d) return "";
  return /^https?:\/\//i.test(d) ? d : `https://${d}`;
}

function oneLine(text: string | null | undefined, max = 160): string {
  if (!text) return "";
  const flat = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + "…" : flat;
}

/**
 * Escape a string for use as Markdown link text: collapse whitespace (so a
 * newline in a title can't split the line) and backslash-escape the characters
 * that would corrupt `[text](url)` — `\`, `[`, `]`. Without this, a title like
 * "Shoe [Red] (40% off)" breaks the link an AI crawler ingests.
 */
function mdText(text: string | null | undefined): string {
  return (text || "").replace(/\s+/g, " ").trim().replace(/([\\[\]])/g, "\\$1");
}

/**
 * Build an llms.txt (Markdown) snapshot from the shop + top products/collections.
 * Pure. Follows the llms.txt convention: H1 name, a `>` summary, then sections.
 */
export function buildLlmsTxt(input: LlmsTxtInput): string {
  const base = baseUrl(input.domain);
  const lines: string[] = [];
  lines.push(`# ${oneLine(input.shopName) || "Shop"}`);
  lines.push("");
  // Check the FLATTENED value, not the raw one: a whitespace-only shop
  // description is truthy and would emit a bare `> ` line, while the UI (which
  // trims) correctly reports the description as missing.
  const summary = oneLine(input.description, 250);
  if (summary) {
    lines.push(`> ${summary}`);
    lines.push("");
  }

  if (input.products.length > 0) {
    lines.push("## Products");
    for (const p of input.products) {
      const url = base ? `${base}/products/${p.handle}` : `/products/${p.handle}`;
      const desc = oneLine(p.description);
      const title = mdText(p.title);
      lines.push(desc ? `- [${title}](${url}): ${desc}` : `- [${title}](${url})`);
    }
    lines.push("");
  }

  if (input.collections.length > 0) {
    lines.push("## Collections");
    for (const c of input.collections) {
      const url = base ? `${base}/collections/${c.handle}` : `/collections/${c.handle}`;
      lines.push(`- [${mdText(c.title)}](${url})`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

const RAW_WRAP_RE = /^\{%-?\s*raw\s*-?%\}\n?([\s\S]*?)\{%-?\s*endraw\s*-?%\}\s*$/;

/**
 * Wrap generated llms.txt content in a Liquid `{% raw %}` block before it is
 * written to `templates/llms.txt.liquid`. The file is served through the
 * theme's Liquid engine, so an untrusted product/collection title or
 * description containing `{{ }}` or `{% %}` would otherwise be interpreted
 * (or corrupt) the template instead of being rendered as plain text. Pure.
 *
 * The wrapper alone is NOT escape-proof (review W3): content containing a
 * literal `{% endraw %}` would terminate the raw block early and everything
 * after it would execute as Liquid. Since llms.txt is plain text for LLM
 * consumers, we defang every Liquid opener in the content by inserting a
 * space (`{%` → `{ %`, `{{` → `{ {`) — visually near-identical, semantically
 * harmless for readers, and impossible for Liquid to parse as a tag. This is
 * deliberately NOT reversed by unwrapLlmsTxtFromTheme: the defanged form is
 * the canonical stored form.
 */
export function defangLiquid(content: string): string {
  return content.replace(/\{\{/g, "{ {").replace(/\{%/g, "{ %");
}

export function wrapLlmsTxtForTheme(content: string): string {
  return `{% raw %}\n${defangLiquid(content)}{% endraw %}\n`;
}

/**
 * Inverse of `wrapLlmsTxtForTheme` — strip the `{% raw %}` wrapper so a caller
 * reading the asset back sees the original Markdown. Content written before
 * this wrapper existed has no wrapper and is returned unchanged. Pure.
 */
export function unwrapLlmsTxtFromTheme(content: string): string {
  const m = content.match(RAW_WRAP_RE);
  return m ? m[1] : content;
}

// ── robots.txt AI-crawler audit ──────────────────────────────────────────────

export interface RobotsGroup {
  agents: string[];
  rules: Array<{ type: "allow" | "disallow"; path: string }>;
}

/**
 * Parse robots.txt text into user-agent groups (consecutive UA lines share a
 * group). Exported (PLAN_SEO_SUITE_COMPLETION.md §3.3) so the Phase-1
 * crawler (crawl.service.ts) can reuse the exact same parser instead of a
 * second, drifting copy — `auditRobotsTxt` below is unaffected, it just calls
 * this the same way it always did.
 */
export function parseRobots(txt: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasRule = false;

  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) {
      // A blank line separates robots.txt records — close the current group so
      // the next User-agent starts a fresh one (instead of being absorbed).
      lastWasRule = false;
      current = null;
      continue;
    }
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const directive = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (directive === "user-agent") {
      if (!current || lastWasRule) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasRule = false;
    } else if (directive === "disallow" || directive === "allow") {
      if (!current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.rules.push({ type: directive, path: value });
      lastWasRule = true;
    }
  }
  return groups;
}

/**
 * How much a single `Disallow` rule actually costs us in AI search:
 *  - `operational` — the path never holds citable content (checkout, cart,
 *    account, admin, theme previews, internal endpoints). Shopify ships most of
 *    these by default; blocking them is correct and needs no merchant action.
 *  - `duplicate` — faceted/sorted/searched variants of pages that exist
 *    elsewhere (`/collections/*sort_by*`, `/search`). Deliberate crawl-budget
 *    hygiene, also Shopify default — no real content is lost.
 *  - `content` — hides pages an AI answer could have cited: a storefront route,
 *    or a plain wildcard-free path (i.e. a real custom route) we don't
 *    recognise. This is the only bucket that drives a warning.
 *  - `unknown` — an unrecognised *pattern* (contains `*`, a query param or a
 *    `[a-f0-9]` character class). Shopify keeps adding such rules, so treating
 *    them as content produced pure noise; they are listed for review but don't
 *    raise the verdict.
 */
export type RobotsRuleImpact = "operational" | "duplicate" | "content" | "unknown";

export interface RobotsRuleAssessment {
  /** The raw `Disallow` path as written in robots.txt. */
  path: string;
  impact: RobotsRuleImpact;
  /** Stable i18n key explaining *why* it landed in that bucket. */
  reason: RobotsRuleReason;
}

export type RobotsRuleReason =
  | "checkout"
  | "account"
  | "password"
  | "admin"
  | "internal"
  | "appProxy"
  | "preview"
  | "tracking"
  | "faceted"
  | "hashedDuplicate"
  | "search"
  | "pagination"
  | "queryParams"
  | "storefront"
  | "sitewide"
  | "technicalPattern"
  | "unknown";

/**
 * Ordered classification table — first match wins, so the narrow operational /
 * duplicate patterns must come before the broad storefront check below (e.g.
 * `/collections/*sort_by*` is faceting, not a blocked collection, and
 * `/products/*-[a-f0-9]…-remote` is a generated duplicate, not a product).
 */
/**
 * Everything before the first meaningful segment: an optional leading star and
 * an optional shop-scope segment (a star, `:id` or a numeric shop id) that
 * Shopify prefixes some default rules with, as in `/:id/checkouts`.
 *
 * Operational and search patterns MUST be anchored with this. Matching a bare
 * `(^|\/)keyword` also matches the LAST segment, which quietly filed real
 * storefront pages as technical: `/pages/services` as an internal endpoint,
 * `/collections/orders` as a customer-account path. Those are false negatives —
 * the app would show a green "everything fine" while a citable page was hidden.
 */
const PATH_PREFIX = String.raw`^\*?\/(?:(?:\*|:id|\d+)\/)?`;

const RULE_PATTERNS: Array<{ re: RegExp; impact: RobotsRuleImpact; reason: RobotsRuleReason }> = [
  // Operational — transactional or internal, never citable.
  {
    re: new RegExp(PATH_PREFIX + String.raw`(?:checkouts?|carts?|thank_you)(\/|$|\?|\*)`),
    impact: "operational",
    reason: "checkout",
  },
  {
    re: new RegExp(PATH_PREFIX + String.raw`password(\/|$|\?|\*)`),
    impact: "operational",
    reason: "password",
  },
  {
    re: new RegExp(
      PATH_PREFIX +
        String.raw`(?:account|accounts|orders?|customer_authentication|challenge|login|logout)(\/|$|\?|\*)`,
    ),
    impact: "operational",
    reason: "account",
  },
  { re: /^\/admin(\/|$|\?|\*)/, impact: "operational", reason: "admin" },
  // `/a/…` is Shopify's app-proxy prefix (e.g. `/a/downloads/-/*` for Digital
  // Downloads) — app-owned endpoints, never storefront content.
  { re: /^\/a\//, impact: "operational", reason: "appProxy" },
  {
    re: new RegExp(
      PATH_PREFIX +
        String.raw`(?:apps|services|tools|recommendations|cdn|wpm|\.well-known|apple-app-site-association|localization|browsing_context_suggestions|sf_private_access_tokens|policies\.json)(\/|$|\?|\.|\*)`,
    ),
    impact: "operational",
    reason: "internal",
  },
  {
    re: /(design_theme_id|preview_theme_id|preview_script_id|preview_key)/,
    impact: "operational",
    reason: "preview",
  },
  // Link-source / A-B / email tracking parameters, plain and percent-encoded.
  { re: /(_ab=|oseid=|shpxid=|[?&*]ls(=|%3d))/i, impact: "operational", reason: "tracking" },
  // Duplicate — same content reachable under a canonical URL.
  // A literal `[a-f0-9]` character class only ever appears in Shopify's
  // generated rules for hash-suffixed duplicate URLs (`…-<hash>-remote`).
  { re: /\[a-f0-9\]/i, impact: "duplicate", reason: "hashedDuplicate" },
  // `filter` only counts as faceting next to a wildcard/query separator or as
  // Shopify's `filter.` param prefix — `_` and `.` in the leading class made
  // `/pages/filter_guide` look like a facet.
  {
    re: /(sort_by|constraint|%2b|\+|[*&?]filter|filter[*&?=]|filter\.)/i,
    impact: "duplicate",
    reason: "faceted",
  },
  {
    re: new RegExp(`(?:${PATH_PREFIX}search(\\/|$|\\?|\\*))|[?&*]q=`),
    impact: "duplicate",
    reason: "search",
  },
  { re: /(page=|\/page\/)/, impact: "duplicate", reason: "pagination" },
  { re: /^\/\*\?\*?$/, impact: "duplicate", reason: "queryParams" },
];

/**
 * Values that close the whole site. `Disallow: *` is a path pattern matching
 * every URL per RFC 9309 — treating only `/` as a full block reported it as a
 * harmless "standard exclusion" and, worse, offered it as a prunable path.
 */
const SITEWIDE_DISALLOW = new Set(["/", "/*", "*"]);

/** Storefront routes whose content is exactly what an AI answer would cite. */
const STOREFRONT_RE = /^\/(?:\*\/)?(?:products|collections|blogs|pages|articles|policies)(\/|$|\?|\*)/;

/**
 * A `Disallow` that carries wildcards, query parameters or a character class is
 * a *pattern* aimed at generated URLs, not a hand-written route. Shopify adds
 * new ones over time, so an unrecognised pattern is filed under `unknown` (shown
 * for review, no warning) while an unrecognised **plain** path — a real custom
 * route like `/lookbook` — still counts as blocked content.
 */
const TECHNICAL_PATTERN_RE = /[*?&=[\]]/;

/**
 * Classify a single `Disallow` path. Pure.
 */
export function classifyDisallowPath(path: string): RobotsRuleAssessment {
  const raw = path.trim();
  const p = raw.toLowerCase();
  if (SITEWIDE_DISALLOW.has(p)) return { path: raw, impact: "content", reason: "sitewide" };
  for (const { re, impact, reason } of RULE_PATTERNS) {
    if (re.test(p)) return { path: raw, impact, reason };
  }
  if (STOREFRONT_RE.test(p)) return { path: raw, impact: "content", reason: "storefront" };
  if (TECHNICAL_PATTERN_RE.test(p)) return { path: raw, impact: "unknown", reason: "technicalPattern" };
  return { path: raw, impact: "content", reason: "unknown" };
}

/** Coarse per-crawler verdict for the UI. */
export type RobotsVerdict = "allowed" | "standard" | "restricted" | "blocked";

export interface RobotsCrawlerStatus {
  crawler: string;
  /** Fully blocked: `Disallow: /` (no overriding `Allow: /`) — kept as-is for
   *  backward compatibility with existing consumers of this shape. */
  blocked: boolean;
  /**
   * Some `Disallow` rule applies to this crawler's group (or the `*` fallback)
   * but the site isn't fully blocked — e.g. `Disallow: /products/`. Note this
   * is true even for harmless Shopify defaults; use `contentRestricted` for the
   * "merchant should look at this" signal.
   */
  partiallyBlocked: boolean;
  /** Which record decided this crawler's access. */
  matchedBy: "explicit" | "wildcard" | "none";
  /** Every applying `Disallow`, classified. Empty when no group matches. */
  rules: RobotsRuleAssessment[];
  /** At least one applying `Disallow` hides real content (and not fully blocked). */
  contentRestricted: boolean;
  verdict: RobotsVerdict;
}

/**
 * Audit live robots.txt content for AI crawlers, per crawler and per rule.
 *
 * A full block (`Disallow: /` with no overriding `Allow: /`) is still reported
 * via `blocked`. Everything else is broken down rule by rule so the merchant
 * sees *which* paths are closed and whether that actually matters — a store on
 * Shopify's stock robots.txt has ~30 `Disallow` lines that are all correct, and
 * reporting those as "partially blocked" is noise. Pure.
 */
export function auditRobotsTxt(robotsTxt: string): RobotsCrawlerStatus[] {
  const groups = parseRobots(robotsTxt || "");
  const matchFor = (crawler: string): { group: RobotsGroup | null; matchedBy: RobotsCrawlerStatus["matchedBy"] } => {
    const c = crawler.toLowerCase();
    const exact = groups.find((g) => g.agents.includes(c));
    if (exact) return { group: exact, matchedBy: "explicit" };
    const wildcard = groups.find((g) => g.agents.includes("*"));
    return wildcard ? { group: wildcard, matchedBy: "wildcard" } : { group: null, matchedBy: "none" };
  };

  return AI_CRAWLERS.map((crawler) => {
    const { group, matchedBy } = matchFor(crawler);
    if (!group) {
      return {
        crawler,
        blocked: false,
        partiallyBlocked: false,
        matchedBy,
        rules: [],
        contentRestricted: false,
        verdict: "allowed" as const,
      };
    }

    const blocksRoot = group.rules.some(
      (r) => r.type === "disallow" && SITEWIDE_DISALLOW.has(r.path.trim().toLowerCase()),
    );
    const allowsRoot = group.rules.some(
      (r) => r.type === "allow" && SITEWIDE_DISALLOW.has(r.path.trim().toLowerCase()),
    );
    const blocked = blocksRoot && !allowsRoot;

    // `Disallow:` with an empty value means "allow everything" per the spec —
    // only a non-empty path is a real restriction.
    const disallows = group.rules.filter((r) => r.type === "disallow" && r.path.trim() !== "");
    // An `Allow` for the same path un-does the `Disallow` (most-specific-wins is
    // an approximation here, but an exact-path Allow is unambiguous).
    const allowed = new Set(group.rules.filter((r) => r.type === "allow").map((r) => r.path.trim()));
    const rules = disallows
      .filter((r) => !allowed.has(r.path.trim()))
      .map((r) => classifyDisallowPath(r.path));

    const contentRestricted = !blocked && rules.some((r) => r.impact === "content");
    const verdict: RobotsVerdict = blocked
      ? "blocked"
      : contentRestricted
        ? "restricted"
        : rules.length > 0
          ? "standard"
          : "allowed";

    return {
      crawler,
      blocked,
      partiallyBlocked: !blocked && rules.length > 0,
      matchedBy,
      rules,
      contentRestricted,
      verdict,
    };
  });
}

export interface RobotsCrawlerGroup {
  /** Crawlers that share an identical verdict + rule set. */
  crawlers: string[];
  matchedBy: RobotsCrawlerStatus["matchedBy"];
  verdict: RobotsVerdict;
  rules: RobotsRuleAssessment[];
}

/**
 * Collapse per-crawler statuses into distinct rule sets. On a stock store all
 * 14 crawlers fall through to the same `User-agent: *` record, so the UI should
 * render one explained block, not fourteen identical ones. Pure.
 */
export function groupCrawlerStatuses(statuses: RobotsCrawlerStatus[]): RobotsCrawlerGroup[] {
  const out: RobotsCrawlerGroup[] = [];
  const bySignature = new Map<string, RobotsCrawlerGroup>();
  for (const s of statuses) {
    // NUL separator (house idiom, see bulk-editor/translations.server.ts) so a
    // path can never collide with the joiner. Written as an escape, not a
    // literal byte, or git classifies this file as binary.
    const signature = `${s.verdict}\u0000${s.matchedBy}\u0000${s.rules.map((r) => r.path).join("\u0000")}`;
    const existing = bySignature.get(signature);
    if (existing) {
      existing.crawlers.push(s.crawler);
      continue;
    }
    const group: RobotsCrawlerGroup = {
      crawlers: [s.crawler],
      matchedBy: s.matchedBy,
      verdict: s.verdict,
      rules: s.rules,
    };
    bySignature.set(signature, group);
    out.push(group);
  }
  // Worst verdict first so the merchant reads the actionable block at the top.
  const order: Record<RobotsVerdict, number> = { blocked: 0, restricted: 1, standard: 2, allowed: 3 };
  return out.sort((a, b) => order[a.verdict] - order[b.verdict]);
}

// ── robots.txt override generation ───────────────────────────────────────────

/**
 * Marker identifying a `robots.txt.liquid` this app generated. Anything without
 * it is the merchant's own file and is never overwritten — losing a hand-tuned
 * robots.txt would be far worse than leaving a Disallow in place.
 */
export const ROBOTS_MANAGED_MARKER = "ContentPilot managed robots.txt";

/** Liquid separator for the removed-path list. A path containing it is refused. */
const ROBOTS_PATH_SEP = "~|~";

/**
 * A path we are willing to write into the generated Liquid. Rejects anything
 * that could break out of the quoted string or the separator, and anything not
 * shaped like a robots.txt path.
 */
export function isRemovableRobotsPath(path: string): boolean {
  const p = (path || "").trim();
  if (!p || p.length > 200) return false;
  if (!p.startsWith("/") && !p.startsWith("*")) return false;
  if (p.includes(ROBOTS_PATH_SEP) || p.includes('"') || p.includes("'")) return false;
  if (/[\r\n{}]/.test(p)) return false;
  // Removing a site-wide Disallow would un-block a fully blocked crawler by
  // deleting the block itself — a different (and much larger) decision than
  // pruning a path, so it does not go through here. `*` and `/*` count too,
  // not just `/`.
  return !SITEWIDE_DISALLOW.has(p.toLowerCase());
}

/**
 * Generate `templates/robots.txt.liquid` that reproduces Shopify's defaults
 * minus the given Disallow paths.
 *
 * It iterates `robots.default_groups` — Shopify's own documented customization
 * hook — so every rule the platform ships stays intact and future additions
 * flow through automatically. Only an exact `Disallow` value match is dropped.
 * Pure, so the exact bytes are unit-tested.
 */
export function buildRobotsLiquid(removedPaths: string[]): string {
  const paths = removedPaths.map((p) => p.trim()).filter(isRemovableRobotsPath);
  const unique = Array.from(new Set(paths));
  const list = unique.join(ROBOTS_PATH_SEP);

  return [
    "{% comment %}",
    `  ${ROBOTS_MANAGED_MARKER}`,
    "",
    "  This file is generated by the app (SEO -> AI search). It reproduces",
    "  Shopify's default robots.txt and removes only the Disallow rules listed",
    "  below. Edit it by hand and the app will stop overwriting it.",
    "",
    ...unique.map((p) => `  cp-removed: ${p}`),
    "{% endcomment %}",
    `{%- assign cp_removed = "${list}" | split: "${ROBOTS_PATH_SEP}" -%}`,
    "{%- for group in robots.default_groups -%}",
    "{{ group.user_agent }}",
    "{% for rule in group.rules -%}",
    "{%- unless rule.directive == 'Disallow' and cp_removed contains rule.value -%}",
    "{{ rule }}",
    "{% endunless -%}",
    "{%- endfor -%}",
    "{%- if group.sitemap != blank -%}",
    "{{ group.sitemap }}",
    "{% endif %}",
    "{% endfor -%}",
    "",
  ].join("\n");
}

/**
 * Read back which paths a generated file removes, or null when the file wasn't
 * written by us. Used both to decide whether overwriting is safe and to show
 * the merchant what is currently pruned. Pure.
 */
export function parseManagedRobotsLiquid(content: string | null): string[] | null {
  if (!content || !content.includes(ROBOTS_MANAGED_MARKER)) return null;
  const out: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s*cp-removed:\s*(\S.*?)\s*$/);
    if (m) out.push(m[1]);
  }
  return out;
}

// ── robots.txt AI advice ─────────────────────────────────────────────────────

export interface RobotsAdvice {
  path: string;
  /** `remove` = the AI thinks unblocking this helps AI search. */
  recommendation: "remove" | "keep";
  /** One sentence, in the merchant's language, shown next to the rule. */
  reason: string;
}

/** Rules we ask the model about — the buckets our classifier can't settle. */
export function adviseableRules(groups: RobotsCrawlerGroup[]): RobotsRuleAssessment[] {
  const seen = new Set<string>();
  const out: RobotsRuleAssessment[] = [];
  for (const g of groups) {
    for (const r of g.rules) {
      if (r.impact !== "content" && r.impact !== "unknown") continue;
      if (r.reason === "sitewide") continue; // a full block isn't a path prune
      if (!isRemovableRobotsPath(r.path) || seen.has(r.path)) continue;
      seen.add(r.path);
      out.push(r);
    }
  }
  return out;
}

/** Max rules per advice call — keeps the prompt and the response bounded. */
export const ROBOTS_ADVICE_BATCH = 25;

export function buildRobotsAdvicePrompt(rules: RobotsRuleAssessment[], language: string): string {
  const list = rules.map((r, i) => `${i + 1}. ${r.path}`).join("\n");
  return [
    "You are auditing a Shopify store's robots.txt for AI-search visibility (AEO).",
    "",
    "For each Disallow path below, decide whether removing it would let AI crawlers",
    "(GPTBot, ClaudeBot, PerplexityBot, Google-Extended) reach content worth citing.",
    "",
    "Recommend KEEP when the path is transactional, private, internal, a duplicate",
    "or a faceted/filtered URL variant — blocking those is correct and removing them",
    "would waste crawl budget or expose non-content pages.",
    "Recommend REMOVE only when the path plausibly holds real, citable storefront",
    "content (products, collections, blog articles, informational pages).",
    "When unsure, recommend KEEP — a wrong REMOVE costs the merchant more than a",
    "wrong KEEP.",
    "",
    `Write each reason as ONE short sentence in this language: ${language}.`,
    "",
    "Paths:",
    list,
    "",
    "Respond with ONLY a JSON array, no prose and no code fences:",
    '[{"path":"<the exact path>","recommendation":"keep|remove","reason":"<one sentence>"}]',
  ].join("\n");
}

/**
 * Parse the model's advice, keeping only entries for paths we actually asked
 * about. Anything malformed, unknown or not explicitly `remove` degrades to
 * `keep` — the model can never talk us into unblocking something by accident.
 */
export function parseRobotsAdviceResponse(raw: string, knownPaths: Set<string>): RobotsAdvice[] {
  let parsed: any;
  try {
    const cleaned = raw.replace(/^```(?:json)?/i, "").replace(/```\s*$/, "").trim();
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    parsed = JSON.parse(start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const seen = new Set<string>();
  const out: RobotsAdvice[] = [];
  for (const item of parsed) {
    const path = typeof item?.path === "string" ? item.path.trim() : "";
    if (!knownPaths.has(path) || seen.has(path)) continue;
    seen.add(path);
    out.push({
      path,
      recommendation: item?.recommendation === "remove" ? "remove" : "keep",
      reason: typeof item?.reason === "string" ? item.reason.trim().slice(0, 300) : "",
    });
  }
  return out;
}

// ── Theme file I/O (Admin GraphQL) ───────────────────────────────────────────

export async function getMainThemeId(admin: AdminApiContext): Promise<string | null> {
  const res = await admin.graphql(GET_THEMES, { variables: { first: 50 } });
  const json: any = await res.json();
  const edges = json?.data?.themes?.edges ?? [];
  // The published theme is role MAIN (OnlineStoreThemeRole has no PUBLISHED).
  const main = edges.find((e: any) => e.node?.role === "MAIN");
  return main?.node?.id ?? null;
}

export async function readThemeFile(
  admin: AdminApiContext,
  themeId: string,
  filename: string,
): Promise<string | null> {
  const res = await admin.graphql(GET_THEME_FILES, { variables: { themeId, filenames: [filename] } });
  const json: any = await res.json();
  const node = json?.data?.theme?.files?.nodes?.[0];
  return node?.body?.content ?? null;
}

export async function upsertThemeFile(
  admin: AdminApiContext,
  themeId: string,
  filename: string,
  content: string,
): Promise<{
  userErrors: Array<{ field?: string[] | null; message: string }>;
  /** Filenames Shopify echoed back as actually written. */
  upserted: string[];
}> {
  const res = await admin.graphql(UPSERT_THEME_FILES, {
    variables: { themeId, files: [{ filename, body: { type: "TEXT", value: content } }] },
  });
  const json: any = await res.json();
  return {
    userErrors: json?.data?.themeFilesUpsert?.userErrors ?? [],
    upserted: (json?.data?.themeFilesUpsert?.upsertedThemeFiles ?? []).map((f: any) => f?.filename),
  };
}

const SHOP_IDENTITY_QUERY = `#graphql
  query aeoShopIdentity {
    shop {
      name
      description
      primaryDomain { host }
    }
  }
`;

/**
 * Shop display name, storefront host and description, used to build llms.txt.
 * Falls back to the myshopify domain so a failed lookup still produces a usable
 * file. `description` is empty when the merchant never set one — the caller
 * surfaces that rather than inventing a summary.
 */
export async function getShopIdentity(
  admin: AdminApiContext,
  fallbackShop: string,
): Promise<{ name: string; domain: string; description: string }> {
  try {
    const res = await admin.graphql(SHOP_IDENTITY_QUERY);
    const j: any = await res.json();
    const shop = j?.data?.shop;
    return {
      name: shop?.name || fallbackShop.replace(/\.myshopify\.com$/, ""),
      domain: shop?.primaryDomain?.host || fallbackShop,
      description: (shop?.description || "").trim(),
    };
  } catch {
    return {
      name: fallbackShop.replace(/\.myshopify\.com$/, ""),
      domain: fallbackShop,
      description: "",
    };
  }
}

export async function deleteThemeFile(
  admin: AdminApiContext,
  themeId: string,
  filename: string,
): Promise<boolean> {
  try {
    const res = await admin.graphql(DELETE_THEME_FILES, { variables: { themeId, files: [filename] } });
    const json: any = await res.json();
    const errs = json?.data?.themeFilesDelete?.userErrors ?? [];
    const deleted = (json?.data?.themeFilesDelete?.deletedThemeFiles ?? []).map((f: any) => f?.filename);
    return errs.length === 0 && deleted.includes(filename);
  } catch {
    return false;
  }
}

// ── Feature gate ─────────────────────────────────────────────────────────────

/**
 * Writing theme files (`themeFilesUpsert`) needs a per-operation approval from
 * Shopify that this app does not hold yet — it is only cleared for direct
 * storefront text edits. Everything that would write `llms.txt.liquid` or
 * `robots.txt.liquid` is therefore built but gated behind `AEO_THEME_WRITES`.
 *
 * Default **off**: an unset variable must never write. Flip to `on` (or
 * `true` / `1`) once the approval lands. Read-only analysis is unaffected.
 *
 * This has to be enforced server-side in every action — hiding the button is
 * not a gate, the routes are POST-reachable directly.
 */
export function themeWritesEnabled(): boolean {
  const v = (process.env.AEO_THEME_WRITES || "").trim().toLowerCase();
  return v === "on" || v === "true" || v === "1";
}

// ── Orchestration ────────────────────────────────────────────────────────────

/** Max items per section in the generated llms.txt. */
export const LLMS_MAX_PER_TYPE = 50;

export interface GenerateLlmsResult {
  ok: boolean;
  error?: string;
}

export interface BuiltLlmsTxt {
  content: string;
  productCount: number;
  collectionCount: number;
}

/**
 * Build the llms.txt this shop *should* have, from the DB cache. Split out of
 * `generateAndUpsertLlmsTxt` so the read-only analysis can build the same bytes
 * and compare them against what's in the theme — that comparison is what makes
 * "up to date / stale" possible without storing a hash anywhere.
 */
export async function buildLlmsTxtForShop(
  db: any,
  shop: string,
  shopName: string,
  domain: string,
  description = "",
): Promise<BuiltLlmsTxt> {
  const [products, collections] = await Promise.all([
    // ACTIVE only, and this one must stay that way: llms.txt is a published
    // file that hands crawlers a list of URLs. Listing unlisted products there
    // would publish exactly the direct links the status exists to keep
    // unlisted — the same reasoning as index-now.service.ts.
    // Ordered by handle, NOT by lastSyncedAt. That column is restamped on every
    // webhook-driven resync, so editing any single product reshuffled the whole
    // section and pushed the 50th item out of the file — the rebuilt content
    // differed on every pass, and both refresh drivers wrote a new theme
    // version for a file whose information barely changed. Ties on
    // lastSyncedAt (batch syncs share a millisecond) additionally made the
    // selected SET nondeterministic, which reported "stale" forever. Handle is
    // unique and stable, so the file only changes when the catalog does.
    db.product.findMany({
      where: { shop, status: "ACTIVE" },
      select: { title: true, handle: true, seoDescription: true, descriptionHtml: true },
      orderBy: { handle: "asc" },
      take: LLMS_MAX_PER_TYPE,
    }),
    db.collection.findMany({
      where: { shop },
      select: { title: true, handle: true },
      orderBy: { handle: "asc" },
      take: LLMS_MAX_PER_TYPE,
    }),
  ]);

  const content = buildLlmsTxt({
    shopName,
    domain,
    description,
    products: products.map((p: any) => ({
      title: p.title,
      handle: p.handle,
      description: p.seoDescription || p.descriptionHtml,
    })),
    collections: collections.map((c: any) => ({ title: c.title, handle: c.handle })),
  });

  return { content, productCount: products.length, collectionCount: collections.length };
}

/**
 * Build llms.txt from the DB cache and upsert it into the published theme.
 * Returns ok:false (never throws) with a reason the route can map to i18n.
 *
 * `skipIfUnchanged` makes this safe to call from a background loop: it reads the
 * current file first and returns `ok:true` without writing when the content
 * already matches, so the periodic refresh doesn't touch the theme every cycle.
 */
export async function generateAndUpsertLlmsTxt(
  admin: AdminApiContext,
  db: any,
  shop: string,
  shopName: string,
  domain: string,
  description: string,
  opts: { skipIfUnchanged?: boolean } = {},
): Promise<GenerateLlmsResult> {
  if (!themeWritesEnabled()) return { ok: false, error: "theme_writes_disabled" };

  const themeId = await getMainThemeId(admin);
  if (!themeId) return { ok: false, error: "no_theme" };

  const { content } = await buildLlmsTxtForShop(db, shop, shopName, domain, description);
  const wrapped = wrapLlmsTxtForTheme(content);

  if (opts.skipIfUnchanged) {
    const existing = await readThemeFile(admin, themeId, LLMS_TEMPLATE_FILENAME);
    if (existing !== null && llmsTxtMatches(existing, content)) return { ok: true };
  }

  const { userErrors, upserted } = await upsertThemeFile(
    admin,
    themeId,
    LLMS_TEMPLATE_FILENAME,
    wrapped,
  );
  if (userErrors.length > 0) return { ok: false, error: "upsert_failed" };
  // Same discipline as the translation writes: an empty `userErrors` is not
  // proof anything was stored — require the filename in the echo.
  if (!upserted.includes(LLMS_TEMPLATE_FILENAME)) return { ok: false, error: "upsert_failed" };
  return { ok: true };
}

/**
 * Does the theme's stored llms.txt already equal what we'd generate now? The
 * stored form is defanged and `{% raw %}`-wrapped, so unwrap it and compare
 * against the defanged fresh content. Pure.
 */
export function llmsTxtMatches(storedThemeFile: string, freshContent: string): boolean {
  return unwrapLlmsTxtFromTheme(storedThemeFile).trim() === defangLiquid(freshContent).trim();
}

/**
 * Periodic llms.txt refresh, called from the sync scheduler.
 *
 * Deliberately conservative on two counts. It only ever *updates* a file that
 * already exists — creating one is an explicit merchant decision, not something
 * a background loop should do behind their back. And it writes only when the
 * content actually differs, so the common case costs one theme read and no
 * write at all. Never throws: the caller is a scheduler cycle.
 */
export async function refreshLlmsTxtIfStale(
  admin: AdminApiContext,
  db: any,
  shop: string,
): Promise<"disabled" | "opted_out" | "absent" | "unchanged" | "updated" | "failed"> {
  if (!themeWritesEnabled()) return "disabled";
  try {
    // Cheapest check first — a shop that switched this off costs one indexed
    // lookup per cycle and no Shopify calls at all.
    const settings = await db.aISettings.findUnique({
      where: { shop },
      select: { llmsTxtAutoUpdate: true, subscriptionPlan: true },
    });
    if (settings && settings.llmsTxtAutoUpdate === false) return "opted_out";
    // The AEO section is Basic+. Without this a shop that downgrades to Free
    // keeps having its theme file rewritten on every session — the loader,
    // action, AI handler and daily sweep all gate, this was the one path that
    // didn't.
    if (!meetsPlan((settings?.subscriptionPlan || "free") as Plan, "basic")) return "opted_out";

    // Stamp before doing the work, not after. This is what the daily sweep
    // (seo/llms-auto-refresh.service.ts) reads to decide a shop is handled, so
    // an in-app refresh has to count even if the Shopify calls below fail —
    // otherwise a shop with a persistent API problem is retried by the sweep
    // on every tick as well.
    await db.aISettings
      .update({ where: { shop }, data: { llmsTxtLastAutoRunAt: new Date() } })
      .catch(() => {});

    const themeId = await getMainThemeId(admin);
    if (!themeId) return "failed";

    const existing = await readThemeFile(admin, themeId, LLMS_TEMPLATE_FILENAME);
    if (!existing || unwrapLlmsTxtFromTheme(existing).trim().length === 0) return "absent";

    const { name, domain, description } = await getShopIdentity(admin, shop);
    const { content } = await buildLlmsTxtForShop(db, shop, name, domain, description);
    if (llmsTxtMatches(existing, content)) return "unchanged";

    const { userErrors, upserted } = await upsertThemeFile(
      admin,
      themeId,
      LLMS_TEMPLATE_FILENAME,
      wrapLlmsTxtForTheme(content),
    );
    if (userErrors.length > 0 || !upserted.includes(LLMS_TEMPLATE_FILENAME)) return "failed";
    return "updated";
  } catch {
    return "failed";
  }
}

export type RobotsApplyError =
  | "theme_writes_disabled"
  | "no_theme"
  | "no_paths"
  /** A requested path isn't one the live robots.txt offers as prunable. */
  | "not_removable"
  | "file_customized"
  | "upsert_failed"
  | "verify_failed"
  | "verify_failed_rolled_back";

/** How many times the served robots.txt is re-read before declaring failure. */
const VERIFY_ATTEMPTS = 3;
const VERIFY_RETRY_DELAY_MS = 1500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface RobotsApplyResult {
  ok: boolean;
  error?: RobotsApplyError;
  /** Paths the generated file now removes (on success). */
  removed?: string[];
}

/**
 * Fetch the live robots.txt, bypassing caches as far as we can.
 */
async function fetchLiveRobots(shop: string): Promise<string | null> {
  try {
    const res = await fetch(`https://${shop}/robots.txt?cp=${encodeURIComponent(String(Date.now()))}`, {
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

/**
 * Is the served robots.txt still structurally sound? A broken
 * `robots.txt.liquid` can render to something that silently changes crawling
 * for every bot, so this is deliberately strict about what "unchanged apart
 * from the removals" means.
 */
export function robotsLooksSane(
  before: string,
  after: string,
  removedPaths: string[],
): boolean {
  const beforeGroups = parseRobots(before);
  const afterGroups = parseRobots(after);
  if (afterGroups.length === 0) return false;
  // The wildcard record must survive — losing it changes every crawler at once.
  const hadWildcard = beforeGroups.some((g) => g.agents.includes("*"));
  if (hadWildcard && !afterGroups.some((g) => g.agents.includes("*"))) return false;
  // No new Disallow may appear, and nothing outside the requested set may go.
  const removed = new Set(removedPaths.map((p) => p.trim()));
  const disallows = (gs: RobotsGroup[]) =>
    new Set(gs.flatMap((g) => g.rules.filter((r) => r.type === "disallow").map((r) => r.path.trim())));
  const beforeDisallows = disallows(beforeGroups);
  const afterDisallows = disallows(afterGroups);
  for (const p of afterDisallows) if (!beforeDisallows.has(p)) return false;
  for (const p of beforeDisallows) {
    if (!afterDisallows.has(p) && !removed.has(p)) return false;
  }
  // The removals must ACTUALLY have happened. Without this the checks above
  // pass trivially for `after === before`, so an unchanged response — a stale
  // CDN copy, or a Liquid file that rendered to the old output — was reported
  // as a successful removal and the rollback never fired.
  for (const p of removed) {
    if (beforeDisallows.has(p) && afterDisallows.has(p)) return false;
  }
  return true;
}

/**
 * Remove merchant-selected Disallow rules from robots.txt by generating a
 * managed `robots.txt.liquid`.
 *
 * Three guards, because a wrong robots.txt is expensive and hard to notice:
 *  1. Never overwrite a `robots.txt.liquid` this app didn't generate.
 *  2. Verify the *served* robots.txt afterwards — a Liquid file that upserts
 *     cleanly can still render to nonsense.
 *  3. Roll back to the previous file when verification fails.
 *
 * Never throws.
 */
export async function applyRobotsRuleRemovals(
  admin: AdminApiContext,
  shop: string,
  paths: string[],
): Promise<RobotsApplyResult> {
  if (!themeWritesEnabled()) return { ok: false, error: "theme_writes_disabled" };

  const requested = Array.from(new Set(paths.map((p) => p.trim()).filter(isRemovableRobotsPath)));
  if (requested.length === 0) return { ok: false, error: "no_paths" };

  try {
    const before = await fetchLiveRobots(shop);
    if (!before) return { ok: false, error: "verify_failed" };

    // Re-derive what is actually prunable from the LIVE robots.txt instead of
    // trusting the form. `isRemovableRobotsPath` is only a shape check, so
    // without this a hand-crafted POST could strip `/admin`, `/checkout` or
    // `/account` — paths the UI never offers. Same discipline the advice
    // handler already applies; the write path is where it matters.
    const allowed = new Set(
      adviseableRules(groupCrawlerStatuses(auditRobotsTxt(before))).map((r) => r.path),
    );
    const removable = requested.filter((p) => allowed.has(p));
    if (removable.length === 0) return { ok: false, error: "not_removable" };
    if (removable.length !== requested.length) return { ok: false, error: "not_removable" };

    const themeId = await getMainThemeId(admin);
    if (!themeId) return { ok: false, error: "no_theme" };

    const previous = await readThemeFile(admin, themeId, ROBOTS_TEMPLATE_FILENAME);
    // A file we didn't write is the merchant's — refuse rather than clobber.
    if (previous !== null && parseManagedRobotsLiquid(previous) === null) {
      return { ok: false, error: "file_customized" };
    }

    const { userErrors, upserted } = await upsertThemeFile(
      admin,
      themeId,
      ROBOTS_TEMPLATE_FILENAME,
      buildRobotsLiquid(removable),
    );
    if (userErrors.length > 0 || !upserted.includes(ROBOTS_TEMPLATE_FILENAME)) {
      return { ok: false, error: "upsert_failed" };
    }

    // The served robots.txt does not update instantly, so an unchanged first
    // read means "not propagated yet", not "broken" — retry before judging.
    for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(VERIFY_RETRY_DELAY_MS);
      const after = await fetchLiveRobots(shop);
      if (after && robotsLooksSane(before, after, removable)) {
        return { ok: true, removed: removable };
      }
    }

    // Verification failed. Restore exactly what was there — and when there was
    // no file, DELETE the one we just created. Rewriting our own generator with
    // an empty removal list (the previous behaviour) reproduces the same
    // possibly-malformed Liquid and leaves an app-owned template behind, while
    // reporting "restored" to the merchant.
    const rolledBack = previous
      ? await upsertThemeFile(admin, themeId, ROBOTS_TEMPLATE_FILENAME, previous).then(
          (r) => r.userErrors.length === 0 && r.upserted.includes(ROBOTS_TEMPLATE_FILENAME),
        )
      : await deleteThemeFile(admin, themeId, ROBOTS_TEMPLATE_FILENAME);

    return { ok: false, error: rolledBack ? "verify_failed_rolled_back" : "verify_failed" };
  } catch {
    return { ok: false, error: "verify_failed" };
  }
}

export interface AeoAnalysis {
  llmsTxtExists: boolean;
  /**
   * The theme's llms.txt already equals what we'd generate now. Meaningless
   * when `llmsTxtExists` is false. Derived by rebuilding and comparing, so it
   * needs no stored hash and can't drift out of sync with the generator.
   */
  llmsTxtUpToDate: boolean;
  /** What the *current* generated file would contain. */
  llmsProductCount: number;
  llmsCollectionCount: number;
  /** First lines of the freshly built file, for the preview panel. */
  llmsPreview: string;
  /** Public URL the file is served from, for the merchant to verify. */
  llmsUrl: string;
  /** `AEO_THEME_WRITES` — false hides/blocks every theme-writing action. */
  themeWrites: boolean;
  /** Merchant switch for the periodic llms.txt refresh (`AISettings`). */
  llmsAutoUpdate: boolean;
  /**
   * `shop.description` is empty, so the file has no `> summary` line. The
   * llms.txt convention puts the one-sentence "what is this site" there — the
   * single most useful line for an LLM — and we deliberately don't invent one.
   */
  shopDescriptionMissing: boolean;
  blockedCrawlers: string[];
  /** AI crawlers with a non-empty `Disallow` rule that doesn't block the whole
   *  site (see `RobotsCrawlerStatus.partiallyBlocked`). Additive field — older
   *  consumers that only read `blockedCrawlers` are unaffected. */
  partiallyBlockedCrawlers: string[];
  /** Subset of `partiallyBlockedCrawlers` whose blocked paths hide real content
   *  — i.e. the ones actually worth a merchant's attention. */
  restrictedCrawlers: string[];
  /** Distinct rule sets across all AI crawlers, worst verdict first. */
  crawlerGroups: RobotsCrawlerGroup[];
  robotsAuditAvailable: boolean;
}

/** Fetches involved in the AEO audit must not hang the route forever. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Just the robots.txt half of the audit. Callers that only need the crawler
 * groups (the AI advice handler) use this instead of `analyzeAeo`, which would
 * additionally rebuild llms.txt and make three Admin API calls for data they
 * throw away.
 */
export async function auditLiveRobots(
  shop: string,
): Promise<{ available: boolean; crawlerGroups: RobotsCrawlerGroup[] }> {
  const txt = await fetchLiveRobots(shop);
  if (txt === null) return { available: false, crawlerGroups: [] };
  return { available: true, crawlerGroups: groupCrawlerStatuses(auditRobotsTxt(txt)) };
}

/**
 * Read-only AEO status: does llms.txt exist in the theme, and which AI crawlers
 * does the live robots.txt block (fully or partially). Best-effort: failures
 * degrade to empty, never throw at the route.
 */
export async function analyzeAeo(
  admin: AdminApiContext,
  shop: string,
  llms: { db: any; shopName: string; domain: string; description: string; autoUpdate: boolean },
): Promise<AeoAnalysis> {
  let llmsTxtExists = false;
  let llmsTxtUpToDate = false;
  let llmsProductCount = 0;
  let llmsCollectionCount = 0;
  let llmsPreview = "";
  try {
    const built = await buildLlmsTxtForShop(llms.db, shop, llms.shopName, llms.domain, llms.description);
    llmsProductCount = built.productCount;
    llmsCollectionCount = built.collectionCount;
    llmsPreview = built.content;

    const themeId = await getMainThemeId(admin);
    if (themeId) {
      const existing = await readThemeFile(admin, themeId, LLMS_TEMPLATE_FILENAME);
      llmsTxtExists = !!existing && unwrapLlmsTxtFromTheme(existing).trim().length > 0;
      llmsTxtUpToDate = llmsTxtExists && llmsTxtMatches(existing!, built.content);
    }
  } catch {
    /* leave defaults */
  }

  let blockedCrawlers: string[] = [];
  let partiallyBlockedCrawlers: string[] = [];
  let restrictedCrawlers: string[] = [];
  let crawlerGroups: RobotsCrawlerGroup[] = [];
  let robotsAuditAvailable = false;
  try {
    const res = await fetch(`https://${shop}/robots.txt`, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.ok) {
      const txt = await res.text();
      const statuses = auditRobotsTxt(txt);
      blockedCrawlers = statuses.filter((s) => s.blocked).map((s) => s.crawler);
      partiallyBlockedCrawlers = statuses.filter((s) => s.partiallyBlocked).map((s) => s.crawler);
      restrictedCrawlers = statuses.filter((s) => s.contentRestricted).map((s) => s.crawler);
      crawlerGroups = groupCrawlerStatuses(statuses);
      robotsAuditAvailable = true;
    }
  } catch {
    /* audit unavailable */
  }

  return {
    llmsTxtExists,
    llmsTxtUpToDate,
    llmsProductCount,
    llmsCollectionCount,
    llmsPreview,
    llmsUrl: `${baseUrl(llms.domain || shop)}/llms.txt`,
    themeWrites: themeWritesEnabled(),
    llmsAutoUpdate: llms.autoUpdate,
    shopDescriptionMissing: llms.description.trim().length === 0,
    blockedCrawlers,
    partiallyBlockedCrawlers,
    restrictedCrawlers,
    crawlerGroups,
    robotsAuditAvailable,
  };
}
