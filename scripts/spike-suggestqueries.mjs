/**
 * Railway spike for keyword research Phase 4 (PLAN_KEYWORDS_EXPANSION.md §6.1).
 *
 * Question to answer: does Google's suggestqueries endpoint answer reliably
 * FROM RAILWAY's egress IPs (datacenter!), including the worst-case call
 * pattern the feature produces (1 direct + 6 question-word + 26 alphabet
 * calls per seed, sequential with 200 ms delay)?
 *
 * Run it ON Railway (not locally — local success proves nothing):
 *   node scripts/spike-suggestqueries.mjs
 * Exit code 0 = PASS (see criteria in the summary), 1 = FAIL.
 *
 * Zero dependencies; Node 18+ (global fetch). Mirrors the production fetch
 * exactly: client=firefox, ContentPilot-SEO/1.0 UA, 5 s timeout, 200 ms delay.
 */

const SEEDS = ["vase", "laufschuhe", "keramik tasse"]; // 3 seeds = the per-minute UI budget
const HL = "de";
const DELAY_MS = 200;
const QUESTION_WORDS = ["wie", "was", "warum", "wo", "welche", "wann"];
const ALPHABET = "abcdefghijklmnopqrstuvwxyz".split("");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stats = { total: 0, ok: 0, blocked: 0, otherFail: 0, emptyBody: 0, statuses: {}, firstBlockAt: null };

async function call(query) {
  stats.total += 1;
  const url = `https://suggestqueries.google.com/complete/search?client=firefox&hl=${HL}&q=${encodeURIComponent(query)}`;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "ContentPilot-SEO/1.0" },
      signal: AbortSignal.timeout(5000),
    });
    stats.statuses[res.status] = (stats.statuses[res.status] ?? 0) + 1;
    if (res.status === 429 || res.status === 403) {
      stats.blocked += 1;
      if (stats.firstBlockAt === null) stats.firstBlockAt = stats.total;
      console.log(`  [${stats.total}] ${res.status} BLOCKED  q="${query}" (${Date.now() - started}ms)`);
      return;
    }
    if (!res.ok) {
      stats.otherFail += 1;
      console.log(`  [${stats.total}] ${res.status} FAIL     q="${query}"`);
      return;
    }
    const body = await res.json().catch(() => null);
    const suggestions = Array.isArray(body) && Array.isArray(body[1]) ? body[1].length : -1;
    if (suggestions < 0) {
      stats.emptyBody += 1;
      console.log(`  [${stats.total}] 200 BAD-SHAPE q="${query}"`);
      return;
    }
    stats.ok += 1;
    console.log(`  [${stats.total}] 200 ok (${suggestions} suggestions, ${Date.now() - started}ms) q="${query}"`);
  } catch (err) {
    stats.otherFail += 1;
    stats.statuses.error = (stats.statuses.error ?? 0) + 1;
    console.log(`  [${stats.total}] NETWORK FAIL q="${query}": ${err?.message ?? err}`);
  }
}

console.log(`suggestqueries spike — ${SEEDS.length} seed(s), full pattern (1+${QUESTION_WORDS.length}+${ALPHABET.length} calls each), ${DELAY_MS}ms delay\n`);

for (const seed of SEEDS) {
  console.log(`Seed "${seed}":`);
  await call(seed);
  for (const w of QUESTION_WORDS) {
    await sleep(DELAY_MS);
    await call(`${w} ${seed}`);
  }
  for (const letter of ALPHABET) {
    await sleep(DELAY_MS);
    await call(`${seed} ${letter}`);
  }
  console.log("");
}

const okPct = stats.total ? Math.round((stats.ok / stats.total) * 1000) / 10 : 0;
const pass = stats.blocked === 0 && okPct >= 95;
console.log("─".repeat(60));
console.log(`Total: ${stats.total} | ok: ${stats.ok} (${okPct}%) | blocked(429/403): ${stats.blocked} | other: ${stats.otherFail} | bad shape: ${stats.emptyBody}`);
console.log(`Status counts: ${JSON.stringify(stats.statuses)}`);
if (stats.firstBlockAt !== null) console.log(`First block at call #${stats.firstBlockAt}`);
console.log(`\nRESULT: ${pass ? "PASS — endpoint usable from this network" : "FAIL — throttled/blocked, keep Phase 4 dark or move to a paid source"}`);
process.exit(pass ? 0 : 1);
