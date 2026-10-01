/**
 * /llms.txt for the app's PUBLIC website — the file AI assistants read to find
 * their way around a site (llmstxt.org). Not the merchant storefront's
 * llms.txt: that one is a theme file this app writes per shop (aeo.service.ts).
 *
 * Built from the same config and copy the pages render, so it cannot list a
 * page that does not exist or describe a topic differently from its page.
 * English only, with the other languages named: the file is a map, and the
 * pages themselves carry hreflang for the rest.
 */

import type { LoaderFunctionArgs } from "react-router";
import { marketingOrigin } from "../utils/marketing-route.server";
import { MARKETING_SITE } from "../config/marketing-site";
import { GUIDE_CATEGORIES, guideTopicPath } from "../config/marketing-guide";
import { COMPETITOR_NAMES, LIVE_COMPETITORS, comparePath } from "../config/marketing-compare";
import { getMarketingTranslation } from "../i18n/marketing";
import { getGuideCopy } from "../i18n/marketing/guide";
import { getCompareCopy } from "../i18n/marketing/compare";
import { MARKETING_DEFAULT_LOCALE } from "../services/marketing-locale.shared";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const origin = marketingOrigin(new URL(request.url));
  const t = getMarketingTranslation(MARKETING_DEFAULT_LOCALE);
  const guide = getGuideCopy(MARKETING_DEFAULT_LOCALE);
  const compare = getCompareCopy(MARKETING_DEFAULT_LOCALE);

  const lines: string[] = [
    `# ${MARKETING_SITE.appName}`,
    "",
    `> ${t.site.description}`,
    "",
    `${MARKETING_SITE.appName} is a Shopify app that runs inside the Shopify admin. Install it from the Shopify App Store${
      MARKETING_SITE.appStoreUrl ? ` (${MARKETING_SITE.appStoreUrl})` : ""
    }. This website is available in English, German (/de) and Spanish (/es).`,
    "",
    "## Pages",
    "",
    `- [Home](${origin}/): what the app does and frequently asked questions`,
    `- [Features](${origin}/features): every feature area in one page`,
    `- [Pricing](${origin}/pricing): the four plans, their prices and limits side by side`,
    `- [Guide](${origin}/guide): how each part of the app works, one topic per page`,
    `- [Comparison](${origin}/compare): ${compare.intro}`,
    `- [Roadmap](${origin}/roadmap): what is planned and recently shipped`,
    "",
  ];

  for (const category of GUIDE_CATEGORIES) {
    lines.push(`## Guide: ${guide.categories[category.id].title}`, "");
    for (const topic of category.topics) {
      const copy = guide.topics[topic];
      lines.push(`- [${copy.title}](${origin}${guideTopicPath(topic)}): ${copy.summary}`);
    }
    lines.push("");
  }

  lines.push("## Comparisons", "");
  for (const id of LIVE_COMPETITORS) {
    const summary = compare.competitors[id]?.summary;
    if (!summary) continue;
    lines.push(`- [${compare.vsTitle.replace("{name}", COMPETITOR_NAMES[id])}](${origin}${comparePath(id)}): ${summary}`);
  }
  lines.push("");

  lines.push(
    "## Optional",
    "",
    `- [Privacy policy](${origin}/privacy)`,
    `- [Terms of service](${origin}/terms)`,
    `- Support: ${MARKETING_SITE.supportEmail}`,
    "",
  );

  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
};
