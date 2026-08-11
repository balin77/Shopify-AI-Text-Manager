import { data as json, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

/**
 * Compact product list for the Image Manager's "Used in other product" filter
 * dropdown. Reads from ContentPilot's local DB cache — no Shopify roundtrip —
 * so the dropdown opens instantly even on shops with thousands of products.
 *
 * Query params:
 *   q?     — free-text title substring (case-insensitive)
 *   first? — page size, default 50, cap 200.
 *
 * Response: `{ products: Array<{ id, title, featuredImageUrl }> }`.
 * `id` is the Shopify product GID (`gid://shopify/Product/...`) — exactly
 * the same shape that /api/files?usedByProductId= expects.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);

  const q = (url.searchParams.get("q") ?? "").trim();
  const firstRaw = parseInt(url.searchParams.get("first") ?? "50", 10);
  const first = Number.isFinite(firstRaw) ? Math.min(Math.max(firstRaw, 1), 200) : 50;

  const where = {
    shop: session.shop,
    ...(q ? { title: { contains: q, mode: "insensitive" as const } } : {}),
  };

  const products = await db.product.findMany({
    where,
    select: { id: true, title: true, featuredImageUrl: true },
    orderBy: { title: "asc" },
    take: first,
  });

  return json({ products });
};
