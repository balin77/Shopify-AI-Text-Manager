import sharp from "sharp";

export async function downloadImageAsBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download image: ${response.status} ${url}`);
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function convertToWebP(
  sourceBuffer: Buffer,
  quality = 85
): Promise<{ buffer: Buffer; filename: string }> {
  const buffer = await sharp(sourceBuffer)
    .webp({ quality })
    .toBuffer();
  return { buffer, filename: `converted-${Date.now()}.webp` };
}

export async function getImageMetadata(buffer: Buffer) {
  return sharp(buffer).metadata();
}

export function isWebP(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.includes(".webp") || lower.includes("format=webp");
}
