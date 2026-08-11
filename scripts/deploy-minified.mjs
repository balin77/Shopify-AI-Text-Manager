#!/usr/bin/env node
/**
 * `shopify app deploy` wrapper that minifies the theme app extension blocks
 * for the duration of the deploy and always restores the commented sources.
 *
 * WHY A WRAPPER AND NOT pre/post SCRIPTS
 * --------------------------------------
 * A theme app extension has no build output directory — the CLI uploads
 * `extensions/storefront/blocks/*.liquid` in place. So the minified form has to
 * exist on disk while the CLI runs, and something has to put the originals back
 * even when the deploy crashes or is Ctrl-C'd. npm `pre*`/`post*` scripts cannot
 * do that (`post` never runs on failure), so the whole cycle lives in one
 * process with the restore in a `finally` plus an `exit` backstop.
 *
 * The minified blocks therefore never survive the command and must never be
 * committed: `blocks/` stays fully commented in git.
 *
 * USAGE
 *   npm run deploy -- -c dev --allow-updates
 *   npm run deploy -- -c prod
 * Every argument is passed straight through to `shopify app deploy`.
 *
 * Set SHOPIFY_CLI_BIN to override the executable (used by tooling/tests to
 * exercise the minify → restore cycle without releasing a version).
 *
 * All filesystem work is synchronous on purpose: the restore path has to be
 * safe to run from a signal handler and from `process.on('exit')`.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  BLOCKS_DIR,
  LIQUID_LIMIT_BYTES,
  LIQUID_TARGET_BYTES,
  buildReport,
  printReport,
} from './minify-liquid-blocks.mjs';

const CLI_BIN = process.env.SHOPIFY_CLI_BIN || 'shopify';
const IS_WINDOWS = process.platform === 'win32';

/** @type {Map<string, string>} absolute path → original contents */
const originals = new Map();
let restored = false;

/** Put every commented source back. Idempotent and safe to call twice. */
function restore() {
  if (restored || originals.size === 0) return;
  restored = true;
  let failed = 0;
  for (const [path, contents] of originals) {
    try {
      writeFileSync(path, contents, 'utf8');
    } catch (err) {
      failed++;
      console.error(`[deploy-minified] FAILED to restore ${path}: ${err.message}`);
    }
  }
  if (failed > 0) {
    console.error(
      `[deploy-minified] ${failed} block(s) are still minified on disk. ` +
        `Run \`git checkout -- ${'extensions/storefront/blocks'}\` to recover the sources.`,
    );
  } else {
    console.log(`[deploy-minified] restored ${originals.size} commented block source(s).`);
  }
}

/**
 * `cmd.exe` does not quote arguments for us, and Node does not either when
 * `shell: true`. Only wrap what actually needs it so `-c dev` stays readable.
 */
function quoteForWindowsShell(arg) {
  return /[\s"^&|<>()%!]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

/**
 * Run the Shopify CLI with inherited stdio and resolve with its exit code.
 *
 * @param {string[]} args
 * @returns {Promise<number>}
 */
function runShopify(args) {
  const argv = ['app', 'deploy', ...args];
  console.log(`\n[deploy-minified] ${CLI_BIN} ${argv.join(' ')}\n`);

  // On Windows the CLI is a `.cmd` shim, which Node refuses to spawn directly
  // since the 20.12 argument-injection fix — it has to go through the shell.
  const child = IS_WINDOWS
    ? spawn(quoteForWindowsShell(CLI_BIN), argv.map(quoteForWindowsShell), {
        stdio: 'inherit',
        shell: true,
      })
    : spawn(CLI_BIN, argv, { stdio: 'inherit' });

  return new Promise((resolvePromise, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      // A signalled child has no numeric code; report the conventional 128+n.
      if (code === null) resolvePromise(signal === 'SIGINT' ? 130 : 1);
      else resolvePromise(code);
    });
  });
}

async function main() {
  const passthrough = process.argv.slice(2);

  const report = buildReport();
  if (report.blocks.length === 0) {
    console.error(`[deploy-minified] no *.liquid blocks found in ${BLOCKS_DIR}`);
    return 1;
  }

  console.log(`\n[deploy-minified] minifying ${report.blocks.length} block(s)\n`);
  printReport(report);

  if (report.minifiedBytes >= LIQUID_LIMIT_BYTES) {
    console.error(
      `\n❌ Minified Liquid is ${report.minifiedBytes} bytes, at or over Shopify's ` +
        `${LIQUID_LIMIT_BYTES} byte per-extension limit. Nothing was written and nothing ` +
        `was deployed — the CLI would only fail with ` +
        `"Extension Liquid content size exceeds 100 KB limit".\n` +
        `   Move markup or data into extensions/storefront/assets/ (assets are served ` +
        `statically and do not count against this budget).\n`,
    );
    return 1;
  }
  if (report.minifiedBytes >= LIQUID_TARGET_BYTES) {
    console.warn(
      `\n⚠️  Only ${LIQUID_LIMIT_BYTES - report.minifiedBytes} bytes of headroom left ` +
        `(safety margin is ${LIQUID_LIMIT_BYTES - LIQUID_TARGET_BYTES} bytes). Deploying anyway.\n`,
    );
  }

  // Stash the sources BEFORE the first write, so the restore map is always
  // complete even if a later write fails halfway through.
  for (const block of report.blocks) originals.set(block.path, block.original);

  try {
    for (const block of report.blocks) {
      if (block.minified !== block.original) writeFileSync(block.path, block.minified, 'utf8');
    }
    return await runShopify(passthrough);
  } finally {
    restore();
  }
}

// Keep Ctrl-C from killing us before `finally` runs: the child receives the
// same signal from the terminal, so the awaited deploy settles on its own and
// the normal restore path takes over. A second signal means "now", so restore
// synchronously and leave.
let signalled = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (signalled) {
      restore();
      process.exit(130);
    }
    signalled = true;
    console.log(`\n[deploy-minified] ${signal} received — waiting for the CLI to stop, then restoring sources…`);
  });
}

// Last-resort backstop for paths `finally` cannot cover (uncaught exception,
// explicit process.exit deeper in the stack).
process.on('exit', restore);

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`\n[deploy-minified] ${err?.message ?? err}`);
    if (err?.code === 'ENOENT') {
      console.error(
        `[deploy-minified] "${CLI_BIN}" was not found on PATH. Install the Shopify CLI ` +
          `(npm i -g @shopify/cli) or set SHOPIFY_CLI_BIN.`,
      );
    }
    process.exitCode = 1;
  });
