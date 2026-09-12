/**
 * /roadmap — rendered from app/config/roadmap.server.ts, the ONE roadmap file.
 *
 * This route holds no content of its own: the LOADER groups the public
 * entries by status, sorts the shipped ones newest first, and hands the
 * component only what it prints — id, status, area, date, and the title and
 * body in the page's language. The internal entries (pricing, strategy,
 * infrastructure) never leave the server: the roadmap module is `.server`,
 * so importing it from this component would fail the build rather than ship
 * them in the bundle, which is what the first cut did.
 */

import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { getMarketingTranslation, type MarketingTranslation } from "../i18n/marketing";
import { MARKETING_SITE } from "../config/marketing-site";
import { publicRoadmap, type RoadmapArea, type RoadmapStatus } from "../config/roadmap.server";
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

/** What the page prints per entry — and nothing the file marks internal. */
interface RoadmapCard {
  id: string;
  area: RoadmapArea;
  shippedOn?: string;
  title: string;
  body: string;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const locale = requireMarketingLocale(params.lang, "/roadmap", url.search);

  const sections = SECTIONS.map(({ status, label }) => {
    const entries = publicRoadmap().filter((entry) => entry.status === status);
    // File order is priority order everywhere except the shipped list, which
    // reads newest first. Plain comparison, not localeCompare: these are ISO
    // dates in one fixed layout, and collation has no say in their order.
    const ordered =
      status === "shipped"
        ? [...entries].sort((a, b) => ((b.shippedOn ?? "") < (a.shippedOn ?? "") ? -1 : (b.shippedOn ?? "") > (a.shippedOn ?? "") ? 1 : 0))
        : entries;
    const cards: RoadmapCard[] = ordered.map((entry) => ({
      id: entry.id,
      area: entry.area,
      shippedOn: entry.shippedOn,
      title: entry.title[locale],
      body: entry.body[locale],
    }));
    return { status, label, cards };
  }).filter((section) => section.cards.length > 0);

  return { locale, origin: url.origin, sections };
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

/** "2026-08" → "August 2026" in the page's own locale. Explicit locale + UTC, so it is the same string on both sides. */
function shippedLabel(iso: string, locale: MarketingLocale): string {
  const [year, month] = iso.split("-");
  if (!month) return year;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, 1));
  return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}

export default function MarketingRoadmap() {
  const { locale, sections } = useLoaderData<typeof loader>();
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
        {sections.map(({ status, label, cards }) => (
          // Section anchors are prefixed so they can never collide with an
          // entry id — both live in one id namespace on the page.
          <section className="mk-roadmap__section" key={status} id={`status-${status}`}>
            <h2 className="mk-roadmap__heading">
              {t.roadmap.sections[label]}
              <span className="mk-roadmap__count" aria-hidden="true">
                {cards.length}
              </span>
            </h2>
            <div className={status === "shipped" ? "mk-roadmap__list" : "mk-roadmap__grid"}>
              {cards.map((card) => (
                <article className="mk-card mk-roadmap__card" key={card.id} id={card.id}>
                  <div className="mk-roadmap__meta">
                    <span className="mk-tag">{t.roadmap.areas[card.area]}</span>
                    {status === "shipped" && card.shippedOn ? (
                      <span className="mk-roadmap__date">
                        {t.roadmap.shippedOn} {shippedLabel(card.shippedOn, locale)}
                      </span>
                    ) : null}
                  </div>
                  <h3>{card.title}</h3>
                  <p>{card.body}</p>
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>

      <MarketingCta t={t} locale={locale} />
    </>
  );
}
