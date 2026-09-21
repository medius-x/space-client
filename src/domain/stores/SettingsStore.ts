import { Emitter } from "../lib/store";
import { kv } from "../persistence/kv-client";
import { DEFAULT_KEYBINDS, resolveKeybinds, type ActionId } from "../logic/keybinds";
import type { SavedSharePreset } from "../logic/share-quality";

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
   *  heavyweight alternative, Speex/Gate/DTLN widen the choice, off =
   *  deliberately raw. AEC/AGC have NO knob: they stay always-on at the
   *  capture constraints (echo hurts the other listeners, not the one
   *  toggling). */
  noiseSuppressionEngine: "off" | "rnnoise" | "deepfilternet3" | "speex" | "gate" | "dtln";
  /** DeepFilterNet3's suppression limit in dB — the engine's own native knob
   *  (0–100): 0 = no limit (the deepest suppression), higher = gentler.
   *  RNNoise has no such knob. */
  deepFilterSuppressionLevel: number;
  /** Device picks (oak Audio/Video): null = system default. Mic/camera apply
   *  on the next capture; the speaker switches live via setSinkId. The LABELS
   *  ride alongside: Chromium's deviceId hashes are NOT stable across app
   *  restarts here, so restoration re-resolves by label (device-match.ts). */
  microphoneDeviceId: string | null;
  microphoneLabel: string | null;
  speakerDeviceId: string | null;
  speakerLabel: string | null;
  cameraDeviceId: string | null;
  cameraLabel: string | null;
  /** Keyboard shortcuts (2026-09-18): action id → accelerator ("" = unbound).
   *  Global-scope entries register OS-wide through the main process — the mute
   *  toggle works from an unfocused game; local entries match a window keydown. */
  keybinds: Partial<Record<ActionId, string>>;
  /** User-saved share-quality presets (the picker's Quality step, oak's
   *  sharePresets): the Save row upserts here, cap 30 in upsertPreset. */
  sharePresets: SavedSharePreset[];
  /** The audio checkbox seeds per source kind (oak persists per kind too) —
   *  the last checkbox state pre-checks the next share of that kind. */
  shareScreenAudio: boolean;
  shareWindowAudio: boolean;
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
  microphoneLabel: null,
  speakerDeviceId: null,
  speakerLabel: null,
  cameraDeviceId: null,
  cameraLabel: null,
  keybinds: { ...DEFAULT_KEYBINDS },
  sharePresets: [],
  shareScreenAudio: true,
  shareWindowAudio: true,
};

const KV_KEY = "client-settings";

/** The selectable engine catalog (mirrors media/noise-suppression's union —
 *  domain cannot import from media, an accepted literal duplication). */
const NS_ENGINES = ["off", "rnnoise", "deepfilternet3", "speex", "gate", "dtln"] as const;

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
      // A stored engine may be gone from the catalog later (dtln was briefly
      // dropped 2026-09-17 and returned the same day) — fall back to the
      // default instead of a dead value.
      if (!NS_ENGINES.includes(this.settings.noiseSuppressionEngine)) {
        this.settings = { ...this.settings, noiseSuppressionEngine: DEFAULT_CLIENT_SETTINGS.noiseSuppressionEngine };
      }
      // Keybinds: defaults ⊕ stored ("" stays unbound, garbage falls back to the
      // default, ids not in the catalog are dropped — the same forward-compat
      // sanitize as the engine list above).
      this.settings = { ...this.settings, keybinds: resolveKeybinds(rest.keybinds ?? {}) };
      // Presets ride as an opaque list — anything not an array is stale/garbage.
      if (!Array.isArray(this.settings.sharePresets)) {
        this.settings = { ...this.settings, sharePresets: [] };
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
