/**
 * Utility functions for URL slug generation and validation
 */

/**
 * Sanitizes a string to create a valid URL slug
 * - Converts to lowercase
 * - Replaces German umlauts (ä->ae, ö->oe, ü->ue, ß->ss)
 * - Removes all special characters except hyphens
 * - Replaces spaces and underscores with hyphens
 * - Removes consecutive hyphens
 * - Trims hyphens from start and end
 *
 * IMPORTANT: This is a strict ASCII safe-charset sanitizer, NOT a transliterator.
 * Non-Latin input (CJK / Cyrillic / Arabic / etc.) is stripped by the
 * `[^a-z0-9-]` filter and can collapse to an EMPTY string. A return value of
 * '' (or a hyphen-only string that trims to '') therefore means "unusable
 * handle — the caller MUST NOT persist this to Shopify or the DB". Producing
 * a real ASCII slug from non-Latin source is the upstream translateSlug's job.
 */
export function sanitizeSlug(input: string): string {
  if (!input || typeof input !== 'string') {
    // Unusable: caller must not write this. See doc note above.
    return '';
  }

  let slug = input.toLowerCase().trim();

  // Replace German umlauts and special characters
  const charMap: Record<string, string> = {
    'ä': 'ae',
    'ö': 'oe',
    'ü': 'ue',
    'ß': 'ss',
    'à': 'a',
    'á': 'a',
    'â': 'a',
    'ã': 'a',
    'å': 'a',
    'è': 'e',
    'é': 'e',
    'ê': 'e',
    'ë': 'e',
    'ì': 'i',
    'í': 'i',
    'î': 'i',
    'ï': 'i',
    'ò': 'o',
    'ó': 'o',
    'ô': 'o',
    'õ': 'o',
    'ù': 'u',
    'ú': 'u',
    'û': 'u',
    'ý': 'y',
    'ÿ': 'y',
    'ñ': 'n',
    'ç': 'c',
  };

  // Replace special characters
  slug = slug.replace(/[äöüßàáâãåèéêëìíîïòóôõùúûýÿñç]/g, (char) => charMap[char] || char);

  // Replace spaces, underscores, and other non-alphanumeric characters with hyphens
  slug = slug.replace(/[\s_]+/g, '-');

  // Remove all characters that are not alphanumeric or hyphens
  slug = slug.replace(/[^a-z0-9-]/g, '');

  // Replace multiple consecutive hyphens with a single hyphen
  slug = slug.replace(/-+/g, '-');

  // Remove leading and trailing hyphens
  slug = slug.replace(/^-+|-+$/g, '');

  return slug;
}

/**
 * Validates and sanitizes a slug in one step.
 * Returns the (potentially sanitized) slug and a flag indicating if sanitization was needed.
 */
export function validateAndSanitizeSlug(input: string): { slug: string; wasSanitized: boolean } {
  const sanitized = sanitizeSlug(input);
  const wasSanitized = sanitized !== input;
  return { slug: sanitized, wasSanitized };
}

/**
 * Validates if a string is a valid URL slug
 * Returns true if the slug only contains lowercase letters, numbers, and hyphens
 * and doesn't start or end with a hyphen
 */
export function isValidSlug(slug: string): boolean {
  if (!slug || typeof slug !== 'string') {
    return false;
  }

  // Check if slug matches the pattern: lowercase letters, numbers, hyphens only
  // Cannot start or end with hyphen
  // Cannot have consecutive hyphens
  const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;

  return slugPattern.test(slug);
}
