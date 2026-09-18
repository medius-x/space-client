/**
 * Pure DSP for the share-audio subtraction spike (#483): remove OUR OWN playout
 * from the desktop loopback so screen-share viewers hear the desktop, not the
 * voice chat twice. The signal model is echo cancellation on a DIGITAL path —
 * loopback[n] ≈ h ∗ reference[n − D] where D is the combined render/mix/capture
 * buffering and h is (mostly) a gain — so a bulk-delay estimate plus a short
 * adaptive FIR around it is enough, with periodic re-correlation for drift.
 *
 * The AudioWorklet in media/share-subtraction.ts carries a HAND-SYNCED COPY of
 * this math (worklet modules must be self-contained blob text — the rnnoise-
 * framing precedent). Keep both in sync.
 */

/** In-place radix-2 FFT. Length must be a power of two. */
export function fftInPlace(real: Float64Array, imag: Float64Array): void {
  const length = real.length;
  for (let index = 1, reversed = 0; index < length; index += 1) {
    let bit = length >> 1;
    for (; (reversed & bit) !== 0; bit >>= 1) {
      reversed ^= bit;
    }
    reversed ^= bit;
    if (index < reversed) {
      const swapReal = real[index]!;
      real[index] = real[reversed]!;
      real[reversed] = swapReal;
      const swapImag = imag[index]!;
      imag[index] = imag[reversed]!;
      imag[reversed] = swapImag;
    }
  }
  for (let span = 2; span <= length; span <<= 1) {
    const angle = -2 * Math.PI / span;
    const twiddleReal = Math.cos(angle);
    const twiddleImag = Math.sin(angle);
    const halfSpan = span >> 1;
    for (let base = 0; base < length; base += span) {
      let currentReal = 1;
      let currentImag = 0;
      for (let offset = 0; offset < halfSpan; offset += 1) {
        const evenIndex = base + offset;
        const oddIndex = evenIndex + halfSpan;
        const oddReal = real[oddIndex]!;
        const oddImag = imag[oddIndex]!;
        const productReal = oddReal * currentReal - oddImag * currentImag;
        const productImag = oddReal * currentImag + oddImag * currentReal;
        real[oddIndex] = real[evenIndex]! - productReal;
        imag[oddIndex] = imag[evenIndex]! - productImag;
        real[evenIndex] = real[evenIndex]! + productReal;
        imag[evenIndex] = imag[evenIndex]! + productImag;
        const nextReal = currentReal * twiddleReal - currentImag * twiddleImag;
        currentImag = currentReal * twiddleImag + currentImag * twiddleReal;
        currentReal = nextReal;
      }
    }
  }
}

/** In-place inverse FFT (conjugate trick). */
export function ifftInPlace(real: Float64Array, imag: Float64Array): void {
  for (let index = 0; index < real.length; index += 1) {
    imag[index] = -imag[index]!;
  }
  fftInPlace(real, imag);
  const scale = 1 / real.length;
  for (let index = 0; index < real.length; index += 1) {
    real[index] = real[index]! * scale;
    imag[index] = -imag[index]! * scale;
  }
}

export interface CorrelationPeak {
  /** signal[n] ≈ g · reference[n − lag]; positive = signal LAGS the reference. */
  lag: number;
  /** Peak normalized to (0, 1] — ~1 for a clean scaled copy, ≈0 for unrelated. */
  quality: number;
}

function nextPowerOfTwo(value: number): number {
  let result = 1;
  while (result < value) {
    result <<= 1;
  }
  return result;
}

/**
 * FFT cross-correlation peak of `signal` against `reference`, searched within
 * [minLag, maxLag] samples (positive lag = the signal trails the reference).
 * Buffers are zero-padded to a power of two, so the circular correlation is
 * linear over the searched range.
 */
export function crossCorrelationPeak(signal: Float32Array, reference: Float32Array, minLag: number, maxLag: number): CorrelationPeak {
  const fftLength = nextPowerOfTwo(signal.length + reference.length);
  const signalReal = new Float64Array(fftLength);
  const signalImag = new Float64Array(fftLength);
  const referenceReal = new Float64Array(fftLength);
  const referenceImag = new Float64Array(fftLength);
  let signalEnergy = 0;
  let referenceEnergy = 0;
  for (let index = 0; index < signal.length; index += 1) {
    signalReal[index] = signal[index]!;
    signalEnergy += signal[index]! * signal[index]!;
  }
  for (let index = 0; index < reference.length; index += 1) {
    referenceReal[index] = reference[index]!;
    referenceEnergy += reference[index]! * reference[index]!;
  }
  const normalizer = Math.sqrt(signalEnergy * referenceEnergy);
  if (normalizer <= 0) {
    return { lag: 0, quality: 0 };
  }
  fftInPlace(signalReal, signalImag);
  fftInPlace(referenceReal, referenceImag);
  for (let bin = 0; bin < fftLength; bin += 1) {
    // spectrum × conj(referenceSpectrum) — correlation, not convolution
    const productReal = signalReal[bin]! * referenceReal[bin]! + signalImag[bin]! * referenceImag[bin]!;
    const productImag = signalImag[bin]! * referenceReal[bin]! - signalReal[bin]! * referenceImag[bin]!;
    signalReal[bin] = productReal;
    signalImag[bin] = productImag;
  }
  ifftInPlace(signalReal, signalImag);
  let bestLag = 0;
  let bestValue = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    const value = signalReal[lag]!;
    if (value > bestValue) {
      bestValue = value;
      bestLag = lag;
    }
    const wrapped = fftLength - lag;
    const wrappedValue = signalReal[wrapped]!;
    if (wrappedValue > bestValue) {
      bestValue = wrappedValue;
      bestLag = -lag;
    }
  }
  return { lag: bestLag, quality: bestValue / normalizer };
}

export interface CancellerOptions {
  /** Adaptive FIR length; the bulk-delay estimate centers it (default 1024 ≈ ±10.7 ms @ 48 k). */
  taps?: number;
  /** Maximum bulk delay the ring can hold, samples (default 16384 ≈ 341 ms @ 48 k). */
  maxDelay?: number;
  /** NLMS step size (default 0.3 — fast convergence on a static digital path). */
  stepSize?: number;
  /** Adapt every Nth sample — decimation halves the cost with slow convergence cost (default 2). */
  adaptEvery?: number;
}

/** Reference-silence floor: below this EMA power the filter stops adapting. */
const REFERENCE_ACTIVE_POWER = 1e-7;
const POWER_DECAY = 0.999;
const REGULARIZATION = 1e-9;

export interface SquareSumChannel {
  loopbackSquareSum: number;
  residualSquareSum: number;
  sampleCount: number;
}

/** Suppression over a stats window in dB; null when no signal reached the loopback. */
export function suppressionDbPure(channels: readonly SquareSumChannel[]): number | null {
  let loopbackSquare = 0;
  let residualSquare = 0;
  let samples = 0;
  for (const channel of channels) {
    loopbackSquare += channel.loopbackSquareSum;
    residualSquare += channel.residualSquareSum;
    samples += channel.sampleCount;
  }
  if (samples === 0 || loopbackSquare <= 1e-12) {
    return null;
  }
  if (residualSquare <= 1e-12) {
    return 60; // residual is digital zero — report the cap
  }
  return 10 * Math.log10(loopbackSquare / residualSquare);
}

/**
 * One channel of the subtractor: y = h ∗ (reference delayed by `delay`), the
 * residual e = loopback − y is both the output and the NLMS error signal. The
 * delay is passed per block (the caller re-centers it from periodic
 * correlation); until enough reference history exists the block passes through.
 */
export class ReferenceCanceller {
  private readonly ring: Float32Array;
  private readonly ringMask: number;
  private readonly taps: Float64Array;
  private readonly tapsLength: number;
  private readonly half: number;
  private readonly stepSize: number;
  private readonly adaptEvery: number;
  private ringPosition = 0; // next write slot
  private written = 0; // total reference samples pushed
  private power = 1e-9; // EMA of instantaneous reference power
  private silentFor = 0; // consecutive near-zero reference samples

  constructor(options: CancellerOptions = {}) {
    this.tapsLength = options.taps ?? 1024;
    const maxDelay = options.maxDelay ?? 16384;
    this.half = this.tapsLength >> 1;
    this.stepSize = options.stepSize ?? 0.3;
    this.adaptEvery = options.adaptEvery ?? 2;
    const ringLength = nextPowerOfTwo(maxDelay + this.tapsLength + 256);
    this.ring = new Float32Array(ringLength);
    this.ringMask = ringLength - 1;
    this.taps = new Float64Array(this.tapsLength);
  }

  isReferenceActive(): boolean {
    return this.power > REFERENCE_ACTIVE_POWER;
  }

  /** Returns false while the ring is too short for this delay (passthrough). */
  processBlock(loopback: Float32Array, reference: Float32Array, delay: number, residual: Float32Array): boolean {
    const blockLength = Math.min(loopback.length, reference.length, residual.length);
    let filteredAny = false;
    for (let sampleIndex = 0; sampleIndex < blockLength; sampleIndex += 1) {
      const referenceSample = reference[sampleIndex]!;
      this.ring[this.ringPosition] = referenceSample;
      this.ringPosition = (this.ringPosition + 1) & this.ringMask;
      this.power = this.power * POWER_DECAY + referenceSample * referenceSample * (1 - POWER_DECAY);
      // Silence gate (mirrored in the worklet): a window the reference has been
      // quiet past is provably zeros — skip the filter loops, pass through.
      if (Math.abs(referenceSample) < 1e-6) {
        this.silentFor += 1;
      } else {
        this.silentFor = 0;
      }
      const absolute = this.written + sampleIndex;
      const windowStart = absolute - delay - this.half;
      if (windowStart < 0 || delay < this.half || this.silentFor > delay + this.half) {
        residual[sampleIndex] = loopback[sampleIndex]!;
        continue;
      }
      filteredAny = true;
      let estimate = 0;
      for (let tapIndex = 0; tapIndex < this.tapsLength; tapIndex += 1) {
        estimate += this.taps[tapIndex]! * this.ring[(windowStart + tapIndex) & this.ringMask]!;
      }
      const error = loopback[sampleIndex]! - estimate;
      residual[sampleIndex] = error;
      if (this.isReferenceActive() && sampleIndex % this.adaptEvery === 0) {
        // TRUE window energy, NOT the lagging EMA: at a hard onset (silence →
        // full-level signal) the EMA trails by ~ms and the EMA-based norm
        // explodes the taps (live divergence: residual 38 dB HOTTER than the
        // loopback, then NaN). The EMA stays as the activity gate only.
        let windowEnergy = 0;
        for (let tapIndex = 0; tapIndex < this.tapsLength; tapIndex += 1) {
          const windowSample = this.ring[(windowStart + tapIndex) & this.ringMask]!;
          windowEnergy += windowSample * windowSample;
        }
        const norm = this.stepSize / (windowEnergy + REGULARIZATION);
        for (let tapIndex = 0; tapIndex < this.tapsLength; tapIndex += 1) {
          this.taps[tapIndex] = this.taps[tapIndex]! + norm * error * this.ring[(windowStart + tapIndex) & this.ringMask]!;
        }
      }
    }
    this.written += blockLength;
    return filteredAny;
  }

  /** Cold-start reset (e.g. after a large delay re-centering). */
  reset(): void {
    this.taps.fill(0);
    this.power = 1e-9;
  }
}
