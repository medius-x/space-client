import { Emitter } from "../domain/lib/store";
import { log } from "../logging";
import type { RestClient } from "../core/rest";

/**
 * ONE audio track for the whole app (oak's MediaPlaybackService posture): a new
 * track replaces and disposes the previous one; the card is a repaintable view,
 * the pinned NowPlayingBar survives whatever scrolls. Fresh-link recovery: a
 * stream that outlived its presigned URL re-mints once and resumes at the
 * position where it died.
 */

export interface PlaybackState {
  key: string | null;
  fileName: string | null;
  playing: boolean;
  positionSeconds: number;
  durationSeconds: number;
  volume: number;
}

const IDLE: PlaybackState = {
  key: null,
  fileName: null,
  playing: false,
  positionSeconds: 0,
  durationSeconds: 0,
  volume: 1,
};

export class PlaybackService extends Emitter {
  private state: PlaybackState = IDLE;
  private audio: HTMLAudioElement | null = null;
  private rest: (() => RestClient | null) | null = null;
  private recoveryTried = false;

  getSnapshot = (): PlaybackState => this.state;

  private patch(partial: Partial<PlaybackState>): void {
    this.state = { ...this.state, ...partial };
    this.emit();
  }

  /** Wire the recovery client once the session owns a RestClient. */
  bindRest(rest: () => RestClient | null): void {
    this.rest = rest;
  }

  private ensureAudio(): HTMLAudioElement {
    if (this.audio === null) {
      const audio = new Audio();
      audio.addEventListener("timeupdate", () => {
        this.patch({ positionSeconds: audio.currentTime });
      });
      audio.addEventListener("durationchange", () => {
        if (Number.isFinite(audio.duration)) {
          this.patch({ durationSeconds: audio.duration });
        }
      });
      audio.addEventListener("ended", () => {
        this.patch({ playing: false, positionSeconds: 0 });
      });
      audio.addEventListener("error", () => {
        void this.recover();
      });
      this.audio = audio;
    }
    return this.audio;
  }

  isCurrent(key: string): boolean {
    return this.state.key === key;
  }

  async play(key: string, fileName: string, url: string): Promise<void> {
    if (this.state.key === key && this.audio !== null) {
      // Same track: toggle. A paused resume must NOT reassign src — that resets position.
      if (this.state.playing) {
        this.pause();
        return;
      }
      try {
        await this.audio.play();
        this.patch({ playing: true });
      } catch {
        this.patch({ playing: false });
      }
      return;
    }
    this.recoveryTried = false;
    this.patch({ key, fileName, positionSeconds: 0, durationSeconds: 0, volume: this.state.volume });
    const audio = this.ensureAudio();
    audio.src = url;
    audio.volume = this.state.volume;
    try {
      await audio.play();
      this.patch({ playing: true });
    } catch {
      this.patch({ playing: false });
    }
  }

  pause(): void {
    if (this.audio !== null) {
      this.audio.pause();
    }
    this.patch({ playing: false });
  }

  /** Resume the current paused track without touching src (keeps the position). */
  async resume(): Promise<void> {
    if (this.audio === null || this.state.key === null || this.state.playing) {
      return;
    }
    try {
      await this.audio.play();
      this.patch({ playing: true });
    } catch {
      this.patch({ playing: false });
    }
  }

  seek(seconds: number): void {
    if (this.audio !== null && Number.isFinite(seconds)) {
      this.audio.currentTime = seconds;
      this.patch({ positionSeconds: seconds });
    }
  }

  setVolume(volume: number): void {
    const clamped = Math.min(1, Math.max(0, volume));
    if (this.audio !== null) {
      this.audio.volume = clamped;
    }
    this.patch({ volume: clamped });
  }

  stop(): void {
    if (this.audio !== null) {
      this.audio.pause();
      this.audio.removeAttribute("src");
    }
    this.state = { ...IDLE, volume: this.state.volume };
    this.emit();
  }

  private async recover(): Promise<void> {
    const key = this.state.key;
    if (key === null || this.recoveryTried || this.rest === null) {
      this.patch({ playing: false });
      return;
    }
    this.recoveryTried = true;
    const client = this.rest();
    if (client === null) {
      return;
    }
    const diedAt = this.state.positionSeconds;
    const fresh = await client.freshAttachmentLink(key).catch((error: unknown) => {
      log.warn("playback", `fresh link failed for ${key}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    if (fresh === null || fresh === undefined || this.state.key !== key) {
      log.warn("playback", `audio load failed, no fresh link: url=${this.audio?.src ?? "-"} key=${key ?? "-"}`);
      this.patch({ playing: false });
      return;
    }
    log.info("playback", `recovery: ${this.audio?.src ?? "-"} -> ${fresh}`);
    const audio = this.ensureAudio();
    audio.src = fresh;
    audio.currentTime = diedAt;
    try {
      await audio.play();
      this.patch({ playing: true });
    } catch {
      this.patch({ playing: false });
    }
  }
}
