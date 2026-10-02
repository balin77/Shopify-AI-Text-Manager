import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { minifyLiquid, EXTENSION_DIR } from '../../scripts/minify-liquid-blocks.mjs';
import { forLiquidjs, makeEngine, read, type Variant } from './helpers/liquid-engine';

/**
 * variant-gallery.liquid (the section block): its JSON island is built in a
 * `capture` and printed into the unchanged <script id="cp-gallery-data-...">.
 * Differential render against the FROZEN pre-refactor block
 * (tests/fixtures/liquid/variant-gallery.a8da7d1.frozen.liquid, a copy from
 * commit a8da7d1 -- never edit it), compared per variant after JSON.parse.
 */
const CURRENT = join(EXTENSION_DIR, 'blocks', 'variant-gallery.liquid');
const FROZEN = join(__dirname, '..', 'fixtures', 'liquid', 'variant-gallery.a8da7d1.frozen.liquid');

const img = (id: number, extra: Record<string, unknown> = {}) => ({ id, src: `p/${id}.jpg`, width: 800, height: 600, ...extra });
const mf = (value: unknown) => ({ value });

const variants = [
  { id: 1, title: 'Plain', featured_image: null, metafields: { custom: {} } },
  { id: 2, title: 'Featured only </script><b>', featured_image: img(10), metafields: { custom: {} } },
  {
    id: 3,
    title: 'Gallery',
    featured_image: img(10),
    metafields: {
      custom: {
        variant_gallery: mf([img(10), img(11, { preview_image: img(11, { width: 400, height: 300 }) }), { ...img(12), no_url: true }]),
      },
    },
  },
];
const product = { id: 1, title: 'P', variants, selected_or_first_available_variant: variants[0] };

async function island(source: string, variant: Variant, prod: unknown) {
  const engine = makeEngine(variant);
  const text = forLiquidjs(variant === 'minified' ? minifyLiquid(source) : source);
  const html = await engine.parseAndRender(text, {
    product: prod,
    block: { id: 'blk1', settings: { thumbnail_size: 80 }, shopify_attributes: '' },
    current_variant: variants[0],
  });
  const m = html.match(/<script type="application\/json" id="cp-gallery-data-blk1">([\s\S]*?)<\/script>/);
  expect(m, 'island present').not.toBeNull();
  return { html, text: m![1], data: JSON.parse(m![1]) as Record<string, any[]> };
}

describe('variant-gallery: island built in a capture renders like the frozen block', () => {
  for (const variant of ['source', 'minified'] as const) {
    for (const [name, prod] of Object.entries({ product, 'no product': undefined })) {
      it(`${name} -- ${variant}`, async () => {
        const before = await island(read(FROZEN), variant, prod);
        const after = await island(read(CURRENT), variant, prod);
        expect(after.data).toEqual(before.data);
      });
    }
  }

  it('is not vacuous, keeps the element id, and markup in a title stays data', async () => {
    const { text, data, html } = await island(read(CURRENT), 'source', product);
    expect(data['3']).toHaveLength(3); // featured + two usable gallery images (the third has no URL)
    expect(data['3'][2].w).toBe(400);
    expect(data['2'][0].alt).toBe('Featured only </script><b>');
    expect(text).not.toContain('<');
    expect(html).toContain('<script type="application/json" id="cp-gallery-data-blk1">');
  });

  it('the block wraps only {{ cp_g_json }} in the island element', () => {
    const src = read(CURRENT);
    expect(src).toContain(
      '{%- endcapture -%}\n<script type="application/json" id="cp-gallery-data-{{ block.id }}">{{ cp_g_json }}</script>',
    );
  });
});
