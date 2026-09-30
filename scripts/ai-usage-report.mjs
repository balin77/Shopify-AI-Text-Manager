/**
 * What the AI actually cost — the operator's read of the Phase 0 meter
 * (docs/plans/PLAN_MANAGED_AI_KEY.md §4, §11).
 *
 * Phase 0's whole payoff is a sentence: "after two to four weeks the app knows
 * what one operation costs, per feature". Something has to ASK it, and until
 * Phase 2 builds the merchant-facing card there is no UI — so this is the
 * answer, and it is deliberately a script rather than a route: it reports over
 * every shop, which is not a thing any merchant may see.
 *
 * The number the §7 price table stands on is `avg in` / `avg out` in the
 * MEASURED half of the output. That is why `estimated` is a key column in the
 * ledger and why this prints the two halves apart rather than summing them: an
 * average that mixes a provider's own count with our character estimate is not
 * a measurement, and the table would inherit whatever the estimate got wrong.
 *
 *   node scripts/ai-usage-report.mjs                 # the current month
 *   node scripts/ai-usage-report.mjs m:2026-09       # one period
 *   node scripts/ai-usage-report.mjs m:2026-09 shop.myshopify.com
 */

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

function currentPeriod(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `m:${y}-${m}`;
}

const eur = (micros) => `€${(Number(micros) / 1_000_000).toFixed(4)}`;
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

async function main() {
  const period = process.argv[2] || currentPeriod();
  const shop = process.argv[3];

  const rows = await db.aiUsageCounter.findMany({
    where: { period, ...(shop ? { shop } : {}) },
    orderBy: [{ shop: "asc" }, { feature: "asc" }, { model: "asc" }],
  });

  if (rows.length === 0) {
    console.log(`No AI usage recorded for period ${period}${shop ? ` on ${shop}` : ""}.`);
    console.log("(A shop with no row simply made no calls — there is no such thing");
    console.log(" as a zero row, which is why an absent one is not ambiguous here.)");
    return;
  }

  // Per (feature, model, estimated) across every shop in scope. The per-call
  // average is the deliverable; the per-shop totals below are the invoice
  // reconciliation.
  const byFeature = new Map();
  for (const r of rows) {
    const key = `${r.feature}\u0000${r.provider}/${r.model}\u0000${r.estimated}`;
    const acc = byFeature.get(key) ?? {
      feature: r.feature,
      model: `${r.provider}/${r.model}`,
      estimated: r.estimated,
      calls: 0,
      inputTokens: 0n,
      outputTokens: 0n,
      costMicros: 0n,
    };
    acc.calls += r.calls;
    acc.inputTokens += r.inputTokens;
    acc.outputTokens += r.outputTokens;
    acc.costMicros += r.costMicros;
    byFeature.set(key, acc);
  }

  const measured = [...byFeature.values()].filter((a) => !a.estimated);
  const estimated = [...byFeature.values()].filter((a) => a.estimated);

  const table = (title, accs) => {
    if (accs.length === 0) return;
    console.log(`\n${title}`);
    console.log(
      `  ${pad("feature", 22)}${pad("model", 34)}${padL("calls", 7)}${padL("avg in", 9)}${padL("avg out", 9)}${padL("cost", 12)}${padL("€/call", 11)}`,
    );
    for (const a of accs.sort((x, y) => y.calls - x.calls)) {
      console.log(
        `  ${pad(a.feature, 22)}${pad(a.model, 34)}${padL(a.calls, 7)}` +
          `${padL(Math.round(Number(a.inputTokens) / a.calls), 9)}` +
          `${padL(Math.round(Number(a.outputTokens) / a.calls), 9)}` +
          `${padL(eur(a.costMicros), 12)}${padL(eur(Number(a.costMicros) / a.calls), 11)}`,
      );
    }
  };

  console.log(`AI usage — period ${period}${shop ? `, shop ${shop}` : ", all shops"}`);
  table("MEASURED (the provider reported these token counts)", measured);
  table("ESTIMATED (no usage object; counted from characters, rounded up)", estimated);

  const totalCalls = rows.reduce((n, r) => n + r.calls, 0);
  const estCalls = rows.filter((r) => r.estimated).reduce((n, r) => n + r.calls, 0);
  const cost = rows.reduce((n, r) => n + r.costMicros, 0n);
  const billed = rows.reduce((n, r) => n + r.billedMicros, 0n);
  const failover = rows.reduce((n, r) => n + r.failoverCalls, 0);

  console.log(`\nTotals: ${totalCalls} calls, cost ${eur(cost)}, billed ${eur(billed)}`);
  console.log(
    `  estimated share: ${((estCalls / totalCalls) * 100).toFixed(1)}% of calls` +
      ` — the first thing to check when the meter and an invoice disagree`,
  );
  if (failover > 0) {
    console.log(
      `  failover: ${failover} calls, absorbed ${eur(cost - billed)} (§3a rules 1-3)`,
    );
  }

  // Which models were seen at all. A model this app does not price is priced
  // at its provider's unknown-model CEILING, i.e. a guess — and a guess in the
  // measured half above quietly corrupts the per-call average. Listed rather
  // than detected here: this script runs on plain Node and cannot import the
  // TypeScript price table, and a check that silently degrades to "nothing to
  // report" is worse than one that makes the operator look.
  const seen = [...new Set(rows.map((r) => `${r.provider}/${r.model}`))].sort();
  console.log(`\n  models seen: ${seen.join(", ")}`);
  console.log("    Any of these missing from app/config/ai-pricing.ts was priced at a");
  console.log("    guessed ceiling — check before trusting the euros above.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
