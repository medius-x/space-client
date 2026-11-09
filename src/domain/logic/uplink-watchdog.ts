/**
 * Publish-side mic stall detector: feed it the mic sender's cumulative
 * outbound audio bytes; two consecutive samples with NO growth while the
 * track is enabled mean no RTP is leaving at all — a dead publish chain
 * (a closed AudioContext behind the published track, a stranded pipeline,
 * a worklet that booted but never runs). Silence never false-positives: an
 * ENABLED track keeps sending comfort/noise frames, so the counters grow
 * even when nobody speaks.
 *
 * This is the publish-side mirror of the receiving side's "real silent join"
 * watchdog (SfuSession still-muted check): the live 2026-10-16 bug — engine
 * switching left one side inaudible for minutes, cured only by a manual
 * room re-join — was invisible to every existing check precisely because
 * only the PEER's renderer could see it.
 */
export class UplinkStallDetector {
  private static readonly STALL_THRESHOLD = 2;

  private lastBytes: number | null = null;
  private streak = 0;

  /**
   * @param bytesSent cumulative outbound-rtp bytes of the mic sender
   * @param trackEnabled the published track's enabled flag — a muted track
   *  legitimately sends nothing, so it pauses the detector (baseline reset)
   * @returns true exactly when this sample CONFIRMS a stall (the caller's
   *  callback moment); the streak resets on firing, so a persistent stall
   *  re-confirms after another threshold samples
   */
  sample(bytesSent: number | null, trackEnabled: boolean): boolean {
    if (!trackEnabled || bytesSent === null) {
      this.reset();
      return false;
    }
    if (this.lastBytes !== null && bytesSent <= this.lastBytes) {
      this.streak += 1;
      this.lastBytes = bytesSent;
      if (this.streak >= UplinkStallDetector.STALL_THRESHOLD) {
        this.streak = 0;
        return true;
      }
      return false;
    }
    this.lastBytes = bytesSent;
    this.streak = 0;
    return false;
  }

  /** Forget the baseline (a track swap or a stats hiccup starts a new watch). */
  reset(): void {
    this.lastBytes = null;
    this.streak = 0;
  }
}

/**
 * The escalation ladder the runtime climbs on each CONFIRMED uplink stall
 * (the detector above), cheapest first:
 *
 *   1. rebuild-noise    — re-create the suppression detour around the SAME
 *                         capture (fixes a stranded pipeline, no disruption)
 *   2. recycle-capture  — stop the raw track and open a FRESH getUserMedia;
 *                         Chromium rebuilds the whole capture chain, which
 *                         unwedges devices that open fine but deliver no
 *                         frames (live 2026-11-07). No room disruption.
 *   3. rejoin ×2        — the full ladder step (room teardown + rejoin)
 *   4. give-up          — show the mic hint, STOP touching the room
 *
 * The reset must ONLY run on a MANUAL room entry. It used to live in
 * teardownVoice — which every automatic rejoin runs — so the rejoin cap never
 * held: a wedged mic re-joined the room every ~20 s for 90 straight minutes
 * (271 rejoins, live 2026-11-07), tearing the audio for everyone else too.
 */
export type UplinkEscalationStep = "rebuild-noise" | "recycle-capture" | "rejoin" | "give-up";

export class UplinkEscalation {
  private static readonly MAX_REJOINS = 2;

  private strikes = 0;
  private rejoins = 0;
  private captureRecycled = false;

  next(): UplinkEscalationStep {
    this.strikes += 1;
    if (this.strikes === 1) {
      return "rebuild-noise";
    }
    if (!this.captureRecycled) {
      this.captureRecycled = true;
      return "recycle-capture";
    }
    if (this.rejoins < UplinkEscalation.MAX_REJOINS) {
      this.rejoins += 1;
      return "rejoin";
    }
    return "give-up";
  }

  /** A manual voice entry (user clicked into a channel) starts the ladder over. */
  reset(): void {
    this.strikes = 0;
    this.rejoins = 0;
    this.captureRecycled = false;
  }
}
