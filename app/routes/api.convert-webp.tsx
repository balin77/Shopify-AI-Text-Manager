import { json, type ActionFunctionArgs } from "@remix-run/node";
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
  if (process.env.APP_ENV === "production") throw new Response("Not Found", { status: 404 });
  const { session } = await authenticate.admin(request);
  const { productId, productTitle, images }: ConvertWebpBody = await request.json();

  if (!images?.length) {
    return json({ error: "No images provided" }, { status: 400 });
  }

  // Bound the fan-out: an unbounded images[] array would create an unbounded
  // number of db.task rows in a single request. Cheap check first, before the
  // quota DB round-trip below.
  const MAX_IMAGES_PER_REQUEST = 250;
  if (images.length > MAX_IMAGES_PER_REQUEST) {
    return json(
      { error: `Too many images in one request (max ${MAX_IMAGES_PER_REQUEST}, got ${images.length})` },
      { status: 413 },
    );
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
