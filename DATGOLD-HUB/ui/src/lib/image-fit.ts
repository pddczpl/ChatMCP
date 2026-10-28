// A picture that is over the limit of the Hub is made smaller instead of refused. A screenshot of a 4K or a scaled display is often a few MB as a PNG, and the person only pasted it.
// The steps go from the least loss to the most; a picture that fits at none of them is refused, and the message says what the limit is.

/** What the Hub accepts for one picture (lib/agent.mjs, buildUserAttachmentParts: 2 MB) and for any other file (200,000 bytes). */
export const IMAGE_LIMIT_BYTES = 2 * 1024 * 1024;
export const FILE_LIMIT_BYTES = 200_000;

/** A GIF may be animated and a canvas keeps one frame of it, so only these are made smaller. */
const SHRINKABLE = /^image\/(?:png|jpeg|webp)$/;

/** From the least loss to the most. A PNG first, so that the sharp text of a screenshot stays sharp as long as it can. */
export const STEPS = [
  { type: 'image/png', side: 2048 },
  { type: 'image/jpeg', quality: 0.9, side: 2048 },
  { type: 'image/jpeg', quality: 0.8, side: 1600 },
  { type: 'image/jpeg', quality: 0.7, side: 1280 },
  { type: 'image/jpeg', quality: 0.6, side: 1024 },
] as const;

export interface FitTools {
  /** The size of the picture; throws when the browser cannot read it. */
  decode(file: Blob): Promise<{ width: number; height: number }>;
  /** The picture at this size as this type, or null when the browser cannot encode it. */
  encode(file: Blob, width: number, height: number, type: string, quality?: number): Promise<Blob | null>;
}

export interface Fitted {
  blob: Blob;
  type: string;
  width: number;
  height: number;
}

/** The size that fits inside `side` on the longer edge; never larger than the picture, and no edge becomes zero. */
export function fitDimensions(width: number, height: number, side: number): { width: number; height: number } {
  const scale = Math.min(1, side / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** The limit as a person reads it: 2 MB, 200 KB. */
export function limitLabel(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${Math.round(bytes / 1000)} KB`;
}

/** A picture that became a JPEG is named like one; any other name stays. */
export function fittedName(name: string, type: string): string {
  return type === 'image/jpeg' ? `${name.replace(/\.[A-Za-z0-9]{1,5}$/, '')}.jpg` : name;
}

/**
 * The picture made small enough, or null when it cannot be (a GIF, something that is not a picture, or no step fits). Throws when the picture cannot be read.
 * `limit` is in bytes of the picture itself, not of its base64.
 */
export async function fitImage(file: Blob & { type: string }, limit: number = IMAGE_LIMIT_BYTES, tools: FitTools = browserTools): Promise<Fitted | null> {
  if (!SHRINKABLE.test(file.type)) return null;
  const source = await tools.decode(file);
  for (const step of STEPS) {
    const size = fitDimensions(source.width, source.height, step.side);
    const blob = await tools.encode(file, size.width, size.height, step.type, 'quality' in step ? step.quality : undefined);
    if (blob && blob.size <= limit) return { blob, type: step.type, ...size };
  }
  return null;
}

/** The browser's own decoder and canvas (WebView2 and every browser the page runs in have them). Only used in a page. */
const browserTools: FitTools = {
  async decode(file) {
    const bitmap = await createImageBitmap(file);
    try { return { width: bitmap.width, height: bitmap.height }; } finally { bitmap.close(); }
  },
  async encode(file, width, height, type, quality) {
    const bitmap = await createImageBitmap(file, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
    try {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) return null;
      // A JPEG has no transparency: what was transparent would be black.
      if (type === 'image/jpeg') { context.fillStyle = 'white'; context.fillRect(0, 0, width, height); }
      context.drawImage(bitmap, 0, 0, width, height);
      return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
    } finally {
      bitmap.close();
    }
  },
};
