import { log } from "../logging";
import { suppressionDbPure } from "../domain/logic/subtract-dsp";

/**
 * Share-audio subtraction (#483): remove OUR OWN playout from the desktop loopback
 * before it is published with a screen share. Our client plays through TWO
 * pipeline domains with DIFFERENT latencies — remote tracks via <audio> ELEMENTS
 * (the media-player path, ~200 ms) and UI sounds via the NotificationHub
 * AudioContext (~80 ms). One canceller cannot serve both (the live smoke: the
 * tracker locked whichever domain spoke first and the other leaked through —
 * the viewer heard mute cues), so the worklet is a CASCADE of two independent
 * domains: elements → contexts, each with its own delay tracker, taps and
 * failure detector; a domain with no reference passes through automatically.
 * A domain never ADAPTS before its tracker locks (the pre-lock garbage window
 * measured residual 44 dB HOTTER than the loopback).
 *
 * Pure mirrors: domain/logic/subtract-dsp.ts (FFT, correlation, canceller) and
 * domain/logic/share-recenter.ts (the stability-first recenter policy).
 */

// The worklet source is plain JS (NO interpolation on purpose — the DFN3
// template-brace lesson). The DSP bodies are hand-synced copies of
// domain/logic/subtract-dsp.ts (fft/ifft/correlation/canceller) and
// domain/logic/share-recenter.ts (the recenter policy). KEEP IN SYNC.
const SUBTRACT_PROCESSOR_SOURCE = `
// Hand-synced copies of domain/logic/subtract-dsp.ts and share-recenter.ts (keep in sync).
const TAPS = 1024;
const HALF = TAPS >> 1;
const MAX_LAG = 16000;
const RING_LENGTH = 32768; // nextPow2(MAX_LAG + TAPS + 256)
const RING_MASK = RING_LENGTH - 1;
const CORR_LENGTH = 16384;
const CORR_EVERY = 24000; // ~0.5 s at 48 k
const STEP_SIZE = 0.3;
const ADAPT_EVERY = 2;
const POWER_DECAY = 0.999;
const REGULARIZATION = 1e-9;
const REFERENCE_ACTIVE_POWER = 1e-7;
// Recenter policy (share-recenter.ts).
const RECENTER_LOCK_QUALITY = 0.3;
const RECENTER_TRACK_QUALITY = 0.25;
const RECENTER_TRACK_WINDOW = 256;
const RECENTER_IGNORE_SHIFT = 8;
const RECENTER_HYSTERESIS_SLACK = 16;
// Failure detector: internal 0.5 s windows (3 = 1.5 s to drop a dead lock).
const FAILURE_RATIO = 0.5;
const FAILURE_WINDOW = 24000;
const FAILURE_WINDOWS = 3;
// Onset verification: fire a full-range correlation this long after a burst
// starts, retry at this cadence while the shot stays untrusted.
const ONSET_SHOT_DELAY = 4800; // 100 ms — enough burst for a trusted peak
const ONSET_SHOT_RETRY = 4800;

function fftInPlace(real, imag) {
  const length = real.length;
  for (let index = 1, reversed = 0; index < length; index += 1) {
    let bit = length >> 1;
    for (; (reversed & bit) !== 0; bit >>= 1) {
      reversed ^= bit;
    }
    reversed ^= bit;
    if (index < reversed) {
      let swap = real[index]; real[index] = real[reversed]; real[reversed] = swap;
      swap = imag[index]; imag[index] = imag[reversed]; imag[reversed] = swap;
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
        const oddReal = real[oddIndex];
        const oddImag = imag[oddIndex];
        const productReal = oddReal * currentReal - oddImag * currentImag;
        const productImag = oddReal * currentImag + oddImag * currentReal;
        real[oddIndex] = real[evenIndex] - productReal;
        imag[oddIndex] = imag[evenIndex] - productImag;
        real[evenIndex] = real[evenIndex] + productReal;
        imag[evenIndex] = imag[evenIndex] + productImag;
        const nextReal = currentReal * twiddleReal - currentImag * twiddleImag;
        currentImag = currentReal * twiddleImag + currentImag * twiddleReal;
        currentReal = nextReal;
      }
    }
  }
}

function ifftInPlace(real, imag) {
  for (let index = 0; index < real.length; index += 1) {
    imag[index] = -imag[index];
  }
  fftInPlace(real, imag);
  const scale = 1 / real.length;
  for (let index = 0; index < real.length; index += 1) {
    real[index] = real[index] * scale;
    imag[index] = -imag[index] * scale;
  }
}

function nextPowerOfTwo(value) {
  let result = 1;
  while (result < value) {
    result <<= 1;
  }
  return result;
}

function crossCorrelationPeak(signal, reference, minLag, maxLag) {
  const fftLength = nextPowerOfTwo(signal.length + reference.length);
  const signalReal = new Float64Array(fftLength);
  const signalImag = new Float64Array(fftLength);
  const referenceReal = new Float64Array(fftLength);
  const referenceImag = new Float64Array(fftLength);
  let signalEnergy = 0;
  let referenceEnergy = 0;
  for (let index = 0; index < signal.length; index += 1) {
    signalReal[index] = signal[index];
    signalEnergy += signal[index] * signal[index];
  }
  for (let index = 0; index < reference.length; index += 1) {
    referenceReal[index] = reference[index];
    referenceEnergy += reference[index] * reference[index];
  }
  const normalizer = Math.sqrt(signalEnergy * referenceEnergy);
  if (normalizer <= 0) {
    return { lag: 0, quality: 0 };
  }
  fftInPlace(signalReal, signalImag);
  fftInPlace(referenceReal, referenceImag);
  for (let bin = 0; bin < fftLength; bin += 1) {
    const productReal = signalReal[bin] * referenceReal[bin] + signalImag[bin] * referenceImag[bin];
    const productImag = signalImag[bin] * referenceReal[bin] - signalReal[bin] * referenceImag[bin];
    signalReal[bin] = productReal;
    signalImag[bin] = productImag;
  }
  ifftInPlace(signalReal, signalImag);
  let bestLag = 0;
  let bestValue = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    const value = signalReal[lag];
    if (value > bestValue) {
      bestValue = value;
      bestLag = lag;
    }
    const wrappedValue = signalReal[fftLength - lag];
    if (wrappedValue > bestValue) {
      bestValue = wrappedValue;
      bestLag = -lag;
    }
  }
  return { lag: bestLag, quality: bestValue / normalizer };
}

class SubtractorChannel {
  constructor() {
    this.ring = new Float32Array(RING_LENGTH);
    this.ringPosition = 0;
    this.written = 0;
    this.taps = new Float64Array(TAPS);
    this.power = 1e-9;
    this.delay = HALF; // owned by the domain tracker (setDelay)
    this.silentFor = 0;
    // NO adaptation before the domain tracker locks — the pre-lock window once
    // adapted on a bogus alignment and the residual came out 44 dB HOTTER
    // than the loopback (live smoke, 2026-09-18).
    this.adaptEnabled = false;
    // Onset hold-off (live smoke, iteration 8): after a silence gap the
    // loopback delivery re-baselines and the old alignment is stale — the
    // domain holds the channel in PASS-THROUGH until a fresh correlation
    // confirms the lock. Worst case = a brief voice-onset leak (the pre-
    // feature behavior); NEVER the misaligned-subtraction roar.
    this.bypass = false;
    this.internalLoopbackSquare = 0; // failure-detector window (never reset by reads)
    this.internalResidualSquare = 0;
    this.referenceSquareSum = 0; // path-gain telescope, reset by reads
  }

  setDelay(delay) {
    this.delay = delay;
  }

  setAdaptEnabled(enabled) {
    this.adaptEnabled = enabled;
  }

  setBypass(bypass) {
    this.bypass = bypass;
  }

  resetTaps() {
    this.taps.fill(0);
    this.power = 1e-9;
  }

  process(loopback, reference, residual, blockLength) {
    for (let sampleIndex = 0; sampleIndex < blockLength; sampleIndex += 1) {
      const loopbackSample = loopback[sampleIndex];
      const referenceSample = reference[sampleIndex];
      this.ring[this.ringPosition] = referenceSample;
      this.ringPosition = (this.ringPosition + 1) & RING_MASK;
      this.power = this.power * POWER_DECAY + referenceSample * referenceSample * (1 - POWER_DECAY);
      this.referenceSquareSum += referenceSample * referenceSample;
      // Silence gate: once the reference has been quiet for longer than the
      // window reaches back, the tap window is provably all zeros — the filter
      // loops (the CPU hot path) are skipped, which is mathematically identical.
      if (Math.abs(referenceSample) < 1e-6) {
        this.silentFor += 1;
      } else {
        this.silentFor = 0;
      }
      const absolute = this.written + sampleIndex;
      const windowStart = absolute - this.delay - HALF;
      let residualSample;
      if (this.bypass || windowStart < 0 || this.delay < HALF || this.silentFor > this.delay + HALF) {
        residualSample = loopbackSample;
      } else {
        let estimate = 0;
        for (let tapIndex = 0; tapIndex < TAPS; tapIndex += 1) {
          estimate += this.taps[tapIndex] * this.ring[(windowStart + tapIndex) & RING_MASK];
        }
        residualSample = loopbackSample - estimate;
        if (this.adaptEnabled && this.power > REFERENCE_ACTIVE_POWER && sampleIndex % ADAPT_EVERY === 0) {
          // TRUE window energy, NOT the lagging EMA — an EMA-based norm explodes
          // the taps at a hard onset after silence (live divergence, 2026-09-18).
          let windowEnergy = 0;
          for (let tapIndex = 0; tapIndex < TAPS; tapIndex += 1) {
            const windowSample = this.ring[(windowStart + tapIndex) & RING_MASK];
            windowEnergy += windowSample * windowSample;
          }
          const norm = STEP_SIZE / (windowEnergy + REGULARIZATION);
          for (let tapIndex = 0; tapIndex < TAPS; tapIndex += 1) {
            this.taps[tapIndex] += norm * residualSample * this.ring[(windowStart + tapIndex) & RING_MASK];
          }
        }
      }
      residual[sampleIndex] = residualSample;
      this.internalLoopbackSquare += loopbackSample * loopbackSample;
      this.internalResidualSquare += residualSample * residualSample;
    }
    this.written += blockLength;
  }
}

// One delay tracker per DOMAIN, fed with the L+R mono sum — speech is
// quasi-periodic and its correlation multi-peaked, so the policy (hand-synced
// from share-recenter.ts) is stability-first and never chases aliases.
class SharedTracker {
  constructor() {
    this.delay = HALF;
    this.locked = false;
    this.pendingShift = 0;
    this.pendingCount = 0;
    this.quality = 0;
    this.lagHistory = [];
    this.corrSignal = new Float32Array(CORR_LENGTH);
    this.corrReference = new Float32Array(CORR_LENGTH);
    this.corrPosition = 0;
    this.corrFilled = 0;
    this.corrTimer = 0;
    this.badWindows = 0;
  }

  append(loopbackSample, referenceSample) {
    this.corrSignal[this.corrPosition] = loopbackSample;
    this.corrReference[this.corrPosition] = referenceSample;
    this.corrPosition = (this.corrPosition + 1) % CORR_LENGTH;
    if (this.corrFilled < CORR_LENGTH) {
      this.corrFilled += 1;
    }
  }

  searchRange() {
    if (!this.locked) {
      return { minLag: 0, maxLag: MAX_LAG };
    }
    return {
      minLag: Math.max(0, this.delay - RECENTER_TRACK_WINDOW),
      maxLag: Math.min(MAX_LAG, this.delay + RECENTER_TRACK_WINDOW),
    };
  }

  maybeRecenter(channels, verifyOnset) {
    if (this.corrFilled < CORR_LENGTH) {
      return "idle";
    }
    // Unwrap the rings chronologically before correlating.
    const signal = new Float32Array(CORR_LENGTH);
    const reference = new Float32Array(CORR_LENGTH);
    const tail = CORR_LENGTH - this.corrPosition;
    signal.set(this.corrSignal.subarray(this.corrPosition), 0);
    signal.set(this.corrSignal.subarray(0, this.corrPosition), tail);
    reference.set(this.corrReference.subarray(this.corrPosition), 0);
    reference.set(this.corrReference.subarray(0, this.corrPosition), tail);
    // Onset verification searches the FULL range: after a silence gap the
    // loopback delivery re-baselines and the old lock may be anywhere relative
    // to the new truth (live smoke, iteration 8 — the onset roar).
    const range = verifyOnset ? { minLag: 0, maxLag: MAX_LAG } : this.searchRange();
    const peak = crossCorrelationPeak(signal, reference, range.minLag, range.maxLag);
    this.quality = peak.quality;
    this.lagHistory.push({ lag: peak.lag, quality: peak.quality });
    if (this.lagHistory.length > 12) {
      this.lagHistory.shift();
    }
    if (verifyOnset && this.locked && peak.quality >= RECENTER_LOCK_QUALITY) {
      if (Math.abs(peak.lag - this.delay) <= RECENTER_TRACK_WINDOW) {
        this.pendingShift = 0;
        this.pendingCount = 0;
        return "confirmed"; // the old alignment still holds — taps stay warm
      }
      // A real delay jump across the gap: apply NOW (single trusted shot, no
      // hysteresis — the hold-off guarantees we were passing through anyway).
      this.delay = Math.max(0, peak.lag);
      this.pendingShift = 0;
      this.pendingCount = 0;
      for (const channel of channels) {
        channel.setDelay(this.delay);
        channel.resetTaps();
      }
      return "relocked";
    }
    // applyRecenterShot (share-recenter.ts) — keep in sync.
    const gate = this.locked ? RECENTER_TRACK_QUALITY : RECENTER_LOCK_QUALITY;
    if (peak.quality < gate) {
      this.pendingShift = 0;
      this.pendingCount = 0;
      return "untrusted"; // an untrusted shot must not move anything
    }
    if (!this.locked) {
      this.locked = true;
      this.delay = Math.max(0, peak.lag);
      this.pendingShift = 0;
      this.pendingCount = 0;
      for (const channel of channels) {
        channel.setDelay(this.delay);
        channel.resetTaps();
        channel.setAdaptEnabled(true);
      }
      return "locked";
    }
    const shift = peak.lag - this.delay;
    if (Math.abs(shift) <= RECENTER_IGNORE_SHIFT) {
      this.pendingShift = 0;
      this.pendingCount = 0;
      return "confirmed";
    }
    const agrees = this.pendingCount > 0 && Math.abs(shift - this.pendingShift) <= RECENTER_HYSTERESIS_SLACK;
    this.pendingShift = shift;
    this.pendingCount = agrees ? this.pendingCount + 1 : 1;
    if (this.pendingCount >= 2) {
      this.delay = this.delay + this.pendingShift;
      this.pendingShift = 0;
      this.pendingCount = 0;
      for (const channel of channels) {
        channel.setDelay(this.delay);
      }
      return "confirmed";
    }
    return "untrusted";
  }

  // Sustained no-cancellation with an active reference drops the lock — a full
  // re-search follows (real drift / device change recovery).
  evaluateFailure(channels) {
    let loopbackSquare = 0;
    let residualSquare = 0;
    let referenceActive = false;
    for (const channel of channels) {
      loopbackSquare += channel.internalLoopbackSquare;
      residualSquare += channel.internalResidualSquare;
      referenceActive = referenceActive || channel.power > REFERENCE_ACTIVE_POWER;
      channel.internalLoopbackSquare = 0;
      channel.internalResidualSquare = 0;
    }
    if (!referenceActive || loopbackSquare <= 1e-9) {
      this.badWindows = 0;
      return null;
    }
    if (residualSquare / loopbackSquare > FAILURE_RATIO) {
      this.badWindows += 1;
    } else {
      this.badWindows = 0;
    }
    if (this.badWindows >= FAILURE_WINDOWS) {
      this.badWindows = 0;
      this.locked = false;
      this.pendingShift = 0;
      this.pendingCount = 0;
      for (const channel of channels) {
        channel.setAdaptEnabled(false);
        channel.resetTaps(); // stale taps at a stale lock are garbage — start clean
      }
      return residualSquare / loopbackSquare;
    }
    return null;
  }
}

// One cancellation domain = one playout pipeline (element playout vs UI-sound
// context) with its own tracker, taps and failure detector. Cascaded: the next
// domain's "loopback" is the previous domain's residual. ONSET HOLD-OFF: when
// the reference goes active after a silence gap, the channels PASS THROUGH
// until a full-range correlation confirms the alignment (~100–300 ms) — a
// stale lock after delivery re-baselining must leak a brief voice onset, never
// subtract a misaligned copy (the overload roar of the live smoke).
class CancellerDomain {
  constructor() {
    this.tracker = new SharedTracker();
    this.channels = [new SubtractorChannel(), new SubtractorChannel()];
    this.processedSamples = 0;
    this.lastReferenceActive = false;
    this.onsetHoldoff = false;
    this.onsetShotIn = 0;
  }

  setOnsetHoldoff(active) {
    this.onsetHoldoff = active;
    for (const channel of this.channels) {
      channel.setBypass(active);
    }
  }

  process(loopbackLeft, loopbackRight, referenceLeft, referenceRight, residualLeft, residualRight, blockLength) {
    if (referenceLeft === null) {
      // No reference connected — this domain is a pure pass-through stage.
      residualLeft.set(loopbackLeft.subarray(0, blockLength));
      residualRight.set(loopbackRight.subarray(0, blockLength));
      this.tracker.badWindows = 0;
      return;
    }
    const referenceForRight = referenceRight !== null ? referenceRight : referenceLeft;
    this.channels[0].process(loopbackLeft, referenceLeft, residualLeft, blockLength);
    this.channels[1].process(loopbackRight, referenceForRight, residualRight, blockLength);
    for (let sampleIndex = 0; sampleIndex < blockLength; sampleIndex += 1) {
      this.tracker.append(
        loopbackLeft[sampleIndex] + (loopbackRight !== null ? loopbackRight[sampleIndex] : 0),
        referenceLeft[sampleIndex] + (referenceRight !== null ? referenceRight[sampleIndex] : 0),
      );
    }
    const referenceActive = this.channels[0].power > REFERENCE_ACTIVE_POWER
      || this.channels[1].power > REFERENCE_ACTIVE_POWER;
    if (referenceActive && !this.lastReferenceActive) {
      // A burst begins: hold off (pass-through) and arm a verification shot.
      this.setOnsetHoldoff(true);
      this.onsetShotIn = ONSET_SHOT_DELAY;
    }
    this.lastReferenceActive = referenceActive;
    if (this.onsetHoldoff) {
      if (!referenceActive) {
        this.setOnsetHoldoff(false); // the burst died before verification — nothing to guard
      } else {
        this.onsetShotIn -= blockLength;
        if (this.onsetShotIn <= 0) {
          const outcome = this.tracker.maybeRecenter(this.channels, true);
          if (outcome === "confirmed" || outcome === "relocked" || outcome === "locked") {
            this.setOnsetHoldoff(false);
          } else {
            this.onsetShotIn = ONSET_SHOT_RETRY; // still untrusted — retry shortly
          }
        }
      }
    }
    this.tracker.corrTimer += blockLength;
    if (this.tracker.corrTimer >= CORR_EVERY) {
      this.tracker.corrTimer = 0;
      this.tracker.maybeRecenter(this.channels, false);
    }
    this.processedSamples += blockLength;
    if (this.processedSamples >= FAILURE_WINDOW) {
      this.processedSamples = 0;
      const failedRatio = this.tracker.evaluateFailure(this.channels);
      if (failedRatio !== null) {
        // Sustained failure: drop the lock AND hold off — the full re-search
        // runs as an onset verification the moment speech continues.
        this.setOnsetHoldoff(true);
        this.onsetShotIn = ONSET_SHOT_DELAY;
        this.port && this.port.postMessage({ type: "unlocked", domain: this.name, ratio: failedRatio });
      }
    }
  }
}

class ShareSubtractorProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.elements = new CancellerDomain();
    this.contexts = new CancellerDomain();
    this.elements.name = "elements";
    this.contexts.name = "contexts";
    this.elements.port = this.port;
    this.contexts.port = this.port;
    this.scratchLeft = new Float32Array(256);
    this.scratchRight = new Float32Array(256);
    // The FINAL residual accumulators (the telemetry truth): original loopback
    // in, cascade residual out.
    this.loopbackSquare = [0, 0];
    this.residualSquare = [0, 0];
    this.sampleCount = 0;
    this.port.onmessage = (event) => {
      const message = event.data;
      if (message && message.type === "read") {
        const channels = this.channelsSnapshot();
        this.port.postMessage({
          type: "stats",
          id: message.id,
          channels,
          domains: [this.domainSnapshot(this.elements), this.domainSnapshot(this.contexts)],
        });
      }
    };
  }

  channelsSnapshot() {
    const snapshot = [];
    for (let channelIndex = 0; channelIndex < 2; channelIndex += 1) {
      const anyRef = this.elements.channels[channelIndex].power > REFERENCE_ACTIVE_POWER
        || this.contexts.channels[channelIndex].power > REFERENCE_ACTIVE_POWER;
      snapshot.push({
        loopbackSquareSum: this.loopbackSquare[channelIndex],
        residualSquareSum: this.residualSquare[channelIndex],
        sampleCount: this.sampleCount,
        referenceActive: anyRef,
      });
    }
    for (let channelIndex = 0; channelIndex < 2; channelIndex += 1) {
      this.loopbackSquare[channelIndex] = 0;
      this.residualSquare[channelIndex] = 0;
    }
    this.sampleCount = 0;
    return snapshot;
  }

  domainSnapshot(domain) {
    let referenceSquareSum = 0;
    for (const channel of domain.channels) {
      referenceSquareSum += channel.referenceSquareSum;
      channel.referenceSquareSum = 0;
    }
    return {
      name: domain.name,
      delaySamples: domain.tracker.delay,
      locked: domain.tracker.locked,
      correlationQuality: domain.tracker.quality,
      lagHistory: domain.tracker.lagHistory.slice(),
      referenceSquareSum,
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const blockLength = output[0] ? output[0].length : 0;
    if (blockLength === 0) {
      return true;
    }
    if (this.scratchLeft.length < blockLength) {
      this.scratchLeft = new Float32Array(blockLength);
      this.scratchRight = new Float32Array(blockLength);
    }
    const pick = (input, channelIndex) => (input && input.length > 0) ? input[Math.min(channelIndex, input.length - 1)] : null;
    const loopbackLeft = pick(inputs[0], 0);
    const loopbackRight = pick(inputs[0], 1);
    const outLeft = output[0];
    const outRight = output.length > 1 ? output[1] : output[0];
    if (loopbackLeft === null) {
      outLeft.fill(0);
      outRight.fill(0);
      return true;
    }
    const loopbackForRight = loopbackRight !== null ? loopbackRight : loopbackLeft;
    // Cascade: elements domain first, contexts domain eats its residual.
    this.elements.process(
      loopbackLeft, loopbackForRight,
      pick(inputs[1], 0), pick(inputs[1], 1),
      this.scratchLeft, this.scratchRight, blockLength,
    );
    this.contexts.process(
      this.scratchLeft, this.scratchRight,
      pick(inputs[2], 0), pick(inputs[2], 1),
      outLeft, outRight, blockLength,
    );
    for (let sampleIndex = 0; sampleIndex < blockLength; sampleIndex += 1) {
      this.loopbackSquare[0] += loopbackLeft[sampleIndex] * loopbackLeft[sampleIndex];
      this.loopbackSquare[1] += loopbackForRight[sampleIndex] * loopbackForRight[sampleIndex];
      this.residualSquare[0] += outLeft[sampleIndex] * outLeft[sampleIndex];
      this.residualSquare[1] += outRight[sampleIndex] * outRight[sampleIndex];
    }
    this.sampleCount += blockLength;
    return true;
  }
}

registerProcessor("share-subtractor", ShareSubtractorProcessor);
`;

export interface ShareSubtractionChannelStats {
  loopbackSquareSum: number;
  residualSquareSum: number;
  sampleCount: number;
  referenceActive: boolean;
}

/** One playout pipeline (elements vs the UI-sound context) with its own delay. */
export interface ShareSubtractionDomainStats {
  name: string;
  delaySamples: number;
  locked: boolean;
  correlationQuality: number;
  lagHistory: { lag: number; quality: number }[];
  /** Reference energy over the same window (the path-gain telescope). */
  referenceSquareSum: number;
}

export interface ShareSubtractionStats {
  channels: ShareSubtractionChannelStats[];
  /** [elements domain, contexts domain] — the cascade order. */
  domains: ShareSubtractionDomainStats[];
}

export interface ShareSubtractionReferences {
  /** The ELEMENT playout reconstruction (RoomAudio) — the long-latency path. */
  elements: (MediaStreamTrack | AudioNode)[];
  /** The UI-sound context reference (NotificationHub) — the short-latency path. */
  contexts: (MediaStreamTrack | AudioNode)[];
}

export interface ShareSubtraction {
  /** The residual (loopback minus our playout) — the track a share would publish. */
  readonly track: MediaStreamTrack;
  /** Reads the accumulators since the LAST read (each read resets the window). */
  readStats(): Promise<ShareSubtractionStats>;
  dispose(): void;
}

/**
 * Builds the subtractor: input 0 = loopback, input 1 = the ELEMENT-domain
 * reference(s), input 2 = the CONTEXT-domain reference(s). Multiple connections
 * into one domain input are summed by WebAudio itself; the domains cascade
 * (elements first, contexts over its residual). An explicit `context` is used
 * as-is (the caller owns its lifetime); without one a dedicated context is
 * created and closed on dispose.
 */
export async function createShareSubtraction(
  loopbackTrack: MediaStreamTrack,
  references: ShareSubtractionReferences,
  context?: AudioContext,
): Promise<ShareSubtraction> {
  const ownContext = context ?? new AudioContext();
  if (ownContext.state !== "running") {
    await ownContext.resume();
  }
  const blobUrl = URL.createObjectURL(new Blob([SUBTRACT_PROCESSOR_SOURCE], { type: "application/javascript" }));
  try {
    // Per-context registration (the #476 lesson): no cross-context caches.
    await ownContext.audioWorklet.addModule(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
  const node = new AudioWorkletNode(ownContext, "share-subtractor", {
    numberOfInputs: 3,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  // TRAP (live, 2026-09-18): a MessagePort DELIVERS nothing until started —
  // addEventListener alone does not start it (the onmessage-setter idiom of
  // the NS engines starts the port implicitly, which is why they worked).
  node.port.start();
  node.port.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { type?: string; domain?: string; ratio?: number } | null;
    if (data?.type === "unlocked") {
      log.warn("share-sub", `${data.domain ?? "domain"} delay lock lost (residual/loopback ${(data.ratio ?? 0).toFixed(2)}) — full re-search`);
    }
  });
  const disconnects: (() => void)[] = [];
  const loopbackSource = ownContext.createMediaStreamSource(new MediaStream([loopbackTrack]));
  loopbackSource.connect(node, 0, 0);
  disconnects.push(() => loopbackSource.disconnect());
  const connectDomain = (domainReferences: (MediaStreamTrack | AudioNode)[], inputIndex: number): void => {
    for (const reference of domainReferences) {
      if (reference instanceof MediaStreamTrack) {
        const referenceSource = ownContext.createMediaStreamSource(new MediaStream([reference]));
        referenceSource.connect(node, 0, inputIndex);
        disconnects.push(() => referenceSource.disconnect());
      } else {
        reference.connect(node, 0, inputIndex);
        disconnects.push(() => {
          try {
            reference.disconnect(node);
          } catch {
            // already disconnected
          }
        });
      }
    }
  };
  connectDomain(references.elements, 1);
  connectDomain(references.contexts, 2);
  const sink = ownContext.createMediaStreamDestination();
  node.connect(sink);
  const outputTrack = sink.stream.getAudioTracks()[0];
  if (outputTrack === undefined) {
    throw new Error("subtractor sink produced no track");
  }

  let requestSeq = 0;
  const readStats = (): Promise<ShareSubtractionStats> => new Promise((resolve, reject) => {
    const requestId = ++requestSeq;
    const timer = setTimeout(() => {
      node.port.removeEventListener("message", onMessage);
      reject(new Error("share-subtractor stats timeout (worklet silent)"));
    }, 2_000);
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as { type?: string; id?: number } | null;
      if (data?.type === "stats" && data.id === requestId) {
        clearTimeout(timer);
        node.port.removeEventListener("message", onMessage);
        resolve({
          channels: (event.data as { channels: ShareSubtractionChannelStats[] }).channels,
          domains: (event.data as { domains: ShareSubtractionDomainStats[] }).domains,
        });
      }
    };
    node.port.addEventListener("message", onMessage);
    node.port.postMessage({ type: "read", id: requestId });
  });

  const dispose = (): void => {
    try {
      for (const disconnect of disconnects) {
        disconnect();
      }
      node.disconnect();
      sink.disconnect();
    } finally {
      if (context === undefined) {
        void ownContext.close().catch(() => undefined);
      }
    }
  };

  return { track: outputTrack, readStats, dispose };
}

/** Suppression over a stats window in dB (null = no signal reached the loopback). */
export function suppressionDb(stats: ShareSubtractionStats): number | null {
  return suppressionDbPure(stats.channels);
}
