import { describe, expect, it } from "vitest";
import {
  MAX_SCALE,
  MIN_SCALE,
  ZOOM_STEP,
  initialTransform,
  panTransform,
  zoomAt,
} from "../src/domain/logic/image-viewer-transform";

// The test cases mirror oak's ImageViewerTransformTest.

describe("initialTransform", () => {
  it("fits a large image exactly (no letterbox, no upscale)", () => {
    // 3000×2000 in 900×600 → base 0.3, drawn 900×600, offsets 0.
    const state = initialTransform({ width: 900, height: 600 }, 3000, 2000);
    expect(state.baseScale).toBeCloseTo(0.3, 10);
    expect(state.scale).toBe(1);
    expect(state.offsetX).toBe(0);
    expect(state.offsetY).toBe(0);
  });

  it("centers a small image at 1:1 — never upscales", () => {
    const state = initialTransform({ width: 900, height: 600 }, 64, 64);
    expect(state.baseScale).toBe(1);
    expect(state.offsetX).toBeCloseTo((900 - 64) / 2, 10);
    expect(state.offsetY).toBeCloseTo((600 - 64) / 2, 10);
  });
});

describe("zoomAt", () => {
  it("clamps the scale to [MIN, MAX]", () => {
    const viewport = { width: 900, height: 600 };
    let state = initialTransform(viewport, 3000, 2000);
    state = zoomAt(state, viewport, 3000, 2000, 450, 300, -40);
    expect(state.scale).toBeCloseTo(ZOOM_STEP, 10);
    // zoomed in 8 times over → clamped at MAX_SCALE
    for (let stepIndex = 0; stepIndex < 10; stepIndex += 1) {
      state = zoomAt(state, viewport, 3000, 2000, 450, 300, -40);
    }
    expect(state.scale).toBe(MAX_SCALE);
    // zoomed out from 1 → clamped at MIN_SCALE
    let out = initialTransform(viewport, 3000, 2000);
    out = zoomAt(out, viewport, 3000, 2000, 450, 300, 40);
    expect(out.scale).toBe(MIN_SCALE);
  });

  it("keeps the point under the cursor under the cursor", () => {
    const viewport = { width: 900, height: 600 };
    const state = initialTransform(viewport, 3000, 2000);
    // At fit the image fills the viewport; the cursor point is (450, 300).
    const zoomed = zoomAt(state, viewport, 3000, 2000, 450, 300, -40);
    const ratio = zoomed.scale / state.scale;
    expect(zoomed.offsetX).toBeCloseTo(450 - ratio * (450 - state.offsetX), 10);
    expect(zoomed.offsetY).toBeCloseTo(300 - ratio * (300 - state.offsetY), 10);
  });
});

describe("panTransform", () => {
  it("is a no-op while the image fits (pinned center)", () => {
    const viewport = { width: 900, height: 600 };
    const state = initialTransform(viewport, 64, 64);
    const panned = panTransform(state, viewport, 64, 64, 500, 500);
    expect(panned.offsetX).toBeCloseTo(state.offsetX, 10);
    expect(panned.offsetY).toBeCloseTo(state.offsetY, 10);
  });

  it("clamps beyond the edges when zoomed", () => {
    const viewport = { width: 900, height: 600 };
    let state = initialTransform(viewport, 3000, 2000);
    state = { ...state, scale: 4 }; // drawn 3600×2400 — larger than the viewport
    // Dragging right/down past the image's top-left edge reveals nothing (offset pins at 0).
    const rightDown = panTransform(state, viewport, 3000, 2000, 10_000, 10_000);
    expect(rightDown.offsetX).toBe(0);
    expect(rightDown.offsetY).toBe(0);
    // Dragging left/up past the image's far edge pins at viewport − drawn.
    const leftUp = panTransform(state, viewport, 3000, 2000, -10_000, -10_000);
    expect(leftUp.offsetX).toBe(viewport.width - 3000 * state.baseScale * state.scale);
    expect(leftUp.offsetY).toBe(viewport.height - 2000 * state.baseScale * state.scale);
  });
});
