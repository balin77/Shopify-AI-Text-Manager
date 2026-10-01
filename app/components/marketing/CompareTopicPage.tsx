import { Link } from "react-router";
import {
  COMPARE_TOPICS,
  COMPETITOR_NAMES,
  comparePath,
  topicPath,
  visibleTopics,
  type CompareTopicId,
  type PriceAppId,
} from "../../config/marketing-compare";
import type { CompareCopy } from "../../i18n/marketing/compare";
import { localizedPath, type MarketingLocale } from "../../services/marketing-locale.shared";
import { CompareDisclaimer, CompareMatrix } from "./CompareTable";

/** Title and lead of a topic: translation keeps the page's original ones. */
export function topicHeading(copy: CompareCopy, topic: CompareTopicId): { title: string; intro: string } {
  if (topic === "translation") return { title: copy.title, intro: copy.intro };
  const item = copy.topics.items[topic];
  return { title: item.title, intro: item.intro };
}

/**
 * The switch between comparison topics. Links, not buttons: every topic is a
 * page of its own that a search engine can find and a visitor can share.
 * Rendered only when there is more than one topic to switch between.
 */
function TopicNav({
  copy,
  locale,
  current,
  preview,
}: {
  copy: CompareCopy;
  locale: MarketingLocale;
  current: CompareTopicId;
  preview: boolean;
}) {
  const topics = visibleTopics(preview);
  if (topics.length < 2) return null;
  // The switch leads the page: the one-plan-covers-everything sentence first,
  // the topics right under it as large tabs, the topic's own heading after.
  // Below a big h1 the tabs read as page chrome and went unnoticed.
  return (
    <div className="mk-compare-hub">
      <p className="mk-compare-hub__suite">{copy.topics.suite}</p>
      <nav className="mk-compare-topics" aria-label={copy.topics.nav}>
        {topics.map((id) => (
          <Link
            key={id}
            className="mk-compare-topics__link"
            aria-current={id === current ? "page" : undefined}
            to={`${localizedPath(locale, topicPath(id))}${preview ? "?preview" : ""}`}
          >
            {copy.topics.items[id].tab}
          </Link>
        ))}
      </nav>
    </div>
  );
}

/**
 * One comparison topic: heading, topic switch, the plan-by-plan table and a
 * card per app that has its own `/compare/<app>` page. `/compare` renders the
 * translation topic, `/compare/<slug>` every other one.
 */
export function CompareTopicPage({
  copy,
  locale,
  topic,
  preview,
}: {
  copy: CompareCopy;
  locale: MarketingLocale;
  topic: CompareTopicId;
  /** Unpublished topics shown in a preview; the banner says so. */
  preview: boolean;
}) {
  const config = COMPARE_TOPICS[topic];
  const { title, intro } = topicHeading(copy, topic);
  const apps: PriceAppId[] = ["contentpilot", ...config.competitors];
  const cards = config.competitors.filter((id) => copy.competitors[id] && config.published);

  return (
    <>
      <section className="mk-section mk-section--first">
        <div className="mk-shell">
          <TopicNav copy={copy} locale={locale} current={topic} preview={preview} />
          {!config.published ? <p className="mk-compare-preview">{copy.topics.preview}</p> : null}
          <div className="mk-section__head mk-compare-head">
            <h1>{title}</h1>
            <p className="mk-lead">{intro}</p>
          </div>

          {/* Keyed by topic: switching topics starts a fresh table rather than
              carrying one topic's hidden columns into the next. */}
          <CompareMatrix
            key={topic}
            copy={copy}
            locale={locale}
            topic={topic}
            apps={apps}
            initialApps={["contentpilot", ...config.initial]}
          />

          {cards.length > 0 ? (
            <ul className="mk-compare-cards">
              {cards.map((id) => {
                const competitor = copy.competitors[id]!;
                return (
                  <li key={id}>
                    <Link className="mk-compare-card" to={localizedPath(locale, comparePath(id))}>
                      <span className="mk-compare-card__title">
                        {copy.vsTitle.replace("{name}", COMPETITOR_NAMES[id])}
                      </span>
                      <span className="mk-note">{competitor.kind}</span>
                      <span className="mk-compare-card__summary">{competitor.summary}</span>
                      <span className="mk-arrow">{copy.detailLink}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-shell">
          <CompareDisclaimer copy={copy} />
        </div>
      </section>
    </>
  );
}
