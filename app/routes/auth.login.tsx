import { LoaderFunctionArgs, redirect } from "@remix-run/node";
import { login } from "../shopify.server";
import { logger } from "~/utils/logger.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  logger.debug("[AUTH.LOGIN] Request received", { context: "Auth", url: request.url, method: request.method });

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  logger.debug("[AUTH.LOGIN] Shop parameter", { context: "Auth", shop });

  if (shop) {
    logger.debug("[AUTH.LOGIN] Redirecting to /auth with shop parameter", { context: "Auth" });
    throw redirect(`/auth?${url.searchParams.toString()}`);
  }

  logger.debug("[AUTH.LOGIN] Calling login function", { context: "Auth" });
  try {
    const result = await login(request);
    logger.debug("[AUTH.LOGIN] Login completed", { context: "Auth" });
    return result;
  } catch (error) {
    logger.error("[AUTH.LOGIN] Error", { context: "Auth", error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
    throw error;
  }
};
