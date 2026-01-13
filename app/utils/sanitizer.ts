/**
 * HTML Sanitization Utility
 *
 * Provides secure HTML sanitization to prevent XSS attacks.
 * Uses DOMPurify to clean user-generated HTML content.
 */

import * as DOMPurify from 'isomorphic-dompurify';

/**
 * Sanitize HTML content for product descriptions and other rich text fields
 *
 * Allows only safe HTML tags that are commonly used in e-commerce:
 * - Headings: h1, h2, h3, h4, h5, h6
 * - Text formatting: p, strong, em, b, i, u, br
 * - Lists: ul, ol, li
 * - Links: a (with href attribute)
 * - Other: span, div
 */
export function sanitizeHTML(html: string): string {
  if (!html) return '';

  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'p', 'br', 'strong', 'em', 'b', 'i', 'u',
      'ul', 'ol', 'li',
      'a', 'span', 'div'
    ],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'class'],
    ALLOW_DATA_ATTR: false,
    // Force target="_blank" for external links to have rel="noopener noreferrer"
    SAFE_FOR_TEMPLATES: true,
  });
}

/**
 * Sanitize HTML content for AI instruction format examples
 * More restrictive than general HTML sanitization
 */
export function sanitizeFormatExample(html: string): string {
  if (!html) return '';

  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'h1', 'h2', 'h3',
      'p', 'br', 'strong', 'em',
      'ul', 'ol', 'li'
    ],
    ALLOWED_ATTR: [],
    ALLOW_DATA_ATTR: false,
  });
}

/**
 * Strip all HTML tags and return plain text
 * Useful for title fields and meta descriptions
 */
export function stripHTML(html: string): string {
  if (!html) return '';

  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [],
    ALLOWED_ATTR: [],
  });
}

/**
 * Escape HTML entities to prevent XSS in plain text contexts
 */
export function escapeHTML(text: string): string {
  if (!text) return '';

  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
