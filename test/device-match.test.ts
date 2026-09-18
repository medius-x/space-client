import { describe, expect, it } from "vitest";
import { deviceLabelFor, matchDeviceId } from "../src/domain/logic/device-match";

const devices = [
  { deviceId: "default", label: "Default - Microphone Array (Realtek)" },
  { deviceId: "communications", label: "Communications - Microphone Array (Realtek)" },
  { deviceId: "aaa111", label: "Microphone Array (Realtek Audio)" },
  { deviceId: "bbb222", label: "Headset Microphone (Jabra)" },
];

describe("matchDeviceId", () => {
  it("prefers the exact saved id when it still exists", () => {
    expect(matchDeviceId(devices, "bbb222", "Microphone Array (Realtek Audio)")).toBe("bbb222");
  });

  it("recovers by label when the id hash went stale", () => {
    expect(matchDeviceId(devices, "deadbeef", "Microphone Array (Realtek Audio)")).toBe("aaa111");
  });

  it("never resolves to a synthetic default entry by label", () => {
    // The synthetic entries carry the real device's name inside their label —
    // they must not win even on a partial collision.
    expect(matchDeviceId(devices, "deadbeef", "Default - Microphone Array (Realtek)")).toBeNull();
  });

  it("returns null (system default) when nothing matches", () => {
    expect(matchDeviceId(devices, "deadbeef", null)).toBeNull();
    expect(matchDeviceId(devices, null, "Gone Headset")).toBeNull();
    expect(matchDeviceId(devices, null, null)).toBeNull();
  });
});

describe("deviceLabelFor", () => {
  it("remembers the real device's label, null for the synthetic/default pick", () => {
    expect(deviceLabelFor(devices, "aaa111")).toBe("Microphone Array (Realtek Audio)");
    expect(deviceLabelFor(devices, "default")).toBeNull();
    expect(deviceLabelFor(devices, null)).toBeNull();
  });
});
