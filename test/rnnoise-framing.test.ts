import { describe, expect, it } from "vitest";
import { RnnoiseFrameBuffer } from "../src/domain/logic/rnnoise-framing";

const QUANTUM = 128;

/** Monotonic counter as sample values — order preservation is then checkable. */
function range(start: number, count: number): Float32Array {
  return Float32Array.from({ length: count }, (_unused, index) => start + index);
}

describe("RnnoiseFrameBuffer", () => {
  it("emits a frame only at exactly 480 raw samples; the remainder waits", () => {
    const buffer = new RnnoiseFrameBuffer();
    buffer.push(range(0, QUANTUM * 3)); // 384 < 480
    expect(buffer.takeFrame()).toBeNull();

    buffer.push(range(384, QUANTUM)); // 512 total
    const frame = buffer.takeFrame();
    expect(frame).not.toBeNull();
    expect(frame!.length).toBe(RnnoiseFrameBuffer.FRAME_SIZE);
    expect(Array.from(frame!)).toEqual(Array.from(range(0, 480)));
    expect(buffer.takeFrame()).toBeNull(); // 32 samples remain — not a frame yet
  });

  it("preserves order across a long uninterrupted stream (constant one-frame lag)", () => {
    const buffer = new RnnoiseFrameBuffer();
    let fed = 0;
    let emitted = 0;
    const produced: number[] = [];
    for (let step = 0; step < 100; step += 1) {
      buffer.push(range(fed, QUANTUM));
      fed += QUANTUM;
      let frame = buffer.takeFrame();
      while (frame !== null) {
        // The model would denoise here; identity keeps the data checkable.
        buffer.pushFrame(frame);
        emitted += frame.length;
        frame = buffer.takeFrame();
      }
      const block = new Float32Array(QUANTUM);
      buffer.takeOutput(block);
      produced.push(...Array.from(block));
    }
    // The priming frame makes the lag a CONSTANT one frame: 480 samples of
    // silence up front, then an exact ordered identity copy with NO mid-stream
    // gaps (480 % 128 = 96 ≠ 0 — without priming the ring runs dry 32 samples
    // per cycle and injects silence into the stream).
    const stableIndex = 2 * RnnoiseFrameBuffer.FRAME_SIZE;
    const lag = stableIndex - produced[stableIndex]!;
    expect(lag).toBe(RnnoiseFrameBuffer.FRAME_SIZE);
    for (let index = 0; index < lag; index += 1) {
      expect(produced[index]).toBe(0);
    }
    for (let index = lag; index < produced.length; index += 1) {
      expect(produced[index]).toBe(index - lag);
    }
    // Conservation: everything fed is either in the output or < one frame short.
    expect(fed - emitted).toBeLessThan(RnnoiseFrameBuffer.FRAME_SIZE);
  });

  it("primes the output with one silent frame — the tail of the 4th block already carries data", () => {
    const buffer = new RnnoiseFrameBuffer();
    // Blocks 1-3 are pure priming silence (384 of 480 samples).
    for (let quantum = 0; quantum < 3; quantum += 1) {
      const block = new Float32Array(QUANTUM);
      buffer.takeOutput(block);
      expect(Array.from(block)).toEqual(Array.from({ length: QUANTUM }, () => 0));
    }
    // A processed frame lands mid-block-4: its first 32 samples ride the tail
    // of that block right after the last 96 samples of priming silence.
    buffer.pushFrame(range(100, 480)); // data: 100..579
    const fourth = new Float32Array(QUANTUM);
    buffer.takeOutput(fourth);
    expect(Array.from(fourth.subarray(0, 96))).toEqual(Array.from({ length: 96 }, () => 0));
    expect(Array.from(fourth.subarray(96))).toEqual(Array.from(range(100, 32)));

    for (let quantum = 0; quantum < 3; quantum += 1) {
      const block = new Float32Array(QUANTUM);
      buffer.takeOutput(block);
      expect(Array.from(block)).toEqual(Array.from(range(132 + quantum * QUANTUM, QUANTUM)));
    }
    // 64 samples of the frame left → 64 data + 64 silence (drained, no gap yet).
    const tail = new Float32Array(QUANTUM);
    buffer.takeOutput(tail);
    expect(Array.from(tail.subarray(0, 64))).toEqual(Array.from(range(516, 64)));
    expect(Array.from(tail.subarray(64))).toEqual(Array.from({ length: 64 }, () => 0));
  });

  it("throws on ring overflow — a caller that never drains breaks loudly", () => {
    const buffer = new RnnoiseFrameBuffer();
    expect(() => {
      // 4× the ring capacity (1920) without a single takeFrame().
      for (let step = 0; step < 16; step += 1) {
        buffer.push(range(step * QUANTUM, QUANTUM));
      }
    }).toThrow(/overflow/);
  });
});
