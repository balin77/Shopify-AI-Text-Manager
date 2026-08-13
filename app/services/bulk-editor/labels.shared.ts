/**
 * Bulk editor — column heading resolution (client-safe).
 *
 * Extracted from app.bulk.tsx so the grid and the "translate missing" page
 * label the same column identically. Shop-defined names (metafields, metaobject
 * fields) are rendered VERBATIM and never translated (Plan §10.4).
 */

import type { ColumnDescriptor } from "./columns.shared";

/** The `t.bulkEditor` subset a heading needs. */
export interface BulkColumnLabelStrings {
  columns: Record<string, string>;
}

export function bulkColumnHeading(
  column: ColumnDescriptor,
  strings: BulkColumnLabelStrings,
  currencyCode = "",
): string {
  if (column.kind === "metafield" || column.kind === "mofield") return column.label;
  if (column.kind === "option") {
    const template = column.optionField === "name" ? strings.columns.optionName : strings.columns.optionValues;
    return (template ?? column.label).replace("{position}", String(column.optionPosition ?? 0));
  }
  if (column.id === "img.alt") return strings.columns.imgAlt ?? column.label;
  const heading = strings.columns[column.label] ?? column.label;
  // Money columns carry the shop currency as a suffix (Plan §5.2) — the
  // currency is shop-wide, never per cell.
  if (column.inputType === "money" && currencyCode) return `${heading} (${currencyCode})`;
  return heading;
}
