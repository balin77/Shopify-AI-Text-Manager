/**
 * /roadmap — rendered from app/config/roadmap.ts, the ONE roadmap file.
 *
 * This route holds no content of its own: it groups the public entries by
 * status, sorts the shipped ones newest first, and prints them. Changing what
 * the page says is changing that file, which is the point — the development
 * plan and the public page cannot disagree because they are one list.
 */

import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { getMarketingTranslation, type MarketingTranslation } from "../i18n/marketing";
import { MARKETING_SITE } from "../config/marketing-site";
import { publicRoadmap, type PublicRoadmapEntry, type RoadmapStatus } from "../config/roadmap";
import { buildMarketingMeta } from "../utils/marketing-meta";
import { requireMarketingLocale } from "../utils/marketing-route.server";
import { MarketingCta } from "../components/marketing/MarketingCta";
import type { MarketingLocale } from "../services/marketing-locale.shared";

/** The sections in reading order. `dropped` is deliberately not one of them. */
const SECTIONS: Array<{ status: RoadmapStatus; label: keyof MarketingTranslation["roadmap"]["sections"] }> = [
  { status: "in-progress", label: "inProgress" },
  { status: "planned", label: "planned" },
  { status: "considering", label: "considering" },
  { status: "shipped", label: "shipped" },
];

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const locale = requireMarketingLocale(params.lang, "/roadmap", url.search);
  return { locale, origin: url.origin };
};

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  if (!data) return [{ title: MARKETING_SITE.appName }];
  const t = getMarketingTranslation(data.locale);
  return buildMarketingMeta({
    origin: data.origin,
    locale: data.locale,
    path: "/roadmap",
    title: `${t.roadmap.title} — ${t.site.name}`,
    description: t.roadmap.intro,
    siteName: t.site.name,
  });
};

function entriesFor(status: RoadmapStatus): PublicRoadmapEntry[] {
  const entries = publicRoadmap().filter((entry) => entry.status === status);
  // File order is priority order everywhere except the shipped list, which
  // reads newest first; an entry without a date sorts last rather than
  // throwing the sort.
  if (status === "shipped") {
    return [...entries].sort((a, b) => (b.shippedOn ?? "").localeCompare(a.shippedOn ?? ""));
  }
  return entries;
}

/** "2026-08" → "08/2026"-style month label in the page's own locale. Deterministic, so safe to render on the server. */
function shippedLabel(iso: string, locale: MarketingLocale): string {
  const [year, month] = iso.split("-");
  if (!month) return year;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, 1));
  return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}

export default function MarketingRoadmap() {
  const { locale } = useLoaderData<typeof loader>();
  const t = getMarketingTranslation(locale);

  return (
    <>
      <section className="mk-section mk-section--first">
        <div className="mk-shell">
          <div className="mk-section__head">
            <h1>{t.roadmap.title}</h1>
            <p className="mk-lead">{t.roadmap.intro}</p>
            <p className="mk-note">{t.roadmap.note}</p>
          </div>
        </div>
      </section>

      <div className="mk-shell mk-roadmap">
        {SECTIONS.map(({ status, label }) => {
          const entries = entriesFor(status);
          if (entries.length === 0) return null;
          return (
            <section className="mk-roadmap__section" key={status} id={status}>
              <h2 className="mk-roadmap__heading">
                {t.roadmap.sections[label]}
                <span className="mk-roadmap__count" aria-hidden="true">
                  {entries.length}
                </span>
              </h2>
              <div className={status === "shipped" ? "mk-roadmap__list" : "mk-roadmap__grid"}>
                {entries.map((entry) => (
                  <article className="mk-card mk-roadmap__card" key={entry.id} id={entry.id}>
                    <div className="mk-roadmap__meta">
                      <span className="mk-tag">{t.roadmap.areas[entry.area]}</span>
                      {status === "shipped" && entry.shippedOn ? (
                        <span className="mk-roadmap__date">
                          {t.roadmap.shippedOn} {shippedLabel(entry.shippedOn, locale)}
                        </span>
                      ) : null}
                    </div>
                    <h3>{entry.title[locale]}</h3>
                    <p>{entry.body[locale]}</p>
                  </article>
                ))}
              </div>
            </section>
          );
        })}
      </div>

      <MarketingCta t={t} locale={locale} />
    </>
  );
}
