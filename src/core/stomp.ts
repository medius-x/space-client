import { log } from "../logging";
import { STOMP_HEARTBEAT_MS, STOMP_READ_DEAD_MS } from "../config";

/**
 * Minimal STOMP 1.2 client over a RAW WebSocket (the server endpoint /ws is not SockJS).
 * Mirrors the hand-rolled protocol discipline of the Java client: the frame codec is
 * pure and unit-tested; the socket client owns heartbeat, reconnect and re-subscribe.
 */

/** The STOMP frame terminator: NULL octet, kept as an escape so the source stays text. */
const FRAME_TERMINATOR = String.fromCharCode(0);

// ---------------------------------------------------------------------------
// Pure frame codec
// ---------------------------------------------------------------------------

export interface StompFrame {
  command: string;
  headers: Record<string, string>;
  body: string;
}

/** STOMP 1.2 escaping — only header VALUES are escaped. */
function escapeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\c").replace(/\n/g, "\\n");
}

function unescapeValue(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === "\\" && index + 1 < value.length) {
      const next = value[index + 1];
      if (next === "\\") {
        result += "\\";
      } else if (next === "c") {
        result += ":";
      } else if (next === "n") {
        result += "\n";
      } else {
        result += next;
      }
      index++;
    } else {
      result += char;
    }
  }
  return result;
}

export function serializeFrame(frame: StompFrame): string {
  const lines = [frame.command];
  for (const [key, value] of Object.entries(frame.headers)) {
    lines.push(`${key}:${escapeValue(value)}`);
  }
  return `${lines.join("\n")}\n\n${frame.body}${FRAME_TERMINATOR}`;
}

/**
 * Split a receive buffer into complete frames. Tolerates \r\n line endings and strips
 * heartbeat EOLs (frames whose content is empty/whitespace-only). Returns the remainder
 * (a possibly incomplete trailing frame) for the caller to prepend to the next chunk.
 */
export function parseAvailableFrames(buffer: string): { frames: StompFrame[]; remainder: string } {
  const frames: StompFrame[] = [];
  let rest = buffer;
  while (true) {
    const terminator = rest.indexOf(FRAME_TERMINATOR);
    if (terminator === -1) {
      break;
    }
    const rawFrame = rest.slice(0, terminator);
    rest = rest.slice(terminator + 1);
    const frame = parseSingleFrame(rawFrame);
    if (frame) {
      frames.push(frame);
    }
  }
  return { frames, remainder: rest };
}

function parseSingleFrame(raw: string): StompFrame | null {
  // A heartbeat EOL may be glued to the head of a frame within one WS message —
  // strip leading blank lines before looking for the command/header structure.
  const normalized = raw.replace(/\r\n/g, "\n").replace(/^[\r\n]+/, "");
  if (normalized.trim().length === 0) {
    return null; // heartbeat EOL only
  }
  const headerEnd = normalized.indexOf("\n\n");
  const headerBlock = headerEnd === -1 ? normalized : normalized.slice(0, headerEnd);
  const body = headerEnd === -1 ? "" : normalized.slice(headerEnd + 2);
  const lines = headerBlock.split("\n");
  const command = (lines.shift() ?? "").trim();
  if (!command) {
    return null;
  }
  const headers: Record<string, string> = {};
  for (const line of lines) {
    if (!line) {
      continue;
    }
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }
    headers[line.slice(0, separator)] = unescapeValue(line.slice(separator + 1));
  }
  return { command, headers, body };
}

// ---------------------------------------------------------------------------
// Socket client
// ---------------------------------------------------------------------------

export interface StompHandlers {
  /** Abnormal loss only (heartbeat death / socket drop) — a manual disconnect stays silent. */
  onLost(reason: string): void;
  /** Fires after every (re)connect — subscriptions are replayed before this.
   *  `reconnected` distinguishes a REconnect (the session re-syncs whatever the
   *  WS gap swallowed) from the first connect (start() takes its own snapshots). */
  onConnected?(reconnected: boolean): void;
  /** Every second while an attempt is SCHEDULED: the seconds left and the
   *  1-based attempt number — oak's "Reconnecting in Ns… M/10" label. */
  onCountdown?(secondsLeft: number, attempt: number): void;
  /** Fires as a reconnect attempt actually leaves (1-based). */
  onAttempt?(attempt: number): void;
  /** The 10-attempt ladder is exhausted — the cycle STOPS (oak's terminal
   *  "Connection lost"); only a manual reconnectNow() restarts it. */
  onExhausted?(): void;
}

export interface StompClientOptions {
  url: string;
  /** Read FRESH at (re)connect time — the token may have rotated. */
  getAccessToken: () => string;
  webSocketImpl?: typeof WebSocket;
  handlers: StompHandlers;
}

const MAX_BACKOFF_SECONDS = 30;
/** oak's MAX_RECONNECT_ATTEMPTS: after this many failed attempts the ladder
 *  STOPS (terminal "Connection lost") — only a manual ↻ restarts the cycle. */
export const MAX_RECONNECT_ATTEMPTS = 10;

export class StompClient {
  private readonly url: string;
  private readonly getAccessToken: () => string;
  private readonly webSocketImpl: typeof WebSocket;
  private readonly handlers: StompHandlers;

  private socket: WebSocket | null = null;
  private manuallyClosed = false;
  private connected = false;
  private receiveBuffer = "";
  private subscriptionCounter = 0;
  /** destination → handler. Replayed verbatim on reconnect. */
  private readonly subscriptions = new Map<string, (body: string) => void>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  /** oak's 1-second countdown Timeline: ticks the "Reconnecting in Ns…" label
   *  and fires the attempt at zero. */
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  /** True while a (scheduled or manual) reconnect attempt's connect() promise
   *  is unsettled — a ↻ in this window is a no-op: the attempt is already
   *  flying and the counter must not reset (live report). */
  private attemptInFlight = false;
  private reconnectAttempt = 0;
  /** True once ANY connect succeeded — a later CONNECTED is a reconnect (the
   *  gap between them lost every server push; the session resyncs). */
  private everConnected = false;
  private lastSentAt = 0;
  private lastReceivedAt = 0;

  constructor(options: StompClientOptions) {
    this.url = options.url;
    this.getAccessToken = options.getAccessToken;
    this.webSocketImpl = options.webSocketImpl ?? WebSocket;
    this.handlers = options.handlers;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Opens the socket and resolves on CONNECTED (rejects on ERROR / first-failure close). */
  connect(): Promise<void> {
    if (this.connected) {
      return Promise.resolve();
    }
    this.manuallyClosed = false;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const socket = new this.webSocketImpl(this.url);
      this.socket = socket;

      socket.onopen = () => {
        this.sendRaw(serializeFrame({
          command: "CONNECT",
          headers: {
            "accept-version": "1.2",
            host: "/",
            "heart-beat": `${STOMP_HEARTBEAT_MS},${STOMP_HEARTBEAT_MS}`,
            // Capital "A" — the server interceptor matches this exact form (it also
            // tolerates lowercase, but the Java client sends capital and so do we).
            Authorization: `Bearer ${this.getAccessToken()}`,
          },
          body: "",
        }));
        this.lastSentAt = Date.now();
      };

      socket.onmessage = (event: { data: string }) => {
        this.lastReceivedAt = Date.now();
        this.receiveBuffer += event.data;
        const { frames, remainder } = parseAvailableFrames(this.receiveBuffer);
        this.receiveBuffer = remainder;
        for (const frame of frames) {
          this.handleFrame(frame, reject, () => {
            if (!settled) {
              settled = true;
              resolve();
            }
          });
        }
      };

      socket.onclose = () => {
        const wasConnected = this.connected;
        this.teardownSocket();
        if (this.manuallyClosed) {
          return;
        }
        if (!settled) {
          settled = true;
          reject(new Error("STOMP socket closed before CONNECTED"));
          return;
        }
        if (wasConnected || this.reconnectAttempt > 0) {
          this.handlers.onLost("socket closed");
        }
        this.scheduleReconnect();
      };

      socket.onerror = () => {
        // onclose follows onerror in practice; nothing to do here.
      };
    });
  }

  /** Deduplicated ON THE WIRE: a repeated subscribe() only swaps the handler. */
  subscribe(destination: string, handler: (body: string) => void): void {
    const existing = this.subscriptions.get(destination);
    this.subscriptions.set(destination, handler);
    if (existing !== undefined || !this.connected) {
      return; // already SUBSCRIBEd on this socket, or the replay will cover it
    }
    this.sendFrame("SUBSCRIBE", { destination, id: this.nextSubscriptionId() }, "");
  }

  send(destination: string, body: unknown): void {
    if (!this.connected) {
      log.warn("stomp", `send to ${destination} skipped — not connected`);
      return;
    }
    this.sendFrame("SEND", { destination, "content-type": "application/json" }, JSON.stringify(body));
  }

  disconnect(): void {
    this.manuallyClosed = true;
    this.stopCountdown();
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // already closing
      }
    }
    this.teardownSocket();
  }

  /**
   * The manual ↻ retry (oak's onRetryReconnect), by state:
   *  - countdown running → cancel it and attempt IMMEDIATELY. The attempt was
   *    already counted when planned ("spent early", oak semantics) — the label
   *    keeps its M/10 and a failure continues from the NEXT backoff interval.
   *  - no countdown (terminal "Connection lost" after 10 failures, or a lost
   *    socket not yet scheduled) → restart the ladder FROM ZERO (oak resets
   *    reconnectAttempt on the terminal-state retry).
   * No-op when connected or manually closed.
   */
  reconnectNow(): void {
    if (this.connected || this.manuallyClosed || this.attemptInFlight) {
      return;
    }
    if (this.countdownTimer !== null) {
      this.stopCountdown();
      this.fireAttempt();
      return;
    }
    this.reconnectAttempt = 0;
    this.scheduleReconnect();
  }

  // ---------------------------------------------------------------------------

  private nextSubscriptionId(): string {
    this.subscriptionCounter += 1;
    return `sub-${this.subscriptionCounter}`;
  }

  private handleFrame(frame: StompFrame, reject: (error: Error) => void, onConnectedFrame: () => void): void {
    switch (frame.command) {
      case "CONNECTED": {
        const wasReconnect = this.everConnected;
        this.everConnected = true;
        this.connected = true;
        this.reconnectAttempt = 0;
        this.startTimers();
        this.replaySubscriptions();
        onConnectedFrame();
        this.handlers.onConnected?.(wasReconnect);
        log.info("stomp", `connected (${frame.headers.server ?? "?"})${wasReconnect ? " — resync due (gap healed)" : ""}`);
        break;
      }
      case "MESSAGE": {
        // Route to the per-destination handler registered via subscribe(); messages
        // for never-subscribed destinations are dropped (they cannot legitimately occur).
        // One throwing handler must not abort the frame loop: the frames behind it
        // in this WS event belong to unrelated channels and would be lost silently.
        const destination = frame.headers.destination ?? "";
        const handler = this.subscriptions.get(destination);
        if (handler !== undefined) {
          try {
            handler(frame.body);
          } catch (error) {
            log.error("stomp", `handler for ${destination} threw (frame dropped, dispatch continues): ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        break;
      }
      case "RECEIPT":
        break;
      case "ERROR": {
        const message = frame.headers.message ?? frame.body ?? "STOMP error";
        log.error("stomp", `ERROR frame: ${message}`);
        if (!this.connected) {
          // A pre-CONNECT error (e.g. auth rejection): surface it to the
          // connect() caller and close the socket. NO manuallyClosed here —
          // that flag permanently silenced the reconnect ladder (its guard),
          // so a server that answers ERROR once (auth hiccup, token rotation
          // window) left the client dead until a manual ↻ (live report).
          // Reject FIRST — the synchronous close() below re-enters onclose,
          // whose own reject would otherwise win the promise race.
          reject(new Error(message));
          try {
            this.socket?.close();
          } catch {
            // already closing
          }
        }
        break;
      }
      default:
        break;
    }
  }

  private replaySubscriptions(): void {
    // Fresh ids on a fresh socket; the map iteration order is registration order.
    for (const destination of this.subscriptions.keys()) {
      this.sendFrame("SUBSCRIBE", { destination, id: this.nextSubscriptionId() }, "");
    }
  }

  private sendFrame(command: string, headers: Record<string, string>, body: string): void {
    this.sendRaw(serializeFrame({ command, headers, body }));
  }

  private sendRaw(data: string): void {
    if (this.socket && this.socket.readyState === this.webSocketImpl.OPEN) {
      this.socket.send(data);
      this.lastSentAt = Date.now();
    }
  }

  private startTimers(): void {
    this.stopTimers();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket && Date.now() - this.lastSentAt >= STOMP_HEARTBEAT_MS) {
        this.sendRaw("\n");
      }
    }, STOMP_HEARTBEAT_MS / 2);
    this.lastReceivedAt = Date.now();
    this.watchdogTimer = setInterval(() => {
      if (Date.now() - this.lastReceivedAt > STOMP_READ_DEAD_MS) {
        log.warn("stomp", `read watchdog fired (${STOMP_READ_DEAD_MS}ms silence) — dropping socket`);
        const dead = this.socket;
        if (dead) {
          dead.onclose = null;
          dead.close();
          this.teardownSocket();
          this.handlers.onLost("read watchdog");
          this.scheduleReconnect();
        }
      }
    }, STOMP_READ_DEAD_MS / 2);
  }

  private stopTimers(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.watchdogTimer !== null) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private teardownSocket(): void {
    this.stopTimers();
    this.connected = false;
    this.socket = null;
    this.receiveBuffer = "";
  }

  private scheduleReconnect(): void {
    if (this.manuallyClosed || this.countdownTimer !== null) {
      return;
    }
    if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      // oak's terminal state: the ladder STOPS — "Connection lost" until the
      // user presses ↻ (which resets the attempt counter from zero).
      log.warn("stomp", `reconnect ladder exhausted (${MAX_RECONNECT_ATTEMPTS} attempts) — stopped`);
      this.handlers.onExhausted?.();
      return;
    }
    const delaySeconds = Math.min(2 ** this.reconnectAttempt, MAX_BACKOFF_SECONDS);
    this.reconnectAttempt += 1;
    const attempt = this.reconnectAttempt;
    log.info("stomp", `reconnecting in ${delaySeconds}s (attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS})`);
    // oak's 1-second Timeline: tick the label every second, fire at zero.
    let secondsLeft = delaySeconds;
    this.handlers.onCountdown?.(secondsLeft, attempt);
    this.countdownTimer = setInterval(() => {
      secondsLeft -= 1;
      if (secondsLeft > 0) {
        this.handlers.onCountdown?.(secondsLeft, attempt);
        return;
      }
      this.stopCountdown();
      this.fireAttempt();
    }, 1000);
  }

  /** Launches attempt #reconnectAttempt NOW (the countdown hit zero, or the
   *  manual ↻ spent it early); guards with attemptInFlight so a ↻ inside the
   *  flight window is a no-op instead of a counter reset. */
  private fireAttempt(): void {
    this.attemptInFlight = true;
    this.handlers.onAttempt?.(this.reconnectAttempt);
    void this.connect()
      .catch((error: unknown) => {
        log.warn("stomp", `reconnect failed: ${error instanceof Error ? error.message : String(error)}`);
        this.scheduleReconnect();
      })
      .finally(() => {
        this.attemptInFlight = false;
      });
  }

  private stopCountdown(): void {
    if (this.countdownTimer !== null) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }
}
