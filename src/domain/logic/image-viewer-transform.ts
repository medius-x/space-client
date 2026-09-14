/**
 * oak's lightbox zoom/pan math (ImageViewerTransform.java), a straight port —
 * pure, unit-tested (the test cases mirror ImageViewerTransformTest).
 *
 * The model: an image of imgW×imgH is shown in a viewport of viewW×viewH.
 * baseScale fits it ONCE (never above 1:1 — a small image is not upscaled);
 * `scale` is the user zoom multiplier OVER base, clamped to [1, MAX]. Offsets
 * are viewport coordinates of the drawn image's top-left corner. An axis
 * smaller than the viewport is PINNED CENTER (pan is a no-op there); a larger
 * one clamps so the image never leaves the viewport.
 */

export const MIN_SCALE = 1;
export const MAX_SCALE = 10;
/** One wheel notch (±40 deltaY on Windows) = one step. */
export const ZOOM_STEP = 1.25;

export interface ViewerTransform {
  baseScale: number;
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface ViewerSize {
  width: number;
  height: number;
}

/** The fitted, centered opening state — also the double-click reset target. */
export function initialTransform(viewport: ViewerSize, imageWidth: number, imageHeight: number): ViewerTransform {
  const baseScale = imageWidth > 0 && imageHeight > 0
    ? Math.min(1, Math.min(viewport.width / imageWidth, viewport.height / imageHeight))
    : 1;
  return {
    baseScale,
    scale: 1,
    offsetX: (viewport.width - imageWidth * baseScale) / 2,
    offsetY: (viewport.height - imageHeight * baseScale) / 2,
  };
}

/** The zoom-TO-THE-CURSOR step: the point under the cursor stays under it. */
export function zoomAt(transform: ViewerTransform, viewport: ViewerSize, imageWidth: number, imageHeight: number, cursorX: number, cursorY: number, deltaY: number): ViewerTransform {
  const factor = deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, transform.scale * factor));
  const ratio = scale / transform.scale;
  return clampTransform({
    ...transform,
    scale,
    offsetX: cursorX - ratio * (cursorX - transform.offsetX),
    offsetY: cursorY - ratio * (cursorY - transform.offsetY),
  }, viewport, imageWidth, imageHeight);
}

/** Drag pan — clamped immediately (an axis that fits is pinned center). */
export function panTransform(transform: ViewerTransform, viewport: ViewerSize, imageWidth: number, imageHeight: number, deltaX: number, deltaY: number): ViewerTransform {
  return clampTransform({
    ...transform,
    offsetX: transform.offsetX + deltaX,
    offsetY: transform.offsetY + deltaY,
  }, viewport, imageWidth, imageHeight);
}

function clampTransform(transform: ViewerTransform, viewport: ViewerSize, imageWidth: number, imageHeight: number): ViewerTransform {
  const clampAxis = (offset: number, drawn: number, view: number): number => {
    if (drawn <= view) {
      return (view - drawn) / 2; // fits — pinned center
    }
    return Math.min(0, Math.max(view - drawn, offset));
  };
  const drawnWidth = imageWidth * transform.baseScale * transform.scale;
  const drawnHeight = imageHeight * transform.baseScale * transform.scale;
  return {
    ...transform,
    offsetX: clampAxis(transform.offsetX, drawnWidth, viewport.width),
    offsetY: clampAxis(transform.offsetY, drawnHeight, viewport.height),
  };
}
