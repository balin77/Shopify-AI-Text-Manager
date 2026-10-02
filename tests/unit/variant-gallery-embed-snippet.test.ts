import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { minifyLiquid, EXTENSION_DIR } from '../../scripts/minify-liquid-blocks.mjs';
import { forLiquidjs, makeEngine, read, type Annotate, type Variant } from './helpers/liquid-engine';

/**
 * Variant-gallery embed: the JSON island is built in a `capture` and printed
 * into the unchanged <script id="cp-embed-data-...">, and every object body
 * lives ONCE in snippets/cp-vg-item.liquid.
 *
 * Differential render test: the FROZEN pre-refactor block
 * (tests/fixtures/liquid/variant-gallery-embed.a8da7d1.frozen.liquid -- a copy
 * of the block at commit a8da7d1, never edit it) and the current block are
 * rendered with liquidjs over the same fixtures and the island of each is
 * compared per variant after JSON.parse. liquidjs is not Shopify's Liquid (see
 * liquid-minify-render-parity.test.ts for the stubs and the findings); the
 * snippet annotation Shopify wraps around `render` output is emulated by the
 * engine helper in three modes so the cut line is exercised.
 */

const BLOCK = join(EXTENSION_DIR, 'blocks', 'variant-gallery-embed.liquid');
const SNIPPET = join(EXTENSION_DIR, 'snippets', 'cp-vg-item.liquid');
const CONTROLLER = join(EXTENSION_DIR, 'assets', 'variant-gallery-embed.js');
const FROZEN = join(__dirname, '..', 'fixtures', 'liquid', 'variant-gallery-embed.a8da7d1.frozen.liquid');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const img = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  src: `p/${id}.jpg`,
  alt: '',
  width: 800,
  height: 600,
  media_type: 'image',
  ...extra,
});
const video = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  media_type: 'video',
  alt: `video ${id}`,
  preview_image: img(id + 1000, { media_type: undefined }),
  sources: [
    { url: `https://cdn.example/v${id}.mp4`, mime_type: 'video/mp4' },
    { url: `https://cdn.example/v${id}.webm`, mime_type: 'video/webm' },
  ],
  ...extra,
});
const mf = (value: unknown) => ({ value });

// Models without a usable GLB are in the list on purpose (131: only a usdz
// source, 132: no sources at all, 133: a GLB but no preview image): the rule
// "a model without a GLB source emits nothing" is rendered, not just read.
const productMedia = [
  img(101, { alt: 'front </script><b>', preview_image: img(101, { media_type: undefined }) }),
  img(102),
  { ...img(103), no_url: true },
  video(110),
  video(111, { sources: [] }),
  { id: 120, media_type: 'external_video', host: 'youtube', external_id: 'dQw4w9WgXcQ', alt: '', preview_image: img(1120) },
  { id: 121, media_type: 'external_video', host: 'vimeo', external_id: '555', alt: 'v', preview_image: null },
  {
    id: 130,
    media_type: 'model',
    alt: '3d </script>',
    preview_image: img(1130),
    sources: [
      { url: 'https://cdn.example/m.usdz', format: 'usdz' },
      { url: 'https://cdn.example/m.glb', format: 'GLB' },
    ],
  },
  { id: 131, media_type: 'model', alt: 'noglb', preview_image: img(1131), sources: [{ url: 'https://cdn.example/n.usdz', format: 'usdz' }] },
  { id: 132, media_type: 'model', alt: 'nosrc', preview_image: img(1132), sources: [] },
  { id: 133, media_type: 'model', alt: 'nopreview', preview_image: null, sources: [{ url: 'https://cdn.example/q.glb', format: 'glb' }] },
  img(134, { alt: null }),
];

const YT = 'https://youtu.be/dQw4w9WgXcQ?t=3';
const variants = [
  // No metafields: fallback path; featured id == media id 101 (the dedup hits).
  { id: 9001, title: 'Plain A', featured_image: img(101), metafields: { custom: {} } },
  // Fallback; featured image is not a product medium id (no dedup), shares the fallback with the others.
  { id: 9002, title: 'Plain B', featured_image: img(555), metafields: { custom: {} } },
  // Fallback without a featured image.
  { id: 9003, title: 'Plain C </script><b>', featured_image: null, metafields: { custom: {} } },
  // Order path, every entry kind, duplicates, an unknown file, tails.
  {
    id: 9004,
    title: 'Ordered </script><b>',
    featured_image: img(201),
    metafields: {
      custom: {
        variant_gallery: mf([
          img(201),
          img(202, { alt: '' }),
          video(203),
          { ...img(204), no_url: true },
          { id: 205, media_type: 'external_video', alt: 'x', preview_image: img(1205), host: 'youtube', external_id: 'zzz' },
          img(206, { alt: 'tail </script><b>' }),
          video(207, { preview_image: null }),
        ]),
        variant_gallery_order: mf([
          { kind: 'file', value: 202 },
          { kind: 'url', value: YT },
          { kind: 'url', value: 'https://vimeo.com/123456789' },
          { kind: 'url', value: 'https://example.com/not-a-video' },
          { kind: 'url', value: ` ${YT} ` },
          { kind: 'model', value: 'https://cdn.example/m1.glb' },
          { kind: 'model', value: 'https://cdn.example/m1.glb' },
          { kind: 'file', value: 202 },
          { kind: 'file', value: 999 },
          { kind: 'file', value: 203 },
          { kind: 'file', value: 205 },
          { kind: 'file', value: 204 },
        ]),
        variant_3d_models: mf(['https://cdn.example/m1.glb', 'https://cdn.example/m2.glb']),
        variant_3d_previews: mf(['https://cdn.example/m1.jpg']),
        variant_external_videos: mf([YT, 'https://www.youtube.com/shorts/abcDEF12345', 'nonsense']),
      },
    },
  },
  // Default path: images first, then videos, then URLs, then models.
  {
    id: 9005,
    title: 'Default',
    featured_image: img(301),
    metafields: {
      custom: {
        variant_gallery: mf([img(301), video(302), img(303, { alt: 'x</script><b>' }), video(304, { sources: [] }), { ...img(305), no_url: true }]),
        variant_external_videos: mf([
          'https://www.youtube.com/shorts/abcDEF12345',
          'https://vimeo.com/55555',
          'https://example.com/not-a-video',
          'https://youtu.be/',
          'https://www.youtube.com/watch?v=abc123&list=a,b',
        ]),
        variant_3d_models: mf(['https://cdn.example/m3.glb', '  ']),
      },
    },
  },
  // Default path through models only, no featured image.
  {
    id: 9006,
    title: 'Models only',
    featured_image: null,
    metafields: { custom: { variant_3d_models: mf(['https://cdn.example/m4.glb']), variant_3d_previews: mf(['https://cdn.example/m4.jpg']) } },
  },
  // Gallery set but every image URL empty: has_any stays false, so the fallback runs.
  { id: 9007, title: 'Empty gallery', featured_image: null, metafields: { custom: { variant_gallery: mf([{ ...img(401), no_url: true }]) } } },
];

const product = {
  id: 7001,
  title: 'Kumiko </script>Box',
  media: productMedia,
  variants,
  selected_or_first_available_variant: variants[0],
};

const SCOPES: Record<string, unknown> = {
  'product with every path': product,
  'product with a single plain variant': { ...product, variants: [variants[0]], selected_or_first_available_variant: variants[0] },
  'product without media': { ...product, media: [] },
};

function island(html: string): Record<string, any[]> {
  const m = html.match(/<script type="application\/json" id="cp-embed-data-blk1">([\s\S]*?)<\/script>/);
  expect(m, 'island present').not.toBeNull();
  return JSON.parse(m![1]);
}

async function renderIsland(source: string, variant: Variant, annotate: Annotate, prod: unknown) {
  const engine = makeEngine(variant, { annotate });
  const text = variant === 'minified' ? minifyLiquid(source) : source;
  const html = await engine.parseAndRender(forLiquidjs(text), {
    product: prod,
    block: { id: 'blk1', settings: { thumbnail_size: 80 } },
  });
  return { html, data: island(html) };
}

// ---------------------------------------------------------------------------

describe('variant-gallery-embed: island built in a capture renders like the frozen block', () => {
  // The frozen block starts its GLB search with `assign cp_glb = blank`, which liquidjs
  // evaluates differently from Ruby Liquid (the literal is not "blank" afterwards). `''`
  // is the Ruby-equivalent spelling (`'' == blank`), so the test renders the frozen text
  // with that one substitution; the file itself stays untouched.
  const frozenRaw = read(FROZEN);
  const frozen = frozenRaw.replace('{%- assign cp_glb = blank -%}', "{%- assign cp_glb = '' -%}");
  const current = read(BLOCK);

  for (const [scopeName, prod] of Object.entries(SCOPES)) {
    for (const variant of ['source', 'minified'] as const) {
      for (const annotate of ['none', 'all', 'first'] as const) {
        it(`${scopeName} -- ${variant}, annotations: ${annotate}`, async () => {
          const before = await renderIsland(frozen, variant, annotate, prod);
          const after = await renderIsland(current, variant, annotate, prod);
          expect(Object.keys(after.data)).toEqual(Object.keys(before.data));
          for (const id of Object.keys(before.data)) {
            expect(after.data[id], `variant ${id}`).toEqual(before.data[id]);
          }
        });
      }
    }
  }

  it('the frozen-text substitution applies (otherwise the frozen side would not be comparable)', () => {
    expect(frozenRaw).toContain('{%- assign cp_glb = blank -%}');
    expect(frozenRaw).not.toBe(frozen);
  });

  it('the fixtures are not vacuous: every item type and every path shows up', async () => {
    const { data } = await renderIsland(current, 'source', 'none', product);
    const all = Object.values(data).flat();
    expect(new Set(all.map((e: any) => e.type))).toEqual(new Set(['image', 'video', 'external_video', 'model']));
    // order path, default path, models-only path, fallback
    expect(data['9004'].length).toBeGreaterThan(8);
    expect(data['9005'].length).toBeGreaterThan(6);
    expect(data['9006']).toHaveLength(1);
    expect(data['9001'].length).toBeGreaterThan(3);
    // gallery set but every image URL empty: nothing emitted by the gallery, so the fallback runs
    expect(data['9007'].length).toBeGreaterThan(3);
    // models: only the one with a GLB source (and a preview) is emitted; a usdz-only
    // model, one without sources and one without preview emit nothing
    const fallbackModels = data['9003'].filter((e: any) => e.type === 'model');
    expect(fallbackModels.map((e: any) => e.model_src)).toEqual(['https://cdn.example/m.glb']);
    expect(all.every((e: any) => e.type !== 'model' || e.model_src !== '')).toBe(true);
    // an alt text with markup survives as DATA
    expect(JSON.stringify(data)).toContain('front </script><b>');
    // ... and never as markup: the island text itself carries no raw `<` in a value
    const { html } = await renderIsland(current, 'source', 'none', product);
    const text = html.match(/id="cp-embed-data-blk1">([\s\S]*?)<\/script>/)![1];
    expect(text).not.toContain('</script');
    expect(text).not.toContain('<b>');
  });

  it('the island element, its id and the placeholder order are unchanged', async () => {
    const { html } = await renderIsland(current, 'source', 'none', product);
    expect(html).toContain('<script type="application/json" id="cp-embed-data-blk1">');
    expect(html.indexOf('cp-embed-data-blk1')).toBeLessThan(html.indexOf('variant-gallery-embed.js'));
    expect(html.indexOf('variant-gallery-embed.js')).toBeLessThan(html.indexOf('<cp-embed-gallery'));
  });
});

// ---------------------------------------------------------------------------
// The snippet: contract, escape rule, call sites
// ---------------------------------------------------------------------------

const BS = String.fromCharCode(92); // a backslash, spelled so no tool can decode it away
const LT_ESCAPE = `${BS}u003c`;
const GT_ESCAPE = `${BS}u003e`;

/** Keys of one gallery entry per type: the contract with the controller. */
const KEYS_BY_TYPE: Record<string, string[]> = {
  image: ['type', 'src_400', 'src_800', 'src_1200', 'thumb', 'w', 'h', 'alt'],
  video: ['type', 'thumb', 'poster', 'w', 'h', 'alt', 'sources'],
  external_video: ['type', 'thumb', 'poster', 'w', 'h', 'alt', 'host', 'external_id'],
  model: ['type', 'thumb', 'poster', 'w', 'h', 'alt', 'model_src'],
};

/**
 * Every property assets/variant-gallery-embed.js reads off a gallery entry (the
 * render functions and the thumbnail strip). Explicit on purpose: a regex over
 * the file would also catch DOM calls such as `img.decode()`. The test below
 * keeps this list honest in both directions.
 */
const READ_BY_CONTROLLER = [
  'type',
  'src_400',
  'src_800',
  'src_1200',
  'thumb',
  'poster',
  'w',
  'h',
  'alt',
  'sources',
  'host',
  'external_id',
  'model_src',
];
/** Properties of a video source entry. */
const READ_BY_CONTROLLER_SOURCE = ['src', 'mime'];

const SNIPPET_PARAMS = ['m', 'kind', 'alt', 'fb', 'url', 'model', 'preview'];

// The cut of Shopify's snippet annotation, printed inline (no extra assign: every assign counts
// against Shopify's memory limit). The emptiness test is `contains '"type"'`: an emitted object
// always has a type key, an annotation never does.
const CUT_PRINT = "{{ cp_o | split: '-->' | last | split: '<!--' | first | strip }}";
const CALL_LINE_RE = /^\s*\{%- if cp_o contains '"type"' -%\}.*\{%- endif -%\}$/;
const CUT_LINE_SNIPPET = "{%- assign cp_i_pair = cp_i_pair | split: '-->' | last | split: '<!--' | first | strip -%}";

describe('cp-vg-item: static contract', () => {
  const snippet = read(SNIPPET);
  const block = read(BLOCK);
  const controller = read(CONTROLLER);

  it('prints its output with < and > escaped, byte-exact', () => {
    const lastLine = snippet.trimEnd().split('\n').pop()!;
    expect(lastLine).toBe(`{{- cp_i_out | replace: "<", "${LT_ESCAPE}" | replace: ">", "${GT_ESCAPE}" -}}`);
    // The control that makes this test able to fail: pattern and replacement
    // must differ, and the replacement is six characters (a backslash, "u003", a letter).
    expect(LT_ESCAPE).toHaveLength(6);
    expect(LT_ESCAPE).not.toBe('<');
    expect(lastLine.split('"<"')).toHaveLength(2);
    expect(lastLine).toContain(`, "${BS}u003c"`);
    expect(lastLine).toContain(`, "${BS}u003e"`);
  });

  it('every alt goes through the single `| json` assign, never raw', () => {
    expect(snippet).toContain('{%- assign cp_i_alt = alt | default: fb | json -%}');
    const altUses = snippet.match(/"alt":\{\{[^}]*\}\}/g) ?? [];
    expect(altUses.length).toBeGreaterThanOrEqual(4);
    for (const u of altUses) expect(u).toBe('"alt":{{ cp_i_alt }}');
  });

  it('is the only place with an object body: the block carries no "type": entry', () => {
    expect(block).not.toMatch(/"type"\s*:\s*"(image|video|external_video|model)"/);
    expect(block).not.toMatch(/"src_(400|800|1200)"/);
    for (const type of Object.keys(KEYS_BY_TYPE)) expect(snippet).toContain(`"type":"${type}"`);
  });

  it('emits exactly the keys the controller reads, per type', () => {
    const bodies = snippet.match(/\{"type":"[a-z_]+",[^\n]*/g) ?? [];
    // The video/external_video/model bodies in product-media mode share cp_i_media.
    const mediaKeys = ['thumb', 'poster', 'w', 'h', 'alt'];
    const seen: Record<string, Set<string>> = {};
    for (const b of bodies) {
      const type = b.match(/"type":"([a-z_]+)"/)![1];
      const keys = [...b.matchAll(/"([a-z_0-9]+)":/g)].map((m) => m[1]);
      const set = (seen[type] ??= new Set());
      keys.forEach((k) => set.add(k));
      if (b.includes('{{ cp_i_media }}')) mediaKeys.forEach((k) => set.add(k));
    }
    for (const [type, expected] of Object.entries(KEYS_BY_TYPE)) {
      expect([...(seen[type] ?? [])].sort(), type).toEqual([...expected].sort());
    }
    expect(snippet).toContain('"sources":[');
    expect(snippet).toContain('{"src":{{ s.url | json }},"mime":{{ s.mime_type | json }}}');
  });

  it('the controller reads nothing the snippet does not emit (and the list is not stale)', () => {
    const union = new Set(Object.values(KEYS_BY_TYPE).flat());
    for (const prop of READ_BY_CONTROLLER) expect(union.has(prop), `${prop} is emitted`).toBe(true);
    for (const prop of READ_BY_CONTROLLER) {
      // `type` is read as `item.type`; the rest as `img.<k>` / `item.<k>`.
      expect(controller, `${prop} is read by the controller`).toMatch(new RegExp(`\\b(?:img|item)\\.${prop}\\b`));
    }
    for (const prop of READ_BY_CONTROLLER_SOURCE) expect(controller).toMatch(new RegExp(`\\bs\\.${prop}\\b`));
    // Whatever else the render functions read off `item` / `img` must be in the list.
    const renderPart = controller.slice(controller.indexOf('_ratioStyle'), controller.indexOf('_render(images)'));
    const reads = new Set([...renderPart.matchAll(/\b(?:img|item)\.([a-z_0-9]+)\b/g)].map((m) => m[1]));
    const DOM_CALLS = new Set(['decode', 'dataset', 'style', 'addEventListener', 'getBoundingClientRect', 'src', 'srcset', 'sizes', 'alt']);
    // `img.src` / `img.alt` on a DOM node (the zoom code) are not gallery data
    // (that code is after _render); inside renderPart only gallery data is read.
    for (const r of reads) {
      if (DOM_CALLS.has(r) && !READ_BY_CONTROLLER.includes(r)) continue;
      expect(READ_BY_CONTROLLER, `controller reads .${r}`).toContain(r);
    }
  });

  it('only YouTube and Vimeo URL entries are emitted (host guard)', () => {
    expect(snippet).toContain("{%- if cp_i_host == 'youtube' or cp_i_host == 'vimeo' -%}");
  });

  it('every render of cp-vg-item is captured and directly followed by the annotation cut', () => {
    const lines = block.split('\n');
    const renders = lines.map((l, i) => ({ l, i })).filter((x) => x.l.includes("render 'cp-vg-item'"));
    expect(renders.length).toBeGreaterThanOrEqual(10);
    for (const { l, i } of renders) {
      expect(l, `line ${i + 1}`).toMatch(/^\s*\{%- capture cp_o -%\}\{%- render 'cp-vg-item'.*\{%- endcapture -%\}$/);
      expect(lines[i + 1], `line ${i + 2}`).toMatch(CALL_LINE_RE);
      expect(lines[i + 1], `line ${i + 2}`).toContain(CUT_PRINT);
    }
    expect((block.match(/split: '-->'/g) ?? []).length).toBe(renders.length);
    // no captured render is ever printed or tested without the cut: cp_o appears only in the capture and these lines
    expect(block.match(/\{\{\s*cp_o\s*\}\}/g)).toBeNull();
    expect(block).not.toMatch(/cp_o != blank/);
    // The snippet's own nested render of the URL parser is cut the same way.
    const own = snippet.split('\n');
    const at = own.findIndex((l) => l.includes("render 'cp-external-video'"));
    expect(at).toBeGreaterThan(-1);
    expect(own[at + 1]).toBe(CUT_LINE_SNIPPET);
    // ... and the block no longer calls the URL parser itself.
    expect(block).not.toContain("render 'cp-external-video'");
  });

  it('callers pass only parameters the snippet knows, and the snippet documents them', () => {
    const calls = [...block.matchAll(/render 'cp-vg-item'([^%]*)-%\}/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      const keys = [...c[1].matchAll(/[,\s]([a-z_]+):/g)].map((m) => m[1]);
      expect(keys.length).toBeGreaterThan(0);
      for (const k of keys) expect(SNIPPET_PARAMS, `param ${k}`).toContain(k);
    }
    for (const p of SNIPPET_PARAMS) expect(snippet).toMatch(new RegExp(`^    ${p}\\s+\\S`, 'm'));
  });

  it('the island element wraps only the captured JSON', () => {
    expect(block).toContain('{%- capture cp_vg_json -%}');
    expect(block).toContain(
      '{%- endcapture -%}\n<script type="application/json" id="cp-embed-data-{{ block.id }}">{{ cp_vg_json }}</script>',
    );
    expect((block.match(/id="cp-embed-data-\{\{ block\.id \}\}"/g) ?? []).length).toBe(1);
  });

  it('the placeholder stays the last element of the block (head invariant)', () => {
    const script = block.indexOf('<script src="{{ \'variant-gallery-embed.js\' | asset_url }}" defer></script>');
    const placeholder = block.lastIndexOf('<cp-embed-gallery'); // the first hit is in a comment
    const endif = block.indexOf('{%- endif -%}', placeholder);
    expect(script).toBeGreaterThan(-1);
    expect(placeholder).toBeGreaterThan(script);
    expect(endif).toBeGreaterThan(placeholder);
    expect(block.slice(endif).includes('<script')).toBe(false);
  });

  it('the render-parity test covers the snippet (it walks the snippets directory)', () => {
    expect(readdirSync(join(EXTENSION_DIR, 'snippets'))).toContain('cp-vg-item.liquid');
    expect(read(join(__dirname, 'liquid-minify-render-parity.test.ts'))).toContain('LIQUID_DIRS');
  });
});

// ---------------------------------------------------------------------------
// The snippet: rendered behaviour
// ---------------------------------------------------------------------------

describe('cp-vg-item: rendered behaviour', () => {
  const block = read(BLOCK);

  it('every rendered entry carries exactly the keys of its type', async () => {
    for (const variant of ['source', 'minified'] as const) {
      const { data } = await renderIsland(block, variant, 'all', product);
      for (const e of Object.values(data).flat() as any[]) {
        expect(Object.keys(e).sort(), `${variant} ${e.type}`).toEqual([...KEYS_BY_TYPE[e.type]].sort());
      }
    }
  });

  it('a URL that must not leave the island (</script>, -->) neither breaks it nor gets cut', async () => {
    const hostile = 'https://cdn.example/a</script><b>-->.glb';
    const p = {
      id: 1,
      title: 'T',
      media: [],
      variants: [
        {
          id: 1,
          title: 'V',
          featured_image: img(1),
          metafields: {
            custom: {
              variant_gallery_order: mf([{ kind: 'model', value: hostile }]),
              variant_3d_models: mf([hostile]),
              variant_3d_previews: mf([`https://cdn.example/p-->.jpg`]),
            },
          },
        },
      ],
    };
    for (const variant of ['source', 'minified'] as const) {
      for (const annotate of ['none', 'all'] as const) {
        const { html, data } = await renderIsland(block, variant, annotate, p);
        const text = html.match(/id="cp-embed-data-blk1">([\s\S]*?)<\/script>/)![1];
        expect(text).not.toContain('<');
        expect(text).not.toContain('>');
        const models = data['1'].filter((e: any) => e.type === 'model');
        expect(models).toHaveLength(1);
        expect(models[0].model_src).toBe(hostile);
        expect(models[0].thumb).toBe('https://cdn.example/p-->.jpg');
      }
    }
  });

  /** Number of times the snippet was read = number of `render 'cp-vg-item'`. */
  async function countItemRenders(prod: unknown) {
    const engine = makeEngine('source', { annotate: 'all' });
    const fs = (engine.options as any).fs;
    let n = 0;
    const readFile = fs.readFile.bind(fs);
    fs.readFile = async (file: string) => {
      if (file.includes('cp-vg-item')) n += 1;
      return readFile(file);
    };
    await engine.parseAndRender(forLiquidjs(read(BLOCK)), { product: prod, block: { id: 'blk1', settings: {} } });
    return n;
  }

  it('the fallback renders product.media ONCE per product, however many variants share it', async () => {
    const plain = (id: number) => ({ id, title: `V${id}`, featured_image: img(id), metafields: { custom: {} } });
    const media = [img(1), img(2), img(3), video(10), { id: 20, media_type: 'external_video', host: 'youtube', external_id: 'abc', alt: '', preview_image: img(30) }];
    const mk = (n: number) => ({ id: 1, title: 'P', media, variants: Array.from({ length: n }, (_, i) => plain(500 + i)), });
    const few = await countItemRenders(mk(2));
    const many = await countItemRenders(mk(20));
    // media memo (5) + one featured render per variant
    expect(few).toBe(5 + 2);
    expect(many).toBe(5 + 20);
  });

  it('the memo is not built for a product whose variants all carry their own gallery', async () => {
    const own = (id: number) => ({
      id,
      title: `V${id}`,
      featured_image: null,
      metafields: { custom: { variant_gallery: mf([img(900 + id)]) } },
    });
    const prod = { id: 1, title: 'P', media: [img(1), img(2), img(3)], variants: [own(1), own(2), own(3)] };
    expect(await countItemRenders(prod)).toBe(3); // one gallery image per variant, no media renders
  });

  it('a variant that lands in the fallback after others did not still gets the memo', async () => {
    const prod = {
      id: 1,
      title: 'P',
      media: [img(1), img(2)],
      variants: [
        { id: 1, title: 'A', featured_image: null, metafields: { custom: { variant_gallery: mf([img(7)]) } } },
        { id: 2, title: 'B', featured_image: null, metafields: { custom: {} } },
        { id: 3, title: 'C', featured_image: null, metafields: { custom: {} } },
      ],
    };
    const { data } = await renderIsland(block, 'source', 'all', prod);
    expect(data['1']).toHaveLength(1);
    expect(data['2']).toHaveLength(2);
    expect(data['3']).toHaveLength(2);
  });
});
