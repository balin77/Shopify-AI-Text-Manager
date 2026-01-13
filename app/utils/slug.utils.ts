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
 */
export function sanitizeSlug(input: string): string {
  if (!input || typeof input !== 'string') {
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

/**
 * Validates and sanitizes a slug
 * If the slug is invalid, it sanitizes it
 * Returns the sanitized slug and a boolean indicating if sanitization was needed
 */
export function validateAndSanitizeSlug(slug: string): { slug: string; wasSanitized: boolean } {
  if (isValidSlug(slug)) {
    return { slug, wasSanitized: false };
  }

  const sanitized = sanitizeSlug(slug);
  return { slug: sanitized, wasSanitized: true };
}
