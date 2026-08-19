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

/**
 * The `optionValueOrder` form field, parsed.
 *
 * ALL OR NOTHING per option, and that is the whole point of this function
 * existing. The payload is POSITIONAL: dropping one malformed id out of five
 * does not sanitise the request, it applies a DIFFERENT order than the merchant
 * dragged — quietly, and to real variants. An option whose list contains
 * anything unusable is therefore skipped entirely, the same rule the attribute
 * mappers follow when a response arrives half-delivered.
 *
 * Shape: `{ "<option gid>": ["<value gid>", …] }`. Anything else yields `{}`;
 * a malformed payload must not fail the whole save, whose other halves are
 * still valid.
 */
export function parseValueOrderPayload(
  raw: string,
  isValidGid: (id: string) => boolean,
): Record<string, string[]> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string[]> = {};
    for (const [optionId, ids] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isValidGid(optionId) || !Array.isArray(ids)) continue;
      const valid = ids.filter((id): id is string => typeof id === "string" && isValidGid(id));
      if (valid.length > 0 && valid.length === ids.length) out[optionId] = valid;
    }
    return out;
  } catch {
    return {};
  }
}
