import { Emitter } from "../lib/store";
import type { ChannelMyPermissions, MyPermissions } from "../../types";

export interface PermissionState {
  my: MyPermissions | null;
  /** Override-aware per-channel bits, cached as channels get opened. */
  channels: ReadonlyMap<number, ChannelMyPermissions>;
}

/**
 * Viewer permissions for UI gating (the server's 403 stays the authority — this
 * only keeps the composer and the channel-management affordances honest).
 * `can(name)` is a plain contains: the server lists every permission name for
 * the OWNER, so no owner special-case exists on the client.
 */
export class PermissionStore extends Emitter {
  private state: PermissionState = {
    my: null,
    channels: new Map<number, ChannelMyPermissions>(),
  };

  getSnapshot = (): PermissionState => this.state;

  can(permission: string): boolean {
    return this.state.my?.permissions.includes(permission) ?? false;
  }

  channelPermissions(channelId: number): ChannelMyPermissions | null {
    return this.state.channels.get(channelId) ?? null;
  }

  applyMy(my: MyPermissions): void {
    this.state = { ...this.state, my };
    this.emit();
  }

  applyChannel(channelId: number, permissions: ChannelMyPermissions): void {
    const existing = this.state.channels.get(channelId);
    if (existing !== undefined && existing.sendMessages === permissions.sendMessages && existing.attachFiles === permissions.attachFiles) {
      return;
    }
    const channels = new Map(this.state.channels);
    channels.set(channelId, permissions);
    this.state = { ...this.state, channels };
    this.emit();
  }

  /** Channel gone — drop its cached bits. */
  dropChannel(channelId: number): void {
    if (!this.state.channels.has(channelId)) {
      return;
    }
    const channels = new Map(this.state.channels);
    channels.delete(channelId);
    this.state = { ...this.state, channels };
    this.emit();
  }
}
