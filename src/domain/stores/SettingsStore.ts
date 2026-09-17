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
  /** Ring timeout; 0 = ring forever (still ends on any hangup signal). Also
   *  bounds the callee's accept→offer gap (re-armed on Accept — oak). */
  ringTimeoutSeconds: number;
  /** The noise-suppression ENGINE (user decision 2026-09-17): the built-in
   *  WebRTC suppressor is gone — RNNoise replaces it, DeepFilterNet3 is the
   *  heavyweight alternative, off = deliberately raw. AEC/AGC have NO knob:
   *  they stay always-on at the capture constraints (echo hurts the other
   *  listeners, not the one toggling). */
  noiseSuppressionEngine: "off" | "rnnoise" | "deepfilternet3";
  /** DeepFilterNet3's suppression limit in dB — the engine's own native knob
   *  (0–100): 0 = no limit (the deepest suppression), higher = gentler.
   *  RNNoise has no such knob. */
  deepFilterSuppressionLevel: number;
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
  ringTimeoutSeconds: 120, // oak's default (SettingsStore.java)
  noiseSuppressionEngine: "rnnoise",
  deepFilterSuppressionLevel: 50, // effectively "no limit" at DFN3's native scale
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
    const stored = await kv.get<Partial<ClientSettings> & { apmEnabled?: boolean }>(KV_KEY);
    if (stored !== null) {
      const { apmEnabled, ...rest } = stored;
      this.settings = { ...DEFAULT_CLIENT_SETTINGS, ...rest };
      // Migration (2026-09-17): the one APM flag used to gate echo+NS+AGC
      // together. AEC/AGC became always-on; the NS slot became an engine.
      // false meant "Raw (off)"; true (the old default) upgrades to RNNoise.
      if (apmEnabled !== undefined && rest.noiseSuppressionEngine === undefined) {
        this.settings = {
          ...this.settings,
          noiseSuppressionEngine: apmEnabled ? "rnnoise" : "off",
        };
      }
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
