/**
 * The shop table of /admin (PLAN_ADMIN_SHOP_OVERVIEW 3.5): header area with a
 * counter per traffic-light colour (also the filter), search and three pill
 * switches; sortable columns; a detail row per shop loaded on click.
 *
 * Filtering and sorting happen here in the client, the loader does not re-run.
 * Everything time-shaped is computed against the LOADER's `now` and rendered as
 * fixed text, so server and hydrating client agree. Approximate figures say so.
 */

import { useState } from 'react';
import { Form, useFetcher, useNavigation } from 'react-router';
import { ToggleSwitch } from '~/components/ToggleSwitch';
import {
  NO_FILTERS,
  countByColor,
  filterRows,
  formatMicros,
  relativeAge,
  sortRows,
  utcStamp,
  type OverviewHeader,
  type ShopDetail,
  type ShopFilters,
  type ShopRow,
  type SortDir,
  type SortKey,
} from '~/services/admin/shop-overview.shared';
import { COLOR_LABELS, type ShopStatusColor } from '~/services/admin/shop-status.shared';
import { BUTTON, DANGER, MUTED, STATUS_DOT, STATUS_TINT, TD, TH } from './admin-styles';
import { ShopDetailPanel } from './ShopDetailPanel';

const COLORS: ShopStatusColor[] = ['red', 'yellow', 'green', 'grey'];

function StatusCell({ row }: { row: ShopRow }) {
  const s = row.status;
  return (
    <span title={s.reasons.length ? s.reasons.join('\n') : s.colorLabel} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {/* Colour is never the only carrier: the word is always there. */}
      <span
        aria-hidden="true"
        style={{ width: 10, height: 10, borderRadius: '50%', background: STATUS_DOT[s.color], display: 'inline-block' }}
      />
      {s.colorLabel}
    </span>
  );
}

function ToggleLine({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  // Words beside the switch, never inside a label around it (the switch is one).
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
      <ToggleSwitch checked={checked} onChange={onChange} ariaLabel={label} />
      <span>{label}</span>
    </div>
  );
}

function installText(row: ShopRow): string {
  if (row.onlyInWebhookLog) return 'nur im Webhook-Protokoll';
  if (row.uninstalledAt) return `deinstalliert ${row.uninstalledAt.slice(0, 10)}`;
  return row.initialSyncCompletedAt ? 'installiert' : 'installiert, Sync offen';
}

function ShopRowView({ row, nowMs, cols }: { row: ShopRow; nowMs: number; cols: number }) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const nav = useNavigation();
  const busy = nav.state !== 'idle' && nav.formData?.get('shop') === row.shop;
  // The detail is loaded on click through the page's own loader (`?detail=`).
  const detail = useFetcher<{ detail?: ShopDetail; error?: string }>();
  const detailLoading = detail.state !== 'idle';
  const lastOpened = row.status.lastOpenedMs;

  const toggleDetail = () => {
    if (!detailOpen && !detail.data?.detail) detail.load(`/admin?detail=${encodeURIComponent(row.shop)}`);
    setDetailOpen((v) => !v);
  };

  return (
    <>
      <tr>
        <td style={TD}><StatusCell row={row} /></td>
        <td style={TD}>
          <strong>{row.shop}</strong>
          {!row.hasSession && !row.onlyInWebhookLog && <span style={{ color: '#8a6116', marginLeft: 6 }}>(keine Session)</span>}
        </td>
        <td style={TD}>{installText(row)}</td>
        <td style={TD} title={lastOpened === null ? undefined : utcStamp(row.lastOpenedAt)}>
          {relativeAge(lastOpened, nowMs)}
          {row.lastOpenedApprox && <span style={{ color: MUTED }}> (ungefähr)</span>}
        </td>
        <td style={TD}>{row.activeDays7} / {row.activeDays30}</td>
        <td style={TD}>{row.actions7} / {row.actions30}</td>
        <td style={TD}>
          {row.tasks7} / {row.tasks30}
          {row.tasksFailed30 > 0 && <span style={{ color: DANGER }}> ({row.tasksFailed7} / {row.tasksFailed30} Fehler)</span>}
        </td>
        <td style={TD}>{formatMicros(row.aiCostMicrosMonth)}</td>
        <td style={TD}>{row.imageOpsMonth}</td>
        <td style={TD}>
          {row.webhooks24h.total}
          {row.webhooks24h.failed > 0 && <span style={{ color: DANGER }}> ({row.webhooks24h.failed} Fehler)</span>}
          {row.webhooksPaused && <span style={{ color: '#8a6116' }}> pausiert, {row.droppedWebhooks} verworfen</span>}
        </td>
        <td style={TD}>{row.status.tokenLabel}</td>
        <td style={TD}>
          {row.plan}
          {row.devForcedPlan && <span style={{ color: MUTED }}> (forced: {row.devForcedPlan})</span>}
        </td>
        <td style={TD} title="Produkte / Collections / Artikel / Seiten">
          {row.products} / {row.collections} / {row.articles} / {row.pages}
        </td>
        <td style={TD}>
          <button type="button" onClick={toggleDetail} style={{ ...BUTTON, marginRight: 6 }} aria-expanded={detailOpen}>
            {detailLoading ? 'Lade…' : detailOpen ? 'Details zu' : 'Details'}
          </button>
          <button type="button" onClick={() => setDeleteOpen((v) => !v)} style={{ ...BUTTON, border: `1px solid ${DANGER}`, color: DANGER }}>
            Alle Daten löschen…
          </button>
        </td>
      </tr>
      {detailOpen && (
        <tr>
          <td style={{ ...TD, whiteSpace: 'normal', background: '#f6f6f7' }} colSpan={cols}>
            {detail.data?.error && <span style={{ color: DANGER }}>{detail.data.error}</span>}
            {detail.data?.detail ? (
              <ShopDetailPanel detail={detail.data.detail} />
            ) : (
              !detail.data?.error && <span>Lade…</span>
            )}
          </td>
        </tr>
      )}
      {deleteOpen && (
        <tr>
          <td style={{ ...TD, background: '#fff4f4' }} colSpan={cols}>
            <Form method="post" replace>
              <input type="hidden" name="intent" value="delete-shop" />
              <input type="hidden" name="shop" value={row.shop} />
              <div style={{ fontSize: 13, marginBottom: 6 }}>
                Unwiderruflich. Zum Bestätigen die Shop-Domain exakt eintippen: <code>{row.shop}</code>
              </div>
              <input
                name="confirm"
                placeholder={row.shop}
                autoComplete="off"
                style={{ padding: '6px 8px', border: '1px solid #babfc3', borderRadius: 4, fontSize: 13, width: 320, marginRight: 8 }}
              />
              <button
                type="submit"
                disabled={busy}
                style={{
                  padding: '6px 12px',
                  border: 'none',
                  background: busy ? '#9b9b9b' : DANGER,
                  color: 'white',
                  borderRadius: 4,
                  cursor: busy ? 'default' : 'pointer',
                  fontSize: 13,
                }}
              >
                {busy ? 'Lösche…' : 'Endgültig löschen'}
              </button>
            </Form>
          </td>
        </tr>
      )}
    </>
  );
}

const COLUMNS: Array<{ label: string; sort?: SortKey; title?: string }> = [
  { label: 'Status', sort: 'status' },
  { label: 'Shop', sort: 'shop' },
  { label: 'Installation' },
  { label: 'Zuletzt geöffnet', sort: 'lastOpened', title: 'Offene, ungenutzte Tabs zählen mit, Hintergrundabfragen nicht.' },
  { label: 'Aktive Tage 7 / 30', sort: 'activeDays30' },
  { label: 'Aktionen 7 / 30', sort: 'actions30', title: 'Anfragen, die nicht nur lesen.' },
  { label: 'Tasks 7 / 30', sort: 'tasks30' },
  { label: 'KI im Monat (ungefähr)', sort: 'ai', title: 'Kosten unseres Managed-AI-Schlüssels im laufenden Monat; eine Abrechnungsperiode zählt zum Monat, in dem sie endet. Der einmalige Taster ist nicht enthalten.' },
  { label: 'Bilder im Monat', sort: 'images' },
  { label: 'Webhooks 24 h', sort: 'webhooks' },
  { label: 'Token' },
  { label: 'Plan', sort: 'plan' },
  { label: 'Inhalte', sort: 'content', title: 'Produkte / Collections / Artikel / Seiten' },
  { label: 'Aktion' },
];

export function ShopOverviewTable({ rows, header, now }: { rows: ShopRow[]; header: OverviewHeader; now: string }) {
  const nowMs = Date.parse(now);
  const [filters, setFilters] = useState<ShopFilters>(NO_FILTERS);
  const [sortKey, setSortKey] = useState<SortKey>('status');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const counts = countByColor(rows);
  const visible = sortRows(filterRows(rows, filters, nowMs), sortKey, sortDir);

  const clickSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      // Text and status read best ascending, figures and recency largest first.
      setSortDir(key === 'status' || key === 'shop' || key === 'plan' ? 'asc' : 'desc');
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', margin: '12px 0' }}>
        {COLORS.map((c) => {
          const active = filters.color === c;
          return (
            <button
              key={c}
              type="button"
              aria-pressed={active}
              onClick={() => setFilters((f) => ({ ...f, color: active ? null : c }))}
              style={{
                ...BUTTON,
                fontSize: 13,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                background: active ? STATUS_TINT[c] : 'white',
                border: `1px solid ${active ? STATUS_DOT[c] : '#babfc3'}`,
              }}
            >
              <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: '50%', background: STATUS_DOT[c], display: 'inline-block' }} />
              {COLOR_LABELS[c]}: <strong>{counts[c]}</strong>
            </button>
          );
        })}
        <span style={{ fontSize: 13, color: MUTED }}>
          Webhooks 24 h: <strong>{header.webhooks24h.total}</strong>
          {header.webhooks24h.failed > 0 && <span style={{ color: DANGER }}> ({header.webhooks24h.failed} Fehler)</span>}
          {' · '}Managed AI im Monat (ungefähr): <strong>{formatMicros(header.managedAiCostMicrosMonth)}</strong>
        </span>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'center', margin: '0 0 12px' }}>
        <input
          type="search"
          value={filters.query}
          onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
          placeholder="Shop-Domain suchen"
          aria-label="Shop-Domain suchen"
          style={{ padding: '6px 8px', border: '1px solid #babfc3', borderRadius: 4, fontSize: 13, width: 260 }}
        />
        <ToggleLine label="Nur installiert" checked={filters.onlyInstalled} onChange={(v) => setFilters((f) => ({ ...f, onlyInstalled: v }))} />
        <ToggleLine label="Nur bezahlt" checked={filters.onlyPaid} onChange={(v) => setFilters((f) => ({ ...f, onlyPaid: v }))} />
        <ToggleLine label="Nur Token-Problem" checked={filters.onlyTokenProblem} onChange={(v) => setFilters((f) => ({ ...f, onlyTokenProblem: v }))} />
        <span style={{ fontSize: 13, color: MUTED }}>{visible.length} von {rows.length} Shop(s)</span>
      </div>

      <div style={{ overflowX: 'auto', border: '1px solid #e1e3e5', borderRadius: 6 }}>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.label}
                  style={TH}
                  title={c.title}
                  aria-sort={c.sort && c.sort === sortKey ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  {c.sort ? (
                    <button
                      type="button"
                      onClick={() => clickSort(c.sort!)}
                      style={{ all: 'unset', cursor: 'pointer', fontWeight: 600 }}
                    >
                      {c.label}
                      {c.sort === sortKey ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td style={TD} colSpan={COLUMNS.length}>
                  {rows.length === 0 ? 'Keine Shops gefunden.' : 'Kein Shop passt zu den Filtern.'}
                </td>
              </tr>
            ) : (
              visible.map((r) => <ShopRowView key={r.shop} row={r} nowMs={nowMs} cols={COLUMNS.length} />)
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
