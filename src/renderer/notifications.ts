import { decideNotification, messageMentionsUser } from "../domain/logic/notification-decider";
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

  /** The full decision path for one live message. */
  handleMessage(message: Message, ownUsername: string, channelName: string, windowFocused: boolean, inOpenChannel: boolean): void {
    const mention = messageMentionsUser(message.mentions, ownUsername);
    const action = decideNotification({ mention, windowFocused, inOpenChannel });
    if (action === "none") {
      return;
    }
    this.showToast({
      title: message.authorUsername,
      channelName,
      body: (message.content?.length ?? 0) > 0 ? message.content! : "(attachment)",
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
