import { describe, it, expect } from 'vitest';
import {
  minifyLiquid,
  buildReport,
  scanRegions,
  LIQUID_LIMIT_BYTES,
  LIQUID_TARGET_BYTES,
  LIQUID_DIRS,
  EXTENSION_DIR,
} from '../../scripts/minify-liquid-blocks.mjs';
import { join } from 'node:path';

/**
 * The minifier only exists so `shopify app deploy` fits under Shopify's 100 KiB
 * Liquid budget while `blocks/*.liquid` stays fully commented in git. That makes
 * it safety-critical: anything it rewrites ships to storefronts. These tests pin
 * down the two halves of the contract — it must shrink plain markup, and it must
 * leave every protected region byte-identical.
 */
describe('minifyLiquid — comment removal (rule 1)', () => {
  it('removes a {% comment %} block and keeps the surrounding code', () => {
    const out = minifyLiquid(
      ['<div>', '{% comment %}', '  explain the thing', '{% endcomment %}', '<span>hi</span>', '</div>'].join('\n'),
    );
    expect(out).not.toContain('explain the thing');
    expect(out).not.toContain('comment');
    expect(out).toContain('<div>');
    expect(out).toContain('<span>hi</span>');
    expect(out).toContain('</div>');
  });

  it('removes the whitespace-control {%- comment -%} spelling', () => {
    const out = minifyLiquid('a{%- comment -%}\n  gone\n{%- endcomment -%}b');
    expect(out).toBe('ab');
  });

  it('removes an inline comment without eating its neighbours', () => {
    expect(minifyLiquid('x {%- comment -%} note {%- endcomment -%} y')).toBe('x  y');
  });

  it('is non-greedy — two comments are removed, the code between them survives', () => {
    const out = minifyLiquid('{% comment %}one{% endcomment %}KEEP{% comment %}two{% endcomment %}');
    expect(out).toBe('KEEP');
  });

  it('leaves a capitalised {% COMMENT %} alone (Liquid tag names are lowercase)', () => {
    const src = '{% COMMENT %}literal{% ENDCOMMENT %}';
    expect(minifyLiquid(src)).toBe(src);
  });

  it('throws instead of guessing when a comment is never closed', () => {
    expect(() => minifyLiquid('<div>\n{% comment %}\nno end tag\n')).toThrow(/unterminated/i);
  });
});

describe('minifyLiquid — whitespace rules (2-4) in plain regions', () => {
  it('strips leading indentation', () => {
    expect(minifyLiquid('<div>\n      <span>x</span>\n</div>')).toBe('<div>\n<span>x</span>\n</div>');
  });

  it('strips trailing whitespace', () => {
    expect(minifyLiquid('<div>   \n<span>x</span>\t\t\n')).toBe('<div>\n<span>x</span>\n');
  });

  it('collapses runs of blank lines to a single one', () => {
    expect(minifyLiquid('a\n\n\n\n\nb')).toBe('a\n\nb');
    expect(minifyLiquid('a\n   \n\t\n\nb')).toBe('a\n\nb');
  });

  it('keeps a single blank line as a single blank line', () => {
    expect(minifyLiquid('a\n\nb')).toBe('a\n\nb');
  });

  it('does not touch spacing in the middle of a line', () => {
    expect(minifyLiquid('  <a href="#"   class="x">t   e</a>')).toBe('<a href="#"   class="x">t   e</a>');
  });

  it('preserves CRLF line endings while still applying the rules', () => {
    expect(minifyLiquid('<div>\r\n    <span>x</span>   \r\n\r\n\r\n</div>')).toBe(
      '<div>\r\n<span>x</span>\r\n\r\n</div>',
    );
  });
});

describe('minifyLiquid — protected regions stay byte-identical', () => {
  it('leaves a JSON-LD island with Liquid output and ugly whitespace untouched', () => {
    const island = [
      '<script type="application/ld+json" data-contentpilot="product">',
      '{',
      '        "@context":    "https://schema.org",',
      '  "@type": "Product",',
      '            "name": {{ product.title | json }},',
      '',
      '',
      '',
      '   "url": {{ shop.url | json }}   ',
      '}',
      '</script>',
    ].join('\n');
    const out = minifyLiquid(`<div>\n  ${island}\n</div>\n`);
    expect(out).toContain(island);
    expect(out).toBe(`<div>\n${island}\n</div>\n`);
  });

  it('leaves an application/json island untouched', () => {
    const island =
      '<script type="application/json" id="cp-gallery-data-{{ block.id }}">\n' +
      '  {\n     "a":   {{ variant.id | json }}\n\n\n  }\n' +
      '</script>';
    expect(minifyLiquid(island)).toBe(island);
  });

  it('leaves an inline <script> with JS untouched (ASI hazard)', () => {
    const js = [
      '<script>',
      '  (function () {',
      '    var a = 1',
      '',
      '',
      '    return a   ',
      '  })();',
      '</script>',
    ].join('\n');
    expect(minifyLiquid(`   ${js}`)).toBe(js);
  });

  it('leaves a <style> block untouched', () => {
    const css = '<style>\n  html.x,\n\n\n  html.y { display: none !important; }   \n</style>';
    expect(minifyLiquid(css)).toBe(css);
  });

  it('leaves <pre> and <textarea> untouched (whitespace is significant)', () => {
    const pre = '<pre>\n    line one\n\n\n        line two   \n</pre>';
    const textarea = '<textarea>\n   keep\n\n\n   me   \n</textarea>';
    expect(minifyLiquid(`  ${pre}\n  ${textarea}\n`)).toBe(`${pre}\n${textarea}\n`);
  });

  it('does not strip {% comment %} inside a protected region', () => {
    const island = '<script type="application/json">\n  {% comment %} kept verbatim {% endcomment %}\n</script>';
    expect(minifyLiquid(island)).toBe(island);
  });

  it('handles a <script> tag whose attributes contain Liquid', () => {
    const tag = `<script src="{{ 'variant-gallery.js' | asset_url }}" defer></script>`;
    expect(minifyLiquid(`    ${tag}\n`)).toBe(`${tag}\n`);
  });

  it('matches closing tags case-insensitively', () => {
    const s = '<SCRIPT>\n   var a = 1\n</SCRIPT>';
    expect(minifyLiquid(s)).toBe(s);
  });

  it('leaves a {% raw %} body untouched', () => {
    const raw = '{% raw %}\n    {{ not_liquid }}\n\n\n{% endraw %}';
    expect(minifyLiquid(`  ${raw}`)).toBe(raw);
  });

  it('throws instead of guessing when a protected element is never closed', () => {
    expect(() => minifyLiquid('<div>\n<script>\nvar a = 1\n')).toThrow(/unterminated/i);
  });
});

describe('minifyLiquid — Liquid expressions are never reformatted', () => {
  it('keeps whitespace control and inner spacing of tags and outputs', () => {
    const src = '{%- if x -%}\n  {{ y }}\n{%- endif -%}';
    expect(minifyLiquid(src)).toBe('{%- if x -%}\n{{ y }}\n{%- endif -%}');
  });

  it('keeps the indented interior of a multi-line {% liquid %} tag', () => {
    const tag = ['{%- liquid', '  assign a = 1', '      assign b = 2', '-%}'].join('\n');
    expect(minifyLiquid(`  ${tag}\n`)).toBe(`${tag}\n`);
  });

  it('keeps filter spacing inside an output expression', () => {
    const src = '{{ vfi | image_url: width: 400  | json }}';
    expect(minifyLiquid(`      ${src}`)).toBe(src);
  });

  it('minifies a {% schema %} body (whitespace-insensitive JSON) but not the tags', () => {
    const out = minifyLiquid('{% schema %}\n  {\n    "name": "x"\n  }\n{% endschema %}');
    expect(out).toBe('{% schema %}\n{\n"name": "x"\n}\n{% endschema %}');
    expect(JSON.parse(out.split('\n').slice(1, -1).join('\n'))).toEqual({ name: 'x' });
  });
});

describe('minifyLiquid — idempotence', () => {
  const samples = [
    '<div>\n\n\n   <span>a</span>   \n{% comment %}\n x\n{% endcomment %}\n</div>\n',
    '{%- if a -%}\n   {{ b }}\n{%- endif -%}\n\n\n<script>\n  var x = 1\n</script>\n',
    'a{%- comment -%}c{%- endcomment -%}b',
    '\n\n\n<pre>\n  x\n</pre>\n\n\n',
    '',
  ];

  it.each(samples)('minifyLiquid(minifyLiquid(x)) === minifyLiquid(x) [%#]', (src) => {
    const once = minifyLiquid(src);
    expect(minifyLiquid(once)).toBe(once);
  });

  it('is idempotent on every real block source', () => {
    for (const block of buildReport().blocks) {
      expect(minifyLiquid(block.minified), block.name).toBe(block.minified);
    }
  });
});

describe('the real extension bundle', () => {
  const report = buildReport();

  it('has blocks to minify', () => {
    expect(report.blocks.length).toBeGreaterThan(0);
  });

  it('fits under the Shopify limit with the safety margin intact once minified', () => {
    expect(report.minifiedBytes).toBeLessThan(LIQUID_TARGET_BYTES);
    expect(LIQUID_TARGET_BYTES).toBeLessThan(LIQUID_LIMIT_BYTES);
  });

  it('counts every configured Liquid directory, and NAMES one it could not find', () => {
    // The budget only means something if it covers what actually ships.
    // `listBlockFiles` skips a missing directory so a repo without snippets
    // still works -- but a renamed or moved folder would then drop out of the
    // total silently, and the check would print 'fits' while the deploy fails
    // on the 100 KiB limit. Reporting it is what makes that visible.
    expect(report.missingDirs).toEqual([]);
    expect(report.blocks.some((b) => b.name.startsWith('blocks/'))).toBe(true);
    expect(report.blocks.some((b) => b.name.startsWith('snippets/'))).toBe(true);

    const withGhost = buildReport([...LIQUID_DIRS, join(EXTENSION_DIR, 'does-not-exist')]);
    expect(withGhost.missingDirs).toHaveLength(1);
    expect(withGhost.minifiedBytes).toBe(report.minifiedBytes);
  });

  it('keeps every protected region of every block byte-identical', () => {
    for (const block of report.blocks) {
      const before = scanRegions(block.original).filter((s) => s.kind === 'protected').map((s) => s.text);
      const after = scanRegions(block.minified).filter((s) => s.kind === 'protected').map((s) => s.text);
      expect(after, block.name).toEqual(before);
    }
  });

  it('changes nothing but whitespace outside the protected regions', () => {
    const plainText = (src: string) =>
      scanRegions(src)
        .filter((s) => s.kind === 'plain')
        .map((s) => s.text)
        .join('')
        .replace(/\s+/g, ' ')
        .trim();

    for (const block of report.blocks) {
      expect(plainText(block.minified), block.name).toBe(plainText(block.original));
    }
  });

  it('leaves no Liquid comments in the minified output', () => {
    for (const block of report.blocks) {
      expect(
        scanRegions(block.minified).some((s) => s.kind === 'comment'),
        block.name,
      ).toBe(false);
    }
  });
});
