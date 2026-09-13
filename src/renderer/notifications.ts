import { decideNotification, messageHasEveryoneHere, messageMentionsUserDirect } from "../domain/logic/notification-decider";
import { knockSchedule } from "../domain/logic/knock-sound";
import {
  CHIME_DURATION_SECONDS,
  CHIME_PARTIALS_HZ,
  CHIME_PARTIAL_GAINS,
  RINGBACK_BURST_SECONDS,
  RINGBACK_TONE_HZ,
  ringbackCycleSeconds,
} from "../domain/logic/call-sounds";
import type { Message } from "../types";

/**
 * Notification hub: in-app toast stack (bottom-right of the window), OS
 * notifications (the renderer Notification API — Electron supports it directly,
 * no IPC), and a WebAudio-synthesized bell (oak's two-partial ding: E6 + a fifth,
 * fast decay — deliberately NOT a pure sine, which read as a Windows system sound).
 */

const BELL_PARTIALS = [1_318.51, 1_975.53]; // E6 + B6
const BELL_DURATION_S = 0.35;

/** Per-server + master switches the decider needs (assembled by the runtime). */
export interface ToastDecisionPrefs {
  serverMode: "ALL" | "MENTIONS" | "NOTHING";
  suppressEveryoneHere: boolean;
  notificationsEnabled: boolean;
  soundEnabled: boolean;
}

/** Toast stack tuning — live accessors over the settings store. */
export interface ToastConfig {
  dismissSeconds(): number;
  maxToasts(): number;
}

export interface ToastPayload {
  title: string;
  channelName: string;
  body: string;
  onClick?: () => void;
  /** Draws the 2px blurple frame (oak's mention toast). */
  mention?: boolean;
}

class NotificationHub {
  private audioContext: AudioContext | null = null;
  private ringbackTimer: number | null = null;
  /** The CURRENT burst's master gain — stopRingback cuts it instead of letting it play out. */
  private ringbackGain: GainNode | null = null;
  private toastConfig: ToastConfig = {
    dismissSeconds: () => 5,
    maxToasts: () => 3,
  };
  /** Card ids → their onClick callbacks (they close over runtime state, so they
   *  run HERE in the main window; the toast window only knows the id). */
  private readonly cardCallbacks = new Map<number, (() => void) | null>();
  private nextCardId = 1;

  constructor() {
    // The toast window reports card clicks by id — run the stored callback.
    window.spaceToast?.onClicked((cardId) => {
      const callback = this.cardCallbacks.get(cardId) ?? null;
      this.cardCallbacks.delete(cardId);
      window.focus(); // bring the app forward first (oak's toast click)
      callback?.();
    });
  }

  setToastConfig(config: ToastConfig): void {
    this.toastConfig = config;
  }

  /** The full decision path for one live message. forceMention = the DM rule
   *  (every direct message counts as a mention); onClick routes the toast click. */
  handleMessage(
    message: Message,
    ownUsername: string,
    channelName: string,
    windowFocused: boolean,
    inOpenChannel: boolean,
    prefs: ToastDecisionPrefs,
    onClick?: () => void,
    forceMention = false,
  ): void {
    const effectiveMention = forceMention || messageMentionsUserDirect(message.mentions, ownUsername);
    const action = decideNotification({
      mention: effectiveMention,
      everyoneHere: messageHasEveryoneHere(message.mentions),
      windowFocused,
      inOpenChannel,
      serverMode: prefs.serverMode,
      suppressEveryoneHere: prefs.suppressEveryoneHere,
      notificationsEnabled: prefs.notificationsEnabled,
      soundEnabled: prefs.soundEnabled,
    });
    if (action === "none") {
      return;
    }
    this.showToast({
      title: message.authorUsername,
      channelName,
      body: (message.content?.length ?? 0) > 0 ? message.content! : "(attachment)",
      onClick,
      mention: action === "toast-sound" && effectiveMention,
    });
    if (action === "toast-sound") {
      this.playBell();
    }
  }

  /** Cards render in the ALWAYS-ON-TOP toast window (oak's NotificationToast):
   *  visible above every window, even with the app minimized. The callback stays
   *  here — the toast window reports the click by id. Without the bridge (tests,
   *  plain browsers) the toast is dropped silently. */
  showToast(payload: ToastPayload): void {
    const toastBridge = window.spaceToast;
    if (toastBridge === undefined) {
      return;
    }
    const cardId = this.nextCardId;
    this.nextCardId += 1;
    this.cardCallbacks.set(cardId, payload.onClick ?? null);
    toastBridge.show({
      id: cardId,
      title: payload.title,
      channelName: payload.channelName,
      body: payload.body,
      mention: payload.mention === true,
      dismissSeconds: this.toastConfig.dismissSeconds(),
      maxToasts: this.toastConfig.maxToasts(),
    });
  }

  /** The voice-room knock (oak's tuned "tuk … tuk"): bare sines, 3 ms attack,
   *  τ=20 ms decay — dry thumps, not beeps. Join goes up, leave goes down. */
  playKnock(direction: "join" | "leave"): void {
    try {
      this.audioContext ??= new AudioContext();
      const context = this.audioContext;
      if (context.state === "suspended") {
        void context.resume();
      }
      const now = context.currentTime;
      const master = context.createGain();
      master.gain.value = 0.5;
      master.connect(context.destination);
      for (const note of knockSchedule(direction)) {
        const startAt = now + note.startSeconds;
        const envelope = context.createGain();
        envelope.gain.setValueAtTime(0, startAt);
        envelope.gain.linearRampToValueAtTime(1, startAt + 0.003); // 3 ms attack
        envelope.gain.exponentialRampToValueAtTime(0.001, startAt + note.durationSeconds); // τ ≈ 20 ms decay
        const oscillator = context.createOscillator();
        oscillator.frequency.value = note.frequencyHz;
        oscillator.connect(envelope);
        envelope.connect(master);
        oscillator.start(startAt);
        oscillator.stop(startAt + note.durationSeconds);
      }
    } catch {
      // audio must never take the app down
    }
  }

  /** Caller's ringback: the dual-tone 440+480 Hz cadence, looped until stopped. */
  startRingback(): void {
    if (this.ringbackTimer !== null) {
      return;
    }
    const playBurst = (): void => {
      try {
        this.audioContext ??= new AudioContext();
        const context = this.audioContext;
        if (context.state === "suspended") {
          void context.resume();
        }
        const now = context.currentTime;
        const master = context.createGain();
        master.gain.value = 0.08; // phone-line quiet — it loops for up to a minute
        master.connect(context.destination);
        for (const frequency of RINGBACK_TONE_HZ) {
          const oscillator = context.createOscillator();
          oscillator.frequency.value = frequency;
          oscillator.connect(master);
          oscillator.start(now);
          oscillator.stop(now + RINGBACK_BURST_SECONDS);
        }
        this.ringbackGain = master;
      } catch {
        // audio must never take the app down
      }
    };
    playBurst();
    this.ringbackTimer = window.setInterval(playBurst, ringbackCycleSeconds() * 1000);
  }

  /** Stops the loop AND cuts the in-flight burst — a fast ACCEPT must silence the
   *  ringback instantly, not after the 1.8 s burst finishes (live M5 smoke). */
  stopRingback(): void {
    if (this.ringbackTimer !== null) {
      window.clearInterval(this.ringbackTimer);
      this.ringbackTimer = null;
    }
    const gain = this.ringbackGain;
    if (gain !== null) {
      this.ringbackGain = null;
      try {
        const context = this.audioContext!;
        gain.gain.cancelScheduledValues(context.currentTime);
        gain.gain.setValueAtTime(gain.gain.value, context.currentTime);
        gain.gain.linearRampToValueAtTime(0, context.currentTime + 0.03); // 30 ms cut
      } catch {
        // context may be gone — the oscillators stop on their own anyway
      }
    }
  }

  /** Callee's chime: ONE long fading bell per incoming call (not a repeating ring). */
  playChime(): void {
    try {
      this.audioContext ??= new AudioContext();
      const context = this.audioContext;
      if (context.state === "suspended") {
        void context.resume();
      }
      const now = context.currentTime;
      const master = context.createGain();
      master.gain.value = 0.12;
      master.connect(context.destination);
      CHIME_PARTIALS_HZ.forEach((frequency, index) => {
        const oscillator = context.createOscillator();
        oscillator.frequency.value = frequency;
        const envelope = context.createGain();
        const peak = CHIME_PARTIAL_GAINS[index] ?? 1;
        envelope.gain.setValueAtTime(0, now);
        envelope.gain.linearRampToValueAtTime(peak, now + 0.004);
        envelope.gain.exponentialRampToValueAtTime(0.001 * peak, now + CHIME_DURATION_SECONDS);
        oscillator.connect(envelope);
        envelope.connect(master);
        oscillator.start(now);
        oscillator.stop(now + CHIME_DURATION_SECONDS);
      });
    } catch {
      // audio must never take the app down
    }
  }

  /** Two-partial bell: quick attack, exponential decay — a "ding", not a beep. */
  playBell(): void {
    try {
      this.audioContext ??= new AudioContext();
      const context = this.audioContext;
      if (context.state === "suspended") {
        void context.resume();
      }
      const now = context.currentTime;
      const master = context.createGain();
      master.gain.value = 0.12;
      master.connect(context.destination);
      for (const frequency of BELL_PARTIALS) {
        const oscillator = context.createOscillator();
        oscillator.frequency.value = frequency;
        const envelope = context.createGain();
        envelope.gain.setValueAtTime(0, now);
        envelope.gain.linearRampToValueAtTime(1, now + 0.003);
        envelope.gain.exponentialRampToValueAtTime(0.001, now + BELL_DURATION_S);
        oscillator.connect(envelope);
        envelope.connect(master);
        oscillator.start(now);
        oscillator.stop(now + BELL_DURATION_S);
      }
    } catch {
      // audio must never take the app down
    }
  }
}

export const notifications = new NotificationHub();
