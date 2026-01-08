import { ShopifyConnector } from '../shopify-connector';

export class TranslationService {
  constructor(private connector: ShopifyConnector) {}

  async getTranslations(productId: string, locales: string[]) {
    const translations: any = {};

    for (const locale of locales) {
      try {
        const transQuery = `
          query getTranslations($id: ID!) {
            translatableResource(resourceId: $id) {
              translations(locale: "${locale}") {
                key
                value
              }
            }
          }
        `;

        const transResult = await this.connector.executeQuery(transQuery, { id: productId });
        const trans = transResult.translatableResource.translations;

        translations[locale] = {
          title: trans.find((t: any) => t.key === 'title')?.value || '',
          description: trans.find((t: any) => t.key === 'body_html')?.value || '',
          handle: trans.find((t: any) => t.key === 'handle')?.value || '',
          seoTitle: trans.find((t: any) => t.key === 'meta_title')?.value || '',
          metaDescription: trans.find((t: any) => t.key === 'meta_description')?.value || '',
        };
      } catch (e) {
        translations[locale] = {
          title: '',
          description: '',
          handle: '',
          seoTitle: '',
          metaDescription: '',
        };
      }
    }

    return translations;
  }

  async getTranslatableContent(productId: string) {
    const query = `
      query getTranslatableContent($id: ID!) {
        translatableResource(resourceId: $id) {
          translatableContent {
            key
            digest
          }
        }
      }
    `;

    const result = await this.connector.executeQuery(query, { id: productId });
    return result.translatableResource.translatableContent;
  }

  async saveTranslation(
    productId: string,
    locale: string,
    data: {
      title?: string;
      description?: string;
      handle?: string;
      seoTitle?: string;
      metaDescription?: string;
    }
  ) {
    const translatableContent = await this.getTranslatableContent(productId);
    const translations: any[] = [];

    // Build translations array
    if (data.title) {
      const titleContent = translatableContent.find((c: any) => c.key === 'title');
      if (titleContent) {
        translations.push({
          key: 'title',
          value: data.title,
          locale,
          translatableContentDigest: titleContent.digest,
        });
      }
    }

    if (data.description) {
      const descContent = translatableContent.find((c: any) => c.key === 'body_html');
      if (descContent) {
        translations.push({
          key: 'body_html',
          value: data.description,
          locale,
          translatableContentDigest: descContent.digest,
        });
      }
    }

    if (data.handle) {
      const handleContent = translatableContent.find((c: any) => c.key === 'handle');
      if (handleContent) {
        translations.push({
          key: 'handle',
          value: data.handle,
          locale,
          translatableContentDigest: handleContent.digest,
        });
      }
    }

    if (data.seoTitle) {
      const metaTitleContent = translatableContent.find((c: any) => c.key === 'meta_title');
      if (metaTitleContent) {
        translations.push({
          key: 'meta_title',
          value: data.seoTitle,
          locale,
          translatableContentDigest: metaTitleContent.digest,
        });
      }
    }

    if (data.metaDescription) {
      const metaDescContent = translatableContent.find((c: any) => c.key === 'meta_description');
      if (metaDescContent) {
        translations.push({
          key: 'meta_description',
          value: data.metaDescription,
          locale,
          translatableContentDigest: metaDescContent.digest,
        });
      }
    }

    if (translations.length === 0) {
      throw new Error('No translations to save');
    }

    // Upload translations
    const mutation = `
      mutation translationsRegister($resourceId: ID!, $translations: [TranslationInput!]!) {
        translationsRegister(resourceId: $resourceId, translations: $translations) {
          userErrors {
            message
          }
        }
      }
    `;

    const result = await this.connector.executeMutation(mutation, {
      resourceId: productId,
      translations,
    });

    if (result.translationsRegister.userErrors.length > 0) {
      throw new Error(result.translationsRegister.userErrors[0].message);
    }

    return true;
  }
}
