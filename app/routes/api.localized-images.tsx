/**
 * /api/localized-images — "Images per language" for one product
 * (PLAN_LOCALIZED_IMAGES Phase 1b).
 *
 *   GET  ?productId=<GID>   → { entries, media }   the stored replacements + the product's images, LIVE
 *   POST { intent: "set", productId, sourceMediaId, locale, marketId, fileId }
 *   POST { intent: "remove", productId, sourceMediaId, locale, marketId }
 *
 * Directly reachable, so the plan gate lives HERE (the image manager's own
 * gate: `variantImageManager`), and nothing the client sends is trusted beyond
 * naming the change — services/localized-media/localized-media.server.ts
 * re-derives every value the storefront will read. `origin` is not accepted
 * from the client: this route only ever writes "manual".
 */
import { data as json, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { canAccessVariantImageManagerInEnv, isProductionLocked, type Plan } from "../utils/planUtils";
import { getCachedShopLocales } from "../utils/shop-locales-cache.server";
import { ShopifyContentService } from "../../src/services/shopify-content.service";
import {
  readProductLocalizedMedia,
  removeLocalizedImage,
  setLocalizedImage,
} from "../services/localized-media/localized-media.server";

type Graphql = Parameters<typeof readProductLocalizedMedia>[0];

const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/;
const MEDIA_GID = /^gid:\/\/shopify\/MediaImage\/\d+$/;

async function gate(shop: string): Promise<boolean> {
  const settings = await db.aISettings.findUnique({ where: { shop }, select: { subscriptionPlan: true } });
  return canAccessVariantImageManagerInEnv((settings?.subscriptionPlan || "free") as Plan, !isProductionLocked());
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  if (!(await gate(session.shop))) return json({ ok: false, code: "gated" }, { status: 403 });
  const productId = new URL(request.url).searchParams.get("productId") ?? "";
  if (!PRODUCT_GID.test(productId)) return json({ ok: false, code: "badRequest" }, { status: 400 });
  const result = await readProductLocalizedMedia(admin.graphql as unknown as Graphql, productId);
  if (!result.ok) return json(result, { status: result.code === "notFound" ? 404 : 502 });
  return json({ ok: true, entries: result.entries, media: result.media });
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  if (!(await gate(session.shop))) return json({ ok: false, code: "gated" }, { status: 403 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const intent = String(body?.intent ?? "");
  const productId = String(body?.productId ?? "");
  const sourceMediaId = String(body?.sourceMediaId ?? "");
  const locale = String(body?.locale ?? "");
  const marketId = String(body?.marketId ?? "");
  if (!PRODUCT_GID.test(productId) || !MEDIA_GID.test(sourceMediaId) || !locale || locale.length > 20) {
    return json({ ok: false, code: "badRequest" }, { status: 400 });
  }
  const graphql = admin.graphql as unknown as Graphql;

  if (intent === "remove") {
    const result = await removeLocalizedImage({ graphql, productId, sourceMediaId, locale, marketId });
    return json(result, { status: result.ok ? 200 : 422 });
  }
  if (intent !== "set") return json({ ok: false, code: "badRequest" }, { status: 400 });

  const fileId = String(body?.fileId ?? "");
  // Locale and market are validated against the shop, never against the
  // client's list. `getCachedShopLocales` answers [] on a failed lookup, which
  // the service reads as "cannot confirm" and refuses.
  const [shopLocales, marketsResult] = await Promise.all([
    getCachedShopLocales(admin, session.shop),
    new ShopifyContentService(admin as never).loadMarkets(),
  ]);
  const result = await setLocalizedImage({
    graphql,
    productId,
    sourceMediaId,
    locale,
    marketId,
    fileId,
    origin: "manual",
    scope: {
      shopLocales: shopLocales.map((l) => ({ locale: l.locale, primary: l.primary })),
      activeMarketIds: marketsResult.markets.map((m) => m.id),
    },
  });
  return json(result, { status: result.ok ? 200 : 422 });
}
