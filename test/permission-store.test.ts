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
    store.applyChannel(1, { sendMessages: true, attachFiles: true });
    store.applyChannel(2, { sendMessages: false, attachFiles: false });

    expect(store.channelPermissions(1)?.sendMessages).toBe(true);
    expect(store.channelPermissions(2)?.sendMessages).toBe(false);
    expect(store.channelPermissions(3)).toBeNull();

    store.dropChannel(1);
    expect(store.channelPermissions(1)).toBeNull();
    expect(store.channelPermissions(2)).not.toBeNull();
  });

  it("re-applying identical channel bits does not emit", () => {
    const store = new PermissionStore();
    store.applyChannel(1, { sendMessages: true, attachFiles: false });
    const listener = vi.fn();
    store.subscribe(listener);

    store.applyChannel(1, { sendMessages: true, attachFiles: false });
    expect(listener).not.toHaveBeenCalled();

    store.applyChannel(1, { sendMessages: false, attachFiles: false });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
