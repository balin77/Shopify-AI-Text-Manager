/**
 * Shared types for template action handlers.
 */

export interface TranslatableField {
  key: string;
  value?: string;
  digest?: string;
}

export interface ThemeContentRow {
  id: string;
  shop: string;
  resourceId: string;
  /** Shopify translatable resource type, e.g. "ONLINE_STORE_THEME_JSON_TEMPLATE" or "ONLINE_STORE_THEME_LOCALE_CONTENT". */
  resourceType?: string;
  groupId: string;
  groupName: string;
  groupIcon: string;
  translatableContent: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface TemplatesActionContext {
  /** Shopify Admin API client */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any;
  session: { shop: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  formData: FormData;
  /** ThemeContent domain this group belongs to: "theme" | "system" | "online_store_extras" | "selling_plans". */
  domain: string;
  groupId: string;
  themeGroups: ThemeContentRow[];
  firstGroup: ThemeContentRow;
  resourceId: string;
  /** Maps each translatable field key → the Shopify resource ID that owns it */
  keyToResourceId: Map<string, string>;
  /** Maps each translatable field key → the Shopify resource type that owns it */
  keyToResourceType: Map<string, string>;
}
