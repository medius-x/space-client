import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { parseAvailableFrames, serializeFrame, StompClient } from "../src/core/stomp";
import { FakeWebSocket, FRAME_TERMINATOR, resetFakeSockets } from "./mocks/fake-websocket";

const TERMINATOR = FRAME_TERMINATOR;

describe("stomp frame codec", () => {
  it("serializes a frame: COMMAND, header lines, blank line, body, NULL", () => {
    const wire = serializeFrame({ command: "SEND", headers: { destination: "/app/x" }, body: "{\"a\":1}" });
    expect(wire).toBe(`SEND\ndestination:/app/x\n\n{"a":1}${TERMINATOR}`);
  });

  it("escapes colons and backslashes in header values (a\\b:c ↔ a\\\\b\\cc)", () => {
    const wire = serializeFrame({ command: "MESSAGE", headers: { destination: "a\\b:c" }, body: "" });
    expect(wire).toContain("destination:a\\\\b\\cc");
  });

  it("parses complete frames and keeps an incomplete tail as remainder", () => {
    const first = serializeFrame({ command: "MESSAGE", headers: { destination: "/t/1" }, body: "hello" });
    const second = serializeFrame({ command: "MESSAGE", headers: { destination: "/t/2" }, body: "world" });
    const { frames, remainder } = parseAvailableFrames(first + second.slice(0, 5));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.body).toBe("hello");
    expect(remainder).toBe(second.slice(0, 5));
  });

  it("skips heartbeat EOLs and tolerates CRLF line endings", () => {
    const crlfFrame = "MESSAGE\r\ndestination:/t/9\r\n\r\nbody" + TERMINATOR;
    const { frames } = parseAvailableFrames("\n" + crlfFrame + "\n\n");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.headers.destination).toBe("/t/9");
    expect(frames[0]?.body).toBe("body");
  });

  it("unescapes header values on parse (round trip of a\\b:c)", () => {
    const wire = serializeFrame({ command: "MESSAGE", headers: { destination: "a\\b:c" }, body: "" });
    const { frames } = parseAvailableFrames(wire);
    expect(frames[0]?.headers.destination).toBe("a\\b:c");
  });
});

describe("StompClient", () => {
  beforeEach(() => {
    resetFakeSockets();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeClient(token = "jwt-1"): {
    client: StompClient;
    messages: { destination: string; body: string }[];
    lost: string[];
    countdowns: { secondsLeft: number; attempt: number }[];
    attempts: number[];
    exhausted: number[];
  } {
    const messages: { destination: string; body: string }[] = [];
    const lost: string[] = [];
    const countdowns: { secondsLeft: number; attempt: number }[] = [];
    const attempts: number[] = [];
    const exhausted: number[] = [];
    const client = new StompClient({
      url: "ws://localhost:8080/ws",
      getAccessToken: () => token,
      webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      handlers: {
        onLost(reason: string) {
          lost.push(reason);
        },
        onCountdown(secondsLeft: number, attempt: number) {
          countdowns.push({ secondsLeft, attempt });
        },
        onAttempt(attempt: number) {
          attempts.push(attempt);
        },
        onExhausted() {
          exhausted.push(1);
        },
      },
    });
    return { client, messages, lost, countdowns, attempts, exhausted };
  }

  function connectedSocket(): FakeWebSocket {
    const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    socket.serverOpen();
    socket.serverMessage("CONNECTED\nserver:test\nversion:1.2\n\n" + TERMINATOR);
    return socket;
  }

  it("connects with the auth token in the CONNECT headers", async () => {
    const { client } = makeClient("jwt-abc");
    const connecting = client.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.serverOpen();
    socket.serverMessage("CONNECTED\n\n" + TERMINATOR);
    await connecting;

    const connectFrame = socket.sent[0]!;
    expect(connectFrame).toContain("CONNECT\n");
    expect(connectFrame).toContain("accept-version:1.2");
    expect(connectFrame).toContain("Authorization:Bearer jwt-abc");
    expect(connectFrame).toContain("heart-beat:10000,10000");
    expect(client.isConnected()).toBe(true);
  });

  it("rejects connect() on an ERROR frame (bad token)", async () => {
    const { client } = makeClient("bad");
    const connecting = client.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.serverOpen();
    socket.serverMessage("ERROR\nmessage:Invalid token\n\n" + TERMINATOR);
    await expect(connecting).rejects.toThrow("Invalid token");
    expect(client.isConnected()).toBe(false);
  });

  it("subscribes once per destination on the wire and routes MESSAGEs by destination", async () => {
    const { client } = makeClient();
    const messages: { destination: string; body: string }[] = [];
    const connecting = client.connect();
    connectedSocket();
    await connecting;
    const socket = FakeWebSocket.instances[0]!;

    client.subscribe("/topic/voice", (body) => messages.push({ destination: "/topic/voice", body }));
    client.subscribe("/topic/voice", (body) => messages.push({ destination: "/topic/voice(2)", body })); // handler swap — no second SUBSCRIBE
    const subscribes = socket.sent.filter((frame) => frame.startsWith("SUBSCRIBE"));
    expect(subscribes).toHaveLength(1);

    client.subscribe("/topic/presence", (body) => messages.push({ destination: "/topic/presence", body }));
    socket.serverMessage(`MESSAGE\ndestination:/topic/voice\n\n{"status":"JOINED"}${TERMINATOR}`);
    socket.serverMessage(`MESSAGE\ndestination:/topic/presence\n\n{"status":"ONLINE"}${TERMINATOR}`);
    // the SWAPPED handler received the voice message, not both
    expect(messages.map((entry) => entry.destination)).toEqual(["/topic/voice(2)", "/topic/presence"]);
    expect(messages[0]?.body).toContain("JOINED");
  });

  it("a THROWING handler does not abort the dispatch of the frames behind it", async () => {
    const { client } = makeClient();
    const received: string[] = [];
    const connecting = client.connect();
    connectedSocket();
    await connecting;
    const socket = FakeWebSocket.instances[0]!;

    client.subscribe("/topic/broken", () => { throw new Error("handler bug"); });
    client.subscribe("/topic/healthy", (body) => received.push(body));
    // Two frames in ONE WS event: the first handler throws, the second must
    // still be delivered (an aborted loop would lose it silently).
    socket.serverMessage(
      `MESSAGE\ndestination:/topic/broken\n\nfirst${TERMINATOR}`
      + `MESSAGE\ndestination:/topic/healthy\n\nsecond${TERMINATOR}`);
    expect(received).toEqual(["second"]);
  });

  it("sends SEND frames with a JSON body", async () => {
    const { client } = makeClient();
    const connecting = client.connect();
    connectedSocket();
    await connecting;
    const socket = FakeWebSocket.instances[0]!;

    client.send("/app/voice.join", { channelId: 7 });
    const sendFrame = socket.sent.find((frame) => frame.startsWith("SEND"));
    expect(sendFrame).toContain("destination:/app/voice.join");
    expect(sendFrame).toContain('{"channelId":7}');
  });

  it("manual disconnect stays silent (no onLost, no reconnect)", async () => {
    const { client, lost } = makeClient();
    const connecting = client.connect();
    connectedSocket();
    await connecting;

    client.disconnect();
    vi.advanceTimersByTime(60_000);
    expect(lost).toEqual([]);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("abnormal close fires onLost and reconnects with replayed subscriptions", async () => {
    const { client, lost } = makeClient();
    const messages: string[] = [];
    const connecting = client.connect();
    const first = connectedSocket();
    await connecting;
    client.subscribe("/topic/voice", (body) => messages.push(body));
    expect(first.sent.filter((frame) => frame.startsWith("SUBSCRIBE"))).toHaveLength(1);

    first.serverClose(); // abnormal
    expect(lost).toEqual(["socket closed"]);

    vi.advanceTimersByTime(1_000); // first backoff step
    const second = FakeWebSocket.instances[1]!;
    second.serverOpen();
    second.serverMessage("CONNECTED\n\n" + TERMINATOR);
    await vi.advanceTimersByTimeAsync(0);

    // subscription replayed on the NEW socket, messages flow again
    expect(second.sent.filter((frame) => frame.startsWith("SUBSCRIBE"))).toHaveLength(1);
    second.serverMessage(`MESSAGE\ndestination:/topic/voice\n\n{"ok":1}${TERMINATOR}`);
    expect(messages).toHaveLength(1);
  });

  it("reconnectNow attempts IMMEDIATELY instead of waiting out the backoff", async () => {
    const { client, attempts } = makeClient();
    const connecting = client.connect();
    const first = connectedSocket();
    await connecting;

    first.serverClose(); // abnormal → attempt 1 scheduled, 1s countdown

    client.reconnectNow(); // the manual ↻: no timer advance anywhere
    expect(attempts).toEqual([1]); // the scheduled attempt, spent early
    const second = FakeWebSocket.instances[1]!;
    second.serverOpen();
    second.serverMessage("CONNECTED\n\n" + TERMINATOR);
    await vi.advanceTimersByTimeAsync(0);
    expect(second.sent[0]).toContain("CONNECT");

    // the cancelled countdown must NOT fire a duplicate socket — the window
    // stays under the 20s read watchdog, which would legitimately drop an
    // idle connection and rearm the cycle
    vi.advanceTimersByTime(2_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("reconnectNow is a no-op while connected", async () => {
    const { client } = makeClient();
    const connecting = client.connect();
    connectedSocket();
    await connecting;

    client.reconnectNow();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("the backoff ladder keeps retrying through connection refusals", async () => {
    const { client, lost } = makeClient();
    const connecting = client.connect();
    const first = connectedSocket();
    await connecting;

    first.serverClose(); // the server drops
    // attempt 1 fires at 1s and is REFUSED (socket closes before CONNECTED)
    await vi.advanceTimersByTimeAsync(1_000);
    FakeWebSocket.instances[1]!.serverClose();
    // attempt 2 must still be scheduled (2s out) — the rejection of a refused
    // attempt must not kill the ladder (live report: "no auto-reconnects")
    await vi.advanceTimersByTimeAsync(2_000);
    expect(FakeWebSocket.instances).toHaveLength(3);

    // and the ladder eventually lands when the server comes back
    const third = FakeWebSocket.instances[2]!;
    third.serverOpen();
    third.serverMessage("CONNECTED\n\n" + TERMINATOR);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.isConnected()).toBe(true);
    expect(lost.length).toBeGreaterThanOrEqual(1);
  });

  it("a server ERROR frame on a reconnect attempt does NOT kill the ladder", async () => {
    const { client } = makeClient();
    const connecting = client.connect();
    const first = connectedSocket();
    await connecting;

    first.serverClose();
    await vi.advanceTimersByTimeAsync(1_000); // attempt 1 leaves
    const second = FakeWebSocket.instances[1]!;
    second.serverOpen();
    // the server ANSWERS with an ERROR frame (e.g. an auth hiccup) — the old
    // code set manuallyClosed here and the ladder died forever (live report:
    // "no auto-reconnects until the user presses ↻")
    second.serverMessage(`ERROR\nmessage:badCredentials\n\n${TERMINATOR}`);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.isConnected()).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000); // attempt 2 must still fire
    expect(FakeWebSocket.instances).toHaveLength(3);
    const third = FakeWebSocket.instances[2]!;
    third.serverOpen();
    third.serverMessage("CONNECTED\n\n" + TERMINATOR);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.isConnected()).toBe(true);
  });

  it("ticks the per-second countdown label with the attempt number", async () => {
    const { client, countdowns } = makeClient();
    const connecting = client.connect();
    const first = connectedSocket();
    await connecting;

    first.serverClose(); // attempt 1 scheduled 1s out — a single tick
    await vi.advanceTimersByTimeAsync(1_000);
    expect(countdowns).toEqual([{ secondsLeft: 1, attempt: 1 }]);

    // let attempt 1 refuse → attempt 2 is 2s out: the schedule label, then ticks at 1
    FakeWebSocket.instances[1]!.serverClose();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(countdowns).toEqual([
      { secondsLeft: 1, attempt: 1 },
      { secondsLeft: 2, attempt: 2 },
      { secondsLeft: 1, attempt: 2 },
    ]);
  });

  it("the ladder STOPS after 10 failed attempts; ↻ restarts it from zero", async () => {
    const { client, attempts, exhausted } = makeClient();
    const connecting = client.connect();
    const first = connectedSocket();
    await connecting;

    first.serverClose();
    // drive all 10 attempts to refusal: delays 1,2,4,8,16,30,30,30,30,30 = 181s
    for (let safety = 0; safety < 40; safety += 1) {
      await vi.advanceTimersByTimeAsync(30_000);
      const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
      if (socket !== first && socket.readyState !== FakeWebSocket.CLOSED) {
        socket.serverClose(); // refused
      }
    }
    expect(attempts).toHaveLength(10);
    expect(exhausted).toHaveLength(1); // the terminal stop

    // no countdown, no 11th socket
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances).toHaveLength(11); // initial + 10 attempts

    // the manual ↻ restarts the CYCLE from zero: attempt 1 scheduled 1s out
    client.reconnectNow();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts).toHaveLength(11);
    expect(attempts[10]).toBe(1);
  });

  it("↻ while an automatic attempt is FLYING is a no-op (no counter reset)", async () => {
    const { client, attempts } = makeClient();
    const connecting = client.connect();
    const first = connectedSocket();
    await connecting;

    first.serverClose();
    await vi.advanceTimersByTimeAsync(1_000); // attempt 1 leaves, socket open, awaiting CONNECTED
    expect(attempts).toEqual([1]);

    client.reconnectNow(); // pressed DURING the flight — must not reset anything
    expect(attempts).toEqual([1]);
    expect(FakeWebSocket.instances).toHaveLength(2); // no duplicate socket either

    // the flight fails → the ladder continues from attempt 2 (not from 1)
    FakeWebSocket.instances[1]!.serverClose();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(attempts).toEqual([1, 2]);
  });

  it("onConnected flags REconnects so the session can resync what the gap missed", async () => {
    const flags: boolean[] = [];
    const client = new StompClient({
      url: "ws://localhost:8080/ws",
      getAccessToken: () => "jwt-1",
      webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      handlers: {
        onLost: () => undefined,
        onConnected: (reconnected) => flags.push(reconnected),
      },
    });
    const connecting = client.connect();
    const first = connectedSocket();
    await connecting;
    expect(flags).toEqual([false]); // the first connect is NOT a reconnect — start() snapshots

    first.serverClose(); // abnormal
    vi.advanceTimersByTime(1_000); // first backoff step
    const second = FakeWebSocket.instances[1]!;
    second.serverOpen();
    second.serverMessage("CONNECTED\n\n" + TERMINATOR);
    await vi.advanceTimersByTimeAsync(0);
    expect(flags).toEqual([false, true]); // the reconnect carries the flag
  });
});
