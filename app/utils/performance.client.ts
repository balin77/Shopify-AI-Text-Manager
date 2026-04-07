/**
 * Client-side Performance Monitoring Utility
 *
 * Automatically measures and logs page load performance in the browser console.
 * Uses the Web Performance API (performance.mark, performance.measure).
 *
 * Logs are only displayed when APP_ENV=development (NODE_ENV is always 'production').
 *
 * Shopify "Built for Shopify" Performance Standards (75th percentile):
 * - Largest Contentful Paint (LCP): ≤ 2500ms
 * - Cumulative Layout Shift (CLS): ≤ 0.1
 * - Interaction to Next Paint (INP): ≤ 200ms
 * - Admin app response time (p95): ≤ 500ms
 * - Storefront speed impact: < 10 performance points
 *
 * Usage in components:
 *
 * import { measurePageLoad } from '~/utils/performance.client';
 *
 * useEffect(() => {
 *   measurePageLoad('ProductsPage');
 * }, []);
 */

/**
 * Check if we're in development mode
 * Only checks APP_ENV (NODE_ENV is always 'production' in Railway)
 */
function isDevelopment(): boolean {
  // Check window.ENV first (injected by Remix from server)
  if (typeof window !== 'undefined' && (window as any).ENV) {
    const env = (window as any).ENV;
    return env.APP_ENV === 'development';
  }

  // Default to false (production)
  return false;
}

interface PerformanceMetrics {
  pageName: string;
  loadTime: number;
  navigationStart?: number;
  domContentLoaded?: number;
  domComplete?: number;
  resourceCount?: number;
}

/**
 * Measures and logs the page load performance
 * Call this in useEffect() after the page has loaded
 * Only logs in development mode
 */
export function measurePageLoad(pageName: string, additionalData?: Record<string, any>) {
  if (typeof window === 'undefined' || !window.performance) {
    return;
  }

  // Only log performance in development mode
  if (!isDevelopment()) {
    return;
  }

  try {
    const markName = `${pageName}-load`;

    // Create a performance mark for this page load
    performance.mark(markName);

    // Get navigation timing
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;

    // Calculate load time from navigation start
    const loadTime = performance.now();

    // Get resource timing
    const resources = performance.getEntriesByType('resource');

    // Build metrics object
    const metrics: PerformanceMetrics = {
      pageName,
      loadTime: Math.round(loadTime),
      resourceCount: resources.length,
    };

    if (navigation) {
      metrics.navigationStart = Math.round(navigation.fetchStart);
      metrics.domContentLoaded = Math.round(navigation.domContentLoadedEventEnd - navigation.fetchStart);
      metrics.domComplete = Math.round(navigation.domComplete - navigation.fetchStart);
    }

    // Add any additional data
    if (additionalData) {
      Object.assign(metrics, additionalData);
    }

    // Calculate Largest Contentful Paint (LCP) if available using PerformanceObserver
    let lcp: number | undefined;
    try {
      // Use PerformanceObserver with buffered: true to get past LCP entries
      if ('PerformanceObserver' in window && PerformanceObserver.supportedEntryTypes?.includes('largest-contentful-paint')) {
        const observer = new PerformanceObserver((list) => {
          const entries = list.getEntries();
          if (entries.length > 0) {
            const lastEntry = entries[entries.length - 1];
            lcp = Math.round(lastEntry.startTime);
          }
        });
        observer.observe({ type: 'largest-contentful-paint', buffered: true });
        // Disconnect immediately after reading buffered entries
        observer.disconnect();
      }
    } catch (e) {
      // LCP might not be available in all browsers
    }

    // Store in performance timeline
    performance.measure(`${pageName}-complete`, {
      start: 0,
      end: performance.now(),
    });

  } catch (error) {
    console.error('[Performance] Error measuring page load:', error);
  }
}
