/**
 * Client-side Performance Monitoring Utility
 *
 * Automatically measures and logs page load performance in the browser console.
 * Uses the Web Performance API (performance.mark, performance.measure).
 *
 * Logs are only displayed in development mode (NODE_ENV=development or APP_ENV=development).
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
 * Checks both window.ENV (injected by Remix) and import.meta.env
 */
function isDevelopment(): boolean {
  // Check window.ENV first (Remix injects this)
  if (typeof window !== 'undefined' && (window as any).ENV) {
    const env = (window as any).ENV;
    return env.NODE_ENV === 'development' || env.APP_ENV === 'development';
  }

  // Fallback: Check import.meta.env (Vite)
  if (typeof import.meta !== 'undefined' && import.meta.env) {
    return import.meta.env.MODE === 'development' ||
           import.meta.env.DEV === true;
  }

  // Default to false in production
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

    // Calculate Largest Contentful Paint (LCP) if available
    let lcp: number | undefined;
    try {
      const lcpEntries = performance.getEntriesByType('largest-contentful-paint');
      if (lcpEntries.length > 0) {
        const lastLcp = lcpEntries[lcpEntries.length - 1] as PerformanceEntry;
        lcp = Math.round(lastLcp.startTime);
      }
    } catch (e) {
      // LCP might not be available in all browsers
    }

    // Log to console with styling
    console.group(`⚡ Performance: ${pageName}`);
    console.log(`📊 Total Load Time: ${metrics.loadTime}ms`);

    if (metrics.domContentLoaded) {
      console.log(`📄 DOM Content Loaded: ${metrics.domContentLoaded}ms`);
    }

    if (metrics.domComplete) {
      console.log(`✅ DOM Complete: ${metrics.domComplete}ms`);
    }

    if (lcp) {
      console.log(`🎨 Largest Contentful Paint (LCP): ${lcp}ms`);
    }

    if (metrics.resourceCount) {
      console.log(`📦 Resources Loaded: ${metrics.resourceCount}`);
    }

    if (additionalData) {
      console.log('📋 Additional Data:', additionalData);
    }

    // Performance assessment based on Shopify "Built for Shopify" standards
    console.log('\n🏆 Shopify Built for Shopify Standards (75th percentile):');

    // LCP Assessment (should be ≤ 2500ms)
    if (lcp !== undefined) {
      if (lcp <= 2500) {
        console.log(`  ✅ LCP: ${lcp}ms (≤ 2500ms) - PASS`);
      } else if (lcp <= 4000) {
        console.log(`  ⚠️ LCP: ${lcp}ms (needs improvement, target: ≤ 2500ms)`);
      } else {
        console.log(`  ❌ LCP: ${lcp}ms (poor, target: ≤ 2500ms)`);
      }
    }

    // Overall Load Time Assessment (general admin app guideline)
    console.log('\n📈 Overall Performance:');
    if (metrics.loadTime <= 500) {
      console.log(`  🚀 Excellent: ${metrics.loadTime}ms (≤ 500ms - Shopify p95 standard)`);
    } else if (metrics.loadTime <= 1000) {
      console.log(`  ✅ Good: ${metrics.loadTime}ms (≤ 1000ms)`);
    } else if (metrics.loadTime <= 2000) {
      console.log(`  ⚠️ Acceptable: ${metrics.loadTime}ms (≤ 2000ms)`);
    } else if (metrics.loadTime <= 3000) {
      console.log(`  ⚠️ Needs Improvement: ${metrics.loadTime}ms (> 2000ms)`);
    } else {
      console.log(`  ❌ Poor: ${metrics.loadTime}ms (> 3000ms - optimize required)`);
    }

    console.log('\n💡 Tip: For Shopify admin apps, aim for <500ms response times (p95)');
    console.groupEnd();

    // Store in performance timeline
    performance.measure(`${pageName}-complete`, {
      start: 0,
      end: performance.now(),
    });

  } catch (error) {
    console.error('[Performance] Error measuring page load:', error);
  }
}

/**
 * Measures a specific operation (e.g., data loading, rendering)
 * Only logs in development mode
 */
export function measureOperation(operationName: string, startMark?: string) {
  if (typeof window === 'undefined' || !window.performance) {
    return () => {};
  }

  // Only log performance in development mode
  if (!isDevelopment()) {
    return () => {};
  }

  try {
    const startMarkName = startMark || `${operationName}-start`;
    performance.mark(startMarkName);

    return () => {
      const endMarkName = `${operationName}-end`;
      performance.mark(endMarkName);

      performance.measure(operationName, startMarkName, endMarkName);

      const measure = performance.getEntriesByName(operationName, 'measure')[0];
      if (measure) {
        console.log(`⏱️ ${operationName}: ${Math.round(measure.duration)}ms`);
      }

      // Cleanup
      performance.clearMarks(startMarkName);
      performance.clearMarks(endMarkName);
      performance.clearMeasures(operationName);
    };
  } catch (error) {
    console.error('[Performance] Error measuring operation:', error);
    return () => {};
  }
}

/**
 * Gets all performance measures
 */
export function getAllMeasures() {
  if (typeof window === 'undefined' || !window.performance) {
    return [];
  }

  return performance.getEntriesByType('measure');
}

/**
 * Clears all performance data
 */
export function clearPerformanceData() {
  if (typeof window === 'undefined' || !window.performance) {
    return;
  }

  performance.clearMarks();
  performance.clearMeasures();
  performance.clearResourceTimings();
}
