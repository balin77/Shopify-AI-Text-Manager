/**
 * Turning what a merchant TYPES into the `shop` parameter Shopify's OAuth
 * entry needs.
 *
 * `/auth/login?shop=<domain>` redirects into `/auth`, which starts the install
 * — but only for a well-formed `<name>.myshopify.com`. Anything else fails
 * somewhere inside the Shopify SDK with a message the merchant cannot act on,
 * so the shapes people actually paste are normalized here instead:
 *
 *   my-shop                                    -> my-shop.myshopify.com
 *   my-shop.myshopify.com                      -> unchanged
 *   https://my-shop.myshopify.com/admin        -> my-shop.myshopify.com
 *   admin.shopify.com/store/my-shop            -> my-shop.myshopify.com
 *   https://admin.shopify.com/store/my-shop/…  -> my-shop.myshopify.com
 *
 * A CUSTOM domain is deliberately NOT guessed at: `myshop.com` is not
 * derivable from anything, and appending `.myshopify.com` to it would send the
 * merchant into an install for a store that does not exist. It is refused with
 * its own reason, so the page can say what to type instead.
 */

/** Shopify's own shape for a store handle, and the one `auth.$.tsx` validates against. */
const MYSHOPIFY_HOST = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/** A bare store handle: what the merchant sees in their own admin URL. */
const STORE_HANDLE = /^[a-z0-9][a-z0-9-]*$/;

export type ShopDomainResult =
  | { ok: true; shop: string }
  | { ok: false; reason: "empty" | "custom-domain" | "invalid" };

export function normalizeShopDomain(input: string): ShopDomainResult {
  const raw = input.trim().toLowerCase();
  if (!raw) return { ok: false, reason: "empty" };

  // Strip a protocol, then everything from the first slash, "?" or "#" —
  // people paste the whole admin URL far more often than a bare domain.
  let value = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");

  // `admin.shopify.com/store/<handle>` is the address bar of the NEW admin,
  // and the handle is the only part of it that matters.
  const adminMatch = /^admin\.shopify\.com\/store\/([a-z0-9][a-z0-9-]*)(?:[/?#]|$)/.exec(value);
  if (adminMatch) return { ok: true, shop: `${adminMatch[1]}.myshopify.com` };

  value = value.split(/[/?#]/)[0];
  // "empty" is reserved for a field the merchant actually left blank. Text
  // that merely carries no host ("/store/foo") is INVALID — telling someone to
  // enter an address over a field they can see text in explains nothing.
  if (!value) return { ok: false, reason: "invalid" };

  if (MYSHOPIFY_HOST.test(value)) return { ok: true, shop: value };

  if (STORE_HANDLE.test(value)) return { ok: true, shop: `${value}.myshopify.com` };

  // It has a dot and is not a myshopify host: a custom storefront domain. The
  // store handle cannot be derived from one, so this is a question, not a
  // failure — the page asks for the .myshopify.com address instead.
  if (value.includes(".")) return { ok: false, reason: "custom-domain" };

  return { ok: false, reason: "invalid" };
}
