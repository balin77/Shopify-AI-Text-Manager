import { data as json, type ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { type Plan } from "../config/plans";
import { consumeImageOperations } from "../utils/imageOperations.server";

interface ConvertWebpBody {
  productId: string;
  productTitle?: string;
  images: Array<{ mediaId: string; url: string; productImageId: string; altText?: string | null; position?: number | null }>;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { productId, productTitle, images: requestedImages }: ConvertWebpBody = await request.json();
  let images = requestedImages;

  if (!images?.length) {
    return json({ error: "No images provided" }, { status: 400 });
  }

  // Bound the fan-out: an unbounded images[] array would create an unbounded
  // number of db.task rows in a single request. Cheap check first, before the
  // quota / ownership DB round-trips below.
  const MAX_IMAGES_PER_REQUEST = 250;
  if (images.length > MAX_IMAGES_PER_REQUEST) {
    return json(
      { error: `Too many images in one request (max ${MAX_IMAGES_PER_REQUEST}, got ${images.length})` },
      { status: 413 },
    );
  }

  // Fail-closed ownership guard (strong `shop_id` compound): never create
  // imageWebpConversion task rows for a productId owned by another shop
  // (N-H6). Also prevents charging quota for a foreign product.
  const owned = await db.product.findUnique({
    where: { shop_id: { shop: session.shop, id: productId } },
    select: { id: true },
  });
  if (!owned) {
    return json({ error: "Product not found for this shop" }, { status: 404 });
  }

  // Only a MediaImage can be converted. Every other product medium — Video,
  // Model3d, ExternalVideo — is reported to the client under its POSTER url
  // (a .jpg on the Shopify CDN), so "the URL does not end in .webp" is not
  // evidence that the row is an image, and this route is directly POST-
  // reachable anyway. Converting a video would be worse than a wasted
  // operation: the worker creates a MediaImage from the poster and then
  // productDeleteMedia's the task's mediaId, i.e. deletes the video. So the
  // kind is verified against Shopify BEFORE the quota is charged and before
  // a single task row exists.
  const mediaIds = [...new Set(images.map(i => i.mediaId).filter((id): id is string => !!id))];
  if (mediaIds.length > 0) {
    let kinds: Record<string, string>;
    try {
      const res = await admin.graphql(
        `#graphql
        query WebpConvertibleMedia($ids: [ID!]!) {
          nodes(ids: $ids) {
            id
            __typename
          }
        }`,
        { variables: { ids: mediaIds } },
      );
      const body = await res.json();
      const nodes = body?.data?.nodes;
      if (!Array.isArray(nodes)) throw new Error("nodes query returned no data");
      kinds = Object.fromEntries(
        nodes.filter((n: any) => n?.id).map((n: any) => [n.id, n.__typename]),
      );
    } catch (err: any) {
      // An unverified kind is never treated as "it is an image" — a throttled
      // or failed lookup must not be able to delete a merchant's video. The
      // merchant retries; nothing was charged.
      console.error("[api.convert-webp] media kind lookup failed:", err?.message);
      return json(
        { error: "Could not verify the media types with Shopify", code: "MEDIA_KIND_UNVERIFIED" },
        { status: 503 },
      );
    }
    const convertible = images.filter(i => !i.mediaId || kinds[i.mediaId] === "MediaImage");
    if (convertible.length !== images.length) {
      console.warn(
        `[api.convert-webp] dropped ${images.length - convertible.length} non-image medium/media from the batch`,
      );
    }
    images = convertible;
    if (images.length === 0) {
      return json({ error: "No convertible images in the request", code: "NO_CONVERTIBLE_IMAGES" }, { status: 400 });
    }
  }

  // Each image conversion = one billable image operation (real compute/
  // bandwidth; AI is merchant-funded BYO). Whole-batch semantics: reject the
  // entire batch if it doesn't fit, so no tasks are created on overage.
  const settings = await db.aISettings.findUnique({
    where: { shop: session.shop },
    select: { subscriptionPlan: true },
  });
  const plan = (settings?.subscriptionPlan || "free") as Plan;
  const quota = await consumeImageOperations(session.shop, plan, images.length);
  if (!quota.allowed) {
    return json(
      { error: "Monthly image-operation limit reached", code: "IMAGE_QUOTA_EXCEEDED", limit: quota.limit },
      { status: 422 }
    );
  }

  const tasks = await Promise.all(images.map(img =>
    db.task.create({
      data: {
        shop: session.shop,
        type: "imageWebpConversion",
        status: "pending",
        resourceType: "product",
        resourceId: productId,
        resourceTitle: productTitle || productId,
        result: JSON.stringify({
          sourceUrl: img.url,
          mediaId: img.mediaId,
          productImageId: img.productImageId,
          productId,
          altText: img.altText ?? null,
          position: img.position ?? null,
        }),
      },
    })
  ));

  return json({ taskIds: tasks.map(t => t.id) });
};
