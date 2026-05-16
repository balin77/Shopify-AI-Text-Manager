/**
 * Standalone-Admin-Seite — bewusst NICHT über Shopify/App Bridge.
 *
 * Zweck: Test-/Betriebs-Werkzeug. Listet alle bekannten Shops mit Kennzahlen
 * (Produkte, Plan, Speicherverbrauch, Install-Status) und erlaubt pro Shop das
 * vollständige Löschen aller Shop-Daten (Testzwecke).
 *
 * Schutz: HTTP Basic Auth gegen process.env.ADMIN_PASSWORD. Ist die Variable
 * nicht gesetzt, ist die Seite komplett gesperrt (kein Default-Passwort).
 *
 * Das eigentliche Löschen verwendet die bereits durch Tests abgesicherte
 * redactShopData()-Transaktion aus gdpr.service (dieselbe Logik wie der
 * shop/redact-GDPR-Webhook), damit es genau eine Quelle der Wahrheit für
 * „alle Daten eines Shops löschen" gibt.
 */

import { useState } from 'react';
import type { LoaderFunctionArgs, ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { useLoaderData, useActionData, Form, useNavigation } from '@remix-run/react';
import { timingSafeEqual } from 'node:crypto';
import { db } from '~/db.server';
import { redactShopData } from '~/services/gdpr.service';
import { logger } from '~/utils/logger.server';

const REALM = 'ContentPilot Admin';

/**
 * Prüft HTTP Basic Auth. Wirft eine 401-Response (mit WWW-Authenticate),
 * wenn kein/falsches Passwort vorliegt oder ADMIN_PASSWORD nicht gesetzt ist.
 * Benutzername wird ignoriert; nur das Passwort zählt.
 */
function requireBasicAuth(request: Request): void {
  const expected = process.env.ADMIN_PASSWORD;

  const deny = (msg: string, status: number) => {
    throw new Response(msg, {
      status,
      headers:
        status === 401
          ? { 'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"` }
          : {},
    });
  };

  if (!expected || expected.length === 0) {
    deny(
      'Admin-Seite gesperrt: Umgebungsvariable ADMIN_PASSWORD ist nicht gesetzt.',
      503,
    );
    return;
  }

  const header = request.headers.get('Authorization') ?? '';
  if (!header.startsWith('Basic ')) {
    deny('Authentifizierung erforderlich.', 401);
    return;
  }

  let provided = '';
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf-8');
    // Format ist user:pass — alles nach dem ersten ':' ist das Passwort.
    provided = decoded.slice(decoded.indexOf(':') + 1);
  } catch {
    deny('Ungültiger Authorization-Header.', 401);
    return;
  }

  const a = Buffer.from(provided, 'utf-8');
  const b = Buffer.from(expected, 'utf-8');
  const ok = a.length === b.length && timingSafeEqual(a, b);
  if (!ok) {
    deny('Falsches Passwort.', 401);
  }
}

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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  requireBasicAuth(request);

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

  return json(
    { rows },
    { headers: { 'Cache-Control': 'no-store' } },
  );
};

export const action = async ({ request }: ActionFunctionArgs) => {
  requireBasicAuth(request);

  const form = await request.formData();
  const intent = form.get('intent');
  const shop = String(form.get('shop') ?? '');
  const confirm = String(form.get('confirm') ?? '');

  if (intent !== 'delete-shop') {
    return json({ error: 'Unbekannte Aktion.' }, { status: 400 });
  }
  if (!shop) {
    return json({ error: 'Kein Shop angegeben.' }, { status: 400 });
  }
  if (confirm !== shop) {
    return json(
      {
        error: `Bestätigung stimmt nicht. Tippe exakt "${shop}" ins Bestätigungsfeld.`,
      },
      { status: 400 },
    );
  }

  try {
    logger.warn(`[ADMIN] Manuelles vollständiges Löschen aller Daten für ${shop}`);
    await redactShopData({ shop_id: 0, shop_domain: shop });
    return json({ ok: `Alle Daten für ${shop} wurden gelöscht.` });
  } catch (error) {
    logger.error('[ADMIN] Löschen fehlgeschlagen', {
      shop,
      error: error instanceof Error ? error.message : String(error),
    });
    return json(
      { error: `Löschen fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 },
    );
  }
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

function ShopRowView({ row }: { row: ShopRow }) {
  const [open, setOpen] = useState(false);
  const nav = useNavigation();
  const busy =
    nav.state !== 'idle' && nav.formData?.get('shop') === row.shop;

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
        <td style={TD}>
          {row.initialSyncCompletedAt ? '✓' : '—'}
        </td>
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

export default function AdminPage() {
  const { rows } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <div
      style={{
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        padding: 24,
        maxWidth: 1200,
        margin: '0 auto',
        color: '#202223',
      }}
    >
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>ContentPilot — Admin</h1>
      <p style={{ color: '#5c5f62', marginTop: 0, fontSize: 13 }}>
        {rows.length} Shop(s). Diese Seite läuft außerhalb von Shopify.
      </p>

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

      <div style={{ overflowX: 'auto', border: '1px solid #e1e3e5', borderRadius: 6 }}>
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
    </div>
  );
}
