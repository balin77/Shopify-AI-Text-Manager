/**
 * Did Shopify CONFIRM a `fileUpdate` alt write? `userErrors: []` alone is not
 * enough (a null payload carries none either): the echoed `files[]` entry for
 * the id must be there, and its alt must be what was sent (compared trimmed, a
 * missing echoed alt reading as "").
 */
export function fileUpdateEchoConfirms(
  files: ReadonlyArray<{ id?: string | null; alt?: string | null }> | null | undefined,
  id: string,
  sentAlt: string,
): boolean {
  const echoed = (files ?? []).find((f) => f?.id === id);
  if (!echoed) return false;
  return (echoed.alt ?? "").trim() === sentAlt.trim();
}
