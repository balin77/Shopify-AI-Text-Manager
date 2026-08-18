/**
 * The one thing the option write path and the editor's UI must agree on.
 *
 * Client-safe on purpose: `product-options.server.ts` imports Prisma and the
 * server logger, so a component that needs this key cannot import from there.
 */

/**
 * Key for "how many variants use this option value".
 *
 * The separator is a newline rather than a slash or a space: option and value
 * names are merchant text and both can contain either, which would let two
 * different pairs collide on one key and name the wrong number in a delete
 * confirmation.
 */
export function variantCountKey(optionName: string, valueName: string): string {
  return `${optionName}\n${valueName}`;
}
