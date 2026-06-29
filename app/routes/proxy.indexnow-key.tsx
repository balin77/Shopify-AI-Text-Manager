/**
 * App Proxy (GET): serve the IndexNow key file (SEO tab Phase 8).
 *
 * Storefront URL: GET /apps/contentpilot/indexnow-key  → returns the shop's
 * public IndexNow key as text/plain. This is the `keyLocation` IndexNow fetches
 * to verify ownership. Shopify HMAC-signs the forwarded request, so the
 * unauthenticated IndexNow/Bing fetch resolves the shop here. The key is public
 * by design (not a secret).
 */
import { type LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { getIndexNowConfig } from "../services/seo/index-now.service";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return new Response("", { status: 404 });

  const config = await getIndexNowConfig(db, session.shop);
  if (!config || !config.enabled) return new Response("", { status: 404 });

  return new Response(config.key, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
