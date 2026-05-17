/**
 * Listet alle Shops, die im GdprAuditLog stehen (3-Jahre-DSGVO-Aufbewahrung,
 * Art. 5(2) Rechenschaftspflicht) — getrennt danach, ob sie noch im
 * Admin-Dashboard sichtbar sind oder nicht.
 *
 * Admin-Dashboard zeigt einen Shop, solange er in Session, ShopInstallState
 * ODER AISettings vorkommt (siehe app/routes/admin.tsx → loadShopRows()).
 * Nach vollständigem shop/redact sind diese Datensätze weg — der Shop
 * verschwindet aus dem Admin, lebt aber 3 Jahre im GdprAuditLog weiter.
 *
 * Aufruf:  node scripts/gdpr-retained-shops.mjs
 */
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

// Shops, die das Admin-Dashboard noch anzeigen würde.
const [sessionShops, installStates, aiSettings] = await Promise.all([
  db.session.findMany({ distinct: ['shop'], select: { shop: true } }),
  db.shopInstallState.findMany({ select: { shop: true } }),
  db.aISettings.findMany({ select: { shop: true } }),
]);

const visibleInAdmin = new Set();
sessionShops.forEach((s) => visibleInAdmin.add(s.shop));
installStates.forEach((s) => visibleInAdmin.add(s.shop));
aiSettings.forEach((s) => visibleInAdmin.add(s.shop));

// Pro Shop: Anzahl je requestType, erste/letzte Anfrage,
// und das Datum, an dem die 3-Jahre-Aufbewahrung ausläuft
// (letzte Anfrage + 3 Jahre — danach räumt der Cleanup-Job auf).
const rows = await db.$queryRawUnsafe(`
  SELECT
    shop,
    count(*)::int                                                   AS audit_rows,
    sum(CASE WHEN "requestType" = 'shop_redact'     THEN 1 ELSE 0 END)::int AS shop_redact,
    sum(CASE WHEN "requestType" = 'customer_redact' THEN 1 ELSE 0 END)::int AS customer_redact,
    sum(CASE WHEN "requestType" = 'data_request'    THEN 1 ELSE 0 END)::int AS data_request,
    min("requestedAt")                                              AS first_request,
    max("requestedAt")                                              AS last_request,
    (max("requestedAt") + interval '3 years')                       AS retained_until
  FROM "GdprAuditLog"
  GROUP BY shop
  ORDER BY shop
`);

const onlyInAuditLog = [];
const stillVisible = [];
for (const r of rows) {
  (visibleInAdmin.has(r.shop) ? stillVisible : onlyInAuditLog).push(r);
}

const fmt = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—');
const line = (r) =>
  `  ${r.shop.padEnd(40)} rows=${String(r.audit_rows).padStart(3)} ` +
  `redact=${r.shop_redact} cust_redact=${r.customer_redact} data_req=${r.data_request} ` +
  `| erste=${fmt(r.first_request)} letzte=${fmt(r.last_request)} ` +
  `| aufbewahrt bis ${fmt(r.retained_until)}`;

console.log(`\nGesamt im GdprAuditLog: ${rows.length} Shop(s)\n`);

console.log(
  `=== NUR im Audit-Log — NICHT im Admin sichtbar (${onlyInAuditLog.length}) ===`,
);
console.log(
  onlyInAuditLog.length
    ? onlyInAuditLog.map(line).join('\n')
    : '  (keine — alle Audit-Shops sind noch im Admin sichtbar)',
);

console.log(
  `\n=== Auch im Admin noch sichtbar (${stillVisible.length}) ===`,
);
console.log(
  stillVisible.length
    ? stillVisible.map(line).join('\n')
    : '  (keine)',
);

console.log('');
await db.$disconnect();
process.exit(0);
