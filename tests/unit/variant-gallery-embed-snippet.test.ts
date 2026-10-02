import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { minifyLiquid, EXTENSION_DIR } from '../../scripts/minify-liquid-blocks.mjs';
import { forLiquidjs, makeEngine, read, type Annotate, type Variant } from './helpers/liquid-engine';

/**
 * Variant-gallery embed: the JSON island is built in a `capture` and printed
 * into the unchanged <script id="cp-embed-data-...">.
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

// NOT in the list: a model without a GLB source. liquidjs evaluates
// `assign x = blank` differently from Ruby Liquid (the comparison against
// `blank` that follows the loop is true for the literal itself), so the
// "no GLB, emit nothing" rule cannot be rendered here -- it is pinned
// statically in the snippet test instead.
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
  const frozen = read(FROZEN);
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
