import { LoaderFunctionArgs, redirect, data as json } from "react-router";
import { login } from "../shopify.server";
import { logger } from "~/utils/logger.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  if (shop) {
    throw redirect(`/auth?${url.searchParams.toString()}`);
  }

  try {
    const result = await login(request);
    return json(result);
  } catch (error) {
    logger.error("[AUTH.LOGIN] Error", { context: "Auth", error: error instanceof Error ? error.message : String(error), ...(process.env.NODE_ENV !== 'production' && { stack: error instanceof Error ? error.stack : undefined }) });
    throw error;
  }
};
