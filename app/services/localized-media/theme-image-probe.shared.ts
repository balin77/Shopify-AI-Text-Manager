/** Report types of the theme-image probe (client-safe, import-free; the Probes card imports them). */

export interface ImageSample {
  resourceId: string;
  resourceType: string;
  key: string;
  value: string;
}

export interface WriteCheck {
  locale: string;
  marketId: string | null;
  registerEchoed: boolean;
  readBack: boolean;
  removeEchoed: boolean;
  goneAfterRemove: boolean;
  error?: string;
}

export interface ThemeImageProbeReport {
  generatedAt: string;
  shop: string;
  scannedRows: number;
  imageKeysByResourceType: Record<string, number>;
  /** Video choices (a video reference or ANY YouTube/Vimeo link — social links included), counted apart. */
  videoValuesByResourceType: Record<string, number>;
  /** Image samples only: the write check is about `image_picker`, nothing else. */
  samples: ImageSample[];
  /** Up to five video values, to show which SPELLING a shop's video settings use (unmeasured). */
  videoSamples: ImageSample[];
  live: { resourceId: string; key: string; reportedAsTranslatable: boolean; digest: string | null; value: string | null } | null;
  writes: WriteCheck[];
  verdict: string[];
}
