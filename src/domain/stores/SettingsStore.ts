import { Emitter } from "../lib/store";
import { kv } from "../persistence/kv-client";

/**
 * App-wide client settings (oak's SettingsStore — the M7 subset that maps onto
 * what this client actually has; device pickers and themes do not exist in
 * Chromium-by-default mode, the avatar editor already lives in ProfileModal).
 * Write-through: apply() patches memory + KV immediately; the UI has no Apply
 * button — every control takes effect at once (the staged-Apply dance of the oak
 * client buys nothing with instant-apply Web settings).
 */
export interface ClientSettings {
  /** false = Enter sends, Ctrl/Shift+Enter newline (oak default). */
  ctrlEnterSends: boolean;
  /** 0 = disk cache off (memory-only); LRU cap otherwise. */
  imageCacheMegabytes: number;
  notificationsEnabled: boolean;
  /** Mention bell; toasts stay on when off. */
  soundEnabled: boolean;
  /** Unread counters in the sidebar/Home badge. */
  badgeEnabled: boolean;
  toastDismissSeconds: number;
  maxToasts: number;
  /** Outgoing ring timeout; 0 = ring forever (still ends on any hangup signal). */
  ringTimeoutSeconds: number;
  /** Chromium APM (echo cancellation et al) on the mic path. */
  apmEnabled: boolean;
}

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = {
  ctrlEnterSends: false,
  imageCacheMegabytes: 256,
  notificationsEnabled: true,
  soundEnabled: true,
  badgeEnabled: true,
  toastDismissSeconds: 5,
  maxToasts: 3,
  ringTimeoutSeconds: 60,
  apmEnabled: true,
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
