import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const entries = await db.optionValueMemory.findMany({
    where: { shop },
    select: { optionValue: true, savedAs: true },
  });

  const memory = Object.fromEntries(entries.map(e => [e.optionValue, e.savedAs]));
  return json({ memory });
};
