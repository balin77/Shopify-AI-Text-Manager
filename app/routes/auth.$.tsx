import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);

  // If we have a redirect, return it
  if (redirect) {
    return redirect;
  }

  // If we have a session, redirect to the app
  if (session) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: `/app`,
      },
    });
  }

  // This shouldn't happen, but just in case
  return new Response("OK", { status: 200 });
};
