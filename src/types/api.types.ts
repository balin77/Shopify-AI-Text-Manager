// API Response Types
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface ProductsResponse {
  success: boolean;
  products: Array<{
    id: string;
    title: string;
    handle: string;
    productType: string;
    tags: string[];
  }>;
}

export interface ProductDetailResponse {
  success: boolean;
  product: any;
  translations: Record<string, any>;
}

export interface TranslationResponse {
  success: boolean;
  translations: Record<string, any>;
  results: Record<string, boolean>;
}
