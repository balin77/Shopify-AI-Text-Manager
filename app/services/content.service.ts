import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import {
  GET_SHOP_LOCALES,
  GET_BLOGS,
  GET_COLLECTIONS,
  GET_PAGES
} from "../graphql/content.queries";

export class ContentService {
  constructor(private admin: AdminApiContext) {}

  async getShopLocales() {
    const response = await this.admin.graphql(GET_SHOP_LOCALES);
    const data = await response.json();
    return data.data.shopLocales;
  }

  async getBlogs(first: number = 50) {
    const response = await this.admin.graphql(GET_BLOGS, {
      variables: { first }
    });
    const data = await response.json();

    console.log('=== BLOGS API RESPONSE ===');
    console.log('Raw blogs data:', JSON.stringify(data, null, 2));
    console.log('Number of blogs:', data.data?.blogs?.edges?.length || 0);

    const blogs = data.data.blogs.edges.map((edge: any) => ({
      ...edge.node,
      articles: edge.node.articles.edges.map((a: any) => ({
        ...a.node,
        translations: []
      }))
    }));

    console.log('Processed blogs:', blogs.length);
    return blogs;
  }

  async getCollections(first: number = 50) {
    const response = await this.admin.graphql(GET_COLLECTIONS, {
      variables: { first }
    });
    const data = await response.json();

    console.log('=== COLLECTIONS API RESPONSE ===');
    console.log('Raw collections data:', JSON.stringify(data, null, 2));
    console.log('Number of collections:', data.data?.collections?.edges?.length || 0);

    const collections = data.data.collections.edges.map((edge: any) => ({
      ...edge.node,
      translations: []
    }));

    console.log('Processed collections:', collections.length);
    return collections;
  }

  async getPages(first: number = 50) {
    const response = await this.admin.graphql(GET_PAGES, {
      variables: { first }
    });
    const data = await response.json();

    console.log('=== PAGES API RESPONSE ===');
    console.log('Raw pages data:', JSON.stringify(data, null, 2));
    console.log('Number of pages:', data.data?.pages?.edges?.length || 0);

    const pages = data.data.pages.edges.map((edge: any) => ({
      ...edge.node,
      translations: []
    }));

    console.log('Processed pages:', pages.length);
    return pages;
  }

  async getAllContent() {
    const [shopLocales, blogs, collections, pages] = await Promise.all([
      this.getShopLocales(),
      this.getBlogs(),
      this.getCollections(),
      this.getPages()
    ]);

    const primaryLocale = shopLocales.find((l: any) => l.primary)?.locale || "de";

    return {
      shopLocales,
      blogs,
      collections,
      pages,
      primaryLocale
    };
  }
}
