import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { Link, useLoaderData } from "react-router";
import { getMarketingTranslation } from "../i18n/marketing";
import { getGuideCopy } from "../i18n/marketing/guide";
import { MARKETING_SITE } from "../config/marketing-site";
import {
  GUIDE_CATEGORIES,
  GUIDE_TOPIC_ORDER,
  GUIDE_VIDEO_DURATIONS,
  GUIDE_VIDEOS,
  guideCategoryOf,
  guideTopicPath,
  isGuideTopicId,
} from "../config/marketing-guide";
import { buildMarketingMeta } from "../utils/marketing-meta";
import { requireMarketingLocale } from "../utils/marketing-route.server";
import { localizedPath } from "../services/marketing-locale.shared";
import { VideoFrame } from "../components/marketing/VideoFrame";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  // The locale gate runs FIRST and with the real path, so `/en/guide/x`
  // redirects to `/guide/x` like every other page before the slug is judged.
  const locale = requireMarketingLocale(params.lang, `/guide/${params.topic ?? ""}`, url.search);
  const topic = params.topic;
  if (!isGuideTopicId(topic)) {
    // The public layout's boundary renders this with the site chrome.
    throw new Response("Not Found", { status: 404 });
  }
  return { locale, origin: url.origin, topic };
};

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  if (!data) return [{ title: MARKETING_SITE.appName }];
  const t = getMarketingTranslation(data.locale);
  const copy = getGuideCopy(data.locale).topics[data.topic];
  return buildMarketingMeta({
    origin: data.origin,
    locale: data.locale,
    path: guideTopicPath(data.topic),
    title: `${copy.title} — ${t.guide.title} — ${t.site.name}`,
    description: copy.summary,
    siteName: t.site.name,
  });
};

/**
 * `/guide/<topic>` — one topic: its video (or the "video follows" frame), its
 * text, and the way to the neighbouring topics.
 *
 * The video sits ABOVE the text on purpose: it is what most visitors came for
 * once it exists, and the frame keeps its 16:9 box while it does not, so
 * publishing a video later moves nothing on the page.
 */
export default function MarketingGuideTopic() {
  const { locale, topic } = useLoaderData<typeof loader>();
  const t = getMarketingTranslation(locale);
  const guide = getGuideCopy(locale);
  const copy = guide.topics[topic];

  const categoryId = guideCategoryOf(topic);
  const category = GUIDE_CATEGORIES.find((c) => c.id === categoryId)!;
  const categoryCopy = guide.categories[categoryId];

  const index = GUIDE_TOPIC_ORDER.indexOf(topic);
  const previous = index > 0 ? GUIDE_TOPIC_ORDER[index - 1] : null;
  const next = index < GUIDE_TOPIC_ORDER.length - 1 ? GUIDE_TOPIC_ORDER[index + 1] : null;

  const video = GUIDE_VIDEOS[topic];
  const duration = GUIDE_VIDEO_DURATIONS[topic];
  const guidePath = localizedPath(locale, "/guide");

  return (
    <div className="mk-shell mk-guide">
      <nav className="mk-guide__crumbs" aria-label={t.guide.title}>
        <Link to={guidePath}>{t.guide.title}</Link>
        <span aria-hidden="true">/</span>
        <Link to={`${guidePath}#${categoryId}`}>{categoryCopy.title}</Link>
      </nav>

      <div className="mk-guide__layout">
        <article className="mk-guide__article">
          <header className="mk-guide__header">
            <h1>{copy.title}</h1>
            <p className="mk-lead">{copy.summary}</p>
          </header>

          <figure className="mk-guide__video">
            {/* Keyed by topic: prev/next stay on this route, so without the
                key a started embed would carry its "playing" state into the
                next topic and load a third-party iframe without a click, and
                a <video> would keep playing the previous topic's file. */}
            <VideoFrame key={topic} source={video} title={copy.title} pendingLabel={t.guide.videoPending} t={t} />
            <figcaption className="mk-note">
              {video === null
                ? t.guide.videoPendingBody
                : [duration, video.kind === "embed" ? t.videos.externalNote : null]
                    .filter(Boolean)
                    .join(" · ")}
            </figcaption>
          </figure>

          <div className="mk-guide__body">
            {copy.sections.map((section) => (
              <section key={section.heading}>
                <h2>{section.heading}</h2>
                {section.paragraphs.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
                {section.list ? (
                  <ul className="mk-points">
                    {section.list.map((item) => (
                      // ONE child only — see the note in the features route:
                      // the bullet is a `::before` grid item.
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                ) : null}
                {section.steps ? (
                  <ol className="mk-guide__steps">
                    {section.steps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                ) : null}
              </section>
            ))}

            {copy.tips && copy.tips.length > 0 ? (
              <aside className="mk-guide__tips">
                <h2>{t.guide.tips}</h2>
                <ul className="mk-points">
                  {copy.tips.map((tip) => (
                    <li key={tip}>{tip}</li>
                  ))}
                </ul>
              </aside>
            ) : null}
          </div>

          <nav className="mk-guide__pager" aria-label={t.guide.allTopics}>
            {previous ? (
              <Link className="mk-guide__pager-link" to={localizedPath(locale, guideTopicPath(previous))}>
                <span className="mk-note">&larr; {t.guide.previous}</span>
                <span>{guide.topics[previous].title}</span>
              </Link>
            ) : (
              <span />
            )}
            {next ? (
              <Link
                className="mk-guide__pager-link mk-guide__pager-link--next"
                to={localizedPath(locale, guideTopicPath(next))}
              >
                <span className="mk-note">
                  {t.guide.next} &rarr;
                </span>
                <span>{guide.topics[next].title}</span>
              </Link>
            ) : null}
          </nav>
        </article>

        <aside className="mk-guide__side">
          <div className="mk-guide__side-card">
            <h2>{t.guide.inThisCategory}</h2>
            <ul>
              {category.topics.map((sibling) => (
                <li key={sibling}>
                  <Link
                    to={localizedPath(locale, guideTopicPath(sibling))}
                    aria-current={sibling === topic ? "page" : undefined}
                  >
                    {guide.topics[sibling].title}
                  </Link>
                </li>
              ))}
            </ul>
            <Link className="mk-arrow mk-guide__all" to={guidePath}>
              {t.guide.allTopics}
            </Link>
          </div>

          <div className="mk-guide__side-card">
            <h2>{t.guide.helpTitle}</h2>
            <p>{t.guide.helpBody}</p>
            <a className="mk-btn mk-btn--ghost" href={`mailto:${MARKETING_SITE.supportEmail}`}>
              {t.guide.helpAction}
            </a>
          </div>
        </aside>
      </div>
    </div>
  );
}
