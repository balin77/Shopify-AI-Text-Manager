/**
 * Legacy path of the bulk editor (docs/plans/PLAN_BULK_EDITOR.md §1.1).
 *
 * The editor moved out of the SEO section to /app/bulk once it outgrew
 * "meta fields only". This route stays as a 302 redirect so bookmarks,
 * deep links from the SEO dashboard and older docs keep working. Query
 * parameters (including Shopify's host/shop/embedded session params) are
 * carried over verbatim.
 */

import { redirect, type LoaderFunctionArgs } from "@remix-run/node";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  return redirect(`/app/bulk${url.search}`, 302);
};
