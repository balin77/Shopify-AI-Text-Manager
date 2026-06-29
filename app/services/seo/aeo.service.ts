/**
 * Answer Engine Optimization (SEO_TAB_IMPLEMENTATION_PLAN.md Phase 7 / Anhang D1).
 *
 * Two AI-search levers that need no Google approval:
 *  - **llms.txt**: a Markdown summary of the store for AI crawlers, written to
 *    the native `templates/llms.txt.liquid` theme file via Admin GraphQL
 *    (Shopify serves it at `/llms.txt`). Writing a *new* additive file is safe.
 *  - **robots.txt AI-crawler audit**: read-only check of the live robots.txt for
 *    AI bots that are blocked. We deliberately do NOT auto-rewrite
 *    `robots.txt.liquid` (an incorrect robots.txt is an SEO footgun and can't be
 *    safely verified here) — the section guides the merchant to the theme editor.
 *
 * `buildLlmsTxt` and `auditRobotsTxt` are pure (unit-tested); theme reads/writes
 * use the existing GET_THEMES / GET_THEME_FILES / UPSERT_THEME_FILES ops and the
 * already-present `write_themes` scope. No new model, no new scope.
 */

import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import { GET_THEMES, GET_THEME_FILES } from "../../graphql/content.queries";
import { UPSERT_THEME_FILES } from "../../graphql/content.mutations";

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
 * Build an llms.txt (Markdown) snapshot from the shop + top products/collections.
 * Pure. Follows the llms.txt convention: H1 name, a `>` summary, then sections.
 */
export function buildLlmsTxt(input: LlmsTxtInput): string {
  const base = baseUrl(input.domain);
  const lines: string[] = [];
  lines.push(`# ${input.shopName || "Shop"}`);
  lines.push("");
  if (input.description) {
    lines.push(`> ${oneLine(input.description, 250)}`);
    lines.push("");
  }

  if (input.products.length > 0) {
    lines.push("## Products");
    for (const p of input.products) {
      const url = base ? `${base}/products/${p.handle}` : `/products/${p.handle}`;
      const desc = oneLine(p.description);
      lines.push(desc ? `- [${p.title}](${url}): ${desc}` : `- [${p.title}](${url})`);
    }
    lines.push("");
  }

  if (input.collections.length > 0) {
    lines.push("## Collections");
    for (const c of input.collections) {
      const url = base ? `${base}/collections/${c.handle}` : `/collections/${c.handle}`;
      lines.push(`- [${c.title}](${url})`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

// ── robots.txt AI-crawler audit ──────────────────────────────────────────────

interface RobotsGroup {
  agents: string[];
  rules: Array<{ type: "allow" | "disallow"; path: string }>;
}

/** Parse robots.txt text into user-agent groups (consecutive UA lines share a group). */
function parseRobots(txt: string): RobotsGroup[] {
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

export interface RobotsCrawlerStatus {
  crawler: string;
  blocked: boolean;
}

/**
 * Audit live robots.txt content for AI crawlers that are fully blocked
 * (a matching `User-agent` group — or the `*` fallback — with `Disallow: /` and
 * no overriding `Allow: /`). Pure.
 */
export function auditRobotsTxt(robotsTxt: string): RobotsCrawlerStatus[] {
  const groups = parseRobots(robotsTxt || "");
  const groupFor = (crawler: string): RobotsGroup | null => {
    const c = crawler.toLowerCase();
    const exact = groups.find((g) => g.agents.includes(c));
    if (exact) return exact;
    return groups.find((g) => g.agents.includes("*")) ?? null;
  };
  const isBlocked = (g: RobotsGroup | null): boolean => {
    if (!g) return false;
    const blocksRoot = g.rules.some((r) => r.type === "disallow" && r.path === "/");
    const allowsRoot = g.rules.some((r) => r.type === "allow" && r.path === "/");
    return blocksRoot && !allowsRoot;
  };
  return AI_CRAWLERS.map((crawler) => ({ crawler, blocked: isBlocked(groupFor(crawler)) }));
}

// ── Theme file I/O (Admin GraphQL) ───────────────────────────────────────────

export async function getMainThemeId(admin: AdminApiContext): Promise<string | null> {
  const res = await admin.graphql(GET_THEMES, { variables: { first: 50 } });
  const json: any = await res.json();
  const edges = json?.data?.themes?.edges ?? [];
  const main =
    edges.find((e: any) => e.node?.role === "MAIN") ??
    edges.find((e: any) => e.node?.role === "PUBLISHED");
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
): Promise<{ userErrors: Array<{ field?: string[] | null; message: string }> }> {
  const res = await admin.graphql(UPSERT_THEME_FILES, {
    variables: { themeId, files: [{ filename, body: { type: "TEXT", value: content } }] },
  });
  const json: any = await res.json();
  return { userErrors: json?.data?.themeFilesUpsert?.userErrors ?? [] };
}

// ── Orchestration ────────────────────────────────────────────────────────────

/** Max items per section in the generated llms.txt. */
export const LLMS_MAX_PER_TYPE = 50;

export interface GenerateLlmsResult {
  ok: boolean;
  error?: string;
}

/**
 * Build llms.txt from the DB cache and upsert it into the published theme.
 * Returns ok:false (never throws) with a reason the route can map to i18n.
 */
export async function generateAndUpsertLlmsTxt(
  admin: AdminApiContext,
  db: any,
  shop: string,
  shopName: string,
  domain: string,
): Promise<GenerateLlmsResult> {
  const themeId = await getMainThemeId(admin);
  if (!themeId) return { ok: false, error: "no_theme" };

  const [products, collections] = await Promise.all([
    db.product.findMany({
      where: { shop, status: "ACTIVE" },
      select: { title: true, handle: true, seoDescription: true, descriptionHtml: true },
      orderBy: { lastSyncedAt: "desc" },
      take: LLMS_MAX_PER_TYPE,
    }),
    db.collection.findMany({
      where: { shop },
      select: { title: true, handle: true },
      orderBy: { lastSyncedAt: "desc" },
      take: LLMS_MAX_PER_TYPE,
    }),
  ]);

  const content = buildLlmsTxt({
    shopName,
    domain,
    products: products.map((p: any) => ({
      title: p.title,
      handle: p.handle,
      description: p.seoDescription || p.descriptionHtml,
    })),
    collections: collections.map((c: any) => ({ title: c.title, handle: c.handle })),
  });

  const { userErrors } = await upsertThemeFile(admin, themeId, LLMS_TEMPLATE_FILENAME, content);
  if (userErrors.length > 0) return { ok: false, error: "upsert_failed" };
  return { ok: true };
}

export interface AeoAnalysis {
  llmsTxtExists: boolean;
  blockedCrawlers: string[];
  robotsAuditAvailable: boolean;
}

/**
 * Read-only AEO status: does llms.txt exist in the theme, and which AI crawlers
 * does the live robots.txt block. Best-effort: failures degrade to empty, never
 * throw at the route.
 */
export async function analyzeAeo(
  admin: AdminApiContext,
  shop: string,
): Promise<AeoAnalysis> {
  let llmsTxtExists = false;
  try {
    const themeId = await getMainThemeId(admin);
    if (themeId) {
      const existing = await readThemeFile(admin, themeId, LLMS_TEMPLATE_FILENAME);
      llmsTxtExists = !!existing && existing.trim().length > 0;
    }
  } catch {
    /* leave false */
  }

  let blockedCrawlers: string[] = [];
  let robotsAuditAvailable = false;
  try {
    const res = await fetch(`https://${shop}/robots.txt`, { redirect: "follow" });
    if (res.ok) {
      const txt = await res.text();
      blockedCrawlers = auditRobotsTxt(txt).filter((s) => s.blocked).map((s) => s.crawler);
      robotsAuditAvailable = true;
    }
  } catch {
    /* audit unavailable */
  }

  return { llmsTxtExists, blockedCrawlers, robotsAuditAvailable };
}
