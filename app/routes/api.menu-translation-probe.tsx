/**
 * Menu Translation Probe — "why do menu SUB-items not translate?"
 *
 * ── The question, precisely ────────────────────────────────────────────────
 * The observed symptom is not "menus cannot be translated". It is one level
 * deeper and much more specific: a TOP-LEVEL menu item ("Produkte") takes a
 * translation, its CHILDREN ("Stifthalter", "Kissenbezüge") do not. That is
 * the entire report this route exists to explain, and there are exactly two
 * candidate explanations with opposite consequences:
 *
 *   (a) ENUMERATION. Shopify's own docs say a menu's
 *       nestedTranslatableResources(resourceType: LINK) covers "1 level of
 *       nesting". If that is literal, the child links are never HANDED to us
 *       — but they exist, and writing to them directly works. Then the fix is
 *       ours to build and the read-only banner on /app/menus is wrong.
 *
 *   (b) PLATFORM. Child links have no translatable resource at all. Then the
 *       banner is right, and no amount of code changes it.
 *
 * Nothing short of a live shop separates the two: both look identical from
 * the app's side (a write that "succeeds" and changes nothing on the
 * storefront), which is how the wrong conclusion — "the Shopify API does not
 * support translating menu items" in the header of app/routes/app.menus.tsx —
 * got recorded as fact in the first place. This is the same trap the
 * translatableContent invariant in CLAUDE.md describes: an absent entry is
 * indistinguishable from an unsupported one until you probe a resource that
 * actually has the value.
 *
 * ── What it measures, and what each measurement decides ────────────────────
 * A. STRUCTURE — menus(first:) with three levels of items. Establishes the
 *    denominator: how many items exist per depth. Without it "we found 7
 *    links" means nothing.
 *
 * B. NESTED — translatableResource(menu).nestedTranslatableResources(LINK).
 *    The path an implementation would naturally take. If depth-1 items come
 *    back and depth-2 items do not, explanation (a) is confirmed for the READ
 *    side. hasNextPage is reported: a truncated page would fake the same
 *    result, and that must not be mistaken for evidence.
 *
 * C. FLAT SWEEP — translatableResources(resourceType: LINK), fully paged.
 *    Every Link resource of the shop, regardless of which menu or depth it
 *    belongs to. If a child's title turns up here, the resource EXISTS and B
 *    was merely hiding it. Matching is by TITLE, so it is reported as
 *    unique / ambiguous / absent rather than as a boolean — two menu items
 *    may legitimately share a label.
 *
 * D. GID DERIVATION — the decisive one, because it needs no title matching.
 *    For depth-1 items we know BOTH ids: the MenuItem GID from A and the Link
 *    GID from B. If their numeric parts are equal, a Link GID is derivable
 *    from any MenuItem GID — so the same construction is applied to a DEPTH-2
 *    MenuItem and the resulting gid://shopify/Link/<n> is looked up directly.
 *    Resolves + value equals the child's title ⇒ (a), proven, with the exact
 *    id an implementation would use.
 *
 * E. WRITE (opt-in) — registers a uniquely tagged translation on a confirmed
 *    depth-2 Link, re-reads it (the echo rule: userErrors:[] is not success),
 *    and removes it again in a finally. It REFUSES to touch a key that
 *    already carries a translation, so it can never overwrite merchant
 *    content — same posture as bulk-translate's fill-only rule.
 *
 * ── Why it runs against several API versions at once ───────────────────────
 * The question that prompted this was "does 2026-07 change anything versus
 * 2025-10". Answering it from changelogs is guesswork; answering it from one
 * run against the pinned version is worse, because it silently reports the
 * pinned version's behaviour as the platform's. So every read measurement is
 * executed once PER version through a raw fetch against
 * /admin/api/<version>/graphql.json (the same escape hatch the COOKIE_BANNER
 * hunt in api.translation-probe.tsx uses), and the verdict states whether the
 * versions agreed. A version whose enum or field does not exist yet comes back
 * as a GraphQL error, which is itself the answer for that version.
 *
 * Read-only unless writeTest=true. Nothing is left behind either way.
 */

import { data as json, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { logger } from "~/utils/logger.server";
import { db } from "~/db.server";
import { meetsPlan } from "~/utils/planUtils";
import { resolveApiVersionString } from "~/utils/api-version";

/** Versions every run compares. The pinned one is added by the action. */
const COMPARE_VERSIONS = ["2025-10", "2026-07"] as const;

/** Menus per run. A shop has a handful; the cap only stops a pathological one. */
const MENU_LIMIT = 25;
/** Page size and page cap for the flat LINK sweep (2000 links). */
const LINK_PAGE_SIZE = 250;
const LINK_PAGE_CAP = 8;
/** How many depth-2 items the derived-GID lookup tries. */
const DERIVED_GID_SAMPLES = 3;

// ── Queries ────────────────────────────────────────────────────────────────
// No backticks inside these comments: a backtick ends the template literal
// and the resulting TS1005 points at innocent code (CLAUDE.md, four rounds).

const MENUS_QUERY = `#graphql
  query menuProbeMenus($first: Int!) {
    menus(first: $first) {
      nodes {
        id
        title
        handle
        items {
          id
          title
          items {
            id
            title
            items { id title }
          }
        }
      }
    }
  }
`;

/** B: the path an implementation would take on its own. */
const MENU_NESTED_QUERY = `#graphql
  query menuProbeNested($resourceId: ID!, $first: Int!) {
    translatableResource(resourceId: $resourceId) {
      resourceId
      translatableContent { key value digest }
      nestedTranslatableResources(resourceType: LINK, first: $first) {
        nodes {
          resourceId
          translatableContent { key value digest }
        }
        pageInfo { hasNextPage }
      }
    }
  }
`;

/** C: every Link of the shop, paged by cursor. */
const LINK_SWEEP_QUERY = `#graphql
  query menuProbeLinkSweep($first: Int!, $after: String) {
    translatableResources(first: $first, after: $after, resourceType: LINK) {
      edges {
        node {
          resourceId
          translatableContent { key value digest }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/**
 * D: content only. Deliberately WITHOUT the translations field — that one
 * takes a required locale argument, and the derived-GID lookup is the one
 * measurement that must not be able to fail over a locale this shop does not
 * have. What D asks is only whether the resource exists and carries the title.
 */
const SINGLE_LINK_CONTENT_QUERY = `#graphql
  query menuProbeSingleLinkContent($resourceId: ID!) {
    translatableResource(resourceId: $resourceId) {
      resourceId
      translatableContent { key value digest }
    }
  }
`;

/** E: the same resource plus its existing translations in the write locale. */
const SINGLE_LINK_QUERY = `#graphql
  query menuProbeSingleLink($resourceId: ID!, $locale: String!) {
    translatableResource(resourceId: $resourceId) {
      resourceId
      translatableContent { key value digest }
      translations(locale: $locale) { key value locale outdated }
    }
  }
`;

const REGISTER_MUTATION = `#graphql
  mutation menuProbeRegister($resourceId: ID!, $translations: [TranslationInput!]!) {
    translationsRegister(resourceId: $resourceId, translations: $translations) {
      translations { key value locale }
      userErrors { field message }
    }
  }
`;

const REMOVE_MUTATION = `#graphql
  mutation menuProbeRemove($resourceId: ID!, $translationKeys: [String!]!, $locales: [String!]!) {
    translationsRemove(resourceId: $resourceId, translationKeys: $translationKeys, locales: $locales) {
      translations { key value }
      userErrors { field message }
    }
  }
`;

const LOCALES_QUERY = `#graphql
  query menuProbeLocales { shopLocales { locale primary published } }
`;

// ── Report shape ───────────────────────────────────────────────────────────

interface MenuItemRef {
  menuId: string;
  menuItemId: string;
  title: string;
  /** 1 = top level. */
  depth: number;
}

interface MenuStructure {
  menuId: string;
  title: string;
  handle: string;
  /** Index 0 = depth 1. */
  itemsByDepth: number[];
}

/** B, per menu. */
interface NestedReport {
  menuId: string;
  menuTitle: string;
  error?: string;
  /** Keys the MENU resource itself offers (expected: title — the admin-only name). */
  menuKeys: string[];
  linkCount: number;
  /** A short page would imitate "children are absent" — never read one as evidence. */
  hasNextPage: boolean;
  /** Index 0 = depth 1: how many of this menu's items were matched uniquely by title. */
  matchedByDepth: number[];
  /** Same index base: titles that occur more than once, so a match proves nothing. */
  ambiguousByDepth: number[];
  /** Returned links whose title matches no item of this menu at all. */
  unmatchedLinks: number;
}

/** C. */
interface SweepReport {
  error?: string;
  total: number;
  pages: number;
  /** Hit the page cap — "absent" below would then be unproven. */
  truncated: boolean;
  /** Per depth (index 0 = depth 1): how the shop's menu items look up in the sweep. */
  lookupByDepth: Array<{ depth: number; items: number; unique: number; ambiguous: number; absent: number }>;
  /** Concrete depth>=2 hits, for the write step and for the reader. */
  deepHits: Array<{ title: string; depth: number; menuItemId: string; linkId: string }>;
}

/** D. */
interface DerivationReport {
  /** Depth-1 pairs where both ids are known and unambiguous. */
  checked: number;
  aligned: number;
  sample?: { menuItemId: string; linkId: string };
  /** Derived lookups against depth>=2 MenuItem ids. */
  probes: Array<{
    menuItemId: string;
    title: string;
    depth: number;
    derivedLinkId: string;
    resolved: boolean;
    keys: string[];
    valueMatchesTitle: boolean;
    error?: string;
  }>;
}

interface VersionReport {
  apiVersion: string;
  /** Set when the version itself could not be reached (unknown version, auth). */
  fatalError?: string;
  structures: MenuStructure[];
  nested: NestedReport[];
  sweep: SweepReport;
  derivation: DerivationReport;
}

interface WriteProbeReport {
  attempted: boolean;
  skipReason?: string;
  apiVersion?: string;
  locale?: string;
  linkId?: string;
  title?: string;
  depth?: number;
  attemptedValue?: string;
  /** The echo rule: what Shopify returned from the mutation. */
  registerEcho?: string | null;
  /** And what a fresh read says afterwards — the only thing that counts. */
  readBack?: string | null;
  result?: "confirmed" | "silent-noop" | "failure";
  removed?: boolean;
  errors?: string[];
}

export interface MenuTranslationProbeReport {
  generatedAt: string;
  shop: string;
  pinnedApiVersion: string;
  primaryLocale: string | null;
  writeLocale: string | null;
  versions: VersionReport[];
  writeProbe: WriteProbeReport;
  verdict: string[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

type GqlResult = { data?: Record<string, unknown>; errors?: Array<{ message: string }> };
type GqlRunner = (query: string, variables?: Record<string, unknown>) => Promise<GqlResult>;

/**
 * Every version — including the pinned one — goes through the same raw client,
 * so a difference between two runs can only come from the version, never from
 * two different transports.
 */
function rawRunner(shop: string, accessToken: string, apiVersion: string): GqlRunner {
  return async (query, variables) => {
    const response = await fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables: variables ?? {} }),
    });
    if (!response.ok) {
      return { errors: [{ message: `HTTP ${response.status} from /admin/api/${apiVersion}` }] };
    }
    return (await response.json()) as GqlResult;
  };
}

/** gid://shopify/MenuItem/123 → "123". Empty string when there is no numeric tail. */
function gidNumeric(gid: string): string {
  const tail = gid.split("/").pop() ?? "";
  return /^\d+$/.test(tail) ? tail : "";
}

function titleOf(content: Array<{ key: string; value: string | null }> | undefined): string | null {
  return content?.find((c) => c.key === "title")?.value ?? null;
}

interface RawMenuItem {
  id: string;
  title: string;
  items?: RawMenuItem[] | null;
}

/** Flattens a menu's item tree, stamping each entry with its depth. */
function flattenItems(menuId: string, items: RawMenuItem[] | null | undefined, depth: number, into: MenuItemRef[]) {
  for (const item of items ?? []) {
    into.push({ menuId, menuItemId: item.id, title: item.title, depth });
    flattenItems(menuId, item.items, depth + 1, into);
  }
}

/** Counts per depth, index 0 = depth 1. */
function countByDepth(items: MenuItemRef[]): number[] {
  const counts: number[] = [];
  for (const item of items) {
    const index = item.depth - 1;
    counts[index] = (counts[index] ?? 0) + 1;
  }
  for (let i = 0; i < counts.length; i += 1) counts[i] = counts[i] ?? 0;
  return counts;
}

/**
 * Title → items. The ONLY way to relate a Link resource to a menu item
 * without an id, so its ambiguity is carried into the report rather than
 * resolved by picking the first hit.
 */
function indexByTitle(items: MenuItemRef[]): Map<string, MenuItemRef[]> {
  const index = new Map<string, MenuItemRef[]>();
  for (const item of items) {
    const key = item.title.trim();
    const bucket = index.get(key);
    if (bucket) bucket.push(item);
    else index.set(key, [item]);
  }
  return index;
}

// ── Measurements ───────────────────────────────────────────────────────────

async function measureVersion(run: GqlRunner, apiVersion: string): Promise<VersionReport> {
  const report: VersionReport = {
    apiVersion,
    structures: [],
    nested: [],
    sweep: { total: 0, pages: 0, truncated: false, lookupByDepth: [], deepHits: [] },
    derivation: { checked: 0, aligned: 0, probes: [] },
  };

  // ── A. Structure ─────────────────────────────────────────────────────────
  const menusResult = await run(MENUS_QUERY, { first: MENU_LIMIT });
  if (menusResult.errors?.length) {
    report.fatalError = `menus query failed: ${menusResult.errors.map((e) => e.message).join(" | ")}`;
    return report;
  }
  const menus = ((menusResult.data as { menus?: { nodes?: Array<{ id: string; title: string; handle: string; items?: RawMenuItem[] }> } })?.menus?.nodes) ?? [];

  const allItems: MenuItemRef[] = [];
  const itemsByMenu = new Map<string, MenuItemRef[]>();
  for (const menu of menus) {
    const items: MenuItemRef[] = [];
    flattenItems(menu.id, menu.items, 1, items);
    itemsByMenu.set(menu.id, items);
    allItems.push(...items);
    report.structures.push({
      menuId: menu.id,
      title: menu.title,
      handle: menu.handle,
      itemsByDepth: countByDepth(items),
    });
  }

  // Pairs harvested from B, consumed by D. Only unambiguous ones are useful.
  const depthOnePairs: Array<{ menuItemId: string; linkId: string }> = [];

  // ── B. Nested enumeration, per menu ──────────────────────────────────────
  for (const menu of menus) {
    const items = itemsByMenu.get(menu.id) ?? [];
    const byTitle = indexByTitle(items);
    const entry: NestedReport = {
      menuId: menu.id,
      menuTitle: menu.title,
      menuKeys: [],
      linkCount: 0,
      hasNextPage: false,
      matchedByDepth: [],
      ambiguousByDepth: [],
      unmatchedLinks: 0,
    };

    const result = await run(MENU_NESTED_QUERY, { resourceId: menu.id, first: LINK_PAGE_SIZE });
    if (result.errors?.length) {
      entry.error = result.errors.map((e) => e.message).join(" | ");
      report.nested.push(entry);
      continue;
    }

    const resource = (result.data as {
      translatableResource?: {
        translatableContent?: Array<{ key: string; value: string | null; digest: string }>;
        nestedTranslatableResources?: {
          nodes?: Array<{ resourceId: string; translatableContent?: Array<{ key: string; value: string | null; digest: string }> }>;
          pageInfo?: { hasNextPage?: boolean };
        };
      };
    })?.translatableResource;

    if (!resource) {
      entry.error = "translatableResource returned null for the menu GID";
      report.nested.push(entry);
      continue;
    }

    entry.menuKeys = (resource.translatableContent ?? []).map((c) => c.key);
    const nodes = resource.nestedTranslatableResources?.nodes ?? [];
    entry.linkCount = nodes.length;
    entry.hasNextPage = !!resource.nestedTranslatableResources?.pageInfo?.hasNextPage;

    for (const node of nodes) {
      const title = titleOf(node.translatableContent)?.trim();
      const candidates = title ? byTitle.get(title) ?? [] : [];
      if (candidates.length === 1) {
        const index = candidates[0].depth - 1;
        entry.matchedByDepth[index] = (entry.matchedByDepth[index] ?? 0) + 1;
        if (candidates[0].depth === 1) {
          depthOnePairs.push({ menuItemId: candidates[0].menuItemId, linkId: node.resourceId });
        }
      } else if (candidates.length > 1) {
        const index = candidates[0].depth - 1;
        entry.ambiguousByDepth[index] = (entry.ambiguousByDepth[index] ?? 0) + 1;
      } else {
        entry.unmatchedLinks += 1;
      }
    }
    for (let i = 0; i < entry.matchedByDepth.length; i += 1) entry.matchedByDepth[i] = entry.matchedByDepth[i] ?? 0;
    for (let i = 0; i < entry.ambiguousByDepth.length; i += 1) entry.ambiguousByDepth[i] = entry.ambiguousByDepth[i] ?? 0;

    report.nested.push(entry);
  }

  // ── C. Flat sweep over every Link of the shop ────────────────────────────
  const linksByTitle = new Map<string, string[]>();
  let cursor: string | null = null;
  let pages = 0;
  // Any exit while Shopify still has pages is a TRUNCATED sweep, whether the
  // cap stopped it or a missing cursor did. Tracking the flag at the exits
  // instead let a cursor-less break through as a complete read, and an
  // incomplete read is what turns "absent" into the unproven verdict below.
  let moreAvailable = false;
  while (pages < LINK_PAGE_CAP) {
    const result: GqlResult = await run(LINK_SWEEP_QUERY, { first: LINK_PAGE_SIZE, after: cursor });
    if (result.errors?.length) {
      report.sweep.error = result.errors.map((e) => e.message).join(" | ");
      break;
    }
    const connection = (result.data as {
      translatableResources?: {
        edges?: Array<{ node: { resourceId: string; translatableContent?: Array<{ key: string; value: string | null; digest: string }> } }>;
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      };
    })?.translatableResources;

    for (const edge of connection?.edges ?? []) {
      report.sweep.total += 1;
      const title = titleOf(edge.node.translatableContent)?.trim();
      if (!title) continue;
      const bucket = linksByTitle.get(title);
      if (bucket) bucket.push(edge.node.resourceId);
      else linksByTitle.set(title, [edge.node.resourceId]);
    }
    pages += 1;
    moreAvailable = !!connection?.pageInfo?.hasNextPage;
    if (!moreAvailable) break;
    cursor = connection?.pageInfo?.endCursor ?? null;
    if (!cursor) break;
  }
  report.sweep.pages = pages;
  report.sweep.truncated = moreAvailable;

  if (!report.sweep.error) {
    // The title is the ONLY thing relating a Link to a menu item here, so a
    // title that several menu items share proves nothing about any of them:
    // a child could be "confirmed" by its own parent's Link, and that GID
    // would then become the write target. Shop-wide scope on purpose — the
    // sweep is shop-wide too.
    const itemsByTitle = indexByTitle(allItems);
    const depths = [...new Set(allItems.map((i) => i.depth))].sort((a, b) => a - b);
    for (const depth of depths) {
      const items = allItems.filter((i) => i.depth === depth);
      let unique = 0;
      let ambiguous = 0;
      let absent = 0;
      for (const item of items) {
        const title = item.title.trim();
        const hits = linksByTitle.get(title) ?? [];
        const sharesTitle = (itemsByTitle.get(title) ?? []).length > 1;
        if (hits.length === 1 && !sharesTitle) {
          unique += 1;
          if (depth >= 2 && report.sweep.deepHits.length < 10) {
            report.sweep.deepHits.push({ title: item.title, depth, menuItemId: item.menuItemId, linkId: hits[0] });
          }
        } else if (hits.length > 1 || (hits.length === 1 && sharesTitle)) {
          ambiguous += 1;
        } else {
          absent += 1;
        }
      }
      report.sweep.lookupByDepth.push({ depth, items: items.length, unique, ambiguous, absent });
    }
  }

  // ── D. Is a Link GID derivable from a MenuItem GID? ──────────────────────
  for (const pair of depthOnePairs) {
    const menuNumeric = gidNumeric(pair.menuItemId);
    const linkNumeric = gidNumeric(pair.linkId);
    if (!menuNumeric || !linkNumeric) continue;
    report.derivation.checked += 1;
    if (menuNumeric === linkNumeric) {
      report.derivation.aligned += 1;
      if (!report.derivation.sample) report.derivation.sample = pair;
    }
  }

  // Try the derived id on DEPTH-2 items regardless of the alignment count:
  // a failed derivation that was never attempted is not a measurement, and
  // when alignment holds this is the exact id an implementation would use.
  const deepItems = allItems.filter((i) => i.depth >= 2).slice(0, DERIVED_GID_SAMPLES);
  for (const item of deepItems) {
    const numeric = gidNumeric(item.menuItemId);
    const derivedLinkId = numeric ? `gid://shopify/Link/${numeric}` : "";
    const probe: DerivationReport["probes"][number] = {
      menuItemId: item.menuItemId,
      title: item.title,
      depth: item.depth,
      derivedLinkId,
      resolved: false,
      keys: [],
      valueMatchesTitle: false,
    };
    if (!derivedLinkId) {
      probe.error = "MenuItem GID has no numeric tail — nothing to derive from";
      report.derivation.probes.push(probe);
      continue;
    }
    const result = await run(SINGLE_LINK_CONTENT_QUERY, { resourceId: derivedLinkId });
    if (result.errors?.length) {
      probe.error = result.errors.map((e) => e.message).join(" | ");
    } else {
      const resource = (result.data as {
        translatableResource?: { translatableContent?: Array<{ key: string; value: string | null }> };
      })?.translatableResource;
      if (resource) {
        probe.resolved = true;
        probe.keys = (resource.translatableContent ?? []).map((c) => c.key);
        probe.valueMatchesTitle = titleOf(resource.translatableContent)?.trim() === item.title.trim();
      }
    }
    report.derivation.probes.push(probe);
  }

  return report;
}

/**
 * E. One real translation on a confirmed depth>=2 Link, verified by re-read
 * and removed again. Refuses a key that already carries a translation — a
 * diagnostic must never overwrite merchant content, and restoring it
 * afterwards would be a second thing that can fail.
 */
async function probeWrite(
  run: GqlRunner,
  apiVersion: string,
  target: { linkId: string; title: string; depth: number },
  locale: string,
): Promise<WriteProbeReport> {
  const report: WriteProbeReport = {
    attempted: true,
    apiVersion,
    locale,
    linkId: target.linkId,
    title: target.title,
    depth: target.depth,
  };

  try {
    const before = await run(SINGLE_LINK_QUERY, { resourceId: target.linkId, locale });
    if (before.errors?.length) {
      report.result = "failure";
      report.errors = before.errors.map((e) => e.message);
      return report;
    }
    const resource = (before.data as {
      translatableResource?: {
        translatableContent?: Array<{ key: string; value: string | null; digest: string }>;
        translations?: Array<{ key: string; value: string | null }>;
      };
    })?.translatableResource;

    const digest = resource?.translatableContent?.find((c) => c.key === "title")?.digest;
    if (!digest) {
      report.result = "failure";
      report.errors = ["The Link resource carries no title digest — nothing to register against."];
      return report;
    }
    const existing = resource?.translations?.find((t) => t.key === "title")?.value ?? null;
    if (existing) {
      report.attempted = false;
      report.skipReason = `This menu item already has a "${locale}" translation ("${existing}"). The probe never overwrites merchant content — pick a shop or item without one.`;
      return report;
    }

    const value = `${target.title} [cp-probe-${Math.random().toString(36).slice(2, 8)}]`;
    report.attemptedValue = value;

    const registered = await run(REGISTER_MUTATION, {
      resourceId: target.linkId,
      translations: [{ key: "title", value, locale, translatableContentDigest: digest }],
    });
    if (registered.errors?.length) {
      report.result = "failure";
      report.errors = registered.errors.map((e) => e.message);
      return report;
    }
    const mutation = (registered.data as {
      translationsRegister?: { translations?: Array<{ key: string; value: string | null }>; userErrors?: Array<{ field: string[] | null; message: string }> };
    })?.translationsRegister;
    if (mutation?.userErrors?.length) {
      report.result = "failure";
      report.errors = mutation.userErrors.map((e) => `${e.field?.join(".") ?? ""}: ${e.message}`);
      return report;
    }
    report.registerEcho = mutation?.translations?.find((t) => t.key === "title")?.value ?? null;

    // The echo rule: the mutation's own answer is not the evidence. A fresh
    // read is — this is exactly the "accepted the call, stored nothing" case
    // the app's translation invariants exist for.
    //
    // But a read that never ARRIVED is not evidence either. A throttled or
    // failed read-back also produces no value, and calling that a silent
    // no-op would print "the feature is not buildable" over a network hiccup.
    const after = await run(SINGLE_LINK_QUERY, { resourceId: target.linkId, locale });
    if (after.errors?.length) {
      report.result = "failure";
      report.errors = [
        `Registered, but the verifying read failed: ${after.errors.map((e) => e.message).join(" | ")}. Nothing is proven either way — re-run.`,
      ];
      return report;
    }
    const readBack = ((after.data as {
      translatableResource?: { translations?: Array<{ key: string; value: string | null }> };
    })?.translatableResource?.translations ?? []).find((t) => t.key === "title")?.value ?? null;
    report.readBack = readBack;
    report.result = readBack === value ? "confirmed" : "silent-noop";

    return report;
  } catch (error) {
    report.result = "failure";
    report.errors = [error instanceof Error ? error.message : String(error)];
    return report;
  } finally {
    // Always: a diagnostic must leave the shop as it found it.
    //
    // And translationsRemove is subject to the same silent-no-op rule as the
    // register side (CLAUDE.md: if Shopify does not confirm the removal, it
    // did not happen). So this counts as removed only when the transport, the
    // userErrors AND the echoed keys all say so — anything short of that
    // reports false, and the verdict then tells the merchant where to delete
    // the leftover by hand. Over-reporting a leftover costs one sentence;
    // under-reporting one leaves a tagged string in a live storefront menu.
    if (report.attempted && report.attemptedValue) {
      const removal = await run(REMOVE_MUTATION, {
        resourceId: target.linkId,
        translationKeys: ["title"],
        locales: [locale],
      }).catch(() => null);
      const payload = (removal?.data as {
        translationsRemove?: { translations?: Array<{ key: string }>; userErrors?: Array<{ field: string[] | null; message: string }> };
      })?.translationsRemove;
      report.removed =
        !!removal &&
        !removal.errors?.length &&
        !payload?.userErrors?.length &&
        !!payload?.translations?.some((t) => t.key === "title");
      if (!report.removed) {
        const detail =
          removal?.errors?.map((e) => e.message).join(" | ") ||
          payload?.userErrors?.map((e) => e.message).join(" | ") ||
          "Shopify did not echo the removed key back";
        report.errors = [...(report.errors ?? []), `Cleanup unconfirmed: ${detail}`];
      }
    }
  }
}

// ── Verdict ────────────────────────────────────────────────────────────────

function buildVerdict(report: MenuTranslationProbeReport): string[] {
  const lines: string[] = [];
  const usable = report.versions.filter((v) => !v.fatalError);

  if (!usable.length) {
    lines.push("INCONCLUSIVE — no API version answered. Nothing below can be read as evidence.");
    return lines;
  }

  const deepItems = usable[0].structures.reduce((sum, s) => sum + s.itemsByDepth.slice(1).reduce((a, b) => a + (b ?? 0), 0), 0);
  if (deepItems === 0) {
    lines.push(
      "INCONCLUSIVE — this shop has no menu items below the top level, so the reported symptom cannot occur here. Run it on a shop with a nested menu.",
    );
    return lines;
  }

  for (const version of usable) {
    const nestedDeep = version.nested.reduce((sum, n) => sum + n.matchedByDepth.slice(1).reduce((a, b) => a + (b ?? 0), 0), 0);
    const nestedTop = version.nested.reduce((sum, n) => sum + (n.matchedByDepth[0] ?? 0), 0);
    const truncatedNested = version.nested.some((n) => n.hasNextPage);
    const sweepDeep = version.sweep.lookupByDepth.filter((l) => l.depth >= 2);
    const sweepUnique = sweepDeep.reduce((sum, l) => sum + l.unique, 0);
    const sweepAbsent = sweepDeep.reduce((sum, l) => sum + l.absent, 0);
    const derivedOk = version.derivation.probes.filter((p) => p.resolved && p.valueMatchesTitle).length;
    const derivedInconclusive =
      version.derivation.probes.length === 0 || version.derivation.probes.every((p) => !!p.error);

    lines.push(
      `[${version.apiVersion}] nestedTranslatableResources returned ${nestedTop} top-level and ${nestedDeep} sub-level links` +
        `${truncatedNested ? " (a page was truncated — treat the sub-level count as unproven)" : ""}.`,
    );

    // Order matters and is not the order of the measurements: whether the
    // NESTED query already returns sub-level links decides which of the two
    // explanations is even on the table. Asking the derived-GID branch first
    // would print "only the enumeration path did not hand it over" about an
    // enumeration that handed it over.
    if (nestedDeep > 0) {
      lines.push(
        `[${version.apiVersion}] ANSWER: sub-items ARE translatable, and nestedTranslatableResources already returns them (${nestedDeep} sub-level links). ` +
          "The enumeration is not the obstacle — whatever failed originally failed on the write side or was never attempted against these ids.",
      );
    } else if (derivedOk > 0) {
      lines.push(
        `[${version.apiVersion}] ANSWER: sub-items ARE translatable. ${derivedOk} of ${version.derivation.probes.length} depth>=2 MenuItem ids resolved as gid://shopify/Link/<same-number> with a matching title` +
          `${version.derivation.checked > 0 ? ` (id alignment held for ${version.derivation.aligned}/${version.derivation.checked} known top-level pairs)` : ""}. ` +
          "The Link resource exists and is addressable — only the enumeration path did not hand it over.",
      );
    } else if (sweepUnique > 0) {
      lines.push(
        `[${version.apiVersion}] ANSWER: sub-items ARE translatable. The flat translatableResources(LINK) sweep found ${sweepUnique} of the sub-level titles as Link resources` +
          `${version.sweep.truncated ? " (the sweep hit its page cap, so the absent ones are unproven)" : ""}, even though the nested query did not return them.`,
      );
    } else if (version.sweep.error) {
      lines.push(`[${version.apiVersion}] INCONCLUSIVE — the flat LINK sweep failed: ${version.sweep.error}`);
    } else if (sweepAbsent > 0 && !version.sweep.truncated && !derivedInconclusive) {
      lines.push(
        `[${version.apiVersion}] ANSWER: NO — ${sweepAbsent} sub-level titles have no Link resource anywhere in the shop, and no derived GID resolved. On this version the limitation is the platform's, not the enumeration's.`,
      );
    } else if (derivedInconclusive) {
      // A negative answer needs BOTH paths to have actually run. Derived
      // lookups that all errored out are an absence of measurement, and
      // reading them as an absence of the resource is the same mistake the
      // "menus cannot be translated" claim was.
      lines.push(
        `[${version.apiVersion}] INCONCLUSIVE — every derived-GID lookup failed or none ran (${version.derivation.probes.map((p) => p.error).filter(Boolean).join("; ") || "no depth>=2 item to derive from"}). The negative reading is not available from this run.`,
      );
    } else {
      lines.push(`[${version.apiVersion}] INCONCLUSIVE — neither path produced a sub-level Link, and nothing rules out a truncated read.`);
    }
  }

  if (usable.length > 1) {
    const signature = (v: VersionReport) =>
      JSON.stringify({
        nestedDeep: v.nested.reduce((sum, n) => sum + n.matchedByDepth.slice(1).reduce((a, b) => a + (b ?? 0), 0), 0),
        derived: v.derivation.probes.filter((p) => p.resolved).length,
        sweepUnique: v.sweep.lookupByDepth.filter((l) => l.depth >= 2).reduce((sum, l) => sum + l.unique, 0),
      });
    const first = signature(usable[0]);
    const same = usable.every((v) => signature(v) === first);
    lines.push(
      same
        ? `VERSION COMPARISON: ${usable.map((v) => v.apiVersion).join(" and ")} behave IDENTICALLY here — upgrading the pinned version changes nothing about menu translations.`
        : `VERSION COMPARISON: the versions DISAGREE (${usable.map((v) => v.apiVersion).join(" vs ")}). Read each line above separately before designing against either.`,
    );
  }

  for (const version of report.versions.filter((v) => v.fatalError)) {
    lines.push(`[${version.apiVersion}] not measured: ${version.fatalError}`);
  }

  if (report.writeProbe.attempted) {
    if (report.writeProbe.result === "confirmed") {
      lines.push(
        `WRITE: a translation on the sub-item "${report.writeProbe.title}" was registered AND read back (${report.writeProbe.locale}), then removed again. The write path works end to end.`,
      );
    } else if (report.writeProbe.result === "silent-noop") {
      lines.push(
        `WRITE: Shopify accepted the call but a fresh read returned ${report.writeProbe.readBack === null ? "nothing" : `"${report.writeProbe.readBack}"`}. That is the silent no-op pattern — the resource takes writes without storing them, so the feature is NOT buildable on this path.`,
      );
    } else {
      lines.push(`WRITE: failed — ${report.writeProbe.errors?.join("; ") || "no detail"}.`);
    }
    if (report.writeProbe.attempted && report.writeProbe.removed === false) {
      lines.push(
        `WRITE CLEANUP: the probe translation could NOT be removed. Delete "${report.writeProbe.attemptedValue}" manually in Shopify Admin → Settings → Languages.`,
      );
    }
  } else if (report.writeProbe.skipReason) {
    lines.push(`WRITE: skipped — ${report.writeProbe.skipReason}`);
  }

  return lines;
}

// ── Route ──────────────────────────────────────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);
  return json({ ok: true, hint: "POST to run the menu translation probe. Pass writeTest=true for the write step." });
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);

  // Directly POST-reachable and it can write, so the gate lives here — same
  // class as the /api/ai handlers, the CSV exports and the redirect probe.
  const settings = await db.aISettings.findUnique({
    where: { shop: session.shop },
    select: { subscriptionPlan: true },
  });
  if (!meetsPlan((settings?.subscriptionPlan || "free") as never, "pro")) {
    return json({ error: "gated" }, { status: 403 });
  }

  const formData = await request.formData().catch(() => null);
  const wantsWriteTest = formData?.get("writeTest") === "true";

  const accessToken = (session as unknown as { accessToken?: string }).accessToken;
  if (!accessToken) {
    return json({ error: "No access token on the session — the per-version probe cannot run." }, { status: 500 });
  }

  // The SAME resolver the admin client is built from, never a second read of
  // the env var: an unsupported or typo'd value falls back there, and a probe
  // that queried the raw string would label its report with a version the app
  // does not actually talk to.
  const pinnedApiVersion = resolveApiVersionString();
  const versions = [...new Set([pinnedApiVersion, ...COMPARE_VERSIONS])];

  const report: MenuTranslationProbeReport = {
    generatedAt: new Date().toISOString(),
    shop: session.shop,
    pinnedApiVersion,
    primaryLocale: null,
    writeLocale: null,
    versions: [],
    writeProbe: { attempted: false },
    verdict: [],
  };

  logger.info("[MENU-TRANSLATION-PROBE] Starting", {
    context: "MenuTranslationProbe",
    shop: session.shop,
    versions: versions.join(","),
    writeTest: wantsWriteTest,
  });

  // Locales come from the pinned version — they are the same on every version
  // and one lookup is enough.
  const pinnedRunner = rawRunner(session.shop, accessToken, pinnedApiVersion);
  const localesResult = await pinnedRunner(LOCALES_QUERY);
  const locales = (localesResult.data as { shopLocales?: Array<{ locale: string; primary: boolean; published: boolean }> })?.shopLocales ?? [];
  report.primaryLocale = locales.find((l) => l.primary)?.locale ?? null;
  report.writeLocale = locales.find((l) => !l.primary && l.published)?.locale ?? null;

  for (const apiVersion of versions) {
    try {
      report.versions.push(await measureVersion(rawRunner(session.shop, accessToken, apiVersion), apiVersion));
    } catch (error) {
      report.versions.push({
        apiVersion,
        fatalError: error instanceof Error ? error.message : String(error),
        structures: [],
        nested: [],
        sweep: { total: 0, pages: 0, truncated: false, lookupByDepth: [], deepHits: [] },
        derivation: { checked: 0, aligned: 0, probes: [] },
      });
    }
  }

  // ── E. Optional write, on the newest version that produced a target ──────
  if (wantsWriteTest) {
    if (!report.writeLocale) {
      report.writeProbe = {
        attempted: false,
        skipReason: "This shop has no published non-primary language — there is nothing to translate INTO.",
      };
    } else {
      // Prefer a target proven by the derived GID (no title matching involved),
      // fall back to a unique sweep hit. Later versions first: if they differ,
      // the newer behaviour is the one worth measuring the write against.
      let chosen: { apiVersion: string; linkId: string; title: string; depth: number } | null = null;
      // Newest first — SORTED, not reversed. The list is [pinned, ...compare]
      // deduped, so with the pin already at the newest version reversing would
      // hand the write to the OLDEST one. YYYY-MM sorts correctly as a string.
      const newestFirst = [...report.versions].sort((a, b) => b.apiVersion.localeCompare(a.apiVersion));
      for (const version of newestFirst) {
        if (version.fatalError) continue;
        const derived = version.derivation.probes.find((p) => p.resolved && p.valueMatchesTitle);
        if (derived) {
          chosen = { apiVersion: version.apiVersion, linkId: derived.derivedLinkId, title: derived.title, depth: derived.depth };
          break;
        }
        const hit = version.sweep.deepHits[0];
        if (hit) {
          chosen = { apiVersion: version.apiVersion, linkId: hit.linkId, title: hit.title, depth: hit.depth };
          break;
        }
      }
      report.writeProbe = chosen
        ? await probeWrite(rawRunner(session.shop, accessToken, chosen.apiVersion), chosen.apiVersion, chosen, report.writeLocale)
        : {
            attempted: false,
            skipReason: "No sub-level Link resource was found to write to, so there is nothing to test the write against.",
          };
    }
  }

  report.verdict = buildVerdict(report);

  logger.info("[MENU-TRANSLATION-PROBE] Done", {
    context: "MenuTranslationProbe",
    shop: session.shop,
    versions: report.versions.length,
    wrote: report.writeProbe.attempted,
  });

  return json({ report });
}
