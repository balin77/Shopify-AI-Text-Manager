/**
 * Give a market its OWN address (a subfolder such as `/es-es`), or take it back
 * onto the shop's shared one — Settings → Shop-Sprachen → "Märkte und Adressen".
 *
 * Why this exists: Shopify keeps a shop's languages on the WEB PRESENCE, not on
 * the market (MEASURED on the owner's two shops, 2026-09-29/30 — see
 * shop-locale-publish.server.ts, `nameSharedPresence`). Markets without a
 * presence of their own share the shop domain's language list, so "Dutch only
 * for Spain" is impossible until Spain has its own subfolder or domain. The
 * owner asked for that step to live in the app, next to the language
 * checkboxes, instead of in a second admin.
 *
 * It is NOT a setting behind the save bar: it changes the storefront URLs of a
 * market (`/es/...` becomes `/es-es/...`), which is an act with SEO weight, so
 * both directions are their own confirmed actions — the removal behind the
 * type-the-name dialog like every destructive act in this app.
 *
 * MEASURED end to end (2026-09-30, API 2026-07, the market probe —
 * api.market-probe.tsx, Settings → Probes → Translation — on a DRAFT market of
 * its own): `webPresenceCreate(input: { subfolderSuffix, defaultLocale,
 * alternateLocales })` + `marketUpdate(id, input: { webPresencesToAdd })`
 * creates and attaches the subfolder, which reads back IMMEDIATELY on the
 * market (no lag seen) with the root url `/<defaultLocale>-<suffix>/` — the
 * preview the create modal shows; `webPresenceDelete(id)` removes it, again
 * visible at once. `marketWebPresenceCreate`/`…Delete` still exist but are
 * DEPRECATED; they stay as the fallback the introspection picks only where the
 * newer pair is missing. The introspection itself, the input-shape log on a
 * schema refusal and the RE-READ confirmation stay: measured on one version is
 * not measured on the next.
 *
 * MEASURED read shapes it relies on (2026-09-30, raw answers from the owner's
 * shop): top-level `webPresences { id subfolderSuffix domain { host }
 * rootUrls { locale url } markets { nodes { name status } } }` and
 * `markets { nodes { id name status webPresences { nodes { id } } } }`.
 */

import { logger } from "../utils/logger.server";

type GraphqlClient = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

export interface MarketAddress {
  marketId: string;
  name: string;
  /** `ACTIVE` or `DRAFT` — only an active market is offered an address. */
  status: string;
  /**
   * The shop's PRIMARY market: `true`/`false` where Shopify says so, `null`
   * where this API version has no such field (deprecated fields included). A
   * primary market is never offered an address of its own (it IS the root
   * storefront) nor a delete. With `null` both stay offered and SHOPIFY is the
   * guard — refusing them outright would switch the feature off on every
   * version without the field; a refusal travels back in Shopify's words.
   */
  primary: boolean | null;
  /**
   * Its OWN presence (subfolder or domain), or `null` = it uses the shop's
   * shared address. With several, the SUBFOLDER one — the only kind this tab
   * can remove. `sharedWith` names the OTHER markets on the same presence.
   */
  own: { presenceId: string; url: string | null; subfolderSuffix: string | null; sharedWith: string[] } | null;
}

export interface MarketAddresses {
  /** Active AND draft markets; only active ones are offered an address. */
  markets: MarketAddress[];
  /** The shop's shared address (the presence no market claims), for the label. */
  sharedUrl: string | null;
  /**
   * Every subfolder suffix ANY presence carries — including one no market
   * claims (an orphan) — so a new suffix is checked against all of them.
   */
  takenSuffixes: string[];
  /** Subfolder presences NO market uses — each blocks its suffix until removed. */
  orphans: Array<{ presenceId: string; url: string | null; subfolderSuffix: string }>;
}

// No comments or non-ASCII inside a #graphql document (CLAUDE.md).
const ADDRESS_PRESENCES = `#graphql
  query appMarketAddressPresences {
    webPresences(first: 10) {
      pageInfo {
        hasNextPage
      }
      nodes {
        id
        subfolderSuffix
        domain {
          host
        }
        rootUrls {
          locale
          url
        }
        defaultLocale {
          locale
        }
        markets(first: 10) {
          pageInfo {
            hasNextPage
          }
          nodes {
            id
            name
            status
          }
        }
      }
    }
  }`;

const ADDRESS_MARKETS = `#graphql
  query appMarketAddressMarkets {
    markets(first: 25) {
      pageInfo {
        hasNextPage
      }
      nodes {
        id
        name
        status
        webPresences(first: 3) {
          pageInfo {
            hasNextPage
          }
          nodes {
            id
          }
        }
      }
    }
  }`;

type PresenceNode = {
  id?: string;
  subfolderSuffix?: string | null;
  domain?: { host?: string } | null;
  rootUrls?: Array<{ locale?: string; url?: string } | null> | null;
  defaultLocale?: { locale?: string } | null;
  markets?: {
    pageInfo?: { hasNextPage?: boolean };
    nodes?: Array<{ id?: string; name?: string; status?: string } | null>;
  } | null;
};

type Body = { errors?: Array<{ message?: string }>; data?: Record<string, unknown> | null };

/**
 * The app's `admin.graphql` THROWS (`GraphqlQueryError`) when Shopify answers
 * HTTP 200 with a top-level `errors` array — a schema-level refusal never
 * comes back as a body. Such a throw is turned back INTO the body it carries,
 * so the callers' `errors` branches (and the input-shape log beside them) are
 * reachable at all. Anything else — throttling, network — still throws.
 */
async function json(admin: GraphqlClient, document: string, variables?: Record<string, unknown>): Promise<Body> {
  try {
    const response = await admin.graphql(document, variables ? { variables } : undefined);
    return (await response.json()) as Body;
  } catch (error: unknown) {
    const graphQLErrors = (error as { body?: { errors?: { graphQLErrors?: unknown } } } | null)?.body?.errors
      ?.graphQLErrors;
    if (Array.isArray(graphQLErrors) && graphQLErrors.length > 0) {
      return {
        errors: graphQLErrors.map((e) => ({ message: (e as { message?: string } | null)?.message ?? "GraphQL error" })),
        data: null,
      };
    }
    throw error;
  }
}

function rootUrlOf(p: PresenceNode): string | null {
  const roots = (p.rootUrls ?? []).filter(Boolean) as Array<{ locale?: string; url?: string }>;
  const def = p.defaultLocale?.locale?.toLowerCase();
  const hit = roots.find((r) => r.locale?.toLowerCase() === def) ?? roots[0];
  return typeof hit?.url === "string" ? hit.url : null;
}

// `Market.primary` is MEASURED on 2026-07 (market probe, 2026-09-30):
// `Boolean!`, DEPRECATED, and it answers — the owner's primary market reads
// `true`. It may vanish in a later version, and an unknown field fails the
// WHOLE document — so it is introspected once and read in a document of its
// own that the address read never depends on. Every
// introspection here asks for DEPRECATED entries too: `primary` belongs to the
// older markets model, a deprecated field still answers, and the default
// `fields` list silently leaves it out — which would read as "no such field"
// and switch this guard off on exactly the versions that still carry it.
const MARKET_FIELDS = `#graphql
  query appMarketFields {
    __type(name: "Market") {
      fields(includeDeprecated: true) {
        name
      }
    }
  }`;

const MARKET_PRIMARY = `#graphql
  query appMarketPrimary {
    markets(first: 50) {
      nodes {
        id
        primary
      }
    }
  }`;

let marketHasPrimary: boolean | null = null;

/** `Map<marketId, primary>`, or `null` = this version cannot tell. Never throws. */
async function loadPrimaryFlags(admin: GraphqlClient): Promise<Map<string, boolean> | null> {
  try {
    if (marketHasPrimary === null) {
      const body = await json(admin, MARKET_FIELDS);
      const fields = (body.data?.__type as { fields?: Array<{ name?: string }> } | null)?.fields;
      if (!Array.isArray(fields)) return null;
      marketHasPrimary = fields.some((f) => f?.name === "primary");
    }
    if (!marketHasPrimary) return null;
    const body = await json(admin, MARKET_PRIMARY);
    const nodes = (body.data?.markets as { nodes?: Array<{ id?: string; primary?: unknown } | null> } | undefined)?.nodes;
    if (!Array.isArray(nodes)) return null;
    const flags = new Map<string, boolean>();
    for (const n of nodes) if (n?.id && typeof n.primary === "boolean") flags.set(n.id, n.primary);
    return flags;
  } catch {
    return null;
  }
}

/** `null` on any failed or truncated read — "cannot tell" is never "shared". */
export async function loadMarketAddresses(admin: GraphqlClient, shop?: string): Promise<MarketAddresses | null> {
  try {
    const [presBody, marketBody, primaryFlags] = await Promise.all([
      json(admin, ADDRESS_PRESENCES),
      json(admin, ADDRESS_MARKETS),
      loadPrimaryFlags(admin),
    ]);
    const pres = presBody.data?.webPresences as { pageInfo?: { hasNextPage?: boolean }; nodes?: PresenceNode[] } | undefined;
    const mkts = marketBody.data?.markets as
      | {
          pageInfo?: { hasNextPage?: boolean };
          nodes?: Array<{
            id?: string;
            name?: string;
            status?: string;
            webPresences?: { pageInfo?: { hasNextPage?: boolean }; nodes?: Array<{ id?: string } | null> } | null;
          } | null>;
        }
      | undefined;
    if (
      presBody.errors?.length ||
      marketBody.errors?.length ||
      !Array.isArray(pres?.nodes) ||
      !Array.isArray(mkts?.nodes) ||
      pres?.pageInfo?.hasNextPage !== false ||
      mkts?.pageInfo?.hasNextPage !== false ||
      // The NESTED lists decide which markets share a presence — the removal
      // guard reads them — so a truncated one is "cannot tell" too.
      pres!.nodes!.some((p) => p?.markets?.pageInfo?.hasNextPage !== false) ||
      mkts!.nodes!.some((m) => m?.webPresences?.pageInfo?.hasNextPage !== false)
    ) {
      logger.warn("[MarketAddress] Addresses could not be read", {
        context: "MarketAddress",
        shop,
        errors: [...(presBody.errors ?? []), ...(marketBody.errors ?? [])].map((e) => e?.message),
      });
      return null;
    }
    const presById = new Map<string, PresenceNode>();
    for (const p of pres!.nodes!) if (p?.id) presById.set(p.id, p);
    // Which markets use which presence — from BOTH sides, because on the
    // measured shops one side answers empty where the other does not.
    const marketIdsOf = new Map<string, Set<string>>();
    const link = (presenceId: string, marketId: string) => {
      if (!presById.has(presenceId)) return;
      const set = marketIdsOf.get(presenceId) ?? new Set<string>();
      set.add(marketId);
      marketIdsOf.set(presenceId, set);
    };
    for (const p of pres!.nodes!) {
      for (const x of p?.markets?.nodes ?? []) if (p?.id && x?.id) link(p.id, x.id);
    }
    for (const m of mkts!.nodes!) {
      for (const n of m?.webPresences?.nodes ?? []) if (m?.id && n?.id) link(n.id, m.id);
    }
    const nameOf = new Map<string, string>();
    for (const m of mkts!.nodes!) if (m?.id && m.name) nameOf.set(m.id, m.name);
    // The shared address: the presence no market claims AND that is not a
    // subfolder — an unclaimed subfolder is an orphan, never the shop domain.
    // Older-model shops link the root domain presence to the primary market,
    // so with nothing unclaimed the first non-subfolder presence is the label.
    const shared =
      pres!.nodes!.find((p) => p?.id && !marketIdsOf.get(p.id)?.size && !p.subfolderSuffix) ??
      pres!.nodes!.find((p) => p?.id && !p.subfolderSuffix);
    // A subfolder no market claims: left behind by an interrupted write (or a
    // deleted market). It blocks its suffix, so it is listed and removable.
    const orphans = pres!.nodes!
      .filter((p) => p?.id && p.subfolderSuffix && !marketIdsOf.get(p.id)?.size)
      .map((p) => ({ presenceId: p.id!, url: rootUrlOf(p), subfolderSuffix: p.subfolderSuffix! }));
    const markets: MarketAddress[] = [];
    for (const m of mkts!.nodes!) {
      if (!m?.id || !m.name || (m.status !== "ACTIVE" && m.status !== "DRAFT")) continue;
      const mine = [...marketIdsOf.entries()].filter(([, ids]) => ids.has(m.id!)).map(([id]) => presById.get(id)!);
      const own = mine.find((p) => p.subfolderSuffix) ?? mine[0];
      markets.push({
        marketId: m.id,
        name: m.name,
        status: m.status,
        primary: primaryFlags ? (primaryFlags.get(m.id) ?? null) : null,
        own: own?.id
          ? {
              presenceId: own.id,
              url: rootUrlOf(own),
              subfolderSuffix: own.subfolderSuffix ?? null,
              sharedWith: [...(marketIdsOf.get(own.id) ?? [])]
                .filter((id) => id !== m.id)
                .map((id) => nameOf.get(id) ?? id),
            }
          : null,
      });
    }
    const takenSuffixes = pres!.nodes!.map((p) => p?.subfolderSuffix?.toLowerCase()).filter((x): x is string => !!x);
    return { markets, sharedUrl: shared ? rootUrlOf(shared) : null, takenSuffixes, orphans };
  } catch (error: unknown) {
    logger.warn("[MarketAddress] Addresses could not be read", {
      context: "MarketAddress",
      shop,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Which mutations this API version has
// ---------------------------------------------------------------------------

const MUTATION_NAMES = `#graphql
  query appMutationNames {
    __schema {
      mutationType {
        fields(includeDeprecated: true) {
          name
        }
      }
    }
  }`;

let mutationNames: Set<string> | null = null;

async function availableMutations(admin: GraphqlClient): Promise<Set<string> | null> {
  if (mutationNames) return mutationNames;
  try {
    const body = await json(admin, MUTATION_NAMES);
    const fields = (body.data?.__schema as { mutationType?: { fields?: Array<{ name?: string }> } } | undefined)
      ?.mutationType?.fields;
    if (!Array.isArray(fields)) return null;
    mutationNames = new Set(fields.map((f) => f?.name).filter((n): n is string => typeof n === "string"));
    return mutationNames;
  } catch {
    return null;
  }
}

/** On a schema-level refusal: log what the input types really accept. */
async function logInputShapes(admin: GraphqlClient, shop: string | undefined, types: string[], refusal: string) {
  const shapes: Record<string, unknown> = {};
  for (const name of types) {
    try {
      const body = await json(admin, `query appInputShape($name: String!) { __type(name: $name) { inputFields(includeDeprecated: true) { name } } }`, {
        name,
      });
      shapes[name] = ((body.data?.__type as { inputFields?: Array<{ name?: string }> } | null)?.inputFields ?? []).map(
        (f) => f?.name,
      );
    } catch (error: unknown) {
      shapes[name] = `threw: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  logger.warn("[MarketAddress] Shopify refused the address write; input shapes", {
    context: "MarketAddress",
    shop,
    refusal,
    shapes,
  });
}

type WriteOutcome = { ok: true } | { ok: false; error: string };

function firstError(body: { errors?: Array<{ message?: string }>; data?: Record<string, unknown> | null }, field: string) {
  if (body.errors?.length) return { schema: true, message: body.errors[0]?.message || "GraphQL error" };
  const payload = body.data?.[field] as { userErrors?: Array<{ message?: string }> } | null | undefined;
  const userErrors = payload?.userErrors ?? [];
  if (userErrors.length > 0) return { schema: false, message: userErrors.map((e) => e.message).join("; ") };
  return null;
}

// ---------------------------------------------------------------------------
// Validation (pure)
// ---------------------------------------------------------------------------

export interface SubfolderRequest {
  marketId: string;
  suffix: string;
  defaultLocale: string;
  alternateLocales: string[];
}

/**
 * The request replayed over what is true NOW: the market must be active and on
 * the shared address, the suffix a short lowercase code no other presence
 * uses, the languages shop locales, the default not repeated as an alternate.
 */
export function validateSubfolderRequest(
  request: SubfolderRequest,
  addresses: MarketAddresses,
  shopLocales: readonly string[],
): { ok: true; request: SubfolderRequest } | { ok: false; error: string } {
  const market = addresses.markets.find((m) => m.marketId === request.marketId);
  if (!market || market.status !== "ACTIVE") return { ok: false, error: "unknownMarket" };
  // The primary market IS the root storefront; a subfolder would move it.
  if (market.primary === true) return { ok: false, error: "primaryMarket" };
  if (market.own) return { ok: false, error: "marketHasAddress" };
  const suffix = request.suffix.trim().toLowerCase();
  if (!/^[a-z]{2,8}$/.test(suffix)) return { ok: false, error: "invalidSuffix" };
  if (addresses.takenSuffixes.includes(suffix)) return { ok: false, error: "suffixTaken" };
  const known = new Set(shopLocales.map((l) => l.toLowerCase()));
  const defaultLocale = request.defaultLocale.trim();
  if (!known.has(defaultLocale.toLowerCase())) return { ok: false, error: "unknownLocale" };
  const alternateLocales = [...new Set(request.alternateLocales.map((l) => l.trim()))].filter(
    (l) => l.toLowerCase() !== defaultLocale.toLowerCase(),
  );
  if (alternateLocales.some((l) => !known.has(l.toLowerCase()))) return { ok: false, error: "unknownLocale" };
  return { ok: true, request: { marketId: request.marketId, suffix, defaultLocale, alternateLocales } };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

const WEB_PRESENCE_CREATE = `#graphql
  mutation appWebPresenceCreate($input: WebPresenceCreateInput!) {
    webPresenceCreate(input: $input) {
      webPresence {
        id
      }
      userErrors {
        field
        message
      }
    }
  }`;

const MARKET_ATTACH_PRESENCE = `#graphql
  mutation appMarketAttachPresence($id: ID!, $input: MarketUpdateInput!) {
    marketUpdate(id: $id, input: $input) {
      market {
        id
      }
      userErrors {
        field
        message
      }
    }
  }`;

const MARKET_WEB_PRESENCE_CREATE = `#graphql
  mutation appMarketWebPresenceCreate($marketId: ID!, $webPresence: MarketWebPresenceCreateInput!) {
    marketWebPresenceCreate(marketId: $marketId, webPresence: $webPresence) {
      market {
        id
      }
      userErrors {
        field
        message
      }
    }
  }`;

const WEB_PRESENCE_DELETE = `#graphql
  mutation appWebPresenceDelete($id: ID!) {
    webPresenceDelete(id: $id) {
      userErrors {
        field
        message
      }
    }
  }`;

const MARKET_WEB_PRESENCE_DELETE = `#graphql
  mutation appMarketWebPresenceDelete($webPresenceId: ID!) {
    marketWebPresenceDelete(webPresenceId: $webPresenceId) {
      userErrors {
        field
        message
      }
    }
  }`;

export async function createMarketSubfolder(
  admin: GraphqlClient,
  shop: string,
  request: SubfolderRequest,
): Promise<WriteOutcome> {
  const names = await availableMutations(admin);
  if (!names) return { ok: false, error: "schemaUnreadable" };
  const presenceInput = {
    subfolderSuffix: request.suffix,
    defaultLocale: request.defaultLocale,
    alternateLocales: request.alternateLocales,
  };
  try {
    if (names.has("webPresenceCreate") && names.has("marketUpdate")) {
      const created = await json(admin, WEB_PRESENCE_CREATE, { input: presenceInput });
      const createError = firstError(created, "webPresenceCreate");
      if (createError) {
        if (createError.schema) await logInputShapes(admin, shop, ["WebPresenceCreateInput"], createError.message);
        return { ok: false, error: createError.message };
      }
      const presenceId = (created.data?.webPresenceCreate as { webPresence?: { id?: string } | null } | null)?.webPresence?.id;
      if (!presenceId) return { ok: false, error: "notConfirmed" };
      // From here a presence EXISTS: every attach outcome that is not an
      // echoed market takes it away again, or the orphan blocks the suffix
      // for every retry and nothing in this tab could remove it.
      let attachFailure: string | null = null;
      try {
        const attached = await json(admin, MARKET_ATTACH_PRESENCE, {
          id: request.marketId,
          input: { webPresencesToAdd: [presenceId] },
        });
        const attachError = firstError(attached, "marketUpdate");
        if (attachError) {
          if (attachError.schema) await logInputShapes(admin, shop, ["MarketUpdateInput"], attachError.message);
          attachFailure = attachError.message;
        } else if (!(attached.data?.marketUpdate as { market?: { id?: string } | null } | null)?.market?.id) {
          attachFailure = "notConfirmed";
        }
      } catch (error: unknown) {
        attachFailure = error instanceof Error ? error.message : String(error);
      }
      if (attachFailure) {
        await deleteOrphanPresence(admin, shop, names, presenceId);
        return { ok: false, error: attachFailure };
      }
    } else if (names.has("marketWebPresenceCreate")) {
      const created = await json(admin, MARKET_WEB_PRESENCE_CREATE, {
        marketId: request.marketId,
        webPresence: presenceInput,
      });
      const createError = firstError(created, "marketWebPresenceCreate");
      if (createError) {
        if (createError.schema) await logInputShapes(admin, shop, ["MarketWebPresenceCreateInput"], createError.message);
        return { ok: false, error: createError.message };
      }
    } else {
      return { ok: false, error: "notSupported" };
    }
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  // Confirmed only by a fresh read: the market carries a presence with it.
  const after = await loadMarketAddresses(admin, shop);
  if (!after) return { ok: false, error: "unverified" };
  const market = after.markets.find((m) => m.marketId === request.marketId);
  if (market?.own?.subfolderSuffix?.toLowerCase() !== request.suffix) return { ok: false, error: "notConfirmed" };
  await clearLocaleCache(shop);
  return { ok: true };
}

/** Take a just-created, unattached presence away again — and SAY if that failed. */
async function deleteOrphanPresence(admin: GraphqlClient, shop: string, names: Set<string>, presenceId: string) {
  let outcome = "deleted";
  try {
    if (!names.has("webPresenceDelete")) outcome = "no webPresenceDelete in this API version";
    else {
      const error = firstError(await json(admin, WEB_PRESENCE_DELETE, { id: presenceId }), "webPresenceDelete");
      if (error) outcome = error.message;
    }
  } catch (error: unknown) {
    outcome = error instanceof Error ? error.message : String(error);
  }
  const meta = { context: "MarketAddress", shop, presenceId, outcome };
  if (outcome === "deleted") logger.info("[MarketAddress] Removed the unattached presence after a failed attach", meta);
  else logger.warn("[MarketAddress] An unattached presence could NOT be removed after a failed attach", meta);
}

export async function removeMarketAddress(
  admin: GraphqlClient,
  shop: string,
  marketId: string,
): Promise<WriteOutcome> {
  const before = await loadMarketAddresses(admin, shop);
  if (!before) return { ok: false, error: "unverified" };
  const market = before.markets.find((m) => m.marketId === marketId);
  if (!market) return { ok: false, error: "unknownMarket" };
  // Only a SUBFOLDER presence is removed here: a domain presence carries a
  // domain the merchant connected, and the shared shop address must never go.
  if (!market.own?.subfolderSuffix) return { ok: false, error: "notSubfolder" };
  // A presence other markets use too would take THEIR address with it.
  if (market.own.sharedWith.length > 0) return { ok: false, error: "presenceShared" };
  const presenceId = market.own.presenceId;
  const names = await availableMutations(admin);
  if (!names) return { ok: false, error: "schemaUnreadable" };
  try {
    if (names.has("webPresenceDelete")) {
      const body = await json(admin, WEB_PRESENCE_DELETE, { id: presenceId });
      const error = firstError(body, "webPresenceDelete");
      if (error) return { ok: false, error: error.message };
    } else if (names.has("marketWebPresenceDelete")) {
      const body = await json(admin, MARKET_WEB_PRESENCE_DELETE, { webPresenceId: presenceId });
      const error = firstError(body, "marketWebPresenceDelete");
      if (error) return { ok: false, error: error.message };
    } else {
      return { ok: false, error: "notSupported" };
    }
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const after = await loadMarketAddresses(admin, shop);
  if (!after) return { ok: false, error: "unverified" };
  // Confirmed when THAT subfolder is gone from the shop's presences (the
  // market may legitimately keep another one, e.g. a domain).
  const suffix = market.own.subfolderSuffix.toLowerCase();
  if (after.takenSuffixes.includes(suffix) || after.markets.some((m) => m.own?.presenceId === presenceId)) {
    return { ok: false, error: "notConfirmed" };
  }
  await clearLocaleCache(shop);
  return { ok: true };
}

/** Remove a subfolder presence NO market uses (see `orphans`), confirmed by a re-read. */
export async function removeOrphanAddress(admin: GraphqlClient, shop: string, presenceId: string): Promise<WriteOutcome> {
  const before = await loadMarketAddresses(admin, shop);
  if (!before) return { ok: false, error: "unverified" };
  const orphan = before.orphans.find((o) => o.presenceId === presenceId);
  // Only an UNCLAIMED subfolder — never a presence some market still serves.
  if (!orphan) return { ok: false, error: "notOrphan" };
  const names = await availableMutations(admin);
  if (!names) return { ok: false, error: "schemaUnreadable" };
  try {
    if (names.has("webPresenceDelete")) {
      const error = firstError(await json(admin, WEB_PRESENCE_DELETE, { id: presenceId }), "webPresenceDelete");
      if (error) return { ok: false, error: error.message };
    } else if (names.has("marketWebPresenceDelete")) {
      const error = firstError(
        await json(admin, MARKET_WEB_PRESENCE_DELETE, { webPresenceId: presenceId }),
        "marketWebPresenceDelete",
      );
      if (error) return { ok: false, error: error.message };
    } else {
      return { ok: false, error: "notSupported" };
    }
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const after = await loadMarketAddresses(admin, shop);
  if (!after) return { ok: false, error: "unverified" };
  if (after.takenSuffixes.includes(orphan.subfolderSuffix.toLowerCase())) return { ok: false, error: "notConfirmed" };
  await clearLocaleCache(shop);
  return { ok: true };
}

async function clearLocaleCache(shop: string) {
  const { clearShopLocalesCache } = await import("../utils/shop-locales-cache.server");
  clearShopLocalesCache(shop);
}

/** Test seam: forget the introspected mutation names. */
export function __resetMarketAddressCache() {
  mutationNames = null;
  marketHasPrimary = null;
}

// ---------------------------------------------------------------------------
// Adding and deleting a MARKET
// ---------------------------------------------------------------------------
//
// The owner asked for markets themselves to be added and removed here too.
// A new market is created as a DRAFT wherever the input lets us say so: an
// ACTIVE market decides where the shop sells, and one whose shipping, prices
// and duties nobody has looked at is not something to switch on from a
// language settings tab — the merchant activates it in Shopify after checking.
// MEASURED (market probe, 2026-09-30, API 2026-07): `MarketCreateInput` takes
// `conditions: { regionsCondition: { regions: [{ countryCode }] } }` and
// `status: DRAFT` (`regions` and `enabled` are there too, deprecated), and the
// market reads back as DRAFT at once. `marketDelete` echoes `deletedId` and
// takes the market's own SUBFOLDER presence WITH it — measured with one
// attached. The input is still introspected (a later version may move it), a
// create is confirmed by a fresh read, a delete by its echoed id AND the
// market's absence from a fresh read.

const MARKET_CREATE = `#graphql
  mutation appMarketCreate($input: MarketCreateInput!) {
    marketCreate(input: $input) {
      market {
        id
      }
      userErrors {
        field
        message
      }
    }
  }`;

const MARKET_DELETE = `#graphql
  mutation appMarketDelete($id: ID!) {
    marketDelete(id: $id) {
      deletedId
      userErrors {
        field
        message
      }
    }
  }`;

async function inputFieldNames(admin: GraphqlClient, type: string): Promise<Set<string> | null> {
  try {
    const body = await json(admin, `query appInputShape($name: String!) { __type(name: $name) { inputFields(includeDeprecated: true) { name } } }`, {
      name: type,
    });
    const fields = (body.data?.__type as { inputFields?: Array<{ name?: string }> } | null)?.inputFields;
    if (!Array.isArray(fields)) return null;
    return new Set(fields.map((f) => f?.name).filter((n): n is string => typeof n === "string"));
  } catch {
    return null;
  }
}

export function validateMarketRequest(
  request: { name: string; countries: string[] },
  addresses: MarketAddresses,
): { ok: true; name: string; countries: string[] } | { ok: false; error: string } {
  const name = request.name.trim();
  if (name.length === 0 || name.length > 60) return { ok: false, error: "invalidMarketName" };
  if (addresses.markets.some((m) => m.name.trim().toLowerCase() === name.toLowerCase())) {
    return { ok: false, error: "marketNameTaken" };
  }
  const countries = [...new Set(request.countries.map((c) => c.trim().toUpperCase()))];
  if (countries.length === 0 || countries.some((c) => !/^[A-Z]{2}$/.test(c))) return { ok: false, error: "invalidCountries" };
  return { ok: true, name, countries };
}

export async function createMarket(
  admin: GraphqlClient,
  shop: string,
  request: { name: string; countries: string[] },
): Promise<{ ok: true; marketId: string } | { ok: false; error: string; marketId?: string }> {
  const names = await availableMutations(admin);
  if (!names) return { ok: false, error: "schemaUnreadable" };
  if (!names.has("marketCreate")) return { ok: false, error: "notSupported" };
  const fields = await inputFieldNames(admin, "MarketCreateInput");
  if (!fields) return { ok: false, error: "schemaUnreadable" };
  const regions = request.countries.map((countryCode) => ({ countryCode }));
  const input: Record<string, unknown> = { name: request.name };
  if (fields.has("conditions")) input.conditions = { regionsCondition: { regions } };
  else if (fields.has("regions")) input.regions = regions;
  else return { ok: false, error: "notSupported" };
  // No way to SAY draft is no market at all: Shopify's default would decide,
  // and an active market sells into those countries the moment it exists.
  if (fields.has("status")) input.status = "DRAFT";
  else if (fields.has("enabled")) input.enabled = false;
  else return { ok: false, error: "notSupported" };
  let marketId: string | undefined;
  try {
    const body = await json(admin, MARKET_CREATE, { input });
    const error = firstError(body, "marketCreate");
    if (error) {
      if (error.schema) await logInputShapes(admin, shop, ["MarketCreateInput", "MarketConditionsInput"], error.message);
      return { ok: false, error: error.message };
    }
    marketId = (body.data?.marketCreate as { market?: { id?: string } | null } | null)?.market?.id;
    if (!marketId) return { ok: false, error: "notConfirmed" };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const after = await loadMarketAddresses(admin, shop);
  if (!after) return { ok: false, error: "unverified" };
  const created = after.markets.find((m) => m.marketId === marketId);
  if (!created) return { ok: false, error: "notConfirmed" };
  // Created, but not as a draft: say so — the merchant must look at it NOW.
  if (created.status !== "DRAFT") return { ok: false, error: "createdNotDraft", marketId };
  return { ok: true, marketId };
}

export async function deleteMarket(admin: GraphqlClient, shop: string, marketId: string): Promise<WriteOutcome> {
  const before = await loadMarketAddresses(admin, shop);
  if (!before) return { ok: false, error: "unverified" };
  const market = before.markets.find((m) => m.marketId === marketId);
  if (!market) return { ok: false, error: "unknownMarket" };
  if (market.primary === true) return { ok: false, error: "primaryMarket" };
  // A market's own unshared SUBFOLDER goes with it (measured). A DOMAIN
  // presence or one other markets use too is unmeasured — deleting the market
  // could take another market's address along — so those go first, in Shopify.
  if (market.own && (!market.own.subfolderSuffix || market.own.sharedWith.length > 0)) {
    return { ok: false, error: "removeAddressFirst" };
  }
  const names = await availableMutations(admin);
  if (!names) return { ok: false, error: "schemaUnreadable" };
  if (!names.has("marketDelete")) return { ok: false, error: "notSupported" };
  try {
    // Where `primary` is unreadable Shopify is the guard: it refuses deleting
    // the primary market, and its words travel back.
    const body = await json(admin, MARKET_DELETE, { id: marketId });
    const error = firstError(body, "marketDelete");
    if (error) return { ok: false, error: error.message };
    const deletedId = (body.data?.marketDelete as { deletedId?: string | null } | null)?.deletedId;
    if (deletedId !== marketId) return { ok: false, error: "notConfirmed" };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const after = await loadMarketAddresses(admin, shop);
  if (!after) return { ok: false, error: "unverified" };
  if (after.markets.some((m) => m.marketId === marketId)) return { ok: false, error: "notConfirmed" };
  // Measured to go with the market; should a version ever leave it behind,
  // it would block its suffix — so an orphan it left is removed here, and a
  // failure there is only logged: the market itself is confirmed gone.
  const ownId = market.own?.presenceId;
  if (ownId && after.orphans.some((o) => o.presenceId === ownId)) {
    const cleaned = await removeOrphanAddress(admin, shop, ownId);
    if (!cleaned.ok) {
      logger.warn("[MarketAddress] The deleted market's address stayed behind", {
        context: "MarketAddress",
        shop,
        presenceId: ownId,
        error: cleaned.error,
      });
    }
  }
  await clearLocaleCache(shop);
  return { ok: true };
}
