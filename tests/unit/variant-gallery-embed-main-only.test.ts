import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { EXTENSION_DIR } from '../../scripts/minify-liquid-blocks.mjs';
import { forLiquidjs, makeEngine, read } from './helpers/liquid-engine';

/**
 * R4 (variant with a main image and exactly one gallery image loses its main image):
 * the gallery image is promoted and `custom.variant_gallery` becomes `[]`. The embed
 * must then show ONLY the remaining image, not every product medium. The only value that
 * achieves that without a Liquid change is a non-empty `custom.variant_gallery_order`
 * (the order path emits `variant.featured_image` first and never reaches the
 * "no gallery: all product media" fallback); `mainOnlyOrder` writes exactly that.
 *
 * Rendered with liquidjs, which is NOT Shopify's Liquid (see liquid-minify-render-parity.test.ts):
 * this pins the reading of the block's source, the real-shop behaviour is still to be seen.
 */
const BLOCK = join(EXTENSION_DIR, 'blocks', 'variant-gallery-embed.liquid');

const img = (id: number) => ({ id, src: `p/${id}.jpg`, alt: '', width: 800, height: 600, media_type: 'image' });
const mf = (value: unknown) => ({ value });
const GID = (n: number) => `gid://shopify/MediaImage/${n}`;

const media = [img(101), img(102), img(103), img(104)];

async function render(variant: Record<string, unknown>) {
  const v = { id: 9001, title: 'V', ...variant };
  const prod = { id: 1, title: 'P', media, variants: [v], selected_or_first_available_variant: v };
  const html = await makeEngine('source').parseAndRender(forLiquidjs(read(BLOCK)), {
    product: prod,
    block: { id: 'blk1', settings: { thumbnail_size: 80 } },
  });
  const m = html.match(/<script type="application\/json" id="cp-embed-data-blk1">([\s\S]*?)<\/script>/);
  expect(m, 'island present').not.toBeNull();
  return JSON.parse(m![1])['9001'] as Array<{ type: string; src?: string }>;
}

describe('variant-gallery-embed: a main image with an empty gallery', () => {
  it('WITHOUT an order entry the variant falls back to every product medium (the problem)', async () => {
    const items = await render({ featured_image: img(102), metafields: { custom: {} } });
    expect(items).toHaveLength(4);
  });

  it('an empty `variant_gallery` ([]) is the same fallback', async () => {
    const items = await render({ featured_image: img(102), metafields: { custom: { variant_gallery: mf([]) } } });
    expect(items).toHaveLength(4);
  });

  it('with the single-entry order [{file: main}] the embed shows ONLY the main image', async () => {
    const items = await render({
      featured_image: img(102),
      metafields: { custom: { variant_gallery: mf([]), variant_gallery_order: mf([{ kind: 'file', value: GID(102) }]) } },
    });
    expect(items).toHaveLength(1);
    expect(JSON.stringify(items[0])).toContain('102');
  });

  it('a gallery image added later is NOT hidden by that stale entry (the tail emits it)', async () => {
    const items = await render({
      featured_image: img(102),
      metafields: { custom: { variant_gallery: mf([img(103)]), variant_gallery_order: mf([{ kind: 'file', value: GID(102) }]) } },
    });
    expect(items).toHaveLength(2);
    expect(JSON.stringify(items[0])).toContain('102');
    expect(JSON.stringify(items[1])).toContain('103');
  });
});

describe('variant-gallery-embed: an order of only a link (no image left)', () => {
  const YT = 'https://youtu.be/dQw4w9WgXcQ';
  it('with the links-only order [{url}] the embed renders just the link', async () => {
    const items = await render({
      featured_image: null,
      metafields: { custom: { variant_external_videos: mf([YT]), variant_gallery_order: mf([{ kind: 'url', value: YT }]) } },
    });
    expect(items).toHaveLength(1);
    expect((items[0] as { type: string }).type).toBe('external_video');
  });
  it('WITHOUT that order the link alone does not keep the variant out of the all-media fallback (why the order is kept)', async () => {
    const items = await render({ featured_image: null, metafields: { custom: { variant_external_videos: mf([YT]) } } });
    expect(items.length).toBeGreaterThan(1);
  });
});

describe('variant-gallery-embed: why the main-only entry is written for MORE than one variant only', () => {
  it('the embed has no single-variant special case: on a product with ONE variant the entry would hide every other product image', async () => {
    // `render` builds a product with exactly one variant (Shopify's default variant is one too)
    const withEntry = await render({
      featured_image: img(102),
      metafields: { custom: { variant_gallery: mf([]), variant_gallery_order: mf([{ kind: 'file', value: GID(102) }]) } },
    });
    expect(withEntry).toHaveLength(1);
    const without = await render({ featured_image: img(102), metafields: { custom: {} } });
    expect(without).toHaveLength(4); // the fallback is what a single-variant product should keep
  });

  it('a variant with NO main image and an empty gallery falls back to all media whatever the order says about files', async () => {
    const items = await render({ featured_image: null, metafields: { custom: {} } });
    expect(items).toHaveLength(4);
  });
});
