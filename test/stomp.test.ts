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
  } {
    const messages: { destination: string; body: string }[] = [];
    const lost: string[] = [];
    const client = new StompClient({
      url: "ws://localhost:8080/ws",
      getAccessToken: () => token,
      webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      handlers: {
        onLost(reason: string) {
          lost.push(reason);
        },
      },
    });
    return { client, messages, lost };
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
});
