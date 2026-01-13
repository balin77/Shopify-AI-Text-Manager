/**
 * Shopify API Gateway
 *
 * Centralized gateway for all Shopify GraphQL API calls with:
 * - Rate limiting control
 * - Automatic retry on rate limit errors
 * - Request queuing
 * - Detailed logging
 */

interface ShopifyGraphQLClient {
  graphql: (query: string, options?: { variables?: any }) => Promise<any>;
}

interface QueuedRequest {
  query: string;
  variables?: any;
  resolve: (value: any) => void;
  reject: (reason: any) => void;
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
   * Execute a GraphQL query with rate limiting and retry logic
   */
  async graphql(query: string, options?: { variables?: any }): Promise<any> {
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
        console.log(`[ShopifyGateway] Rate limit reached (${this.requestCount}/${this.MAX_REQUESTS_PER_SECOND}). Waiting ${waitTime}ms...`);
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
        const data = await response.json();

        // Check for rate limit errors in the response
        if (this.isRateLimitError(data)) {
          console.log(`[ShopifyGateway] Rate limit error detected in response`);
          await this.handleRateLimitError(request);
          continue;
        }

        // Check for other GraphQL errors
        if (data.errors && data.errors.length > 0) {
          const error = data.errors[0];

          // If it's a throttle error, retry
          if (error.extensions?.code === 'THROTTLED') {
            console.log(`[ShopifyGateway] Throttled request detected`);
            await this.handleRateLimitError(request);
            continue;
          }

          // Other errors - log and continue
          console.warn(`[ShopifyGateway] GraphQL error:`, error.message);
        }

        // Success - resolve the promise with the original response
        request.resolve({ json: async () => data });

      } catch (error: any) {
        // Check if it's a rate limit error from HTTP status
        if (error.status === 429 || error.message?.includes('rate limit')) {
          console.log(`[ShopifyGateway] HTTP 429 rate limit error`);
          await this.handleRateLimitError(request);
        } else {
          // Other errors - reject after retries
          if (request.retryCount < this.MAX_RETRIES) {
            console.warn(`[ShopifyGateway] Request failed, retrying (${request.retryCount + 1}/${this.MAX_RETRIES}):`, error.message);
            request.retryCount++;
            this.requestQueue.unshift(request); // Add back to front of queue
            await this.sleep(this.RETRY_DELAY_MS);
          } else {
            console.error(`[ShopifyGateway] Request failed after ${this.MAX_RETRIES} retries:`, error.message);
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
      console.log(`[ShopifyGateway] Retrying after ${backoffTime}ms (attempt ${request.retryCount + 1}/${this.MAX_RETRIES})`);

      request.retryCount++;

      // Wait before retrying
      await this.sleep(backoffTime);

      // Add back to queue
      this.requestQueue.unshift(request);

      // Reset rate limit counter
      this.requestCount = 0;
      this.windowStart = Date.now();
    } else {
      console.error(`[ShopifyGateway] Request failed after ${this.MAX_RETRIES} rate limit retries`);
      request.reject(new Error('Rate limit exceeded after maximum retries'));
    }
  }

  /**
   * Check if response contains rate limit error
   */
  private isRateLimitError(data: any): boolean {
    if (!data.errors) return false;

    return data.errors.some((error: any) =>
      error.extensions?.code === 'THROTTLED' ||
      error.message?.toLowerCase().includes('throttled') ||
      error.message?.toLowerCase().includes('rate limit')
    );
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
    console.log(`[ShopifyGateway] Cleared ${clearedCount} queued requests`);
  }
}
