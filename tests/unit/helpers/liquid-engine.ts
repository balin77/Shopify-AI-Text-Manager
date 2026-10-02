import { Liquid, Tag, TagToken, Context, Emitter, TopLevelToken } from 'liquidjs';
import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { minifyLiquid, EXTENSION_DIR } from '../../../scripts/minify-liquid-blocks.mjs';

/**
 * Shared liquidjs engine for the storefront extension's render tests: Shopify
 * filters/tags stubbed deterministically, snippets resolved from
 * extensions/storefront/snippets (optionally minified, optionally wrapped in
 * Shopify's "<!-- BEGIN app snippet -->" annotation). See
 * liquid-minify-render-parity.test.ts for what is and is not covered.
 */

export const read = (p: string) => readFileSync(p, 'utf8');

/**
 * Two liquidjs/Ruby differences the extension relies on, bridged here.
 * (1) liquidjs decodes backslash escapes inside string literals (backslash-u003c
 * becomes "<"), Shopify's Ruby Liquid does NOT (the backslash stays). The extension
 * relies on the Ruby behaviour (`replace: "<", "\u003c"` must emit the six
 * characters), so every template handed to liquidjs goes through this first:
 * the backslash of those two sequences is doubled, which liquidjs reads back as
 * one literal backslash.
 */
export const forLiquidjs = (s: string) =>
  s
    .replace(/\\u003([ce])/g, '\\\\u003$1')
    // Second difference: `assign x = nil` is `blank` in Ruby (nil == blank), but
    // liquidjs keeps an explicit null that does NOT equal `blank` (a variable that
    // was never set does). An unset variable is the faithful stand-in.
    .replace(/=\s*nil\b/g, '= __nil__');

export type Variant = 'source' | 'minified';

/** How Shopify's snippet annotation is emulated around `render` output. */
export type Annotate = 'none' | 'all' | 'first';

export interface EngineOptions {
  /** Directory the `render 'x'` snippets are read from. */
  snippetsDir?: string;
  /** Wrap each rendered snippet in the BEGIN/END annotation comments. */
  annotate?: Annotate;
}

export const SNIPPETS = join(EXTENSION_DIR, 'snippets');

export function makeEngine(variant: Variant, opts: EngineOptions = {}) {
  const dir = opts.snippetsDir ?? SNIPPETS;
  const annotate = opts.annotate ?? 'none';
  let reads = 0;
  const transform = (s: string, file: string) => {
    const body = forLiquidjs(variant === 'minified' ? minifyLiquid(s) : s);
    reads += 1;
    if (annotate === 'none' || (annotate === 'first' && reads > 1)) return body;
    const name = basename(file).replace(/\.liquid$/, '');
    return `<!-- BEGIN app snippet: ${name} -->${body}<!-- END app snippet -->`;
  };
  const engine = new Liquid({
    root: ['/virtual'],
    extname: '.liquid',
    relativeReference: false,
    // Unknown filters / variables must not throw: Shopify-only ones pass through.
    strictFilters: false,
    strictVariables: false,
    fs: {
      async readFile(file: string) {
        return transform(read(join(dir, basename(file))), file);
      },
      readFileSync(file: string) {
        return transform(read(join(dir, basename(file))), file);
      },
      async exists() {
        return true;
      },
      existsSync() {
        return true;
      },
      resolve(_root: string, file: string, ext: string) {
        return `/virtual/${file}${ext}`;
      },
    },
  });

  const fmt = (v: unknown) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? ''));
  const args = (a: unknown[]) => a.map(fmt).join(',');

  engine.registerFilter('image_url', function (this: unknown, v: any, ...a: unknown[]) {
    const id = v && typeof v === 'object' ? (v.src ?? v.id ?? v.url ?? 'obj') : v;
    // `no_url` stands for an image Shopify cannot produce a URL for.
    if (v && typeof v === 'object' && v.no_url) return '';
    return v == null || v === '' ? '' : `https://cdn.example/${id}?${args(a)}`;
  });
  engine.registerFilter('asset_url', (v: unknown) => `https://cdn.example/assets/${fmt(v)}`);
  engine.registerFilter('t', (v: unknown, ...a: unknown[]) => `[t:${fmt(v)}${a.length ? ':' + args(a) : ''}]`);
  engine.registerFilter('image_tag', (v: unknown, ...a: unknown[]) => `<img src="${fmt(v)}" data-a="${args(a)}">`);
  engine.registerFilter('stylesheet_tag', (v: unknown) => `<link rel="stylesheet" href="${fmt(v)}">`);
  engine.registerFilter('money', (v: unknown) => `$${(Number(v) / 100).toFixed(2)}`);
  engine.registerFilter('money_without_currency', (v: unknown) => (Number(v) / 100).toFixed(2));
  engine.registerFilter('structured_data', (v: unknown) => fmt(v));
  engine.registerFilter('url_decode', (v: unknown) => {
    try {
      return decodeURIComponent(fmt(v));
    } catch {
      return fmt(v);
    }
  });
  engine.registerFilter('strip_html', (v: unknown) => fmt(v).replace(/<[^>]*>/g, ''));

  // {% schema %}...{% endschema %}: Shopify consumes it; here its body is
  // emitted so the minified schema JSON is compared too.
  engine.registerTag('schema', {
    tokens: [] as TopLevelToken[],
    parse(this: any, tagToken: TagToken, remainTokens: TopLevelToken[]) {
      this.tokens = [];
      const stream = this.liquid.parser.parseStream(remainTokens);
      stream
        .on('token', (t: any) => {
          if (t.name === 'endschema') stream.stop();
          else this.tokens.push(t);
        })
        .on('end', () => {
          throw new Error(`tag ${tagToken.getText()} not closed`);
        });
      stream.start();
    },
    render(this: any, _ctx: Context, emitter: Emitter) {
      // The body is whitespace-insensitive JSON (the minifier is allowed to
      // reflow it), so compare its parsed form; unparseable bodies stay raw.
      const raw = this.tokens.map((t: any) => t.input.slice(t.begin, t.end)).join('');
      let body = raw;
      try {
        body = JSON.stringify(JSON.parse(raw));
      } catch {
        /* keep raw */
      }
      emitter.write(`<schema>${body}</schema>`);
    },
  } as unknown as Tag);

  // {% form 'localization', id: x, class: y %}...{% endform %}
  engine.registerTag('form', {
    parse(this: any, tagToken: TagToken, remainTokens: TopLevelToken[]) {
      this.args = tagToken.args;
      this.templates = [];
      const stream = this.liquid.parser.parseStream(remainTokens);
      stream
        .on('template', (tpl: any) => this.templates.push(tpl))
        .on('tag:endform', () => stream.stop())
        .on('end', () => {
          throw new Error(`tag ${tagToken.getText()} not closed`);
        });
      stream.start();
    },
    *render(this: any, ctx: Context, emitter: Emitter) {
      emitter.write(`<form args="${String(this.args).trim()}">`);
      yield this.liquid.renderer.renderTemplates(this.templates, ctx, emitter);
      emitter.write('</form>');
    },
  } as unknown as Tag);

  return engine;
}

