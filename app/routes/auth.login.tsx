import { LoaderFunctionArgs, redirect } from "@remix-run/node";
import { login } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  console.log("🔐 [AUTH.LOGIN] Request URL:", request.url);
  console.log("🔐 [AUTH.LOGIN] Method:", request.method);

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  console.log("🔐 [AUTH.LOGIN] Shop parameter:", shop);

  if (shop) {
    console.log("🔀 [AUTH.LOGIN] Redirecting to /auth with shop parameter");
    throw redirect(`/auth?${url.searchParams.toString()}`);
  }

  console.log("🔐 [AUTH.LOGIN] Calling login function");
  try {
    const result = await login(request);
    console.log("✅ [AUTH.LOGIN] Login completed");
    return result;
  } catch (error) {
    console.error("❌ [AUTH.LOGIN] Error:", error);
    console.error("❌ [AUTH.LOGIN] Error stack:", error instanceof Error ? error.stack : "No stack");
    throw error;
  }
};
