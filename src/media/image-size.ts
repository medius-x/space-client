/**
 * Intrinsic image dimensions measured at upload (the same one-decode the
 * video-preview path already pays): shipped on the wire so the renderer
 * reserves the exact aspect box before the bytes arrive. Any decode failure
 * resolves null — the attachment simply sends without dimensions and the
 * renderer keeps estimating (never blocks the send).
 */
export async function measureImageSize(file: File): Promise<{ width: number; height: number } | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return null;
  }
}
