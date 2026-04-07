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
  groupId: string;
  themeGroups: ThemeContentRow[];
  firstGroup: ThemeContentRow;
  resourceId: string;
  /** Maps each translatable field key → the Shopify resource ID that owns it */
  keyToResourceId: Map<string, string>;
}
