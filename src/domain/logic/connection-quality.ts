/**
 * Pure connection-quality state machine for the ping indicator (Discord-style RTT
 * over the long-lived STOMP socket). The network cycle lives in ConnectionSession
 * (SEND /app/ping every PING_INTERVAL_MS, echo on /user/queue/ping); this class only
 * folds samples into display state — every method takes explicit timestamps, so the
 * whole thing is testable without timers.
 *
 * Signals:
 *  - recordEcho: an echo arrived; rtt = now − the echoed send timestamp. The server
 *    adds no timing of its own (it relays the client's value verbatim).
 *  - recordTimeout: an echo did not arrive within the session's ping timeout. If NO
 *    echo was ever seen, that is an old server without the /app/ping mapping (it
 *    silently drops the SEND) → "unsupported", terminal until a reconnect re-probes;
 *    "no echo" is NEVER an error. After working echoes, misses read as degradation.
 *  - recordRestSample: a passive REST round-trip measurement (RestClient's single
 *    choke point). REST answers include server processing (DB writes), so samples
 *    never feed the classification — they only keep the ms readout alive for servers
 *    too old to echo pings.
 */

/** Display state of the indicator dot. "probing" = the first ping is still in flight. */
export type ConnectionQualityState = "probing" | "good" | "weak" | "bad" | "unsupported";

export interface ConnectionQualitySnapshot {
  readonly state: ConnectionQualityState;
  /** The latest STOMP-echo RTT (null until the first echo of this connection). */
  readonly lastRttMillis: number | null;
  /** The latest REST round-trip — the fallback readout while "unsupported". */
  readonly lastRestMillis: number | null;
  /** min/avg/max RTT over the trailing minute of echo samples (nulls while empty). */
  readonly windowMinMillis: number | null;
  readonly windowAvgMillis: number | null;
  readonly windowMaxMillis: number | null;
  /** EWMA of |sample − mean| — the stability half of the classification. */
  readonly jitterMillis: number | null;
  /** Echoes that timed out in a row right now (diagnostics for the tooltip). */
  readonly consecutiveMisses: number;
}

/** EWMA smoothing for the mean and jitter estimates (0.3 ≈ 3-sample memory). */
const EWMA_ALPHA = 0.3;
/** good: snappy AND stable. */
const GOOD_AVG_MAX_MILLIS = 150;
const GOOD_JITTER_MAX_MILLIS = 60;
/** weak: usable but noticeable (cross-continent/VPN territory). */
const WEAK_AVG_MAX_MILLIS = 400;
const WEAK_JITTER_MAX_MILLIS = 150;
/** Echo samples older than this leave the min/avg/max tooltip window. */
const WINDOW_MILLIS = 60_000;
/** Deviations beyond this are stalls (a busy renderer main thread — the RTT
 *  measurement includes the event-loop queues on both ends), not network
 *  variation: they still move the MEAN (sustained stalls trip the avg-based
 *  weak/bad), but a one-off must not keep the jitter — and the dot — degraded
 *  for minutes while the last ping reads single-digit ms. */
const JITTER_DEVIATION_CAP_MILLIS = 150;
/** Outside this range an "RTT" is clock garbage (skew, a stuck frame), not latency. */
const MAX_PLAUSIBLE_RTT_MILLIS = 10_000;
/** Consecutive missed echoes that read as BAD. */
const BAD_MISS_STREAK = 2;
/** Misses with ZERO echoes seen before declaring the server too old to answer
 *  pings: a single lost FIRST frame (e.g. the server-side race between
 *  SUBSCRIBE registration and echo delivery on different inbound workers) must
 *  not disable the indicator for the whole session. */
const UNSUPPORTED_MISS_STREAK = 2;

/** The store's placeholder until a session's first publish (a fresh machine's view). */
export function initialConnectionQuality(): ConnectionQualitySnapshot {
  return new ConnectionQuality().snapshot();
}

export class ConnectionQuality {
  private state: ConnectionQualityState = "probing";
  private lastRttMillis: number | null = null;
  private lastRestMillis: number | null = null;
  private ewmaAvgMillis: number | null = null;
  private ewmaJitterMillis: number | null = null;
  private window: { rttMillis: number; atMillis: number }[] = [];
  private echoCount = 0;
  private consecutiveMisses = 0;
  /** The first echo's RTT, held while the warm-up withholds the verdict (see recordEcho). */
  private firstEchoRttMillis: number | null = null;

  snapshot(): ConnectionQualitySnapshot {
    const rtts = this.window.map((sample) => sample.rttMillis);
    return {
      state: this.state,
      lastRttMillis: this.lastRttMillis,
      lastRestMillis: this.lastRestMillis,
      windowMinMillis: rtts.length > 0 ? Math.min(...rtts) : null,
      windowAvgMillis: rtts.length > 0 ? rtts.reduce((sum, value) => sum + value, 0) / rtts.length : null,
      windowMaxMillis: rtts.length > 0 ? Math.max(...rtts) : null,
      jitterMillis: this.ewmaJitterMillis,
      consecutiveMisses: this.consecutiveMisses,
    };
  }

  /** @returns whether the DISPLAYED snapshot changed (the session re-publishes only then). */
  recordEcho(nowMillis: number, sentAtMillis: number): boolean {
    const rttMillis = nowMillis - sentAtMillis;
    // Number.isFinite first: a non-number echo body (a hostile/buggy server)
    // yields NaN, which slips every comparison guard and would paint "NaN ms".
    if (!Number.isFinite(rttMillis) || rttMillis < 0 || rttMillis > MAX_PLAUSIBLE_RTT_MILLIS) {
      return false; // clock garbage — ignore the sample, not the connection
    }
    this.lastRttMillis = rttMillis;
    this.echoCount += 1;
    this.consecutiveMisses = 0;
    this.window.push({ rttMillis, atMillis: nowMillis });
    this.window = this.window.filter((sample) => nowMillis - sample.atMillis <= WINDOW_MILLIS);

    if (this.echoCount === 1) {
      // Warm-up: the FIRST ping rides the startup storm (REST snapshots, media
      // prefetch, first layout), so its RTT is inflated by event-loop
      // contention — a live report had 423 ms on localhost painting the dot red
      // while every later ping read 5 ms. Withhold the verdict; the seed below
      // takes the FASTER of the first two echoes (a stall can only ADD delay,
      // so the faster sample is the honest network estimate).
      this.firstEchoRttMillis = rttMillis;
      this.state = "probing";
      return true;
    }
    if (this.echoCount === 2) {
      this.ewmaAvgMillis = Math.min(this.firstEchoRttMillis ?? rttMillis, rttMillis);
      this.ewmaJitterMillis = 0;
      this.firstEchoRttMillis = null;
    } else {
      const previousAvg = this.ewmaAvgMillis;
      this.ewmaAvgMillis = previousAvg === null
        ? rttMillis
        : previousAvg + EWMA_ALPHA * (rttMillis - previousAvg);
      const deviation = previousAvg === null ? 0 : Math.abs(rttMillis - previousAvg);
      if (previousAvg === null || deviation <= JITTER_DEVIATION_CAP_MILLIS) {
        // Only plausible network variation feeds the jitter (see the cap above) —
        // the mean above has already absorbed the sample either way.
        this.ewmaJitterMillis = this.ewmaJitterMillis === null
          ? deviation
          : this.ewmaJitterMillis + EWMA_ALPHA * (deviation - this.ewmaJitterMillis);
      }
    }
    this.state = this.classify();
    return true; // the ms readout always moved
  }

  /** @returns whether the DISPLAYED snapshot changed. */
  recordTimeout(): boolean {
    const previousState = this.state;
    this.consecutiveMisses += 1;
    if (this.echoCount === 0) {
      // Never a single echo: TWO misses in = the server build predates the
      // ping mapping (old servers silently drop SENDs without one). One miss
      // proves nothing — keep probing.
      if (this.consecutiveMisses >= UNSUPPORTED_MISS_STREAK) {
        this.state = "unsupported";
      }
    } else if (this.consecutiveMisses >= BAD_MISS_STREAK) {
      this.state = "bad";
    } else if (previousState !== "bad") {
      this.state = "weak"; // one miss while the heartbeats still flow
    }
    return this.state !== previousState;
  }

  /** @returns whether the DISPLAYED snapshot changed (only true while "unsupported",
   *  where the REST number is the visible readout). */
  recordRestSample(millis: number): boolean {
    this.lastRestMillis = Math.max(0, Math.round(millis));
    return this.state === "unsupported";
  }

  /** Back to "probing" — called on every (re)connect; a fresh socket re-measures. */
  reset(): boolean {
    const wasPristine = this.state === "probing" && this.lastRttMillis === null
      && this.lastRestMillis === null && this.consecutiveMisses === 0 && this.firstEchoRttMillis === null;
    this.state = "probing";
    this.lastRttMillis = null;
    this.lastRestMillis = null;
    this.ewmaAvgMillis = null;
    this.ewmaJitterMillis = null;
    this.window = [];
    this.echoCount = 0;
    this.consecutiveMisses = 0;
    this.firstEchoRttMillis = null;
    return !wasPristine;
  }

  private classify(): ConnectionQualityState {
    const avgMillis = this.ewmaAvgMillis ?? 0;
    const jitterMillis = this.ewmaJitterMillis ?? 0;
    if (avgMillis <= GOOD_AVG_MAX_MILLIS && jitterMillis <= GOOD_JITTER_MAX_MILLIS) {
      return "good";
    }
    if (avgMillis <= WEAK_AVG_MAX_MILLIS && jitterMillis <= WEAK_JITTER_MAX_MILLIS) {
      return "weak";
    }
    return "bad";
  }
}
