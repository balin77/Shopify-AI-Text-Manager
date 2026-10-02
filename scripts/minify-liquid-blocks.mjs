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
 *      whitespace-control `{%- comment -%}` spelling). A dash on the removed
 *      comment is honoured exactly as Liquid would have honoured it: `{%-`
 *      trims the whitespace at the end of the directly preceding text, `-%}`
 *      the whitespace at the start of the directly following text (ASCII
 *      whitespace only, newlines included). Without a dash nothing is trimmed.
 *      One case is not dropped but kept as an inline comment (`{%-#-%}` /
 *      `{%-#%}`, dashes as in the source): whitespace-only text between a
 *      tag/the file start and a `{%- comment`, where Ruby Liquid's
 *      `bug_compatible_whitespace_trimming` mode renders differently from the
 *      normal one and the engine, not this script, must do the trimming.
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
 *   - The interior of Liquid tags `{% … %}` and outputs `{{ … }}`, with ONE
 *     exception: a multi-line `{% liquid %}` tag is minified by
 *     `minifyLiquidTag` (indentation, blank lines and whole-line `#` comments
 *     go; lines are never joined, because a newline ends a tag in there).
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
  let markIdx = 0;

  return {
    /** Remember where the plain segment about to be written starts. */
    mark() {
      markIdx = out.length;
    },

    /**
     * Emulate `{%-` on a removed comment: drop ASCII whitespace at the end of
     * the output, but only inside the plain segment written since `mark()` --
     * Liquid trims the directly preceding text token and nothing else.
     */
    trimTrailingWhitespace() {
      while (out.length > markIdx) {
        const last = out[out.length - 1].replace(/[ \t\n\r\f\v]+$/, '');
        if (last === '') out.pop();
        else {
          out[out.length - 1] = last;
          break;
        }
      }
      // Resynchronise the line state from what is really at the end now.
      let tail = '';
      for (let i = out.length - 1; i >= 0; i--) {
        const at = out[i].lastIndexOf('\n');
        if (at !== -1) {
          tail = out[i].slice(at + 1) + tail;
          break;
        }
        tail = out[i] + tail;
      }
      lineHasContent = /\S/.test(tail);
      blankRun = 0;
    },

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

/** A dash-trimming inline comment tag: `{%-# ... %}` / `{%-# ... -%}`. */
const INLINE_DASH_COMMENT = /^\{%-#/;

const LIQUID_TAG_OPEN = /^\{%-?\s*liquid\b/;

/**
 * Minify the interior of a `{% liquid %}` tag.
 *
 * In there every line is its own tag, so indentation is meaningless, a line
 * whose first non-blank character is `#` is a comment, and blank lines are
 * empty. Lines are NEVER joined (the newline is the statement separator), a
 * `#` after code on the same line is never touched (it may sit in a string),
 * and the last line -- the one carrying the closing `%}` -- is always kept.
 * A tag on one line is returned unchanged. Idempotent.
 *
 * @param {string} text the whole tag, `{%- liquid` through `-%}`
 * @returns {string}
 */
export function minifyLiquidTag(text) {
  if (!text.includes('\n')) return text;
  const lines = text.split('\n');
  const last = lines.length - 1;
  const kept = [];
  for (let i = 0; i <= last; i++) {
    let line = i === 0 ? lines[i].replace(/[ \t\r]+$/, '') : lines[i].replace(/^[ \t\r]+|[ \t\r]+$/g, '');
    if (i > 0 && i < last && (line === '' || line.startsWith('#'))) continue;
    kept.push(line);
  }
  return kept.join('\n');
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
  const segments = scanRegions(source);
  let prevKind = null;
  let trimNext = false;
  // What the Liquid token boundary before the current plain text looks like:
  // `atTagBoundary` is true at the start of the file and right after a Liquid
  // tag/output/comment (NOT after a <script>/<pre> element, which is text);
  // `boundaryDash` says that tag ended in `-%}`/`-}}` and therefore already
  // stripped the text that follows.
  let atTagBoundary = true;
  let boundaryDash = false;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.kind === 'plain') {
      let text = segment.text;
      // `-%}` on the comment before: Liquid strips this text's leading whitespace.
      if (trimNext) text = text.replace(/^[ \t\n\r\f\v]+/, '');
      const next = segments[i + 1];
      if (
        next &&
        (next.kind === 'comment' ? next.text.startsWith('{%-') : INLINE_DASH_COMMENT.test(next.text)) &&
        atTagBoundary &&
        !boundaryDash &&
        /^[ \t\n\r\f\v]+$/.test(text)
      ) {
        // Whitespace-only text between a tag (or the file start) and a
        // `{%- comment`: Ruby Liquid's bug_compatible_whitespace_trimming mode
        // restores the FIRST byte of a text token that rstrip emptied, so
        // whether this whitespace survives depends on a parser flag we cannot
        // observe. Keep its first byte and let Shopify's own engine do the
        // trimming through an inline comment carrying the same dashes.
        emit.pushProtected(text[0]);
        // A second pass meets the inline comment this branch wrote and must
        // keep it (and the byte before it) as it is: idempotence.
        emit.pushProtected(
          next.kind === 'comment' ? (next.text.endsWith('-%}') ? '{%-#-%}' : '{%-#%}') : next.text,
        );
        trimNext = next.text.endsWith('-%}');
        boundaryDash = trimNext;
        atTagBoundary = true;
        prevKind = 'comment';
        i++;
        continue;
      }
      emit.mark();
      emit.pushPlain(text);
      trimNext = false;
    } else if (segment.kind === 'protected') {
      emit.pushProtected(LIQUID_TAG_OPEN.test(segment.text) ? minifyLiquidTag(segment.text) : segment.text);
      trimNext = false;
      atTagBoundary = segment.text.startsWith('{');
      boundaryDash = atTagBoundary && /-(?:%|\})\}$/.test(segment.text);
    } else {
      // 'comment' segments are dropped entirely (rule 1), but the dashes still
      // act: `{%-` trims the preceding text token, `-%}` the following one.
      if (prevKind === 'plain' && segment.text.startsWith('{%-')) emit.trimTrailingWhitespace();
      trimNext = segment.text.endsWith('-%}');
      atTagBoundary = true;
      boundaryDash = trimNext;
    }
    prevKind = segment.kind;
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
 * @returns {{blocks: BlockReport[], missingDirs: string[], originalBytes: number, minifiedBytes: number}}
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

  // A configured directory that is not there is REPORTED, never shrugged off.
  // `listBlockFiles` skips it so a repo without snippets still works, but a
  // renamed or moved folder would otherwise silently drop out of the budget --
  // the check would print 'fits' while the deploy fails on the 100 KiB limit,
  // which is the exact failure this scan was widened to prevent.
  const missingDirs = (Array.isArray(dirs) ? dirs : [dirs]).filter((d) => !existsSync(d));

  return {
    blocks,
    missingDirs,
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
  for (const dir of report.missingDirs ?? []) {
    console.warn(`  ⚠️  configured Liquid directory not found, NOT counted: ${dir}`);
  }
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
