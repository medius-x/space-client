import { decideNotification, messageMentionsUser } from "../domain/logic/notification-decider";
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

const TOAST_CAP = 3;
const TOAST_TTL_MS = 5_000;
const BELL_PARTIALS = [1_318.51, 1_975.53]; // E6 + B6
const BELL_DURATION_S = 0.35;

export interface ToastPayload {
  title: string;
  channelName: string;
  body: string;
  onClick?: () => void;
}

class NotificationHub {
  private stackElement: HTMLDivElement | null = null;
  private audioContext: AudioContext | null = null;
  private ringbackTimer: number | null = null;
  /** The CURRENT burst's master gain — stopRingback cuts it instead of letting it play out. */
  private ringbackGain: GainNode | null = null;

  /** The full decision path for one live message. forceMention = the DM rule
   *  (every direct message counts as a mention); onClick routes the toast click. */
  handleMessage(message: Message, ownUsername: string, channelName: string, windowFocused: boolean, inOpenChannel: boolean, forceMention = false, onClick?: () => void): void {
    const mention = forceMention || messageMentionsUser(message.mentions, ownUsername);
    const action = decideNotification({ mention, windowFocused, inOpenChannel });
    if (action === "none") {
      return;
    }
    this.showToast({
      title: message.authorUsername,
      channelName,
      body: (message.content?.length ?? 0) > 0 ? message.content! : "(attachment)",
      onClick,
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
    while (stack.children.length >= TOAST_CAP) {
      stack.firstElementChild?.remove();
    }
    const card = document.createElement("div");
    card.className = "toast-card";
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
    card.addEventListener("click", () => {
      payload.onClick?.();
      card.remove();
    });
    stack.appendChild(card);
    window.setTimeout(() => card.remove(), TOAST_TTL_MS);
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
