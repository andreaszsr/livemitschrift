import { MAX_IMAGE_BYTES, MAX_IMAGE_SIDE } from '@livemitschrift/core';

export interface PreparedImage { bytes: Uint8Array; width: number; height: number }

/** Image files the editor accepts; HEIC works only where WebKit can decode it. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic', 'image/heif'];

/**
 * Decode, downscale to at most MAX_IMAGE_SIDE pixels and re-encode an image.
 * Re-encoding normalizes the format to PNG (when the image has transparency)
 * or JPEG and drops all metadata such as EXIF camera data and GPS positions.
 * EXIF orientation is applied while decoding.
 */
export async function prepareImage(source: Blob): Promise<PreparedImage> {
    let bitmap: ImageBitmap;
    try {
        bitmap = await createImageBitmap(source, {imageOrientation: 'from-image'});
    } catch {
        throw new Error('Das Bild kann nicht gelesen werden. Bitte als PNG oder JPEG speichern und erneut einfügen.');
    }
    try {
        const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
        const width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const context = canvas.getContext('2d', {willReadFrequently: true});
        if (!context) throw new Error('Das Bild kann nicht verarbeitet werden.');
        context.drawImage(bitmap, 0, 0, width, height);
        // JPEG has no alpha channel; keep PNG only where transparency is visible.
        const transparent = source.type !== 'image/jpeg' && hasTransparency(context.getImageData(0, 0, width, height).data);
        let blob = await encode(canvas, transparent ? 'image/png' : 'image/jpeg');
        if (blob.size > MAX_IMAGE_BYTES && transparent) blob = await encode(canvas, 'image/jpeg');
        if (blob.size > MAX_IMAGE_BYTES) throw new Error('Das Bild ist auch nach dem Verkleinern größer als 10 MB.');
        return {bytes: new Uint8Array(await blob.arrayBuffer()), width, height};
    } finally {
        bitmap.close();
    }
}

function hasTransparency(pixels: Uint8ClampedArray): boolean {
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index]! < 255) return true;
    return false;
}

function encode(canvas: HTMLCanvasElement, type: 'image/png' | 'image/jpeg'): Promise<Blob> {
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Das Bild kann nicht gespeichert werden.')), type, 0.85));
}

/** The first image file of a paste or drop, if any. */
export function imageFile(data: DataTransfer | null): File | null {
    for (const file of data?.files ?? []) if (file.type.startsWith('image/')) return file;
    for (const item of data?.items ?? []) if (item.kind === 'file' && item.type.startsWith('image/')) return item.getAsFile();
    return null;
}
