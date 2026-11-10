/**
 * Detail view of one shop on /admin (PLAN_ADMIN_SHOP_OVERVIEW 3.5): reasons,
 * facts, a 30-day activity bar, storage and a timeline. Rendered from the data
 * of `GET /admin?detail=<shop>` that the row's fetcher loaded on click; no
 * customer data is in it. Times are fixed UTC stamps (same text on server and
 * client).
 */

import type { ShopDetail } from '~/services/admin/shop-overview.shared';
import { relativeAge, utcStamp } from '~/services/admin/shop-overview.shared';
import type { UninstallReviewView } from '~/services/admin/uninstall-review.shared';
import { MarkUninstalledSection } from './MarkUninstalledSection';
import { MUTED, STATUS_DOT, STATUS_TINT } from './admin-styles';

const DAY_MS = 24 * 60 * 60 * 1000;

function thirtyDays(detail: ShopDetail): Array<{ day: string; slots: number; actions: number }> {
  const byDay = new Map(detail.usage.map((u) => [u.day, u]));
  const end = Date.parse(detail.now);
  const out: Array<{ day: string; slots: number; actions: number }> = [];
  for (let i = 29; i >= 0; i--) {
    const day = new Date(end - i * DAY_MS).toISOString().slice(0, 10);
    const u = byDay.get(day);
    out.push({ day, slots: u?.activeSlots ?? 0, actions: u?.actions ?? 0 });
  }
  return out;
}

export function ShopDetailPanel({ detail, uninstall = null }: { detail: ShopDetail; uninstall?: UninstallReviewView | null }) {
  const nowMs = Date.parse(detail.now);
  const days = thirtyDays(detail);
  const maxSlots = Math.max(1, ...days.map((d) => d.slots));
  return (
    <div style={{ display: 'grid', gap: 14, whiteSpace: 'normal', fontSize: 13 }}>
      <div
        style={{
          background: STATUS_TINT[detail.status.color],
          border: `1px solid ${STATUS_DOT[detail.status.color]}`,
          borderRadius: 4,
          padding: '8px 10px',
        }}
      >
        <strong>{detail.status.colorLabel}</strong>
        {detail.status.reasons.length === 0 ? (
          <span style={{ color: MUTED }}> — keine Auffälligkeiten.</span>
        ) : (
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {detail.status.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
      </div>

      <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '3px 14px', margin: 0 }}>
        {detail.facts.map((f) => (
          <div key={f.label} style={{ display: 'contents' }}>
            <dt style={{ color: MUTED }}>{f.label}</dt>
            <dd style={{ margin: 0, wordBreak: 'break-word' }}>{f.value}</dd>
          </div>
        ))}
        <dt style={{ color: MUTED }}>Speicher (ungefähr)</dt>
        <dd style={{ margin: 0 }}>{detail.storageMB} MB Text</dd>
      </dl>

      <div>
        <div style={{ color: MUTED, marginBottom: 4 }}>
          Aktivität der letzten 30 Tage (aktive 5-Minuten-Fenster pro Tag)
        </div>
        <div style={{ display: 'flex', gap: 2 }} role="img" aria-label="Aktivität der letzten 30 Tage">
          {days.map((d) => (
            <div
              key={d.day}
              title={`${d.day}: ${d.slots} Fenster, ${d.actions} Aktionen`}
              style={{
                width: 14,
                height: 22,
                borderRadius: 2,
                background: d.slots === 0 ? '#e1e3e5' : '#008060',
                opacity: d.slots === 0 ? 1 : 0.25 + 0.75 * (d.slots / maxSlots),
              }}
            />
          ))}
        </div>
      </div>

      {uninstall && <MarkUninstalledSection review={uninstall} />}

      <div>
        <div style={{ color: MUTED, marginBottom: 4 }}>Zeitleiste (höchstens 100 Einträge)</div>
        {detail.timeline.length === 0 ? (
          <div>Keine Einträge.</div>
        ) : (
          <div style={{ maxHeight: 260, overflow: 'auto', border: '1px solid #e1e3e5', borderRadius: 4, background: '#fff' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <tbody>
                {detail.timeline.map((e, i) => (
                  <tr key={`${e.at}-${i}`}>
                    <td style={{ padding: '3px 8px', whiteSpace: 'nowrap', color: MUTED }} title={utcStamp(e.at)}>
                      {utcStamp(e.at)} · {relativeAge(Date.parse(e.at), nowMs)}
                    </td>
                    <td style={{ padding: '3px 8px', whiteSpace: 'nowrap' }}>{e.kind}</td>
                    <td style={{ padding: '3px 8px' }}>{e.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
