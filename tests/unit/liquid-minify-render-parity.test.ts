import { describe, it, expect } from 'vitest';
import { Liquid } from 'liquidjs';
import { readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { minifyLiquid, LIQUID_DIRS } from '../../scripts/minify-liquid-blocks.mjs';
import { forLiquidjs, makeEngine, read, type Variant } from './helpers/liquid-engine';

/**
 * Differential test for the Liquid minifier: every block and snippet is
 * RENDERED from its commented source and from its minified form with liquidjs,
 * and the two outputs must be identical, under several storefront scenarios.
 *
 * The string-level minifier tests prove what the transform does to bytes; this
 * proves what it does to the rendered storefront. liquidjs is not Shopify's
 * Liquid, so the Shopify-only pieces are stubbed (see `makeEngine`):
 *   - filters: image_url, asset_url, t, image_tag, ... are deterministic
 *     functions of their arguments. They only need to be the SAME function for
 *     both renders.
 *   - tags: `schema` renders its parsed JSON body (so the minified schema is
 *     compared too, semantically -- its whitespace may legally change) and
 *     `form` renders its body inside a marker.
 *   - `render 'x'` resolves snippets from extensions/storefront/snippets, and
 *     the `fs` hands out the SAME variant (source or minified) as the file
 *     being rendered, so a snippet change is covered as well.
 *   - `block.settings` is built from the block's own `{% schema %}` defaults.
 *
 * FINDING (checked for plan Anhang C §2): liquidjs `split` DROPS trailing empty
 * strings like Ruby's Liquid does ('a,b,,' -> [a,b]; 'https://youtu.be/' split
 * on 'youtu.be/' -> ['https://']; ',' -> []). So the snippet-annotation cut
 * (`split: '-->' | last | split: '<!--' | first`) and the id-guard in
 * cp-external-video behave the same here as on Shopify and need no stubbing.
 * It is pinned below so a liquidjs upgrade that changes it fails loudly.
 *
 * NOT covered (liquidjs is not Shopify): Shopify's `<!-- BEGIN app snippet -->`
 * annotation, theme-check rules, real filter output (image_url sizes, money
 * formats) and Shopify's resource drops. A stub that returns the same text for
 * both variants can hide a difference in *how often* or *with which arguments*
 * a filter runs only through the argument strings, which is why the stubs
 * print their arguments.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const img = (id: number, alt = '') => ({
  id,
  src: `p/${id}.jpg`,
  url: `https://cdn.example/p/${id}.jpg`,
  alt,
  width: 800,
  height: 600,
  aspect_ratio: 1.333,
});

const productMedia = [
  { id: 101, media_type: 'image', alt: 'front </script><b>', preview_image: img(101), width: 800, height: 600 },
  {
    id: 102,
    media_type: 'external_video',
    host: 'youtube',
    external_id: 'dQw4w9WgXcQ',
    alt: 'clip',
    preview_image: img(102),
  },
  {
    id: 103,
    media_type: 'video',
    alt: 'file video',
    preview_image: img(103),
    sources: [{ url: 'https://cdn.example/v.mp4', mime_type: 'video/mp4', width: 640, height: 360 }],
  },
  {
    id: 104,
    media_type: 'model',
    alt: '3d',
    preview_image: img(104),
    sources: [{ url: 'https://cdn.example/m.glb', mime_type: 'model/gltf-binary' }],
  },
];

const mf = (value: unknown) => ({ value });

const variants = [
  { id: 9001, title: 'Plain', sku: 'S1', price: 1999, available: true, featured_image: img(101), metafields: { custom: {} } },
  {
    id: 9002,
    title: 'Ordered </script><b>',
    sku: 'S2',
    price: 2999,
    available: false,
    featured_image: img(101),
    metafields: {
      custom: {
        variant_gallery: mf([img(101), img(105)]),
        variant_gallery_order: mf([
          { kind: 'file', value: 105 },
          { kind: 'url', value: 'https://youtu.be/dQw4w9WgXcQ?t=3' },
          { kind: 'url', value: 'https://vimeo.com/123456789' },
          { kind: 'model', value: 'https://cdn.example/m.glb' },
          { kind: 'file', value: 101 },
        ]),
        variant_3d_models: mf(['https://cdn.example/m.glb']),
        variant_3d_previews: mf(['https://cdn.example/m.jpg']),
      },
    },
  },
  {
    id: 9003,
    title: 'Default path',
    sku: 'S3',
    price: 3999,
    available: true,
    featured_image: img(101),
    metafields: {
      custom: {
        variant_gallery: mf([img(101), img(105), { ...img(106), media_type: 'video' }]),
        variant_external_videos: mf([
          'https://youtu.be/dQw4w9WgXcQ',
          'https://www.youtube.com/shorts/abcDEF12345',
          'https://vimeo.com/55555',
          'https://example.com/not-a-video',
        ]),
      },
    },
  },
];

const product = {
  id: 7001,
  title: 'Kumiko Box',
  handle: 'kumiko-box',
  url: '/products/kumiko-box',
  vendor: 'Atelier',
  type: 'Box',
  description: '<p>A <b>box</b> &amp; more</p>',
  available: true,
  price: 1999,
  price_min: 1999,
  price_max: 3999,
  compare_at_price: 2999,
  published_at: '2026-01-01T00:00:00Z',
  featured_image: img(101),
  featured_media: productMedia[0],
  images: [img(101), img(105)],
  media: productMedia,
  variants,
  selected_or_first_available_variant: variants[0],
  selected_variant: variants[0],
  tags: ['a', 'b'],
  metafields: {
    custom: {
      faq: mf([{ question: 'Q1', answer: 'A1' }]),
      mpn: mf('MPN-1'),
      og_description: mf('og desc'),
      og_image: mf(img(101)),
      price_valid_until: mf('2027-01-01'),
      video_upload_dates: mf({ '103': '2026-02-03T04:05:06Z' }),
      video_upload_date: mf('2026-01-01'),
      localized_media: mf({ e: [{ i: 101, l: { de: 'p/de.jpg' } }] }),
    },
    reviews: { rating: mf({ value: 4.5, scale_max: 5 }), rating_count: mf(12) },
  },
};

const shop = {
  name: 'Test Shop',
  url: 'https://shop.example',
  description: 'Shop <desc>',
  locale: 'de',
  currency: 'EUR',
  brand: { logo: img(1) },
  metafields: {},
};

const localization = {
  language: { iso_code: 'de', name: 'Deutsch', endonym_name: 'Deutsch', root_url: '/de' },
  country: { iso_code: 'DE', name: 'Germany', currency: { iso_code: 'EUR', symbol: '€' } },
  market: { id: 5, handle: 'de' },
  available_languages: [
    { iso_code: 'de', name: 'Deutsch', endonym_name: 'Deutsch', root_url: '/de', primary: true },
    { iso_code: 'en', name: 'English', endonym_name: 'English', root_url: '/en', primary: false },
    { iso_code: 'es', name: 'Spanish', endonym_name: 'Español', root_url: '/es', primary: false },
  ],
  available_countries: [
    { iso_code: 'DE', name: 'Germany', currency: { iso_code: 'EUR', symbol: '€' } },
    { iso_code: 'US', name: 'United States', currency: { iso_code: 'USD', symbol: '$' } },
  ],
};

const scenarios: Record<string, Record<string, unknown>> = {
  product: {
    request: { page_type: 'product', path: '/products/kumiko-box', locale: { iso_code: 'de' } },
    template: { name: 'product' },
    product,
    collection: { title: 'Boxes', url: '/collections/boxes' },
    canonical_url: 'https://shop.example/products/kumiko-box',
    page_title: 'Kumiko Box',
  },
  collection: {
    request: { page_type: 'collection', path: '/collections/boxes', locale: { iso_code: 'en' } },
    template: { name: 'collection' },
    collection: { title: 'Boxes', url: '/collections/boxes', image: img(2), description: 'All boxes', products: [product] },
    canonical_url: 'https://shop.example/collections/boxes',
  },
  article: {
    request: { page_type: 'article', path: '/blogs/news/hello', locale: { iso_code: 'es' } },
    template: { name: 'article' },
    blog: { title: 'News', url: '/blogs/news' },
    article: {
      title: 'Hello',
      url: '/blogs/news/hello',
      image: img(3),
      author: 'Me',
      published_at: '2026-03-01T00:00:00Z',
      excerpt: 'x',
      content: '<p>y</p>',
    },
  },
  notFound: {
    request: { page_type: '404', path: '/nope', locale: { iso_code: 'de' } },
    template: { name: '404' },
  },
  index: {
    request: { page_type: 'index', path: '/', locale: { iso_code: 'de' } },
    template: { name: 'index' },
  },
};

/** `block.settings` from the `{% schema %}` defaults, with every checkbox on. */
function blockSettings(src: string, checkboxes: boolean): Record<string, unknown> {
  const m = src.match(/\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/);
  if (!m) return {};
  const schema = JSON.parse(m[1]);
  const out: Record<string, unknown> = {};
  for (const s of schema.settings ?? []) {
    if (!s.id) continue;
    if (s.type === 'checkbox') out[s.id] = checkboxes ? true : (s.default ?? false);
    else if (s.default !== undefined) out[s.id] = s.default;
    else if (s.type === 'image_picker') out[s.id] = img(9);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parity
// ---------------------------------------------------------------------------

const files = LIQUID_DIRS.flatMap((dir: string) =>
  readdirSync(dir)
    .filter((n) => n.endsWith('.liquid'))
    .sort()
    .map((n) => ({ name: `${basename(dir)}/${n}`, path: join(dir, n) })),
);

/**
 * Files liquidjs cannot render at all. Empty on purpose: add an entry (file ->
 * reason) AND an `it.skip` explanation here rather than letting a file pass
 * without being compared.
 */
const UNRENDERABLE: Record<string, string> = {};

/**
 * The minifier is allowed to change exactly three things in the OUTPUT too:
 * indentation, trailing blanks and runs of blank lines (rules 2-4). Everything
 * else -- every character, every line break, spacing in the middle of a line --
 * must survive. So both renders are reduced by exactly those three rules and
 * nothing more (in particular NOT by folding all whitespace, which would hide a
 * lost separator or a joined line).
 */
const normalizeLayout = (t: string) =>
  t
    .split('\n')
    .map((l) => l.replace(/^[ \t\r]+|[ \t\r]+$/g, ''))
    .filter((l) => l !== '')
    .join('\n');

async function renderBoth(src: string, scope: Record<string, unknown>) {
  const out: Record<Variant, string> = { source: '', minified: '' };
  for (const variant of ['source', 'minified'] as const) {
    const engine = makeEngine(variant);
    const text = variant === 'minified' ? minifyLiquid(src) : src;
    out[variant] = await engine.parseAndRender(forLiquidjs(text), scope);
  }
  return out;
}

describe('liquidjs behaves like Ruby Liquid where the extension depends on it', () => {
  it('split drops trailing empty strings (annotation cut / id guard rely on it)', async () => {
    const e = new Liquid();
    const r = (s: string) => e.parseAndRender(s);
    expect(await r(`{{ 'a,b,,' | split: ',' | json }}`)).toBe('["a","b"]');
    expect(await r(`{{ 'https://youtu.be/' | split: 'youtu.be/' | json }}`)).toBe('["https://"]');
    expect(await r(`{{ ',' | split: ',' | json }}`)).toBe('[]');
    expect(await r(`{{ ',a' | split: ',' | json }}`)).toBe('["","a"]');
  });
});

describe('minified Liquid renders exactly like the commented source', () => {
  it('has files to compare', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const reason = UNRENDERABLE[file.name];
    if (reason) {
      // Skipped explicitly, never silently: the reason is in UNRENDERABLE.
      it.skip(`${file.name} (not renderable in liquidjs: ${reason})`, () => {});
      continue;
    }
    const src = read(file.path);

    for (const [scenarioName, base] of Object.entries(scenarios)) {
      for (const checkboxes of [true, false]) {
        it(`${file.name} — ${scenarioName}, ${checkboxes ? 'all switches on' : 'schema defaults'}`, async () => {
          const scope = {
            ...base,
            shop,
            localization,
            routes: { root_url: '/', search_url: '/search' },
            settings: {},
            block: { id: 'blk1', settings: blockSettings(src, checkboxes), shopify_attributes: '' },
            // Arguments of snippet files (they are rendered stand-alone too).
            url: 'https://youtu.be/dQw4w9WgXcQ?t=1',
            src: 'p/101.jpg',
            width: 1200,
          };
          const { source, minified } = await renderBoth(src, scope);
          expect(normalizeLayout(minified)).toBe(normalizeLayout(source));
        });
      }
    }
  }

  it('actually exercises the renderer (a block renders something non-trivial)', async () => {
    const f = files.find((x) => x.name === 'blocks/variant-gallery-embed.liquid')!;
    const src = read(f.path);
    const { source } = await renderBoth(src, {
      ...scenarios.product,
      shop,
      localization,
      block: { id: 'blk1', settings: blockSettings(src, true) },
    });
    expect(source).toContain('cp-embed-data-blk1');
    expect(source.length).toBeGreaterThan(1000);
  });

  it('would catch a rendering difference (control: a minifier that eats a space)', async () => {
    const src = 'x {%- comment -%}c{%- endcomment -%} y';
    const engine = makeEngine('source');
    const rendered = await engine.parseAndRender(src);
    expect(rendered).toBe('xy');
    expect(await engine.parseAndRender('x  y')).not.toBe(rendered);
  });
});
