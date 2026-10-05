import { Emitter } from "../lib/store";
import type { VoiceControlState } from "../../types";

/**
 * Per-connection mute/deafen marks for voice-room members, fed by the
 * /topic/voice.state broadcast. The store keeps the ORIGIN flags verbatim —
 * the UI paints self=yellow, moderator=red (red wins when both hold), and the
 * self-toggle must read ONLY the self flags (a self-unmute never lifts a
 * moderator's mute; the server enforces the same split).
 */

export interface VoiceMemberMarks {
  selfMuted: boolean;
  selfDeafened: boolean;
  modMuted: boolean;
  modDeafened: boolean;
  /** The SPEAK-permission mute (security round 6): derived state, lifted only by
   *  the server's permission sweeps — never by a self or moderator unmute. */
  permMuted: boolean;
}

export interface VoiceControlSnapshot {
  marks: ReadonlyMap<string, VoiceMemberMarks>;
}

export class VoiceControlStore extends Emitter {
  private state: VoiceControlSnapshot = { marks: new Map() };

  getSnapshot = (): VoiceControlSnapshot => this.state;

  /** A /topic/voice.state push — replaces the member's marks (the push is a full state). */
  applyState(push: VoiceControlState): void {
    const marks = new Map(this.state.marks);
    marks.set(push.username, {
      selfMuted: push.selfMuted,
      selfDeafened: push.selfDeafened,
      modMuted: push.modMuted,
      modDeafened: push.modDeafened,
      permMuted: push.permMuted,
    });
    this.state = { marks };
    this.emit();
  }

  /** A member left a voice room — their rows disappear, stale marks are useless.
   *  Moderator marks SURVIVE a re-entry server-side and are re-published on enter. */
  clearUser(username: string): void {
    if (!this.state.marks.has(username)) {
      return;
    }
    const marks = new Map(this.state.marks);
    marks.delete(username);
    this.state = { marks };
    this.emit();
  }

  /** Entering a different voice room — the old room's marks are noise. */
  clearAll(): void {
    if (this.state.marks.size === 0) {
      return;
    }
    this.state = { marks: new Map() };
    this.emit();
  }

  marksFor(username: string): VoiceMemberMarks {
    return this.state.marks.get(username)
      ?? { selfMuted: false, selfDeafened: false, modMuted: false, modDeafened: false, permMuted: false };
  }
}
