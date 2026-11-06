/**
 * Shopify API Gateway
 *
 * Centralized gateway for all Shopify GraphQL API calls with:
 * - Rate limiting control
 * - Automatic retry on rate limit errors
 * - Request queuing
 * - Detailed logging
 */

import { logger } from '~/utils/logger.server';
import { getFullErrorMessage } from '~/utils/error-handler';
import type { ShopifyGraphQLClient } from './sync-types';

interface GraphQLResponse {
  ok: boolean;
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: () => Promise<any>;
}

interface QueuedRequest {
  query: string;
  variables?: Record<string, unknown>;
  resolve: (value: GraphQLResponse) => void;
  reject: (reason: unknown) => void;
  retryCount: number;
}

export class ShopifyApiGateway {
  private admin: ShopifyGraphQLClient;
  private shop: string;
  private requestQueue: QueuedRequest[] = [];
  private isProcessing: boolean = false;
  private requestCount: number = 0;
  private windowStart: number = Date.now();

  // Rate limiting configuration
  // Shopify GraphQL uses cost-based limits (100-1000 points/sec depending on plan)
  // Simple translation queries cost ~5-15 points each
  // Conservative approach: 10 requests per second = ~50-150 points/sec (safe for all plans)
  private readonly MAX_REQUESTS_PER_SECOND = 10;
  private readonly REQUEST_WINDOW = 1000; // 1 second window
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY_MS = 1000; // 1 second between retries (Shopify recommends 1s backoff)

  constructor(admin: ShopifyGraphQLClient, shop: string) {
    this.admin = admin;
    this.shop = shop;
  }

  /**
   * The client this gateway sends through. For code that outlives its request
   * and has to decide (`backgroundAdmin`) whether that client may be kept.
   */
  getAdmin(): ShopifyGraphQLClient {
    return this.admin;
  }

  /**
   * Execute a GraphQL query with rate limiting and retry logic
   */
  async graphql(query: string, options?: { variables?: Record<string, unknown> }): Promise<GraphQLResponse> {
    return new Promise((resolve, reject) => {
      this.requestQueue.push({
        query,
        variables: options?.variables,
        resolve,
        reject,
        retryCount: 0
      });

      // Start processing queue if not already running
      if (!this.isProcessing) {
        this.processQueue();
      }
    });
  }

  /**
   * Process queued requests with rate limiting
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    while (this.requestQueue.length > 0) {
      // Check rate limit
      const now = Date.now();
      const timeElapsed = now - this.windowStart;

      // Reset counter if window has passed
      if (timeElapsed >= this.REQUEST_WINDOW) {
        this.requestCount = 0;
        this.windowStart = now;
      }

      // If we've hit the rate limit, wait
      if (this.requestCount >= this.MAX_REQUESTS_PER_SECOND) {
        const waitTime = this.REQUEST_WINDOW - timeElapsed;
        logger.debug(`[ShopifyGateway] Rate limit reached (${this.requestCount}/${this.MAX_REQUESTS_PER_SECOND}). Waiting ${waitTime}ms...`);
        await this.sleep(waitTime);
        this.requestCount = 0;
        this.windowStart = Date.now();
      }

      // Get next request from queue
      const request = this.requestQueue.shift();
      if (!request) break;

      try {
        // Execute the request
        const response = await this.admin.graphql(request.query, {
          variables: request.variables
        });

        this.requestCount++;

        // Parse response to check for rate limit errors
        const data = await response.json() as Record<string, unknown>;

        // Check for rate limit errors in the response
        if (this.isRateLimitError(data)) {
          logger.debug(`[ShopifyGateway] Rate limit error detected in response`);
          await this.handleRateLimitError(request);
          continue;
        }

        // Check for other GraphQL errors
        if (Array.isArray(data.errors) && data.errors.length > 0) {
          const error = data.errors[0] as { extensions?: { code?: string }; message?: string };

          // If it's a throttle error, retry
          if (error.extensions?.code === 'THROTTLED') {
            logger.debug(`[ShopifyGateway] Throttled request detected`);
            await this.handleRateLimitError(request);
            continue;
          }

          // Other errors - log and continue
          logger.warn(`[ShopifyGateway] GraphQL error:`, error.message);
        }

        // Success - resolve the promise with a Response-like object
        request.resolve({ ok: true, status: 200, json: async () => data });

      } catch (error: unknown) {
        // Check if it's a rate limit error from HTTP status
        if (isThrownRateLimitError(error)) {
          logger.debug(`[ShopifyGateway] HTTP 429 rate limit error`);
          await this.handleRateLimitError(request);
        } else {
          // Other errors - reject after retries
          if (request.retryCount < this.MAX_RETRIES) {
            logger.warn(`[ShopifyGateway] Request failed, retrying (${request.retryCount + 1}/${this.MAX_RETRIES}):`, getFullErrorMessage(error));
            request.retryCount++;
            this.requestQueue.unshift(request); // Add back to front of queue
            await this.sleep(this.RETRY_DELAY_MS);
          } else {
            const fullMsg = getFullErrorMessage(error);
            logger.error(`[ShopifyGateway] Request failed after ${this.MAX_RETRIES} retries:`, fullMsg);
            // Enrich the error message with cause details before rejecting
            if (error instanceof Error && fullMsg !== error.message) {
              error.message = fullMsg;
            }
            request.reject(error);
          }
        }
      }

      // Small delay between requests (20ms = smooth distribution, ~50 req/sec max)
      await this.sleep(20);
    }

    this.isProcessing = false;
  }

  /**
   * Handle rate limit errors by retrying the request
   */
  private async handleRateLimitError(request: QueuedRequest): Promise<void> {
    if (request.retryCount < this.MAX_RETRIES) {
      const backoffTime = this.RETRY_DELAY_MS * (request.retryCount + 1); // Exponential backoff
      logger.debug(`[ShopifyGateway] Retrying after ${backoffTime}ms (attempt ${request.retryCount + 1}/${this.MAX_RETRIES})`);

      request.retryCount++;

      // Wait before retrying
      await this.sleep(backoffTime);

      // Add back to queue
      this.requestQueue.unshift(request);

      // Reset rate limit counter
      this.requestCount = 0;
      this.windowStart = Date.now();
    } else {
      logger.error(`[ShopifyGateway] Request failed after ${this.MAX_RETRIES} rate limit retries`);
      request.reject(new Error('Rate limit exceeded after maximum retries'));
    }
  }

  /**
   * Check if response contains rate limit error
   */
  private isRateLimitError(data: Record<string, unknown>): boolean {
    if (!data.errors || !Array.isArray(data.errors)) return false;

    return data.errors.some((error: unknown) => {
      if (typeof error !== 'object' || error === null) return false;
      const e = error as { extensions?: { code?: string }; message?: string };
      return (
        e.extensions?.code === 'THROTTLED' ||
        e.message?.toLowerCase().includes('throttled') ||
        e.message?.toLowerCase().includes('rate limit')
      );
    });
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get current queue status (for monitoring)
   */
  getQueueStatus(): { queueLength: number; isProcessing: boolean; requestCount: number } {
    return {
      queueLength: this.requestQueue.length,
      isProcessing: this.isProcessing,
      requestCount: this.requestCount
    };
  }

  /**
   * Clear the queue (useful for testing or emergency stops)
   */
  clearQueue(): void {
    const clearedCount = this.requestQueue.length;
    this.requestQueue.forEach(req =>
      req.reject(new Error('Queue cleared'))
    );
    this.requestQueue = [];
    logger.debug(`[ShopifyGateway] Cleared ${clearedCount} queued requests`);
  }
}

/**
 * Is a THROWN error Shopify saying "slow down"? Three shapes reach the gateway:
 * a plain `{ status: 429 }`, the library's `HttpThrottlingError` /
 * `HttpResponseError` (`response.code === 429` — what the refreshing offline
 * client throws, since it wraps the library client rather than raw fetch), and
 * the library's `GraphqlQueryError` for an HTTP-200 `THROTTLED` answer, whose
 * GraphQL `errors` ride on `body`. Matched by SHAPE, not class: two copies of
 * @shopify/shopify-api can coexist in the bundle and `instanceof` misses one.
 */
export function isThrownRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as {
    status?: number;
    name?: string;
    message?: string;
    response?: { code?: number; status?: number };
    body?: { errors?: unknown };
  };
  if (e.status === 429) return true;
  if (e.response?.code === 429 || e.response?.status === 429) return true;
  if (e.name === "HttpThrottlingError") return true;
  // The library's GraphqlQueryError (clients/common throwFailedRequest) carries
  // the graphql-client's error OBJECT on `body.errors`:
  // `{ message, graphQLErrors: [...], networkStatusCode, response }`, and its
  // own message is `graphQLErrors[0].message` ("Throttled"). A bare array is
  // kept for callers that hand over the raw response's `errors`.
  const bodyErrors = e.body?.errors;
  const graphQLErrors: unknown[] = Array.isArray(bodyErrors)
    ? bodyErrors
    : bodyErrors && typeof bodyErrors === "object" &&
        Array.isArray((bodyErrors as { graphQLErrors?: unknown }).graphQLErrors)
      ? ((bodyErrors as { graphQLErrors: unknown[] }).graphQLErrors)
      : [];
  if (
    graphQLErrors.some((x) => (x as { extensions?: { code?: string } } | null)?.extensions?.code === "THROTTLED")
  ) {
    return true;
  }
  if (typeof e.message !== "string") return false;
  const msg = e.message.toLowerCase();
  return msg.includes("rate limit") || msg.trim() === "throttled";
}
