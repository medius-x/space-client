import { describe, expect, it } from "vitest";
import {
  SPEAKING_FULL_SCALE,
  SPEAKING_NOISE_FLOOR,
  isSpeaking,
  speakingLevel,
} from "../src/core/audio-math";

/**
 * oak parity of the speaking envelope (MainController/SfuAudioMixer): the level
 * smooths per 10 ms frame with a 3%-of-gap decay, the ring threshold is 0.05, and
 * the ring therefore fades ~1 s after speech stops. We poll every 100 ms, so one
 * poll tick compounds ten 10 ms frames.
 */

/** A frame comfortably above the full-scale calibration → instant level 1.0. */
const LOUD_RMS = 0.2;
const SILENT_RMS = 0;

describe("speakingLevel", () => {
  it("attacks instantly on a loud frame", () => {
    expect(speakingLevel(LOUD_RMS, 0)).toBe(1);
  });

  it("decays to below the ring threshold within a second of silence", () => {
    let level = speakingLevel(LOUD_RMS, 0);
    for (let tick = 0; tick < 9; tick++) {
      level = speakingLevel(SILENT_RMS, level);
    }
    expect(isSpeaking(level)).toBe(true); // ~0.065 after 900 ms — still lit
    level = speakingLevel(SILENT_RMS, level);
    expect(isSpeaking(level)).toBe(false); // ~0.048 after 1000 ms — oak's fade time
  });

  it("gates near-silence to a zero instant level", () => {
    expect(speakingLevel(SPEAKING_NOISE_FLOOR / 2, 0)).toBe(0);
  });

  it("never decays upward toward a quieter instant", () => {
    const quiet = speakingLevel(SPEAKING_NOISE_FLOOR + SPEAKING_FULL_SCALE * 0.1, 0);
    expect(speakingLevel(SILENT_RMS, quiet)).toBeLessThan(quiet);
  });
});

describe("isSpeaking", () => {
  it("uses oak's 0.05 threshold", () => {
    expect(isSpeaking(0.06)).toBe(true);
    expect(isSpeaking(0.04)).toBe(false);
  });
});
