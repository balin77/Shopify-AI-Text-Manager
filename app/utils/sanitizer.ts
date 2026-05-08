/**
 * HTML Sanitization Utility
 *
 * Provides secure HTML sanitization to prevent XSS attacks.
 * Uses DOMPurify to clean user-generated HTML content.
 */

import DOMPurify from 'isomorphic-dompurify';

/**
 * Sanitize HTML content for product descriptions and other rich text fields
 *
 * Allows only safe HTML tags that are commonly used in e-commerce:
 * - Headings: h1, h2, h3, h4, h5, h6
 * - Text formatting: p, strong, em, b, i, u, s, br
 * - Lists: ul, ol, li
 * - Block formatting: blockquote, pre, code
 * - Links: a (with href attribute)
 * - Other: span, div
 */
// Enforce rel="noopener noreferrer" on any <a target="..."> to prevent tab-napping
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('target')) {
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

/** Sanitize HTML for format examples — allows a broader set of tags including headings */
export function sanitizeFormatExample(html: string): string {
  if (!html) return '';
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'p', 'br', 'strong', 'em', 'b', 'i', 'u', 's',
      'ul', 'ol', 'li',
      'blockquote', 'pre', 'code',
      'a', 'span', 'div', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
    ],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'class'],
    ALLOW_DATA_ATTR: false,
  });
}

/** Strip all HTML tags, returning plain text */
export function stripHTML(html: string): string {
  if (!html) return '';
  return DOMPurify.sanitize(html, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] });
}

/** Escape HTML special characters to prevent XSS in plain-text contexts */
export function escapeHTML(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function sanitizeHTML(html: string): string {
  if (!html) return '';

  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'p', 'br', 'strong', 'em', 'b', 'i', 'u', 's',
      'ul', 'ol', 'li',
      'blockquote', 'pre', 'code',
      'a', 'span', 'div',
      'img'
    ],
    ALLOWED_ATTR: [
      'href', 'target', 'rel', 'class',
      'src', 'alt', 'title', 'width', 'height', 'loading', 'srcset', 'sizes'
    ],
    ALLOW_DATA_ATTR: false,
  });
}
