/**
 * Mock Shopify GraphQL Responses
 *
 * Verwendung:
 * - Keine echte Shopify-Installation nötig
 * - Testdaten basierend auf echten Shopify-Responses
 * - Kann auch für Storybook verwendet werden
 */

import { vi } from 'vitest';

/**
 * Mock Product Data (entspricht Shopify Admin API Schema)
 */
export const mockShopifyProduct = {
  id: 'gid://shopify/Product/123456789',
  title: 'Premium Leather Wallet',
  descriptionHtml: '<p>Handcrafted genuine leather wallet with RFID protection.</p>',
  handle: 'premium-leather-wallet',
  status: 'ACTIVE',
  productType: 'Accessories',
  updatedAt: '2026-02-04T10:00:00Z',
  seo: {
    title: 'Premium Leather Wallet - RFID Protection',
    description: 'Shop our handcrafted leather wallet with RFID blocking. Free shipping.'
  },
  featuredImage: {
    url: 'https://cdn.shopify.com/example.jpg',
    altText: 'Premium leather wallet in brown'
  },
  media: {
    edges: [
      {
        node: {
          id: 'gid://shopify/MediaImage/111',
          alt: 'Premium leather wallet in brown',
          image: {
            url: 'https://cdn.shopify.com/image1.jpg'
          }
        }
      },
      {
        node: {
          id: 'gid://shopify/MediaImage/222',
          alt: 'Wallet interior showing card slots',
          image: {
            url: 'https://cdn.shopify.com/image2.jpg'
          }
        }
      }
    ]
  },
  options: [
    {
      id: 'gid://shopify/ProductOption/1',
      name: 'Color',
      position: 1,
      linkedMetafield: null,
      optionValues: [
        { id: 'gid://shopify/ProductOptionValue/1', name: 'Brown', linkedMetafieldValue: null },
        { id: 'gid://shopify/ProductOptionValue/2', name: 'Black', linkedMetafieldValue: null },
        { id: 'gid://shopify/ProductOptionValue/3', name: 'Navy', linkedMetafieldValue: null },
      ]
    },
    {
      id: 'gid://shopify/ProductOption/2',
      name: 'Size',
      position: 2,
      linkedMetafield: null,
      optionValues: [
        { id: 'gid://shopify/ProductOptionValue/4', name: 'Standard', linkedMetafieldValue: null },
        { id: 'gid://shopify/ProductOptionValue/5', name: 'Large', linkedMetafieldValue: null },
      ]
    }
  ],
  metafields: {
    edges: [
      {
        node: {
          id: 'gid://shopify/Metafield/1',
          namespace: 'custom',
          key: 'material',
          value: 'Genuine Italian Leather',
          type: 'single_line_text_field'
        }
      }
    ]
  }
};

/**
 * Mock Shop Locales
 */
export const mockShopLocales = [
  {
    locale: 'de',
    name: 'German',
    primary: true,
    published: true
  },
  {
    locale: 'en',
    name: 'English',
    primary: false,
    published: true
  },
  {
    locale: 'fr',
    name: 'French',
    primary: false,
    published: true
  }
];

/**
 * Mock Translatable Content (für Übersetzungen)
 */
export const mockTranslatableContent = {
  translatableContent: [
    {
      key: 'title',
      value: 'Premium Leder Geldbörse',
      digest: 'abc123',
      locale: 'de'
    },
    {
      key: 'body_html',
      value: '<p>Handgefertigte Leder-Geldbörse mit RFID-Schutz.</p>',
      digest: 'def456',
      locale: 'de'
    }
  ],
  translations: [
    {
      key: 'title',
      value: 'Premium Leather Wallet',
      locale: 'en'
    },
    {
      key: 'body_html',
      value: '<p>Handcrafted genuine leather wallet with RFID protection.</p>',
      locale: 'en'
    }
  ]
};

/**
 * Mock Collection Data
 */
export const mockShopifyCollection = {
  id: 'gid://shopify/Collection/987654321',
  title: 'Leather Goods',
  descriptionHtml: '<p>Explore our premium leather collection.</p>',
  handle: 'leather-goods',
  imageUrl: 'https://cdn.shopify.com/collection.jpg',
  imageAltText: 'Collection of leather products',
  seoTitle: 'Premium Leather Collection',
  seoDescription: 'Shop our curated leather goods collection.',
  updatedAt: '2026-02-04T10:00:00Z'
};

/**
 * Mock GraphQL Admin Client
 */
export const createMockShopifyAdmin = () => {
  const graphql = vi.fn().mockImplementation((query: string, options?: any) => {
    // Product Query
    if (query.includes('query getProduct')) {
      return Promise.resolve({
        json: () => Promise.resolve({
          data: { product: mockShopifyProduct }
        })
      });
    }

    // Shop Locales Query
    if (query.includes('query getShopLocales')) {
      return Promise.resolve({
        json: () => Promise.resolve({
          data: { shopLocales: mockShopLocales }
        })
      });
    }

    // Translatable Resource Query
    if (query.includes('query getTranslations')) {
      return Promise.resolve({
        json: () => Promise.resolve({
          data: { translatableResource: mockTranslatableContent }
        })
      });
    }

    // Media Image Translations Bulk Query
    if (query.includes('query getMediaImageTranslationsBulk')) {
      return Promise.resolve({
        json: () => Promise.resolve({
          data: {
            translatableResourcesByIds: {
              edges: [
                {
                  node: {
                    resourceId: 'gid://shopify/MediaImage/111',
                    translations: [
                      { key: 'alt', value: 'Premium leather wallet in brown' }
                    ]
                  }
                }
              ]
            }
          }
        })
      });
    }

    // Translation Mutation
    if (query.includes('mutation updateTranslation')) {
      return Promise.resolve({
        json: () => Promise.resolve({
          data: {
            translationsRegister: {
              userErrors: [],
              translations: [
                {
                  key: 'title',
                  value: options?.variables?.translations?.[0]?.value || 'Translated Title',
                  locale: options?.variables?.translations?.[0]?.locale || 'en'
                }
              ]
            }
          }
        })
      });
    }

    // Default: Empty response
    return Promise.resolve({
      json: () => Promise.resolve({ data: {} })
    });
  });

  return { graphql };
};

/**
 * Mock für Shopify REST Admin (falls benötigt)
 */
export const createMockShopifyREST = () => ({
  get: vi.fn().mockResolvedValue({ body: {} }),
  post: vi.fn().mockResolvedValue({ body: {} }),
  put: vi.fn().mockResolvedValue({ body: {} }),
  delete: vi.fn().mockResolvedValue({ body: {} }),
});
