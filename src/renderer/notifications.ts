import { decideNotification, messageHasEveryoneHere, messageMentionsRole, messageMentionsUser, type MentionIdentity } from "../domain/logic/notification-decider";
import { toastBodyFallback, toastPreviewSegments } from "../domain/logic/toast-preview";
import { knockSchedule } from "../domain/logic/knock-sound";
import { deafenCue, muteCue } from "../domain/logic/mute-cue";
import {
  CHIME_DECAY_TAU_S,
  CHIME_DURATION_SECONDS,
  CHIME_PARTIALS_HZ,
  CHIME_PARTIAL_GAINS,
  RINGBACK_BURST_SECONDS,
  RINGBACK_TONE_HZ,
  ringbackCycleSeconds,
} from "../domain/logic/call-sounds";
import type { Message } from "../types";
import type { ToastCallCardPayload } from "./bridges";

/**
 * Notification hub: in-app toast stack (bottom-right of the window), OS
 * notifications (the renderer Notification API — Electron supports it directly,
 * no IPC), and a WebAudio-synthesized bell (oak's two-partial ding: E6 + a fifth,
 * fast decay — deliberately NOT a pure sine, which read as a Windows system sound).
 */

/** oak's message ding (NotificationSound.buildMessagePcm): two bell partials,
 *  C6 + a fifth above, the upper one ~7 dB quieter, ONE shared exponential
 *  decay — setTargetAtTime is exactly that curve (τ = 0.10 s) — 4 ms attack,
 *  0.35 s long. Not a pure sine: that read as a Windows system sound. */
const BELL_PARTIALS_HZ = [1046.5, 1570.9];
const BELL_PARTIAL_GAINS = [0.32, 0.14];
const BELL_DECAY_TAU_S = 0.10;
const BELL_ATTACK_S = 0.004;
const BELL_MASTER_GAIN = 0.3;
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
  /** Pre-split body: mention spans tint soft-blurple (user decision); absent on
   *  system toasts. */
  segments?: { text: string; mention: boolean }[];
  onClick?: () => void;
  /** Draws the 2px blurple frame (oak's mention toast). */
  mention?: boolean;
}

class NotificationHub {
  private audioContext: AudioContext | null = null;
  /** The one convergence point of every UI sound (#483): all per-sound masters
   *  connect here instead of the destination, and the share-subtraction
   *  reference taps this bus — so knocks/dings/chimes/ringback leave the share. */
  private mixBus: GainNode | null = null;
  private referenceDest: MediaStreamAudioDestinationNode | null = null;
  /** The selected output device (Settings → Audio), applied to the context sink —
   *  oak plays every UI sound through the playout line so it follows the chosen
   *  speaker; the WebAudio shape of that rule is AudioContext.setSinkId. */
  private outputDeviceId: string | null = null;
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
  /** The incoming-call card's Accept/Decline handler (the runtime answers the
   *  call machine — the toast window only knows the button that was pressed). */
  private callActionHandler: ((action: "accept" | "decline") => void) | null = null;

  constructor() {
    // The toast window reports card clicks by id — run the stored callback.
    window.spaceToast?.onClicked((cardId) => {
      const callback = this.cardCallbacks.get(cardId) ?? null;
      this.cardCallbacks.delete(cardId);
      window.focus(); // bring the app forward first (oak's toast click)
      callback?.();
    });
    window.spaceToast?.onCallAction((action) => {
      window.focus(); // answering a call brings the app forward too
      this.callActionHandler?.(action);
    });
  }

  setToastConfig(config: ToastConfig): void {
    this.toastConfig = config;
  }

  /** Re-points every UI sound at the chosen speaker; remembered for the lazy
   *  context creation. null = the system default (the empty sink id). */
  setOutputDevice(deviceId: string | null): void {
    this.outputDeviceId = deviceId;
    if (this.audioContext !== null) {
      this.setContextSink(this.audioContext, deviceId);
    }
  }

  /** AudioContext.setSinkId exists in Chromium but not in every TS lib —
   *  feature-detect through a narrow structural type (RoomAudio's media-element
   *  trick, applied to the context). */
  private setContextSink(context: AudioContext, deviceId: string | null): void {
    const sinkCapable = context as AudioContext & { setSinkId?: (deviceId: string) => Promise<void> };
    if (typeof sinkCapable.setSinkId === "function") {
      try {
        sinkCapable.setSinkId(deviceId ?? "").catch(() => undefined);
      } catch {
        // a failed sink switch must never take the app down
      }
    }
  }

  /** Lazily creates the shared context ON THE SELECTED DEVICE and wakes it. */
  private ensureAudioContext(): AudioContext {
    if (this.audioContext === null) {
      this.audioContext = new AudioContext();
      if (this.outputDeviceId !== null) {
        this.setContextSink(this.audioContext, this.outputDeviceId);
      }
    }
    const context = this.audioContext;
    if (context.state === "suspended") {
      void context.resume();
    }
    return context;
  }

  /** The bus every sound's master connects to (created with the context). */
  private ensureMixBus(context: AudioContext): GainNode {
    if (this.mixBus === null) {
      this.mixBus = context.createGain();
      this.mixBus.connect(context.destination);
      this.referenceDest = context.createMediaStreamDestination();
      this.mixBus.connect(this.referenceDest);
    }
    return this.mixBus;
  }

  /** The UI sounds as a reference stream for the share subtractor (#483) —
   *  creating the context here is free (a silent context costs nothing). */
  getReferenceStream(): MediaStream {
    this.ensureMixBus(this.ensureAudioContext());
    return this.referenceDest!.stream;
  }

  /** The full decision path for one live message. self = the signed-in user's
   *  id/roles on the sending instance (mention match key). forceMention = the DM
   *  rule (every direct message counts as a mention); onClick routes the toast click. */
  handleMessage(
    message: Message,
    self: MentionIdentity,
    channelName: string,
    windowFocused: boolean,
    inOpenChannel: boolean,
    prefs: ToastDecisionPrefs,
    onClick?: () => void,
    forceMention = false,
    /** The RENDERED author name (the nickname, resolved by the caller against
     *  the live roster) — falls back to the wire's authorUsername. */
    authorName?: string,
  ): void {
    // ONE mention formula shared by the decision AND the toast frame: a direct
    // @user, a held @role, or an UNSUPPRESSED @everyone/@here (live report: the
    // sound fired for @everyone while the frame stayed neutral — the local flag
    // missed the everyone branch the decider adds internally).
    const effectiveMention = forceMention
      || messageMentionsUser(message.mentions, self.userId)
      || messageMentionsRole(message.mentions, self.roleIds)
      || (messageHasEveryoneHere(message.mentions) && !prefs.suppressEveryoneHere);
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
    // Tint ONLY spans that ping the recipient — my @user, a role I hold, an
    // unsuppressed @everyone (live report: every valid mention lit up grey-equal).
    const segments = toastPreviewSegments(message.content, message.mentions, {
      userId: self.userId,
      roleIds: self.roleIds,
      suppressEveryoneHere: prefs.suppressEveryoneHere,
    });
    this.showToast({
      title: authorName ?? message.authorUsername,
      channelName,
      body: segments.length > 0 ? segments.map((segment) => segment.text).join("") : toastBodyFallback(message),
      segments: segments.length > 0 ? segments : undefined,
      onClick,
      // The blurple frame follows the MENTION, not the sound decision (oak passes
      // the mention flag into the toast; a mention with sound off still frames).
      mention: effectiveMention,
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
      kind: "message",
      card: {
        id: cardId,
        title: payload.title,
        channelName: payload.channelName,
        body: payload.body,
        segments: payload.segments, // the tinted spans (dropped here once — everything rendered grey)
        mention: payload.mention === true,
        dismissSeconds: this.toastConfig.dismissSeconds(),
        maxToasts: this.toastConfig.maxToasts(),
      },
    });
  }

  /** The sticky incoming-call card (oak's CallOverlay): bottom-right of the
   *  SCREEN, above every window, no TTL — it outranks message toasts (the stack
   *  clears and goes quiet while it is up) and dies only when the call machine
   *  tears it down. */
  showCallCard(card: ToastCallCardPayload): void {
    window.spaceToast?.show({ kind: "call", card });
  }

  /** The call card survives Accept — it just stops offering buttons and reads
   *  "Connecting…" until the offer arrives (oak keeps the card through the gap). */
  updateCallCardStatus(status: ToastCallCardPayload["status"]): void {
    window.spaceToast?.show({ kind: "call-status", status });
  }

  dismissCallCard(): void {
    window.spaceToast?.show({ kind: "call-end" });
  }

  /** The runtime's Accept/Decline answer point for the call card. */
  setCallActionHandler(handler: (action: "accept" | "decline") => void): void {
    this.callActionHandler = handler;
  }

  /** The voice-room knock (oak's tuned "tuk … tuk"): bare sines, 3 ms attack,
   *  τ=20 ms decay — dry thumps, not beeps. Join goes up, leave goes down. */
  playKnock(direction: "join" | "leave"): void {
    try {
      const context = this.ensureAudioContext();
      const now = context.currentTime;
      const master = context.createGain();
      master.gain.value = 0.5;
      master.connect(this.ensureMixBus(context));
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

  /** The HOTKEY mute/unmute cue (user decision 2026-09-18): one gliding sweep —
   *  rising when the mic returns, falling when it mutes — in a register far above
   *  the knock's dry thumps. The user is in an unfocused game: the sound IS the
   *  feedback, no toast is shown. Gated by the app's sound switch like every
   *  other UI sound (the runtime checks it — audio must never decide policy). */
  playMuteCue(muted: boolean): void {
    this.playSweep(muteCue(muted));
  }

  /** The deafen twin of the mute cue (user request): the SAME sweep shape one
   *  register lower — falling when deafen engages, rising when it lifts. */
  playDeafenCue(deafened: boolean): void {
    this.playSweep(deafenCue(deafened));
  }

  /** One oscillator, one glide, one soft envelope — the shared shape of both
   *  voice-state cues. */
  private playSweep(cue: ReturnType<typeof muteCue>): void {
    try {
      const context = this.ensureAudioContext();
      const now = context.currentTime;
      const master = context.createGain();
      master.gain.value = cue.gain;
      master.connect(this.ensureMixBus(context));
      const envelope = context.createGain();
      envelope.gain.setValueAtTime(0, now);
      envelope.gain.linearRampToValueAtTime(1, now + cue.attackSeconds);
      envelope.gain.exponentialRampToValueAtTime(0.001, now + cue.durationSeconds);
      envelope.connect(master);
      const oscillator = context.createOscillator();
      oscillator.frequency.setValueAtTime(cue.fromHz, now);
      oscillator.frequency.linearRampToValueAtTime(cue.toHz, now + cue.durationSeconds);
      oscillator.connect(envelope);
      oscillator.start(now);
      oscillator.stop(now + cue.durationSeconds);
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
        // The factory (not a bare `??=`): the ringback must follow the chosen
        // output device like every other UI sound (pre-existing bypass, fixed).
        const context = this.ensureAudioContext();
        const now = context.currentTime;
        const master = context.createGain();
        master.gain.value = 0.08; // phone-line quiet — it loops for up to a minute
        master.connect(this.ensureMixBus(context));
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

  /** Callee's chime: ONE long fading bell per incoming call (not a repeating ring).
   *  oak's CallChime recipe: the three partials share ONE exponential decay —
   *  setTargetAtTime IS that e^(-t/τ) curve with τ = 0.55 s. */
  playChime(): void {
    try {
      const context = this.ensureAudioContext();
      const now = context.currentTime;
      const master = context.createGain();
      master.gain.value = 1;
      master.connect(this.ensureMixBus(context));
      CHIME_PARTIALS_HZ.forEach((frequency, index) => {
        const oscillator = context.createOscillator();
        oscillator.frequency.value = frequency;
        const envelope = context.createGain();
        const peak = CHIME_PARTIAL_GAINS[index] ?? 0;
        envelope.gain.setValueAtTime(0, now);
        envelope.gain.linearRampToValueAtTime(peak, now + 0.004);
        envelope.gain.setTargetAtTime(0, now + 0.004, CHIME_DECAY_TAU_S);
        oscillator.connect(envelope);
        envelope.connect(master);
        oscillator.start(now);
        oscillator.stop(now + CHIME_DURATION_SECONDS);
      });
    } catch {
      // audio must never take the app down
    }
  }

  /** The mention/DM ding — oak's bell recipe (see BELL_* constants). */
  playBell(): void {
    try {
      const context = this.ensureAudioContext();
      const now = context.currentTime;
      const master = context.createGain();
      master.gain.value = BELL_MASTER_GAIN;
      master.connect(this.ensureMixBus(context));
      BELL_PARTIALS_HZ.forEach((frequency, index) => {
        const peak = BELL_PARTIAL_GAINS[index] ?? 1;
        const oscillator = context.createOscillator();
        oscillator.frequency.value = frequency;
        const envelope = context.createGain();
        envelope.gain.setValueAtTime(0, now);
        envelope.gain.linearRampToValueAtTime(peak, now + BELL_ATTACK_S);
        // setTargetAtTime IS the exponential decay e^(-t/τ) — oak's shared envelope
        envelope.gain.setTargetAtTime(0, now + BELL_ATTACK_S, BELL_DECAY_TAU_S);
        oscillator.connect(envelope);
        envelope.connect(master);
        oscillator.start(now);
        oscillator.stop(now + BELL_DURATION_S);
      });
    } catch {
      // audio must never take the app down
    }
  }
}

export const notifications = new NotificationHub();
