import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { getMarketingTranslation } from "../i18n/marketing";
import { getCompareCopy } from "../i18n/marketing/compare";
import { MARKETING_SITE } from "../config/marketing-site";
import { breadcrumbLd } from "../utils/marketing-jsonld";
import { buildMarketingMeta } from "../utils/marketing-meta";
import {
  marketingOrigin,
  redirectTrailingSlash,
  requireMarketingLocale,
} from "../utils/marketing-route.server";
import { localizedPath } from "../services/marketing-locale.shared";
import { CompareTopicPage } from "../components/marketing/CompareTopicPage";
import { MarketingCta } from "../components/marketing/MarketingCta";
import { comparePreviewAllowed } from "../utils/marketing-compare-preview.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  redirectTrailingSlash(url);
  const locale = requireMarketingLocale(params.lang, "/compare", url.search);
  return { locale, origin: marketingOrigin(url), preview: comparePreviewAllowed(url) };
};

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  if (!data) return [{ title: MARKETING_SITE.appName }];
  const t = getMarketingTranslation(data.locale);
  const copy = getCompareCopy(data.locale);
  return buildMarketingMeta({
    origin: data.origin,
    locale: data.locale,
    path: "/compare",
    title: `${copy.title} — ${t.site.name}`,
    description: copy.intro,
    siteName: t.site.name,
    jsonLd: [
      breadcrumbLd([
        { name: t.site.name, url: `${data.origin}${localizedPath(data.locale, "/")}` },
        { name: t.nav.compare, url: `${data.origin}${localizedPath(data.locale, "/compare")}` },
      ]),
    ],
  });
};

/**
 * `/compare` — the translation topic, ContentPilot against the translation
 * apps merchants weigh it against. The other topics live at
 * `/compare/<topic>` and share this page's layout (CompareTopicPage). The
 * facts live in config/marketing-compare.ts; read the rules there before
 * changing an answer.
 */
export default function MarketingCompare() {
  const { locale, preview } = useLoaderData<typeof loader>();
  const t = getMarketingTranslation(locale);
  const copy = getCompareCopy(locale);

  return (
    <>
      <CompareTopicPage copy={copy} locale={locale} topic="translation" preview={preview} />
      <MarketingCta t={t} locale={locale} />
    </>
  );
}
