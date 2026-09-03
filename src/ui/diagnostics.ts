import { el, clear } from "./dom";
import { log } from "../logging";

export interface DiagActions {
  /** Phase-1 risk probe: getDisplayMedia against this exact Electron build. */
  runDisplayMediaSelfTest(): void;
}

export interface StereoReadingView {
  leftDbfs: number;
  rightDbfs: number;
  deltaDb: number;
  channelCount: number;
}

export interface DiagModel {
  lines: { key: string; value: string }[];
  stereo: StereoReadingView | null;
  stereoVerdict: "PASS" | "MONO" | "SILENT" | null;
}

/**
 * The evidence surface of the spike: connection key/values, the stereo oracle readout
 * (fmtp + per-channel dBFS + PASS/MONO/SILENT verdict) and the log tail. Re-rendered on
 * a timer (4 Hz), not on every event — it is a dashboard, not a live view.
 */
export class DiagnosticsView {
  private readonly container: HTMLElement;
  private readonly kvBox = el("div", {});
  private readonly verdictLine = el("div", { class: "diag-verdict" }, "—");
  private readonly stereoBox = el("div", {});
  private readonly logBox = el("div", { class: "diag-log" });

  constructor(parent: HTMLElement, actions: DiagActions) {
    this.container = el("div", { class: "diagnostics" });
    const selfTestButton = el("button", { class: "ghost" }, "getDisplayMedia self-test");
    selfTestButton.addEventListener("click", () => actions.runDisplayMediaSelfTest());
    this.container.append(
      el("div", { class: "diag-title" }, "diagnostics"),
      selfTestButton,
      this.kvBox,
      el("div", { class: "diag-title" }, "stereo oracle"),
      this.verdictLine,
      this.stereoBox,
      el("div", { class: "diag-title" }, "log"),
      this.logBox,
    );
    parent.append(this.container);
    this.update({ lines: [], stereo: null, stereoVerdict: null });
  }

  update(model: DiagModel): void {
    clear(this.kvBox);
    for (const line of model.lines) {
      this.kvBox.append(el("div", { class: "diag-kv" },
        el("span", { class: "key" }, line.key),
        el("span", { class: "value" }, line.value),
      ));
    }

    if (model.stereoVerdict === null) {
      this.verdictLine.className = "diag-verdict";
      this.verdictLine.textContent = "—";
    } else {
      this.verdictLine.className = "diag-verdict " + model.stereoVerdict.toLowerCase();
      this.verdictLine.textContent = model.stereoVerdict;
    }

    clear(this.stereoBox);
    if (model.stereo === null) {
      this.stereoBox.append(el("div", { class: "diag-kv" }, el("span", { class: "key" }, "no share audio")));
    } else {
      this.stereoBox.append(
        el("div", { class: "diag-kv" }, el("span", { class: "key" }, "L"), el("span", { class: "value" }, dbfs(model.stereo.leftDbfs))),
        el("div", { class: "diag-kv" }, el("span", { class: "key" }, "R"), el("span", { class: "value" }, dbfs(model.stereo.rightDbfs))),
        el("div", { class: "diag-kv" }, el("span", { class: "key" }, "Δ"), el("span", { class: "value" }, model.stereo.deltaDb.toFixed(1) + " dB")),
        el("div", { class: "diag-kv" }, el("span", { class: "key" }, "channels"), el("span", { class: "value" }, String(model.stereo.channelCount))),
      );
    }

    clear(this.logBox);
    for (const entry of log.entries().slice(-80)) {
      this.logBox.append(`${entry.timestamp} ${entry.level.toUpperCase().padEnd(5)} [${entry.tag}] ${entry.message}\n`);
    }
    this.logBox.scrollTop = this.logBox.scrollHeight;
  }
}

function dbfs(value: number): string {
  return (value <= -100 ? "−∞" : value.toFixed(1)) + " dBFS";
}
