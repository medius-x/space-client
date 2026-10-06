import { describe, expect, it } from "vitest";
import { ConnectionQuality } from "../src/domain/logic/connection-quality";

/** recordEcho at a fixed "now" — the tracker takes explicit timestamps. */
function echo(tracker: ConnectionQuality, sentAtMillis: number, rttMillis: number): boolean {
  return tracker.recordEcho(sentAtMillis + rttMillis, sentAtMillis);
}

describe("ConnectionQuality", () => {
  it("starts probing with an empty snapshot", () => {
    const tracker = new ConnectionQuality();
    expect(tracker.snapshot()).toEqual({
      state: "probing",
      lastRttMillis: null,
      lastRestMillis: null,
      windowMinMillis: null,
      windowAvgMillis: null,
      windowMaxMillis: null,
      jitterMillis: null,
      consecutiveMisses: 0,
    });
  });

  it("two snappy echoes read good and fill the window stats", () => {
    const tracker = new ConnectionQuality();
    expect(echo(tracker, 1_000, 20)).toBe(true);
    expect(tracker.snapshot().state).toBe("probing"); // warm-up: one echo is not a verdict
    expect(echo(tracker, 2_000, 20)).toBe(true);
    const snapshot = tracker.snapshot();
    expect(snapshot.state).toBe("good");
    expect(snapshot.lastRttMillis).toBe(20);
    expect(snapshot.windowMinMillis).toBe(20);
    expect(snapshot.windowMaxMillis).toBe(20);
    expect(snapshot.jitterMillis).toBe(0);
  });

  it("a startup-inflated FIRST ping never seeds the verdict (live report: 423 ms on localhost)", () => {
    const tracker = new ConnectionQuality();
    echo(tracker, 1_000, 423); // the first ping rides the startup storm
    expect(tracker.snapshot().state).toBe("probing"); // the number shows, the verdict withholds
    echo(tracker, 11_000, 5); // the seed takes the FASTER of the first two
    const snapshot = tracker.snapshot();
    expect(snapshot.state).toBe("good");
    expect(snapshot.jitterMillis).toBe(0);
  });

  it("two genuinely slow first samples still seed a slow verdict", () => {
    const tracker = new ConnectionQuality();
    echo(tracker, 1_000, 300);
    echo(tracker, 11_000, 320);
    expect(tracker.snapshot().state).toBe("weak"); // min(300, 320) seeds the mean
    echo(tracker, 21_000, 305);
    expect(tracker.snapshot().state).toBe("weak");
  });

  it("a slow-but-steady echo reads weak, a very slow one bad", () => {
    const steadySlow = new ConnectionQuality();
    for (let index = 0; index < 5; index += 1) {
      echo(steadySlow, 1_000 + index * 1_000, 250);
    }
    expect(steadySlow.snapshot().state).toBe("weak"); // 250 ms avg, no jitter

    const verySlow = new ConnectionQuality();
    for (let index = 0; index < 5; index += 1) {
      echo(verySlow, 1_000 + index * 1_000, 500);
    }
    expect(verySlow.snapshot().state).toBe("bad");
  });

  it("a single stall-sized outlier never flips good (jitter ignores it, the mean absorbs it)", () => {
    const tracker = new ConnectionQuality();
    echo(tracker, 1_000, 5);
    echo(tracker, 2_000, 5);
    echo(tracker, 3_000, 300); // busy renderer main thread — one-off 300 ms
    expect(tracker.snapshot().state).toBe("good"); // mean ~93, jitter still 0
    echo(tracker, 4_000, 5);
    const snapshot = tracker.snapshot();
    expect(snapshot.state).toBe("good");
    expect(snapshot.lastRttMillis).toBe(5);
  });

  it("sustained wild alternation still trips bad — through the MEAN, jitter untouched", () => {
    const tracker = new ConnectionQuality();
    for (let index = 0; index < 8; index += 1) {
      echo(tracker, index * 2_000, 50);
      echo(tracker, index * 2_000 + 1_000, 1_000);
    }
    const snapshot = tracker.snapshot();
    expect(snapshot.state).toBe("bad"); // the EWMA mean converges past 400
    expect(snapshot.jitterMillis).toBe(0); // every deviation exceeded the stall cap
  });

  it("sustained MODERATE swings trip weak through jitter (deviations under the cap)", () => {
    const tracker = new ConnectionQuality();
    for (let index = 0; index < 6; index += 1) {
      echo(tracker, index * 2_000, 100);
      echo(tracker, index * 2_000 + 1_000, 350);
    }
    const snapshot = tracker.snapshot();
    expect(snapshot.state).toBe("weak"); // mean ~210 stays under weak-avg, jitter > 60
    expect(snapshot.jitterMillis!).toBeGreaterThan(60);
  });

  it("missed echoes degrade good → weak → bad, and an echo heals", () => {
    const tracker = new ConnectionQuality();
    echo(tracker, 1_000, 30);
    echo(tracker, 11_000, 30);
    expect(tracker.snapshot().state).toBe("good");

    expect(tracker.recordTimeout()).toBe(true);
    expect(tracker.snapshot().state).toBe("weak");
    expect(tracker.snapshot().consecutiveMisses).toBe(1);

    expect(tracker.recordTimeout()).toBe(true);
    expect(tracker.snapshot().state).toBe("bad");

    expect(echo(tracker, 60_000, 30)).toBe(true);
    expect(tracker.snapshot().state).toBe("good");
    expect(tracker.snapshot().consecutiveMisses).toBe(0);
  });

  it("a miss never improves an already-bad connection", () => {
    const tracker = new ConnectionQuality();
    echo(tracker, 1_000, 500); // bad by latency
    echo(tracker, 11_000, 500);
    expect(tracker.snapshot().state).toBe("bad");
    expect(tracker.recordTimeout()).toBe(false); // bad stays bad
  });

  it("a timeout with NO echo ever means an old server: unsupported after TWO misses", () => {
    const tracker = new ConnectionQuality();
    // ONE lost first ping is not a verdict (a server-side subscribe/echo race
    // can drop exactly one frame) — keep probing, no state change.
    expect(tracker.recordTimeout()).toBe(false);
    expect(tracker.snapshot().state).toBe("probing");
    expect(tracker.recordTimeout()).toBe(true);
    expect(tracker.snapshot().state).toBe("unsupported");
    expect(tracker.snapshot().consecutiveMisses).toBe(2);
  });

  it("REST samples feed the readout ONLY while unsupported", () => {
    const tracker = new ConnectionQuality();
    expect(tracker.recordRestSample(43.6)).toBe(false); // still probing — ignored for display
    expect(tracker.snapshot().lastRestMillis).toBe(44);
    tracker.recordTimeout();
    tracker.recordTimeout(); // → unsupported
    expect(tracker.recordRestSample(51)).toBe(true); // the visible number moved
    expect(tracker.snapshot().lastRestMillis).toBe(51);
  });

  it("clock-garbage echoes (negative or absurd RTT) are ignored wholesale", () => {
    const tracker = new ConnectionQuality();
    expect(tracker.recordEcho(5_000, 10_000)).toBe(false); // echo before send — skew
    expect(tracker.recordEcho(1_000_000, 1_000)).toBe(false); // 16-minute "RTT"
    expect(tracker.snapshot().lastRttMillis).toBeNull();
    expect(tracker.snapshot().state).toBe("probing");
  });

  it("a non-number echo body (hostile server) never paints NaN", () => {
    const tracker = new ConnectionQuality();
    // JSON.parse of a hostile frame yields an object/undefined — arithmetic
    // turns it into NaN, which must die at the guard.
    expect(tracker.recordEcho(Date.now(), Number.NaN)).toBe(false);
    expect(tracker.snapshot().lastRttMillis).toBeNull();
    expect(tracker.snapshot().state).toBe("probing");
  });

  it("the min/avg/max window keeps only the trailing minute", () => {
    const tracker = new ConnectionQuality();
    echo(tracker, 0, 500);
    echo(tracker, 1_000, 100);
    echo(tracker, 61_000, 200); // the first two samples age out (60 s window)
    const snapshot = tracker.snapshot();
    expect(snapshot.windowMinMillis).toBe(200);
    expect(snapshot.windowMaxMillis).toBe(200);
    // The EWMA mean still carries the history (classification memory ≠ tooltip window).
    expect(snapshot.jitterMillis).not.toBeNull();
  });

  it("reset returns to probing and reports whether anything was displayed before", () => {
    const tracker = new ConnectionQuality();
    expect(tracker.reset()).toBe(false); // pristine — nothing shown changes
    echo(tracker, 1_000, 40);
    expect(tracker.reset()).toBe(true);
    expect(tracker.snapshot().state).toBe("probing");
    expect(tracker.snapshot().lastRttMillis).toBeNull();
  });
});
