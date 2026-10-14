import { describe, expect, it } from "vitest";
import { voiceRttMillis, voiceSignalLevel, type CandidatePairEntry } from "../src/domain/logic/voice-rtt";

function pair(overrides: Partial<CandidatePairEntry>): CandidatePairEntry {
  return { type: "candidate-pair", state: "succeeded", nominated: false, currentRoundTripTime: 0.05, ...overrides };
}

describe("voiceRttMillis", () => {
  it("rounds the nominated succeeded pair to whole milliseconds", () => {
    expect(voiceRttMillis([pair({ nominated: true, currentRoundTripTime: 0.0419 })])).toBe(42);
  });

  it("falls back to a succeeded pair without nominated (vanilla-ICE stacks)", () => {
    expect(voiceRttMillis([pair({ nominated: false, currentRoundTripTime: 0.123 })])).toBe(123);
  });

  it("prefers the nominated pair over an earlier non-nominated one", () => {
    expect(voiceRttMillis([
      pair({ nominated: false, currentRoundTripTime: 0.5 }),
      pair({ nominated: true, currentRoundTripTime: 0.04 }),
    ])).toBe(40);
  });

  it("ignores pairs that are not candidate-pairs or not succeeded", () => {
    expect(voiceRttMillis([
      { type: "inbound-rtp", state: "succeeded", nominated: true, currentRoundTripTime: 0.01 },
      pair({ state: "failed", nominated: true, currentRoundTripTime: 0.01 }),
      pair({ state: "in-progress", currentRoundTripTime: 0.01 }),
    ])).toBeNull();
  });

  it("drops garbage values (NaN, negative, non-number) instead of rendering them", () => {
    expect(voiceRttMillis([
      pair({ nominated: true, currentRoundTripTime: Number.NaN }),
      pair({ currentRoundTripTime: -0.2 }),
      pair({ currentRoundTripTime: undefined }),
      pair({ currentRoundTripTime: 0.07 }),
    ])).toBe(70);
  });

  it("returns null for an empty report (transport still connecting)", () => {
    expect(voiceRttMillis([])).toBeNull();
  });
});

describe("voiceSignalLevel", () => {
  it("no reading (null / garbage) keeps all waves dim", () => {
    expect(voiceSignalLevel(null)).toBe(0);
    expect(voiceSignalLevel(Number.NaN)).toBe(0);
    expect(voiceSignalLevel(-5)).toBe(0);
  });

  it("tiers at the thresholds: good < 120 ≤ weak < 250 ≤ poor", () => {
    expect(voiceSignalLevel(119)).toBe(3);
    expect(voiceSignalLevel(120)).toBe(2);
    expect(voiceSignalLevel(249)).toBe(2);
    expect(voiceSignalLevel(250)).toBe(1);
    expect(voiceSignalLevel(400)).toBe(1);
  });

  it("a live HK-link reading (230 ms) lands on the middle tier", () => {
    expect(voiceSignalLevel(230)).toBe(2);
  });
});
