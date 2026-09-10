/**
 * One-command frame tracer for the renderer (scroll-jank hunts). Spawns the app
 * with `--trace-frames=<seconds>` — Electron's contentTracing records the
 * devtools.timeline (paint/raster/composite across ALL threads; a renderer CPU
 * profile showed an idle main thread, so the cost lives in the rendering
 * pipeline) and dumps profile-trace.json into the project root. This script
 * waits for the file, closes the app, and aggregates stage durations into
 * profile-hotspots.txt.
 *
 *   npm run profile        → 15 seconds of recording after the prompt
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RECORD_SECONDS = Number(process.env.PROFILE_SECONDS ?? 15);

// Resolve the electron BINARY (require("electron") from plain node returns the
// exe path) and spawn it WITHOUT a shell — with shell:true child.kill() reaped
// only the cmd.exe wrapper and the real client windows piled up (live incident).
const electronBinary = createRequire(import.meta.url)("electron");
const projectRoot = join(import.meta.dirname, "..");
const tracePath = join(projectRoot, "profile-trace.json");
if (existsSync(tracePath)) {
  // stale file from an earlier run must not pass for a fresh recording
  import("node:fs").then((fs) => fs.rmSync(tracePath));
}

const child = spawn(electronBinary, [".", `--trace-frames=${RECORD_SECONDS}`], {
  cwd: projectRoot,
  stdio: "ignore",
});
const kill = () => {
  if (child.killed || child.exitCode !== null) {
    return;
  }
  try {
    child.kill();
  } catch {
    // already gone
  }
  // Belt and braces on Windows: reap the whole process TREE (main + gpu +
  // renderers) — a bare kill on the main pid can leave children behind.
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // best effort
    }
  }
};
process.on("exit", kill);
process.on("SIGINT", () => {
  kill();
  process.exit(0);
});

console.log(`>>> RECORDING ${RECORD_SECONDS}s — switch to the app NOW and scroll the sticky place (big message groups)…`);

// The app writes profile-trace.json when its own timer ends; wait a little past
// that for the file to land, then close the app.
let traceJson = null;
for (let attempt = 0; attempt < (RECORD_SECONDS + 60) * 2; attempt++) {
  if (existsSync(tracePath)) {
    try {
      traceJson = JSON.parse(readFileSync(tracePath, "utf8"));
      break;
    } catch {
      // mid-write — keep waiting
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
kill();
if (traceJson === null) {
  throw new Error("profile-trace.json never appeared");
}

const events = Array.isArray(traceJson) ? traceJson : traceJson.traceEvents ?? [];

/** Aggregate "X" (complete) events by name: total ms + call count, and per-thread. */
const totals = new Map();
const byThread = new Map();
for (const event of events) {
  if (event.ph !== "X" || typeof event.dur !== "number") {
    continue;
  }
  const name = event.name ?? "?";
  const bucket = totals.get(name) ?? { totalMs: 0, count: 0 };
  bucket.totalMs += event.dur / 1000;
  bucket.count += 1;
  totals.set(name, bucket);
  const thread = event.tid;
  const threadBucket = byThread.get(thread) ?? new Map();
  const inner = threadBucket.get(name) ?? { totalMs: 0, count: 0 };
  inner.totalMs += event.dur / 1000;
  inner.count += 1;
  threadBucket.set(name, inner);
  byThread.set(thread, threadBucket);
}

const lines = [
  `trace events: ${events.length}`,
  "",
  "stage totals (ms across the whole recording), top 25:",
  ...[...totals.entries()]
    .sort((left, right) => right[1].totalMs - left[1].totalMs)
    .slice(0, 25)
    .map(([name, bucket]) => `${bucket.totalMs.toFixed(0).padStart(7)}ms  ×${String(bucket.count).padStart(5)}  ${name}`),
  "",
  "per-thread top 8 (tid → heaviest stages):",
  ...[...byThread.entries()].flatMap(([thread, stageMap]) => {
    const top = [...stageMap.entries()].sort((left, right) => right[1].totalMs - left[1].totalMs).slice(0, 8)
      .map(([name, bucket]) => `    ${bucket.totalMs.toFixed(0).padStart(7)}ms ×${bucket.count}  ${name}`);
    return [`  tid ${thread}:`, ...top];
  }),
  "",
];
writeFileSync("profile-hotspots.txt", lines.join("\n"));
console.log(">>> saved profile-trace.json + profile-hotspots.txt");
