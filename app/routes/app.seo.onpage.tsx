/**
 * `/app/seo/onpage` — a REDIRECT since the on-page report became step 2 of the
 * crawl tab (`/app/seo/crawl?view=onpage`).
 *
 * The route stays rather than being deleted: it was a nav entry, so it lives in
 * bookmarks and in the SEO dashboard's deep links, and the `?tab=` a deep link
 * carries has to survive the hop or a merchant clicking "canonical issues" on
 * the dashboard lands on the indexability list instead.
 *
 * The report itself now lives in `components/seo/crawl/OnPageReportView.tsx`
 * (rendering) and `services/seo/onpage-report.server.ts` (loading), so this
 * file holds no logic at all.
 */

import { redirect, type LoaderFunctionArgs } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const target = new URLSearchParams({ view: "onpage" });
  const tab = url.searchParams.get("tab");
  if (tab) target.set("tab", tab);
  return redirect(`/app/seo/crawl?${target.toString()}`);
};
