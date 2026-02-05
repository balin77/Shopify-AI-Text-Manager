import { RemixBrowser } from "@remix-run/react";
import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";

// Filter out known third-party library warnings
if (typeof window !== 'undefined') {
  const originalWarn = console.warn;
  console.warn = (...args: any[]) => {
    const message = args[0]?.toString() || '';

    // Suppress known third-party warnings from Shopify libraries
    if (
      message.includes('deprecated parameters for the initialization') ||
      message.includes('preloaded using link preload but not used') ||
      message.includes('CriticalApps') // Shopify Admin preload loop
    ) {
      return;
    }

    originalWarn.apply(console, args);
  };

  // Also filter console.error for preload warnings
  const originalError = console.error;
  console.error = (...args: any[]) => {
    const message = args[0]?.toString() || '';

    if (message.includes('preloaded using link preload but not used')) {
      return;
    }

    originalError.apply(console, args);
  };

  // Filter preload warnings in addEventListener
  const originalAddEventListener = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function(type: string, listener: any, options?: any) {
    // Make wheel/touchstart/touchmove listeners passive by default
    if (['wheel', 'touchstart', 'touchmove'].includes(type)) {
      if (typeof options === 'object' && options !== null) {
        options = { ...options, passive: options.passive !== false };
      } else if (typeof options === 'boolean') {
        options = { capture: options, passive: true };
      } else {
        options = { passive: true };
      }
    }
    return originalAddEventListener.call(this, type, listener, options);
  };
}

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <RemixBrowser />
    </StrictMode>
  );
});
