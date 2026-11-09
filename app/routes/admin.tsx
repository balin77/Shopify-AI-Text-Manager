/**
 * Standalone-Admin-Seite — bewusst NICHT über Shopify/App Bridge.
 *
 * Zweck: Test-/Betriebs-Werkzeug. Listet alle bekannten Shops mit Kennzahlen
 * (Produkte, Plan, Speicherverbrauch, Install-Status) und erlaubt pro Shop das
 * vollständige Löschen aller Shop-Daten (Testzwecke).
 *
 * Schutz: Eigenes Passwort-Formular + signiertes, httpOnly-Cookie. Bewusst
 * KEIN HTTP Basic Auth — eine im Loader geworfene 401-Response würde von der
 * Root-ErrorBoundary (app/root.tsx) abgefangen, wodurch der WWW-Authenticate-
 * Header verloren geht und der Browser nie einen Login-Dialog zeigt. Das
 * Formular ist vollständig in dieser Route gekapselt und unabhängig davon.
 *
 * Passwort/Signatur stammen aus process.env.ADMIN_PASSWORD. Ist die Variable
 * nicht gesetzt, ist die Seite komplett gesperrt (kein Default-Passwort).
 *
 * Das eigentliche Löschen verwendet die bereits durch Tests abgesicherte
 * redactShopData()-Transaktion aus gdpr.service (dieselbe Logik wie der
 * shop/redact-GDPR-Webhook), damit es genau eine Quelle der Wahrheit für
 * „alle Daten eines Shops löschen" gibt.
 */

import { useState } from 'react';
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { data as json, redirect } from "react-router";
import { useLoaderData, useActionData, Form, useNavigation, useFetcher } from "react-router";
import { db } from '~/db.server';
import { redactShopData } from '~/services/gdpr.service';
import {
  loadAuditDetail,
  loadAuditRows,
  loadShopRows,
  loadShopStorage,
  type AuditDetail,
  type AuditRow,
  type ShopRow,
} from '~/services/admin/shop-overview.server';
import { logger } from '~/utils/logger.server';
import { adminLoginLimiter, clientIpFromRequest } from '~/utils/admin-login-limiter.server';
import {
  ADMIN_PASSWORD_MIN_LENGTH,
  ADMIN_SECURITY_HEADERS,
  adminPassword,
  adminPasswordState,
  constantTimeEqual,
  isAdminAuthenticated,
  serializeAdminLogout,
  serializeAdminSession,
} from '~/utils/admin-auth.server';

const baseHeaders = (extra: Record<string, string> = {}) => ({
  ...ADMIN_SECURITY_HEADERS,
  'Cache-Control': 'no-store',
  ...extra,
});

// React Router builds document and .data headers ONLY from this return value
// (Set-Cookie is merged on top), so everything that must reach the client
// has to be named here.
export const headers = ({
  loaderHeaders,
  actionHeaders,
  errorHeaders,
}: {
  loaderHeaders?: Headers;
  actionHeaders?: Headers;
  errorHeaders?: Headers;
} = {}) => {
  const out: Record<string, string> = { ...ADMIN_SECURITY_HEADERS, 'Cache-Control': 'no-store' };
  const retryAfter =
    actionHeaders?.get('Retry-After') ??
    loaderHeaders?.get('Retry-After') ??
    errorHeaders?.get('Retry-After');
  if (retryAfter) out['Retry-After'] = retryAfter;
  return out;
};

export function ErrorBoundary() {
  return (
    <div style={{ fontFamily: 'sans-serif', padding: 24 }}>
      <h1 style={{ fontSize: 20 }}>ContentPilot — Admin</h1>
      <p>Es ist ein Fehler aufgetreten.</p>
    </div>
  );
}

/** True for a browser navigation, false for the router's own data fetches. */
function isDocumentRequest(request: Request): boolean {
  const dest = request.headers.get('Sec-Fetch-Dest');
  if (dest) return dest === 'document' || dest === 'iframe';
  return (request.headers.get('Accept') ?? '').includes('text/html');
}

type LoaderData =
  | { authed: false; configured: boolean; tooShort: boolean; noSecret: boolean; minLength: number }
  | { authed: true; rows: ShopRow[]; audits: AuditRow[] };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // The on-demand detail is answered to the page's fetcher only; a direct
  // visit (link, reload) goes back to the plain page.
  const params = new URL(request.url).searchParams;
  const isDetail = params.has('audit') || params.has('storage');
  if (isDetail && isDocumentRequest(request)) {
    return redirect('/admin', { headers: baseHeaders() });
  }
  if (!(await isAdminAuthenticated(request))) {
    if (isDetail) {
      return json({ error: 'Nicht angemeldet.' }, { status: 401, headers: baseHeaders() });
    }
    return json<LoaderData>(
      {
        authed: false,
        configured: adminPassword() !== null,
        tooShort: adminPasswordState() === 'too-short',
        noSecret: adminPasswordState() === 'no-secret',
        minLength: ADMIN_PASSWORD_MIN_LENGTH,
      },
      { headers: baseHeaders() },
    );
  }
  const storageShop = params.get('storage');
  if (storageShop !== null) {
    if (!storageShop) {
      return json({ error: 'Kein Shop angegeben.' }, { status: 400, headers: baseHeaders() });
    }
    return json({ storage: await loadShopStorage(storageShop) }, { headers: baseHeaders() });
  }
  const auditId = params.get('audit');
  if (auditId !== null) {
    const detail = auditId ? await loadAuditDetail(auditId) : null;
    if (!detail) {
      return json({ error: 'Eintrag nicht gefunden.' }, { status: 404, headers: baseHeaders() });
    }
    return json({ detail }, { headers: baseHeaders() });
  }
  const [rows, audits] = await Promise.all([loadShopRows(), loadAuditRows()]);
  return json<LoaderData>({ authed: true, rows, audits }, { headers: baseHeaders() });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const form = await request.formData();
  const intent = form.get('intent');

  // --- Login ---
  if (intent === 'login') {
    const expected = adminPassword();
    if (!expected) {
      return json(
        {
          error:
            adminPasswordState() === 'too-short'
              ? `Admin-Seite gesperrt: ADMIN_PASSWORD hat weniger als ${ADMIN_PASSWORD_MIN_LENGTH} Zeichen.`
              : adminPasswordState() === 'no-secret'
                ? 'Admin-Seite gesperrt: SHOPIFY_API_SECRET ist nicht gesetzt.'
                : 'Admin-Seite gesperrt: ADMIN_PASSWORD ist nicht gesetzt.',
        },
        { status: 503, headers: baseHeaders() },
      );
    }
    // Brute-force guard (admin-login-limiter.server.ts): failed attempts are
    // counted per client IP and globally; a locked caller is refused BEFORE
    // the password is compared, so a lockout cannot be probed for a hit.
    const clientIp = clientIpFromRequest(request);
    const limit = adminLoginLimiter.check(clientIp);
    if (!limit.allowed) {
      logger.warn('[ADMIN] Login gesperrt (zu viele Fehlversuche)', { clientIp });
      const minutes = Math.max(1, Math.ceil(limit.retryAfterSec / 60));
      return json(
        { error: `Zu viele Fehlversuche. Bitte in ${minutes} Minute(n) erneut versuchen.` },
        { status: 429, headers: baseHeaders({ 'Retry-After': String(limit.retryAfterSec) }) },
      );
    }
    const pw = String(form.get('password') ?? '');
    if (!constantTimeEqual(pw, expected)) {
      adminLoginLimiter.recordFailure(clientIp);
      logger.warn('[ADMIN] Falsches Passwort', { clientIp });
      return json({ error: 'Falsches Passwort.' }, { status: 401, headers: baseHeaders() });
    }
    adminLoginLimiter.recordSuccess(clientIp);
    logger.info('[ADMIN] Erfolgreiche Anmeldung', { clientIp });
    return redirect('/admin', {
      headers: baseHeaders({ 'Set-Cookie': await serializeAdminSession() }),
    });
  }

  // --- Logout --- (immer möglich, auch ohne gültige Session: Cookie weg)
  if (intent === 'logout') {
    return redirect('/admin', {
      headers: baseHeaders({ 'Set-Cookie': await serializeAdminLogout() }),
    });
  }

  // Alle übrigen Aktionen erfordern eine gültige Session.
  if (!(await isAdminAuthenticated(request))) {
    return json({ error: 'Nicht angemeldet.' }, { status: 401, headers: baseHeaders() });
  }

  // --- Shop-Daten löschen ---
  if (intent === 'delete-shop') {
    const shop = String(form.get('shop') ?? '');
    const confirm = String(form.get('confirm') ?? '');
    if (!shop) {
      return json({ error: 'Kein Shop angegeben.' }, { status: 400, headers: baseHeaders() });
    }
    if (confirm !== shop) {
      return json(
        {
          error: `Bestätigung stimmt nicht. Tippe exakt "${shop}" ins Bestätigungsfeld.`,
        },
        { status: 400, headers: baseHeaders() },
      );
    }
    try {
      logger.warn(`[ADMIN] Manuelles vollständiges Löschen aller Daten für ${shop}`);
      await redactShopData({ shop_id: 0, shop_domain: shop });
      return json({ ok: `Alle Daten für ${shop} wurden gelöscht.` }, { headers: baseHeaders() });
    } catch (error) {
      logger.error('[ADMIN] Löschen fehlgeschlagen', {
        shop,
        error: error instanceof Error ? error.message : String(error),
      });
      return json(
        {
          error: `Löschen fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`,
        },
        { status: 500, headers: baseHeaders() },
      );
    }
  }

  return json({ error: 'Unbekannte Aktion.' }, { status: 400, headers: baseHeaders() });
};

const TD: React.CSSProperties = {
  padding: '8px 10px',
  borderBottom: '1px solid #e1e3e5',
  fontSize: 13,
  whiteSpace: 'nowrap',
};
const TH: React.CSSProperties = {
  ...TD,
  textAlign: 'left',
  background: '#f6f6f7',
  fontWeight: 600,
  position: 'sticky',
  top: 0,
};
const PAGE: React.CSSProperties = {
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  padding: 24,
  maxWidth: 1200,
  margin: '0 auto',
  color: '#202223',
};

function LoginView({ configured, tooShort, noSecret, minLength }: { configured: boolean; tooShort: boolean; noSecret: boolean; minLength: number }) {
  const actionData = useActionData<typeof action>();
  return (
    <div style={{ ...PAGE, maxWidth: 380 }}>
      <h1 style={{ fontSize: 20 }}>ContentPilot — Admin</h1>
      {!configured && (
        <div
          style={{
            background: '#fbeae5',
            border: '1px solid #e0b3a8',
            padding: '10px 12px',
            borderRadius: 4,
            fontSize: 13,
          }}
        >
          {noSecret ? (
            <>
              Gesperrt: <code>SHOPIFY_API_SECRET</code> ist nicht gesetzt.
            </>
          ) : tooShort ? (
            <>
              Gesperrt: <code>ADMIN_PASSWORD</code> hat weniger als{' '}
              {minLength} Zeichen.
            </>
          ) : (
            <>
              Gesperrt: Umgebungsvariable <code>ADMIN_PASSWORD</code> ist nicht
              gesetzt.
            </>
          )}
        </div>
      )}
      {configured && (
        <Form method="post" replace>
          <input type="hidden" name="intent" value="login" />
          <input
            type="password"
            name="password"
            placeholder="Passwort"
            autoFocus
            autoComplete="current-password"
            style={{
              width: '100%',
              padding: '8px 10px',
              border: '1px solid #babfc3',
              borderRadius: 4,
              fontSize: 14,
              marginBottom: 10,
              boxSizing: 'border-box',
            }}
          />
          {actionData && 'error' in actionData && actionData.error && (
            <div style={{ color: '#bf0711', fontSize: 13, marginBottom: 10 }}>
              {actionData.error}
            </div>
          )}
          <button
            type="submit"
            style={{
              width: '100%',
              padding: '9px 0',
              border: 'none',
              background: '#008060',
              color: 'white',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            Anmelden
          </button>
        </Form>
      )}
    </div>
  );
}

function ShopRowView({ row }: { row: ShopRow }) {
  const [open, setOpen] = useState(false);
  const nav = useNavigation();
  const busy = nav.state !== 'idle' && nav.formData?.get('shop') === row.shop;
  // Storage is detail data: loaded on click through the page's own loader.
  const storage = useFetcher<{ storage?: { storageMB: number }; error?: string }>();
  const storageLoading = storage.state !== 'idle';

  return (
    <>
      <tr>
        <td style={TD}>
          <strong>{row.shop}</strong>
          {!row.hasSession && (
            <span style={{ color: '#8a6116', marginLeft: 6 }}>
              (keine Session)
            </span>
          )}
          {row.uninstalledAt && (
            <span style={{ color: '#bf0711', marginLeft: 6 }}>
              deinstalliert {row.uninstalledAt.slice(0, 10)}
            </span>
          )}
        </td>
        <td style={TD}>
          {row.plan}
          {row.devForcedPlan && (
            <span style={{ color: '#5c5f62' }}> (forced: {row.devForcedPlan})</span>
          )}
        </td>
        <td style={TD}>{row.products}</td>
        <td style={TD}>{row.collections}</td>
        <td style={TD}>{row.articles}</td>
        <td style={TD}>{row.pages}</td>
        <td style={TD}>{row.tasks}</td>
                <td style={TD}>{row.initialSyncCompletedAt ? '✓' : '—'}</td>
        <td style={TD}>
          <button
            type="button"
            disabled={storageLoading}
            onClick={() => storage.load(`/admin?storage=${encodeURIComponent(row.shop)}`)}
            style={{
              padding: '5px 10px',
              border: '1px solid #babfc3',
              background: 'white',
              borderRadius: 4,
              cursor: storageLoading ? 'default' : 'pointer',
              fontSize: 12,
              marginRight: 6,
            }}
          >
            {storageLoading
              ? 'Lade…'
              : storage.data?.storage
                ? `${storage.data.storage.storageMB} MB`
                : storage.data?.error
                  ? storage.data.error
                  : 'Speicher'}
          </button>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            style={{
              padding: '5px 10px',
              border: '1px solid #bf0711',
              color: '#bf0711',
              background: 'white',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            Alle Daten löschen…
          </button>
        </td>
      </tr>
      {open && (
        <tr>
          <td style={{ ...TD, background: '#fff4f4' }} colSpan={9}>
            <Form method="post" replace>
              <input type="hidden" name="intent" value="delete-shop" />
              <input type="hidden" name="shop" value={row.shop} />
              <div style={{ fontSize: 13, marginBottom: 6 }}>
                Unwiderruflich. Zum Bestätigen die Shop-Domain exakt eintippen:{' '}
                <code>{row.shop}</code>
              </div>
              <input
                name="confirm"
                placeholder={row.shop}
                autoComplete="off"
                style={{
                  padding: '6px 8px',
                  border: '1px solid #babfc3',
                  borderRadius: 4,
                  fontSize: 13,
                  width: 320,
                  marginRight: 8,
                }}
              />
              <button
                type="submit"
                disabled={busy}
                style={{
                  padding: '6px 12px',
                  border: 'none',
                  background: busy ? '#9b9b9b' : '#bf0711',
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

function AuditRowView({ audit: a }: { audit: AuditRow }) {
  const fetcher = useFetcher<{ detail?: AuditDetail; error?: string }>();
  const detail = fetcher.data?.detail;
  const loading = fetcher.state !== 'idle';
  return (
    <>
      <tr>
        <td style={TD}>
          <strong>{a.shop}</strong>
        </td>
        <td style={TD}>{a.requestType}</td>
        <td style={TD}>
          <span style={{ color: a.status === 'completed' ? '#108043' : '#bf0711' }}>
            {a.status}
          </span>
        </td>
        <td style={TD}>{a.requestedAt.replace('T', ' ').slice(0, 19)}</td>
        <td style={TD}>
          <button
            type="button"
            disabled={loading}
            onClick={() => fetcher.load(`/admin?audit=${encodeURIComponent(a.id)}`)}
            style={{
              padding: '4px 10px',
              border: '1px solid #babfc3',
              background: 'white',
              borderRadius: 4,
              cursor: loading ? 'default' : 'pointer',
              fontSize: 12,
            }}
          >
            {loading ? 'Lade…' : 'Details laden'}
          </button>
        </td>
      </tr>
      {(detail || fetcher.data?.error) && (
        <tr>
          <td style={{ ...TD, whiteSpace: 'normal', background: '#f6f6f7' }} colSpan={5}>
            {fetcher.data?.error && (
              <span style={{ color: '#bf0711' }}>{fetcher.data.error}</span>
            )}
            {detail && (
              <div>
                <div>Kunde: {detail.customerEmail ?? '—'}</div>
                {detail.error && (
                  <div style={{ color: '#bf0711' }}>Fehler: {detail.error}</div>
                )}
                {detail.dataExported ? (
                  <details open>
                    <summary style={{ cursor: 'pointer' }}>
                      Exportierte Daten
                      {detail.webhookId ? ` (id ${detail.webhookId.slice(0, 8)}…)` : ''}
                    </summary>
                    <a
                      href={`data:application/json;charset=utf-8,${encodeURIComponent(
                        detail.dataExported,
                      )}`}
                      download={`gdpr-data-request-${detail.shop}-${detail.id}.json`}
                    >
                      Download JSON
                    </a>
                    <pre
                      style={{
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all',
                        maxHeight: 240,
                        overflow: 'auto',
                        background: '#fff',
                        padding: 8,
                        marginTop: 6,
                      }}
                    >
                      {detail.dataExported}
                    </pre>
                  </details>
                ) : (
                  <div>Keine exportierten Daten.</div>
                )}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export default function AdminPage() {
  const data = useLoaderData() as LoaderData;
  const actionData = useActionData<typeof action>();

  if (!data.authed) {
    return <LoginView configured={data.configured} tooShort={data.tooShort} noSecret={data.noSecret} minLength={data.minLength} />;
  }

  const { rows, audits } = data;
  return (
    <div style={PAGE}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
        }}
      >
        <div>
          <h1 style={{ fontSize: 22, marginBottom: 4 }}>
            ContentPilot — Admin
          </h1>
          <p style={{ color: '#5c5f62', marginTop: 0, fontSize: 13 }}>
            {rows.length} Shop(s). Diese Seite läuft außerhalb von Shopify.
          </p>
        </div>
        <Form method="post" replace>
          <input type="hidden" name="intent" value="logout" />
          <button
            type="submit"
            style={{
              padding: '6px 12px',
              border: '1px solid #babfc3',
              background: 'white',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            Abmelden
          </button>
        </Form>
      </div>

      {actionData && 'ok' in actionData && actionData.ok && (
        <div
          style={{
            background: '#e3f1df',
            border: '1px solid #aee9d1',
            padding: '10px 12px',
            borderRadius: 4,
            margin: '12px 0',
            fontSize: 13,
          }}
        >
          ✓ {actionData.ok}
        </div>
      )}
      {actionData && 'error' in actionData && actionData.error && (
        <div
          style={{
            background: '#fbeae5',
            border: '1px solid #e0b3a8',
            padding: '10px 12px',
            borderRadius: 4,
            margin: '12px 0',
            fontSize: 13,
          }}
        >
          ✗ {actionData.error}
        </div>
      )}

      <div
        style={{
          overflowX: 'auto',
          border: '1px solid #e1e3e5',
          borderRadius: 6,
        }}
      >
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th style={TH}>Shop</th>
              <th style={TH}>Plan</th>
              <th style={TH}>Produkte</th>
              <th style={TH}>Collections</th>
              <th style={TH}>Artikel</th>
              <th style={TH}>Seiten</th>
              <th style={TH}>Tasks</th>
              <th style={TH}>Sync</th>
              <th style={TH}>Aktion</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td style={TD} colSpan={9}>
                  Keine Shops gefunden.
                </td>
              </tr>
            ) : (
              rows.map((r) => <ShopRowView key={r.shop} row={r} />)
            )}
          </tbody>
        </table>
      </div>

      <h2 style={{ fontSize: 18, margin: '28px 0 4px' }}>
        GDPR-Audit-Log
      </h2>
      <p style={{ color: '#5c5f62', marginTop: 0, fontSize: 13 }}>
        Letzte {audits.length} Einträge. Diese Tabelle überlebt das Löschen
        bewusst (3-Jahres-Aufbewahrung) — hier siehst du auch bereits
        vollständig gelöschte Shops.
      </p>
      <div
        style={{
          overflowX: 'auto',
          border: '1px solid #e1e3e5',
          borderRadius: 6,
        }}
      >
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th style={TH}>Shop</th>
              <th style={TH}>Typ</th>
              <th style={TH}>Status</th>
              <th style={TH}>Zeitpunkt</th>
              <th style={TH}>Details</th>
            </tr>
          </thead>
          <tbody>
            {audits.length === 0 ? (
              <tr>
                <td style={TD} colSpan={5}>
                  Keine Audit-Einträge.
                </td>
              </tr>
            ) : (
              audits.map((a) => <AuditRowView key={a.id} audit={a} />)
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
