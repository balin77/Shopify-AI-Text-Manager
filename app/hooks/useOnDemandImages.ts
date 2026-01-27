/**
 * Hook for on-demand loading of product images from Shopify
 *
 * Since only the first image is cached in DB, this hook loads
 * all images from Shopify when a product is selected.
 */

import { useState, useEffect, useCallback } from "react";
import { useFetcher } from "@remix-run/react";

interface ImageData {
  url: string;
  altText: string | null;
  mediaId: string;
  position: number;
  width?: number;
  height?: number;
}

interface UseOnDemandImagesProps {
  productId: string | null;
  cachedFirstImage?: {
    url: string;
    altText?: string | null;
  } | null;
}

interface UseOnDemandImagesReturn {
  images: ImageData[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useOnDemandImages({
  productId,
  cachedFirstImage,
}: UseOnDemandImagesProps): UseOnDemandImagesReturn {
  const [images, setImages] = useState<ImageData[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetcher = useFetcher<{ success: boolean; images: ImageData[]; error?: string }>();

  // Load images when product changes
  useEffect(() => {
    if (!productId) {
      setImages([]);
      setError(null);
      return;
    }

    // Start loading
    setIsLoading(true);
    setError(null);

    // Fetch images from Shopify via API
    fetcher.load(`/api/product-images?productId=${encodeURIComponent(productId)}`);
  }, [productId]);

  // Handle fetcher response
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      setIsLoading(false);

      if (fetcher.data.success && fetcher.data.images) {
        setImages(fetcher.data.images);
      } else if (fetcher.data.error) {
        setError(fetcher.data.error);
        // Fall back to cached first image if available
        if (cachedFirstImage) {
          setImages([{
            url: cachedFirstImage.url,
            altText: cachedFirstImage.altText || null,
            mediaId: "",
            position: 0,
          }]);
        }
      }
    }
  }, [fetcher.state, fetcher.data, cachedFirstImage]);

  // Manual refetch function
  const refetch = useCallback(() => {
    if (productId) {
      setIsLoading(true);
      setError(null);
      fetcher.load(`/api/product-images?productId=${encodeURIComponent(productId)}`);
    }
  }, [productId, fetcher]);

  return {
    images,
    isLoading,
    error,
    refetch,
  };
}
