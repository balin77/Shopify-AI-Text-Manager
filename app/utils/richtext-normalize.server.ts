/**
 * Normalize HTML to satisfy Shopify's richtext theme-setting rule:
 *   "All top level nodes must be '<p>', '<ul>', '<ol>' or '<h1>'-'<h6>' tags"
 *
 * The theme-content editor is a contentEditable div ([AIEditableHTMLField]) that
 * saves its raw innerHTML. Browsers routinely emit top-level bare text, <br> and
 * <div> nodes while typing — all rejected by Shopify's richtext settings (e.g.
 * Brand information → brand_description). Product body_html has no such rule, so
 * this only matters for the theme-settings save path in templates-update.action.ts.
 *
 * Strategy: wrap runs of top-level inline/text content in <p>, pass allowed block
 * tags through unchanged, and unwrap <div> (treating it as a line/block boundary)
 * so contentEditable's per-line <div> wrappers become individual <p> paragraphs.
 *
 * Uses isomorphic-dompurify (a prod dependency; jsdom is dev-only) to get a DOM to
 * traverse on both server and client.
 */

import DOMPurify from "isomorphic-dompurify";

// The only tags Shopify accepts as TOP-LEVEL nodes of a richtext setting value.
const ALLOWED_TOP = new Set(["P", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6"]);

// Keep the sanitizer's tag set aligned with the display sanitizer (utils/sanitizer.ts)
// so normalization never strips markup the editor legitimately produced.
const ALLOWED_TAGS = [
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "br", "strong", "em", "b", "i", "u", "s",
  "ul", "ol", "li",
  "blockquote", "pre", "code",
  "a", "span", "div", "img",
];
const ALLOWED_ATTR = [
  "href", "target", "rel", "class", "style",
  "src", "alt", "title", "width", "height",
];

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
const MAX_DEPTH = 20;

/** Cheap check: does the value contain any HTML tag at all? */
export function hasHtmlTags(value: string): boolean {
  return /<[a-z][\s\S]*?>/i.test(value || "");
}

/** True for Shopify's "all top level nodes must be …" richtext rejection. */
export function isRichtextTopLevelError(message: string): boolean {
  return /top level nodes must be/i.test(message || "");
}

/**
 * Rewrite `html` so every top-level node is a block tag Shopify accepts.
 * Returns the input unchanged when it has no HTML tags (plain-text settings must
 * never be wrapped — that would corrupt a non-richtext value).
 */
export function normalizeShopifyRichtext(html: string): string {
  if (!html || !hasHtmlTags(html)) return html;

  const body = DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    RETURN_DOM: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as unknown as HTMLElement;

  const doc = body.ownerDocument;
  const out = doc.createElement("div");
  let buffer: Node[] = [];

  const bufferHasMeaning = () =>
    buffer.some(
      (n) =>
        (n.nodeType === TEXT_NODE && (n.textContent || "").trim() !== "") ||
        (n.nodeType === ELEMENT_NODE && (n as Element).tagName !== "BR"),
    );

  const flush = () => {
    if (buffer.length && bufferHasMeaning()) {
      const p = doc.createElement("p");
      for (const n of buffer) p.appendChild(n); // moves the node
      out.appendChild(p);
    }
    buffer = [];
  };

  const process = (nodes: Node[], depth: number) => {
    for (const node of nodes) {
      if (node.nodeType === ELEMENT_NODE) {
        const el = node as Element;
        const tag = el.tagName;
        if (ALLOWED_TOP.has(tag)) {
          flush();
          out.appendChild(el);
          continue;
        }
        if (tag === "DIV" && depth < MAX_DEPTH) {
          // contentEditable wraps each line in a <div>; treat it as a block
          // boundary and normalize its children as if they were top-level.
          flush();
          process(Array.from(el.childNodes), depth + 1);
          continue;
        }
        // inline element (a, span, strong, br, img, …) — accumulate into a <p>.
        buffer.push(node);
      } else {
        buffer.push(node);
      }
    }
  };

  process(Array.from(body.childNodes), 0);
  flush();

  return out.innerHTML;
}
