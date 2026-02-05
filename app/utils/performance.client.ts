/**
 * Client-side Performance Monitoring Utility
 *
 * Automatically measures and logs page load performance in the browser console.
 * Uses the Web Performance API (performance.mark, performance.measure).
 *
 * Usage in components:
 *
 * import { measurePageLoad } from '~/utils/performance.client';
 *
 * useEffect(() => {
 *   measurePageLoad('ProductsPage');
 * }, []);
 */

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
 */
export function measurePageLoad(pageName: string, additionalData?: Record<string, any>) {
  if (typeof window === 'undefined' || !window.performance) {
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

    // Log to console with styling
    console.group(`⚡ Performance: ${pageName}`);
    console.log(`📊 Total Load Time: ${metrics.loadTime}ms`);

    if (metrics.domContentLoaded) {
      console.log(`📄 DOM Content Loaded: ${metrics.domContentLoaded}ms`);
    }

    if (metrics.domComplete) {
      console.log(`✅ DOM Complete: ${metrics.domComplete}ms`);
    }

    if (metrics.resourceCount) {
      console.log(`📦 Resources Loaded: ${metrics.resourceCount}`);
    }

    if (additionalData) {
      console.log('📋 Additional Data:', additionalData);
    }

    // Performance assessment
    if (metrics.loadTime < 1000) {
      console.log('🚀 Performance: Excellent (<1s)');
    } else if (metrics.loadTime < 2000) {
      console.log('✅ Performance: Good (<2s)');
    } else if (metrics.loadTime < 3000) {
      console.log('⚠️ Performance: Acceptable (<3s)');
    } else {
      console.log('❌ Performance: Slow (>3s)');
    }

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
 */
export function measureOperation(operationName: string, startMark?: string) {
  if (typeof window === 'undefined' || !window.performance) {
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
