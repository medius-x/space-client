import { useEffect, useState } from "react";
import { buildDiagModel, runDisplayMediaSelfTest, seedSyntheticMessages, toggleTestTone, type DiagModel } from "../runtime";
import { log } from "../../logging";

/** The evidence surface: connection key/values, stereo oracle, log tail. 4 Hz refresh. */
export function Diagnostics(): React.JSX.Element {
  const [model, setModel] = useState<DiagModel>({ lines: [], stereo: null, stereoVerdict: null });
  const [logVersion, setLogVersion] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setModel(buildDiagModel());
      setLogVersion((version) => version + 1);
    }, 250);
    return () => window.clearInterval(timer);
  }, []);

  const verdictClass = model.stereoVerdict === null ? "" : " " + model.stereoVerdict.toLowerCase();

  return (
    <div className="diagnostics">
      <div className="diag-title">diagnostics</div>
      <button className="ghost" onClick={() => void runDisplayMediaSelfTest()}>getDisplayMedia self-test</button>
      <button className="ghost" onClick={() => seedSyntheticMessages(10_000)}>seed 10k messages (perf gate)</button>
      <div className="diag-row">
        <button className="ghost" onClick={() => toggleTestTone("left")}>Tone L</button>
        <button className="ghost" onClick={() => toggleTestTone("right")}>Tone R</button>
      </div>
      {model.lines.map((line) => (
        <div key={line.key} className="diag-kv">
          <span className="key">{line.key}</span>
          <span className="value">{line.value}</span>
        </div>
      ))}
      <div className="diag-title">stereo oracle</div>
      <div className={"diag-verdict" + verdictClass}>{model.stereoVerdict ?? "—"}</div>
      {model.stereo ? (
        <>
          <div className="diag-kv"><span className="key">L</span><span className="value">{model.stereo.leftDbfs <= -100 ? "−∞" : model.stereo.leftDbfs.toFixed(1)}</span></div>
          <div className="diag-kv"><span className="key">R</span><span className="value">{model.stereo.rightDbfs <= -100 ? "−∞" : model.stereo.rightDbfs.toFixed(1)}</span></div>
          <div className="diag-kv"><span className="key">Δ</span><span className="value">{model.stereo.deltaDb.toFixed(1)} dB</span></div>
          <div className="diag-kv"><span className="key">channels</span><span className="value">{model.stereo.channelCount}</span></div>
        </>
      ) : (
        <div className="diag-kv"><span className="key">no share audio</span></div>
      )}
      <div className="diag-title">log</div>
      <div className="diag-log">
        {log.entries().slice(-80).map((entry, index) => (
          <div key={`${entry.timestamp}-${index}`}>{entry.timestamp} {entry.level.toUpperCase().padEnd(5)} [{entry.tag}] {entry.message}</div>
        ))}
      </div>
      <span hidden>{logVersion}</span>
    </div>
  );
}
