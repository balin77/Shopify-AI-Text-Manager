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

export const headers = () => ({ ...ADMIN_SECURITY_HEADERS });

interface ShopRow {
  shop: string;
  plan: string;
  devForcedPlan: string | null;
  products: number;
  collections: number;
  articles: number;
  pages: number;
  tasks: number;
  hasSession: boolean;
  uninstalledAt: string | null;
  initialSyncCompletedAt: string | null;
  storageMB: number;
}

interface AuditRow {
  id: string;
  shop: string;
  requestType: string;
  status: string;
  requestedAt: string;
  completedAt: string;
}

// Loaded only on click (GET /admin?audit=<id>), never with the page: it holds
// the customer e-mail and the full data_request export (R5-G1: the export must
// stay retrievable so the request can be fulfilled).
interface AuditDetail {
  id: string;
  shop: string;
  customerEmail: string | null;
  error: string | null;
  dataExported: string | null;
  webhookId: string | null;
}

type LoaderData =
  | { authed: false; configured: boolean; tooShort: boolean; minLength: number }
  | { authed: true; rows: ShopRow[]; audits: AuditRow[] };

async function loadAuditRows(): Promise<AuditRow[]> {
  // GdprAuditLog überlebt redactShopData bewusst (3-Jahres-Aufbewahrung).
  // Hier separat anzeigen, da der Shop sonst nach Löschung nirgends auftaucht.
  const logs = await db.gdprAuditLog.findMany({
    orderBy: { requestedAt: 'desc' },
    take: 200,
    select: {
      id: true,
      shop: true,
      requestType: true,
      status: true,
      requestedAt: true,
      completedAt: true,
    },
  });
  return logs.map((l) => ({
    id: l.id,
    shop: l.shop,
    requestType: l.requestType,
    status: l.status,
    requestedAt: l.requestedAt.toISOString(),
    completedAt: l.completedAt.toISOString(),
  }));
}

async function loadAuditDetail(id: string): Promise<AuditDetail | null> {
  const l = await db.gdprAuditLog.findUnique({
    where: { id },
    select: {
      id: true,
      shop: true,
      customerEmail: true,
      error: true,
      dataExported: true,
      webhookId: true,
    },
  });
  return l;
}

async function loadShopRows(): Promise<ShopRow[]> {
  // Shop-Liste aus allen Quellen zusammenführen — ein Shop kann existieren
  // ohne aktive Session (deinstalliert) oder ohne ShopInstallState (alt).
  const [sessionShops, installStates, aiSettings] = await Promise.all([
    db.session.findMany({ distinct: ['shop'], select: { shop: true } }),
    db.shopInstallState.findMany(),
    db.aISettings.findMany({
      select: { shop: true, subscriptionPlan: true, devForcedPlan: true },
    }),
  ]);

  const shops = new Set<string>();
  sessionShops.forEach((s) => shops.add(s.shop));
  installStates.forEach((s) => shops.add(s.shop));
  aiSettings.forEach((s) => shops.add(s.shop));

  const sessionShopSet = new Set(sessionShops.map((s) => s.shop));
  const installByShop = new Map(installStates.map((s) => [s.shop, s]));
  const aiByShop = new Map(aiSettings.map((s) => [s.shop, s]));

  const rows: ShopRow[] = [];
  for (const shop of [...shops].sort()) {
    const [products, collections, articles, pages, tasks, sizeRows] =
      await Promise.all([
        db.product.count({ where: { shop } }),
        db.collection.count({ where: { shop } }),
        db.article.count({ where: { shop } }),
        db.page.count({ where: { shop } }),
        db.task.count({ where: { shop } }),
        // Grobe Größenschätzung der Textinhalte (Bytes) des Shops.
        db.$queryRaw<Array<{ bytes: bigint }>>`
          SELECT
            (SELECT COALESCE(SUM(octet_length(COALESCE(title,'')) + octet_length(COALESCE("descriptionHtml",''))),0) FROM "Product" WHERE shop = ${shop})
          + (SELECT COALESCE(SUM(octet_length(COALESCE(title,'')) + octet_length(COALESCE("descriptionHtml",''))),0) FROM "Collection" WHERE shop = ${shop})
          + (SELECT COALESCE(SUM(octet_length(COALESCE(title,'')) + octet_length(COALESCE(body,''))),0) FROM "Article" WHERE shop = ${shop})
          + (SELECT COALESCE(SUM(octet_length(COALESCE(title,'')) + octet_length(COALESCE(body,''))),0) FROM "Page" WHERE shop = ${shop})
          + (SELECT COALESCE(SUM(octet_length(COALESCE(value,''))),0) FROM "ContentTranslation" WHERE shop = ${shop})
          + (SELECT COALESCE(SUM(octet_length(COALESCE(value,''))),0) FROM "ThemeTranslation" WHERE shop = ${shop})
          AS bytes`,
      ]);

    const install = installByShop.get(shop);
    const ai = aiByShop.get(shop);
    rows.push({
      shop,
      plan: ai?.subscriptionPlan ?? '—',
      devForcedPlan: ai?.devForcedPlan ?? null,
      products,
      collections,
      articles,
      pages,
      tasks,
      hasSession: sessionShopSet.has(shop),
      uninstalledAt: install?.uninstalledAt?.toISOString() ?? null,
      initialSyncCompletedAt:
        install?.initialSyncCompletedAt?.toISOString() ?? null,
      storageMB:
        Math.round((Number(sizeRows[0]?.bytes ?? 0) / (1024 * 1024)) * 1000) /
        1000,
    });
  }
  return rows;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!(await isAdminAuthenticated(request))) {
    if (new URL(request.url).searchParams.has('audit')) {
      return json({ error: 'Nicht angemeldet.' }, { status: 401, headers: baseHeaders() });
    }
    return json<LoaderData>(
      {
        authed: false,
        configured: adminPassword() !== null,
        tooShort: adminPasswordState() === 'too-short',
        minLength: ADMIN_PASSWORD_MIN_LENGTH,
      },
      { headers: baseHeaders() },
    );
  }
  const auditId = new URL(request.url).searchParams.get('audit');
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

function LoginView({ configured, tooShort, minLength }: { configured: boolean; tooShort: boolean; minLength: number }) {
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
          {tooShort ? (
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
        <td style={TD}>{row.storageMB} MB</td>
        <td style={TD}>{row.initialSyncCompletedAt ? '✓' : '—'}</td>
        <td style={TD}>
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
          <td style={{ ...TD, background: '#fff4f4' }} colSpan={10}>
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
    return <LoginView configured={data.configured} tooShort={data.tooShort} minLength={data.minLength} />;
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
              <th style={TH}>Speicher</th>
              <th style={TH}>Sync</th>
              <th style={TH}>Aktion</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td style={TD} colSpan={10}>
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
