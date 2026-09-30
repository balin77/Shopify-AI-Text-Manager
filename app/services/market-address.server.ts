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
 * NOT MEASURED, and built accordingly:
 *  - WHICH mutation this API version offers. Two shapes are known: the newer
 *    `webPresenceCreate` + `marketUpdate(webPresencesToAdd)` and the older
 *    `marketWebPresenceCreate(marketId, webPresence)` (likewise for delete).
 *    The mutation type is INTROSPECTED once per process and the shape that
 *    exists is used; neither existing is reported as `notSupported`, never
 *    guessed. A schema-level refusal of the chosen document is reported in
 *    Shopify's words, and the input type is introspected and LOGGED beside it,
 *    so a wrong field name costs one look at the log, not a blind round.
 *  - Whether it worked is never read off an echo: the addresses are RE-READ
 *    and the change counts only when the market really carries (or no longer
 *    carries) a presence with that subfolder.
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
  /** Its OWN presence (subfolder or domain), or `null` = it uses the shop's shared address. */
  own: { presenceId: string; url: string | null; subfolderSuffix: string | null } | null;
}

export interface MarketAddresses {
  /** Active markets only — a draft market has no storefront to address. */
  markets: MarketAddress[];
  /** The shop's shared address (the presence no market claims), for the label. */
  sharedUrl: string | null;
}

// No comments or non-ASCII inside a #graphql document (CLAUDE.md).
const ADDRESS_PRESENCES = `#graphql
  query appMarketAddressPresences {
    webPresences(first: 25) {
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
        markets(first: 25) {
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
    markets(first: 50) {
      pageInfo {
        hasNextPage
      }
      nodes {
        id
        name
        status
        webPresences(first: 5) {
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
  markets?: { nodes?: Array<{ id?: string; name?: string; status?: string } | null> } | null;
};

async function json(admin: GraphqlClient, document: string, variables?: Record<string, unknown>) {
  const response = await admin.graphql(document, variables ? { variables } : undefined);
  return (await response.json()) as {
    errors?: Array<{ message?: string }>;
    data?: Record<string, unknown> | null;
  };
}

function rootUrlOf(p: PresenceNode): string | null {
  const roots = (p.rootUrls ?? []).filter(Boolean) as Array<{ locale?: string; url?: string }>;
  const def = p.defaultLocale?.locale?.toLowerCase();
  const hit = roots.find((r) => r.locale?.toLowerCase() === def) ?? roots[0];
  return typeof hit?.url === "string" ? hit.url : null;
}

/** `null` on any failed or truncated read — "cannot tell" is never "shared". */
export async function loadMarketAddresses(admin: GraphqlClient, shop?: string): Promise<MarketAddresses | null> {
  try {
    const [presBody, marketBody] = await Promise.all([json(admin, ADDRESS_PRESENCES), json(admin, ADDRESS_MARKETS)]);
    const pres = presBody.data?.webPresences as { pageInfo?: { hasNextPage?: boolean }; nodes?: PresenceNode[] } | undefined;
    const mkts = marketBody.data?.markets as
      | {
          pageInfo?: { hasNextPage?: boolean };
          nodes?: Array<{ id?: string; name?: string; status?: string; webPresences?: { nodes?: Array<{ id?: string } | null> } | null } | null>;
        }
      | undefined;
    if (
      presBody.errors?.length ||
      marketBody.errors?.length ||
      !Array.isArray(pres?.nodes) ||
      !Array.isArray(mkts?.nodes) ||
      pres?.pageInfo?.hasNextPage !== false ||
      mkts?.pageInfo?.hasNextPage !== false
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
    // The shared address: a presence no market claims (the shop domain).
    const shared = pres!.nodes!.find((p) => (p?.markets?.nodes ?? []).filter(Boolean).length === 0);
    const markets: MarketAddress[] = [];
    for (const m of mkts!.nodes!) {
      if (!m?.id || !m.name || m.status !== "ACTIVE") continue;
      // A market's own presence: named on the market, or listing the market.
      const ownId =
        (m.webPresences?.nodes ?? []).map((n) => n?.id).find((id): id is string => typeof id === "string") ??
        pres!.nodes!.find((p) => (p?.markets?.nodes ?? []).some((x) => x?.id === m.id))?.id;
      const own = ownId ? presById.get(ownId) : undefined;
      markets.push({
        marketId: m.id,
        name: m.name,
        own: own?.id
          ? { presenceId: own.id, url: rootUrlOf(own), subfolderSuffix: own.subfolderSuffix ?? null }
          : null,
      });
    }
    return { markets, sharedUrl: shared ? rootUrlOf(shared) : null };
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
        fields {
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
      const body = await json(admin, `query appInputShape($name: String!) { __type(name: $name) { inputFields { name } } }`, {
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
  if (!market) return { ok: false, error: "unknownMarket" };
  if (market.own) return { ok: false, error: "marketHasAddress" };
  const suffix = request.suffix.trim().toLowerCase();
  if (!/^[a-z]{2,8}$/.test(suffix)) return { ok: false, error: "invalidSuffix" };
  if (addresses.markets.some((m) => m.own?.subfolderSuffix?.toLowerCase() === suffix)) {
    return { ok: false, error: "suffixTaken" };
  }
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
      const attached = await json(admin, MARKET_ATTACH_PRESENCE, {
        id: request.marketId,
        input: { webPresencesToAdd: [presenceId] },
      });
      const attachError = firstError(attached, "marketUpdate");
      if (attachError) {
        if (attachError.schema) await logInputShapes(admin, shop, ["MarketUpdateInput"], attachError.message);
        // Never leave an orphan presence behind a refused attach.
        if (names.has("webPresenceDelete")) await json(admin, WEB_PRESENCE_DELETE, { id: presenceId }).catch(() => null);
        return { ok: false, error: attachError.message };
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
  const names = await availableMutations(admin);
  if (!names) return { ok: false, error: "schemaUnreadable" };
  try {
    if (names.has("webPresenceDelete")) {
      const body = await json(admin, WEB_PRESENCE_DELETE, { id: market.own.presenceId });
      const error = firstError(body, "webPresenceDelete");
      if (error) return { ok: false, error: error.message };
    } else if (names.has("marketWebPresenceDelete")) {
      const body = await json(admin, MARKET_WEB_PRESENCE_DELETE, { webPresenceId: market.own.presenceId });
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
  if (after.markets.find((m) => m.marketId === marketId)?.own) return { ok: false, error: "notConfirmed" };
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
}
