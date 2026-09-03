import { JANUS_KEEPALIVE_MS, JANUS_POLL_ALIVE_MS, JANUS_POLL_TIMEOUT_MS } from "../config";
import { log } from "../logging";
import { parseVideoroomData, type VideoroomEvent } from "./janus-events";

/**
 * Janus REST transport: session create/handle attach over synchronous POSTs, event
 * delivery over an HTTP long-poll (this gateway build's WebSocket transport is broken —
 * hard-won fact from the Java client). Vanilla-protocol quirks that MUST hold:
 *  - the auth token rides as a TOP-LEVEL BODY FIELD on every POST (query tokens on POSTs
 *    are rejected 403 by this build) and as ?token= only on the poll GET;
 *  - exactly one poll in flight, client timeout 40 s (server holds ~30 s);
 *  - a poll error surfacing after ≥20 s of waiting means the gateway is ALIVE;
 *  - ANY janus:"error" answer on the poll is fatal (session lost).
 */

export interface JanusJsep {
  type: string;
  sdp: string;
}

export interface JanusSendResult {
  data: unknown;
  jsep: JanusJsep | null;
}

export interface JanusClientOptions {
  baseUrl: string;
  token: string | null;
  pin: string | null;
  roomId: number;
  fetchImpl?: typeof fetch;
  onEvent(handleId: number, event: VideoroomEvent): void;
  /** Fires for events carrying a JSEP that no pending send() is waiting on. */
  onJsep(handleId: number, jsep: JanusJsep): void;
  onSessionLost(reason: string): void;
}

const SEND_TIMEOUT_MS = 10_000;
const POLL_RETRY_MS = 1_000;
const SILENCE_LOSS_MS = 45_000;

interface PendingSend {
  resolve: (result: JanusSendResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class JanusClient {
  private readonly baseUrl: string;
  private readonly token: string | null;
  private readonly pin: string | null;
  private readonly roomId: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onEvent: JanusClientOptions["onEvent"];
  private readonly onJsep: JanusClientOptions["onJsep"];
  private readonly onSessionLost: JanusClientOptions["onSessionLost"];

  private sessionId: number | null = null;
  private running = false;
  private sessionLostFired = false;
  private lastAliveAt = 0;
  private pollAbort: AbortController | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private silenceTimer: ReturnType<typeof setInterval> | null = null;
  private readonly pending = new Map<string, PendingSend>();
  private pollPromise: Promise<void> | null = null;

  constructor(options: JanusClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.pin = options.pin;
    this.roomId = options.roomId;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.onEvent = options.onEvent;
    this.onJsep = options.onJsep;
    this.onSessionLost = options.onSessionLost;
  }

  getSessionId(): number | null {
    return this.sessionId;
  }

  /**
   * Creates the session, attaches the publisher videoroom handle, starts the long-poll
   * loop and keepalive. The poll loop starts BEFORE any join — join answers arrive
   * through it (Java-client ordering).
   */
  async open(): Promise<number> {
    const createBody = this.withToken({ janus: "create", transaction: this.newTransaction() });
    const created = await this.postJson<{"janus": string; "data"?: {"id"?: number}}>(this.baseUrl, createBody, 10_000);
    this.requireNoJanusError(created, "create session");
    const sessionId = (created.data as { id?: number } | undefined)?.id;
    if (typeof sessionId !== "number") {
      throw new Error("janus create: no session id in answer");
    }
    this.sessionId = sessionId;
    this.running = true;
    this.lastAliveAt = Date.now();

    this.pollPromise = this.pollLoop();
    this.keepaliveTimer = setInterval(() => {
      void this.fireAndForget({ janus: "keepalive", session_id: sessionId, transaction: this.newTransaction() });
    }, JANUS_KEEPALIVE_MS);
    this.silenceTimer = setInterval(() => {
      if (this.running && Date.now() - this.lastAliveAt > SILENCE_LOSS_MS) {
        this.declareSessionLost("silence watchdog (45s)");
      }
    }, POLL_RETRY_MS);

    const publisherHandleId = await this.attach("janus.plugin.videoroom");
    log.info("janus", `session ${sessionId}, publisher handle ${publisherHandleId}`);
    return publisherHandleId;
  }

  async attach(plugin: string): Promise<number> {
    const body = this.withToken({ janus: "attach", plugin, transaction: this.newTransaction() });
    const answer = await this.postJson<{"data"?: {"id"?: number}}>(this.handleUrl(), body, SEND_TIMEOUT_MS);
    this.requireNoJanusError(answer, `attach ${plugin}`);
    const handleId = (answer.data as { id?: number } | undefined)?.id;
    if (typeof handleId !== "number") {
      throw new Error("janus attach: no handle id in answer");
    }
    return handleId;
  }

  /**
   * Sends a videoroom message to a handle. The POST returns an immediate ack; the REAL
   * result (plugin data / jsep) arrives later through the long-poll correlated by the
   * transaction id — send() resolves when that lands (or rejects after 10 s).
   */
  send(handleId: number, videoroomBody: Record<string, unknown>, jsep?: JanusJsep): Promise<JanusSendResult> {
    const transaction = this.newTransaction();
    const body: Record<string, unknown> = {
      janus: "message",
      transaction,
      body: videoroomBody,
    };
    if (jsep) {
      body.jsep = jsep;
    }
    return new Promise<JanusSendResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(transaction);
        reject(new Error(`janus send timeout (${transaction})`));
      }, SEND_TIMEOUT_MS);
      this.pending.set(transaction, { resolve, reject, timer });
      void this.postJson<unknown>(`${this.baseUrl}/${this.sessionId}/${handleId}`, this.withToken(body), SEND_TIMEOUT_MS)
        .then((ack) => {
          if ((ack as { janus?: string }).janus === "error") {
            this.requireNoJanusError(ack as Record<string, unknown>, "message");
          }
        })
        .catch((error: unknown) => {
          clearTimeout(timer);
          this.pending.delete(transaction);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  /** Fire-and-forget POST for keepalive/destroy — answers ignored. */
  private async fireAndForget(body: Record<string, unknown>): Promise<void> {
    try {
      await this.postJson<unknown>(this.handleUrl(), this.withToken(body), SEND_TIMEOUT_MS);
    } catch (error: unknown) {
      log.warn("janus", `fire-and-forget failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async destroy(): Promise<void> {
    this.running = false;
    if (this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    if (this.silenceTimer !== null) {
      clearInterval(this.silenceTimer);
      this.silenceTimer = null;
    }
    this.pollAbort?.abort();
    // Do NOT await the poll promise — against a dead transport it may never settle.
    void this.pollPromise?.catch(() => undefined);
    for (const [transaction, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("janus client destroyed"));
      this.pending.delete(transaction);
    }
    if (this.sessionId !== null) {
      const sessionUrl = this.handleUrl(); // build BEFORE nulling the id
      const sessionId = this.sessionId;
      this.sessionId = null;
      try {
        await this.postJson<unknown>(sessionUrl, this.withToken({ janus: "destroy", transaction: this.newTransaction() }), SEND_TIMEOUT_MS);
      } catch {
        // best effort — the session dies server-side anyway
      }
      log.info("janus", `session ${sessionId} destroyed`);
    }
  }

  // ---------------------------------------------------------------------------

  private newTransaction(): string {
    return crypto.randomUUID().substring(0, 8);
  }

  private withToken(body: Record<string, unknown>): Record<string, unknown> {
    if (this.token) {
      return { ...body, token: this.token };
    }
    return body;
  }

  private handleUrl(): string {
    return `${this.baseUrl}/${this.sessionId}`;
  }

  private async postJson<T>(url: string, body: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`janus POST ${url} → HTTP ${response.status}`);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  private declareSessionLost(reason: string): void {
    if (!this.running || this.sessionLostFired) {
      return;
    }
    this.sessionLostFired = true;
    this.running = false;
    this.pollAbort?.abort();
    log.warn("janus", `session lost: ${reason}`);
    this.onSessionLost(reason);
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      const startedAt = Date.now();
      const pollUrl = this.token
        ? `${this.baseUrl}/${this.sessionId}?maxev=1&token=${encodeURIComponent(this.token)}`
        : `${this.baseUrl}/${this.sessionId}?maxev=1`;
      const controller = new AbortController();
      this.pollAbort = controller;
      const timeout = setTimeout(() => controller.abort(), JANUS_POLL_TIMEOUT_MS);
      try {
        const response = await this.fetchImpl(pollUrl, { method: "GET", signal: controller.signal });
        clearTimeout(timeout);
        if (!response.ok) {
          throw new Error(`poll HTTP ${response.status}`);
        }
        const message = (await response.json()) as Record<string, unknown>;
        if (message.janus === "error") {
          clearTimeout(timeout);
          this.declareSessionLost(`poll error: ${JSON.stringify(message.error ?? {})}`);
          return;
        }
        this.lastAliveAt = Date.now();
        this.dispatch(message);
      } catch (error) {
        clearTimeout(timeout);
        const waitedMs = Date.now() - startedAt;
        if (waitedMs >= JANUS_POLL_ALIVE_MS) {
          // The gateway HELD the connection for a long time before the error — that is
          // liveness (a genuine dead gateway errors fast). Not an availability event.
          this.lastAliveAt = Date.now();
        }
        if (!this.running) {
          return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, POLL_RETRY_MS));
        void error; // loop and retry — fatality is decided by the silence watchdog
      }
    }
  }

  /** Route one poll message: tx-correlated sends, plugindata events, JSEPs.
   *  OFFERS fire onJsep even when tx-claimed — the subscriber join/subscribe answers
   *  carry Janus's offer in the SAME message that resolves the pending send, and the
   *  send() caller does not consume it. ANSWERS stay claimed-only (the publisher
   *  configure round owns its own). */
  private dispatch(message: Record<string, unknown>): void {
    const transaction = typeof message.transaction === "string" ? message.transaction : null;
    const jsep = this.parseJsep(message.jsep);
    const plugindata = message.plugindata as Record<string, unknown> | undefined;
    const videoroomData = plugindata?.data;
    const event = videoroomData === undefined ? null : parseVideoroomData(videoroomData);

    const handleId = typeof message.sender === "number" ? message.sender : null;
    const offerJsep = jsep !== null && jsep.type === "offer" ? jsep : null;

    if (transaction !== null) {
      const pending = this.pending.get(transaction);
      if (pending) {
        this.pending.delete(transaction);
        clearTimeout(pending.timer);
        pending.resolve({ data: videoroomData, jsep });
        if (event) {
          this.onEvent(handleId ?? 0, event);
        }
        if (offerJsep) {
          this.onJsep(handleId ?? 0, offerJsep);
        }
        return;
      }
    }
    if (event) {
      this.onEvent(handleId ?? 0, event);
    }
    if (offerJsep) {
      this.onJsep(handleId ?? 0, offerJsep);
    }
  }

  private parseJsep(raw: unknown): JanusJsep | null {
    if (typeof raw !== "object" || raw === null) {
      return null;
    }
    const record = raw as Record<string, unknown>;
    if (typeof record.type !== "string" || typeof record.sdp !== "string") {
      return null;
    }
    return { type: record.type, sdp: record.sdp };
  }

  private requireNoJanusError(answer: Record<string, unknown>, what: string): void {
    if (answer.janus === "error") {
      const error = answer.error as { code?: number; reason?: string } | undefined;
      throw new Error(`janus ${what}: ${error?.code ?? "?"} ${error?.reason ?? ""}`.trim());
    }
  }
}
