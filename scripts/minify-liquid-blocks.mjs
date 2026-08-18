/**
 * Liquid minifier for the theme app extension blocks.
 *
 * WHY
 * ---
 * Shopify enforces a hard 100 KiB (102400 bytes) limit on the *Liquid* content
 * of a single theme app extension. Every file under
 * `extensions/storefront/blocks/` counts against that budget (`assets/` does
 * not — JS/CSS/SVG are served statically). The sources are heavily commented
 * on purpose, which pushed the bundle past the limit and made
 * `shopify app deploy` fail with
 *   `bundle: Extension Liquid content size exceeds 100 KB limit`.
 *
 * Rather than stripping the comments from the repo, `scripts/deploy-minified.mjs`
 * minifies the blocks in place for the duration of the deploy and restores the
 * commented originals afterwards. This module holds the pure transform so it is
 * unit-testable and importable by the deploy wrapper.
 *
 * SAFETY MODEL
 * ------------
 * The transform must be logic- and render-neutral. A naive regex pass over the
 * whole file is NOT acceptable: it would reach into `<script>` bodies (ASI
 * hazards), JSON islands and `<pre>`. So the file is first tokenised into
 * protected and minifiable regions, and only the latter are touched.
 *
 * Applied to minifiable regions only:
 *   1. `{% comment %}…{% endcomment %}` blocks are removed (incl. the
 *      whitespace-control `{%- comment -%}` spelling).
 *   2. Leading indentation is stripped per line.
 *   3. Runs of 2+ blank lines collapse to one.
 *   4. Trailing whitespace is stripped per line.
 *
 * Kept byte-identical (never rewritten, never scanned for comments):
 *   - `<script>…</script>` in any flavour — JS bodies (ASI) as well as
 *     `application/json` / `application/ld+json` islands. Those islands contain
 *     Liquid `{{ … }}` and are therefore NOT parseable JSON before rendering,
 *     so re-serialising them is impossible.
 *   - `<style>…</style>`, `<pre>…</pre>`, `<textarea>…</textarea>`.
 *   - The interior of Liquid tags `{% … %}` (including multi-line
 *     `{% liquid %}` / `{% schema %}` openers) and outputs `{{ … }}`.
 *   - `{% raw %}…{% endraw %}` bodies, which Liquid emits verbatim.
 *
 * Note that `{% schema %}` *bodies* are minifiable: they are whitespace-
 * insensitive JSON, and a JSON string literal can never span a line break, so
 * indentation stripping cannot reach inside a string.
 *
 * CLI
 * ---
 *   node scripts/minify-liquid-blocks.mjs --check
 * Reports per-file and total sizes without writing anything. Exits non-zero if
 * the minified bundle would still hit Shopify's hard limit.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Root of the ONE theme app extension. Names in the report are relative to it. */
export const EXTENSION_DIR = join(REPO_ROOT, 'extensions', 'storefront');

/** App blocks. */
export const BLOCKS_DIR = join(EXTENSION_DIR, 'blocks');

/**
 * Snippets the blocks `{% render %}`. They count against the SAME 100 KiB
 * budget as the blocks — Shopify measures the extension's Liquid, not one
 * folder of it. Scanning only `blocks/` would make this check report
 * "fits" while the deploy fails, which is worse than having no check.
 */
export const SNIPPETS_DIR = join(EXTENSION_DIR, 'snippets');

/** Every directory whose `*.liquid` counts. Missing ones are skipped. */
export const LIQUID_DIRS = [BLOCKS_DIR, SNIPPETS_DIR];

/** Shopify's hard limit: 100 KiB of Liquid content per theme app extension. */
export const LIQUID_LIMIT_BYTES = 100 * 1024;

/** Safety margin we want to stay under, so a small edit cannot break a deploy. */
export const LIQUID_TARGET_BYTES = 96 * 1024;

/** Build a case-insensitive literal matcher without an `i` flag on the whole regex. */
const ci = (word) =>
  word
    .split('')
    .map((c) => `[${c.toLowerCase()}${c.toUpperCase()}]`)
    .join('');

/** HTML elements whose entire markup (open tag, body, close tag) is untouchable. */
const PROTECTED_ELEMENTS = ['script', 'style', 'pre', 'textarea'];

/**
 * Leftmost opener of any construct the scanner has to react to.
 *
 * Order matters: `comment` and `raw` are listed before the generic `{%` so that
 * at the same offset the more specific alternative wins. The Liquid
 * alternatives stay case-sensitive (Liquid tag names are lowercase — treating
 * `{% COMMENT %}` as a comment would delete literal text); the HTML ones are
 * spelled out case-insensitively.
 */
const OPENER = new RegExp(
  [
    String.raw`\{%-?\s*comment\s*-?%\}`,
    String.raw`\{%-?\s*raw\s*-?%\}`,
    String.raw`\{\{`,
    String.raw`\{%`,
    ...PROTECTED_ELEMENTS.map((tag) => `<${ci(tag)}\\b`),
  ].join('|'),
  'g',
);

const COMMENT_OPEN = /^\{%-?\s*comment/;
const RAW_OPEN = /^\{%-?\s*raw/;
const ENDCOMMENT = new RegExp(String.raw`\{%-?\s*endcomment\s*-?%\}`, 'g');
const ENDRAW = new RegExp(String.raw`\{%-?\s*endraw\s*-?%\}`, 'g');

/** Closing-tag matcher per protected element, e.g. `</script >`. */
const CLOSERS = new Map(
  PROTECTED_ELEMENTS.map((tag) => [tag, new RegExp(`</${ci(tag)}\\s*>`, 'g')]),
);

/**
 * Find the end offset of a delimited region, or throw with useful context.
 *
 * @param {string} src
 * @param {number} from index to start searching at
 * @param {RegExp|string} closer sticky-less matcher for the closing delimiter
 * @param {string} what human-readable name for the error message
 * @returns {number} offset just past the closing delimiter
 */
function endOf(src, from, closer, what) {
  let end = -1;
  if (typeof closer === 'string') {
    const at = src.indexOf(closer, from);
    if (at !== -1) end = at + closer.length;
  } else {
    closer.lastIndex = from;
    const m = closer.exec(src);
    if (m) end = m.index + m[0].length;
  }
  if (end === -1) {
    const line = src.slice(0, from).split('\n').length;
    throw new Error(
      `minifyLiquid: unterminated ${what} starting around line ${line} — refusing to minify a file I cannot parse safely.`,
    );
  }
  return end;
}

/**
 * Split a source file into ordered segments.
 *
 * @param {string} src
 * @returns {Array<{kind: 'plain'|'protected'|'comment', text: string}>}
 */
export function scanRegions(src) {
  /** @type {Array<{kind: 'plain'|'protected'|'comment', text: string}>} */
  const segments = [];
  let cursor = 0;

  OPENER.lastIndex = 0;
  let match;
  while ((match = OPENER.exec(src)) !== null) {
    const start = match.index;
    const token = match[0];

    let end;
    /** @type {'protected'|'comment'} */
    let kind = 'protected';

    if (COMMENT_OPEN.test(token)) {
      end = endOf(src, start + token.length, ENDCOMMENT, '{% comment %}');
      kind = 'comment';
    } else if (RAW_OPEN.test(token)) {
      end = endOf(src, start + token.length, ENDRAW, '{% raw %}');
    } else if (token === '{{') {
      end = endOf(src, start + token.length, '}}', 'Liquid output {{ … }}');
    } else if (token === '{%') {
      end = endOf(src, start + token.length, '%}', 'Liquid tag {% … %}');
    } else {
      const tag = token.slice(1).toLowerCase();
      end = endOf(src, start + token.length, CLOSERS.get(tag), `<${tag}> element`);
    }

    if (start > cursor) segments.push({ kind: 'plain', text: src.slice(cursor, start) });
    segments.push({ kind, text: src.slice(start, end) });

    cursor = end;
    OPENER.lastIndex = end;
  }

  if (cursor < src.length) segments.push({ kind: 'plain', text: src.slice(cursor) });
  return segments;
}

/**
 * Line-aware output builder.
 *
 * The whitespace rules are per *line*, but lines routinely straddle segment
 * boundaries (`  <div>` … `<script>…</script>` … `</div>`). The emitter
 * therefore carries two bits of cross-segment state: whether the line being
 * built already has non-whitespace content (so mid-line spacing is never
 * mistaken for indentation), and how many blank lines were just emitted.
 */
function createEmitter() {
  /** @type {string[]} */
  const out = [];
  let lineHasContent = false;
  let blankRun = 0;

  return {
    /** Emit untouched bytes and resynchronise the line state from them. */
    pushProtected(text) {
      if (text === '') return;
      out.push(text);
      const lastBreak = text.lastIndexOf('\n');
      lineHasContent = lastBreak === -1 ? true : /\S/.test(text.slice(lastBreak + 1));
      blankRun = 0;
    },

    /** Emit text with rules 2–4 applied. */
    pushPlain(text) {
      if (text === '') return;
      const parts = text.split('\n');
      for (let i = 0; i < parts.length; i++) {
        const isComplete = i < parts.length - 1;
        let line = parts[i];

        // Preserve CRLF: treat a trailing \r as part of the terminator so the
        // whitespace rules still see the real end of the line.
        let eol = '\n';
        if (isComplete && line.endsWith('\r')) {
          line = line.slice(0, -1);
          eol = '\r\n';
        }

        // Rule 2 — leading indentation, but only when nothing precedes it on
        // this line; otherwise it is meaningful inter-token spacing.
        if (!lineHasContent) line = line.replace(/^[ \t]+/, '');

        if (!isComplete) {
          // The line continues into the next segment: its trailing whitespace
          // is not end-of-line whitespace, so rule 4 does not apply yet.
          if (line !== '') {
            out.push(line);
            if (/\S/.test(line)) {
              lineHasContent = true;
              blankRun = 0;
            }
          }
          continue;
        }

        line = line.replace(/[ \t]+$/, ''); // rule 4

        if (!lineHasContent && line === '') {
          // Rule 3 — keep the first blank line of a run, drop the rest.
          if (blankRun < 1) {
            out.push(eol);
            blankRun++;
          }
          continue;
        }

        out.push(line + eol);
        blankRun = 0;
        lineHasContent = false;
      }
    },

    result: () => out.join(''),
  };
}

/**
 * Minify one Liquid source file.
 *
 * Idempotent: `minifyLiquid(minifyLiquid(x)) === minifyLiquid(x)`.
 *
 * @param {string} source raw file contents
 * @returns {string} minified contents
 */
export function minifyLiquid(source) {
  const emit = createEmitter();
  for (const segment of scanRegions(source)) {
    if (segment.kind === 'plain') emit.pushPlain(segment.text);
    else if (segment.kind === 'protected') emit.pushProtected(segment.text);
    // 'comment' segments are dropped entirely (rule 1). The whitespace they
    // leave behind is normalised by rules 2–4 on the surrounding plain text.
  }
  return emit.result();
}

/**
 * @typedef {Object} BlockReport
 * @property {string} name file name
 * @property {string} path absolute path
 * @property {string} original original contents
 * @property {string} minified minified contents
 * @property {number} originalBytes
 * @property {number} minifiedBytes
 */

/** List the `*.liquid` files that count against the extension Liquid budget. */
export function listBlockFiles(dirs = LIQUID_DIRS) {
  const list = Array.isArray(dirs) ? dirs : [dirs];
  return list
    .filter((dir) => existsSync(dir))
    .flatMap((dir) =>
      readdirSync(dir)
        .filter((name) => name.endsWith('.liquid'))
        .sort()
        .map((name) => join(dir, name)),
    );
}

/**
 * Read every block and minify it in memory. Writes nothing.
 *
 * @param {string} [dir]
 * @returns {{blocks: BlockReport[], originalBytes: number, minifiedBytes: number}}
 */
export function buildReport(dirs = LIQUID_DIRS) {
  const blocks = listBlockFiles(dirs).map((path) => {
    const name = path.slice(EXTENSION_DIR.length + 1).split(sep).join('/');
    const original = readFileSync(path, 'utf8');
    const minified = minifyLiquid(original);
    return {
      name,
      path,
      original,
      minified,
      originalBytes: Buffer.byteLength(original, 'utf8'),
      minifiedBytes: Buffer.byteLength(minified, 'utf8'),
    };
  });

  return {
    blocks,
    originalBytes: blocks.reduce((sum, b) => sum + b.originalBytes, 0),
    minifiedBytes: blocks.reduce((sum, b) => sum + b.minifiedBytes, 0),
  };
}

const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

/**
 * Print the size table shared by `--check` and the deploy wrapper.
 *
 * @param {{blocks: BlockReport[], originalBytes: number, minifiedBytes: number}} report
 */
export function printReport(report) {
  const width = Math.max(...report.blocks.map((b) => b.name.length), 5);
  console.log('  file'.padEnd(width + 4) + '     original      minified        saved');
  for (const b of report.blocks) {
    const saved = b.originalBytes - b.minifiedBytes;
    const pct = b.originalBytes === 0 ? 0 : (saved / b.originalBytes) * 100;
    console.log(
      `  ${b.name.padEnd(width)}  ${String(b.originalBytes).padStart(11)}  ${String(
        b.minifiedBytes,
      ).padStart(12)}  ${String(saved).padStart(8)} (${pct.toFixed(1).padStart(4)}%)`,
    );
  }
  const savedTotal = report.originalBytes - report.minifiedBytes;
  console.log(
    `  ${'TOTAL'.padEnd(width)}  ${String(report.originalBytes).padStart(11)}  ${String(
      report.minifiedBytes,
    ).padStart(12)}  ${String(savedTotal).padStart(8)}`,
  );
  console.log(
    `\n  ${kib(report.minifiedBytes)} of ${kib(LIQUID_LIMIT_BYTES)} Shopify limit ` +
      `(target < ${kib(LIQUID_TARGET_BYTES)}, headroom ${kib(
        LIQUID_LIMIT_BYTES - report.minifiedBytes,
      )})`,
  );
}

function runCheck() {
  const report = buildReport();
  console.log(`\n[minify-liquid-blocks] ${EXTENSION_DIR}\n`);
  printReport(report);

  if (report.minifiedBytes >= LIQUID_LIMIT_BYTES) {
    console.error(
      `\n❌ Minified Liquid is ${report.minifiedBytes} bytes — at or over Shopify's ` +
        `${LIQUID_LIMIT_BYTES} byte limit. \`shopify app deploy\` would fail. ` +
        `Move markup/logic into assets/ (assets do not count) before deploying.\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (report.minifiedBytes >= LIQUID_TARGET_BYTES) {
    console.warn(
      `\n⚠️  Minified Liquid is ${report.minifiedBytes} bytes — under the hard limit but ` +
        `over the ${LIQUID_TARGET_BYTES} byte safety margin. The next block edit may break ` +
        `the deploy; consider moving markup into assets/.\n`,
    );
    return;
  }

  console.log('\n✅ Minified Liquid fits with margin to spare.\n');
}

// CLI entry point — only when executed directly, never on import.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--check') || args.length === 0) {
    runCheck();
  } else {
    console.error(
      'Usage: node scripts/minify-liquid-blocks.mjs [--check]\n' +
        '  --check   report block sizes before/after minification (writes nothing)\n\n' +
        'To deploy with minified blocks use: npm run deploy -- -c dev --allow-updates',
    );
    process.exitCode = 1;
  }
}
