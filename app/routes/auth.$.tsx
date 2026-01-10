import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  console.log("🔐 [AUTH.$] Request URL:", request.url);
  console.log("🔐 [AUTH.$] Method:", request.method);
  console.log("🔐 [AUTH.$] Headers:", Object.fromEntries(request.headers.entries()));

  try {
    console.log("🔐 [AUTH.$] Authenticating...");
    const { session, redirect } = await authenticate.admin(request);

    // If we have a redirect, return it
    if (redirect) {
      console.log("🔀 [AUTH.$] Redirect response:", redirect.headers.get("Location"));
      return redirect;
    }

    // If we have a session, redirect to the app
    if (session) {
      console.log("✅ [AUTH.$] Session found, redirecting to /app");
      console.log("✅ [AUTH.$] Shop:", session.shop);
      console.log("✅ [AUTH.$] Session ID:", session.id);
      return new Response(null, {
        status: 302,
        headers: {
          Location: `/app`,
        },
      });
    }

    // This shouldn't happen, but just in case
    console.log("⚠️ [AUTH.$] No session and no redirect - returning OK");
    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("❌ [AUTH.$] Error:", error);
    console.error("❌ [AUTH.$] Error stack:", error instanceof Error ? error.stack : "No stack");
    throw error;
  }
};
