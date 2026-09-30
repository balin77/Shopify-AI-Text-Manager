import {
  COMPARE_GROUPS,
  COMPARE_ROWS,
  COMPETITOR_NAMES,
  type CompetitorId,
  type Support,
} from "../../config/marketing-compare";
import { MARKETING_SITE } from "../../config/marketing-site";
import type { CompareCopy } from "../../i18n/marketing/compare";

const SYMBOL: Record<Support, string> = {
  yes: "✓",
  partial: "~",
  no: "✕",
  unstated: "?",
};

/**
 * The feature table of the comparison pages: ContentPilot first, then the
 * competitors asked for (all four on `/compare`, one on `/compare/<app>`).
 *
 * A real `<table>` — the row and column headers are what make a comparison
 * readable to a screen reader and to a search engine alike. Each cell says its
 * answer in WORDS next to the symbol, because a symbol alone is not an answer
 * (and colour alone even less). On a phone the table scrolls sideways inside
 * its own box, with the feature column kept in view.
 */
export function CompareTable({
  copy,
  competitors,
}: {
  copy: CompareCopy;
  competitors: readonly CompetitorId[];
}) {
  return (
    <div className="mk-compare-table__scroll" tabIndex={0} role="region" aria-label={copy.tableHeading}>
      <table className={`mk-compare-table${competitors.length === 1 ? " mk-compare-table--single" : ""}`}>
        <thead>
          <tr>
            <th scope="col">{copy.featureColumn}</th>
            <th scope="col" className="mk-compare-table__ours">
              {MARKETING_SITE.appName}
            </th>
            {competitors.map((id) => (
              <th scope="col" key={id}>
                {COMPETITOR_NAMES[id]}
              </th>
            ))}
          </tr>
        </thead>
        {COMPARE_GROUPS.map((group) => (
          <tbody key={group}>
            <tr className="mk-compare-table__group">
              <th scope="rowgroup" colSpan={2 + competitors.length}>
                {copy.groups[group]}
              </th>
            </tr>
            {COMPARE_ROWS.filter((row) => row.group === group).map((row) => (
              <tr key={row.id}>
                <th scope="row">
                  <span className="mk-compare-table__label">{copy.rows[row.id].label}</span>
                  <span className="mk-compare-table__help">{copy.rows[row.id].help}</span>
                </th>
                <CompareCell
                  support={row.ours}
                  label={copy.support[row.ours]}
                  note={copy.ourNotes[row.id]}
                  ours
                />
                {competitors.map((id) => (
                  <CompareCell
                    key={id}
                    support={row.them[id]}
                    label={copy.support[row.them[id]]}
                    note={copy.competitors[id].notes?.[row.id]}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}

function CompareCell({
  support,
  label,
  note,
  ours = false,
}: {
  support: Support;
  label: string;
  note?: string;
  ours?: boolean;
}) {
  return (
    <td className={`mk-compare-cell mk-compare-cell--${support}${ours ? " mk-compare-table__ours" : ""}`}>
      <span className="mk-compare-cell__answer">
        <span className="mk-compare-cell__symbol" aria-hidden="true">
          {SYMBOL[support]}
        </span>
        {label}
      </span>
      {note ? <span className="mk-compare-cell__note">{note}</span> : null}
    </td>
  );
}

/** Where the facts come from, how old they are, and where to report a wrong one. */
export function CompareDisclaimer({ copy }: { copy: CompareCopy }) {
  return (
    <p className="mk-note mk-compare__disclaimer">
      {copy.disclaimer.replace("{date}", copy.checkedAt)}{" "}
      <a href={`mailto:${MARKETING_SITE.supportEmail}`}>{copy.correction}</a>
    </p>
  );
}
