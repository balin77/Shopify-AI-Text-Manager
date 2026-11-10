/**
 * Styles of the standalone /admin page. /admin is not embedded in Shopify, so
 * the Polaris stylesheet and the width tokens of responsive.css do not apply
 * there; every colour and every width of the page lives here, once.
 */

import type { CSSProperties } from 'react';
import type { ShopStatusColor } from '~/services/admin/shop-status.shared';

export const TD: CSSProperties = {
  padding: '8px 10px',
  borderBottom: '1px solid #e1e3e5',
  fontSize: 13,
  whiteSpace: 'nowrap',
  verticalAlign: 'top',
};

export const TH: CSSProperties = {
  ...TD,
  textAlign: 'left',
  background: '#f6f6f7',
  fontWeight: 600,
  position: 'sticky',
  top: 0,
  verticalAlign: 'bottom',
};

/** The overview table spends the full window width (data grid, no reading-width cap). */
export const PAGE_WIDTH = 'none';
export const LOGIN_WIDTH = 380;

export const PAGE: CSSProperties = {
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  padding: 24,
  maxWidth: PAGE_WIDTH,
  margin: '0 auto',
  color: '#202223',
};

export const BUTTON: CSSProperties = {
  padding: '5px 10px',
  border: '1px solid #babfc3',
  background: 'white',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 12,
};

export const MUTED = '#5c5f62';
export const DANGER = '#bf0711';

export const STATUS_DOT: Record<ShopStatusColor, string> = {
  red: '#d82c0d',
  yellow: '#e5a500',
  green: '#008060',
  grey: '#8c9196',
};

export const STATUS_TINT: Record<ShopStatusColor, string> = {
  red: '#fbeae5',
  yellow: '#fff5ea',
  green: '#e3f1df',
  grey: '#f1f2f3',
};
