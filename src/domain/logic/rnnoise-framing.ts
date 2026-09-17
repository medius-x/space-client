/**
 * Pure framing logic for the RNNoise AudioWorklet bridge. The worklet receives
 * 128-sample render quanta and must feed RNNoise exact 480-sample frames
 * (10 ms @ 48 kHz — the model's fixed cadence); processed frames come back and
 * are re-emitted as 128-sample blocks. Two FIFOs of plain floats:
 *
 *   raw in ──push()──▶ [input ring] ──takeFrame()──▶ RNNoise ──pushFrame()──▶ [output ring] ──takeOutput()──▶ worklet out
 *
 * The worklet keeps this class's semantics verbatim (a worklet module cannot
 * import app code), so the contract is pinned here by tests: frame exactness,
 * order preservation, and zero-padding of a starved output (a stream's first
 * frame — the model runs one frame behind by design).
 */
export class RnnoiseFrameBuffer {
  /** RNNoise's fixed frame size in samples (10 ms @ 48 kHz). */
  static readonly FRAME_SIZE = 480;

  private readonly input: Float32Array;
  private readonly output: Float32Array;
  private inputLength = 0;
  private outputLength = 0;

  constructor() {
    // Headroom for several quanta without a frame drain (the worklet drains on
    // every process() callback, so a few frames of slack is all that is needed).
    this.input = new Float32Array(RnnoiseFrameBuffer.FRAME_SIZE * 4);
    this.output = new Float32Array(RnnoiseFrameBuffer.FRAME_SIZE * 4);
    // CRITICAL priming: 480 does not divide by the 128-sample quantum, so a
    // frame arrives only every ~3.75 quanta while the worklet consumes 128 every
    // callback — without a silent prefix the output ring would run 32 samples
    // dry once per cycle and inject mid-stream silence gaps (a soft crackle).
    // One priming frame of silence makes the lag a CONSTANT one frame instead.
    this.output.fill(0, 0, RnnoiseFrameBuffer.FRAME_SIZE);
    this.outputLength = RnnoiseFrameBuffer.FRAME_SIZE;
  }

  /** A 128-sample render quantum of RAW mic audio enters the pipeline. */
  push(block: Float32Array): void {
    this.write(this.input, block);
    this.inputLength += block.length;
  }

  /** The next complete RAW frame for the model, or null while short of 480. */
  takeFrame(): Float32Array | null {
    if (this.inputLength < RnnoiseFrameBuffer.FRAME_SIZE) {
      return null;
    }
    const frame = this.input.slice(0, RnnoiseFrameBuffer.FRAME_SIZE);
    this.input.copyWithin(0, RnnoiseFrameBuffer.FRAME_SIZE, this.inputLength);
    this.inputLength -= RnnoiseFrameBuffer.FRAME_SIZE;
    return frame;
  }

  /** A PROCESSED 480-sample frame comes back from the model. */
  pushFrame(frame: Float32Array): void {
    this.write(this.output, frame);
    this.outputLength += frame.length;
  }

  /** Fill one 128-sample output block; a starved tail renders as silence. */
  takeOutput(block: Float32Array): void {
    const copied = Math.min(block.length, this.outputLength);
    block.set(this.output.subarray(0, copied));
    if (copied < block.length) {
      block.fill(0, copied);
    }
    this.output.copyWithin(0, copied, this.outputLength);
    this.outputLength -= copied;
  }

  /** Samples of processed audio still waiting (diagnostics / overflow checks). */
  get pending(): number {
    return this.outputLength;
  }

  private write(ring: Float32Array, samples: Float32Array): void {
    const length = ring === this.input ? this.inputLength : this.outputLength;
    const overflow = length + samples.length - ring.length;
    if (overflow > 0) {
      throw new Error(`rnnoise ring overflow by ${overflow} samples — drain the frames`);
    }
    ring.set(samples, length);
  }
}
