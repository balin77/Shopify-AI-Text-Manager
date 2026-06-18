/**
 * Known third-party app metafield namespaces.
 *
 * Used by the Metafields settings tab to categorize product metafield
 * definitions into "shop" (shop-owned, can be made translatable by us),
 * "contentpilot" (owned by this app) and "third-party" (owned by another
 * app — Shopify rejects `metafieldDefinitionUpdate` from us, so these can
 * only be displayed, not enabled, in Phase 1).
 *
 * This is a CURATED allowlist (decided design point 2 of the plan). It is
 * intentionally cheap to extend — adding an entry is a one-line PR. The map
 * is keyed by the metafield namespace prefix the app uses.
 */

export interface ThirdPartyAppInfo {
  /** Human-readable app name shown in the UI instead of the bare namespace. */
  displayName: string;
  /** Optional link to the app's translation docs. */
  helpUrl?: string;
}

/** Namespace this app owns. Definitions here are always patchable by us. */
export const CONTENTPILOT_NAMESPACE = "contentpilot";

/**
 * namespace prefix → app info. A definition is treated as third-party when its
 * namespace exactly matches a key here, or starts with `"<key>."`/`"<key>-"`
 * (some apps suffix their namespace, e.g. `judgeme.widget`).
 */
export const KNOWN_THIRD_PARTY_APPS: Record<string, ThirdPartyAppInfo> = {
  judgeme: { displayName: "Judge.me" },
  loox: { displayName: "Loox" },
  "yotpo-reviews": { displayName: "Yotpo Reviews" },
  yotpo: { displayName: "Yotpo" },
  pagefly: { displayName: "PageFly" },
  shogun: { displayName: "Shogun" },
  gempages: { displayName: "GemPages" },
  powr: { displayName: "POWR" },
  smile: { displayName: "Smile.io" },
  growave: { displayName: "Growave" },
  "bold-bundles": { displayName: "Bold Bundles" },
  klaviyo: { displayName: "Klaviyo" },
};

export type MetafieldOwnerCategory = "shop" | "third-party" | "contentpilot";

export interface MetafieldOwnerResult {
  category: MetafieldOwnerCategory;
  /** Present when category === "third-party" and the app is in the allowlist. */
  appName?: string;
}

/**
 * Categorize a metafield definition by its namespace.
 *
 * Order of precedence:
 *  1. Our own namespace → "contentpilot".
 *  2. Shopify app-reserved namespaces (`app--<id>--…`) → "third-party".
 *  3. Curated allowlist match → "third-party" (with displayName).
 *  4. Everything else → "shop" (shop-owned, patchable).
 */
export function categorizeMetafieldOwner(namespace: string): MetafieldOwnerResult {
  const ns = (namespace || "").toLowerCase();

  if (ns === CONTENTPILOT_NAMESPACE || ns.startsWith(`${CONTENTPILOT_NAMESPACE}.`)) {
    return { category: "contentpilot" };
  }

  // Shopify reserves the `app--<app-id>--<namespace>` prefix for app-owned
  // metafields. These are never patchable by another app.
  if (ns.startsWith("app--")) {
    return { category: "third-party" };
  }

  for (const [prefix, info] of Object.entries(KNOWN_THIRD_PARTY_APPS)) {
    if (ns === prefix || ns.startsWith(`${prefix}.`) || ns.startsWith(`${prefix}-`)) {
      return { category: "third-party", appName: info.displayName };
    }
  }

  return { category: "shop" };
}
