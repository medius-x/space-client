import { describe, expect, it } from "vitest";
import { crossCorrelationPeak, fftInPlace, ifftInPlace, ReferenceCanceller } from "../src/domain/logic/subtract-dsp";

/** Deterministic LCG noise — the same family the self-tests play through speakers. */
function lcgNoise(count: number, seedValue: number, amplitude: number): Float32Array {
  const samples = new Float32Array(count);
  let seed = seedValue >>> 0;
  for (let index = 0; index < count; index += 1) {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
    samples[index] = (seed / 0xffff_ffff - 0.5) * 2 * amplitude;
  }
  return samples;
}

describe("fftInPlace / ifftInPlace", () => {
  it("matches a naive DFT on a mixed-tone signal", () => {
    const length = 64;
    const real = new Float64Array(length);
    const imag = new Float64Array(length);
    for (let index = 0; index < length; index += 1) {
      real[index] = Math.sin((2 * Math.PI * 5 * index) / length) + 0.5 * Math.cos((2 * Math.PI * 13 * index) / length);
    }
    fftInPlace(real, imag);
    // Naive DFT for comparison (kept simple: recompute per bin).
    const naiveReal = new Float64Array(length);
    const naiveImag = new Float64Array(length);
    for (let bin = 0; bin < length; bin += 1) {
      for (let index = 0; index < length; index += 1) {
        const angle = (-2 * Math.PI * bin * index) / length;
        const sample = Math.sin((2 * Math.PI * 5 * index) / length) + 0.5 * Math.cos((2 * Math.PI * 13 * index) / length);
        naiveReal[bin] = (naiveReal[bin] ?? 0) + sample * Math.cos(angle);
        naiveImag[bin] = (naiveImag[bin] ?? 0) + sample * Math.sin(angle);
      }
    }
    for (let bin = 0; bin < length; bin += 1) {
      expect(real[bin]).toBeCloseTo(naiveReal[bin]!, 6);
      expect(imag[bin]).toBeCloseTo(naiveImag[bin]!, 6);
    }
  });

  it("round-trips through the inverse", () => {
    const length = 128;
    const real = new Float64Array(length);
    const imag = new Float64Array(length);
    const source = lcgNoise(length, 42, 0.25);
    real.set(source);
    const realCopy = Float64Array.from(real);
    const imagCopy = Float64Array.from(imag);
    fftInPlace(real, imag);
    ifftInPlace(real, imag);
    for (let index = 0; index < length; index += 1) {
      expect(real[index]).toBeCloseTo(realCopy[index]!, 8);
      expect(imag[index]).toBeCloseTo(imagCopy[index]!, 8);
    }
  });
});

describe("crossCorrelationPeak", () => {
  it("finds the lag of a delayed, scaled copy", () => {
    const reference = lcgNoise(8192, 7, 0.25);
    const delay = 700;
    const gain = 0.6;
    const signal = new Float32Array(reference.length);
    for (let index = delay; index < signal.length; index += 1) {
      signal[index] = reference[index - delay]! * gain;
    }
    const peak = crossCorrelationPeak(signal, reference, 0, 4000);
    expect(Math.abs(peak.lag - delay)).toBeLessThanOrEqual(2);
    expect(peak.quality).toBeGreaterThan(0.9);
  });

  it("reports near-zero quality for unrelated signals", () => {
    const signal = lcgNoise(8192, 1, 0.25);
    const reference = lcgNoise(8192, 2, 0.25);
    const peak = crossCorrelationPeak(signal, reference, 0, 4000);
    expect(Math.abs(peak.quality)).toBeLessThan(0.1);
  });

  it("finds the peak inside a restricted lag window", () => {
    const reference = lcgNoise(8192, 7, 0.25);
    const delay = 700;
    const signal = new Float32Array(reference.length);
    for (let index = delay; index < signal.length; index += 1) {
      signal[index] = reference[index - delay]!;
    }
    // A strong copy also exists at other offsets if we search wide; restrict to
    // ±100 around the truth and the answer must stay the true lag.
    const peak = crossCorrelationPeak(signal, reference, delay - 100, delay + 100);
    expect(peak.lag).toBe(delay);
  });
});

describe("ReferenceCanceller", () => {
  it("converges on a delayed, gained digital path", () => {
    const delay = 200;
    const gain = 0.6;
    const blockLength = 128;
    const totalSamples = 60_000;
    const canceller = new ReferenceCanceller({ taps: 256, maxDelay: 2048, stepSize: 0.3, adaptEvery: 1 });
    const reference = lcgNoise(totalSamples, 99, 0.25);
    const loopback = new Float32Array(totalSamples);
    for (let index = delay; index < totalSamples; index += 1) {
      loopback[index] = reference[index - delay]! * gain;
    }
    let loopbackSquare = 0;
    let residualSquare = 0;
    const residual = new Float32Array(blockLength);
    for (let offset = 0; offset + blockLength <= totalSamples; offset += blockLength) {
      canceller.processBlock(
        loopback.subarray(offset, offset + blockLength),
        reference.subarray(offset, offset + blockLength),
        delay,
        residual,
      );
      // Measure only the tail — the head is convergence.
      if (offset >= totalSamples / 2) {
        for (let index = 0; index < blockLength; index += 1) {
          loopbackSquare += loopback[offset + index]! * loopback[offset + index]!;
          residualSquare += residual[index]! * residual[index]!;
        }
      }
    }
    const suppressionDb = 10 * Math.log10(loopbackSquare / Math.max(residualSquare, 1e-20));
    expect(suppressionDb).toBeGreaterThan(30);
  });

  it("survives a hard onset after silence without diverging", () => {
    // The live 2026-09-18 failure: phases start from silence, and an EMA-based
    // NLMS normalizer lags the onset by ~ms — the step explodes and the taps
    // blow up (residual HOTTER than the loopback, then NaN). The true window
    // energy must keep the step bounded at the very first loud samples.
    const delay = 200;
    const gain = 0.6;
    const blockLength = 128;
    const silenceSamples = 20_000;
    const totalSamples = 80_000;
    const canceller = new ReferenceCanceller({ taps: 256, maxDelay: 2048, stepSize: 0.3, adaptEvery: 1 });
    const reference = new Float32Array(totalSamples);
    const noise = lcgNoise(totalSamples - silenceSamples, 123, 0.25);
    reference.set(noise, silenceSamples);
    const loopback = new Float32Array(totalSamples);
    for (let index = delay; index < totalSamples; index += 1) {
      loopback[index] = reference[index - delay]! * gain;
    }
    let loopbackSquare = 0;
    let residualSquare = 0;
    const residual = new Float32Array(blockLength);
    for (let offset = 0; offset + blockLength <= totalSamples; offset += blockLength) {
      canceller.processBlock(
        loopback.subarray(offset, offset + blockLength),
        reference.subarray(offset, offset + blockLength),
        delay,
        residual,
      );
      if (offset >= totalSamples / 2) {
        for (let index = 0; index < blockLength; index += 1) {
          loopbackSquare += loopback[offset + index]! * loopback[offset + index]!;
          residualSquare += residual[index]! * residual[index]!;
        }
      }
    }
    expect(Number.isFinite(residualSquare)).toBe(true);
    const suppressionDb = 10 * Math.log10(loopbackSquare / Math.max(residualSquare, 1e-20));
    expect(suppressionDb).toBeGreaterThan(30);
  });

  it("passes through (not filters) once the reference has gone silent past the window", () => {
    // The CPU hot path is skipped in long silence — but the OUTPUT must be
    // identical to filtering through the now-zero window: a plain copy.
    const delay = 200;
    const blockLength = 128;
    const canceller = new ReferenceCanceller({ taps: 64, maxDelay: 1024 });
    const noise = lcgNoise(20_000, 77, 0.25);
    const residual = new Float32Array(blockLength);
    const silence = new Float32Array(blockLength);
    const loopbackNoise = new Float32Array(blockLength);
    for (let index = 0; index < blockLength; index += 1) {
      loopbackNoise[index] = 0.05; // any leftover loopback content
    }
    // Prime the filter with signal, then go silent past delay + half.
    for (let offset = 0; offset + blockLength <= 20_000; offset += blockLength) {
      canceller.processBlock(
        noise.subarray(offset, offset + blockLength),
        noise.subarray(offset, offset + blockLength),
        delay,
        residual,
      );
    }
    for (let repeat = 0; repeat < 40; repeat += 1) {
      canceller.processBlock(loopbackNoise, silence, delay, residual);
    }
    for (let index = 0; index < blockLength; index += 1) {
      expect(residual[index]).toBe(loopbackNoise[index]);
    }
  });

  it("passes through while the reference history is too short", () => {
    const canceller = new ReferenceCanceller({ taps: 64, maxDelay: 1024 });
    const block = lcgNoise(128, 5, 0.25);
    const residual = new Float32Array(128);
    const filtered = canceller.processBlock(block, block, 500, residual);
    expect(filtered).toBe(false);
    for (let index = 0; index < 128; index += 1) {
      expect(residual[index]).toBe(block[index]);
    }
  });
});
