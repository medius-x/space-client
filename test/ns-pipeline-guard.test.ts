import { describe, expect, it } from "vitest";
import { noisePipelineStillWanted } from "../src/media/noise-suppression";

function input(overrides: Partial<Parameters<typeof noisePipelineStillWanted>[0]> = {}) {
  return {
    rawTrackLive: true,
    voiceSessionAlive: false,
    callSessionAlive: false,
    callMicBootInFlight: false,
    ...overrides,
  };
}

describe("noisePipelineStillWanted", () => {
  it("a dead raw track is never wanted", () => {
    expect(noisePipelineStillWanted(input({ rawTrackLive: false, voiceSessionAlive: true }))).toBe(false);
    expect(noisePipelineStillWanted(input({ rawTrackLive: false, callMicBootInFlight: true }))).toBe(false);
  });

  it("a live voice room session keeps the pipeline", () => {
    expect(noisePipelineStillWanted(input({ voiceSessionAlive: true }))).toBe(true);
  });

  it("a live call session keeps the pipeline (the post-boot rebuild path)", () => {
    expect(noisePipelineStillWanted(input({ callSessionAlive: true }))).toBe(true);
  });

  it("a call PREPARING its mic keeps the pipeline — the 1-on-1 startup path", () => {
    // Regression (live 2026-10-15): wrapCallMic runs BEFORE the PeerCallSession
    // exists, so without this flag every engine boot died silently on the
    // outgoing ring AND the accept, publishing the raw mic.
    expect(noisePipelineStillWanted(input({ callMicBootInFlight: true }))).toBe(true);
  });

  it("nothing alive and nothing preparing — the boot is dropped (never resurrect)", () => {
    expect(noisePipelineStillWanted(input())).toBe(false);
  });
});
