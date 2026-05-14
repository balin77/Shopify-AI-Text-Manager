import sharp from "sharp";

export async function downloadImageAsBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download image: ${response.status} ${url}`);
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function convertToWebP(
  sourceBuffer: Buffer,
  originalUrl?: string,
  quality = 85
): Promise<{ buffer: Buffer; filename: string }> {
  const buffer = await sharp(sourceBuffer)
    .webp({ quality })
    .toBuffer();
  let filename = `converted-${Date.now()}.webp`;
  if (originalUrl) {
    try {
      const base = new URL(originalUrl).pathname.split("/").pop()!.replace(/\.[^.]+$/, "");
      if (base) filename = `${base}.webp`;
    } catch {}
  }
  return { buffer, filename };
}

export async function getImageMetadata(buffer: Buffer) {
  return sharp(buffer).metadata();
}

export function isWebP(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.includes(".webp") || lower.includes("format=webp");
}
