import { redirect, type LoaderFunctionArgs } from "@remix-run/node";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  // Redirect root to /app with all query params
  return redirect(`/app${url.search}`);
};
