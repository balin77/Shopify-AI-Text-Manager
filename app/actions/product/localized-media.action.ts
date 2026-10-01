/**
 * "Images per language" on the product page (PLAN_LOCALIZED_IMAGES Phase 1b):
 * the card's load / set / remove, as ACTIONS of the product page.
 *
 * They used to be a route of their own. They are product-page actions now so
 * they inherit what every product action has: the page's plan gate
 * (`makeContentRouteAction`), the content rate limiter and the one door the
 * editor's plain-`fetch` callers use (`/api/content-editor-action`). The one
 * thing added here is the image manager's own gate (`variantImageManager`):
 * the card is part of that feature, and every action is directly POST-reachable.
 *
 * Nothing the client sends is trusted beyond naming the change --
 * services/localized-media/localized-media.server.ts re-derives every value
 * the storefront will read. `origin` is never accepted from the client: this
 * only ever writes "manual".
 *
 * The answers keep the shape the card maps: `{ ok, entries, media }` or
 * `{ ok: false, code }` with a status.
 */
import { data as json } from "react-router";
import { ShopifyContentService } from "../../../src/services/shopify-content.service";
import { getFormString } from "../../utils/form-data.utils";
import { canAccessVariantImageManagerInEnv, isProductionLocked, type Plan } from "../../utils/planUtils";
import { getCachedShopLocales } from "../../utils/shop-locales-cache.server";
import {
  readProductLocalizedMedia,
  removeLocalizedImage,
  setLocalizedMedia,
} from "../../services/localized-media/localized-media.server";
import type { ContentActionHandlerContext } from "../content/alt-text.action";

export const LOCALIZED_MEDIA_ACTIONS: ReadonlySet<string> = new Set([
  "localizedMediaLoad",
  "localizedMediaSet",
  "localizedMediaRemove",
]);

type Graphql = Parameters<typeof readProductLocalizedMedia>[0];

const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/;
// The ORIGINAL may be any of the three media kinds the card offers.
const MEDIA_GID = /^gid:\/\/shopify\/(MediaImage|Video|ExternalVideo)\/\d+$/;

export async function handleLocalizedMediaAction(
  ctx: Pick<ContentActionHandlerContext, "admin" | "session" | "contentConfig" | "aiSettings">,
  formData: FormData,
  action: string,
) {
  // Products only: the other pages share this handler but have no such card.
  if (ctx.contentConfig.resourceType !== "Product") {
    return json({ ok: false, code: "badRequest" }, { status: 400 });
  }
  const plan = (ctx.aiSettings?.subscriptionPlan || "free") as Plan;
  if (!canAccessVariantImageManagerInEnv(plan, !isProductionLocked())) {
    return json({ ok: false, code: "gated", success: false, error: "gated", actionType: action }, { status: 403 });
  }

  const productId = getFormString(formData, "productId");
  if (!PRODUCT_GID.test(productId)) return json({ ok: false, code: "badRequest" }, { status: 400 });
  const graphql = ctx.admin.graphql as unknown as Graphql;

  if (action === "localizedMediaLoad") {
    const result = await readProductLocalizedMedia(graphql, productId);
    if (!result.ok) return json(result, { status: result.code === "notFound" ? 404 : 502 });
    return json({ ok: true, entries: result.entries, media: result.media });
  }

  const sourceMediaId = getFormString(formData, "sourceMediaId");
  const locale = getFormString(formData, "locale");
  const marketId = getFormString(formData, "marketId");
  if (!MEDIA_GID.test(sourceMediaId) || !locale || locale.length > 20) {
    return json({ ok: false, code: "badRequest" }, { status: 400 });
  }

  if (action === "localizedMediaRemove") {
    const result = await removeLocalizedImage({ graphql, productId, sourceMediaId, locale, marketId });
    return json(result, { status: result.ok ? 200 : 422 });
  }

  const fileId = getFormString(formData, "fileId");
  const externalUrl = getFormString(formData, "externalUrl").slice(0, 2048);
  // Locale and market are validated against the shop, never against the
  // client's list. `getCachedShopLocales` answers [] on a failed lookup, which
  // the service reads as "cannot confirm" and refuses.
  const [shopLocales, marketsResult] = await Promise.all([
    getCachedShopLocales(ctx.admin, ctx.session.shop),
    new ShopifyContentService(ctx.admin as never).loadMarkets(),
  ]);
  const result = await setLocalizedMedia({
    graphql,
    productId,
    sourceMediaId,
    locale,
    marketId,
    fileId,
    externalUrl,
    origin: "manual",
    scope: {
      shopLocales: shopLocales.map((l) => ({ locale: l.locale, primary: l.primary })),
      activeMarketIds: marketsResult.markets.map((m) => m.id),
    },
  });
  return json(result, { status: result.ok ? 200 : 422 });
}
