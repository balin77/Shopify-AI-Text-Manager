/**
 * Checks the app/uninstalled webhook makes beyond the signature (pure).
 * Kept out of the route module: a route may only export its route API.
 */

/** "app/uninstalled" and "APP_UNINSTALLED" are the same topic. */
export function isUninstallTopic(topic: unknown): boolean {
  return typeof topic === "string" && topic.trim().toUpperCase().replace(/[/.]/g, "_") === "APP_UNINSTALLED";
}

/**
 * The payload names the shop it is about. It must be the shop the signed
 * header names; `domain` (the primary domain, possibly custom) is only read
 * when `myshopify_domain` is absent.
 */
export function payloadMatchesShop(payload: Record<string, unknown> | undefined, shop: string): boolean {
  const norm = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");
  const mine = norm(payload?.myshopify_domain);
  const wanted = shop.trim().toLowerCase();
  if (mine) return mine === wanted;
  const primary = norm(payload?.domain);
  return !!primary && primary === wanted;
}

/** Shopify's clock and ours may differ; only a clearly older delivery is skipped. */
export const CLOCK_SKEW_MS = 5_000;

/**
 * A late redelivery of an old uninstall (Shopify retries for up to 48 h) must
 * not delete the sessions of a reinstall that happened since. True when the
 * header says the event is OLDER than the shop's last sign-in. A missing or
 * unparseable header, or an unknown sign-in, keeps the current behaviour.
 */
export function isStaleUninstall(triggeredAtHeader: string | null, lastAuthAt: Date | null | undefined): boolean {
  if (!triggeredAtHeader || !lastAuthAt) return false;
  const triggered = Date.parse(triggeredAtHeader);
  if (!Number.isFinite(triggered)) return false;
  return triggered < lastAuthAt.getTime() - CLOCK_SKEW_MS;
}
