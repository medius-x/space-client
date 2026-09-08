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
  private stackElement: HTMLDivElement | null = null;
  private audioContext: AudioContext | null = null;
  private ringbackTimer: number | null = null;
  /** The CURRENT burst's master gain — stopRingback cuts it instead of letting it play out. */
  private ringbackGain: GainNode | null = null;
  private toastConfig: ToastConfig = {
    dismissSeconds: () => 5,
    maxToasts: () => 3,
  };

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
    if (!windowFocused) {
      this.showSystem(message.authorUsername, channelName, message.content);
    }
  }

  showToast(payload: ToastPayload): void {
    const stack = this.ensureStack();
    // Cards only (the Hide-all chip sits at the top of the stack, oak layout).
    const cards = [...stack.children].filter((child) => child.classList.contains("toast-card"));
    while (cards.length >= this.toastConfig.maxToasts()) {
      cards.shift()?.remove();
    }
    const card = document.createElement("div");
    card.className = "toast-card" + (payload.mention === true ? " mention" : "");
    const header = document.createElement("div");
    header.className = "toast-header";
    header.textContent = payload.channelName;
    const author = document.createElement("div");
    author.className = "toast-author";
    author.textContent = payload.title;
    const body = document.createElement("div");
    body.className = "toast-body";
    body.textContent = payload.body.slice(0, 140);
    card.append(header, author, body);
    // Dismiss (timeout or click) also PRUNES the stack: with no cards left the
    // chip and the stack element go too — "Hide all" must not outlive the cards
    // (live report).
    const dismiss = () => {
      card.remove();
      if (stack.querySelector(".toast-card") === null) {
        stack.remove();
      }
    };
    card.addEventListener("click", () => {
      payload.onClick?.();
      dismiss();
    });
    // Newest on top — right under the Hide-all chip.
    stack.insertBefore(card, this.hideAllChip(stack).nextSibling);
    window.setTimeout(dismiss, this.toastConfig.dismissSeconds() * 1000);
  }

  /** The stack's persistent "Hide all" chip (created on first use). */
  private hideAllChip(stack: HTMLDivElement): HTMLElement {
    const existing = stack.querySelector<HTMLElement>(".toast-hide-all");
    if (existing !== null) {
      return existing;
    }
    const chip = document.createElement("button");
    chip.className = "toast-hide-all";
    chip.textContent = "Hide all";
    chip.addEventListener("click", () => {
      for (const card of [...stack.querySelectorAll(".toast-card")]) {
        card.remove();
      }
      stack.remove(); // everything is dismissed — the chip goes with the stack
    });
    stack.prepend(chip);
    return chip;
  }

  showSystem(author: string, channelName: string, body: string | null): void {
    if (typeof Notification === "undefined" || Notification.permission === "denied") {
      return;
    }
    const show = () => {
      const notification = new Notification(`${author} · #${channelName}`, { body: (body ?? "").slice(0, 200), silent: true });
      notification.addEventListener("click", () => {
        window.focus();
      });
    };
    if (Notification.permission === "granted") {
      show();
    } else {
      void Notification.requestPermission().then((permission) => {
        if (permission === "granted") {
          show();
        }
      });
    }
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

  private ensureStack(): HTMLDivElement {
    if (this.stackElement === null || !document.body.contains(this.stackElement)) {
      this.stackElement = document.createElement("div");
      this.stackElement.className = "toast-stack";
      document.body.appendChild(this.stackElement);
    }
    return this.stackElement;
  }
}

export const notifications = new NotificationHub();
