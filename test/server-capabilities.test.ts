import { describe, expect, it } from "vitest";
import { hasServerCapability } from "../src/domain/logic/server-capabilities";
import type { ServerProfile } from "../src/types";

function profile(overrides: Partial<ServerProfile> = {}): ServerProfile {
  return {
    id: 1,
    name: "OAK Server",
    avatarKey: null,
    avatarUrl: null,
    connectionHost: null,
    connectionPort: null,
    ...overrides,
  };
}

describe("hasServerCapability", () => {
  it("sees a reported flag", () => {
    expect(hasServerCapability(profile({ capabilities: ["voice-morph", "game-activity"] }), "voice-morph")).toBe(true);
  });

  it("misses an unreported flag", () => {
    expect(hasServerCapability(profile({ capabilities: ["game-activity"] }), "voice-morph")).toBe(false);
  });

  it("treats an old server WITHOUT the field as the flagless 0.1.0 base", () => {
    expect(hasServerCapability(profile(), "voice-morph")).toBe(false);
  });

  it("treats an explicit empty catalogue the same as a missing one", () => {
    expect(hasServerCapability(profile({ capabilities: [] }), "voice-morph")).toBe(false);
  });

  it("treats null (the wire null) and a null session profile the same", () => {
    expect(hasServerCapability(profile({ capabilities: null }), "voice-morph")).toBe(false);
    expect(hasServerCapability(null, "voice-morph")).toBe(false);
  });
});
