import { describe, expect, it, vi } from "vitest";
import { PermissionStore } from "../src/domain/stores/PermissionStore";

describe("PermissionStore", () => {
  it("can() is a plain contains — the server lists every name for the owner", () => {
    const store = new PermissionStore();
    expect(store.can("MANAGE_CHANNELS")).toBe(false); // no snapshot yet → closed gates

    store.applyMy({ permissions: ["SEND_MESSAGES"], owner: false });
    expect(store.can("SEND_MESSAGES")).toBe(true);
    expect(store.can("MANAGE_CHANNELS")).toBe(false);

    store.applyMy({ permissions: ["SEND_MESSAGES", "MANAGE_CHANNELS"], owner: true });
    expect(store.can("MANAGE_CHANNELS")).toBe(true); // listed by the server, not an owner special-case
  });

  it("channel bits are cached per channel and drop with the channel", () => {
    const store = new PermissionStore();
    store.applyChannel(1, { sendMessages: true, attachFiles: true, stream: true });
    store.applyChannel(2, { sendMessages: false, attachFiles: false, stream: false });

    expect(store.channelPermissions(1)?.sendMessages).toBe(true);
    expect(store.channelPermissions(2)?.sendMessages).toBe(false);
    expect(store.channelPermissions(3)).toBeNull();

    store.dropChannel(1);
    expect(store.channelPermissions(1)).toBeNull();
    expect(store.channelPermissions(2)).not.toBeNull();
  });

  it("re-applying identical channel bits does not emit", () => {
    const store = new PermissionStore();
    store.applyChannel(1, { sendMessages: true, attachFiles: false, stream: true });
    const listener = vi.fn();
    store.subscribe(listener);

    store.applyChannel(1, { sendMessages: true, attachFiles: false, stream: true });
    expect(listener).not.toHaveBeenCalled();

    store.applyChannel(1, { sendMessages: false, attachFiles: false, stream: true });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("a stream-only flip emits (the share-button gate follows the live permission sweep)", () => {
    // Security round 6 regression: the dedup compared only the composer bits, so a
    // per-channel STREAM deny arriving with everything else unchanged never re-rendered.
    const store = new PermissionStore();
    store.applyChannel(7, { sendMessages: true, attachFiles: true, stream: true });
    const listener = vi.fn();
    store.subscribe(listener);

    store.applyChannel(7, { sendMessages: true, attachFiles: true, stream: false });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.channelPermissions(7)?.stream).toBe(false);
  });
});
