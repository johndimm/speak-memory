import sharp from "sharp";

export const IMAGE_MAX_PX = 1200;
export const IMAGE_JPEG_QUALITY = 82;

export async function compressImage(buffer) {
  return sharp(buffer)
    .rotate()
    .resize(IMAGE_MAX_PX, IMAGE_MAX_PX, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: IMAGE_JPEG_QUALITY, mozjpeg: true })
    .toBuffer();
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
