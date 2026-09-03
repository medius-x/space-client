import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { JanusClient } from "../src/core/janus";
import type { VideoroomEvent } from "../src/core/janus-events";

/**
 * Janus client tests driven through a scripted fetch. POSTs answer synchronously from a
 * queue; poll GETs hang until the test resolves them — exactly the live shape.
 */
class JanusScriptedFetch {
  readonly calls: { method: string; url: string; body: Record<string, unknown> | null }[] = [];
  private readonly postAnswers: unknown[] = [];
  private pollResponder: ((message: unknown) => void) | null = null;

  queuePostAnswer(answer: unknown): void {
    this.postAnswers.push(answer);
  }

  resolvePoll(message: unknown): void {
    this.pollResponder?.(message);
  }

  private jsonResponse(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    this.calls.push({ method, url: String(input), body });
    if (method === "POST") {
      const answer = this.postAnswers.shift() ?? { janus: "ack" };
      return this.jsonResponse(answer);
    }
    return new Promise<Response>((resolve) => {
      this.pollResponder = (message: unknown) => {
        if (message instanceof Error) {
          resolve(this.jsonResponse({ janus: "error" }, 500));
          return;
        }
        resolve(this.jsonResponse(message));
      };
    });
  };
}

function makeClient(adapter: JanusScriptedFetch, sinks: {
  events?: VideoroomEvent[];
  jseps?: string[];
  lost?: string[];
}): JanusClient {
  return new JanusClient({
    baseUrl: "http://localhost:8088/janus",
    token: "tok-1",
    pin: null,
    roomId: 5,
    fetchImpl: adapter.fetch,
    onEvent: (_handleId, event) => sinks.events?.push(event),
    onJsep: (_handleId, jsep) => sinks.jseps?.push(jsep.type),
    onSessionLost: (reason) => sinks.lost?.push(reason),
  });
}

async function openClient(adapter: JanusScriptedFetch, sinks: {
  events?: VideoroomEvent[];
  jseps?: string[];
  lost?: string[];
}): Promise<JanusClient> {
  adapter.queuePostAnswer({ janus: "success", data: { id: 777 } }); // create session
  adapter.queuePostAnswer({ janus: "success", data: { id: 42 } }); // attach publisher handle
  const client = makeClient(adapter, sinks);
  const opened = client.open();
  await vi.advanceTimersByTimeAsync(0);
  await opened;
  return client;
}

describe("JanusClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("open(): create + attach with the token as a TOP-LEVEL BODY FIELD on POSTs", async () => {
    const adapter = new JanusScriptedFetch();
    const client = await openClient(adapter, {});

    expect(client.getSessionId()).toBe(777);
    expect(adapter.calls[0]?.method).toBe("POST");
    expect(adapter.calls[0]?.url).toBe("http://localhost:8088/janus");
    expect(adapter.calls[0]?.body).toMatchObject({ janus: "create", token: "tok-1" });
    // The poll GET is issued BETWEEN create and attach (loop starts before join) —
    // so locate the attach by its body, not by index.
    const attach = adapter.calls.find((call) => call.body?.janus === "attach");
    expect(attach?.body).toMatchObject({ janus: "attach", plugin: "janus.plugin.videoroom", token: "tok-1" });

    await client.destroy();
  });

  it("send(): the videoroom answer arrives through the poll, correlated by transaction", async () => {
    const adapter = new JanusScriptedFetch();
    const client = await openClient(adapter, {});

    const sent = client.send(42, { request: "join", room: 5, ptype: "publisher", display: "alice" });
    await vi.advanceTimersByTimeAsync(0);

    const posted = adapter.calls.find((call) => call.body?.janus === "message");
    expect(posted?.body?.body).toMatchObject({ request: "join", room: 5, ptype: "publisher" });
    const transaction = posted?.body?.transaction;
    expect(typeof transaction).toBe("string");
    expect(transaction).toHaveLength(8);

    adapter.resolvePoll({
      janus: "event",
      sender: 42,
      transaction,
      plugindata: { plugin: "janus.plugin.videoroom", data: { videoroom: "joined", publishers: [] } },
    });
    const result = await sent;
    expect((result.data as { videoroom: string }).videoroom).toBe("joined");

    await client.destroy();
  });

  it("a poll answer janus:error is fatal — session lost fires once", async () => {
    const adapter = new JanusScriptedFetch();
    const sinks: { lost: string[] } = { lost: [] };
    const client = await openClient(adapter, sinks);

    adapter.resolvePoll({ janus: "error", error: { code: 458, reason: "No such session" } });
    await vi.advanceTimersByTimeAsync(0);
    adapter.resolvePoll({ janus: "error", error: { code: 458, reason: "again" } });
    await vi.advanceTimersByTimeAsync(0);

    expect(sinks.lost).toHaveLength(1);
    expect(sinks.lost[0]).toContain("458");
  });

  it("unclaimed JSEPs fire onJsep; tx-claimed ones resolve the send() instead", async () => {
    const adapter = new JanusScriptedFetch();
    const sinks: { jseps: string[] } = { jseps: [] };
    const client = await openClient(adapter, sinks);

    adapter.resolvePoll({ janus: "event", sender: 9, jsep: { type: "offer", sdp: "v=0" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(sinks.jseps).toEqual(["offer"]);

    // claimed: the publisher answer goes to the pending send, NOT to onJsep
    const sent = client.send(42, { request: "configure", audio: true, video: true });
    await vi.advanceTimersByTimeAsync(0);
    const posted = adapter.calls.filter((call) => call.body?.janus === "message").pop();
    adapter.resolvePoll({
      janus: "event",
      sender: 42,
      transaction: posted?.body?.transaction,
      jsep: { type: "answer", sdp: "v=0-answer" },
    });
    const result = await sent;
    expect(result.jsep?.sdp).toBe("v=0-answer");
    expect(sinks.jseps).toEqual(["offer"]);

    await client.destroy();
  });

  it("REGRESSION (live smoke 2026-09-03): an OFFER riding a tx-claimed answer ALSO fires onJsep — the subscriber join's offer must not be swallowed", async () => {
    const adapter = new JanusScriptedFetch();
    const sinks: { jseps: string[] } = { jseps: [] };
    const client = await openClient(adapter, sinks);

    // The exact live shape: subscriber join resolves its send AND carries Janus's offer.
    const sent = client.send(42, { request: "join", ptype: "subscriber", room: 5, streams: [{ feed: 9, mid: "0" }] });
    await vi.advanceTimersByTimeAsync(0);
    const posted = adapter.calls.filter((call) => call.body?.janus === "message").pop();
    adapter.resolvePoll({
      janus: "event",
      sender: 42,
      transaction: posted?.body?.transaction,
      plugindata: { plugin: "janus.plugin.videoroom", data: { videoroom: "event" } },
      jsep: { type: "offer", sdp: "v=0-subscriber-offer" },
    });
    const result = await sent;

    // BOTH consumers got it: the send resolved with the jsep, and onJsep fired.
    expect(result.jsep?.sdp).toBe("v=0-subscriber-offer");
    expect(sinks.jseps).toEqual(["offer"]);

    await client.destroy();
  });

  it("keepalive posts every 25s with session_id, and destroy posts janus:destroy", async () => {
    const adapter = new JanusScriptedFetch();
    const client = await openClient(adapter, {});

    await vi.advanceTimersByTimeAsync(25_000);
    const keepalive = adapter.calls.find((call) => call.body?.janus === "keepalive");
    expect(keepalive?.body).toMatchObject({ janus: "keepalive", session_id: 777 });

    await client.destroy();
    const destroyCall = adapter.calls.find((call) => call.body?.janus === "destroy");
    expect(destroyCall?.url).toBe("http://localhost:8088/janus/777");
  });

  it("45s of poll silence declares the session lost", async () => {
    const adapter = new JanusScriptedFetch();
    const sinks: { lost: string[] } = { lost: [] };
    const client = await openClient(adapter, sinks);

    await vi.advanceTimersByTimeAsync(46_000);
    expect(sinks.lost).toHaveLength(1);
    expect(sinks.lost[0]).toContain("silence");

    await client.destroy();
  });
});
