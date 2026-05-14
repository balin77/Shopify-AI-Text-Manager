/**
 * Webhook Registration Service
 *
 * Registers webhooks with Shopify for product events
 */

import { logger } from '~/utils/logger.server';

interface WebhookUserError {
  field?: string;
  message: string;
}

interface WebhookSubscription {
  id: string;
  topic: string;
  endpoint?: {
    __typename: string;
    callbackUrl?: string;
  };
}

interface ShopifyGraphQLClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<{ json: () => Promise<any> }>;
}

export class WebhookRegistrationService {
  constructor(private admin: ShopifyGraphQLClient) {}

  /**
   * Register all product webhooks
   */
  async registerProductWebhooks(): Promise<void> {
    const appUrl = process.env.SHOPIFY_APP_URL;

    if (!appUrl) {
      throw new Error("SHOPIFY_APP_URL environment variable not set");
    }

    const webhooks = [
      {
        topic: "PRODUCTS_CREATE",
        address: `${appUrl}/webhooks/products`,
      },
      {
        topic: "PRODUCTS_UPDATE",
        address: `${appUrl}/webhooks/products`,
      },
      {
        topic: "PRODUCTS_DELETE",
        address: `${appUrl}/webhooks/products`,
      },
    ];

    logger.info(`[WebhookRegistration] Registering product webhooks...`);

    for (const webhook of webhooks) {
      try {
        await this.registerWebhook(webhook.topic, webhook.address);
        logger.info(`[WebhookRegistration] Registered ${webhook.topic}`);
      } catch (error: unknown) {
        logger.error(`[WebhookRegistration] Failed to register ${webhook.topic}:`, error instanceof Error ? error.message : String(error));
        // Continue with other webhooks even if one fails
      }
    }

    logger.info(`[WebhookRegistration] Webhook registration complete`);
  }

  /**
   * Register all content webhooks (collections, blogs)
   */
  async registerContentWebhooks(): Promise<void> {
    const appUrl = process.env.SHOPIFY_APP_URL;

    if (!appUrl) {
      throw new Error("SHOPIFY_APP_URL environment variable not set");
    }

    const webhooks = [
      // Collection webhooks
      {
        topic: "COLLECTIONS_CREATE",
        address: `${appUrl}/webhooks/collections`,
      },
      {
        topic: "COLLECTIONS_UPDATE",
        address: `${appUrl}/webhooks/collections`,
      },
      {
        topic: "COLLECTIONS_DELETE",
        address: `${appUrl}/webhooks/collections`,
      },
      // Blog article webhooks
      {
        topic: "ARTICLES_CREATE",
        address: `${appUrl}/webhooks/articles`,
      },
      {
        topic: "ARTICLES_UPDATE",
        address: `${appUrl}/webhooks/articles`,
      },
      {
        topic: "ARTICLES_DELETE",
        address: `${appUrl}/webhooks/articles`,
      },
    ];

    logger.info(`[WebhookRegistration] Registering content webhooks...`);

    for (const webhook of webhooks) {
      try {
        await this.registerWebhook(webhook.topic, webhook.address);
        logger.info(`[WebhookRegistration] Registered ${webhook.topic}`);
      } catch (error: unknown) {
        logger.error(`[WebhookRegistration] Failed to register ${webhook.topic}:`, error instanceof Error ? error.message : String(error));
        // Continue with other webhooks even if one fails
      }
    }

    logger.info(`[WebhookRegistration] Content webhook registration complete`);
  }

  /**
   * Register subscription webhooks
   */
  async registerSubscriptionWebhooks(): Promise<void> {
    const appUrl = process.env.SHOPIFY_APP_URL;

    if (!appUrl) {
      throw new Error("SHOPIFY_APP_URL environment variable not set");
    }

    const webhooks = [
      {
        topic: "APP_SUBSCRIPTIONS_UPDATE",
        address: `${appUrl}/webhooks/subscription`,
      },
    ];

    logger.info(`[WebhookRegistration] Registering subscription webhooks...`);

    for (const webhook of webhooks) {
      try {
        await this.registerWebhook(webhook.topic, webhook.address);
        logger.info(`[WebhookRegistration] Registered ${webhook.topic}`);
      } catch (error: unknown) {
        logger.error(`[WebhookRegistration] Failed to register ${webhook.topic}:`, error instanceof Error ? error.message : String(error));
        // Continue with other webhooks even if one fails
      }
    }

    logger.info(`[WebhookRegistration] Subscription webhook registration complete`);
  }

  /**
   * Manual re-registration of all webhooks. Used by the Settings → Setup tab
   * and the /api/setup-webhooks debug endpoint.
   *
   * NOTE: All webhook subscriptions (app/uninstalled, products/*, collections/*,
   * articles/*, app_subscriptions/update) are declared in shopify.app.toml and
   * registered automatically by Shopify on every (re)install. This method exists
   * only as a manual recovery / inspection tool — it should be a no-op in
   * normal operation (existing subscriptions are detected and updated in place).
   */
  async registerAllWebhooks(): Promise<void> {
    await this.registerProductWebhooks();
    await this.registerContentWebhooks();
    await this.registerSubscriptionWebhooks();
  }

  /**
   * Register a single webhook
   */
  private async registerWebhook(topic: string, address: string): Promise<void> {
    // First, check if webhook already exists
    const existing = await this.getExistingWebhook(topic);

    if (existing) {
      logger.info(`[WebhookRegistration] Webhook ${topic} already exists, updating...`);
      await this.updateWebhook(existing.id, address);
      return;
    }

    // Create new webhook
    const response = await this.admin.graphql(
      `#graphql
        mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
          webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
            webhookSubscription {
              id
              topic
              endpoint {
                __typename
                ... on WebhookHttpEndpoint {
                  callbackUrl
                }
              }
            }
            userErrors {
              field
              message
            }
          }
        }`,
      {
        variables: {
          topic,
          webhookSubscription: {
            callbackUrl: address,
            format: "JSON",
          },
        },
      }
    );

    const data = await response.json();

    if (data.data?.webhookSubscriptionCreate?.userErrors?.length > 0) {
      const errors = data.data.webhookSubscriptionCreate.userErrors;
      throw new Error(`Webhook creation failed: ${(errors as WebhookUserError[]).map((e) => e.message).join(", ")}`);
    }

    logger.info(`[WebhookRegistration] Created webhook ${topic}`);
  }

  /**
   * Get existing webhook subscription
   */
  private async getExistingWebhook(topic: string): Promise<WebhookSubscription | null> {
    const response = await this.admin.graphql(
      `#graphql
        query getWebhookSubscriptions {
          webhookSubscriptions(first: 100) {
            edges {
              node {
                id
                topic
                endpoint {
                  __typename
                  ... on WebhookHttpEndpoint {
                    callbackUrl
                  }
                }
              }
            }
          }
        }`
    );

    const data = await response.json();
    const subscriptions = data.data?.webhookSubscriptions?.edges || [];

    for (const edge of subscriptions) {
      if (edge.node.topic === topic) {
        return edge.node;
      }
    }

    return null;
  }

  /**
   * Update existing webhook
   */
  private async updateWebhook(id: string, address: string): Promise<void> {
    const response = await this.admin.graphql(
      `#graphql
        mutation webhookSubscriptionUpdate($id: ID!, $webhookSubscription: WebhookSubscriptionInput!) {
          webhookSubscriptionUpdate(id: $id, webhookSubscription: $webhookSubscription) {
            webhookSubscription {
              id
            }
            userErrors {
              field
              message
            }
          }
        }`,
      {
        variables: {
          id,
          webhookSubscription: {
            callbackUrl: address,
            format: "JSON",
          },
        },
      }
    );

    const data = await response.json();

    if (data.data?.webhookSubscriptionUpdate?.userErrors?.length > 0) {
      const errors = data.data.webhookSubscriptionUpdate.userErrors;
      throw new Error(`Webhook update failed: ${(errors as WebhookUserError[]).map((e) => e.message).join(", ")}`);
    }
  }

  /**
   * List all registered webhooks (for debugging)
   */
  async listWebhooks(): Promise<WebhookSubscription[]> {
    const response = await this.admin.graphql(
      `#graphql
        query getWebhookSubscriptions {
          webhookSubscriptions(first: 100) {
            edges {
              node {
                id
                topic
                endpoint {
                  __typename
                  ... on WebhookHttpEndpoint {
                    callbackUrl
                  }
                }
              }
            }
          }
        }`
    );

    const data = await response.json();
    return (data.data?.webhookSubscriptions?.edges as Array<{ node: WebhookSubscription }> || []).map((e) => e.node);
  }
}
