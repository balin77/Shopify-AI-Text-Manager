/**
 * Global type declarations for the Shopify app
 */

// Shopify App Bridge global interface
interface Window {
  shopify?: {
    navigate: (path: string) => void;
    idToken?: string;
    [key: string]: any;
  };
}
