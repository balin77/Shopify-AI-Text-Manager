import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

interface ConvertWebpBody {
  productId: string;
  images: Array<{ mediaId: string; url: string; productImageId: string }>;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { productId, images }: ConvertWebpBody = await request.json();

  if (!images?.length) {
    return json({ error: "No images provided" }, { status: 400 });
  }

  const tasks = await Promise.all(images.map(img =>
    db.task.create({
      data: {
        shop: session.shop,
        type: "imageWebpConversion",
        status: "pending",
        resourceType: "product",
        resourceId: productId,
        resourceTitle: img.mediaId,
        result: JSON.stringify({
          sourceUrl: img.url,
          mediaId: img.mediaId,
          productImageId: img.productImageId,
          productId,
        }),
      },
    })
  ));

  return json({ taskIds: tasks.map(t => t.id) });
};
