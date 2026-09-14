import { Emitter } from "../lib/store";
import { kv } from "../persistence/kv-client";

/**
 * App-wide client settings (oak's SettingsStore — the M7 subset that maps onto
 * what this client actually has; device pickers and themes do not exist in
 * Chromium-by-default mode, the avatar editor already lives in ProfileModal).
 * apply() is the COMMIT write (memory + KV): the user-settings Audio/Video/
 * Appearance/Notifications sections stage a draft and call it from the
 * window-level Apply button, oak's model; the live effects (speaker switch,
 * cache budget) ride the same commit in the modal.
 */
export interface ClientSettings {
  /** false = Enter sends, Ctrl/Shift+Enter newline (oak default). */
  ctrlEnterSends: boolean;
  /** false = message timestamps always show the full date (oak Appearance). */
  relativeDates: boolean;
  /** 0 = disk cache off (memory-only); LRU cap otherwise. */
  imageCacheMegabytes: number;
  notificationsEnabled: boolean;
  /** The app's sound switch: the mention ding AND the voice-room join/leave
   *  knocks ride it (one switch, explicit label — user decision 2026-09-15);
   *  toasts stay on when off. */
  soundEnabled: boolean;
  /** Unread counters in the sidebar/Home badge. */
  badgeEnabled: boolean;
  toastDismissSeconds: number;
  maxToasts: number;
  /** Outgoing ring timeout; 0 = ring forever (still ends on any hangup signal). */
  ringTimeoutSeconds: number;
  /** Chromium APM (echo cancellation et al) on the mic path. */
  apmEnabled: boolean;
  /** Device picks (oak Audio/Video): null = system default. Mic/camera apply
   *  on the next capture; the speaker switches live via setSinkId. */
  microphoneDeviceId: string | null;
  speakerDeviceId: string | null;
  cameraDeviceId: string | null;
}

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = {
  ctrlEnterSends: false,
  relativeDates: true,
  imageCacheMegabytes: 256,
  notificationsEnabled: true,
  soundEnabled: true,
  badgeEnabled: true,
  toastDismissSeconds: 5,
  maxToasts: 3,
  ringTimeoutSeconds: 60,
  apmEnabled: true,
  microphoneDeviceId: null,
  speakerDeviceId: null,
  cameraDeviceId: null,
};

const KV_KEY = "client-settings";

export class SettingsStore extends Emitter {
  private settings: ClientSettings = { ...DEFAULT_CLIENT_SETTINGS };
  private loaded = false;

  getSnapshot = (): ClientSettings => this.settings;

  isLoaded(): boolean {
    return this.loaded;
  }

  async load(): Promise<void> {
    const stored = await kv.get<Partial<ClientSettings>>(KV_KEY);
    if (stored !== null) {
      this.settings = { ...DEFAULT_CLIENT_SETTINGS, ...stored };
    }
    this.loaded = true;
    this.emit();
  }

  /** Instant-apply write-through; returns the resulting snapshot. */
  apply(partial: Partial<ClientSettings>): ClientSettings {
    this.settings = { ...this.settings, ...partial };
    this.emit();
    void kv.set(KV_KEY, this.settings);
    return this.settings;
  }
}
