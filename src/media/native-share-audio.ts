/**
 * Native share-audio manager (#485 production): the published audio track of a
 * share is the WASAPI process-loopback capture instead of Chromium's
 * full-desktop loopback. Screen shares capture the desktop minus OUR process
 * tree — the OS-level replacement for the failed DSP subtraction (#483 NO-GO):
 * viewers hear the voice channel once (directly), never doubled inside the
 * share. Window shares pass the source id and capture ONLY that application's
 * process tree (per-app audio, oak parity). Every failure path returns null
 * and the caller falls back — screens to the raw display-audio track, windows
 * to the M4 video-only share; the feature must never break a share.
 *
 * One native capture at a time (the main process enforces a single session
 * too); room share and call share are exclusive by app logic, but a defensive
 * release keeps a leaked session from blocking the next share. The diag
 * self-test shares this IPC frame sink — starting a share mid-test steals its
 * frames (dev-only collision, accepted).
 */
import { log } from "../logging";
import { rmsToDbfs } from "../core/audio-math";
import { createSystemAudioSource, type SystemAudioSource } from "./system-audio-source";

let active: SystemAudioSource | null = null;
let activeKind: "window" | "screen" | null = null;
let monitorWanted = false;

/** RMS telemetry of the live native capture (2026-10-19, the kyoDzo
 *  investigation): a capture that STARTED but records digital silence (player
 *  in WASAPI exclusive mode, target playing to another output device, a mixer's
 *  virtual endpoint in between) is indistinguishable from a working one in the
 *  lifecycle logs alone. The worklet already measures per-second RMS for the
 *  self-test; the production share reports it too, at the [share-stats]
 *  cadence. */
const SHARE_AUDIO_STATS_INTERVAL_MS = 10_000;
let statsTimer: ReturnType<typeof setInterval> | null = null;
let peakLinearRms = 0;

function describeDbfs(linearRms: number): string {
  const dbfs = rmsToDbfs(linearRms);
  return dbfs <= -100 ? "silent" : `${dbfs.toFixed(1)} dBFS`;
}

function startShareAudioStats(kind: "window" | "screen", source: SystemAudioSource): void {
  stopShareAudioStats();
  peakLinearRms = 0;
  statsTimer = setInterval(() => {
    const stats = source.latestStats();
    if (stats === null) {
      return; // no 1 s worklet window has completed yet
    }
    peakLinearRms = Math.max(peakLinearRms, stats.rmsLeft, stats.rmsRight);
    log.info("share-audio", `${kind}: L ${describeDbfs(stats.rmsLeft)} · R ${describeDbfs(stats.rmsRight)} · underruns ${stats.underruns} · dropped ${stats.dropped}`);
  }, SHARE_AUDIO_STATS_INTERVAL_MS);
}

function stopShareAudioStats(): void {
  if (statsTimer === null) {
    return;
  }
  clearInterval(statsTimer);
  statsTimer = null;
  // The session summary answers "did the capture EVER carry sound" in one line:
  // a whole share peaking at silence is the exclusive-mode/wrong-device
  // signature, even when nobody was watching the periodic lines.
  const peak = rmsToDbfs(peakLinearRms);
  log.info("share-audio", `${activeKind ?? "capture"} ended; peak ${peak <= -100 ? "SILENT for the whole session" : peak.toFixed(1) + " dBFS"}`);
  peakLinearRms = 0;
}

/** Whether a native share capture is running (the diag monitor attaches to it). */
export function isNativeShareActive(): boolean {
  return active !== null;
}

/** The wanted state of the local monitor over the ACTIVE share capture. */
export function isShareMonitorWanted(): boolean {
  return monitorWanted;
}

/** Monitor the LIVE share capture with our own ears (diag). The only loop-free
 *  listening post on a same-machine smoke stand: the monitor renders through
 *  OUR process, which the capture excludes by construction. Returns false
 *  when no native share is running (the caller falls back to standalone). */
export function monitorActiveShare(enabled: boolean): boolean {
  monitorWanted = enabled;
  if (active === null) {
    return false;
  }
  active.setMonitor(enabled);
  return true;
}

/** Re-route the active share's monitor ear (settings Apply / devicechange). */
export function setActiveShareMonitorSink(sinkId: string | null): void {
  active?.setMonitorSink(sinkId);
}

/**
 * The track to publish in place of the display stream's own audio track, or
 * null when the native capturer is unavailable or failed to start. Without a
 * source id the capture excludes our own process (whole desktop); a window
 * source id ("window:HWND:…") captures only that application.
 */
export async function acquireNativeShareAudioTrack(sourceId?: string, monitorSinkId?: string | null): Promise<MediaStreamTrack | null> {
  const bridge = window.spaceSysAudio;
  if (bridge === undefined) {
    return null;
  }
  try {
    if (!(await bridge.available())) {
      return null;
    }
    releaseNativeShareAudio(); // a leaked previous session must not block this one
    const source = await createSystemAudioSource({ monitorSinkId: monitorSinkId ?? null });
    // Wire the sink BEFORE start: frames flow on the first drain tick.
    bridge.onFrame((pcm, _silent) => source.feed(pcm));
    if (!(await bridge.start(sourceId))) {
      source.dispose();
      log.warn("share", `native audio failed to start${sourceId !== undefined ? ` (source ${sourceId})` : ""} — falling back`);
      return null;
    }
    active = source;
    activeKind = sourceId !== undefined ? "window" : "screen";
    startShareAudioStats(activeKind, source);
    return source.track;
  } catch (error) {
    releaseNativeShareAudio();
    log.warn("share", `native audio unavailable (${String(error)}) — falling back`);
    return null;
  }
}

/** Frees the WASAPI session and the injector context — every share teardown
 *  path calls this; a no-op when no native share is running. */
export function releaseNativeShareAudio(): void {
  monitorWanted = false;
  stopShareAudioStats();
  if (active === null) {
    return;
  }
  try {
    void window.spaceSysAudio?.stop();
  } finally {
    active.dispose();
    active = null;
    activeKind = null;
  }
}
