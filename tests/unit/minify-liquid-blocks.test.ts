import { describe, it, expect } from 'vitest';
import {
  minifyLiquid,
  minifyLiquidTag,
  minifyJsonIslandBody,
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

  it("removes an inline comment exactly as Liquid's whitespace control would", () => {
    // Liquid renders this as `xy`: both dashes trim the spaces next to them.
    expect(minifyLiquid('x {%- comment -%} note {%- endcomment -%} y')).toBe('xy');
  });

  it('trims only the side that carries a dash', () => {
    expect(minifyLiquid('x {%- comment %} n {% endcomment %} y')).toBe('x y');
    expect(minifyLiquid('x {% comment -%} n {%- endcomment -%} y')).toBe('x y');
    expect(minifyLiquid('x {% comment %} n {% endcomment -%} y')).toBe('x y');
  });

  it('trims nothing without dashes (whitespace is only normalised)', () => {
    expect(minifyLiquid('a \n {% comment %}c{% endcomment %} \n b')).toBe('a\n\nb');
    expect(minifyLiquid('x {% comment %}c{% endcomment %} y')).toBe('x  y');
  });

  it('removes the whitespace around a comment inside a quoted string', () => {
    expect(minifyLiquid('"a {%- comment -%}x{%- endcomment -%} b"')).toBe('"ab"');
  });

  it('handles two consecutive dashed comments', () => {
    expect(minifyLiquid('a  {%- comment -%}1{%- endcomment -%}{%- comment -%}2{%- endcomment -%}  b')).toBe('ab');
  });

  it('trims across newlines, and only ASCII whitespace (NBSP survives)', () => {
    expect(minifyLiquid('a\n\n  {%- comment -%}c{%- endcomment -%}\n\n  b')).toBe('ab');
    expect(minifyLiquid('a\u00a0{%- comment -%}c{%- endcomment -%}\u00a0b')).toBe('a\u00a0\u00a0b');
  });

  it('never trims into a protected region or a Liquid tag next to the comment', () => {
    expect(minifyLiquid('<script>x </script>{%- comment -%}c{%- endcomment -%} <b>')).toBe('<script>x </script><b>');
    expect(minifyLiquid('{{ a -}} {%- comment -%}c{%- endcomment -%}{{ b }}')).toBe('{{ a -}}{{ b }}');
    expect(minifyLiquid('{{ a }}{% comment %}c{%- endcomment -%} {{ b }}')).toBe('{{ a }}{{ b }}');
  });

  it('keeps the line state right after trimming back to an earlier line', () => {
    expect(minifyLiquid('  a\n   {%- comment -%}c{% endcomment %}\n   b')).toBe('a\nb');
  });

  describe('whitespace-only text before a `{%- comment` (bug_compatible_whitespace_trimming)', () => {
    // Ruby Liquid's bug-compatible mode restores the FIRST byte of a text
    // token that rstrip emptied, so `{{ 'A' }}\n  {%- comment -%}…` renders
    // `AB` normally but `A\nB` there. We cannot tell which mode a storefront
    // uses, so the comment is kept as an inline comment with the same dashes
    // and Shopify's own engine does the trimming.
    const repro = "{{ 'A' }}\n  {%- comment -%}x{%- endcomment -%}\n{{ 'B' }}";

    it('keeps an inline comment with the original dash sides in the ambiguous case', () => {
      expect(minifyLiquid(repro)).toBe("{{ 'A' }}\n{%-#-%}{{ 'B' }}");
      expect(minifyLiquid("{{ 'A' }}\n  {%- comment %}x{% endcomment %}\n{{ 'B' }}")).toBe(
        "{{ 'A' }}\n{%-#%}\n{{ 'B' }}",
      );
    });

    it('also applies at the start of the file and after {% raw %}', () => {
      expect(minifyLiquid("\n  {%- comment -%}x{%- endcomment -%}\n{{ 'B' }}")).toBe("\n{%-#-%}{{ 'B' }}");
      expect(minifyLiquid('{% raw %}r{% endraw %}\n {%- comment %}x{% endcomment %}')).toBe(
        '{% raw %}r{% endraw %}\n{%-#%}',
      );
    });

    it('keeps the first byte as written, so the bug-compatible render is the source render', () => {
      expect(minifyLiquid("{{ 'A' }} \n {%- comment -%}x{%- endcomment -%}{{ 'B' }}")).toBe("{{ 'A' }} {%-#-%}{{ 'B' }}");
    });

    it('is idempotent, including the inline comment form and a leading-space first byte', () => {
      for (const src of [repro, " {%- comment -%}x{%- endcomment -%}{{ 'B' }}", "{{ 'A' }}  {%- comment %}x{% endcomment %}"]) {
        const once = minifyLiquid(src);
        expect(minifyLiquid(once)).toBe(once);
      }
    });

    it('does not apply when the preceding tag already trimmed, or text is not whitespace-only', () => {
      expect(minifyLiquid("{{ 'A' -}}\n  {%- comment -%}x{%- endcomment -%}\n{{ 'B' }}")).toBe("{{ 'A' -}}{{ 'B' }}");
      expect(minifyLiquid("{{ 'A' }}x\n  {%- comment -%}x{%- endcomment -%}\n{{ 'B' }}")).toBe("{{ 'A' }}x{{ 'B' }}");
      expect(minifyLiquid("<script>x</script> {%- comment -%}x{%- endcomment -%}{{ 'B' }}")).toBe(
        "<script>x</script>{{ 'B' }}",
      );
      expect(minifyLiquid("{{ 'A' }}\n  {% comment -%}x{%- endcomment -%}\n{{ 'B' }}")).toBe("{{ 'A' }}\n{{ 'B' }}");
    });
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

  it('does not strip {% comment %} inside a JS or ld+json script', () => {
    for (const type of ['', ' type="text/javascript"', ' type="application/ld+json"', ' type="module"']) {
      const el = `<script${type}>\n  {% comment %} kept verbatim {% endcomment %}\n</script>`;
      expect(minifyLiquid(el)).toBe(el);
    }
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

  it('strips indentation inside a multi-line {% liquid %} tag but keeps every statement line', () => {
    const tag = ['{%- liquid', '  assign a = 1', '      assign b = 2', '-%}'].join('\n');
    expect(minifyLiquid(`  ${tag}\n`)).toBe('{%- liquid\nassign a = 1\nassign b = 2\n-%}\n');
  });

  it('drops blank and whole-line # lines in {% liquid %}, never a # after code or in a string', () => {
    const tag = [
      '{%- liquid',
      '  # a note',
      '',
      "  assign x = '#'",
      '  assign y = 1 # trailing',
      '\t# tab note',
      '  assign z = 2',
      '-%}',
    ].join('\n');
    expect(minifyLiquidTag(tag)).toBe(
      ['{%- liquid', "assign x = '#'", 'assign y = 1 # trailing', 'assign z = 2', '-%}'].join('\n'),
    );
  });

  it('keeps capture / echo / endcapture in order inside {% liquid %}', () => {
    const tag = ['{% liquid', '  capture c', '    echo a', '', '    echo b', '  endcapture', '%}'].join('\n');
    expect(minifyLiquidTag(tag)).toBe('{% liquid\ncapture c\necho a\necho b\nendcapture\n%}');
  });

  it('keeps the last line (closing delimiter) even when it starts with #', () => {
    expect(minifyLiquidTag('{% liquid\n  assign a = 1\n  # x %}')).toBe('{% liquid\nassign a = 1\n# x %}');
  });

  it('leaves a one-line {% liquid %} byte-identical', () => {
    const tag = '{% liquid   assign a = 1   %}';
    expect(minifyLiquidTag(tag)).toBe(tag);
    expect(minifyLiquid(`x ${tag} y`)).toBe(`x ${tag} y`);
  });

  it('removes \\r inside {% liquid %} and is idempotent', () => {
    const tag = '{%- liquid\r\n  assign a = 1\r\n\r\n  # c\r\n  assign b = 2\r\n-%}';
    const once = minifyLiquidTag(tag);
    expect(once).toBe('{%- liquid\nassign a = 1\nassign b = 2\n-%}');
    expect(minifyLiquidTag(once)).toBe(once);
  });

  it('does not treat other tags as {% liquid %}', () => {
    const tag = '{% if a %}\n    # x\n\n    y\n{% endif %}';
    expect(minifyLiquid(tag)).toBe('{% if a %}\n# x\n\ny\n{% endif %}');
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
    'x  {%- comment -%} c {%- endcomment -%}  \n\n  y',
    '{%- liquid\n  # n\n  assign a = 1\n\n    assign b = 2\n-%}\n',
    '<div>\r\n  {%- comment -%}c{%- endcomment -%}\r\n  {% liquid\r\n   assign a = 1\r\n  %}\r\n</div>\r\n',
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

  it('keeps every protected region byte-identical, except {% liquid %} tags which go through minifyLiquidTag', () => {
    const isLiquidTag = (t: string) => /^\{%-?\s*liquid\b/.test(t);
    for (const block of report.blocks) {
      const before = scanRegions(block.original)
        .filter((s) => s.kind === 'protected')
        .map((s) => (isLiquidTag(s.text) ? minifyLiquidTag(s.text) : s.text));
      const after = scanRegions(block.minified).filter((s) => s.kind === 'protected').map((s) => s.text);
      expect(after, block.name).toEqual(before);
    }
  });

  it('changes nothing but whitespace outside the protected regions', () => {
    // Whitespace may only vanish where Liquid's own dash trimming would remove
    // it, i.e. next to a removed `{%-` / `-%}` comment. The expectation is built
    // by replaying exactly that on the ORIGINAL segments. Every non-plain
    // segment becomes a NUL sentinel on both sides (a plain segment that
    // vanished keeps an empty placeholder), so whitespace lost on ONE side of a
    // protected region (`x {{ a }} y` -> `x{{ a }} y`) cannot hide in a join.
    // Runs of whitespace are folded to one space, NOT deleted.
    const fold = (t: string) => t.replace(/\s+/g, ' ');
    const trimmed = (seg: { text: string }) => seg.text.replace(/^[ \t\n\r\f\v]+/, '');
    for (const block of report.blocks) {
      const segs = scanRegions(block.original);
      const expected: string[] = [];
      segs.forEach((seg, i) => {
        if (seg.kind === 'comment') return;
        if (seg.kind !== 'plain') {
          expected.push('\u0000');
          return;
        }
        let t = seg.text;
        const prev = segs[i - 1];
        const next = segs[i + 1];
        if (prev?.kind === 'comment' && prev.text.endsWith('-%}')) t = trimmed({ text: t });
        if (next?.kind === 'comment' && next.text.startsWith('{%-')) t = t.replace(/[ \t\n\r\f\v]+$/, '');
        expected.push(t);
      });
      // Removed comments contribute nothing, so the plain segments around one
      // simply concatenate on both sides.
      const actual = scanRegions(block.minified).map((s) => (s.kind === 'plain' ? s.text : '\u0000'));
      expect(fold(actual.join('')), block.name).toBe(fold(expected.join('')));
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

  it('leaves no line starting with # inside any minified {% liquid %} tag', () => {
    for (const block of report.blocks) {
      for (const seg of scanRegions(block.minified)) {
        if (seg.kind !== 'protected' || !/^\{%-?\s*liquid\b/.test(seg.text)) continue;
        const inner = seg.text.split('\n').slice(1, -1);
        expect(
          inner.filter((l) => l.trim() === '' || l.trim().startsWith('#')),
          block.name,
        ).toEqual([]);
      }
    }
  });
});

describe('minifyLiquid — <script type="application/json"> islands', () => {
  const wrap = (body: string, attrs = 'type="application/json" id="cp-x-{{ block.id }}"') =>
    `<script ${attrs}>${body}</script>`;

  it('strips indentation and blank lines but never joins lines', () => {
    const el = wrap('\n  {\n     "a":   {{ v | json }},\n\n\n      "b": 1   \n  }\n');
    expect(minifyLiquid(el)).toBe(wrap('\n{\n"a":   {{ v | json }},\n"b": 1\n}\n'));
  });

  it('removes comment blocks inside the island', () => {
    const el = wrap('\n  {\n    {% comment %}\n      explain\n    {% endcomment %}\n    "a": 1\n  }\n');
    const out = minifyLiquid(el);
    expect(out).not.toContain('explain');
    expect(out).toBe(wrap('\n{\n"a": 1\n}\n'));
  });

  it('replays the dash trims of a removed comment like Liquid', () => {
    // `{%-` eats the whitespace before, `-%}` the whitespace after, newlines included.
    expect(minifyJsonIslandBody('"a": 1,  {%- comment -%} x {%- endcomment -%}\n   "b": 2')).toBe('"a": 1,"b": 2');
    // no dash: nothing trimmed (indentation still goes, as everywhere)
    expect(minifyJsonIslandBody('"a": 1\n  {% comment %}x{% endcomment %}\n  "b": 2')).toBe('"a": 1\n"b": 2');
  });

  it('keeps a bug-compatible-ambiguous comment as an inline comment', () => {
    const out = minifyJsonIslandBody('{% if a %}\n   {%- comment -%}x{%- endcomment -%}\n"a"{%- endif -%}');
    expect(out).toContain('{%-#-%}');
    expect(out).not.toContain('x{%-');
  });

  it('minifies a multi-line {% liquid %} tag inside the island', () => {
    const el = wrap('\n  {% liquid\n    # a note\n    assign a = 1\n\n    if a\n      echo a\n    endif\n  %}\n  "x": 1\n');
    expect(minifyLiquid(el)).toBe(wrap('\n{% liquid\nassign a = 1\nif a\necho a\nendif\n%}\n"x": 1\n'));
  });

  it('never touches bytes inside a multi-line Liquid tag or output (string with a newline)', () => {
    const output = '{{ "line one\n      line   two\n\n\n   three" | json }}';
    const tag = '{% assign t = "x\n    y" %}';
    const el = wrap(`\n  ${tag}\n  "a": ${output}\n`);
    const out = minifyLiquid(el);
    expect(out).toContain(output);
    expect(out).toContain(tag);
    expect(out).toBe(wrap(`\n${tag}\n"a": ${output}\n`));
  });

  it('keeps whitespace in the middle of a line (it may sit between two outputs inside a string)', () => {
    const body = '\n"alt": "{{ a }}   {{ b }}",\n';
    expect(minifyJsonIslandBody(body)).toBe(body);
  });

  it('keeps {% raw %} bodies verbatim inside the island', () => {
    const body = '\n  {% raw %}\n    {{ x }}\n\n\n  {% endraw %}\n  "a": 1\n';
    expect(minifyJsonIslandBody(body)).toBe('\n{% raw %}\n    {{ x }}\n\n\n  {% endraw %}\n"a": 1\n');
  });

  it('is idempotent', () => {
    const el = wrap(
      '\n  {\n    {%- for v in vs -%}\n      {% comment %}c{% endcomment %}\n      {%- liquid\n        assign a = 1\n\n        # n\n      -%}\n      "{{ v.id }}": [\n\n   1\n  ]{% unless forloop.last %},{% endunless %}\n    {%- endfor -%}\n  }\n',
    );
    const once = minifyLiquid(el);
    expect(minifyLiquid(once)).toBe(once);
  });

  it('accepts attribute order, quoting and spacing variants of the type', () => {
    for (const attrs of [
      'id="a" type="application/json"',
      "type='application/json'",
      'type = "application/json" data-x="{{ y }}"',
      'type=application/json',
      'id="{{ block.id }}" data-type="x" type="application/json"',
    ]) {
      expect(minifyLiquid(`<script ${attrs}>\n  {\n  }\n</script>`), attrs).toBe(`<script ${attrs}>\n{\n}\n</script>`);
    }
  });

  it('reaches only the exact type: ld+json, JS, other types and typeless scripts stay byte-identical', () => {
    const body = '\n  {% comment %}c{% endcomment %}\n     {\n\n\n  "a": 1 }\n';
    for (const attrs of [
      'type="application/ld+json"',
      'type="application/JSON"',
      'type="application/json "',
      'type="application/jsonx"',
      'type="text/template"',
      'type="module"',
      'src="{{ x | asset_url }}" type="application/json"',
      'data-type="application/json"',
      'type="application/json" type="text/javascript"',
      '',
    ]) {
      const el = `<script ${attrs}>${body}</script>`;
      expect(minifyLiquid(el), attrs).toBe(el);
    }
  });

  it('refuses an open tag built by a Liquid tag', () => {
    const el = '<script {% if a %}type="application/json"{% endif %}>\n   {\n\n  }\n</script>';
    expect(minifyLiquid(el)).toBe(el);
  });

  it('keeps an island verbatim when its body cannot be parsed safely', () => {
    const el = '<script type="application/json">\n   {\n  {% if a\n  }\n</script>';
    expect(minifyLiquid(el)).toBe(el);
    expect(minifyJsonIslandBody('  {{ unterminated\n  x')).toBe('  {{ unterminated\n  x');
  });

  it('leaves the surrounding page minifiable and unaffected', () => {
    const out = minifyLiquid('  <div>\n    <script type="application/json">\n      {}\n    </script>\n\n\n\n    <p>x</p>\n  </div>\n');
    expect(out).toBe('<div>\n<script type="application/json">\n{}\n</script>\n\n<p>x</p>\n</div>\n');
  });

  it('does not take a <style> or <pre> inside the island body for HTML', () => {
    const body = '\n   "a": "<style>",\n   "b": "<pre>"\n';
    expect(minifyJsonIslandBody(body)).toBe('\n"a": "<style>",\n"b": "<pre>"\n');
  });
});
