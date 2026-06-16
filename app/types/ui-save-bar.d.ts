/**
 * JSX typing for the App Bridge `ui-save-bar` web component.
 *
 * The save bar is provided by the CDN App Bridge script loaded in root.tsx
 * (https://cdn.shopify.com/shopifycloud/app-bridge.js). It renders the native
 * Shopify save/discard bar ABOVE the embedded app (outside the iframe) and is
 * required for "Built for Shopify". See app/components/AppSaveBar.tsx.
 *
 * Declared in both the global and the React JSX namespaces so it resolves
 * regardless of the classic vs. automatic JSX runtime.
 */
import "react";

type UiSaveBarElement = {
  id: string;
  children?: React.ReactNode;
};

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "ui-save-bar": UiSaveBarElement;
    }
  }
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "ui-save-bar": UiSaveBarElement;
    }
  }
}

export {};
