/**
 * Operator script (PLAN_ADMIN_SHOP_OVERVIEW 2.7): mark ONE shop as uninstalled
 * when its install state is stale (the app/uninstalled webhook never arrived),
 * but only with evidence. Marking leads, 30 days later, to the data reaper
 * deleting the shop's data, so the default is a DRY RUN.
 *
 * Usage (in the production service environment, e.g. a Railway shell):
 *   npx tsx scripts/mark-stale-uninstalled.ts --shop example.myshopify.com
 *   npx tsx scripts/mark-stale-uninstalled.ts --shop example.myshopify.com --apply
 *
 * It prints the evidence (last webhook, last API success, last visit/sign-in,
 * connection state and reason, session and token presence, migration state) and
 * refuses unless the shop is "presumed uninstalled": blocked for at least 30
 * days (7 when Shopify says the shop is not found) with no webhook, visit,
 * sign-in, API success or reinstall evidence since the block began. Only
 * `--apply` writes, through markShopUninstalled(shop, { source: "operator" }),
 * after the facts were re-read. Exit codes: 0 ok / dry run, 1 usage or error,
 * 2 refused (no evidence, unknown shop, already uninstalled).
 *
 * Never prints a token. No shop names are stored in the repo.
 */

import { pathToFileURL } from "node:url";

export interface CliIo {
  log: (line: string) => void;
  error: (line: string) => void;
}

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export function parseArgs(argv: string[]): { shop: string | null; apply: boolean; unknown: string[] } {
  let shop: string | null = null;
  let apply = false;
  const unknown: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") apply = true;
    else if (a === "--shop") shop = (argv[++i] ?? "").trim().toLowerCase() || null;
    else if (a.startsWith("--shop=")) shop = a.slice(7).trim().toLowerCase() || null;
    else unknown.push(a);
  }
  return { shop, apply, unknown };
}

const iso = (d: unknown): string => {
  if (d === null || d === undefined) return "never";
  const t = d instanceof Date ? d : new Date(d as string | number);
  return Number.isNaN(t.getTime()) ? "unknown" : t.toISOString();
};

/** Run the script; returns the exit code. `now` and `io` are seams for tests. */
export async function runMarkStaleUninstalled(
  argv: string[],
  io: CliIo = { log: (l) => console.log(l), error: (l) => console.error(l) },
  now: Date = new Date(),
): Promise<number> {
  const { shop, apply, unknown } = parseArgs(argv);
  if (!shop || unknown.length > 0 || !SHOP_RE.test(shop)) {
    io.error("Usage: mark-stale-uninstalled.ts --shop <name>.myshopify.com [--apply]");
    return 1;
  }
  const { reviewStaleInstall } = await import("../app/services/stale-install.server");
  const review = await reviewStaleInstall(shop, now);
  if (!review.found) {
    io.error(`REFUSED: no install state is known for ${shop}.`);
    return 2;
  }
  const i = review.install!;
  io.log(`Evidence for ${shop} (now ${now.toISOString()}):`);
  io.log(`  connection state:      ${i.connectionState ?? "none"} (reason ${i.connectionStateReason ?? "none"}, since ${iso(i.connectionStateSince)})`);
  io.log(`  derived status:        ${review.status?.status ?? "unknown"}`);
  io.log(`  last webhook:          ${iso(i.lastWebhookAt)}`);
  io.log(`  last API success:      ${iso(i.lastApiOkAt)}`);
  io.log(`  last visit:            ${iso(i.lastActivityAt)}`);
  io.log(`  last sign-in:          ${iso(i.lastAuthAt)}`);
  io.log(`  reinstall evidence:    ${iso(i.reinstallEvidenceAt)}`);
  io.log(`  uninstalled at:        ${iso(i.uninstalledAt)}${i.uninstallSource ? ` (source ${i.uninstallSource})` : ""}`);
  io.log(`  offline sessions:      ${review.sessions.total} (${review.sessions.withToken} with a token)`);
  io.log(`  token migration:       ${review.migration ? `${review.migration.status}, ${review.migration.attempts} attempt(s)` : "none"}`);
  io.log(`  presumed uninstalled:  ${review.presumedUninstalled ? "yes" : "no"}`);

  if (review.alreadyUninstalled) {
    io.error("REFUSED: the shop is already marked uninstalled.");
    return 2;
  }
  if (!review.presumedUninstalled) {
    io.error(
      "REFUSED: no evidence that the shop is gone (needs a block of at least 30 days, 7 for a 404, " +
        "and no webhook, visit, sign-in, API success or reinstall evidence since).",
    );
    return 2;
  }
  if (!apply) {
    io.log("DRY RUN: nothing was changed. Run again with --apply to mark the shop uninstalled (source operator).");
    return 0;
  }
  // Re-read right before writing: a webhook or sign-in may have landed meanwhile.
  const again = await reviewStaleInstall(shop, now);
  if (!again.found || again.alreadyUninstalled || !again.presumedUninstalled) {
    io.error("REFUSED: the evidence changed while the script ran; nothing was marked.");
    return 2;
  }
  const { markShopUninstalled } = await import("../app/services/shop-uninstall.server");
  await markShopUninstalled(shop, { source: "operator" });
  io.log(`MARKED: ${shop} is now uninstalled (source operator). The data reaper handles it after its retention window.`);
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runMarkStaleUninstalled(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`Failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
