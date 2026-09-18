import { describe, expect, it } from "vitest";
import { deafenCue, muteCue } from "../src/domain/logic/mute-cue";
import { knockSchedule } from "../src/domain/logic/knock-sound";

/** All frequencies a cue's sweep touches (endpoints only — the glide is monotonic). */
function cueRange(frequencies: { fromHz: number; toHz: number }): [number, number] {
  return [Math.min(frequencies.fromHz, frequencies.toHz), Math.max(frequencies.fromHz, frequencies.toHz)];
}

/** Two monotonic glides overlap iff their endpoint ranges intersect. */
function rangesOverlap(left: [number, number], right: [number, number]): boolean {
  return left[0] <= right[1] && right[0] <= left[1];
}

describe("muteCue (the hotkey mute/unmute sweep)", () => {
  it("rises on unmute, falls on mute — the direction is the message", () => {
    expect(muteCue(false).toHz).toBeGreaterThan(muteCue(false).fromHz);
    expect(muteCue(true).toHz).toBeLessThan(muteCue(true).fromHz);
  });

  it("both directions share one register (same endpoint pair, mirrored)", () => {
    const unmute = muteCue(false);
    const mute = muteCue(true);
    expect(mute.fromHz).toBe(unmute.toHz);
    expect(mute.toHz).toBe(unmute.fromHz);
  });
});

describe("deafenCue (the same sweep one register lower — user request)", () => {
  it("rises on undeafen, falls on deafen, mirroring the same endpoints", () => {
    expect(deafenCue(false).toHz).toBeGreaterThan(deafenCue(false).fromHz);
    expect(deafenCue(true).toHz).toBeLessThan(deafenCue(true).fromHz);
    expect(deafenCue(true).fromHz).toBe(deafenCue(false).toHz);
  });

  it("sits strictly BELOW the mute cue's register", () => {
    expect(Math.max(...cueRange(deafenCue(false)))).toBeLessThan(Math.min(...cueRange(muteCue(false))));
  });
});

describe("the three sound families stay pairwise distinct (user rule)", () => {
  it("neither cue touches the knock's register, and the cues don't overlap", () => {
    const knockRange: [number, number] = [
      Math.min(...knockSchedule("join").map((note) => note.frequencyHz)),
      Math.max(...knockSchedule("join").map((note) => note.frequencyHz)),
    ];
    const muteRange = cueRange(muteCue(false));
    const deafenRange = cueRange(deafenCue(false));
    expect(rangesOverlap(knockRange, muteRange)).toBe(false);
    expect(rangesOverlap(knockRange, deafenRange)).toBe(false);
    expect(rangesOverlap(muteRange, deafenRange)).toBe(false);
  });
});
