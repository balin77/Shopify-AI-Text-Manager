export function normalizeGroupedValue(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export const GROUPED_FIELD_KEYS = ["productType"] as const;
export type GroupedFieldKey = (typeof GROUPED_FIELD_KEYS)[number];

export function isGroupedFieldKey(key: string): key is GroupedFieldKey {
  return (GROUPED_FIELD_KEYS as readonly string[]).includes(key);
}
