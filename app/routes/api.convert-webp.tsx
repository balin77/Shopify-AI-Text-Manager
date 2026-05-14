import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

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
