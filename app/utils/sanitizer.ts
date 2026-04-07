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

export function sanitizeHTML(html: string): string {
  if (!html) return '';

  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'p', 'br', 'strong', 'em', 'b', 'i', 'u', 's',
      'ul', 'ol', 'li',
      'blockquote', 'pre', 'code',
      'a', 'span', 'div'
    ],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'class'],
    ALLOW_DATA_ATTR: false,
  });
}
