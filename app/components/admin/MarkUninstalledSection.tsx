/**
 * "Als deinstalliert markieren" in the /admin detail view. The verdict and the
 * evidence come from the loader (server-built, no token); the button only
 * opens the evidence, and the POST needs the shop domain typed exactly. The
 * server re-reads and re-judges everything, so this is presentation only.
 */

import { useState } from 'react';
import { useFetcher } from 'react-router';
import { markRefusalText, type UninstallReviewView } from '~/services/admin/uninstall-review.shared';
import { utcStamp } from '~/services/admin/shop-overview.shared';
import { BUTTON, DANGER, MUTED } from './admin-styles';

const stamp = (iso: string | null): string => (iso ? utcStamp(iso) : 'nie');
const yesNo = (v: boolean): string => (v ? 'ja' : 'nein');

export function MarkUninstalledSection({ review }: { review: UninstallReviewView }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const fetcher = useFetcher<{ ok?: string; error?: string }>();
  const busy = fetcher.state !== 'idle';
  const e = review.evidence;
  const done = !!fetcher.data?.ok;
  const canSubmit = review.eligible && typed === review.shop && !busy && !done;

  return (
    <div style={{ border: '1px solid #e1e3e5', borderRadius: 4, padding: '8px 10px', background: '#fff' }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Als deinstalliert markieren</div>
      {!review.eligible && review.refusal && (
        <div style={{ color: MUTED }}>{markRefusalText(review.refusal)}</div>
      )}
      <button
        type="button"
        disabled={!review.eligible || done}
        onClick={() => setOpen((v) => !v)}
        style={{ ...BUTTON, marginTop: 6, ...(review.eligible && !done ? { border: `1px solid ${DANGER}`, color: DANGER } : { opacity: 0.5 }) }}
      >
        {open ? 'Schliessen' : 'Als deinstalliert markieren…'}
      </button>

      {open && review.eligible && e && (
        <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
          <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '3px 14px', margin: 0 }}>
            <dt style={{ color: MUTED }}>Verbindungszustand</dt>
            <dd style={{ margin: 0 }}>
              {e.connectionState ?? 'keiner'} (Grund {e.connectionStateReason ?? 'keiner'}, seit {stamp(e.connectionStateSince)})
            </dd>
            <dt style={{ color: MUTED }}>Abgeleiteter Status</dt>
            <dd style={{ margin: 0 }}>{e.derivedStatus ?? 'unbekannt'}</dd>
            <dt style={{ color: MUTED }}>Letzter Webhook</dt>
            <dd style={{ margin: 0 }}>{stamp(e.lastWebhookAt)}</dd>
            <dt style={{ color: MUTED }}>Letzter API-Erfolg</dt>
            <dd style={{ margin: 0 }}>{stamp(e.lastApiOkAt)}</dd>
            <dt style={{ color: MUTED }}>Letzter Besuch</dt>
            <dd style={{ margin: 0 }}>{stamp(e.lastActivityAt)}</dd>
            <dt style={{ color: MUTED }}>Letzte Anmeldung</dt>
            <dd style={{ margin: 0 }}>{stamp(e.lastAuthAt)}</dd>
            <dt style={{ color: MUTED }}>Wiederinstallations-Beleg</dt>
            <dd style={{ margin: 0 }}>{stamp(e.reinstallEvidenceAt)}</dd>
            <dt style={{ color: MUTED }}>Offline-Sessions</dt>
            <dd style={{ margin: 0 }}>
              {e.sessionsTotal} (Token vorhanden: {yesNo(e.hasToken)}, Refresh-Token vorhanden: {yesNo(e.hasRefreshToken)})
            </dd>
            <dt style={{ color: MUTED }}>Token-Migration</dt>
            <dd style={{ margin: 0 }}>{e.migration ?? 'keine'}</dd>
          </dl>
          <div style={{ color: MUTED }}>
            Nach dem Markieren löscht die Datenbereinigung die Daten des Shops, sobald die Aufbewahrungsfrist
            abgelaufen ist (standardmässig 30 Tage). Meldet sich der Shop vorher neu an (Wiederinstallation),
            wird die Markierung aufgehoben und der Shop ist wieder aktiv.
          </div>
          <fetcher.Form method="post" action="/admin">
            <input type="hidden" name="intent" value="mark-uninstalled" />
            <input type="hidden" name="shop" value={review.shop} />
            <div style={{ marginBottom: 6 }}>
              Zum Bestätigen die Shop-Domain exakt eintippen: <code>{review.shop}</code>
            </div>
            <input
              name="confirm"
              value={typed}
              onChange={(ev) => setTyped(ev.target.value)}
              placeholder={review.shop}
              autoComplete="off"
              style={{ padding: '6px 8px', border: '1px solid #babfc3', borderRadius: 4, fontSize: 13, width: 320, marginRight: 8 }}
            />
            <button
              type="submit"
              disabled={!canSubmit}
              style={{
                padding: '6px 12px',
                border: 'none',
                background: canSubmit ? DANGER : '#9b9b9b',
                color: 'white',
                borderRadius: 4,
                cursor: canSubmit ? 'pointer' : 'default',
                fontSize: 13,
              }}
            >
              {busy ? 'Markiere…' : 'Endgültig markieren'}
            </button>
          </fetcher.Form>
        </div>
      )}
      {fetcher.data?.ok && <div style={{ color: '#108043', marginTop: 6 }}>✓ {fetcher.data.ok}</div>}
      {fetcher.data?.error && <div style={{ color: DANGER, marginTop: 6 }}>✗ {fetcher.data.error}</div>}
    </div>
  );
}
