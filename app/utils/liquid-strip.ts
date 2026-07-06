/**
 * Shared Liquid/HTML stripping for turning Shopify template content (which is
 * riddled with `{{ }}` / `{% %}` Liquid and, for email bodies, HTML) into plain,
 * readable text. Used for the email-notification nav name fallback
 * (background-sync deriveName) and the AI title-excerpt builder
 * (template-titles handler) so the two stay in lockstep.
 */

/**
 * Remove Liquid tags/outputs and the empty ()/[] they leave behind, then
 * collapse whitespace. "Bestellung {{name}} bestätigt" → "Bestellung bestätigt";
 * "[{{ shop.name }}] Beleg" → "Beleg".
 */
export function stripLiquid(v: string): string {
  return v
    .replace(/\{\{[\s\S]*?\}\}/g, " ")
    .replace(/\{%[\s\S]*?%\}/g, " ")
    .replace(/\(\s*\)/g, " ")
    .replace(/\[\s*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Like stripLiquid, but also strips HTML tags and entities first (for email bodies). */
export function stripLiquidAndHtml(v: string): string {
  return stripLiquid(
    v.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ")
  );
}
