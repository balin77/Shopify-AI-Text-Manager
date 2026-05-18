/**
 * Hard-delete every public client sourcemap after the build (review H1).
 *
 * @sentry/vite-plugin already deletes build/client/**\/*.map AFTER a SUCCESSFUL
 * upload — but if the upload fails (network, bad token) the .map files remain
 * and express.static("build/client") would serve them by direct URL. This
 * runs unconditionally as the last build step: server stack traces stay
 * readable via Sentry's own copy, and nothing is left to leak locally.
 *
 * Server-side maps (build/server) are intentionally kept: they are never
 * served publicly and help Sentry de-minify SSR stack traces.
 *
 * No-op when there are no maps (the no-token build emits none at all).
 */
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = join(process.cwd(), 'build', 'client');

async function walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // build/client missing → nothing to do
  }
  const maps = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) maps.push(...(await walk(full)));
    else if (e.name.endsWith('.map')) maps.push(full);
  }
  return maps;
}

const maps = await walk(ROOT);
await Promise.all(maps.map((m) => rm(m, { force: true })));
console.log(`[strip-client-sourcemaps] removed ${maps.length} public .map file(s) from build/client`);
